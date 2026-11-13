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
export const RPC_METHODS = ['list', 'save', 'remove', 'probe', 'probeAll', 'configUpdate'] as const

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
}

/** One secret write: a string stores, `null` forgets, absence leaves as-is. */
export type SecretPatch = { password?: string | null | undefined; passphrase?: string | null | undefined }

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
}

/** Plugin-wide settings, held in the domain's global slot. */
export interface SshSettings {
  /** `ssh` executable: a bare name resolved on `PATH`, or an absolute path. */
  command: string
  /** Deadline for one probe, in whole milliseconds. */
  probeTimeoutMs: number
  /** Per-stream capture ceiling for one probe, in bytes. */
  maxOutputBytes: number
}

/** The page's settings write, with every field optional. */
export interface SettingsInput {
  command?: string | undefined
  probeTimeoutMs?: number | undefined
  maxOutputBytes?: number | undefined
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
