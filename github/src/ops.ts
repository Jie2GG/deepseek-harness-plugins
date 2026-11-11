/** The GitHub plugin's operations, called by the settings page and by any later agent tool. @module dsh-plugin-github/ops */

import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { GhProcess, GhRunResult } from './gh.ts'
import { firstLine } from './gh.ts'
import type { GithubInstaller } from './installer.ts'
import { managedPaths, platformTarget } from './installer.ts'
import type { GhClient } from './gh.ts'
import type { JobTable } from './jobs.ts'
import type { AuthStatusView, ConfigView, ReleaseView, StatusView, JobView } from './types.ts'
import { GhError } from './types.ts'
import type { ResolvedConfig } from './config.ts'
import { LOGIN_JOB_TIMEOUT_MS } from './config.ts'

/** How long a computed status stays cached, which keeps job polling off the `gh` binary. */
const STATUS_TTL_MS = 5_000

/** Host a device-code flow is polled against, defaulting to the public deployment. */
export const DEFAULT_HOST = 'github.com'

/** Accepted GitHub hostnames: a DNS name with an optional port, which covers GitHub Enterprise too. */
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/u

/** Accepted `gh` executable values: an absolute path or a bare program name, never a shell line. */
const COMMAND_PATTERN = /^(?:\/[A-Za-z0-9._/-]+|[A-Za-z0-9][A-Za-z0-9._-]*)$/u

/** Git protocols `gh auth login` accepts. */
const GIT_PROTOCOLS = ['https', 'ssh'] as const

/** Everything the operations need, wired once per activation. */
export interface OpsDeps {
  gh: GhClient
  installer: GithubInstaller
  jobs: JobTable
  config: ResolvedConfig
  /** Persist this plugin's own `command` value, or clear it; a write restarts the plugin. */
  writeCommand: (command: string | null) => Promise<void>
}

/** Page-facing operations, one per RPC method name. */
export interface GithubOps {
  status(): Promise<StatusView>
  authStatus(): Promise<AuthStatusView>
  authToken(host?: string, user?: string): Promise<{ token: string; host: string }>
  authLoginToken(token: string, host: string, gitProtocol: string, scopes?: string[]): Promise<{ message: string }>
  authLoginWeb(host: string, gitProtocol: string, scopes?: string[]): Promise<{ jobId: string }>
  authLogout(host: string, user?: string): Promise<{ message: string }>
  authSwitch(host: string, user: string): Promise<{ message: string }>
  releaseCheck(): Promise<{ latest: ReleaseView; checkedAt: number; upToDate: boolean; current?: string }>
  installStart(): Promise<{ jobId: string }>
  removeManaged(): Promise<{ removed: string; commandCleared: boolean }>
  configUpdate(command: string | null): Promise<{ applied: ConfigView; restarting: boolean }>
  jobPoll(id: string): Promise<{ job?: JobView; stale: boolean }>
  jobCancel(id: string): Promise<{ job?: JobView }>
}

/**
 * Validate a GitHub host.
 * @param value - hostname, optionally with a port.
 * @returns the trimmed host.
 * @throws {GhError} `bad-input` for anything else.
 */
export function requireHost(value: string | undefined): string {
  const host = (value ?? DEFAULT_HOST).trim().toLowerCase().replace(/^https?:\/\//u, '').replace(/\/.*$/u, '')
  if (host === '') return DEFAULT_HOST
  if (!HOST_PATTERN.test(host)) throw new GhError('bad-input', `"${value}" is not a GitHub hostname.`, 'Use a name like github.com or ghe.example.com:8443.')
  return host
}

/**
 * Validate a git protocol choice.
 * @param value - `https` or `ssh`, defaulting to `https`.
 * @returns the protocol to pass to `gh`.
 */
export function requireProtocol(value: string | undefined): string {
  const protocol = (value ?? 'https').trim().toLowerCase()
  if (!(GIT_PROTOCOLS as readonly string[]).includes(protocol)) {
    throw new GhError('bad-input', `"${value}" is not a git protocol.`, 'Choose https or ssh.')
  }
  return protocol
}

/**
 * Validate optional extra scopes.
 * @param value - scope names from the page.
 * @returns the scopes to request, or `undefined` for `gh`'s defaults.
 */
export function optionalScopes(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parts = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : String(value).split(/[\s,]+/u)
  const scopes = parts.map(part => part.trim()).filter(part => part !== '')
  for (const scope of scopes) {
    if (!/^[\w.:*+-]{1,64}$/u.test(scope)) throw new GhError('bad-input', `"${scope}" is not a token scope name.`, 'Separate scopes with commas, for example repo,gist.')
  }
  return scopes.length === 0 ? undefined : scopes
}

/**
 * Validate a token typed into the page.
 * @param value - raw token text.
 * @returns the token, which callers must never log.
 */
export function requireToken(value: unknown): string {
  if (typeof value !== 'string') throw new GhError('bad-input', 'A token is required to sign in.')
  const token = value.trim()
  if (token === '') throw new GhError('bad-input', 'A token is required to sign in.')
  if (token.length > 4096 || /[\s\u0000-\u001f]/u.test(token)) {
    throw new GhError('bad-input', 'That token is not usable text.', 'Paste a personal access token without spaces or line breaks.')
  }
  return token
}

/**
 * Validate a `gh` executable value the page wants to save.
 * @param value - absolute path or bare program name, or `null` to fall back to `gh` on PATH.
 * @returns the value to persist, or `null`.
 */
export function requireCommand(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new GhError('bad-input', 'The gh path must be text.')
  const command = value.trim()
  if (command === '') return null
  if (command.length > 4096 || !COMMAND_PATTERN.test(command)) {
    throw new GhError('bad-input', `"${command}" is not a usable gh path.`, 'Give an absolute path such as /usr/bin/gh, or a program name like gh.')
  }
  return command
}

/**
 * Read everything one running child has written to both collected streams.
 * @param handle - the live child handle.
 * @returns combined text, newest tail first, for prompt and code detection.
 */
function collectedText(handle: SubprocessHandle): string {
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  return `${stdout}\n${stderr}`
}

/**
 * Extract the device-flow one-time code from `gh`'s output.
 * @param text - combined output so far.
 * @returns the code, or `undefined` while `gh` has not printed it yet.
 */
function deviceCodeOf(text: string): string | undefined {
  return /one[- ]time code:?\s*([A-Z0-9-]{6,12})/iu.exec(text)?.[1]
}

/**
 * Build the operations object one activation serves.
 * @param deps - clients, job table, configuration, and the config writer.
 * @returns the page-facing operations.
 */
export function createOps(deps: OpsDeps): GithubOps {
  const { gh, installer, jobs, config } = deps
  let cache: { at: number; view: StatusView } | undefined

  /** Forget the cached status so the next read recomputes it. */
  const invalidate = (): void => {
    cache = undefined
  }

  /** Effective configuration echoed to the page. */
  const configView = (): ConfigView => ({
    command: config.command,
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    commandExplicit: config.commandExplicit,
  })

  return {
    async status(): Promise<StatusView> {
      if (cache !== undefined && Date.now() - cache.at < STATUS_TTL_MS) return cache.view
      const installation = await gh.installation()
      const managed = await installer.managed(installation.path).catch((): undefined => undefined)
      const cached = installer.cached
      const platform = platformTarget()
      const paths = managedPaths()
      const extensions = installation.installed ? await gh.extensions().catch((): string[] => []) : []
      const checkedAt = cached.checkedAt === 0 ? undefined : cached.checkedAt
      const upToDate = installation.version !== undefined && cached.latest !== undefined
        ? installation.version === cached.latest.version
        : undefined
      const view: StatusView = {
        ...installation,
        source: installation.installed ? (config.commandExplicit ? 'config' : 'path') : 'none',
        ...managed === undefined ? {} : { managed },
        ...cached.latest === undefined ? {} : { latest: cached.latest },
        ...cached.checkError === undefined ? {} : { checkError: cached.checkError },
        ...checkedAt === undefined ? {} : { checkedAt },
        ...upToDate === undefined ? {} : { upToDate },
        config: configView(),
        platform,
        managedDir: paths.dir,
        managedPath: paths.path,
        extensions,
        runningJobs: jobs.running,
        serverTime: Date.now(),
      }
      cache = { at: Date.now(), view }
      return view
    },

    async authStatus(): Promise<AuthStatusView> {
      return await gh.authStatus()
    },

    async authToken(host?: string, user?: string): Promise<{ token: string; host: string }> {
      const target = requireHost(host)
      return { token: await gh.token(target, user), host: target }
    },

    async authLoginToken(token: string, host: string, gitProtocol: string, scopes?: string[]): Promise<{ message: string }> {
      const message = await gh.loginWithToken(token, { host, gitProtocol, ...scopes === undefined ? {} : { scopes } })
      invalidate()
      return { message }
    },

    async authLoginWeb(host: string, gitProtocol: string, scopes?: string[]): Promise<{ jobId: string }> {
      const jobId = jobs.start('sign-in', async (api): Promise<{ message: string }> => {
        const process: GhProcess = await gh.startWebLogin({ host, gitProtocol, ...scopes === undefined ? {} : { scopes } })
        // Settle in the background so the poll loop can read the printed code while `gh` waits.
        let outcome: { result?: GhRunResult; error?: unknown } = {}
        void process.finish().then(
          (result): void => {
            outcome = { result }
          },
          (error: unknown): void => {
            outcome = { error }
          },
        )
        let code: string | undefined
        let answered = false
        const deadline = Date.now() + LOGIN_JOB_TIMEOUT_MS
        api.log(`${process.label} started.`)
        while (outcome.result === undefined && outcome.error === undefined && Date.now() < deadline) {
          if (api.signal.aborted) {
            process.cancel()
            throw new GhError('timeout', 'Sign-in was cancelled.', 'Start it again when you are ready.')
          }
          const text = collectedText(process.handle)
          if (code === undefined) {
            code = deviceCodeOf(text)
            if (code !== undefined) {
              api.publish({ code, url: `https://${host}/login/device` })
              api.log(`One-time code: ${code}`)
            }
          }
          if (code !== undefined && !answered) {
            answered = true
            process.handle.stdin?.write('\n')
            api.log('Waiting for the browser sign-in to finish.')
          }
          await new Promise<void>(resolve => setTimeout(resolve, 400))
        }
        if (outcome.error !== undefined) {
          process.cancel()
          if (outcome.error instanceof GhError) throw outcome.error
          throw new GhError('gh-failed', `gh auth login failed: ${(outcome.error as Error).message}`, undefined, { cause: outcome.error })
        }
        const result = outcome.result
        if (result === undefined) {
          process.cancel()
          throw new GhError('timeout', 'The browser sign-in did not finish in time.', 'Open the code URL yourself, retry, or sign in with a token.')
        }
        if (!result.ok) {
          throw new GhError('gh-failed', `gh auth login exited ${String(result.exitCode)}.`, firstLine(result.stderr) ?? firstLine(result.stdout))
        }
        invalidate()
        return { message: firstLine(result.stdout) ?? 'Authenticated.' }
      })
      return { jobId }
    },

    async authLogout(host: string, user?: string): Promise<{ message: string }> {
      const message = await gh.logout(host, user)
      invalidate()
      return { message }
    },

    async authSwitch(host: string, user: string): Promise<{ message: string }> {
      const message = await gh.switchAccount(host, user)
      invalidate()
      return { message }
    },

    async releaseCheck(): Promise<{ latest: ReleaseView; checkedAt: number; upToDate: boolean; current?: string }> {
      const { latest, checkedAt } = await installer.release(true)
      const installation = await gh.installation().catch((): { installed: boolean; version?: string } => ({ installed: false }))
      invalidate()
      return {
        latest,
        checkedAt,
        upToDate: installation.version !== undefined && installation.version === latest.version,
        ...installation.version === undefined ? {} : { current: installation.version },
      }
    },

    async installStart(): Promise<{ jobId: string }> {
      const jobId = jobs.start('install', async (api): Promise<unknown> => {
        const outcome = await installer.install(api)
        if (outcome.shadowed) {
          api.log(`Pointing this plugin at ${outcome.path}.`)
          try {
            await deps.writeCommand(outcome.path)
          } catch (error) {
            api.log(`Could not save that path: ${(error as Error).message}`)
          }
        }
        invalidate()
        return outcome
      })
      return { jobId }
    },

    async removeManaged(): Promise<{ removed: string; commandCleared: boolean }> {
      const paths = managedPaths()
      const pointsAtManaged = config.commandExplicit
        && (config.command === paths.path || config.command.startsWith(`${paths.dir}/`))
      const removed = await installer.remove()
      if (pointsAtManaged) await deps.writeCommand(null)
      invalidate()
      return { removed, commandCleared: pointsAtManaged }
    },

    async configUpdate(command: string | null): Promise<{ applied: ConfigView; restarting: boolean }> {
      await deps.writeCommand(command)
      invalidate()
      // The saved value belongs to the next activation, so echo what was written, not what is running.
      const next = command === null ? configView() : { ...configView(), command, commandExplicit: true }
      return { applied: next, restarting: true }
    },

    async jobPoll(id: string): Promise<{ job?: JobView; stale: boolean }> {
      const job = jobs.poll(id)
      return { ...job === undefined ? {} : { job }, stale: job === undefined }
    },

    async jobCancel(id: string): Promise<{ job?: JobView }> {
      const job = jobs.cancel(id)
      return job === undefined ? {} : { job }
    },
  }
}
