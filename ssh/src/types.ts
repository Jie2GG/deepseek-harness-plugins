/**
 * Shared vocabulary between the Host plugin and the browser settings page.
 *
 * The Client half imports this module type-only, so nothing here reaches the
 * browser artifact at runtime; the two halves stay in step on the route path,
 * the method names, and the failure vocabulary.
 *
 * @module @jie2gg/dsh-plugin-ssh/types
 */

/** Absolute path of the plugin's route on the shared `/api` channel. */
export const RPC_ROUTE_PATH = '/api/ssh/rpc'

/** RPC names the page may invoke; every other name is refused before dispatch. */
export const RPC_METHODS = ['list', 'save', 'remove', 'probe', 'probeAll', 'run', 'resolve', 'upload', 'download', 'setSessionTarget', 'clearSessionTarget', 'configUpdate'] as const

/** One RPC name as it travels on the wire. */
export type RpcMethod = (typeof RPC_METHODS)[number]

/** Closed failure vocabulary for the route. A probe never fails for an
 * authentication, network, or timeout reason — those are {@link ProbeStatus}
 * outcomes — so these codes stay reserved for request, storage and secret faults.
 */
export type SshErrorCode = 'bad-input' | 'not-found' | 'busy' | 'storage-error' | 'secret-error' | 'internal'

/** How one target authenticates. */
export type AuthMode = 'password' | 'key' | 'key+password'

/** The modes the page may choose and a write may set, in display order. */
export const AUTH_MODES: readonly AuthMode[] = ['key', 'password']

/**
 * Every mode this plugin still reads. `key+password` was an offered choice in
 * 0.4.0 only: a stored row that carries it keeps its previous probe behaviour,
 * but nothing new can select it.
 */
export const STORED_AUTH_MODES: readonly AuthMode[] = ['key', 'key+password', 'password']

/** Which secret slots a target has, reported without any value. */
export interface SecretStatus {
  /** Whether a login password is stored. */
  password: boolean
  /** Whether a private-key passphrase is stored. */
  passphrase: boolean
  /** Whether the root account's own password is stored, for `su` elevation. */
  root: boolean
}

/** One secret write: a string stores, `null` forgets, absence leaves as-is. */
export type SecretPatch = { password?: string | null | undefined; passphrase?: string | null | undefined; root?: string | null | undefined }

/** A stored target as the page reads it: the record plus its secret presence. */
export interface ConnectionView extends ConnectionRecord {
  /** Presence of each secret slot, never a value. */
  secrets: SecretStatus
}

/** One failure as the browser reads it. */
export interface SshFailure {
  /** Machine-readable code from {@link SshErrorCode}. */
  readonly code: SshErrorCode
  /** Human-readable reason; the page shows it verbatim. */
  readonly message: string
  /** Form field a `bad-input` failure belongs to, when one is known. */
  readonly field?: string | undefined
  /** What the user can do next, when the reason alone is not actionable. */
  readonly hint?: string | undefined
}

/** One route answer: a result, or a classified failure. */
export type RpcResult<T> = { ok: true; result: T } | { ok: false; error: SshFailure }

/** Outcome of one connectivity probe. */
export type ProbeStatus =
  | 'reachable'
  | 'auth-failed'
  | 'unreachable'
  | 'unknown-host'
  | 'timeout'
  | 'ssh-missing'
  | 'failed'

/** One probe result, kept on the stored record so the list survives a restart. */
export interface ProbeOutcome {
  /** When the probe settled, as a canonical UTC instant. */
  readonly at: string
  /** Classified result. */
  readonly status: ProbeStatus
  /** Truncated stderr/stdout tail explaining the result. */
  readonly detail?: string | undefined
  /** Child exit code; `null` when a signal ended it. */
  readonly exitCode?: number | null | undefined
  /** Wall-clock duration of one probe in whole milliseconds. */
  readonly durationMs?: number | undefined
}

/** One SSH target as the page edits it. */
export interface ConnectionInput {
  /** Existing record identity; omitted asks the Host to assign one. */
  id?: string | undefined
  /** Display name shown in the list. */
  label: string
  /** Host name or an existing OpenSSH host alias. */
  host: string
  /** Remote user; omission lets the OpenSSH client decide from its own configuration. */
  user?: string | undefined
  /** Remote port; omission keeps the client default of 22. */
  port?: number | undefined
  /** Private key path passed to `-i`. */
  identityFile?: string | undefined
  /** Jump host passed to `-J`. */
  proxyJump?: string | undefined
  /** Additional client flags; every entry must start with `-`. */
  extraArgs?: readonly string[] | undefined
  /** Free-form remark for the reader of the list. */
  note?: string | undefined
  /** How to authenticate; omission keeps the agent-or-unencrypted-key probe. */
  auth?: AuthMode | undefined
  /** Whether the agent may reach this target at all. */
  agentAccess?: 'on' | 'off' | undefined
  /** Whether later calls to this target ride on the first call's connection. */
  pool?: 'on' | 'off' | undefined
  /** Program names runnable without an approval; empty asks for every command. */
  allowedCommands?: readonly string[] | undefined
  /** Per-target command deadline; `null` clears the override. */
  remoteTimeoutMs?: number | null | undefined
  /** Per-target output ceiling; `null` clears the override. */
  maxOutputBytes?: number | null | undefined
}

/** What one target's OpenSSH client configuration resolves to. */
export interface ResolvedConfig {
  /** The host the client will dial after aliases and canonicalisation. */
  hostname?: string | undefined
  /** The port it will dial. */
  port?: number | undefined
  /** The user it will send. */
  user?: string | undefined
  /** Identity files the configuration names, in the order the client would try them. */
  identityFiles?: string[] | undefined
  /** Jump host, if one is configured. */
  proxyJump?: string | undefined
  /** ProxyCommand, if one is configured. */
  proxyCommand?: string | undefined
}

/** One SSH target as the plugin's storage domain keeps it. */
export interface ConnectionRecord extends ConnectionInput {
  /** Host-assigned identity. */
  id: string
  label: string
  host: string
  /** Creation instant, never rewritten by an edit. */
  readonly createdAt: string
  /** Last identity change. */
  readonly updatedAt: string
  /** Most recent probe, kept so the list shows an honest “as of”. */
  readonly lastProbe?: ProbeOutcome | undefined
  /** How this target authenticates; `key` also covers a bare ssh-agent probe. */
  readonly auth: AuthMode
  /** Whether the agent may reach this target at all. */
  readonly agentAccess: 'on' | 'off'
  /** Whether later calls ride on this target's first connection. */
  readonly pool: 'on' | 'off'
  /** Program names runnable without an approval. */
  readonly allowedCommands: readonly string[]
  /** Per-target command deadline; absence follows the shared setting. */
  readonly remoteTimeoutMs?: number | undefined
  /** Per-target output ceiling; absence follows the shared setting. */
  readonly maxOutputBytes?: number | undefined
}

/** One remote command result, kept on the record and returned to the model. */
export interface RemoteRunResult {
  /** Classified outcome of the whole call. */
  status: RemoteStatus
  /**
   * The deadline this call actually ran under: the config default, this profile's
   * stored override, the target's own override, and the call's request resolved in
   * that order and held to the configured cap. Echoed because a cap that moved a
   * number a caller asked for is information, not a detail.
   */
  timeoutMs?: number
  /** The per-stream capture ceiling that actually applied, for the same reason. */
  outputBytes?: number
  /**
   * One objective sentence per correction a resolution made — a value capped, a
   * config cap raised to its default. Advice belongs on the card; this is the
   * receipt.
   */
  notes?: readonly string[]
  /** When it finished, as a canonical UTC instant. */
  at: string
  /** Child exit code; `null` when a signal ended it. */
  exitCode?: number | null | undefined
  /** Captured stdout, already trimmed to the ceiling. */
  stdout?: string | undefined
  /** Captured stderr, already trimmed to the ceiling. */
  stderr?: string | undefined
  /** Whether either stream lost bytes to the ceiling. */
  truncated?: boolean | undefined
  /**
   * Where the complete stdout went when the ceiling clipped it. The provider writes
   * the whole stream to a file when a call asks for that (`maxSpillBytes`), so a
   * truncated answer is a tail with a pointer, not a tail with a loss.
   */
  stdoutSpillPath?: string | undefined
  /** The same for stderr. */
  stderrSpillPath?: string | undefined
  /** Wall-clock duration in whole milliseconds. */
  durationMs?: number | undefined
  /** Whether the call ran under a requested pseudo-terminal (`-tt`). */
  tty?: boolean | undefined
  /** Bytes handed to the command's stdin, when stdin was used. */
  stdinBytes?: number | undefined
  /** The account an elevated call ran as: the `as` name, or `su:root`. */
  elevated?: string | undefined
  /** The job a call that ran out of time was handed to; present with `status: 'promoted'`. */
  jobId?: string | undefined
  /** Plain-language reason, set by the layers that know more than an exit code — a handover, or a handover that was refused. */
  message?: string | undefined
  /** The next step a reader can take, when the status alone would not say it. */
  hint?: string | undefined
}

/**
 * Plugin-wide settings as they sit in the domain's global slot: this profile's
 * **overrides** only. A key that is absent falls through to the plugin's configured
 * default, which is where the default and the cap now live (`config.ts`), so the
 * stored file is no longer the whole answer about a ceiling.
 */
export interface StoredSettings {
  /** Per-stream capture ceiling in bytes, when this profile overrides it. */
  readonly maxOutputBytes?: number | undefined
  /** Foreground command deadline in milliseconds, when this profile overrides it. */
  readonly remoteTimeoutMs?: number | undefined
  /** File-transfer ceiling in bytes, when this profile overrides it. */
  readonly maxTransferBytes?: number | undefined
}

/**
 * The three ceilings as one call runs under them: every number present, because
 * `bounds.ts` has already resolved default, stored override, per-target override,
 * and per-call request into it and held the result to the configured cap.
 */
export interface SshSettings {
  /** Per-stream capture ceiling for a probe or a remote command, in bytes. */
  maxOutputBytes: number
  /** Deadline for one agent-issued remote command, in whole milliseconds. */
  remoteTimeoutMs: number
  /** Largest file or tree one transfer may move, in bytes. */
  maxTransferBytes: number
  /**
   * Whole-budget deadline for one file transfer, in milliseconds — its own clock,
   * not the command deadline, so a permitted copy is not killed at 30 s.
   */
  transferTimeoutMs: number
  /** Pre-check cap on how many files one recursive upload may carry. */
  maxTransferFiles: number
  /** Pre-check cap on the cumulative bytes one recursive upload may carry. */
  maxTransferTotalBytes: number
  /** How many file transfers may hold an operation slot at once. */
  maxConcurrentTransfers: number
  /** How many background jobs may hold an operation slot at once. */
  maxRunningJobs: number
  /** Deadline one connectivity probe waits to, in whole milliseconds. */
  probeTimeoutMs: number
  /** Deadline for the size-and-type pre-check one download asks first. */
  statTimeoutMs: number
  /** Cap on the full-stream spill file a capped capture leaves behind; 0 disables spilling. */
  maxSpillBytes: number
  /** Grace a child gets between SIGTERM and SIGKILL before it is given up on. */
  graceMs: number
}

/** One conversation's chosen target, kept in the plugin's own storage. */
export interface SessionTarget {
  /** The DSH Session this choice belongs to. */
  sessionId: string
  /** The chosen target id. */
  targetId: string
  /** When it was chosen, as a canonical UTC instant. */
  setAt: string
}

/** Outcome of one remote command, classified the same way a probe is. */
export type RemoteStatus =
  | 'succeeded'
  /**
   * The call ran out of its deadline and the command was **handed to the job
   * registry** rather than killed: the remote process is still running, and
   * `jobId` says where to read it. The harness's own shell tool answers a timeout
   * this way, and a plugin that kills a long build just because a reply window
   * closed was asking the reader to start it again.
   */
  | 'promoted'
  | 'exit-nonzero'
  | 'auth-failed'
  | 'unreachable'
  | 'unknown-host'
  | 'timeout'
  | 'cancelled'
  | 'ssh-missing'
  | 'failed'

/** How a call reached its target. */
export type TargetSource = 'argument' | 'session' | 'only-target'

/** One completed or refused file transfer. */
export interface RemoteTransferResult {
  /** `upload` or `download`. */
  action: 'upload' | 'download'
  /** Whether bytes moved. */
  ok: boolean
  /** The transfer outcome. */
  status: 'moved' | 'refused-size' | 'refused-exists' | 'missing' | 'failed'
  /** The target the bytes moved with. */
  target: { id: string; label: string; host: string }
  /** Absolute path on this machine, inside the conversation's workspace. */
  localPath: string
  /** Absolute path on the server. */
  remotePath: string
  /** Bytes moved, when the transfer reported them. */
  bytes?: number
  /** Files counted by the walk, for a recursive upload. */
  files?: number
  /** The ceiling this copy ran under, after capping; stated because it is the answer to “why did that one refuse”. */
  bytesLimit?: number
  /** The deadline this copy ran under, after capping. */
  timeoutMs?: number
  /** Objective sentences naming what a resolution corrected. */
  notes?: readonly string[]
  /** Whether a directory was copied. */
  recursive?: boolean
  /** Whether an existing destination was replaced. */
  overwrote?: boolean
  /** Seconds spent. */
  durationMs?: number
  /** Plain-language reason for a refusal or failure. */
  message?: string
  /** The next step for a reader. */
  hint?: string
}

/** The page's settings write, with every field optional. */
export interface SettingsInput {
  maxOutputBytes?: number | undefined
  remoteTimeoutMs?: number | undefined
  maxTransferBytes?: number | undefined
}

/** A failure carrying one {@link SshErrorCode} for the route layer to map. */
export class SshError extends Error {
  /** Code the page discriminates on. */
  readonly code: SshErrorCode
  /** Form field this failure belongs to, when one is known. */
  readonly field: string | undefined
  /** Actionable next step for the reader. */
  readonly hint: string | undefined

  /**
   * @param code - one {@link SshErrorCode}.
   * @param message - the reason shown to the user.
   * @param options - the failing field and any hint, plus an optional cause.
   */
  constructor(
    code: SshErrorCode,
    message: string,
    options: { readonly field?: string | undefined; readonly hint?: string | undefined; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = code
    this.field = options.field
    this.hint = options.hint
  }
}
