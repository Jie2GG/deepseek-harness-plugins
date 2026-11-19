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

import { connectionInputSchema, draftSecretSchema, remotePathSchema, transferInputSchema, sessionTargetInputSchema, CONTROL_PERSIST_SECONDS, FOREGROUND_RESERVED_OPS, MAX_CONCURRENT_OPS, MAX_CONNECTIONS, MAX_LIVE_MASTERS, probeDraftSchema, remoteRunSchema, secretPatchSchema, settingsInputSchema } from './storage.ts'
import { defaultBounds, resolveSettings } from './bounds.ts'
import type { Bounds, CeilingLayers, ResolvedSettings } from './bounds.ts'
import { SshError } from './types.ts'
import type { AuthMode, ConnectionRecord, ConnectionView, ProbeOutcome, ResolvedConfig, RemoteRunResult, RemoteTransferResult, SshSettings, StoredSettings } from './types.ts'
import { transfer } from './transfer.ts'
import {
  applyEdit,
  previewEdit,
  buildEditRead,
  buildEditWrite,
  buildEditRestore,
  splitEditVersion,
  verifyEditBody,
  digestHex,
  parseWriteReport,
  parseRepairReport,
  EDIT_MISSING,
  EDIT_STALE,
  EDIT_BACKUP_FAILED,
  EDIT_WRITE_FAILED,
  EDIT_SIZE_MISMATCH,
  EDIT_CONTENT_MISMATCH,
  EDIT_CONTENT_UNVERIFIED,
  EDIT_RESTORE_FAILED,
  EDIT_RESTORE_UNVERIFIED,
  EDIT_LANDED_UNCONFIRMED,
} from './edit.ts'
import type { RepairReport } from './edit.ts'
import { startRemoteJob } from './jobs.ts'
import type { JobRegistry } from './jobs.ts'
import { remotePathArg, shellQuote, leadingProgram, classifyCollectedRun, effectiveLaneCap, JOB_LANE } from './transport.ts'
import type { RemoteAuth, RemoteTarget, SshTransport } from './transport.ts'
import type { TargetStore } from './store.ts'
import type { TargetSecrets } from './secrets.ts'

/** How many stored targets one `probeAll` covers; the rest are reported as skipped. */
const PROBE_ALL_LIMIT = 12

/** Plain JSON parameters as the route decoded them. */
export type Params = Record<string, unknown>

/** What starting a backgrounded remote command reports. */
export interface BackgroundRunResult {
  /** Always `exec`, because this is one way to run a command. */
  action: 'exec'
  /** Whether the job started. */
  ok: boolean
  /** `started` while it is running, `refused` when the job ceiling turned it away. */
  status: 'started' | 'refused'
  /** The target the command runs on. */
  target: { id: string; label: string; host: string }
  /** The command line that was handed over. */
  command: string
  /** The registry-issued id the reader polls with; absent when the call was refused. */
  jobId?: string
  /** Why the call was refused, in the words the ceiling answers with. */
  message?: string
  /** What to do next. */
  hint?: string | undefined
  /** The refreshed inventory, for the page. */
  connections: ConnectionView[]
}

/** What one `ssh -G` resolution reports. */
export interface ResolveResult {
  /** Always `resolve`. */
  action: 'resolve'
  /** Whether the client understood and resolved the target. */
  ok: boolean
  /** The target that was resolved. */
  target: { id: string; label: string; host: string }
  /** The keys this plugin's calls are built from, as the client would use them. */
  resolved: ResolvedConfig
  /** What the saved record itself says, for comparison. */
  stored: { host: string; user?: string | undefined; port?: number | undefined }
  /** Whether the resolved destination differs from the saved address. */
  differs: boolean
  /** The raw resolved configuration, trimmed for a details panel. */
  text?: string | undefined
  /** Why it failed. */
  message?: string | undefined
  durationMs?: number | undefined
}

/** One remote file operation's canonical result. */
export interface RemoteFileResult {
  /** `read`, `write`, or `edit`. */
  action: 'read' | 'write' | 'edit'
  /** Whether the remote side accepted and completed the call. */
  ok: boolean
  /** Classified transport and command outcome. */
  status: RemoteRunResult['status']
  /** The target that was used, named for the reader. */
  target: { id: string; label: string; host: string }
  /** The remote path the call addressed. */
  path: string
  /** What the path was: a directory is answered with a listing, a file with text. */
  type?: 'file' | 'directory' | 'other' | 'missing'
  /** The file's true size on the server, which may exceed what came back. */
  size?: number
  /** Listing text, when the path was a directory. */
  entriesText?: string
  /** File text, for a read. */
  content?: string
  /** Bytes returned or sent. */
  bytes?: number
  /** Lines of content returned. */
  lines?: number
  /** Whether the ceiling clipped the text. */
  truncated?: boolean
  /** The file holding the whole stream when the ceiling clipped stdout, if one survived. */
  stdoutSpillPath?: string
  /** The file holding the whole stream when the ceiling clipped stderr, if one survived. */
  stderrSpillPath?: string
  /** Whether an existing remote file was replaced. */
  overwrote?: boolean
  /** For `edit`: how many places were replaced. */
  replaced?: number
  /** For a refused `edit`: how many places the text matched, which is why it stopped. */
  matches?: number
  /** For `edit`: the size before and after the change. */
  bytesBefore?: number
  /** For `edit`: the size after the change. */
  bytesAfter?: number
  /**
   * For `edit`: where a copy of the previous content survived this call — the
   * `<path>.dsh-bak` the reader asked for, or the internal snapshot that had to
   * stay because the write went wrong and could not be undone. Absent means no
   * copy exists, which on a failed edit is the sentence worth reading.
   */
  backup?: string
  /** For `edit`: true when the write stopped because the file had changed under the read. */
  stale?: boolean
  /**
   * For `edit`: true when a failed write was undone from the copy **and the server
   * digested the result as the content this call read**. A copy that merely counts
   * out at the right length does not set this — see `verdict`.
   */
  restored?: boolean
  /**
   * For `edit`: whether the content the server has now was confirmed by digest, as
   * opposed to being counted by size or not observed at all. `false` means the
   * plugin cannot say what the file holds; read it.
   */
  contentVerified?: boolean
  /**
   * For `edit`: what the last command this plugin ran can prove about the file.
   *
   * - `landed` — the intended content is in the file, proven by digest;
   * - `intact` — the file still holds the content this call read, proven by digest;
   * - `restored` — the copy was put back and digests as the content this call read;
   * - `unrecoverable` — the file is not what this call read and cannot be put back;
   * - `unknown` — the server could only count bytes, or never answered, so the
   *   content is undetermined. Never read this as a success.
   */
  verdict?: EditVerdict
  /** For `edit`: the SHA-256 the server stated for the file as it stands now. */
  sha256?: string
  /**
   * For `edit`: whether this server stated an inode, size, and nanosecond mtime
   * for the file, which is what a write is checked against before anything is
   * truncated. False means the copy and the byte check still ran and no version
   * was compared — not that the edit was unprotected, and not that it was.
   */
  versionChecked?: boolean
  /** For `edit`: true when the call previewed the change instead of writing it. */
  dryRun?: boolean
  /** For a `dryRun` edit: the line view of what would change, possibly cut short. */
  diff?: string
  /** For a `dryRun` edit: true when `diff` was cut short. */
  diffTruncated?: boolean
  /** Exit code of the remote command. */
  exitCode?: number | null
  /** Duration of the whole call. */
  durationMs?: number
  /** The deadline this call actually ran under, after capping. */
  timeoutMs?: number
  /** The per-stream capture ceiling that actually applied. */
  outputBytes?: number
  /** Objective sentences naming what a bounds resolution corrected on the way here. */
  notes?: readonly string[]
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
  /** What this profile stores as overrides; absent keys follow the configured default. */
  settings: StoredSettings
  limits: {
    maxConnections: number
    concurrentOps: number
    maxLiveMasters: number
    controlPersistSeconds: number
    probeAllLimit: number
  }
  /**
   * The bounds as the running Host resolves them: the configured default and cap
   * for each ceiling, what a call with no override would actually use, and the
   * receipts for anything the configuration had to correct. The page shows this
   * instead of publishing numbers of its own.
   */
  bounds: {
    timeoutMs: number
    maxTimeoutMs: number
    outputBytes: number
    maxOutputBytes: number
    transferBytes: number
    maxTransferBytes: number
    probeTimeoutMs: number
    statTimeoutMs: number
    maxSpillBytes: number
    graceMs: number
    promoteOnTimeout: boolean
    /**
     * How many of the operation slots a background job may hold at once, as this
     * Host resolved it — the number the transport admits against, not the number a
     * profile asked for.
     */
    maxRunningJobs: number
    /** The same number for one file copy. */
    maxConcurrentTransfers: number
    /** Every operation slot there is, jobs and copies and probes alike. */
    concurrentOps: number
    /** The slots a job can never take, which is what keeps a call answerable. */
    foregroundReservedOps: number
    effective: SshSettings
    notes: readonly string[]
  }
  /** Whether calls on this Host can share a connection, and how many masters do. */
  pool: { ready: boolean; liveMasters: number; transfers: number; jobs: number; failure?: string }
  /** This process's spill accounting: what it asked the provider to keep, and what the budget refused. */
  spill: { used: number; files: number; refusals: number; max: number }
  /** What this Host's startup collected from its own temp namespace, if it looked. */
  temp?: TempSummary | undefined
  /** Whether this Host can answer a password or passphrase prompt at all. */
  askpass: 'ready' | 'unavailable'
  /** Why the helper is unavailable, when it is. */
  askpassFailure?: string
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
  /**
   * Run one remote command, resolving the target the same way the tool will.
   * @param params - the call's wire parameters.
   * @param signal - the caller's cancellation, forwarded to the ssh child.
   */
  runCommand(params: Params, signal?: AbortSignal): Promise<{ run: RemoteRunResult; connection?: ConnectionView | undefined; connections: ConnectionView[] }>
  /** Ask the local OpenSSH client what this target really resolves to. */
  resolveRemote(params: Params): Promise<ResolveResult>
  /** Start one remote command as a background job and return its id. */
  execBackground(params: Params): Promise<BackgroundRunResult>
  /**
   * Push one local file or directory to the server.
   * @param params - the call's wire parameters.
   * @param signal - the caller's cancellation, forwarded to the scp child.
   */
  upload(params: Params, signal?: AbortSignal): Promise<RemoteTransferResult>
  /**
   * Pull one remote file into the conversation's workspace.
   * @param params - the call's wire parameters.
   * @param signal - the caller's cancellation, forwarded to the scp child.
   */
  download(params: Params, signal?: AbortSignal): Promise<RemoteTransferResult>
  /** Point a conversation at a target. */
  setSessionTarget(params: Params): Promise<{ sessionTarget: { sessionId: string; targetId: string; setAt: string } | null }>
  /** Forget a conversation's chosen target. */
  clearSessionTarget(params: Params): Promise<{ sessionTarget: null }>
  /**
   * Read one remote path, whether it is a file, a directory, or missing.
   * @param params - the call's wire parameters.
   * @param signal - the caller's cancellation, forwarded to the ssh child.
   */
  readPath(params: Params, signal?: AbortSignal): Promise<RemoteFileResult>
  /**
   * Replace exact text inside one remote file.
   * @param params - the call's wire parameters.
   * @param signal - the caller's cancellation, forwarded to both ssh children.
   */
  editRemote(params: Params, signal?: AbortSignal): Promise<RemoteFileResult>
  /**
   * Write one remote file from text, with the overwrite guard.
   * @param params - the call's wire parameters.
   * @param signal - the caller's cancellation, forwarded to the ssh child.
   */
  writeRemote(params: Params, signal?: AbortSignal): Promise<RemoteFileResult>
  /** Replace this profile's stored ceilings; `null` on a key drops the override. */
  configUpdate(params: Params): Promise<{ settings: StoredSettings; effective: SshSettings; notes: readonly string[] }>
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
  /**
   * Called after the saved inventory changes. The tool description lists the
   * aliases the model chooses between, and the parameter DSL is static, so the
   * holder of the registration decides whether to re-register.
   */
  onInventoryChanged?: (() => void) | undefined
  /** The harness job registry, when the profile mounts one. */
  jobs?: JobRegistry | undefined
  /**
   * The live bounds, read per call so a profile edit lands on the next call. When
   * an assembly brings no configuration the published defaults stand in, each cap at
   * the height of its own default.
   */
  bounds?: (() => Bounds) | undefined
  /**
   * What this Host process can say about its own resources: the spill budget it
   * is holding itself against, and the temp-namespace collection its startup made.
   * Read per call, like the bounds — a number frozen at activation would be a
   * number that stopped being true the moment a stream overflowed.
   */
  observability?: (() => {
    spill: { used: number; files: number; refusals: number; max: number }
    temp: TempSummary | undefined
  }) | undefined
}

/** What one startup's temp-namespace sweep reported. */
export interface TempSummary {
  /** Directories in this plugin's namespace that were looked at. */
  scanned: number
  /** Paths collected, each with the reason it was collectable. */
  removed: { path: string; reason: string }[]
  /** Paths left, with their reasons, counted rather than listed: a live Host's
   own two directories are the ordinary answer. */
  kept: { path: string; reason: string }[]
  /** Paths that could not be read or removed. */
  errors: { path: string; message: string }[]
}

/**
 * Read the identity fields a probe needs out of a stored record or a draft.
 * @param source - a record, or a draft target as the page submitted it.
 * @returns the probe fields.
 */
/**
 * How long a failed edit's repair child may take. It is not the edit's own
 * deadline: the copy it reads back is already on the server, and the wait is a
 * local one.
 */
const EDIT_REPAIR_BUDGET_MS = 30_000

/** The one word a caller may rely on about an edit's file state. */
export type EditVerdict = 'landed' | 'intact' | 'restored' | 'unrecoverable' | 'unknown'

/**
 * Turn the repair child's answer into the verdict this plugin reports.
 *
 * The rule is the whole point of the exercise: **a verdict that claims the file
 * holds particular content needs a digest to back it.** A byte count that matches
 * is a hint about the file, not a statement about it — content B of the same size
 * as content A satisfies the count and falsifies the claim — so every answer the
 * server could only count its way to comes back `unknown`, and no caller reads a
 * same-size collision as a verified edit. A refusal to restore is different in
 * kind: whether it was stated by digest or by size, there is nothing left to put
 * back, so it stays `unrecoverable` either way.
 * @param report - what the repair child attested, with its evidence level.
 * @returns the outward verdict, and nothing else — the prose is built from it.
 */
function editVerdict (report: RepairReport): EditVerdict {
  switch (report.verdict) {
    case 'unrecoverable':
    case 'partial':
      return 'unrecoverable'
    case 'landed':
    case 'intact':
    case 'restored':
      return report.contentVerified ? report.verdict : 'unknown'
    default:
      // No marker at all: the repair child died before it could answer, or its
      // stdout never arrived. Anything else would be this plugin inventing a state.
      return 'unknown'
  }
}

function targetOf(source: RemoteTarget): RemoteTarget {
  return {
    host: source.host,
    // The id is what the pool keys a shared connection by: an edited target gets a
    // new socket name instead of inheriting the master its predecessor left open.
    ...(source.id === undefined ? {} : { id: source.id }),
    ...(source.pool === undefined ? {} : { pool: source.pool }),
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

/**
 * Build the operations over one runner, one storage handle and one credential face.
 * @param deps - the assembled dependencies.
 * @returns the methods the route dispatches to.
 */
export function createOps(deps: OpsDeps): Ops {
  const { runner, store, secrets, askpass } = deps
  const liveBounds = deps.bounds ?? defaultBounds
  /** The resource answers this Host can give that a ceiling in the config cannot,
   * read per call like the bounds: a spill count frozen at activation would be a
   * number that stopped being true with the first overflowing stream. */
  const observed = deps.observability
  const localExists = deps.localExists
  const inventoryChanged = deps.onInventoryChanged
  const jobs = deps.jobs

  /**
   * The ceilings one call runs under.
   *
   * Config default, this profile's stored override, the target's own, and the
   * call's request, in that precedence, capped by the config — and every number the
   * cap pulled down is named in `notes`, because a value that silently changed is
   * the kind of surprise this plugin keeps being asked not to produce.
   * @param stored - what the settings page stores for this profile.
   * @param target - the record the call resolved to, when it resolved to one.
   * @param call - the per-call overrides the caller brought.
   * @returns the resolved ceilings and their receipts.
   */
  function ceilings(stored: StoredSettings, target?: ConnectionRecord, call: CeilingLayers['call'] = {}): ResolvedSettings {
    return resolveSettings(liveBounds(), {
      stored,
      ...(target === undefined ? {} : { target }),
      call,
    })
  }

  /**
   * Attach to a finished remote call what actually applied, and any correction the
   * cap made on the way.
   *
   * This is the layer that resolved the numbers, so this is the layer that can say
   * what they came to; a caller who asked for a deadline above the cap has no other
   * way to learn it was moved, and a silent correction is the surprise this plugin
   * keeps being asked not to produce.
   * @param run - the result the transport handed back.
   * @param settings - the ceilings this call ran under.
   * @param notes - the receipts from the resolution, if any.
   * @returns the same result, stamped.
   */
  function stampCeilings(run: RemoteRunResult, settings: SshSettings, notes: readonly string[]): RemoteRunResult {
    run.timeoutMs = settings.remoteTimeoutMs
    run.outputBytes = settings.maxOutputBytes
    // Merged, not replaced: a capped ceiling and a spill the budget refused are
    // two different sentences about the same call, and the run may already carry
    // the second one when this is called.
    const merged = [...notes, ...(run.notes ?? [])].filter((entry, index, list) => list.indexOf(entry) === index)
    if (merged.length > 0) run.notes = merged
    return run
  }

  /**
   * A wait that can be called off, so a settled command does not leave a timer
   * behind holding the event loop.
   * @param ms - how long to wait before reporting the call still alive.
   * @returns the promise to race, and the way to stand the wait down.
   */
  function wakeAfter(ms: number): { readonly alive: Promise<'alive'>; cancel(): void } {
    let timer: ReturnType<typeof setTimeout> | undefined
    const alive = new Promise<'alive'>((resolve) => {
      timer = setTimeout(() => { resolve('alive') }, ms)
    })
    return {
      alive,
      cancel: (): void => {
        if (timer !== undefined) clearTimeout(timer)
      },
    }
  }

  /**
   * Run one command, and if it outlives its deadline, hand it to the job registry
   * instead of killing it.
   *
   * The deadline belongs to the reply, not to the work — that is how the harness's
   * own shell answers a timeout, and the difference is visible: a long build killed
   * at thirty seconds because a model asked once and waited has to be started again
   * from nothing, while a call that hands over keeps the process running on the
   * server and returns the id that reads it. Registration can still be refused (the
   * registry caps how many jobs one conversation holds), and then this falls back to
   * what the plugin used to do, saying why rather than losing the work quietly.
   * @param record - the target the call resolved to.
   * @param settings - the ceilings this call runs under.
   * @param auth - the credentials for this target.
   * @param command - the assembled remote command line.
   * @param facts - tty, stdin, cancellation, and the job bookkeeping to attach.
   * @returns the run result: settled, promoted with a job id, or a refusal that says
   *   which of the three it is.
   */
  async function runPromoted(
    record: ConnectionRecord,
    settings: SshSettings,
    auth: RemoteAuth,
    command: string,
    facts: {
      readonly tty?: boolean | undefined
      readonly stdin?: string | undefined
      readonly signal?: AbortSignal | undefined
      readonly owner?: string | undefined
      readonly label: string
      readonly toolCall?: { callId: string; rootCallId: string } | undefined
    },
  ): Promise<RemoteRunResult> {
    const startedAt = Date.now()
    const registry = jobs
    if (registry === undefined) throw new SshError('internal', 'A promoted run needs a job registry.')
    const job = await runner.startRun(targetOf(record), settings, auth, command, {
      ...(facts.tty === true ? { tty: true } : {}),
      ...(facts.stdin === undefined ? {} : { stdin: facts.stdin }),
      // No deadline of its own: the wait below is bounded, the command is not. That
      // is the whole difference between a promoted call and a killed one, and
      // `deadline(…, 0, …)` means exactly that to the timeout library — arm no
      // timer, forward only the caller's cancellation.
      timeoutMs: 0,
      ...(facts.signal === undefined ? {} : { signal: facts.signal }),
    })
    if (job === undefined) {
      return {
        at: new Date().toISOString(),
        status: 'ssh-missing',
        durationMs: 0,
        stderr: 'No ssh program was found: PATH and the usual install locations were tried.',
      }
    }
    const wait = wakeAfter(settings.remoteTimeoutMs)
    const outcome = await Promise.race([
      job.finished.then(result => ({ kind: 'settled' as const, result })),
      wait.alive.then(() => ({ kind: 'alive' as const })),
    ])
    wait.cancel()
    if (outcome.kind === 'settled') {
      return classifyCollectedRun(outcome.result, {
        ...(facts.tty === true ? { tty: true } : {}),
        ...(facts.stdin === undefined ? {} : { stdinBytes: Buffer.byteLength(facts.stdin, 'utf8') }),
      })
    }
    // What the command produced so far travels with the hand-over, so the reader is
    // not choosing between "still running" and "here is the output". The provider's
    // offset readers are non-consuming, so the job still reads the whole stream from
    // the beginning afterwards.
    const partial = { stdout: '', stderr: '' }
    for (const source of job.sources) {
      const read = source.read(0)
      if (read.text !== '') partial[source.channel === 'stdout' ? 'stdout' : 'stderr'] = read.text
    }
    const at = new Date().toISOString()
    const durationMs = Date.now() - startedAt
    try {
      const jobId = startRemoteJob(registry, {
        label: facts.label,
        ...(facts.owner === undefined ? {} : { owner: facts.owner }),
        ...(facts.toolCall === undefined ? {} : { toolCall: facts.toolCall }),
        start: async () => job,
      })
      return {
        at,
        status: 'promoted',
        durationMs,
        jobId,
        // Not `truncated`: that word belongs to a ceiling that clipped a stream, and
        // this stream is still being written. What is true is that the text below is
        // only as far as the command had got, and the job carries the whole thing
        // from the beginning — the provider's offset readers are non-consuming, so
        // showing it here costs the reader nothing.
        ...(partial.stdout === '' ? {} : { stdout: partial.stdout }),
        ...(partial.stderr === '' ? {} : { stderr: partial.stderr }),
        message: `The command is still running on the server: it outlived the ${String(settings.remoteTimeoutMs)} ms this call was willing to wait. The text below is only how far it had got by then.`,
        hint: `Read the whole stream with \`job_output\` (job ${jobId}) — it starts from the beginning — and stop it with \`job_kill\`; ask for a longer wait with \`timeoutMs\` if you expected it to finish.`,
      }
    } catch (error: unknown) {
      // The registry said no — usually every job slot this conversation holds is
      // taken. Killing is the old behaviour, and it is still better than a call that
      // reports success over a process nobody can read.
      job.kill()
      return {
        at,
        status: 'timeout',
        durationMs,
        message: `The command ran out of its ${String(settings.remoteTimeoutMs)} ms deadline, and it could not be left running: ${messageOf(error).slice(0, 240)}`,
        hint: 'Stop a job with `job_kill` and run the command again, or raise the ceiling with `timeoutMs`.',
      }
    }
  }

  /** One stored record as the page sees it. */
  async function viewOf(state: TargetStore, record: ConnectionRecord): Promise<ConnectionView> {
    const holder = secrets()
    const slots = holder === undefined ? { password: false, passphrase: false, root: false } : await holder.status(record.id)
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
  async function fileCall(params: Params, action: 'read' | 'write' | 'edit', call: CeilingLayers['call'] = {}) {
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
    // A per-call ceiling now reaches the file actions too. It used to be that a
    // `read` asking for `maxOutputBytes` ran at the shared ceiling anyway — a wart
    // the old suites pinned in place — and folding it into the same resolution every
    // other call uses is the smaller lie than documenting it.
    const asked = typeof params.maxOutputBytes === 'number' ? params.maxOutputBytes : undefined
    const resolved = ceilings(globalSettings, record, {
      ...call,
      maxOutputBytes: asked ?? call.maxOutputBytes,
    })
    const settings = resolved.settings
    const auth = await authFor(record.id, record.auth)
    return { state, record, settings, notes: resolved.notes, auth, path }
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
    action: 'read' | 'write',
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
      ...(run.stdoutSpillPath === undefined ? {} : { stdoutSpillPath: run.stdoutSpillPath }),
      ...(run.stderrSpillPath === undefined ? {} : { stderrSpillPath: run.stderrSpillPath }),
      ...(run.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs }),
      ...(run.outputBytes === undefined ? {} : { outputBytes: run.outputBytes }),
      ...(run.notes === undefined ? {} : { notes: run.notes }),
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
   * Split the marker line a read answered with from its body.
   * @param text - the raw stdout of the read command.
   * @returns the kind, the body, and the reported size, or `undefined` when the
   *   answer carried no marker.
   */
  function splitMarker(text: string): { kind: 'file' | 'directory' | 'other' | 'missing'; text: string; size?: number } | undefined {
    const newline = text.indexOf('\n')
    const head = newline === -1 ? text : text.slice(0, newline)
    const match = /^ssh-plugin:\s+(directory|file|other|missing)(?:\s+(\d+))?\s*$/u.exec(head.trim())
    if (match === null) return undefined
    const rest = newline === -1 ? '' : text.slice(newline + 1)
    const size = match[2] === undefined ? undefined : Number(match[2])
    return {
      kind: (match[1] ?? 'file') as 'file' | 'directory' | 'other' | 'missing',
      text: rest,
      ...(size === undefined || !Number.isFinite(size) ? {} : { size }),
    }
  }

  /**
   * Read the handful of resolved keys this plugin's calls actually affect.
   * @param text - the `ssh -G` output.
   * @returns the parsed keys, omitting any the client did not print.
   */
  function parseResolved(text: string): ResolvedConfig {
    const resolved: ResolvedConfig = {}
    const identities: string[] = []
    for (const line of (text ?? '').split('\n')) {
      const match = /^(\S+)\s+(.*)$/u.exec(line.trim())
      if (match === null) continue
      const key = (match[1] ?? '').toLowerCase()
      const raw = (match[2] ?? '').trim()
      switch (key) {
        case 'hostname':
          resolved.hostname = raw
          break
        case 'port': {
          const port = Number(raw)
          if (Number.isInteger(port) && port > 0 && port <= 65535) resolved.port = port
          break
        }
        case 'user':
          resolved.user = raw
          break
        case 'identityfile':
          if (raw !== '') identities.push(raw)
          break
        case 'proxyjump':
          if (raw !== 'none') resolved.proxyJump = raw
          break
        case 'proxycommand':
          if (raw !== 'none') resolved.proxyCommand = raw
          break
        default:
          break
      }
    }
    if (identities.length > 0) resolved.identityFiles = identities
    return resolved
  }

  /**
   * Whether the client's answer differs from the address the user saved.
   * @param resolved - the parsed `ssh -G` keys.
   * @param stored - what the record itself says.
   * @returns true when at least one field was resolved to something else.
   */
  function resolvedDiffers(resolved: ResolvedConfig, stored: { host: string; user?: string | undefined; port?: number | undefined }): boolean {
    if (resolved.hostname !== undefined && resolved.hostname !== stored.host) return true
    if (resolved.user !== undefined && resolved.user !== stored.user) return true
    if (resolved.port !== undefined && resolved.port !== (stored.port ?? 22)) return true
    return resolved.proxyJump !== undefined || resolved.proxyCommand !== undefined
  }

  /**
   * Validate one transfer call and run it, keeping the refusal language the same
   * for both directions.
   * @param direction - which way the bytes go.
   * @param params - validated inputs.
   * @param signal - the caller's cancellation, forwarded to the scp child (and
   *   to its pre-checks), so a cancelled copy leaves the destination untouched.
   * @returns the canonical transfer result.
   */
  async function move(direction: 'upload' | 'download', params: Params, signal?: AbortSignal): Promise<RemoteTransferResult> {
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
    let destinationExists = false
    if (direction === 'download' && localExists !== undefined) {
      destinationExists = await localExists(local)
      if (destinationExists && !overwrite) {
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
    }
    const resolved = ceilings(globalSettings, record, { timeoutMs: input.timeoutMs, maxBytes: input.maxBytes })
    const settings = resolved.settings
    const auth = await authFor(record.id, record.auth)
    const outcome = await transfer(runner, targetOf(record), settings, auth, {
      direction,
      localPath: local,
      remotePath: input.path,
      ...(input.recursive === undefined ? {} : { recursive: input.recursive }),
      overwrite,
      // All four numbers are already resolved: the ceiling this copy runs
      // under, the pre-check ceilings for a tree, and the deadline its pre-check
      // and transfer wait to — the transfer deadline being its own clock, not
      // the 30 s command default, so a permitted copy is not killed mid-stream.
      maxBytes: settings.maxTransferBytes,
      maxFiles: settings.maxTransferFiles,
      maxTotalBytes: settings.maxTransferTotalBytes,
      ...(destinationExists ? { destinationExists: true } : {}),
      timeoutMs: settings.transferTimeoutMs,
      ...(signal === undefined ? {} : { signal }),
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
      bytesLimit: settings.maxTransferBytes,
      timeoutMs: settings.transferTimeoutMs,
      // Which ceiling answered, and what the copy has to say about the numbers it
      // quotes: a single file is held to the bytes that moved, a tree to what a
      // `stat` or a walk said before they did. The notes travel with it, merged
      // with the ones a capped ceiling produced, so a reader gets one list.
      limitMode: outcome.limitMode,
      ...((outcome.notes === undefined || outcome.notes.length === 0) && resolved.notes.length === 0
        ? {}
        : { notes: [...resolved.notes, ...(outcome.notes ?? [])] }),
      ...(outcome.bytes === undefined ? {} : { bytes: outcome.bytes }),
      ...(outcome.files === undefined ? {} : { files: outcome.files }),
      ...(input.recursive === true ? { recursive: true } : {}),
      ...(outcome.overwrote === true ? { overwrote: true } : {}),
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
      // A refusal that already knows what to suggest — a full transfer lane names
      // `job_kill` and the ceiling to raise — is not improved by a generic hint.
      ...(outcome.hint === undefined ? {} : { hint: outcome.hint }),
    }
    if (base.ok) return base
    return { ...base, ...(base.hint === undefined ? { hint: transferHint(outcome.status, direction) } : {}) }
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

  return {
    async list(params: Params = {}): Promise<ListResult> {
      const state = await store()
      const stored = state.settings()
      const bounds = liveBounds()
      const resolved = ceilings(stored)
      const helper = askpass()
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      const chosen = sessionId === '' ? undefined : state.getSessionTarget(sessionId)?.targetId
      return {
        connections: await viewsOf(state),
        ...(chosen === undefined ? {} : { sessionTarget: chosen }),
        settings: stored,
        limits: {
          maxConnections: MAX_CONNECTIONS,
          concurrentOps: MAX_CONCURRENT_OPS,
          maxLiveMasters: MAX_LIVE_MASTERS,
          controlPersistSeconds: CONTROL_PERSIST_SECONDS,
          probeAllLimit: PROBE_ALL_LIMIT,
        },
        bounds: {
          timeoutMs: bounds.timeoutMs,
          maxTimeoutMs: bounds.maxTimeoutMs,
          outputBytes: bounds.outputBytes,
          maxOutputBytes: bounds.maxOutputBytes,
          transferBytes: bounds.transferBytes,
          maxTransferBytes: bounds.maxTransferBytes,
          probeTimeoutMs: bounds.probeTimeoutMs,
          statTimeoutMs: bounds.statTimeoutMs,
          maxSpillBytes: bounds.maxSpillBytes,
          graceMs: bounds.graceMs,
          promoteOnTimeout: bounds.promoteOnTimeout,
          // The lane numbers belong in the same payload as the ceilings they are
          // derived from: a page that printed a job ceiling of its own invention is
          // how 0.0.36 came to show a probe timeout that was not the one the Host
          // dialed with.
          maxRunningJobs: effectiveLaneCap({ kind: JOB_LANE, cap: bounds.maxRunningJobs }),
          maxConcurrentTransfers: bounds.maxConcurrentTransfers,
          concurrentOps: MAX_CONCURRENT_OPS,
          foregroundReservedOps: FOREGROUND_RESERVED_OPS,
          effective: resolved.settings,
          notes: resolved.notes,
        },
        askpass: helper.ready ? 'ready' : 'unavailable',
        ...(helper.ready || helper.failure === undefined ? {} : { askpassFailure: helper.failure.slice(0, 512) }),
        pool: {
          ready: runner.mux.ready,
          liveMasters: runner.liveMasters,
          // The transfer lane is the one ceiling a reader can hit without having
          // done anything wrong — two copies are moving and a third is turned away
          // — and until now the refusal was the only place its number appeared.
          transfers: runner.transfersInFlight,
          // The job lane is the one that can be full for hours and stay invisible,
          // because nothing is waiting on a job: this is where a reader finds out why
          // the next `background: true` was refused.
          jobs: runner.laneUsage(JOB_LANE),
          ...(runner.mux.failure === undefined ? {} : { failure: runner.mux.failure.slice(0, 512) }),
        },
        probing: runner.inFlight,
        spill: runner.spill,
        ...(observed === undefined ? {} : { temp: observed().temp }),
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
      inventoryChanged?.()
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
      inventoryChanged?.()
      return { removed: true, orphanSecrets, connections: await viewsOf(state) }
    },

    async probe(params: Params) {
      const state = await store()
      const storedSettings = state.settings()
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
        const probe = await runner.probe(targetOf(draft), ceilings(storedSettings).settings, auth)
        return { probe, connections: await viewsOf(state) }
      }
      const id = typeof params.id === 'string' ? params.id : ''
      if (id === '') throw new SshError('bad-input', 'Probe needs the id of one stored SSH target, or a draft.', { field: 'id' })
      const record = state.get(id)
      if (record === undefined) throw new SshError('not-found', `No stored SSH target carries the id "${id}".`, { field: 'id' })
      const auth = await authFor(record.id, record.auth)
      const outcome = await runner.probe(targetOf(record), ceilings(storedSettings, record).settings, auth)
      const updated = await state.recordProbe(id, outcome)
      const connection = updated === undefined ? undefined : await viewOf(state, updated)
      return { ...(connection === undefined ? {} : { connection }), connections: await viewsOf(state) }
    },

    async probeAll() {
      const state = await store()
      const storedSettings = state.settings()
      const all = state.list()
      const chosen = all.slice(0, PROBE_ALL_LIMIT)
      const failures: { id: string; message: string }[] = []
      let cursor = 0
      const lanes = Math.min(MAX_CONCURRENT_OPS, Math.max(1, chosen.length))
      await Promise.all(
        Array.from({ length: lanes }, async () => {
          while (cursor < chosen.length) {
            const record = chosen[cursor]
            if (record === undefined) break
            cursor += 1
            try {
              const auth = await authFor(record.id, record.auth)
              const outcome = await runner.probe(targetOf(record), ceilings(storedSettings, record).settings, auth)
              await state.recordProbe(record.id, outcome)
            } catch (error: unknown) {
              failures.push({ id: record.id, message: messageOf(error) })
            }
          }
        }),
      )
      return { connections: await viewsOf(state), probed: chosen.length, skipped: all.length - chosen.length, failures }
    },

    async runCommand(params: Params, signal?: AbortSignal) {
      const state = await store()
      const globalSettings = state.settings()
      // The registry's own bookkeeping travels with the call so a command that gets
      // promoted names the conversation and the call that started it — and the run
      // schema is strict, so it is read off first.
      const { callId, rootCallId, ...runParams } = params
      const toolCall = typeof callId === 'string' && typeof rootCallId === 'string'
        ? { callId, rootCallId }
        : undefined
      const owner = typeof runParams.sessionId === 'string' ? runParams.sessionId : undefined
      let input: ReturnType<typeof remoteRunSchema.parse>
      try {
        input = remoteRunSchema.parse(runParams.command !== undefined ? runParams : { command: runParams })
      } catch (error: unknown) {
        throw new SshError('bad-input', messageOf(error), { field: fieldOf(error) ?? 'command', hint: 'Fix the reported value and try again.' })
      }
      const record = pickTarget(state, params)
      if (record.agentAccess === 'off') {
        throw new SshError('bad-input', `"${record.label}" is set to agent access off, so no remote command may run on it.`, { field: 'target', hint: 'Turn agent access on for this target in the settings page.' })
      }
      const resolved = ceilings(globalSettings, record, { timeoutMs: input.timeoutMs, maxOutputBytes: input.maxOutputBytes })
      const settings = resolved.settings
      const auth = await authFor(record.id, record.auth)
      // Elevation assembly. Both mechanisms need an answer at a prompt, and the
      // plugin holds secrets the model never sees: `as` reaches an account
      // through sudo answered with the stored login password, `su` reaches root
      // through its own stored root password. Either forces a pseudo-terminal
      // so the prompt actually reaches the injected stdin, and neither ever
      // echoes the secret back — the result reports stdinBytes, like any other
      // stdin use.
      let command = input.command
      let tty = input.tty
      let stdin = input.input
      let elevated: string | undefined
      const holder = secrets()
      // sudo and su answer their prompt on the one stdin the command body would
      // use, and the prompt comes first: under `-tt` the remote pty reads the
      // password from the same stream the body travels down, so a call that
      // asked for elevation AND carried an `input` body had its first line eaten
      // as the answer — silently dropping one of the two. The pair is refused
      // up front instead of picking a loser. One combination survives, and only
      // one: `as` with no stored login password runs `sudo -n`, which prompts
      // never — a NOPASSWD host takes the body intact, a prompting one fails
      // fast with a real reason, and neither path spends the body's first line.
      if (input.su === true && input.input !== undefined) {
        throw new SshError('bad-input', 'su answers its password prompt on the same stdin the command body would use, so a su call cannot also carry input.', {
          field: 'input',
          hint: 'Drop input and su will answer with the stored root password, or fold the body into the command itself (printf … | su root -c …) and run it in the foreground.',
        })
      }
      if (input.as !== undefined && input.input !== undefined) {
        const storedForSudo = holder === undefined ? undefined : await holder.read(record.id, 'password')
        if (storedForSudo !== undefined) {
          throw new SshError('bad-input', 'sudo is prompted on the same stdin this call filled with input, and this target stores a login password the prompt would answer with instead.', {
            field: 'input',
            hint: 'Run the elevated command without input and let the plugin answer the prompt, or pipe the body inside the command (echo … | sudo tee …).',
          })
        }
      }
      if (input.as !== undefined) {
        elevated = input.as
        const stored = holder === undefined ? undefined : await holder.read(record.id, 'password')
        // Whether *the plugin* can answer the prompt — not merely whether a
        // stdin exists. `input` was refused above when a password is stored, so
        // the only body left here travels to a `sudo -n` that never prompts.
        const willAnswer = stored !== undefined
        // A caller who wrote their own sudo line keeps it verbatim; the prefix
        // only arrives when the command is an ordinary one. Without a password
        // to inject, sudo runs with -n so a NOPASSWD host answers immediately
        // and a prompting one fails fast instead of waiting out the deadline.
        if (leadingProgram(command) !== 'sudo') {
          const head = willAnswer ? 'sudo' : 'sudo -n'
          command = input.as === 'root' ? `${head} ${command}` : `${head} -u ${shellQuote(input.as)} ${command}`
        }
        tty = true
        if (stdin === undefined && stored !== undefined) stdin = `${stored}\n`
      } else if (input.su === true) {
        elevated = 'su:root'
        if (holder === undefined) throw new SshError('secret-error', 'su needs the credential store for the root password, and this Host does not expose one.')
        const rootPassword = stdin === undefined ? await holder.read(record.id, 'root') : undefined
        if (stdin === undefined && rootPassword === undefined) {
          throw new SshError('bad-input', `"${record.label}" has no stored root password, so a su prompt could not be answered.`, {
            field: 'su',
            hint: 'Save the root password in the target form, or use as: "root" — sudo answers with the login password instead.',
          })
        }
        if (leadingProgram(command) !== 'su') command = `su root -c ${shellQuote(command)}`
        tty = true
        if (stdin === undefined && rootPassword !== undefined) stdin = `${rootPassword}\n`
      }
      // Promoting is the default because a deadline that belongs to the reply
      // should not be allowed to destroy the work. A profile without a job registry,
      // or one that sets `promoteOnTimeout: false`, keeps the old bounded wait.
      const promotable = liveBounds().promoteOnTimeout && jobs !== undefined
      const run = promotable
        ? await runPromoted(record, settings, auth, command, {
          ...(tty === true ? { tty: true } : {}),
          ...(stdin === undefined ? {} : { stdin }),
          // The caller's cancellation outranks the deadline: the transport fuses
          // the two and reports whichever fired first, so a user cancel reads as
          // `cancelled` and this plugin's own timeout still reads as `timeout`.
          ...(signal === undefined ? {} : { signal }),
          label: `${record.label}: ${command}`,
          ...(owner === undefined ? {} : { owner }),
          ...(toolCall === undefined ? {} : { toolCall }),
        })
        : await runner.run(targetOf(record), settings, auth, command, {
          ...(tty === undefined ? {} : { tty }),
          ...(stdin === undefined ? {} : { stdin }),
          ...(signal === undefined ? {} : { signal }),
        })
      if (elevated !== undefined) run.elevated = elevated
      // What applied, and whether a cap had to move it: only this layer knows.
      stampCeilings(run, settings, resolved.notes)
      const connection = await viewOf(state, record)
      return { run, connection, connections: await viewsOf(state) }
    },

    async readPath(params: Params, signal?: AbortSignal): Promise<RemoteFileResult> {
      const { record, settings, notes, auth, path } = await fileCall(params, 'read')
      // One round trip answers a file, a directory, and a miss. The remote shell
      // prints a marker line naming which it found — `file` carries the byte size
      // the server reported, so a clipped read can say how much was left behind —
      // and everything after the first line is the answer itself. A reply with no
      // marker is taken as plain file text, which is what a shell that could not
      // run the test would have produced anyway.
      const quoted = remotePathArg(path)
      const command = `if [ -d ${quoted} ]; then printf 'ssh-plugin: directory\\n'; ls -la -- ${quoted}; `
        + `elif [ -f ${quoted} ]; then printf 'ssh-plugin: file %s\\n' "$(wc -c < ${quoted} | tr -dc 0-9)"; cat -- ${quoted}; `
        + `elif [ -e ${quoted} ]; then printf 'ssh-plugin: other\\n'; ls -la -- ${quoted}; `
        + `else printf 'ssh-plugin: missing\\n'; exit 20; fi`
      const run = await runner.run(targetOf(record), settings, auth, command, {
        ...(signal === undefined ? {} : { signal }),
      })
      stampCeilings(run, settings, notes)
      const body = splitMarker(run.stdout ?? '')
      if (body === undefined) {
        return fileResult('read', record, path, run, undefined, run.stdout ?? '', { type: 'file' })
      }
      if (body.kind === 'directory' || body.kind === 'other') {
        return fileResult('read', record, path, run, body.text, undefined, { type: body.kind })
      }
      if (body.kind === 'missing') {
        return fileResult('read', record, path, run, undefined, '', {
          type: 'missing',
          message: `Nothing at ${path} on ${record.host}.`,
          hint: 'List the parent directory with the same read call, or check the path.',
        })
      }
      return fileResult('read', record, path, run, undefined, body.text, {
        type: 'file',
        ...(body.size === undefined ? {} : { size: body.size }),
      })
    },

    async editRemote(params: Params, signal?: AbortSignal): Promise<RemoteFileResult> {
      const { record, settings, notes, auth, path } = await fileCall(params, 'edit')
      const oldText = typeof params.oldText === 'string' ? params.oldText : ''
      const newText = typeof params.newText === 'string' ? params.newText : ''
      const quoted = remotePathArg(path)
      const target = { id: record.id, label: record.label, host: record.host }
      const read = await runner.run(targetOf(record), settings, auth, buildEditRead(quoted), {
        ...(signal === undefined ? {} : { signal }),
      })
      stampCeilings(read, settings, notes)
      if (read.status !== 'succeeded') {
        const missing = read.exitCode === EDIT_MISSING
        return {
          action: 'edit',
          ok: false,
          status: read.status,
          target,
          path,
          type: missing ? 'missing' : 'file',
          ...(read.durationMs === undefined ? {} : { durationMs: read.durationMs }),
          ...(read.exitCode === undefined ? {} : { exitCode: read.exitCode }),
          message: missing ? `There is no regular file at ${path} on ${record.host}.` : (read.stderr ?? 'The remote file could not be read.'),
          hint: missing ? 'Read the parent directory, or write the file first.' : 'Read the file to see what came back.',
        }
      }
      if (read.truncated === true) {
        return {
          action: 'edit',
          ok: false,
          status: 'exit-nonzero',
          target,
          path,
          type: 'file',
          ...(read.durationMs === undefined ? {} : { durationMs: read.durationMs }),
          message: 'The file is larger than the read ceiling, so an edit could not see all of it.',
          hint: 'Raise the output ceiling in Settings → Remote connections, or replace the file with write.',
        }
      }
      // The read answered with three markers and then the file: the `stat` token, the
      // digest this server computed over the bytes it was about to hand over, and how
      // many of those bytes there were. A server whose `stat` cannot state a token,
      // that has no checksum tool, or whose `wc -c` could not run leaves that marker
      // empty, and the edit runs without the corresponding guard rather than refusing
      // to run — the safety copy and the checks that follow still stand, and the
      // result says which guard was in force.
      const { version, digest: originalSha256, bodyBytes, content } = splitEditVersion(read.stdout ?? '')
      // K-6: the byte count and the digest the server stated are not decoration. They
      // are the only evidence available that the text this call is about to edit *is*
      // the file — that nothing was clipped below the ceiling, that the stream did not
      // carry a line from outside the file, and that the bytes were not silently
      // rewritten by decoding a file that is not valid UTF-8. An edit that went ahead
      // on a body like that would replace the file with something the server never
      // agreed to, and the loss would be exactly the part nobody saw. This is checked
      // before the match, before any dry-run preview, and long before anything is
      // copied or truncated.
      const integrity = verifyEditBody(content, {
        ...(bodyBytes === undefined ? {} : { bytes: bodyBytes }),
        ...(originalSha256 === undefined ? {} : { digest: originalSha256 }),
      })
      if (!integrity.ok) {
        return {
          action: 'edit',
          ok: false,
          status: 'exit-nonzero',
          target,
          path,
          type: 'file',
          contentVerified: false,
          versionChecked: version !== undefined,
          ...(read.durationMs === undefined ? {} : { durationMs: read.durationMs }),
          message: `${path} was read, but the body of that read is not provably the file, so nothing was written and the file is unchanged. ${integrity.message}`,
          hint: integrity.hint,
        }
      }
      const outcome = applyEdit({
        content,
        oldText,
        newText,
        ...(params.all === undefined ? {} : { all: params.all === true }),
        ...(params.replaceFirst === undefined ? {} : { replaceFirst: params.replaceFirst === true }),
      })
      if (!outcome.ok) {
        return {
          action: 'edit',
          ok: false,
          status: 'exit-nonzero',
          target,
          path,
          type: 'file',
          ...(read.durationMs === undefined ? {} : { durationMs: read.durationMs }),
          message: outcome.message,
          hint: outcome.hint,
          ...(outcome.reason === 'ambiguous' ? { matches: outcome.found } : {}),
        }
      }
      if (params.dryRun === true) {
        // The preview path: the match was found and the replacement text
        // computed, and the server keeps its file. Nothing is written, no
        // backup is taken, and the only thing dialed was the read this call
        // needed anyway. `matches` semantics on refusal are unchanged: a dry
        // run refuses an ambiguous match exactly like the real edit would.
        const preview = previewEdit(content, outcome.text)
        return {
          action: 'edit',
          ok: true,
          status: 'succeeded',
          target,
          path,
          type: 'file',
          dryRun: true,
          replaced: outcome.count,
          bytesBefore: preview.bytesBefore,
          bytesAfter: preview.bytesAfter,
          ...(preview.diff === '' ? {} : { diff: preview.diff }),
          ...(preview.truncated ? { diffTruncated: true } : {}),
          // The preview tells the reader whether the write the same call would do
          // is guarded: a dry run on a server that cannot state a version would
          // overwrite whatever else has touched the file, and that is worth knowing
          // before deciding the preview is enough.
          versionChecked: version !== undefined,
          ...(read.durationMs === undefined ? {} : { durationMs: read.durationMs }),
          ...(originalSha256 === undefined
            ? { notes: [`this server stated no usable SHA-256 for ${path}, so a safe edit is not available here: the same call without dryRun is refused before anything is copied or written, and the file is left unchanged`] }
            : {}),
          // K-1: the preview has to say what the matching write would really do. On a
          // server that cannot state a usable digest that write is **refused**, so the
          // sentence this branch used to carry — "the same call without dryRun applies
          // this change" — invited a reader to treat `dryRun` as the thing standing in
          // the way. It is not: no value of this flag lets an uncheckable overwrite
          // through, and the hint now says so on the flag's own terms.
          hint: originalSha256 === undefined
            ? 'Dry run: nothing was written and no backup was taken. The same call without dryRun would be refused on this server, which states no usable SHA-256, so turning this flag off does not make the edit apply.'
            : 'Dry run: nothing was written and no backup was taken. The same call without dryRun applies this change.',
        }
      }
      // K-1: the SHA-256 capability is decided here, before anything is copied or
      // truncated, not discovered after the fact. This read asked the server, in
      // the same round trip that produced the text, for a checksum of those exact
      // bytes; an empty answer means this server cannot state one (no `sha256sum`,
      // no `shasum`, no `openssl`, or the tool failed to run). Without a digest to
      // check what lands, an overwrite here is a bet the reader cannot audit: the
      // byte count proves length, not content, and a same-length different body
      // would sail through. So the edit **refuses before writing** — no copy, no
      // truncation — and leaves the file exactly as the read found it. The reader
      // gets a clear reason and two ways forward, rather than a write that landed
      // unverified and now has to be read back and second-guessed.
      if (originalSha256 === undefined) {
        return {
          action: 'edit',
          ok: false,
          status: 'exit-nonzero',
          target,
          path,
          type: 'file',
          contentVerified: false,
          versionChecked: version !== undefined,
          bytesBefore: outcome.bytesBefore,
          bytesAfter: outcome.bytesAfter,
          ...(read.durationMs === undefined ? {} : { durationMs: read.durationMs }),
          message: `${record.host} stated no usable SHA-256 for ${path} — no checksum tool, or a value that is not a digest — so this edit was not written and the file is unchanged: an overwrite that cannot be checked after it lands would have left the new bytes unverified and the old ones at the mercy of the copy step.`,
          hint: `Put a checksum tool (sha256sum, shasum, or openssl) on ${record.host} and re-run, or replace the whole file with \`write\` (which needs no read-verify). \`dryRun\` only previews a change: no setting of it lets this edit write on a server that cannot attest the bytes.`,
        }
      }
      // The write is guarded, copied, checked, and — if any of that goes wrong
      // after the copy — put back.
      //
      // What does not change is *how* the bytes land: `cat >` through the existing
      // inode, so the owner, the mode, and every hardlink pointed at the file
      // survive the overwrite. A temp file and a rename would be tidier to reason
      // about and would quietly break all three (measured on a live server: an
      // overwrite kept `inode 584, mode 640, links 2`, and the second name saw the
      // new content because it is the same file). So the integrity comes from the
      // copy taken before the truncation and the **digest of what is in the file
      // after it**, not from an atomic swap this plugin would have to apologise for
      // later. The digest is asked of the server, never computed here from the text
      // we meant to send: counting the bytes was the old check, and a second writer
      // can produce the same count with different content.
      //
      // What that buys, and what it does not: the version guard runs in the same
      // shell that truncates the file, which shrinks the window between noticing a
      // change and making one to a couple of shell builtins — it does not close
      // it. This is still a preview-and-confirm flow, not a transaction.
      const keepBackup = params.backup !== false
      const backupPath = keepBackup
        ? `${path}.dsh-bak`
        : `${path}.dsh-snap-${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const backupArg = remotePathArg(backupPath)
      const expectedSha256 = digestHex(outcome.text)
      const wrote = await runner.run(targetOf(record), settings, auth, buildEditWrite({
        pathArg: quoted,
        backupArg,
        version,
        ...(originalSha256 === undefined ? {} : { originalSha256 }),
        expectedBytes: outcome.bytesAfter,
        expectedSha256,
        keepBackup,
      }), {
        stdin: outcome.text,
        maxOutputBytes: settings.maxOutputBytes,
        ...(signal === undefined ? {} : { signal }),
      })
      const durationMs = (wrote.durationMs ?? 0) + (read.durationMs ?? 0)
      const base = {
        action: 'edit' as const,
        target,
        path,
        type: 'file' as const,
        replaced: outcome.count,
        bytesBefore: outcome.bytesBefore,
        bytesAfter: outcome.bytesAfter,
        versionChecked: version !== undefined,
        durationMs,
      }
      const report = parseWriteReport(wrote.stdout)
      if (wrote.status === 'succeeded' && report.evidence === 'digest') {
        // The write command removes the copy itself when the reader did not ask
        // for one, so a success that says `backup` is a success whose previous
        // content really is where the sentence says it is.
        return {
          ...base,
          ok: true,
          status: 'succeeded' as const,
          contentVerified: true,
          verdict: 'landed' as const,
          sha256: report.sha256 ?? expectedSha256,
          ...(keepBackup ? { backup: backupPath } : {}),
        }
      }
      if (wrote.status === 'succeeded') {
        // Exit 0 without a digest to stand on (a server with no `sha256sum`,
        // `shasum`, or `openssl`): the count says the body is there, and nothing
        // on this server can say the bytes are. The copy stays where it is for
        // either value of `backup`, because dropping it is a claim this branch
        // cannot support.
        return {
          ...base,
          ok: false,
          status: 'succeeded' as const,
          contentVerified: false,
          verdict: 'unknown' as const,
          ...(report.bytes === undefined ? {} : { size: report.bytes }),
          backup: backupPath,
          message: `${path} holds ${String(report.bytes ?? outcome.bytesAfter)} bytes, which is the length this edit sent, but this server stated no checksum for the file, so it is not proven to be this edit's content.`,
          hint: `Read ${path} to see what is in it, and recover the previous content from ${backupPath} if that is not it. Do not re-run the edit blind: it would read the file fresh.`,
        }
      }
      if (wrote.exitCode === EDIT_CONTENT_UNVERIFIED) {
        // The write finished and the count matches; this server has no
        // `sha256sum`, `shasum`, or `openssl`, so nothing here can prove the bytes
        // are the ones this edit sent. No repair: the file is not known to be
        // damaged, and undoing a change that probably landed would be a worse guess
        // than naming the doubt. The copy is left in place for exactly that reason,
        // whatever `backup` was asked for.
        return {
          ...base,
          ok: false,
          status: 'exit-nonzero' as const,
          contentVerified: false,
          verdict: 'unknown' as const,
          ...(report.bytes === undefined ? {} : { size: report.bytes }),
          backup: backupPath,
          message: `${path} holds ${String(report.bytes ?? outcome.bytesAfter)} bytes, which is the length this edit sent, but this server stated no checksum for the file, so those bytes are not proven to be this edit's content.`,
          hint: `Read ${path} to see what is in it; the previous content is at ${backupPath} until you confirm. Do not re-run the edit blind, and put a sha256 tool (sha256sum, shasum, or openssl) on the server if this answer is not good enough.`,
        }
      }
      // A refusal that stopped before the file was touched needs no repair, and
      // says so in the same breath it gives the reason.
      if (wrote.exitCode === EDIT_STALE) {
        // Two guards can refuse: the `stat` token moved, or — invisible to a
        // same-size rewrite with a coarse mtime — the content the server digested
        // at write time is not the content the read digested. Which one happened is
        // what the child said on stderr. No write verdict applies here: this call
        // never truncated the file, and what is in it now belongs to someone else.
        const byContent = (wrote.stderr ?? '').includes('content changed')
        return {
          ...base,
          ok: false,
          status: 'exit-nonzero' as const,
          stale: true,
          message: `The file changed on ${record.host} between reading it and editing it, so this edit stopped before writing anything${byContent ? ' (its content no longer matches the digest taken at the read)' : ''}${version === undefined ? '' : ` (it was ${version} at the read)`}.`,
          hint: 'Read the file again, then re-run the edit against what is there now.',
        }
      }
      if (wrote.exitCode === EDIT_MISSING) {
        return {
          ...base,
          ok: false,
          status: 'exit-nonzero' as const,
          type: 'missing' as const,
          message: `${path} was gone by the time the write child reached for it.`,
          hint: 'Read the path to see where it went, or write it fresh.',
        }
      }
      if (wrote.exitCode === EDIT_BACKUP_FAILED) {
        return {
          ...base,
          ok: false,
          status: 'exit-nonzero' as const,
          message: `The edit could not make its safety copy of ${path}, so nothing was written: ${(wrote.stderr ?? 'the server refused the copy').slice(0, 400)}`,
          hint: 'Free space or fix the directory permissions on the server, then try again.',
        }
      }
      // Past this point the file may hold a partial body: find out which, and put
      // the previous content back through the same inode when it does.
      // The repair does not ride the caller's signal. A reader who stopped the
      // write stopped *the edit*; the file being whole again is not a thing they
      // asked to cancel, and a repair child killed by the same abort that just cut
      // the write short would leave the truncation with the undo sitting one path
      // away, unapplied. It runs on its own short budget instead — the copy is on
      // the server's own disk, so thirty seconds is generous, and the wait is
      // bounded whatever the caller chose.
      const repaired = await runner.run(targetOf(record), settings, auth, buildEditRestore({
        pathArg: quoted,
        backupArg,
        originalBytes: outcome.bytesBefore,
        intendedBytes: outcome.bytesAfter,
        expectedSha256,
        ...(originalSha256 === undefined ? {} : { originalSha256 }),
        ...(report.preSha256 === undefined ? {} : { preSha256: report.preSha256 }),
        keepBackup,
      }), {
        maxOutputBytes: settings.maxOutputBytes,
        timeoutMs: Math.min(settings.remoteTimeoutMs, EDIT_REPAIR_BUDGET_MS),
      })
      const reason = wrote.stderr === undefined || wrote.stderr === ''
        ? `the write child ended ${String(wrote.exitCode ?? wrote.status)}`
        : wrote.stderr
      // The repair child says which of five things is true about the file, and says
      // **how it knows**. Reading its answer, rather than assuming the write left a
      // mess, is what keeps the sentences below supportable: a cancelled call that
      // stopped before the truncation must not be reported as a repair, and a lost
      // answer is not a failure to write. And a verdict the server counted its way
      // to is reported as `unknown`, because the count is not the content.
      const repair = parseRepairReport(repaired.stdout)
      const verdict = editVerdict(repair)
      const atBytes = repair.bytes
      const measured = `${atBytes === undefined ? 'an unknown number of' : String(atBytes)} bytes`
      const digestNote = repair.sha256 === undefined ? '' : `, digest ${repair.sha256}`
      if (repair.verdict === 'landed') {
        return {
          ...base,
          ok: false,
          status: wrote.status,
          contentVerified: repair.contentVerified,
          verdict,
          ...(repair.sha256 === undefined ? {} : { sha256: repair.sha256 }),
          ...(atBytes === undefined ? {} : { size: atBytes }),
          backup: backupPath,
          message: repair.contentVerified
            ? `The answer from the write never arrived, but the server has since digested ${path} at exactly the content this edit meant to send (${measured}${digestNote}) — the change is on the server, and the previous content is at ${backupPath}.`
            : `The answer from the write never arrived, and ${path} now holds ${measured}, the length this edit meant to send — but this server stated no checksum, so those bytes are not proven to be this edit's content. The previous content is at ${backupPath}.`,
          hint: 'Read the file to confirm it, rather than editing it again from memory.',
        }
      }
      if (repair.verdict === 'intact') {
        // Nothing was truncated: the call stopped before the write reached the
        // file, so there was nothing to put back and no copy to promise.
        return {
          ...base,
          ok: false,
          status: wrote.status,
          contentVerified: repair.contentVerified,
          verdict,
          ...(atBytes === undefined ? {} : { size: atBytes }),
          ...(repair.sha256 === undefined ? {} : { sha256: repair.sha256 }),
          message: repair.contentVerified
            ? `The edit stopped (${reason.slice(0, 300)}) before the write reached ${path}; the server has since digested the file as the content this call read (${measured}${digestNote}).`
            : `The edit stopped (${reason.slice(0, 300)}) before the write reached ${path}; the file still holds ${measured}, the length it had before, though this server stated no checksum to prove the content did not move.`,
          hint: 'Run the same edit again, or read the file first if other writers are on it.',
        }
      }
      if (repair.verdict === 'restored' && repair.contentVerified && repaired.status === 'succeeded') {
        // `restored: true` is only ever set on a digest: this is the field a caller
        // reads as "the file is back the way it was", and a byte count cannot carry
        // that claim.
        return {
          ...base,
          ok: false,
          status: wrote.status,
          contentVerified: true,
          verdict: 'restored' as const,
          ...(atBytes === undefined ? {} : { size: atBytes }),
          ...(repair.sha256 === undefined ? {} : { sha256: repair.sha256 }),
          ...(keepBackup ? { backup: backupPath } : {}),
          restored: true,
          message: `The write failed (${reason.slice(0, 300)}), so the previous content was put back at ${path} and the server has digested it as the content this call read${digestNote}.`,
          hint: 'Read the file to see it as it was, then try the edit again.',
        }
      }
      if (repair.verdict === 'restored') {
        // The copy went back and the length is the one this call read, and that is
        // as far as a server without a checksum tool can go.
        return {
          ...base,
          ok: false,
          status: wrote.status,
          contentVerified: false,
          verdict: 'unknown' as const,
          ...(atBytes === undefined ? {} : { size: atBytes }),
          ...(keepBackup ? { backup: backupPath } : {}),
          message: `The write failed (${reason.slice(0, 300)}), so the copy this edit took was written back at ${path}, and it counts out at ${measured} — the length this call read. This server stated no checksum, so the content is not proven to be back.`,
          hint: `Read ${path} to see it for yourself${keepBackup ? `, or recover it from ${backupPath}` : ''}, then try the edit again.`,
        }
      }
      if (verdict === 'unrecoverable') {
        // Either the copy is gone, or the write back failed, or what came back is
        // provably not the content this call read. All three need the same thing
        // from the reader: the file is not what it was, and here is where the copy
        // is (or that there is no copy).
        const where = repair.verdict === 'partial'
          ? 'the copy was written back but is not the content this call read'
          : repair.verdict === 'unrecoverable'
            ? 'there is no copy left to put back, or putting it back failed'
            : `the repair child ended ${String(repaired.exitCode ?? repaired.status)}`
        return {
          ...base,
          ok: false,
          status: wrote.status,
          contentVerified: repair.contentVerified,
          verdict: 'unrecoverable' as const,
          ...(atBytes === undefined ? {} : { size: atBytes }),
          ...(repair.sha256 === undefined ? {} : { sha256: repair.sha256 }),
          backup: backupPath,
          restored: false,
          message: `The write failed (${reason.slice(0, 300)}) and the file could not be put back where it started (${where}). ${path} holds ${measured}${digestNote}; the content this call read was ${String(outcome.bytesBefore)} bytes.`,
          hint: `Read ${backupPath} to recover the previous content by hand, then retry the edit against what is there now.`,
        }
      }
      // Everything else is the bad news, said with the byte count the server just
      // reported rather than a guess about it — and with no verdict, because the
      // repair never answered.
      const where = repaired.status === 'succeeded'
        ? 'the repair child answered without stating a verdict'
        : `the repair child ended ${String(repaired.exitCode ?? repaired.status)}`
      return {
        ...base,
        ok: false,
        status: wrote.status,
        contentVerified: false,
        verdict: 'unknown' as const,
        ...(atBytes === undefined ? {} : { size: atBytes }),
        backup: backupPath,
        restored: false,
        // The repair never answered, so this call does not know whether the file was
        // put back or left half written. Saying so is the whole point: the caller has
        // to treat it as unverified, not as a restore.
        message: `The write failed (${reason.slice(0, 300)}) and this call cannot say what state ${path} is in (${where}). ${path} holds ${measured}; the previous content was ${String(outcome.bytesBefore)} bytes.`,
        hint: `Read ${backupPath} to recover the previous content by hand, then retry the edit.`,
      }
    },

    async writeRemote(params: Params, signal?: AbortSignal): Promise<RemoteFileResult> {
      const { record, settings, notes, auth, path } = await fileCall(params, 'write')
      const content = typeof params.content === 'string' ? params.content : ''
      const append = params.append === true
      const mkdir = params.mkdir !== false
      const overwrite = params.overwrite === true
      const quoted = remotePathArg(path)
      const guard = overwrite || append
        ? ''
        : `if [ -e ${quoted} ]; then echo 'ssh-plugin: refusing to overwrite an existing file' >&2; exit 17; fi; `
      const parent = path.replace(/\\/gu, '/').replace(/\/+[^/]*$/u, '') || '/'
      // `~` on its own is not a directory to make: the login already proved it
      // exists, and a quoted `mkdir -p '~'` would create a file named tilde in
      // whatever the session's working directory happens to be.
      const prepare = mkdir && parent !== '' && parent !== '~' ? `mkdir -p -- ${remotePathArg(parent)} && ` : ''
      const run = await runner.run(targetOf(record), settings, auth, `${guard}${prepare}cat ${append ? '>>' : '>'} ${quoted}`, {
        stdin: content,
        ...(signal === undefined ? {} : { signal }),
      })
      stampCeilings(run, settings, notes)
      return fileResult('write', record, path, run, undefined, undefined, {
        bytes: Buffer.byteLength(content, 'utf8'),
        overwrote: overwrite && !append,
      })
    },

    async resolveRemote(params: Params): Promise<ResolveResult> {
      const state = await store()
      const record = pickTarget(state, params)
      const settings = ceilings(state.settings(), record).settings
      const collected = await runner.resolve(targetOf(record), settings)
      const target = { id: record.id, label: record.label, host: record.host }
      const stored: { host: string; user?: string | undefined; port?: number | undefined } = {
        host: record.host,
        ...(record.user === undefined ? {} : { user: record.user }),
        ...(record.port === undefined ? {} : { port: record.port }),
      }
      if (collected.outcome !== 'exit' || (collected.exitCode ?? 0) !== 0) {
        const reason = collected.error ?? collected.stderr ?? collected.stdout
        return {
          action: 'resolve',
          ok: false,
          target,
          stored,
          resolved: {},
          differs: false,
          durationMs: collected.durationMs,
          ...(reason === undefined || reason.trim() === '' ? {} : { message: reason.trim().slice(0, 512) }),
        }
      }
      const resolved = parseResolved(collected.stdout)
      return {
        action: 'resolve',
        ok: true,
        target,
        stored,
        resolved,
        differs: resolvedDiffers(resolved, stored),
        ...(collected.stdout.trim() === '' ? {} : { text: collected.stdout.trim().split('\n').slice(0, 220).join('\n') }),
        durationMs: collected.durationMs,
      }
    },

    async execBackground(params: Params): Promise<BackgroundRunResult> {
      const state = await store()
      const globalSettings = state.settings()
      // The job registry's bookkeeping travels with the call, but it is not part of
      // what a remote command takes: read it off first so the strict run schema does
      // not reject a well-formed call.
      const { callId, rootCallId, ...runInput } = params
      const toolCall = typeof callId === 'string' && typeof rootCallId === 'string'
        ? { callId, rootCallId }
        : undefined
      let input: ReturnType<typeof remoteRunSchema.parse>
      try {
        input = remoteRunSchema.parse(runInput.command !== undefined ? runInput : { command: runInput })
      } catch (error: unknown) {
        throw new SshError('bad-input', messageOf(error), { field: fieldOf(error) ?? 'command', hint: 'Fix the reported value and try again.' })
      }
      const record = pickTarget(state, params)
      if (record.agentAccess === 'off') {
        throw new SshError('bad-input', `"${record.label}" is set to agent access off, so no remote command may run on it.`, { field: 'target', hint: 'Turn agent access on for this target in the settings page.' })
      }
      // A backgrounded job streams output but has no stdin channel, so the
      // plugin cannot answer a sudo or su prompt for it — say so up front
      // instead of leaving the job waiting on a prompt until its deadline.
      if (input.as !== undefined || input.su === true) {
        throw new SshError('bad-input', 'A backgrounded command has no stdin channel, so the plugin cannot inject an elevation password for it.', {
          field: 'background',
          hint: 'Run it in the foreground with as/su, or write the sudo into the command and rely on a NOPASSWD policy.',
        })
      }
      if (jobs === undefined) {
        throw new SshError('bad-input', 'This profile has no job registry, so a remote command cannot be left running in the background.', {
          field: 'background',
          hint: 'Drop background and the same command runs and waits as usual.',
        })
      }
      const resolved = ceilings(globalSettings, record, { timeoutMs: input.timeoutMs, maxOutputBytes: input.maxOutputBytes })
      const settings = resolved.settings
      const auth = await authFor(record.id, record.auth)
      const owner = typeof input.sessionId === 'string' ? input.sessionId : undefined
      // The job ceiling is asked about *before* the registry is told to start, so a
      // call that will not fit comes back in the frame that made it, with the
      // ceiling in its words. The reservation itself is unchanged — the lane is
      // still taken by the child when it spawns, and a start that loses the race to
      // another call still ends as a failed job with the same sentence.
      // The number quoted here is the number the transport will hold the lane to
      // (`effectiveLaneCap`), not whatever a profile's settings object happens to
      // carry: a refusal that names a ceiling nobody can reach sends the reader off to
      // change a knob that would not have helped.
      const jobCap = effectiveLaneCap({ kind: JOB_LANE, cap: settings.maxRunningJobs })
      if (!runner.laneRoom({ kind: JOB_LANE, cap: jobCap })) {
        return {
          action: 'exec',
          ok: false,
          status: 'refused',
          target: { id: record.id, label: record.label, host: record.host },
          command: input.command,
          message: `At most ${String(jobCap)} ${JOB_LANE} may run at once, and all ${String(jobCap)} slots are taken.`,
          hint: 'Stop one with `job_kill` or wait for one to settle. That ceiling is the part of the operation table a job may hold at all: a job keeps its slot until it ends, and the rest of the slots stay open for the commands a reader is waiting on.',
          connections: await viewsOf(state),
        }
      }
      // A backgrounded command has no deadline of its own: it lives until it
      // settles, until `job_kill`, until its conversation goes away, or until the
      // Host exits — the same bargain the harness's own background shell makes, and
      // a self-imposed 30-minute guillotine would only have meant a longer build died
      // mid-flight. What it does keep holding is one of the plugin's operation slots.
      const deadline = 0 // `deadline(…, 0, …)` arms no timer at all
      const label = `${record.label}: ${input.command}`
      const jobId = startRemoteJob(jobs, {
        label,
        ...(owner === undefined ? {} : { owner }),
        ...(toolCall === undefined ? {} : { toolCall }),
        start: async () => {
          const live = await runner.startRun(targetOf(record), settings, auth, input.command, {
            timeoutMs: deadline,
            // A started job holds its slot until it settles, so it counts against
            // the job ceiling — the reservation that keeps eight foreground slots
            // open no matter how many jobs someone left running.
            job: true,
            ...(input.tty === undefined ? {} : { tty: input.tty }),
          })
          if (live === undefined) {
            return { message: 'No ssh program was found: PATH and the usual install locations were tried.' }
          }
          return {
            // Structural all the way down: the transport's source shape and the
            // registry adapter's are the same fields, so this used to remap field
            // by field into an identical object. One copy of the shape, passed.
            sources: live.sources,
            kill: live.kill,
            finished: live.finished,
          }
        },
      })
      const target = { id: record.id, label: record.label, host: record.host }
      return {
        action: 'exec',
        ok: true,
        status: 'started',
        target,
        command: input.command,
        jobId,
        hint: 'Read it with the `job_output` tool and stop it with `job_kill`; it also dies with this conversation.',
        connections: await viewsOf(state),
      }
    },

    async upload(params: Params, signal?: AbortSignal): Promise<RemoteTransferResult> {
      return await move('upload', params, signal)
    },

    async download(params: Params, signal?: AbortSignal): Promise<RemoteTransferResult> {
      return await move('download', params, signal)
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
        throw new SshError('bad-input', messageOf(error), {
          field: fieldOf(error),
          // The range is no longer the gate, so the hint that used to point at a
          // range would send a reader hunting for a bound that does not exist.
          hint: 'Send a positive whole number, or null to drop this profile\u2019s override and follow the configured default.',
        })
      }
      // `null` clears an override rather than carrying one over, which is the only
      // way a profile can go back to a configured default from the page.
      const merged: StoredSettings = {
        ...(patch.maxOutputBytes === undefined ? { maxOutputBytes: current.maxOutputBytes } : patch.maxOutputBytes === null ? {} : { maxOutputBytes: patch.maxOutputBytes }),
        ...(patch.remoteTimeoutMs === undefined ? { remoteTimeoutMs: current.remoteTimeoutMs } : patch.remoteTimeoutMs === null ? {} : { remoteTimeoutMs: patch.remoteTimeoutMs }),
        ...(patch.maxTransferBytes === undefined ? { maxTransferBytes: current.maxTransferBytes } : patch.maxTransferBytes === null ? {} : { maxTransferBytes: patch.maxTransferBytes }),
      }
      const stored = await state.saveSettings(merged)
      const resolved = ceilings(stored)
      return { settings: stored, effective: resolved.settings, notes: resolved.notes }
    },
  }
}
