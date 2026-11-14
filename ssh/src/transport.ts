/**
 * The transport every remote operation shares: one OpenSSH child, started with
 * explicit arguments and a bounded collect, terminated through the subprocess
 * provider's managed range, and read only after that range has drained.
 *
 * Both halves of the option set — the argv flags and the askpass environment —
 * are built in one place (`sshOptions`), because every lesson learned about them
 * has to apply to probes, remote commands, and file transfers alike:
 * `BatchMode` depends on whether a secret must be answered, an unknown host key
 * is recorded rather than asked about (a spawned child has no terminal), the
 * connect phase gets only a third of the deadline, and one child at a time counts
 * against the concurrency ceiling.
 *
 * @module @jie2gg/dsh-plugin-ssh/transport
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { MAX_CONCURRENT_PROBES, MIN_REMOTE_TIMEOUT_MS } from './storage.ts'
import { SshError } from './types.ts'
import type { AuthMode, ProbeOutcome, ProbeStatus, RemoteRunResult, RemoteStatus, SshSettings } from './types.ts'

/** The identity fields one remote operation connects with. */
export interface RemoteTarget {
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

/** The credentials one call may answer a prompt with. */
export interface RemoteAuth {
  /** How the target authenticates; omission keeps the agent-or-key path. */
  mode?: AuthMode | undefined
  /** Login password, for the modes that use one. */
  password?: string | undefined
  /** Private-key passphrase, handed to the askpass helper. */
  passphrase?: string | undefined
}

/** A ready askpass path, or the reason one is unavailable. */
export interface AskPassSource {
  /** Absolute path of the ssh askpass helper, or `undefined` when unavailable. */
  readonly path: string | undefined
  /** Why the helper could not be prepared. */
  readonly failure: string | undefined
}

/** stderr text meaning the host key is not trusted, or has changed. */
const HOST_KEY_PATTERNS: readonly RegExp[] = [
  /host key verification failed/iu,
  /no matching host key type/iu,
  /man-in-the-middle/iu,
  /remote host identification has changed/iu,
  /offending (rsa |ecdsa |ed25519 |ecdsa-sk |ed25519-sk )?key in/iu,
  /host key for .* did not match/iu,
  /fingerprint does not match/iu,
]

/** stderr text meaning the transport worked and the credential did not. */
const AUTH_PATTERNS: readonly RegExp[] = [
  /permission denied \((publickey|password|keyboard-interactive|hostbased)/iu,
  /no supported authentication methods/iu,
  /too many authentication failures/iu,
  /server refused our key/iu,
  /could not open a connection to your authentication agent/iu,
  /permission denied \(publickey/iu,
]

/** stderr text meaning the network or the host itself refused the session. */
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

/** Bytes of combined output kept as a failure explanation. */
const DETAIL_LIMIT = 2048

/** How long to wait for the provider to drain the pipes after termination. */
const DRAIN_MS = 400

/** An unknown host key is recorded on first contact; a changed one still fails. */
export const HOST_KEY_SETTING = 'StrictHostKeyChecking=accept-new'

/**
 * Quote one value for the **remote** shell.
 *
 * The remote command reaches the server as a single argument and is then parsed
 * by the login shell, so every path the plugin builds must arrive as one word.
 * A single-quoted POSIX word with embedded quotes doubled is exactly that.
 * @param value - the raw path or argument.
 * @returns the quoted word.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/**
 * The program name a remote command line starts with, used for the per-target
 * allowlist. A pipeline, a subshell, or an assignment has no single program, so
 * the caller must fall back to asking.
 * @param command - the remote command line as written.
 * @returns the leading program name, or `undefined` when the line is not one
 *   plain invocation.
 */
export function leadingProgram(command: string): string | undefined {
  const text = command.trim()
  if (text === '') return undefined
  // A redirection or a substitution is not a plain invocation either; keeping the
  // test cheap and conservative is the point: when in doubt, ask.
  if (/[|;&<>`$(){}\\]/u.test(text)) return undefined
  const first = text.split(/\s+/u)[0]
  if (first === undefined || first === '') return undefined
  // Compare allowlists on the bare name, so `/usr/bin/git` and `git` are the same
  // program to a reader who allowlisted `git`.
  const name = first.includes('/') ? first.slice(first.lastIndexOf('/') + 1) : first
  return /^[a-z0-9][a-z0-9._-]*$/u.test(name) ? name : undefined
}

/**
 * Pick the {@link ProbeStatus} for one finished probe.
 * @param exitCode - the child's exit code, or `null` when a signal ended it.
 * @param detail - the captured output tail.
 * @returns the status the page renders.
 */
export function classifyProbe(exitCode: number | null, detail: string): ProbeStatus {
  if (exitCode === 0) return 'reachable'
  if (HOST_KEY_PATTERNS.some(pattern => pattern.test(detail))) return 'unknown-host'
  if (AUTH_PATTERNS.some(pattern => pattern.test(detail))) return 'auth-failed'
  if (NETWORK_PATTERNS.some(pattern => pattern.test(detail))) return 'unreachable'
  return 'failed'
}

/**
 * Pick the {@link RemoteStatus} for one finished remote command.
 * @param exitCode - the child's exit code, or `null` when a signal ended it.
 * @param detail - the captured output.
 * @returns the classified outcome of the call.
 */
export function classifyRun(exitCode: number | null, detail: string): RemoteStatus {
  if (HOST_KEY_PATTERNS.some(pattern => pattern.test(detail))) return 'unknown-host'
  if (AUTH_PATTERNS.some(pattern => pattern.test(detail))) return 'auth-failed'
  if (NETWORK_PATTERNS.some(pattern => pattern.test(detail))) return 'unreachable'
  if (exitCode === 0) return 'succeeded'
  return exitCode === null ? 'failed' : 'exit-nonzero'
}

/**
 * Trim one call's captured streams into a single explanation tail.
 * @param stdout - collected stdout text.
 * @param stderr - collected stderr text.
 * @returns the trimmed detail, or `undefined` when the child said nothing.
 */
export function tail(stdout: string, stderr: string): string | undefined {
  const text = [stderr.trim(), stdout.trim()].filter(value => value !== '').join('\n')
  if (text === '') return undefined
  return text.length <= DETAIL_LIMIT ? text : text.slice(-DETAIL_LIMIT)
}

/**
 * The part of the provider's child handle this transport uses, stated locally.
 *
 * Written by hand rather than imported: a plugin resolves its own copy of the
 * subprocess package, and a nominal type from one copy does not satisfy the other,
 * which is how an unrelated call site would start failing to compile.
 */
interface ChildHandle {
  /** Resolves when the child is gone, with the exit classification. */
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  /** Streams the provider retains, readable from any offset. */
  collected: {
    stdout?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string | undefined } } | undefined
    stderr?: { readFrom(offset: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string | undefined } } | undefined
  }
  /** Starts the managed interrupt of the whole process range. */
  terminate(): void
  /** Waits out that range, bounded by the caller's signal. */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

/** The live controls of one backgrounded remote command. */
export interface RemoteJob {
  /** Pull sources shaped for the job registry's pump. */
  sources: readonly RemoteJobSource[]
  /** Interrupt the child through the managed range. */
  kill(): void
  /** The settled result, once the child has drained. */
  finished: Promise<Collected>
}

/** One incrementally readable stream of a backgrounded command. */
export interface RemoteJobSource {
  /** Which channel this reads. */
  channel: 'stdout' | 'stderr'
  /**
   * Read from a byte offset.
   * @param fromByte - the offset a previous read reported, or 0.
   * @returns the delta, the next offset, whether bytes were lost, and the spill file.
   */
  read(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string | undefined }
}

/**
 * Wrap the provider's own cursor readers as job output sources.
 * @param handle - the spawned child.
 * @returns the two sources the registry can pump.
 */
function streamSources(handle: ChildHandle): RemoteJobSource[] {
  const source = (channel: 'stdout' | 'stderr'): RemoteJobSource => ({
    channel,
    read: (fromByte: number) => {
      const reader = handle.collected[channel]
      if (reader === undefined) return { text: '', nextOffset: fromByte, lossy: false }
      const read = reader.readFrom(fromByte)
      return { text: read.text, nextOffset: read.nextOffset, lossy: read.lossy, ...(read.spillPath === undefined ? {} : { spillPath: read.spillPath }) }
    },
  })
  return [source('stdout'), source('stderr')]
}

/** What one bounded child produced. */
export interface Collected {
  outcome: 'exit' | 'timeout' | 'error' | 'cancelled'
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  truncated: boolean
  /** Why the provider could not run the child, when that is the outcome. */
  error?: string
}

/** Runs probes, remote commands, and transfers through `ctx.subprocess`. */
export class SshTransport {
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

  /** How many children this transport has running right now. */
  get inFlight(): number {
    return this.#inFlight
  }

  /** Abort every child still running, for plugin teardown. */
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
  async resolveExecutable(command: string, signal?: AbortSignal): Promise<string | undefined> {
    try {
      return await this.#ctx.subprocess.resolveExecutable(command, undefined, signal)
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      return undefined
    }
  }

  /**
   * Build the option flags and child environment one call needs.
   * @param program - the resolved executable, or the configured name when absent.
   * @param target - identity fields to connect with.
   * @param settings - shared ceilings and the probe/command deadline to derive from.
   * @param auth - the mode and any secret this call may answer with.
   * @param deadlineMs - the whole budget for this call, in milliseconds.
   * @returns the leading flags (through the host target), the environment, and
   *   whether a secret has to be answered.
   */
  sshOptions(
    target: RemoteTarget,
    settings: SshSettings,
    auth: RemoteAuth,
    deadlineMs: number,
    options: { readonly portFlag?: string | undefined } = {},
  ): { flags: string[]; env: NodeJS.ProcessEnv | undefined; needsSecret: boolean } {
    const mode = auth.mode ?? 'key'
    const needsSecret = mode === 'password' || mode === 'key+password' || (mode === 'key' && auth.passphrase !== undefined)
    const helper = this.#askpass?.path
    if (needsSecret && helper === undefined) {
      throw new SshError('secret-error', 'This Host cannot run the ssh askpass helper, so a stored password or passphrase cannot be used.', {
        hint: this.#askpass?.failure === undefined ? 'The helper is not prepared yet.' : this.#askpass.failure.slice(0, 512),
      })
    }
    // The connect phase gets a third of the budget, capped at 10 s: an
    // unreachable host still fails fast, and one that answers slowly keeps room
    // for key exchange and an authentication round.
    const connectTimeoutSeconds = Math.max(1, Math.min(10, Math.round(deadlineMs / 3000)))
    const flags: string[] = [
      '-o', `BatchMode=${needsSecret ? 'no' : 'yes'}`,
      '-o', HOST_KEY_SETTING,
      '-o', `ConnectTimeout=${String(connectTimeoutSeconds)}`,
      '-o', `ServerAliveInterval=${String(Math.max(1, Math.floor(connectTimeoutSeconds / 2)))}`,
    ]
    if (needsSecret) flags.push('-o', 'NumberOfPasswordPrompts=1')
    if (mode === 'password') {
      flags.push('-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive')
    } else if (mode === 'key') {
      flags.push('-o', 'PreferredAuthentications=publickey')
    }
    // scp names the port -P; only ssh takes -p.
    if (target.port !== undefined) flags.push(options.portFlag ?? '-p', String(target.port))
    if (target.identityFile !== undefined) flags.push('-i', target.identityFile)
    if (target.proxyJump !== undefined) flags.push('-J', target.proxyJump)
    if (target.extraArgs !== undefined) flags.push(...target.extraArgs)
    const env: NodeJS.ProcessEnv | undefined = needsSecret && helper !== undefined
      ? {
          // Explicit entries merge after the provider's environment scrub, which
          // is the only way a secret-shaped name reaches the child at all.
          SSH_ASKPASS: helper,
          SSH_ASKPASS_REQUIRE: 'force',
          DSH_SSH_ASKPASS_PASSWORD: auth.password ?? '',
          DSH_SSH_ASKPASS_PASSPHRASE: auth.passphrase ?? '',
        }
      : undefined
    return { flags, env, needsSecret }
  }

  /**
   * Address one target on the command line.
   * @param target - the identity fields.
   * @returns the `[user@]host` argument.
   */
  authority(target: RemoteTarget): string {
    return target.user === undefined || target.user === '' ? target.host : `${target.user}@${target.host}`
  }

  /**
   * Take one of the shared concurrency lanes.
   * @param label - what is being run, for the refusal message.
   * @returns the controller to hand to the child, already registered.
   */
  #takeLane(label: string): AbortController {
    if (this.#inFlight >= MAX_CONCURRENT_PROBES) {
      throw new SshError('busy', `At most ${String(MAX_CONCURRENT_PROBES)} remote operations may run at once.`, {
        hint: `Wait for the running ${label} to finish.`,
      })
    }
    this.#inFlight += 1
    const controller = new AbortController()
    this.#controllers.add(controller)
    return controller
  }

  /**
   * Start one child, wait for its bounded outcome, and read the drained streams.
   * @param program - resolved executable to run.
   * @param argvTail - arguments after the program, never shell-interpreted.
   * @param settings - the capture ceiling to honour.
   * @param env - the explicit child environment additions.
   * @param deadlineMs - the whole budget for this child.
   * @param controller - the lane's cancellation controller.
   * @param external - an optional caller signal (a tool call's own cancellation).
   * @returns the outcome class, exit facts, drained streams, and duration.
   */
  /**
   * Start one child through the provider and wire the cancellation edges.
   * @param program - the resolved executable.
   * @param argvTail - the arguments after the executable.
   * @param settings - the output ceiling the provider retains to.
   * @param env - extra environment entries, when a secret has to be answered.
   * @param controller - the lane controller this child is bound to.
   * @param external - the caller's own signal, which outranks the deadline.
   * @param stdin - text fed to the child, or nothing when stdin stays closed.
   * @returns the live handle and the detacher for the caller's signal.
   */
  #spawn(
    program: string,
    argvTail: readonly string[],
    settings: SshSettings,
    env: NodeJS.ProcessEnv | undefined,
    controller: AbortController,
    external: AbortSignal | undefined,
    stdin: string | undefined,
  ): { handle: ChildHandle; detach: () => void } {
    const handle = this.#ctx.subprocess.spawn({
      argv: [program, ...argvTail],
      cwd: process.env.HOME ?? process.cwd(),
      stdio: {
        stdin: stdin === undefined ? 'ignore' : { data: stdin },
        stdout: { maxBytes: settings.maxOutputBytes },
        stderr: { maxBytes: settings.maxOutputBytes },
      },
      graceMs: 2_000,
      ...(env === undefined ? {} : { env }),
      signal: controller.signal,
    })
    const onExternalAbort = (): void => { controller.abort() }
    if (external !== undefined) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', onExternalAbort, { once: true })
    }
    return { handle, detach: () => { external?.removeEventListener('abort', onExternalAbort) } }
  }

  /**
   * Wait for one child to settle, then drain it if the wait was interrupted.
   *
   * Shared by a foreground collect and a background job so neither can learn a
   * different lesson about the provider: reading the streams before the managed
   * range has drained leaves a timeout or a cancellation with no reason at all.
   * @param handle - the spawned child.
   * @param controller - the lane controller, aborted to end the wait.
   * @param deadlineMs - how long to wait before terminating it.
   * @param external - the caller's signal, which reads as cancelled rather than timed out.
   * @param startedAt - the millisecond the wait began.
   * @returns the settled classification and the drained streams.
   */
  async #settleAndDrain(
    handle: ChildHandle,
    controller: AbortController,
    deadlineMs: number,
    external: AbortSignal | undefined,
    startedAt: number,
  ): Promise<Collected> {
    type Settled =
      | { kind: 'exit'; exitCode: number | null; signal: NodeJS.Signals | null }
      | { kind: 'timeout' }
      | { kind: 'cancelled' }
      | { kind: 'error'; message: string }
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled: Settled
    try {
      settled = await new Promise<Settled>(resolve => {
        void handle.done
          .then(outcome => { resolve({ kind: 'exit', exitCode: outcome.exitCode, signal: outcome.signal }) })
          .catch((error: unknown) => {
            resolve({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
          })
        timer = setTimeout(() => {
          controller.abort()
          resolve(external?.aborted === true ? { kind: 'cancelled' } : { kind: 'timeout' })
        }, Math.max(MIN_REMOTE_TIMEOUT_MS, deadlineMs))
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    if (settled.kind !== 'exit') {
      // Providers flush the pipes while they terminate the managed range, so the
      // streams are read only after that settles; reading earlier leaves a
      // timeout or cancellation with no reason at all.
      handle.terminate()
      const drain = new AbortController()
      const drainTimer = setTimeout(() => { drain.abort() }, DRAIN_MS)
      await handle.waitForExit(drain.signal).catch(() => undefined)
      clearTimeout(drainTimer)
    }

    const stdoutRead = handle.collected.stdout?.readFrom(0)
    const stderrRead = handle.collected.stderr?.readFrom(0)
    const stdout = stdoutRead?.text ?? ''
    const stderr = stderrRead?.text ?? ''
    return {
      outcome: settled.kind === 'error' ? 'error' : settled.kind,
      ...(settled.kind === 'error' ? { error: settled.message } : {}),
      exitCode: settled.kind === 'exit' ? settled.exitCode : null,
      signal: settled.kind === 'exit' ? settled.signal : null,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
      truncated: stdoutRead?.lossy === true || stderrRead?.lossy === true,
    }
  }

  async #collect(
    program: string,
    argvTail: readonly string[],
    settings: SshSettings,
    env: NodeJS.ProcessEnv | undefined,
    deadlineMs: number,
    controller: AbortController,
    external?: AbortSignal,
    stdin?: string,
  ): Promise<Collected> {
    const startedAt = Date.now()
    const { handle, detach } = this.#spawn(program, argvTail, settings, env, controller, external, stdin)
    try {
      return await this.#settleAndDrain(handle, controller, deadlineMs, external, startedAt)
    } finally {
      detach()
    }
  }

  /**
   * Run one bounded child end to end.
   * @param program - resolved executable.
   * @param argvTail - arguments after the program.
   * @param settings - ceilings and defaults.
   * @param env - explicit child environment additions.
   * @param deadlineMs - whole budget for this call.
   * @param label - what is running, for the concurrency refusal.
   * @param external - optional caller cancellation signal.
   * @returns the drained outcome.
   */
  async execute(
    program: string,
    argvTail: readonly string[],
    settings: SshSettings,
    env: NodeJS.ProcessEnv | undefined,
    deadlineMs: number,
    label: string,
    external?: AbortSignal,
  ): Promise<Collected> {
    const controller = this.#takeLane(label)
    try {
      return await this.#collect(program, argvTail, settings, env, deadlineMs, controller, external)
    } finally {
      this.#controllers.delete(controller)
      this.#inFlight -= 1
    }
  }

  /**
   * Probe one target: connect and run `true` and nothing else.
   * @param target - the identity fields to connect with.
   * @param settings - the executable, deadline, and capture ceiling to honour.
   * @param auth - the mode and any secret this probe should answer with.
   * @returns the classified outcome; only a concurrency or secret-plumbing
   *   refusal throws.
   */
  async probe(target: RemoteTarget, settings: SshSettings, auth?: RemoteAuth): Promise<ProbeOutcome> {
    const controller = this.#takeLane('probe')
    try {
      const deadline = settings.probeTimeoutMs
      const { flags, env } = this.sshOptions(target, settings, auth ?? {}, deadline)
      const program = await this.resolveExecutable(settings.command, controller.signal)
      if (program === undefined) {
        return {
          at: new Date().toISOString(),
          status: 'ssh-missing',
          durationMs: 0,
          detail: `Could not resolve the ssh executable "${settings.command}".`,
        }
      }
      const collected = await this.#collect(program, [...flags, this.authority(target), 'true'], settings, env, deadline, controller)
      const detail = tail(collected.stdout, collected.stderr)
      if (collected.outcome === 'timeout') {
        return {
          at: new Date().toISOString(),
          status: 'timeout',
          durationMs: collected.durationMs,
          ...(detail === undefined ? {} : { detail }),
        }
      }
      if (collected.outcome === 'cancelled') {
        return {
          at: new Date().toISOString(),
          status: 'failed',
          durationMs: collected.durationMs,
          detail: 'The probe was cancelled.',
        }
      }
      if (collected.outcome === 'error') {
        return {
          at: new Date().toISOString(),
          status: 'failed',
          durationMs: collected.durationMs,
          detail: `The ssh client could not start: ${collected.error ?? collected.stdout}${collected.stderr}`.slice(0, DETAIL_LIMIT),
        }
      }
      return {
        at: new Date().toISOString(),
        status: classifyProbe(collected.exitCode, detail ?? ''),
        durationMs: collected.durationMs,
        exitCode: collected.exitCode,
        ...(detail === undefined ? {} : { detail }),
      }
    } finally {
      this.#controllers.delete(controller)
      this.#inFlight -= 1
    }
  }

  /**
   * Ask the local OpenSSH client what a target really resolves to.
   *
   * `ssh -G` applies the client configuration and prints the result without
   * contacting the server, so it answers "where does this alias actually go"
   * instantly and without a credential. The plugin's own overrides (port, key,
   * jump, extra flags) are passed exactly as a probe would pass them, so what is
   * printed is what a probe would dial.
   * @param target - the identity fields to resolve.
   * @param settings - the executable and the capture ceiling.
   * @returns the resolved configuration text, or a classified failure.
   */
  async resolve(target: RemoteTarget, settings: SshSettings): Promise<Collected> {
    const controller = this.#takeLane('config resolution')
    try {
      const program = await this.resolveExecutable(settings.command, controller.signal)
      if (program === undefined) {
        return {
          outcome: 'error',
          error: `Could not resolve the ssh executable "${settings.command}".`,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: 0,
          truncated: false,
        }
      }
      const flags: string[] = []
      if (target.port !== undefined) flags.push('-p', String(target.port))
      if (target.identityFile !== undefined) flags.push('-i', target.identityFile)
      if (target.proxyJump !== undefined) flags.push('-J', target.proxyJump)
      if (target.extraArgs !== undefined) flags.push(...target.extraArgs)
      return await this.#collect(program, ['-G', ...flags, this.authority(target)], settings, undefined, 5_000, controller)
    } finally {
      this.#controllers.delete(controller)
      this.#inFlight -= 1
    }
  }

  /**
   * Start one remote command and hand back its live handles instead of waiting.
   *
   * This is what a background job needs: the output can be pumped incrementally
   * from the provider's own cursors, and cancellation reaches the child through the
   * same managed range a foreground call uses. The lane stays occupied while the
   * command runs, which is the point — the plugin's ceiling on concurrent remote
   * operations counts a long job like any other child.
   * @param target - where to run it.
   * @param settings - the executable, the retention ceiling, and the defaults.
   * @param auth - the credentials for this target.
   * @param command - the command line, executed by the remote login shell.
   * @param options - the deadline, the caller's signal, and whether to ask for a tty.
   * @returns the sources, a killer, and the settled result, or `undefined` when the
   *   executable cannot be resolved.
   */
  async startRun(
    target: RemoteTarget,
    settings: SshSettings,
    auth: RemoteAuth,
    command: string,
    options: {
      readonly timeoutMs?: number | undefined
      readonly signal?: AbortSignal | undefined
      readonly tty?: boolean | undefined
    } = {},
  ): Promise<RemoteJob | undefined> {
    const deadline = Math.max(MIN_REMOTE_TIMEOUT_MS, options.timeoutMs ?? settings.remoteTimeoutMs)
    const controller = this.#takeLane('background command')
    const program = await this.resolveExecutable(settings.command, controller.signal)
    if (program === undefined) {
      this.#controllers.delete(controller)
      this.#inFlight -= 1
      return undefined
    }
    // The same option set a foreground call builds, so a backgrounded command
    // authenticates and trusts the host exactly like the probe for that target does.
    const { flags, env } = this.sshOptions(target, settings, auth, deadline)
    const ttyFlags = options.tty === true ? ['-tt'] : []
    const startedAt = Date.now()
    const { handle, detach } = this.#spawn(program, [...flags, ...ttyFlags, this.authority(target), command], settings, env, controller, options.signal, undefined)
    const finished = this.#settleAndDrain(handle, controller, deadline, options.signal, startedAt)
      .then((result: Collected) => { detach(); return result })
      .catch((error: unknown) => {
        detach()
        return {
          outcome: 'error' as const,
          error: error instanceof Error ? error.message : String(error),
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: '',
          durationMs: Date.now() - startedAt,
          truncated: false,
        } satisfies Collected
      })
      .finally(() => {
        this.#controllers.delete(controller)
        this.#inFlight -= 1
      })
    return {
      sources: streamSources(handle),
      kill: (): void => {
        controller.abort()
        handle.terminate()
      },
      finished,
    }
  }

  /**
   * Run one command on the remote host.
   *
   * The command is a single argument, so nothing is interpreted locally; the
   * remote login shell does its own quoting, exactly as `ssh host <command>`
   * does in a terminal.
   * @param target - the identity fields to connect with.
   * @param settings - the executable and shared ceilings.
   * @param auth - the mode and secrets to authenticate with.
   * @param command - the remote command line.
   * @param options - per-call deadline, output ceiling, stdin payload, and
   *   cancellation.
   * @returns the classified run result; a concurrency refusal throws.
   */
  async run(
    target: RemoteTarget,
    settings: SshSettings,
    auth: RemoteAuth,
    command: string,
    options: {
      readonly timeoutMs?: number | undefined
      readonly maxOutputBytes?: number | undefined
      readonly signal?: AbortSignal | undefined
      /** Text fed to the remote command's stdin, for a file write or a prompt answer. */
      readonly stdin?: string | undefined
      /**
       * Ask the server for a pseudo-terminal (`-tt`). This is what a command that
       * inspects its stdout — `sudo` reading a password, `ssh` hopping again, a
       * colourised `ls` — needs in order to stop waiting for a terminal that was
       * never there. The trade is that the server then merges stderr into stdout
       * and ends lines with CRLF, so the answer arrives noisier.
       */
      readonly tty?: boolean | undefined
    } = {},
  ): Promise<RemoteRunResult> {
    const deadline = Math.max(MIN_REMOTE_TIMEOUT_MS, options.timeoutMs ?? settings.remoteTimeoutMs)
    const bounded: SshSettings = options.maxOutputBytes === undefined ? settings : { ...settings, maxOutputBytes: options.maxOutputBytes }
    const controller = this.#takeLane('remote command')
    try {
      const { flags, env } = this.sshOptions(target, bounded, auth, deadline)
      const program = await this.resolveExecutable(bounded.command, controller.signal)
      if (program === undefined) {
        return {
          at: new Date().toISOString(),
          status: 'ssh-missing',
          durationMs: 0,
          stderr: `Could not resolve the ssh executable "${bounded.command}".`,
        }
      }
      // `-tt` must precede the destination, like every other ssh option. Two t's,
      // not one: a single `-t` defers to the local side having a terminal, which a
      // spawned child never does.
      const ttyFlags = options.tty === true ? ['-tt'] : []
      const collected = await this.#collect(program, [...flags, ...ttyFlags, this.authority(target), command], bounded, env, deadline, controller, options.signal, options.stdin)
      const result: RemoteRunResult = {
        at: new Date().toISOString(),
        status: collected.outcome === 'cancelled'
          ? 'cancelled'
          : collected.outcome === 'timeout'
            ? 'timeout'
            : collected.outcome === 'error'
              ? 'failed'
              : classifyRun(collected.exitCode, `${collected.stdout}\n${collected.stderr}`),
        durationMs: collected.durationMs,
        ...(options.tty === true ? { tty: true } : {}),
        ...(options.stdin === undefined ? {} : { stdinBytes: Buffer.byteLength(options.stdin, 'utf8') }),
        ...(collected.exitCode === null && collected.outcome !== 'exit' ? {} : { exitCode: collected.exitCode }),
        ...(collected.stdout === '' ? {} : { stdout: collected.stdout }),
        ...(collected.stderr === '' && collected.error === undefined ? {} : {
          stderr: [collected.stderr, collected.error === undefined ? '' : `The ssh client could not start: ${collected.error}`]
            .filter(value => value !== '')
            .join('\n'),
        }),
        ...(collected.truncated ? { truncated: true } : {}),
      }
      return result
    } finally {
      this.#controllers.delete(controller)
      this.#inFlight -= 1
    }
  }
}
