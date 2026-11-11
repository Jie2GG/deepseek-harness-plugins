/** Shared vocabulary between the GitHub plugin's Host operations, its HTTP face, and its settings page. @module dsh-plugin-github/types */

/** Stable reasons a GitHub plugin operation refuses, each with a fixed user-facing next step. */
export type GhErrorCode =
  | 'gh-missing'
  | 'gh-failed'
  | 'timeout'
  | 'network'
  | 'checksum'
  | 'extract'
  | 'permission'
  | 'unsupported-platform'
  | 'busy'
  | 'bad-input'
  | 'config-rejected'
  | 'internal'

/** A refusal the page renders inline: why it failed and what the user can do next. */
export interface GhFailure {
  code: GhErrorCode
  message: string
  hint?: string
}

/** Thrown by Host operations; the HTTP face converts it into a {@link GhFailure}. */
export class GhError extends Error {
  constructor(
    readonly code: GhErrorCode,
    message: string,
    readonly hint?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'GhError'
  }
}

/** One authenticated account on one GitHub host, as `gh auth status --json` reports it. */
export interface AuthAccountView {
  login: string
  active: boolean
  state: string
  scopes: string
  tokenSource: string
  gitProtocol: string
}

/** One host and every account `gh` knows about it, in `gh`'s own order. */
export interface AuthHostView {
  host: string
  accounts: AuthAccountView[]
}

/** Account-management payload: parsed `gh auth status` plus a text fallback. */
export interface AuthStatusView {
  loggedIn: boolean
  hosts: AuthHostView[]
  /** Present when `gh` answered something this plugin cannot parse; the raw text follows. */
  note?: string
  raw?: string
}

/** Facts about the `gh` executable this plugin resolves and the copy it manages itself. */
export interface InstallationView {
  installed: boolean
  /** The executable the plugin resolves for every `gh` call. */
  path?: string
  version?: string
  /** How the plugin came to resolve this file, for display only. */
  source: 'config' | 'path' | 'none'
  /** The plugin-managed copy, when one exists on disk. */
  managed?: ManagedCopyView
  /** Release metadata from the last successful check. */
  latest?: ReleaseView
  /** Last check outcome; a failed check keeps its reason here instead of clearing the cache. */
  checkError?: GhFailure
  checkedAt?: number
}

/** The plugin-owned `gh` binary in its managed directory. */
export interface ManagedCopyView {
  path: string
  dir: string
  version?: string
  installedAt?: number
  /** True when PATH resolution still prefers another `gh`, so installing changes nothing until the path is selected. */
  shadowed: boolean
}

/** One GitHub CLI release, from `cli/cli` on api.github.com. */
export interface ReleaseView {
  version: string
  tag: string
  name: string
  url: string
  publishedAt: string
  /** Size of the archive for this platform, when the release carries one. */
  assetBytes?: number
  platformSupported: boolean
}

/** State of one long-running plugin job (device-code sign-in, binary install). */
export interface JobView {
  id: string
  state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  label: string
  log: string[]
  startedAt: number
  endedAt?: number
  /** Device-flow sign-in publishes the one-time code and its URL as soon as `gh` prints them. */
  code?: string
  url?: string
  result?: unknown
  error?: GhFailure
}

/** Configuration echoed to the page, with the effective values the plugin is running with. */
export interface ConfigView {
  command: string
  timeoutMs: number
  maxOutputBytes: number
  /** True when the row itself set `command` rather than falling back to `gh` on `PATH`. */
  commandExplicit: boolean
}

/** This Host's platform as the installer sees it, so the page can explain an unsupported route. */
export interface PlatformView {
  goos: string
  goArch: string
  packaging: string
  supported: boolean
  hint?: string
}

/** Full payload of the page's first read: installation, accounts summary, and what the plugin can do here. */
export interface StatusView extends InstallationView {
  config: ConfigView
  platform: PlatformView
  /** Directory and file the plugin manages its own copy in, shown before any install happens. */
  managedDir: string
  managedPath: string
  /** `gh extension list` rows; empty when nothing is installed or `gh` refuses. */
  extensions: string[]
  /** Count of plugin jobs still running, which the page uses to disable conflicting buttons. */
  runningJobs: number
  /** Whether the active `gh` is already the newest release this plugin knows about. */
  upToDate?: boolean
  /** Host clock, so the page renders relative times from the same instant the data was taken. */
  serverTime: number
}

/** Successful HTTP result. */
export interface RpcSuccess<T> {
  ok: true
  result: T
}

/** Refused HTTP result. */
export interface RpcFailure {
  ok: false
  error: GhFailure
}

/** One HTTP answer on the plugin's RPC face. */
export type RpcResult<T> = RpcSuccess<T> | RpcFailure

/** Parameters every method may receive; the dispatcher validates what it needs. */
export type RpcParams = Record<string, unknown>

/** Route registered on the shared `/api` channel; the page fetches the same literal. */
export const RPC_ROUTE_PATH = '/api/github/rpc'

/** Every method name the RPC face accepts, so the Client and Host cannot drift apart. */
export const RPC_METHODS = [
  'status',
  'authStatus',
  'authToken',
  'authLoginToken',
  'authLoginWeb',
  'authLogout',
  'authSwitch',
  'releaseCheck',
  'installStart',
  'removeManaged',
  'configUpdate',
  'jobPoll',
  'jobCancel',
] as const

/** One RPC method name. */
export type RpcMethod = (typeof RPC_METHODS)[number]
