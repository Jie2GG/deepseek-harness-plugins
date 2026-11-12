/**
 * The plugin's operations, one method per RPC name.
 *
 * Nothing here knows about HTTP: the route layer decodes a request and calls
 * these, and the same methods are the surface a later agent tool will reuse.
 * Every identity write goes through the storage domain and every secret through
 * the credential store, so the page never touches the profile patch file and no
 * secret ever travels back to the browser.
 *
 * @module @jie2gg/dsh-plugin-ssh/ops
 */

import { connectionInputSchema, draftSecretSchema, MAX_CONCURRENT_PROBES, MAX_CONNECTIONS, MAX_MAX_OUTPUT_BYTES, MAX_PROBE_TIMEOUT_MS, MIN_MAX_OUTPUT_BYTES, MIN_PROBE_TIMEOUT_MS, probeDraftSchema, secretPatchSchema, settingsInputSchema } from './storage.ts'
import { SshError } from './types.ts'
import type { AuthMode, ConnectionRecord, ConnectionView, ProbeOutcome, SshSettings } from './types.ts'
import type { ProbeAuth, ProbeTarget, SshRunner } from './ssh.ts'
import type { TargetStore } from './store.ts'
import type { TargetSecrets } from './secrets.ts'

/** How many stored targets one `probeAll` covers; the rest are reported as skipped. */
const PROBE_ALL_LIMIT = 12

/** Plain JSON parameters as the route decoded them. */
export type Params = Record<string, unknown>

/** One JSON-safe result the route hands back to the page. */
export interface ListResult {
  connections: ConnectionView[]
  settings: SshSettings
  limits: {
    maxConnections: number
    concurrentProbes: number
    probeAllLimit: number
    probeTimeoutMinMs: number
    probeTimeoutMaxMs: number
    outputMinBytes: number
    outputMaxBytes: number
  }
  /** Whether this Host can answer a password or passphrase prompt at all. */
  askpass: 'ready' | 'unavailable'
  /** Why the helper is unavailable, when it is. */
  askpassFailure?: string
  probing: number
}

/** The operations the page may invoke. */
export interface Ops {
  /** Everything the page renders in one read. */
  list(): Promise<ListResult>
  /** Insert or overwrite one target, and any secret the page sent with it. */
  save(params: Params): Promise<{ connection: ConnectionView; connections: ConnectionView[] }>
  /** Delete one target and forget its secrets. */
  remove(params: Params): Promise<{ removed: true; orphanSecrets: boolean; connections: ConnectionView[] }>
  /** Probe one stored target, or one unsaved draft. */
  probe(params: Params): Promise<{ connection?: ConnectionView | undefined; probe?: ProbeOutcome | undefined; connections: ConnectionView[] }>
  /** Probe the stored targets, up to the built-in limit. */
  probeAll(): Promise<{ connections: ConnectionView[]; probed: number; skipped: number; failures: { id: string; message: string }[] }>
  /** Replace the shared settings. */
  configUpdate(params: Params): Promise<{ settings: SshSettings }>
}

/** Dependencies the plugin entry assembles. */
export interface OpsDeps {
  /** The probe runner. */
  runner: SshRunner
  /** Awaited storage; rejects with a `storage-error` {@link SshError} when the domain is unavailable. */
  store: () => Promise<TargetStore>
  /** The credential-store face; `undefined` until the plugin is fully mounted. */
  secrets: () => TargetSecrets | undefined
  /** Whether the askpass helper is usable, for the page to say so up front. */
  askpass: () => { ready: boolean; failure?: string | undefined }
}

/**
 * Read the identity fields a probe needs out of a stored record or a draft.
 * @param source - a record, or a draft target as the page submitted it.
 * @returns the probe fields.
 */
function targetOf(source: ProbeTarget): ProbeTarget {
  return {
    host: source.host,
    ...(source.user === undefined ? {} : { user: source.user }),
    ...(source.port === undefined ? {} : { port: source.port }),
    ...(source.identityFile === undefined ? {} : { identityFile: source.identityFile }),
    ...(source.proxyJump === undefined ? {} : { proxyJump: source.proxyJump }),
    ...(source.extraArgs === undefined ? {} : { extraArgs: source.extraArgs }),
  }
}

/**
 * Turn any thrown value into the route's failure vocabulary.
 * @param error - whatever escaped an operation.
 * @returns the message a reader can act on.
 */
function messageOf(error: unknown): string {
  if (error instanceof SshError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * Lift the first offending key out of a zod error message.
 * @param error - the validation failure.
 * @returns the field path, when the message carries one.
 */
function fieldOf(error: unknown): string | undefined {
  const issues: unknown = (error as { issues?: unknown } | undefined)?.issues
  if (!Array.isArray(issues)) return undefined
  const first = issues[0] as { path?: unknown } | undefined
  const path = first?.path
  return Array.isArray(path) && path.length > 0 ? path.map(String).join('.') : undefined
}

/**
 * Decode and validate one `save` payload.
 * @param params - the route parameters.
 * @returns the target fields, or a `bad-input` failure naming the offending key.
 */
function readConnection(params: Params): ReturnType<typeof connectionInputSchema.parse> {
  const value = params.connection ?? params
  try {
    return connectionInputSchema.parse(value)
  } catch (error: unknown) {
    throw new SshError('bad-input', messageOf(error), { field: fieldOf(error), hint: 'Fix the reported field and save again.' })
  }
}

/**
 * Decode the optional secret patch of a `save` payload.
 * @param params - the route parameters.
 * @returns the patch, or `undefined` when the page sent none.
 */
function readSecrets(params: Params): ReturnType<typeof secretPatchSchema.parse> | undefined {
  if (params.secrets === undefined) return undefined
  try {
    return secretPatchSchema.parse(params.secrets)
  } catch (error: unknown) {
    throw new SshError('bad-input', messageOf(error), { field: fieldOf(error), hint: 'A secret must be non-empty, or null to forget it.' })
  }
}

/**
 * Build the operations over one runner, one storage handle and one credential face.
 * @param deps - the assembled dependencies.
 * @returns the methods the route dispatches to.
 */
export function createOps(deps: OpsDeps): Ops {
  const { runner, store, secrets, askpass } = deps

  /** One stored record as the page sees it. */
  async function viewOf(state: TargetStore, record: ConnectionRecord): Promise<ConnectionView> {
    const holder = secrets()
    const slots = holder === undefined ? { password: false, passphrase: false } : await holder.status(record.id)
    return { ...record, secrets: slots }
  }

  /** The whole list, with secret presence. */
  async function viewsOf(state: TargetStore): Promise<ConnectionView[]> {
    return await Promise.all(state.list().map(async record => await viewOf(state, record)))
  }

  /** The credentials for one probe, transient values winning. */
  async function authFor(id: string | undefined, mode: AuthMode, transient?: { password?: unknown; passphrase?: unknown }): Promise<ProbeAuth> {
    const holder = secrets()
    const password = typeof transient?.password === 'string' && transient.password !== '' ? transient.password : undefined
    const passphrase = typeof transient?.passphrase === 'string' && transient.passphrase !== '' ? transient.passphrase : undefined
    if (id === undefined || holder === undefined) return { mode, ...(password === undefined ? {} : { password }), ...(passphrase === undefined ? {} : { passphrase }) }
    const storedPassword = password ?? await holder.read(id, 'password')
    const storedPassphrase = passphrase ?? await holder.read(id, 'passphrase')
    return {
      mode,
      ...(storedPassword === undefined ? {} : { password: storedPassword }),
      ...(storedPassphrase === undefined ? {} : { passphrase: storedPassphrase }),
    }
  }

  return {
    async list(): Promise<ListResult> {
      const state = await store()
      const settings = state.settings()
      const helper = askpass()
      return {
        connections: await viewsOf(state),
        settings,
        limits: {
          maxConnections: MAX_CONNECTIONS,
          concurrentProbes: MAX_CONCURRENT_PROBES,
          probeAllLimit: PROBE_ALL_LIMIT,
          probeTimeoutMinMs: MIN_PROBE_TIMEOUT_MS,
          probeTimeoutMaxMs: MAX_PROBE_TIMEOUT_MS,
          outputMinBytes: MIN_MAX_OUTPUT_BYTES,
          outputMaxBytes: MAX_MAX_OUTPUT_BYTES,
        },
        askpass: helper.ready ? 'ready' : 'unavailable',
        ...(helper.ready || helper.failure === undefined ? {} : { askpassFailure: helper.failure.slice(0, 512) }),
        probing: runner.inFlight,
      }
    },

    async save(params: Params) {
      const state = await store()
      const input = readConnection(params)
      const patch = readSecrets(params)
      const connection = input.id === undefined ? await state.create(input) : await state.edit(input.id, input)
      if (patch !== undefined) {
        const holder = secrets()
        if (holder === undefined) throw new SshError('secret-error', 'This plugin cannot reach the credential store on this Host.')
        await holder.apply(connection.id, patch)
      }
      return { connection: await viewOf(state, connection), connections: await viewsOf(state) }
    },

    async remove(params: Params) {
      const state = await store()
      const id = typeof params.id === 'string' ? params.id : ''
      if (id === '') throw new SshError('bad-input', 'Remove needs the id of one stored SSH target.', { field: 'id' })
      if (!(await state.remove(id))) throw new SshError('not-found', `No stored SSH target carries the id "${id}".`, { field: 'id' })
      let orphanSecrets = false
      const holder = secrets()
      if (holder !== undefined) {
        try {
          await holder.clearAll(id)
        } catch {
          orphanSecrets = true
        }
      }
      return { removed: true, orphanSecrets, connections: await viewsOf(state) }
    },

    async probe(params: Params) {
      const state = await store()
      const settings = state.settings()
      if (params.draft !== undefined) {
        let draft: ProbeTarget & { auth?: AuthMode | undefined }
        try {
          draft = probeDraftSchema.parse(params.draft)
        } catch (error: unknown) {
          throw new SshError('bad-input', messageOf(error), { field: fieldOf(error) ?? 'host', hint: 'Enter a host name or an OpenSSH host alias, then test it.' })
        }
        let transient: { password?: unknown; passphrase?: unknown } | undefined
        try {
          transient = params.secrets === undefined ? undefined : draftSecretSchema.parse(params.secrets)
        } catch (error: unknown) {
          throw new SshError('bad-input', messageOf(error), { field: fieldOf(error), hint: 'A draft secret must be a non-empty string.' })
        }
        const auth = await authFor(undefined, draft.auth ?? 'key', transient)
        const probe = await runner.probe(targetOf(draft), settings, auth)
        return { probe, connections: await viewsOf(state) }
      }
      const id = typeof params.id === 'string' ? params.id : ''
      if (id === '') throw new SshError('bad-input', 'Probe needs the id of one stored SSH target, or a draft.', { field: 'id' })
      const record = state.get(id)
      if (record === undefined) throw new SshError('not-found', `No stored SSH target carries the id "${id}".`, { field: 'id' })
      const auth = await authFor(record.id, record.auth)
      const outcome = await runner.probe(targetOf(record), settings, auth)
      const updated = await state.recordProbe(id, outcome)
      const connection = updated === undefined ? undefined : await viewOf(state, updated)
      return { ...(connection === undefined ? {} : { connection }), connections: await viewsOf(state) }
    },

    async probeAll() {
      const state = await store()
      const settings = state.settings()
      const all = state.list()
      const chosen = all.slice(0, PROBE_ALL_LIMIT)
      const failures: { id: string; message: string }[] = []
      let cursor = 0
      const lanes = Math.min(MAX_CONCURRENT_PROBES, Math.max(1, chosen.length))
      await Promise.all(
        Array.from({ length: lanes }, async () => {
          while (cursor < chosen.length) {
            const record = chosen[cursor]
            if (record === undefined) break
            cursor += 1
            try {
              const auth = await authFor(record.id, record.auth)
              const outcome = await runner.probe(targetOf(record), settings, auth)
              await state.recordProbe(record.id, outcome)
            } catch (error: unknown) {
              failures.push({ id: record.id, message: messageOf(error) })
            }
          }
        }),
      )
      return { connections: await viewsOf(state), probed: chosen.length, skipped: all.length - chosen.length, failures }
    },

    async configUpdate(params: Params) {
      const state = await store()
      const current = state.settings()
      const value = params.settings ?? params
      let patch: ReturnType<typeof settingsInputSchema.parse>
      try {
        patch = settingsInputSchema.parse(value)
      } catch (error: unknown) {
        throw new SshError('bad-input', messageOf(error), { field: fieldOf(error), hint: 'Fix the reported value or range and save again.' })
      }
      const settings = await state.saveSettings({
        command: patch.command ?? current.command,
        probeTimeoutMs: patch.probeTimeoutMs ?? current.probeTimeoutMs,
        maxOutputBytes: patch.maxOutputBytes ?? current.maxOutputBytes,
      })
      return { settings }
    },
  }
}
