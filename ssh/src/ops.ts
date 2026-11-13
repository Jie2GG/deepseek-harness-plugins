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

import { connectionInputSchema, draftSecretSchema, remotePathSchema, transferInputSchema, sessionTargetInputSchema, MAX_CONCURRENT_PROBES, MAX_CONNECTIONS, MAX_MAX_OUTPUT_BYTES, MAX_MAX_TRANSFER_BYTES, MAX_PROBE_TIMEOUT_MS, MAX_REMOTE_TIMEOUT_MS, MIN_MAX_OUTPUT_BYTES, MIN_MAX_TRANSFER_BYTES, MIN_PROBE_TIMEOUT_MS, MIN_REMOTE_TIMEOUT_MS, probeDraftSchema, remoteRunSchema, secretPatchSchema, settingsInputSchema } from './storage.ts'
import { SshError } from './types.ts'
import type { AuthMode, ConnectionRecord, ConnectionView, ProbeOutcome, RemoteRunResult, RemoteTransferResult, SshSettings } from './types.ts'
import { transfer } from './transfer.ts'
import { shellQuote } from './transport.ts'
import type { RemoteAuth, RemoteTarget, SshTransport } from './transport.ts'
import type { TargetStore } from './store.ts'
import type { TargetSecrets } from './secrets.ts'

/** How many stored targets one `probeAll` covers; the rest are reported as skipped. */
const PROBE_ALL_LIMIT = 12

/** Plain JSON parameters as the route decoded them. */
export type Params = Record<string, unknown>

/** One remote file operation's canonical result. */
export interface RemoteFileResult {
  /** `list`, `read`, or `write`. */
  action: 'list' | 'read' | 'write'
  /** Whether the remote side accepted and completed the call. */
  ok: boolean
  /** Classified transport and command outcome. */
  status: RemoteRunResult['status']
  /** The target that was used, named for the reader. */
  target: { id: string; label: string; host: string }
  /** The remote path the call addressed. */
  path: string
  /** Listing text or written confirmation. */
  entriesText?: string
  /** File text, for a read. */
  content?: string
  /** Bytes returned or sent. */
  bytes?: number
  /** Lines of content returned. */
  lines?: number
  /** Whether the ceiling clipped the text. */
  truncated?: boolean
  /** Whether an existing remote file was replaced. */
  overwrote?: boolean
  /** Exit code of the remote command. */
  exitCode?: number | null
  /** Duration of the whole call. */
  durationMs?: number
  /** Failure or refusal explanation. */
  message?: string
  /** Hint naming the next step for a reader. */
  hint?: string
}

/** One JSON-safe result the route hands back to the page. */
export interface ListResult {
  connections: ConnectionView[]
  /** The target this conversation chose, when the caller names a session. */
  sessionTarget?: string
  settings: SshSettings
  limits: {
    maxConnections: number
    concurrentProbes: number
    probeAllLimit: number
    probeTimeoutMinMs: number
    probeTimeoutMaxMs: number
    remoteTimeoutMinMs: number
    remoteTimeoutMaxMs: number
    outputMinBytes: number
    outputMaxBytes: number
    transferMinBytes: number
    transferMaxBytes: number
  }
  /** Whether this Host can answer a password or passphrase prompt at all. */
  askpass: 'ready' | 'unavailable'
  /** Why the helper is unavailable, when it is. */
  askpassFailure?: string
  /** Whose `~/.ssh` the probes read and write: the Host process's own identity. */
  runsAs: { uid: number | null; user: string; home: string }
  probing: number
}

/** The operations the page may invoke. */
export interface Ops {
  /** Everything the page renders in one read, plus this conversation's choice. */
  list(params?: Params): Promise<ListResult>
  /** Insert or overwrite one target, and any secret the page sent with it. */
  save(params: Params): Promise<{ connection: ConnectionView; connections: ConnectionView[] }>
  /** Delete one target and forget its secrets. */
  remove(params: Params): Promise<{ removed: true; orphanSecrets: boolean; connections: ConnectionView[] }>
  /** Probe one stored target, or one unsaved draft. */
  probe(params: Params): Promise<{ connection?: ConnectionView | undefined; probe?: ProbeOutcome | undefined; connections: ConnectionView[] }>
  /** Probe the stored targets, up to the built-in limit. */
  probeAll(): Promise<{ connections: ConnectionView[]; probed: number; skipped: number; failures: { id: string; message: string }[] }>
  /** Run one remote command, resolving the target the same way the tool will. */
  runCommand(params: Params): Promise<{ run: RemoteRunResult; connection?: ConnectionView | undefined; connections: ConnectionView[] }>
  /** Push one local file or directory to the server. */
  upload(params: Params): Promise<RemoteTransferResult>
  /** Pull one remote file into the conversation's workspace. */
  download(params: Params): Promise<RemoteTransferResult>
  /** Point a conversation at a target. */
  setSessionTarget(params: Params): Promise<{ sessionTarget: { sessionId: string; targetId: string; setAt: string } | null }>
  /** Forget a conversation's chosen target. */
  clearSessionTarget(params: Params): Promise<{ sessionTarget: null }>
  /** List one remote path. */
  listRemote(params: Params): Promise<RemoteFileResult>
  /** Read one remote file as text. */
  readRemote(params: Params): Promise<RemoteFileResult>
  /** Write one remote file from text, with the overwrite guard. */
  writeRemote(params: Params): Promise<RemoteFileResult>
  /** Replace the shared settings. */
  configUpdate(params: Params): Promise<{ settings: SshSettings }>
}

/** Dependencies the plugin entry assembles. */
export interface OpsDeps {
  /** The shared transport for probes, commands, and transfers. */
  runner: SshTransport
  /** Awaited storage; rejects with a `storage-error` {@link SshError} when the domain is unavailable. */
  store: () => Promise<TargetStore>
  /** The credential-store face; `undefined` until the plugin is fully mounted. */
  secrets: () => TargetSecrets | undefined
  /** Whether the askpass helper is usable, and where it lives. */
  askpass: () => { ready: boolean; path?: string | undefined; failure?: string | undefined }
  /** Whether a local path already exists, so a download can refuse to overwrite. */
  localExists?: ((path: string) => boolean | Promise<boolean>) | undefined
  /** Optional per-call overrides the tool layer passes down. */
  options?: FileCallOptions
}

/**
 * Read the identity fields a probe needs out of a stored record or a draft.
 * @param source - a record, or a draft target as the page submitted it.
 * @returns the probe fields.
 */
function targetOf(source: RemoteTarget): RemoteTarget {
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
 * Resolve which stored target a call means: an explicit reference wins, then the
 * conversation's chosen target, then the only target there is.
 * @param state - the open storage.
 * @param params - route parameters, optionally carrying `target` and `sessionId`.
 * @returns the matching record.
 */
function pickTarget(state: TargetStore, params: Params): ConnectionRecord {
  const records = state.list()
  const ref = typeof params.target === 'string' ? params.target.trim() : ''
  if (ref !== '') {
    const direct = records.find(row => row.id === ref)
      ?? records.find(row => row.label.toLowerCase() === ref.toLowerCase())
      ?? records.find(row => row.host.toLowerCase() === ref.toLowerCase()
        || (row.user !== undefined && `${row.user}@${row.host}`.toLowerCase() === ref.toLowerCase()))
    if (direct !== undefined) return direct
    const candidates = records.map(row => row.label).join(', ')
    throw new SshError('not-found', `No stored SSH target matches "${ref}".`, {
      field: 'target',
      hint: candidates === '' ? 'Add a target in Settings → Remote connections first.' : `Known targets: ${candidates}.`,
    })
  }
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
  if (sessionId !== '') {
    const chosen = state.getSessionTarget(sessionId)
    if (chosen !== undefined) {
      const row = state.get(chosen.targetId)
      if (row !== undefined) return row
    }
  }
  if (records.length === 1) {
    const only = records[0]
    if (only !== undefined) return only
  }
  throw new SshError('bad-input', records.length === 0
    ? 'No SSH target has been saved yet.'
    : `${String(records.length)} targets are saved, so this call has to name one.`, {
    field: 'target',
    hint: records.length === 0
      ? 'Add one in Settings → Remote connections.'
      : `Pass a target (${records.map(row => row.label).join(', ')}), or pick a default for this conversation.`,
  })
}

/** Options one remote file call may override. */
export interface FileCallOptions {
  /** Output ceiling for this call. */
  maxOutputBytes?: number
}

/**
 * Build the operations over one runner, one storage handle and one credential face.
 * @param deps - the assembled dependencies.
 * @returns the methods the route dispatches to.
 */
export function createOps(deps: OpsDeps): Ops {
  const { runner, store, secrets, askpass } = deps
  const options = deps.options ?? {}
  const localExists = deps.localExists

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
  async function authFor(id: string | undefined, mode: AuthMode, transient?: { password?: unknown; passphrase?: unknown }): Promise<RemoteAuth> {
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

  /**
   * Resolve everything a remote file call shares: the target, its settings, the
   * credentials, and a validated path.
   * @param params - route or tool parameters.
   * @param action - which file action is running, for the refusal message.
   * @returns the resolved pieces.
   */
  async function fileCall(params: Params, action: 'list' | 'read' | 'write') {
    const state = await store()
    const globalSettings = state.settings()
    const record = pickTarget(state, params)
    if (record.agentAccess === 'off') {
      throw new SshError('bad-input', `"${record.label}" is set to agent access off, so no remote file work may run on it.`, { field: 'target' })
    }
    const rawPath = typeof params.path === 'string' ? params.path.trim() : ''
    let path: string
    try {
      path = remotePathSchema.parse(rawPath)
    } catch (error: unknown) {
      throw new SshError('bad-input', `A remote ${action} needs an absolute path.`, { field: 'path', hint: messageOf(error) })
    }
    const settings: SshSettings = {
      ...globalSettings,
      ...(record.maxOutputBytes === undefined ? {} : { maxOutputBytes: record.maxOutputBytes }),
    }
    const auth = await authFor(record.id, record.auth)
    return { state, record, settings, auth, path }
  }

  /**
   * Shape one remote file result, mapping the plugin's own guard exits to plain
   * language a reader can act on.
   * @param action - which operation produced it.
   * @param record - the target used.
   * @param path - the remote path addressed.
   * @param run - the transport result.
   * @param entriesText - listing text, for a list.
   * @param content - file text, for a read.
   * @param extra - additional fields (bytes written, overwrite marker).
   * @returns the canonical result the route and the tool both return.
   */
  function fileResult(
    action: 'list' | 'read' | 'write',
    record: ConnectionRecord,
    path: string,
    run: RemoteRunResult,
    entriesText: string | undefined,
    content: string | undefined,
    extra: Record<string, unknown> = {},
  ): RemoteFileResult {
    const stderr = run.stderr ?? ''
    const missing = /no such file or directory/iu.test(stderr)
    const refused = run.exitCode === 17 || /refusing to overwrite/iu.test(stderr)
    const target = { id: record.id, label: record.label, host: record.host }
    const base: RemoteFileResult = {
      action,
      ok: run.status === 'succeeded',
      status: refused ? 'exit-nonzero' : run.status,
      target,
      path,
      ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
      ...(run.exitCode === undefined && run.status === 'succeeded' ? {} : { exitCode: run.exitCode ?? null }),
      ...(run.truncated === undefined ? {} : { truncated: run.truncated }),
      ...(entriesText === undefined || entriesText === '' ? {} : { entriesText }),
      ...(content === undefined ? {} : { content, bytes: Buffer.byteLength(content, 'utf8'), lines: content === '' ? 0 : content.split('\n').length }),
      ...extra,
    }
    if (refused) return { ...base, ok: false, message: 'The remote file already exists.', hint: 'Pass overwrite (or append) to replace it.' }
    if (missing) return { ...base, ok: false, message: `Nothing at ${path} on ${record.host}.`, hint: 'Check the path, or list the parent directory.' }
    if (!base.ok) return { ...base, ...(stderr === '' ? {} : { message: stderr.slice(0, 512) }) }
    return base
  }


  /**
   * Validate one transfer call and run it, keeping the refusal language the same
   * for both directions.
   * @param direction - which way the bytes go.
   * @param params - validated inputs.
   * @returns the canonical transfer result.
   */
  async function move(direction: 'upload' | 'download', params: Params): Promise<RemoteTransferResult> {
    const state = await store()
    const globalSettings = state.settings()
    // The remote path is validated on its own first, so a metacharacter or a
    // relative path is explained in plain words instead of a schema dump.
    const statedPath = typeof params.path === 'string' ? params.path.trim() : ''
    try {
      remotePathSchema.parse(statedPath)
    } catch (error: unknown) {
      throw new SshError('bad-input', messageOf(error), { field: 'path', hint: 'Expected an absolute path on the server, or one starting with "~/".' })
    }
    let input: ReturnType<typeof transferInputSchema.parse>
    try {
      input = transferInputSchema.parse(params)
    } catch (error: unknown) {
      throw new SshError('bad-input', messageOf(error), { field: fieldOf(error), hint: 'Fix the reported value and try again.' })
    }
    const record = pickTarget(state, params)
    if (record.agentAccess === 'off') {
      throw new SshError('bad-input', `"${record.label}" is set to agent access off, so no file may move with it.`, { field: 'target' })
    }
    const local = pathInside(input.localPath, input.localDir)
    const overwrite = input.overwrite === true
    if (direction === 'download' && !overwrite && localExists !== undefined && await localExists(local)) {
      return {
        action: 'download',
        ok: false,
        status: 'refused-exists',
        target: { id: record.id, label: record.label, host: record.host },
        localPath: local,
        remotePath: input.path,
        message: `${local} already exists locally.`,
        hint: 'Pass overwrite to replace it.',
      }
    }
    const settings: SshSettings = {
      ...globalSettings,
      ...(record.maxOutputBytes === undefined ? {} : { maxOutputBytes: record.maxOutputBytes }),
    }
    const auth = await authFor(record.id, record.auth)
    const outcome = await transfer(runner, askpassSource(), targetOf(record), settings, auth, {
      direction,
      localPath: local,
      remotePath: input.path,
      ...(input.recursive === undefined ? {} : { recursive: input.recursive }),
      overwrite,
      maxBytes: input.maxBytes ?? settings.maxTransferBytes,
      timeoutMs: input.timeoutMs ?? record.remoteTimeoutMs ?? settings.remoteTimeoutMs,
    })
    const target = { id: record.id, label: record.label, host: record.host }
    const base: RemoteTransferResult = {
      action: direction,
      ok: outcome.status === 'moved',
      status: outcome.status,
      target,
      localPath: local,
      remotePath: input.path,
      durationMs: outcome.durationMs,
      ...(outcome.bytes === undefined ? {} : { bytes: outcome.bytes }),
      ...(input.recursive === true ? { recursive: true } : {}),
      ...(outcome.overwrote === true ? { overwrote: true } : {}),
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
    }
    if (base.ok) return base
    return { ...base, hint: transferHint(outcome.status, direction) }
  }

  /**
   * Refuse a local path outside the conversation's workspace, so the model cannot
   * reach arbitrary files through a transfer.
   * @param raw - the path as sent.
   * @param dir - the workspace root, when the caller knows one.
   * @returns the absolute path.
   */
  function pathInside(raw: string, dir: string | undefined): string {
    const value = raw.trim()
    if (dir === undefined) return value
    const root = dir.endsWith('/') ? dir : `${dir}/`
    if (value === dir) return value
    if (!value.startsWith(root)) {
      throw new SshError('bad-input', `"${value}" is outside the workspace ${dir}.`, {
        field: 'localPath',
        hint: 'Give a path inside the conversation workspace, or one relative to it.',
      })
    }
    return value
  }

  /**
   * Read and validate one conversation-target call.
   * @param params - route parameters.
   * @returns the session and the optional target.
   */
  function readSession(params: Params): { sessionId: string; targetId?: string } {
    try {
      const parsed = sessionTargetInputSchema.parse(params)
      if (parsed.targetId === undefined) return { sessionId: parsed.sessionId }
      return { sessionId: parsed.sessionId, targetId: parsed.targetId }
    } catch (error: unknown) {
      throw new SshError('bad-input', messageOf(error), { field: fieldOf(error) ?? 'sessionId' })
    }
  }

  /**
   * Name the next step for a refused transfer.
   * @param status - what stopped it.
   * @param direction - which way the bytes were moving.
   * @returns the hint text.
   */
  function transferHint(status: string, direction: 'upload' | 'download'): string {
    if (status === 'refused-size') return 'Raise the transfer ceiling in Settings → Remote connections, or copy a smaller path.'
    if (status === 'refused-exists') return direction === 'download' ? 'Pass overwrite to replace the local file.' : 'Pass overwrite to replace the remote file.'
    if (status === 'missing') return direction === 'download' ? 'List the remote directory first, or check the path.' : 'Check the local path, and make sure the remote directory exists (write with mkdir first).'
    return 'See the message; a transfer failure usually means the path, the credential, or the deadline.'
  }

  /** The askpass face, taken through the readiness check so transfers get it too. */
  function askpassSource() {
    const helper = askpass()
    return { path: helper.ready ? helper.path : undefined, failure: helper.failure }
  }

  return {
    async list(params: Params = {}): Promise<ListResult> {
      const state = await store()
      const settings = state.settings()
      const helper = askpass()
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      const chosen = sessionId === '' ? undefined : state.getSessionTarget(sessionId)?.targetId
      return {
        connections: await viewsOf(state),
        ...(chosen === undefined ? {} : { sessionTarget: chosen }),
        settings,
        limits: {
          maxConnections: MAX_CONNECTIONS,
          concurrentProbes: MAX_CONCURRENT_PROBES,
          probeAllLimit: PROBE_ALL_LIMIT,
          probeTimeoutMinMs: MIN_PROBE_TIMEOUT_MS,
          probeTimeoutMaxMs: MAX_PROBE_TIMEOUT_MS,
          outputMinBytes: MIN_MAX_OUTPUT_BYTES,
          outputMaxBytes: MAX_MAX_OUTPUT_BYTES,
          remoteTimeoutMinMs: MIN_REMOTE_TIMEOUT_MS,
          remoteTimeoutMaxMs: MAX_REMOTE_TIMEOUT_MS,
          transferMinBytes: MIN_MAX_TRANSFER_BYTES,
          transferMaxBytes: MAX_MAX_TRANSFER_BYTES,
        },
        askpass: helper.ready ? 'ready' : 'unavailable',
        ...(helper.ready || helper.failure === undefined ? {} : { askpassFailure: helper.failure.slice(0, 512) }),
        runsAs: {
          uid: typeof process.getuid === 'function' ? process.getuid() : null,
          user: process.env.USER ?? process.env.LOGNAME ?? '',
          home: process.env.HOME ?? '',
        },
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
      // A removed target must not keep pointing conversations at a dangling id.
      await state.forgetSessionTargetsFor(id)
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
        let draft: RemoteTarget & { auth?: AuthMode | undefined }
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

    async runCommand(params: Params) {
      const state = await store()
      const globalSettings = state.settings()
      let input: ReturnType<typeof remoteRunSchema.parse>
      try {
        input = remoteRunSchema.parse(params.command !== undefined ? params : { command: params })
      } catch (error: unknown) {
        throw new SshError('bad-input', messageOf(error), { field: fieldOf(error) ?? 'command', hint: 'Fix the reported value and try again.' })
      }
      const record = pickTarget(state, params)
      if (record.agentAccess === 'off') {
        throw new SshError('bad-input', `"${record.label}" is set to agent access off, so no remote command may run on it.`, { field: 'target', hint: 'Turn agent access on for this target in the settings page.' })
      }
      const settings: SshSettings = {
        ...globalSettings,
        ...(record.maxOutputBytes === undefined ? {} : { maxOutputBytes: record.maxOutputBytes }),
      }
      const auth = await authFor(record.id, record.auth)
      const run = await runner.run(targetOf(record), settings, auth, input.command, {
        ...(input.timeoutMs === undefined && record.remoteTimeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs ?? record.remoteTimeoutMs }),
        ...(record.maxOutputBytes === undefined ? {} : { maxOutputBytes: record.maxOutputBytes }),
      })
      const connection = await viewOf(state, record)
      return { run, connection, connections: await viewsOf(state) }
    },

    async listRemote(params: Params): Promise<RemoteFileResult> {
      const { state, record, settings, auth, path } = await fileCall(params, 'list')
      const run = await runner.run(targetOf(record), settings, auth, `ls -la -- ${shellQuote(path)}`, {
        maxOutputBytes: settings.maxOutputBytes,
      })
      return fileResult('list', record, path, run, run.stdout === undefined || run.stdout.trim() === '' ? undefined : run.stdout, undefined)
    },

    async readRemote(params: Params): Promise<RemoteFileResult> {
      const { state, record, settings, auth, path } = await fileCall(params, 'read')
      const run = await runner.run(targetOf(record), settings, auth, `cat -- ${shellQuote(path)}`, {
        maxOutputBytes: options.maxOutputBytes ?? settings.maxOutputBytes,
      })
      const content = run.stdout ?? ''
      return fileResult('read', record, path, run, undefined, content)
    },

    async writeRemote(params: Params): Promise<RemoteFileResult> {
      const { state, record, settings, auth, path } = await fileCall(params, 'write')
      const content = typeof params.content === 'string' ? params.content : ''
      const append = params.append === true
      const mkdir = params.mkdir !== false
      const overwrite = params.overwrite === true
      const quoted = shellQuote(path)
      const guard = overwrite || append
        ? ''
        : `if [ -e ${quoted} ]; then echo 'ssh-plugin: refusing to overwrite an existing file' >&2; exit 17; fi; `
      const parent = path.replace(/\\/gu, '/').replace(/\/+[^/]*$/u, '') || '/'
      const prepare = mkdir && parent !== '' ? `mkdir -p -- ${shellQuote(parent)} && ` : ''
      const run = await runner.run(targetOf(record), settings, auth, `${guard}${prepare}cat ${append ? '>>' : '>'} ${quoted}`, {
        stdin: content,
        maxOutputBytes: settings.maxOutputBytes,
      })
      return fileResult('write', record, path, run, undefined, undefined, {
        bytes: Buffer.byteLength(content, 'utf8'),
        overwrote: overwrite && !append,
      })
    },

    async upload(params: Params): Promise<RemoteTransferResult> {
      return await move('upload', params)
    },

    async download(params: Params): Promise<RemoteTransferResult> {
      return await move('download', params)
    },

    async setSessionTarget(params: Params) {
      const state = await store()
      const input = readSession(params)
      if (input.targetId === undefined) return { sessionTarget: null }
      const row = await state.setSessionTarget(input.sessionId, input.targetId)
      return { sessionTarget: row }
    },

    async clearSessionTarget(params: Params) {
      const state = await store()
      const input = readSession(params)
      await state.clearSessionTarget(input.sessionId)
      return { sessionTarget: null }
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
        remoteTimeoutMs: patch.remoteTimeoutMs ?? current.remoteTimeoutMs,
        maxTransferBytes: patch.maxTransferBytes ?? current.maxTransferBytes,
      })
      return { settings }
    },
  }
}
