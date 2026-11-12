/**
 * The plugin's operations, one method per RPC name.
 *
 * Nothing here knows about HTTP: the route layer decodes a request and calls
 * these, and the same methods are the surface a later agent tool will reuse.
 * Every mutation goes through the storage domain, so the page never writes the
 * user's profile patch file.
 *
 * @module @jie2gg/dsh-plugin-ssh/ops
 */

import { connectionInputSchema, MAX_CONCURRENT_PROBES, MAX_CONNECTIONS, probeDraftSchema, settingsInputSchema } from './storage.ts'
import { SshError } from './types.ts'
import type { ConnectionRecord, ProbeOutcome, SshSettings } from './types.ts'
import type { ProbeTarget, SshRunner } from './ssh.ts'
import type { TargetStore } from './store.ts'

/** How many stored targets one `probeAll` covers; the rest are reported as skipped. */
const PROBE_ALL_LIMIT = 12

/** Plain JSON parameters as the route decoded them. */
export type Params = Record<string, unknown>

/** One JSON-safe result the route hands back to the page. */
export interface ListResult {
  connections: ConnectionRecord[]
  settings: SshSettings
  limits: { maxConnections: number; concurrentProbes: number; probeAllLimit: number }
  probing: number
}

/** The operations the page may invoke. */
export interface Ops {
  /** Everything the page renders in one read. */
  list(): Promise<ListResult>
  /** Insert or overwrite one target. */
  save(params: Params): Promise<{ connection: ConnectionRecord; connections: ConnectionRecord[] }>
  /** Delete one target. */
  remove(params: Params): Promise<{ removed: true; connections: ConnectionRecord[] }>
  /** Probe one stored target, or one unsaved draft. */
  probe(params: Params): Promise<{ connection?: ConnectionRecord | undefined; probe?: ProbeOutcome | undefined; connections: ConnectionRecord[] }>
  /** Probe the stored targets, up to the built-in limit. */
  probeAll(): Promise<{ connections: ConnectionRecord[]; probed: number; skipped: number; failures: { id: string; message: string }[] }>
  /** Replace the shared settings. */
  configUpdate(params: Params): Promise<{ settings: SshSettings }>
}

/** Dependencies the plugin entry assembles. */
export interface OpsDeps {
  /** The probe runner. */
  runner: SshRunner
  /** Awaited storage; rejects with a `storage-error` {@link SshError} when the domain is unavailable. */
  store: () => Promise<TargetStore>
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
 * Build the operations over one runner and one storage handle.
 * @param deps - the runner and the awaited store.
 * @returns the methods the route dispatches to.
 */
export function createOps(deps: OpsDeps): Ops {
  const { runner, store } = deps

  return {
    async list(): Promise<ListResult> {
      const state = await store()
      const settings = state.settings()
      return {
        connections: state.list(),
        settings,
        limits: { maxConnections: MAX_CONNECTIONS, concurrentProbes: MAX_CONCURRENT_PROBES, probeAllLimit: PROBE_ALL_LIMIT },
        probing: runner.inFlight,
      }
    },

    async save(params: Params) {
      const state = await store()
      const input = readConnection(params)
      const connection = input.id === undefined ? await state.create(input) : await state.edit(input.id, input)
      return { connection, connections: state.list() }
    },

    async remove(params: Params) {
      const state = await store()
      const id = typeof params.id === 'string' ? params.id : ''
      if (id === '') throw new SshError('bad-input', 'Remove needs the id of one stored SSH target.', { field: 'id' })
      if (!(await state.remove(id))) throw new SshError('not-found', `No stored SSH target carries the id "${id}".`, { field: 'id' })
      return { removed: true, connections: state.list() }
    },

    async probe(params: Params) {
      const state = await store()
      const settings = state.settings()
      if (params.draft !== undefined) {
        let draft: ProbeTarget
        try {
          draft = probeDraftSchema.parse(params.draft) as ProbeTarget
        } catch (error: unknown) {
          throw new SshError('bad-input', messageOf(error), { field: 'host', hint: 'Enter a host name or an OpenSSH host alias, then test it.' })
        }
        const probe = await runner.probe(draft, settings)
        return { probe, connections: state.list() }
      }
      const id = typeof params.id === 'string' ? params.id : ''
      if (id === '') throw new SshError('bad-input', 'Probe needs the id of one stored SSH target, or a draft.', { field: 'id' })
      if (state.get(id) === undefined) throw new SshError('not-found', `No stored SSH target carries the id "${id}".`, { field: 'id' })
      const record = state.get(id)
      if (record === undefined) throw new SshError('not-found', `No stored SSH target carries the id "${id}".`, { field: 'id' })
      const outcome = await runner.probe(targetOf(record), settings)
      const connection = await state.recordProbe(id, outcome)
      return { ...(connection === undefined ? {} : { connection }), connections: state.list() }
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
              const outcome = await runner.probe(targetOf(record), settings)
              await state.recordProbe(record.id, outcome)
            } catch (error: unknown) {
              failures.push({ id: record.id, message: messageOf(error) })
            }
          }
        }),
      )
      return { connections: state.list(), probed: chosen.length, skipped: all.length - chosen.length, failures }
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
