/** Every `gh` invocation this plugin makes, through the Host subprocess service. @module dsh-plugin-github/gh */

import type { Context } from '@deepseek-ai/cordis'
import { SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { ResolvedConfig } from './config.ts'
import { LOGIN_JOB_TIMEOUT_MS } from './config.ts'
import { GhError } from './types.ts'
import type { AuthAccountView, AuthHostView, AuthStatusView } from './types.ts'

/** Environment every child gets on top of the scrubbed parent base. */
const CHILD_ENV: Readonly<Record<string, string>> = {
  // An unexpected prompt must fail loudly instead of hanging a settings request.
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
}

/** Collection ceiling for a long-running flow (sign-in, extraction) whose text stays short. */
const LONG_RUN_OUTPUT_BYTES = 8 * 1024

/** Grace given to the provider's termination ladder after an aborted child. */
const TERMINATE_GRACE_MS = 5_000

/** Bounded best-effort wait for a settled child and any survivor it can still observe. */
const QUIESCENCE_WAIT_MS = 2_000

/** One finished process: exit facts plus the captured text of both streams. */
export interface GhRunResult {
  ok: boolean
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
}

/** Per-call options for one process. */
export interface GhRunOptions {
  /** Written to stdin and then closed, which is how `gh auth login --with-token` receives a secret. */
  stdinData?: string
  /** Keep stdin open as a pipe so a later flow can answer a prompt, which device-code sign-in needs. */
  stdinPipe?: boolean
  timeoutMs?: number
  /** Bytes collected per stream; omission uses the configured batch ceiling. */
  maxOutputBytes?: number
  env?: Record<string, string | undefined>
  cwd?: string
}

/**
 * One started process and the ways to finish observing it.
 * A long flow keeps this object so it can write stdin, poll collected output,
 * and settle the deadline exactly once.
 */
export interface GhProcess {
  /** The live child handle, including its stdin when the call asked for a pipe. */
  handle: SubprocessHandle
  /** Absolute executable the process was launched from. */
  executable: string
  /** Stream label used in every refusal this process reports. */
  label: string
  /** Await the child's exit and read both collected streams. Always clears the deadline. */
  finish(): Promise<GhRunResult>
  /** Abort the deadline and terminate the child; safe after settlement and safe twice. */
  cancel(): void
}

/**
 * Read the version out of `gh --version`, or `undefined` for unrecognizable text.
 * @param stdout - raw standard output of `gh --version`.
 * @returns the version triple, for example `2.103.3`.
 */
export function parseGhVersion(stdout: string): string | undefined {
  return /gh version\s+(\d+\.\d+\.\d+[^\s]*)/u.exec(stdout)?.[1]
}

/**
 * Take the first non-empty line of captured output, for a compact failure hint.
 * @param text - captured stream text.
 * @returns the trimmed first line, or `undefined` when there is none.
 */
export function firstLine(text: string): string | undefined {
  const line = text.split('\n').map(value => value.trim()).find(value => value !== '')
  return line === undefined ? undefined : line.slice(0, 300)
}

/** Narrow one `gh auth status --json hosts` element into the account record the page renders. */
function accountOf(value: unknown): AuthAccountView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.login !== 'string' || record.login === '') return undefined
  return {
    login: record.login,
    active: record.active === true,
    state: typeof record.state === 'string' ? record.state : 'unknown',
    scopes: typeof record.scopes === 'string' ? record.scopes : '',
    tokenSource: typeof record.tokenSource === 'string' ? record.tokenSource : 'unknown',
    gitProtocol: typeof record.gitProtocol === 'string' ? record.gitProtocol : '',
  }
}

/** Runs and reads `gh` for one plugin activation, with every deadline and limit explicit. */
export class GhClient {
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  /** Working directory for children: no call this plugin makes resolves a repository. */
  private get cwd(): string {
    return process.cwd()
  }

  /**
   * Resolve the configured `gh` name or path.
   * @returns the absolute executable path, or `undefined` when nothing resolves.
   * @throws {GhError} `bad-input` when the configured name cannot be resolved as a program.
   */
  async executable(): Promise<string | undefined> {
    try {
      return await this.ctx.subprocess.resolveExecutable(this.config.command)
    } catch (error) {
      if (error instanceof SubprocessExecutableNotFoundError) return undefined
      throw new GhError(
        'bad-input',
        `Cannot resolve "${this.config.command}": ${(error as Error).message}`,
        'Set an absolute path to the gh executable, or clear the field to use PATH.',
        { cause: error },
      )
    }
  }

  /**
   * Resolve a helper program this plugin may need, such as `tar`.
   * @param name - program name.
   * @returns absolute path, or `undefined` when the platform lacks it.
   */
  async helper(name: string): Promise<string | undefined> {
    try {
      return await this.ctx.subprocess.resolveExecutable(name)
    } catch (error) {
      if (error instanceof SubprocessExecutableNotFoundError) return undefined
      throw error
    }
  }

  /**
   * Start one `gh` process and own its deadline without waiting for it.
   * @param args - `gh` arguments, never shell-interpreted.
   * @param options - stdin payload, deadline, collection limit, and environment.
   * @returns a {@link GhProcess} the caller must finish or cancel.
   * @throws {GhError} `gh-missing` when nothing resolves, or `gh-failed` when the child never started.
   */
  async gh(args: readonly string[], options: GhRunOptions = {}): Promise<GhProcess> {
    const executable = await this.executable()
    if (executable === undefined) {
      throw new GhError(
        'gh-missing',
        `No gh found for "${this.config.command}".`,
        'Install gh, or point the Installation card at an existing executable.',
      )
    }
    return this.spawn([executable, ...args], `gh ${args.join(' ')}`, options)
  }

  /**
   * Start one `gh` call to completion.
   * @param args - `gh` arguments, never shell-interpreted.
   * @param options - stdin payload, deadline, collection limit, and environment.
   * @returns exit facts and captured text; a non-zero exit is a result, not a refusal.
   * @throws {GhError} `gh-missing`, `timeout`, or `gh-failed`.
   */
  async run(args: readonly string[], options: GhRunOptions = {}): Promise<GhRunResult> {
    return await (await this.gh(args, options)).finish()
  }

  /**
   * Run one program this plugin owns to completion, such as `tar`.
   * @param argv - program and arguments, never shell-interpreted.
   * @param options - deadline, working directory, and collection limit.
   * @returns exit facts and captured text.
   * @throws {GhError} `extract`, `timeout`, or `gh-failed`.
   */
  async exec(argv: readonly string[], options: GhRunOptions = {}): Promise<GhRunResult> {
    return await this.finishSpawn(argv, argv[0] ?? 'program', options)
  }

  /**
   * Start the browser device-code flow, whose stdin stays open so the job can answer the Enter prompt.
   * @param options - host, git protocol, and extra scopes.
   * @returns a {@link GhProcess} for the running flow.
   */
  async startWebLogin(options: { host: string; gitProtocol: string; scopes?: string[] }): Promise<GhProcess> {
    const args = ['auth', 'login', '--web', '--hostname', options.host, '--git-protocol', options.gitProtocol, '--skip-ssh-key']
    if (options.scopes !== undefined && options.scopes.length > 0) args.push('--scopes', options.scopes.join(','))
    return await this.gh(args, { timeoutMs: LOGIN_JOB_TIMEOUT_MS, maxOutputBytes: LONG_RUN_OUTPUT_BYTES, stdinPipe: true })
  }

  /**
   * Report which `gh` this plugin resolves and which version it is.
   * @returns installation facts; `installed: false` when nothing resolves.
   */
  async installation(): Promise<{ installed: boolean; path?: string; version?: string }> {
    const executable = await this.executable()
    if (executable === undefined) return { installed: false }
    const result = await this.run(['--version'], { timeoutMs: Math.min(this.config.timeoutMs, 10_000) })
    const version = parseGhVersion(result.stdout)
    return { installed: true, path: executable, ...version === undefined ? {} : { version } }
  }

  /**
   * Read the signed-in accounts of every host through `gh auth status --json hosts`.
   * @returns parsed accounts, with `gh`'s own text kept when the shape is unfamiliar.
   */
  async authStatus(): Promise<AuthStatusView> {
    const result = await this.run(['auth', 'status', '--json', 'hosts', '--no-refresh'])
    const trimmed = result.stdout.trim()
    if (trimmed === '') {
      const note = result.stderr.trim()
      return { loggedIn: false, hosts: [], ...(note === '' ? {} : { note: 'gh returned no account data', raw: note.slice(0, 500) }) }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return { loggedIn: false, hosts: [], note: 'Unrecognized gh auth status output', raw: trimmed.slice(0, 500) }
    }
    const hostsRecord = (parsed as { hosts?: unknown }).hosts
    const hosts: AuthHostView[] = []
    if (typeof hostsRecord === 'object' && hostsRecord !== null) {
      for (const [host, rows] of Object.entries(hostsRecord as Record<string, unknown>)) {
        const accounts = Array.isArray(rows)
          ? rows.map(accountOf).filter((row): row is AuthAccountView => row !== undefined)
          : []
        hosts.push({ host, accounts })
      }
    }
    return { loggedIn: hosts.some(host => host.accounts.some(account => account.active)), hosts }
  }

  /**
   * Read the active account's token. It stays on the Host unless the page asks for it explicitly.
   * @param host - GitHub host whose active account is asked for.
   * @param user - account to read when the host has several.
   * @returns the token text.
   * @throws {GhError} `gh-failed` when `gh` has no such credential.
   */
  async token(host?: string, user?: string): Promise<string> {
    const args = ['auth', 'token', '--no-refresh']
    if (host !== undefined) args.push('--hostname', host)
    if (user !== undefined) args.push('--user', user)
    const result = await this.run(args)
    const token = result.stdout.trim()
    if (!result.ok || token === '') {
      throw new GhError('gh-failed', 'gh has no token to return for that host and account.', firstLine(result.stderr))
    }
    return token
  }

  /**
   * Sign in with a token fed through stdin, the only non-interactive `gh auth login` shape.
   * @param token - personal access token, never logged.
   * @param options - host, git protocol, and extra scopes.
   * @returns `gh`'s confirmation text.
   * @throws {GhError} `gh-failed` with `gh`'s own first error line.
   */
  async loginWithToken(token: string, options: { host: string; gitProtocol: string; scopes?: string[] }): Promise<string> {
    const args = ['auth', 'login', '--with-token', '--hostname', options.host, '--git-protocol', options.gitProtocol]
    if (options.scopes !== undefined && options.scopes.length > 0) args.push('--scopes', options.scopes.join(','))
    const result = await this.run(args, { stdinData: `${token}\n`, timeoutMs: Math.max(this.config.timeoutMs, 60_000) })
    if (!result.ok) {
      throw new GhError('gh-failed', `gh auth login failed (exit ${String(result.exitCode)}).`, firstLine(result.stderr) ?? firstLine(result.stdout))
    }
    return firstLine(result.stdout) ?? 'Authenticated.'
  }

  /**
   * Drop one account's credentials.
   * @param host - GitHub host to log out of.
   * @param user - account to log out when the host holds several.
   * @returns `gh`'s confirmation text.
   */
  async logout(host: string, user?: string): Promise<string> {
    const args = ['auth', 'logout', '--hostname', host]
    if (user !== undefined) args.push('--user', user)
    const result = await this.run(args)
    if (!result.ok) throw new GhError('gh-failed', `gh auth logout failed (exit ${String(result.exitCode)}).`, firstLine(result.stderr))
    return firstLine(result.stdout) ?? 'Logged out.'
  }

  /**
   * Make one account the active credentials of its host.
   * @param host - GitHub host to change.
   * @param user - account to activate.
   * @returns `gh`'s confirmation text.
   */
  async switchAccount(host: string, user: string): Promise<string> {
    const result = await this.run(['auth', 'switch', '--hostname', host, '--user', user])
    if (!result.ok) throw new GhError('gh-failed', `gh auth switch failed (exit ${String(result.exitCode)}).`, firstLine(result.stderr))
    return firstLine(result.stdout) ?? 'Active account changed.'
  }

  /**
   * List installed `gh` extensions, part of what a machine's GitHub CLI carries.
   * @returns one entry per extension; empty when none are installed or `gh` refuses.
   */
  async extensions(): Promise<string[]> {
    const result = await this.run(['extension', 'list'])
    if (!result.ok) return []
    return result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  }

  /**
   * Start one fully-specified child and own its deadline, without waiting for it.
   * @param argv - program and arguments.
   * @param label - human name used in every refusal about this child.
   * @param options - stdio, deadline, collection limit, environment, and directory.
   * @returns a {@link GhProcess} the caller must finish or cancel.
   */
  private spawn(argv: readonly string[], label: string, options: GhRunOptions): GhProcess {
    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs
    const maxBytes = options.maxOutputBytes ?? this.config.maxOutputBytes
    const controller = new AbortController()
    let timedOut = false
    let cleared = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const clearTimer = (): void => {
      if (cleared) return
      cleared = true
      clearTimeout(timer)
    }
    let handle: SubprocessHandle
    try {
      handle = this.ctx.subprocess.spawn({
        argv: [...argv],
        cwd: options.cwd ?? this.cwd,
        stdio: {
          stdin: options.stdinData !== undefined ? { data: options.stdinData } : options.stdinPipe === true ? 'pipe' : 'ignore',
          stdout: { maxBytes },
          stderr: { maxBytes },
        },
        graceMs: TERMINATE_GRACE_MS,
        signal: controller.signal,
        env: { ...CHILD_ENV, ...options.env },
      })
    } catch (error) {
      clearTimer()
      throw new GhError('gh-failed', `Could not start ${label}: ${(error as Error).message}`, undefined, { cause: error })
    }
    const read = (reader: { readFrom(fromByte: number): { text: string; lossy: boolean } } | undefined): { text: string; truncated: boolean } =>
      reader === undefined ? { text: '', truncated: false } : { text: reader.readFrom(0).text, truncated: reader.readFrom(0).lossy }
    const quiet = async (): Promise<void> => {
      await Promise.resolve(handle.waitForExit(AbortSignal.timeout(QUIESCENCE_WAIT_MS))).catch(() => undefined)
    }
    return {
      handle,
      executable: argv[0] ?? '',
      label,
      async finish(): Promise<GhRunResult> {
        try {
          const outcome = await handle.done
          const stdout = read(handle.collected.stdout)
          const stderr = read(handle.collected.stderr)
          await quiet()
          return {
            ok: outcome.exitCode === 0,
            exitCode: outcome.exitCode,
            signal: outcome.signal,
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated,
            durationMs: Date.now() - startedAt,
          }
        } catch (error) {
          const stdout = read(handle.collected.stdout)
          const stderr = read(handle.collected.stderr)
          handle.terminate()
          await quiet()
          if (timedOut) {
            throw new GhError('timeout', `${label} did not finish in ${timeoutMs} ms.`, 'Retry, raise the timeout, or check the network.', { cause: error })
          }
          throw new GhError('gh-failed', `${label} failed: ${(error as Error).message}`, firstLine(stderr.text), { cause: error })
        } finally {
          clearTimer()
        }
      },
      cancel(): void {
        clearTimer()
        handle.terminate()
      },
    }
  }

  /**
   * Start a non-`gh` program and run it to completion.
   * @param argv - program and arguments.
   * @param label - human name used in refusals.
   * @param options - deadline, directory, and collection limit.
   * @returns exit facts and captured text.
   */
  private async finishSpawn(argv: readonly string[], label: string, options: GhRunOptions): Promise<GhRunResult> {
    return await this.spawn(argv, label, options).finish()
  }
}
