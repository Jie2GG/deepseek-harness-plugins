/**
 * One bounded connectivity probe against a target, run through the Host's
 * subprocess service.
 *
 * The probe never authenticates interactively: it forces `BatchMode=yes`, so an
 * unusable credential comes back as a classified result instead of a child
 * waiting forever for a passphrase. It also never relaxes host-key checking and
 * never writes `known_hosts`, because both belong to the user's own OpenSSH
 * state, not to this plugin.
 *
 * @module @deepseek-ai/dsh-plugin-ssh/ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { MAX_CONCURRENT_PROBES } from './storage.ts'
import { SshError } from './types.ts'
import type { ProbeOutcome, ProbeStatus, SshSettings } from './types.ts'

/** The identity fields one probe needs from a target. */
export interface ProbeTarget {
  /** Host name or an existing OpenSSH host alias. */
  host: string
  /** Remote user. */
  user?: string | undefined
  /** Remote port. */
  port?: number | undefined
  /** Private key path. */
  identityFile?: string | undefined
  /** Jump host. */
  proxyJump?: string | undefined
  /** Additional client flags. */
  extraArgs?: readonly string[] | undefined
}

/** stderr text that means the host key is not trusted yet. */
const HOST_KEY_PATTERNS: readonly RegExp[] = [
  /host key verification failed/iu,
  /no matching host key type/iu,
  /man-in-the-middle/iu,
]

/** stderr text that means the transport worked and the credential did not. */
const AUTH_PATTERNS: readonly RegExp[] = [
  /permission denied \((publickey|password|keyboard-interactive|hostbased)/iu,
  /no supported authentication methods/iu,
  /too many authentication failures/iu,
  /server refused our key/iu,
  /could not open a connection to your authentication agent/iu,
  /permission denied \(publickey/iu,
]

/** stderr text that means the network or the host itself refused the session. */
const NETWORK_PATTERNS: readonly RegExp[] = [
  /connection refused/iu,
  /no route to host/iu,
  /host is (down|not reachable)/iu,
  /network is unreachable/iu,
  /could not resolve hostname/iu,
  /name or service not known/iu,
  /connect to host .* timed out/iu,
  /connection timed out/iu,
  /operation timed out/iu,
  /connection closed by/iu,
  /connection reset by peer/iu,
  /broken pipe/iu,
  /ssh: connect to host/iu,
]

/** Bytes of combined output kept as the failure explanation. */
const DETAIL_LIMIT = 2048

/**
 * Pick the {@link ProbeStatus} for one finished probe.
 * @param exitCode - the child's exit code, or `null` when a signal ended it.
 * @param detail - the captured output tail.
 * @returns the status the page renders.
 */
function classify(exitCode: number | null, detail: string): ProbeStatus {
  if (exitCode === 0) return 'reachable'
  if (HOST_KEY_PATTERNS.some(pattern => pattern.test(detail))) return 'unknown-host'
  if (AUTH_PATTERNS.some(pattern => pattern.test(detail))) return 'auth-failed'
  if (NETWORK_PATTERNS.some(pattern => pattern.test(detail))) return 'unreachable'
  return 'failed'
}

/**
 * Trim one probe's captured streams into a single explanation tail.
 * @param stdout - collected stdout text.
 * @param stderr - collected stderr text.
 * @returns the trimmed detail, or `undefined` when the child said nothing.
 */
function tail(stdout: string, stderr: string): string | undefined {
  const text = [stderr.trim(), stdout.trim()].filter(value => value !== '').join('\n')
  if (text === '') return undefined
  return text.length <= DETAIL_LIMIT ? text : `${text.slice(-DETAIL_LIMIT)}`
}

/** The credentials one probe may need, supplied per call and never stored here. */
export interface ProbeAuth {
  /** How the target authenticates; omission keeps the agent-or-key probe. */
  mode?: 'password' | 'key' | 'key+password'
  /** Login password, for the modes that use one. */
  password?: string | undefined
  /** Private-key passphrase, handed to the askpass helper. */
  passphrase?: string | undefined
}

/** Reads and writes a target's secrets in the credential store. */
export interface AskPassSource {
  /** Absolute path of the ssh askpass helper, or `undefined` when unavailable. */
  readonly path: string | undefined
  /** Why the helper could not be prepared. */
  readonly failure: string | undefined
}

/** Runs probes through `ctx.subprocess`, one executable lookup at a time. */
export class SshRunner {
  readonly #ctx: Context
  readonly #askpass: AskPassSource | undefined
  #inFlight = 0
  readonly #controllers = new Set<AbortController>()

  /**
   * @param ctx - Host context that carries `subprocess`.
   * @param askpass - the helper that answers a password or passphrase prompt.
   */
  constructor(ctx: Context, askpass?: AskPassSource) {
    this.#ctx = ctx
    this.#askpass = askpass
  }

  /** How many probes are running right now. */
  get inFlight(): number {
    return this.#inFlight
  }

  /** Abort every probe still running, for plugin teardown. */
  dispose(): void {
    for (const controller of this.#controllers) controller.abort()
    this.#controllers.clear()
  }

  /**
   * Resolve the configured executable.
   * @param command - a bare name or an absolute path.
   * @param signal - cancellation of the lookup.
   * @returns the resolved path, or `undefined` when the executable is missing.
   */
  async #resolve(command: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      return await this.#ctx.subprocess.resolveExecutable(command, undefined, signal)
    } catch (error: unknown) {
      if (signal.aborted) throw error
      return undefined
    }
  }

  /**
   * Probe one target: `ssh -o BatchMode=<yes|no> … <host> true`.
   * @param target - the identity fields to connect with.
   * @param settings - the executable, deadline, and capture ceiling to honour.
   * @param auth - the mode and any secret this probe should answer with.
   * @returns the classified outcome; only a concurrency or secret-plumbing
   *   refusal throws.
   */
  async probe(target: ProbeTarget, settings: SshSettings, auth?: ProbeAuth): Promise<ProbeOutcome> {
    if (this.#inFlight >= MAX_CONCURRENT_PROBES) {
      throw new SshError('busy', `At most ${String(MAX_CONCURRENT_PROBES)} probes may run at once.`, {
        hint: 'Wait for the running probes to finish.',
      })
    }
    this.#inFlight += 1
    const controller = new AbortController()
    this.#controllers.add(controller)
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const mode = auth?.mode ?? 'key'
      const password = auth?.password
      const passphrase = auth?.passphrase
      // A secret can only be answered through the askpass helper: stdin is
      // ignored, so an interactive prompt would just burn the whole deadline.
      const needsSecret = mode === 'password' || mode === 'key+password' || (mode === 'key' && passphrase !== undefined)
      const helper = this.#askpass?.path
      if (needsSecret && helper === undefined) {
        throw new SshError('secret-error', 'This Host cannot run the ssh askpass helper, so a stored password or passphrase cannot be used.', {
          hint: this.#askpass?.failure === undefined ? 'The helper is not prepared yet.' : this.#askpass.failure.slice(0, 512),
        })
      }
      const connectTimeoutSeconds = Math.max(1, Math.round(settings.probeTimeoutMs / 1000))
      const executable = await this.#resolve(settings.command, controller.signal)
      if (executable === undefined) {
        return {
          at: new Date().toISOString(),
          status: 'ssh-missing',
          durationMs: Date.now() - startedAt,
          detail: `Could not resolve the ssh executable "${settings.command}".`,
        }
      }
      const argv: string[] = [
        executable,
        '-o', `BatchMode=${needsSecret ? 'no' : 'yes'}`,
        '-o', `ConnectTimeout=${String(connectTimeoutSeconds)}`,
        '-o', `ServerAliveInterval=${String(Math.max(1, Math.floor(connectTimeoutSeconds / 2)))}`,
      ]
      if (needsSecret) argv.push('-o', 'NumberOfPasswordPrompts=1')
      if (mode === 'password') {
        argv.push('-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive')
      } else if (mode === 'key') {
        argv.push('-o', 'PreferredAuthentications=publickey')
      }
      if (target.port !== undefined) argv.push('-p', String(target.port))
      if (target.identityFile !== undefined) argv.push('-i', target.identityFile)
      if (target.proxyJump !== undefined) argv.push('-J', target.proxyJump)
      if (target.extraArgs !== undefined) argv.push(...target.extraArgs)
      argv.push(target.user === undefined ? target.host : `${target.user}@${target.host}`, 'true')

      // Explicit entries merge after the provider's environment scrub, which is
      // how the helper path and the secret reach the child at all.
      const env: NodeJS.ProcessEnv | undefined = needsSecret && helper !== undefined
        ? {
            SSH_ASKPASS: helper,
            SSH_ASKPASS_REQUIRE: 'force',
            DSH_SSH_ASKPASS_PASSWORD: password ?? '',
            DSH_SSH_ASKPASS_PASSPHRASE: passphrase ?? '',
          }
        : undefined

      const handle = this.#ctx.subprocess.spawn({
        argv,
        cwd: process.env.HOME ?? process.cwd(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: settings.maxOutputBytes },
          stderr: { maxBytes: settings.maxOutputBytes },
        },
        graceMs: 2_000,
        ...(env === undefined ? {} : { env }),
        signal: controller.signal,
      })

      type Settled =
        | { kind: 'exit'; exitCode: number | null; signal: NodeJS.Signals | null }
        | { kind: 'timeout' }
        | { kind: 'error'; message: string }
      const settled = await new Promise<Settled>(resolve => {
        void handle.done
          .then(outcome => { resolve({ kind: 'exit', exitCode: outcome.exitCode, signal: outcome.signal }) })
          .catch((error: unknown) => { resolve({ kind: 'error', message: error instanceof Error ? error.message : String(error) }) })
        timer = setTimeout(() => {
          controller.abort()
          resolve({ kind: 'timeout' })
        }, settings.probeTimeoutMs)
      })

      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      const durationMs = Date.now() - startedAt

      if (settled.kind === 'timeout') {
        handle.terminate()
        return {
          at: new Date().toISOString(),
          status: 'timeout',
          durationMs,
          ...(tail(stdout, stderr) === undefined ? {} : { detail: tail(stdout, stderr) }),
        }
      }
      if (settled.kind === 'error') {
        return {
          at: new Date().toISOString(),
          status: 'failed',
          durationMs,
          detail: `The ssh client could not start: ${settled.message}`.slice(0, DETAIL_LIMIT),
        }
      }
      const detail = tail(stdout, stderr)
      const status = classify(settled.exitCode, detail ?? '')
      return {
        at: new Date().toISOString(),
        status,
        durationMs,
        exitCode: settled.exitCode,
        ...(detail === undefined ? {} : { detail }),
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.#controllers.delete(controller)
      this.#inFlight -= 1
    }
  }
}
