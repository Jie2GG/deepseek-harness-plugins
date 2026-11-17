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
 * Sharing is decided in one place too: a call that wants to ride on an existing
 * connection leases one from the pool before `sshOptions` runs and hands it back
 * when the child is gone. A call that leases nothing gets `ControlPath=none`, so
 * the only way a plugin child can join a control socket is by asking.
 *
 * @module @jie2gg/dsh-plugin-ssh/transport
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import { MAX_CONCURRENT_OPS, SCP_EXECUTABLE, SCP_FALLBACK_PATHS, SSH_EXECUTABLE, SSH_FALLBACK_PATHS } from './storage.ts'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

/**
 * The timeout code this module stamps on its own deadline, so `timeoutOf` can tell
 * a timeout of ours apart from a caller's cancellation even when both were fused
 * into one signal. The harness names this per capability (`BASH_TIMEOUT`); the
 * symmetry is the point.
 */
export const SSH_TIMEOUT = 'SSH_TIMEOUT'
import { NO_SHARE_FLAGS, type MuxSource, type PoolTicket } from './pool.ts'
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
  /**
   * The stored target's id. The pool keys a shared connection by it so an edited
   * target cannot inherit the master its predecessor left behind; a draft has none.
   */
  id?: string | undefined
  /** Whether this target may share; `off` asks for a fresh connection every call. */
  pool?: 'on' | 'off' | undefined
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

/**
 * stderr text meaning a shared connection stopped being usable: the server refused
 * another channel, or the master hung up under the call. Either way the pool should
 * forget this master and the next call dials its own.
 */
const SESSION_SETUP_PATTERNS: readonly RegExp[] = [
  /session setup failed/iu,
  /too many sessions/iu,
  /exceeded maxsessions/iu,
  /channel open failed/iu,
  /packet write failed/iu,
  /mux_handler: read error/iu,
  /controlsocket.*already exists/iu,
]

/** stderr text meaning the transport worked and the credential did not. */
const AUTH_PATTERNS: readonly RegExp[] = [
  /permission denied \((publickey|password|keyboard-interactive|hostbased)/iu,
  /no supported authentication methods/iu,
  /too many authentication failures/iu,
  /server refused our key/iu,
  /could not open a connection to your authentication agent/iu,
  /permission denied \(publickey/iu,
  // Elevation answers come from the same kind of secret, and a wrong one must
  // read as an authentication failure rather than a plain nonzero exit.
  /incorrect password/iu,
  /sudo: a password is required/iu,
  /su: authentication failure/iu,
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

/**
 * How long to wait for the provider to drain the pipes after termination.
 *
 * Exported because the budget this plugin declares to the harness has to sit above
 * the worst case an internal deadline can take, and that worst case is the
 * deadline plus this drain plus the kill grace — three numbers that live in
 * different files and have to be read together to stay true.
 */
export const DRAIN_MS = 400

/**
 * How long one `ssh -O exit` teardown child gets before it is given up on.
 *
 * Closing a master is a conversation with the local socket, not with the server,
 * so it answers in milliseconds or the master is already gone. It takes no
 * operation slot and borrows no page setting, hence its own small budget.
 */
const MASTER_EXIT_MS = 2_000

/**
 * The ceilings a teardown child runs under, for the same reason. Stated here and
 * not read from the bounds layer on purpose: these are this module's own small
 * budget for talking to a local socket, and a profile that sets a generous
 * transfer ceiling has no bearing on closing a master.
 */
const CONTROL_SETTINGS: SshSettings = {
  maxOutputBytes: 8_192,
  remoteTimeoutMs: MASTER_EXIT_MS,
  maxTransferBytes: 1_024,
  probeTimeoutMs: MASTER_EXIT_MS,
  statTimeoutMs: MASTER_EXIT_MS,
  maxSpillBytes: 0,
  graceMs: 500,
}

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
 * Turn one finished child into the classified result a reader of `exec` sees.
 *
 * Exported because two paths reach the same answer now: a foreground call that
 * settled inside its deadline, and one that settled after being handed to the job
 * registry. Both must read the server's output the same way, or a promoted command
 * would answer the model's question with different words than one that finished on
 * time.
 * @param collected - what the bounded child produced.
 * @param facts - what the call asked for, echoed back the way `run` echoes it.
 * @returns the classified run result.
 */
export function classifyCollectedRun(
  collected: Collected,
  facts: { tty?: boolean | undefined; stdinBytes?: number | undefined } = {},
): RemoteRunResult {
  const text = `${collected.stdout}\n${collected.stderr}`
  const status: RemoteStatus = collected.outcome === 'cancelled'
    ? 'cancelled'
    : collected.outcome === 'timeout'
      ? 'timeout'
      : collected.outcome === 'error'
        ? 'failed'
        : classifyRun(collected.exitCode, text)
  return {
    at: new Date().toISOString(),
    status,
    durationMs: collected.durationMs,
    ...(facts.tty === true ? { tty: true } : {}),
    ...(facts.stdinBytes === undefined ? {} : { stdinBytes: facts.stdinBytes }),
    ...(collected.exitCode === null && collected.outcome !== 'exit' ? {} : { exitCode: collected.exitCode }),
    ...(collected.stdout === '' ? {} : { stdout: collected.stdout }),
    ...(collected.stderr === '' && collected.error === undefined ? {} : {
      stderr: [collected.stderr, collected.error === undefined ? '' : `The ssh client could not start: ${collected.error}`]
        .filter(value => value !== '')
        .join('\n'),
    }),
    ...(collected.truncated ? { truncated: true } : {}),
    ...(collected.stdoutSpillPath === undefined ? {} : { stdoutSpillPath: collected.stdoutSpillPath }),
    ...(collected.stderrSpillPath === undefined ? {} : { stderrSpillPath: collected.stderrSpillPath }),
  }
}

/**
 * The argv tail one probe runs with.
 *
 * Two shapes, because what ends the child depends on what the call leaves behind:
 *
 * - a call carrying a shared connection asks for `-N`: OpenSSH hands the
 *   authenticated master to the background (`ControlPersist`) and the foreground
 *   client, with no remote command and nothing to forward, exits on its own — a
 *   live measurement put that at two tenths of a second for a first connection and
 *   a tenth for a warm one, and a rejected credential still answers
 *   `Permission denied (…)` rather than hanging;
 * - a call with no control socket asks for `true` instead, because `-N` with no
 *   master to leave behind simply sits on an idle session until its deadline, and
 *   a page that waits thirty seconds to say “yes” is a worse page than one that
 *   runs one word on the far side.
 *
 * So a probe now stops at the question it is actually being asked — can this
 * credential get an authenticated session open — and a target whose sharing is
 * switched off keeps answering the slightly wider question it always answered.
 * @param flags - the option flags, already built.
 * @param authority - the `[user@]host` to address.
 * @param pooled - whether this call is carrying a control socket.
 * @returns the argv tail for the child.
 */
export function probeArgvTail(flags: readonly string[], authority: string, pooled: boolean): string[] {
  return pooled ? [...flags, '-N', authority] : [...flags, authority, 'true']
}

/**
 * Turn one finished probe child into the outcome the page stores.
 *
 * The child's own ending comes first: a probe that ran out of its deadline or was
 * cancelled never reaches an exit code worth classifying, and reading one anyway
 * is how a timeout used to arrive with no reason attached.
 * @param collected - what the bounded child produced.
 * @param detail - the captured output tail, already trimmed.
 * @returns the classified probe outcome.
 */
function classifyCollectedProbe(collected: Collected, detail: string | undefined): ProbeOutcome {
  const at = new Date().toISOString()
  if (collected.outcome === 'timeout') {
    return { at, status: 'timeout', durationMs: collected.durationMs, ...(detail === undefined ? {} : { detail }) }
  }
  if (collected.outcome === 'cancelled') {
    return { at, status: 'failed', durationMs: collected.durationMs, detail: 'The probe was cancelled.' }
  }
  if (collected.outcome === 'error') {
    return {
      at,
      status: 'failed',
      durationMs: collected.durationMs,
      detail: `The ssh client could not start: ${collected.error ?? collected.stdout}${collected.stderr}`.slice(0, DETAIL_LIMIT),
    }
  }
  return {
    at,
    status: classifyProbe(collected.exitCode, detail ?? ''),
    durationMs: collected.durationMs,
    exitCode: collected.exitCode,
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * Fold the pool's explanation into a result, for the rare call it let run alone.
 * @param outcome - the classified probe.
 * @param ticket - the lease, whose note is set only when this call did not share.
 * @returns the outcome to store, with the note appended to its detail.
 */
function withPoolNote(outcome: ProbeOutcome, ticket: PoolTicket | undefined): ProbeOutcome {
  if (ticket?.note === undefined) return outcome
  const detail = outcome.detail === undefined ? ticket.note : `${outcome.detail}\n${ticket.note}`
  return { ...outcome, detail: detail.slice(0, DETAIL_LIMIT) }
}

/**
 * Fold the pool's explanation into a finished command, so a reader told the call
 * ran on its own connection can see why it did.
 * @param result - the classified run.
 * @param ticket - the lease, whose note is set only when this call did not share.
 * @returns the result to hand back.
 */
function withRunNote(result: RemoteRunResult, ticket: PoolTicket | undefined): RemoteRunResult {
  if (ticket?.note === undefined) return result
  const stderr = result.stderr === undefined ? ticket.note : `${result.stderr}\n${ticket.note}`
  return { ...result, stderr }
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
  /** Where the complete stdout went when the ceiling clipped it, if a spill survived. */
  stdoutSpillPath?: string
  /** Where the complete stderr went when the ceiling clipped it, if a spill survived. */
  stderrSpillPath?: string
  /** Why the provider could not run the child, when that is the outcome. */
  error?: string
}

/** Runs probes, remote commands, and transfers through `ctx.subprocess`. */
export class SshTransport {
  readonly #ctx: Context
  readonly #askpass: AskPassSource | undefined
  readonly #pool: MuxSource | undefined
  #inFlight = 0
  readonly #controllers = new Set<AbortController>()
  // The programs the plugin dials with, found on first use: no page names them
  // any more. Only a hit is cached, so installing openssh between calls takes
  // effect without a restart; a miss re-runs the search.
  #sshPath: string | undefined
  #scpPath: string | undefined

  /**
   * @param ctx - Host context that carries `subprocess`.
   * @param askpass - the helper that answers a password or passphrase prompt.
   * @param pool - the per-target connection pool, when this profile has one.
   */
  constructor(ctx: Context, askpass?: AskPassSource, pool?: MuxSource) {
    this.#ctx = ctx
    this.#askpass = askpass
    this.#pool = pool
  }

  /** How many children this transport has running right now. */
  get inFlight(): number {
    return this.#inFlight
  }

  /** How many servers are holding an open shared connection right now. */
  get liveMasters(): number {
    return this.#pool?.liveMasters ?? 0
  }

  /** Whether this Host can share connections at all, and why not when it cannot. */
  get mux(): { ready: boolean; failure?: string | undefined } {
    if (this.#pool === undefined) return { ready: false, failure: 'no pool was assembled for this profile' }
    return { ready: this.#pool.ready, ...(this.#pool.failure === undefined ? {} : { failure: this.#pool.failure }) }
  }

  /**
   * Lease a shared connection for one call.
   *
   * Every caller must hand the ticket back through {@link unshare} in a `finally`:
   * the pool counts calls in flight, and a leaked lease holds a slot that no
   * eviction can reclaim. A call that leases nothing still dials correctly,
   * because {@link sshOptions} defaults to disabling sharing.
   * @param target - the identity fields, including the stored target's id.
   * @param auth - the credential this call answers prompts with.
   * @returns the lease, or `undefined` when no pool is assembled.
   */
  share(target: RemoteTarget, auth: RemoteAuth): PoolTicket | undefined {
    return this.#pool?.claim(target, auth)
  }

  /**
   * Hand one lease back.
   * @param ticket - the lease to release; `undefined` is fine.
   */
  unshare(ticket: PoolTicket | undefined): void {
    ticket?.release()
  }

  /**
   * Settle one lease against how its call actually went.
   *
   * A call that got a session open proves the master is there. A call the server
   * refused a channel on, or that lost the connection mid-flight, proves the master
   * is not worth trusting again and the next call dials its own. Anything between —
   * a rejected credential, a host key nobody accepted — leaves the ledger alone,
   * because the release path already drops a master that never proved itself.
   *
   * Public because a caller that builds its own child — a transfer, for one — has
   * to settle the lease it holds the same way this class settles its own.
   * @param ticket - the lease the call held, pooled or not.
   * @param worked - whether this call reached an authenticated session.
   */
  noteShared(ticket: PoolTicket | undefined, worked: boolean): void {
    if (ticket === undefined || !ticket.pooled) return
    if (worked) {
      ticket.markLive()
      return
    }
    ticket.drop()
  }

  /**
   * Whether this output text says the shared connection itself gave out, which is a
   * different fault from the server refusing the call.
   *
   * Public for the same reason {@link noteShared} is: a caller that builds its own
   * child still has to read the same table.
   * @param text - the captured output of one finished call.
   * @returns `true` when a reader is looking at a multiplexing failure.
   */
  sessionBroken(text: string): boolean {
    return SESSION_SETUP_PATTERNS.some(pattern => pattern.test(text))
  }

  /**
   * Ask one master to hang up. Best-effort: a master that will not answer is
   * already gone, and its socket goes with the directory.
   * @param socketPath - the control socket naming the master.
   * @param authority - the `[user@]host` OpenSSH matches the socket to.
   * @returns resolution once the teardown child settled.
   */
  async exitMaster(socketPath: string, authority: string): Promise<void> {
    const program = await this.resolveSsh()
    if (program === undefined) return
    const controller = new AbortController()
    this.#controllers.add(controller)
    try {
      await this.#collect(
        program,
        ['-o', `ControlPath=${socketPath}`, '-o', 'ControlMaster=no', '-o', 'BatchMode=yes', '-O', 'exit', authority],
        CONTROL_SETTINGS,
        undefined,
        MASTER_EXIT_MS,
        controller,
      )
    } catch {
      // Nothing a reader could act on is waiting on this call.
    } finally {
      this.#controllers.delete(controller)
    }
  }

  /** Abort every child still running, for plugin teardown. */
  dispose(): void {
    for (const controller of this.#controllers) controller.abort()
    this.#controllers.clear()
    this.#sshPath = undefined
    this.#scpPath = undefined
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

  /** The first name of the candidates the provider can resolve, or `undefined`. */
  async #firstPresent(names: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
    for (const name of names) {
      const found = await this.resolveExecutable(name, signal)
      if (found !== undefined) return found
    }
    return undefined
  }

  /**
   * The ssh program to dial with, found on first use and then kept: the bare
   * name through `PATH` first, since that honours whatever openssh the account
   * actually prefers, then the usual absolute install locations.
   * @param signal - cancellation of the lookup.
   * @returns the resolved executable, or `undefined` when none of them exists.
   */
  async resolveSsh(signal?: AbortSignal): Promise<string | undefined> {
    if (this.#sshPath !== undefined) return this.#sshPath
    this.#sshPath = await this.#firstPresent([SSH_EXECUTABLE, ...SSH_FALLBACK_PATHS], signal)
    return this.#sshPath
  }

  /**
   * The scp to move bytes with, searched the same way. A resolved ssh's own
   * sibling wins, so a non-standard install keeps its two programs together;
   * otherwise the bare name and the usual locations are tried in order.
   * @param signal - cancellation of the lookup.
   * @returns the resolved executable, or `undefined` when none of them exists.
   */
  async resolveScp(signal?: AbortSignal): Promise<string | undefined> {
    if (this.#scpPath !== undefined) return this.#scpPath
    const ssh = await this.resolveSsh(signal)
    const sibling = ssh !== undefined && ssh.endsWith('/ssh') ? `${ssh.slice(0, -'/ssh'.length)}/scp` : undefined
    const names = sibling === undefined
      ? [SCP_EXECUTABLE, ...SCP_FALLBACK_PATHS]
      : [sibling, SCP_EXECUTABLE, ...SCP_FALLBACK_PATHS.filter(path => path !== sibling)]
    this.#scpPath = await this.#firstPresent(names, signal)
    return this.#scpPath
  }

  /**
   * Build the option flags and child environment one call needs.
   * @param program - the resolved executable, or the configured name when absent.
   * @param target - identity fields to connect with.
   * @param settings - shared ceilings and the probe/command deadline to derive from.
   * @param auth - the mode and any secret this call may answer with.
   * @param deadlineMs - the whole budget for this call, in milliseconds.
   * @param options - the port flag, and the pool flags this call leased (a call
   *   that leased none still has to be told not to share).
   * @returns the leading flags (through the host target), the environment, and
   *   whether a secret has to be answered.
   */
  sshOptions(
    target: RemoteTarget,
    settings: SshSettings,
    auth: RemoteAuth,
    deadlineMs: number,
    options: {
      readonly portFlag?: string | undefined
      readonly poolFlags?: readonly string[] | undefined
    } = {},
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
    // Sharing is opted into a call at a time, and the default has to be the safe
    // direction: `ControlPath=none` is what keeps a child from riding on a master
    // this plugin never leased — the Host account's own `~/.ssh/config` may well
    // name one, and a plugin that inherited it would be sharing a connection whose
    // credentials it cannot account for. These land before the target's own extra
    // arguments, so a reader who writes `-o ControlPath=…` there still wins.
    flags.push(...(options.poolFlags ?? NO_SHARE_FLAGS))
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
    if (this.#inFlight >= MAX_CONCURRENT_OPS) {
      throw new SshError('busy', `At most ${String(MAX_CONCURRENT_OPS)} remote operations may run at once.`, {
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
      // The provider keeps an in-memory tail per stream and, when asked, writes the
      // complete stream to a file whose path it hands back. `spill` is opt-in —
      // omitting it is what used to make "truncated" mean "the rest is gone" — so a
      // ceiling that clips a stream now costs a temp file instead of the answer.
      stdio: (() => {
        const collect = () => ({
          maxBytes: settings.maxOutputBytes,
          ...(settings.maxSpillBytes > 0 ? { spill: { maxBytes: settings.maxSpillBytes } } : {}),
        })
        return {
          stdin: stdin === undefined ? 'ignore' : { data: stdin },
          stdout: collect(),
          stderr: collect(),
        }
      })(),
      graceMs: settings.graceMs,
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
    // One fused deadline carries both this plugin's own timeout and the caller's
    // cancellation, so whichever fires first is the recorded cause: `AbortSignal.any`
    // adopts the reason of the first aborter, and `timeoutOf` reads our code only
    // when the timeout won. The hand-rolled version this replaces had to guess when
    // a child died in the same instant its timer fired, and a guessed `timeout` on a
    // call the reader had already cancelled sends them off to fix a server that was
    // answering normally.
    const d = deadline(external, deadlineMs, SSH_TIMEOUT)
    let settled: Settled
    try {
      settled = await new Promise<Settled>(resolve => {
        void handle.done
          .then(outcome => { resolve({ kind: 'exit', exitCode: outcome.exitCode, signal: outcome.signal }) })
          .catch((error: unknown) => {
            resolve({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
          })
        const onDeadline = (): void => {
          controller.abort()
          resolve(timeoutOf(d.signal, SSH_TIMEOUT) === undefined ? { kind: 'cancelled' } : { kind: 'timeout' })
        }
        if (d.signal.aborted) onDeadline()
        else d.signal.addEventListener('abort', onDeadline, { once: true })
      })
    } finally {
      d[Symbol.dispose]()
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
      ...(stdoutRead?.spillPath === undefined ? {} : { stdoutSpillPath: stdoutRead.spillPath }),
      ...(stderrRead?.spillPath === undefined ? {} : { stderrSpillPath: stderrRead.spillPath }),
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
   * Probe one target: connect and authenticate — `-N` on a shared connection, and
   * `true` on a call that is dialing its own.
   * @param target - the identity fields to connect with.
   * @param settings - the executable, deadline, and capture ceiling to honour.
   * @param auth - the mode and any secret this probe should answer with.
   * @returns the classified outcome; only a concurrency or secret-plumbing
   *   refusal throws.
   */
  async probe(target: RemoteTarget, settings: SshSettings, auth?: RemoteAuth): Promise<ProbeOutcome> {
    const controller = this.#takeLane('probe')
    const ticket = this.share(target, auth ?? {})
    try {
      const deadline = settings.probeTimeoutMs
      const { flags, env } = this.sshOptions(target, settings, auth ?? {}, deadline, { poolFlags: ticket?.flags })
      const program = await this.resolveSsh(controller.signal)
      if (program === undefined) {
        return {
          at: new Date().toISOString(),
          status: 'ssh-missing',
          durationMs: 0,
          detail: 'No ssh program was found: PATH and the usual install locations were tried.',
        }
      }
      const pooled = ticket?.pooled === true
      const collected = await this.#collect(program, probeArgvTail(flags, this.authority(target), pooled), settings, env, deadline, controller)
      const detail = tail(collected.stdout, collected.stderr)
      const outcome = classifyCollectedProbe(collected, detail)
      // A probe that reached `reachable` proved the session; one that never left
      // the network or the host key proved nothing, and the master goes back.
      this.noteShared(ticket, outcome.status === 'reachable' && !this.sessionBroken(detail ?? ''))
      return withPoolNote(outcome, ticket)
    } finally {
      this.unshare(ticket)
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
      const program = await this.resolveSsh(controller.signal)
      if (program === undefined) {
        return {
          outcome: 'error',
          error: 'No ssh program was found: PATH and the usual install locations were tried.',
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
      /**
       * Bytes written to the command's stdin before it closes. A backgrounded
       * command needs it for the same reason a foreground one does: an elevated
       * call injects the answer to a sudo or su prompt, and a command handed to the
       * registry mid-flight must have already been fed.
       */
      readonly stdin?: string | undefined
    } = {},
  ): Promise<RemoteJob | undefined> {
    const deadline = options.timeoutMs ?? settings.remoteTimeoutMs
    const controller = this.#takeLane('background command')
    const ticket = this.share(target, auth)
    const program = await this.resolveSsh(controller.signal)
    if (program === undefined) {
      this.unshare(ticket)
      this.#controllers.delete(controller)
      this.#inFlight -= 1
      return undefined
    }
    // The same option set a foreground call builds, so a backgrounded command
    // authenticates and trusts the host exactly like the probe for that target does.
    // Everything between here and the settle chain is guarded, because the option
    // builder can refuse (a secret with no askpass helper to answer with) and a
    // command that never started would otherwise leave an operation slot and a
    // master marked in use for as long as the process lives.
    let job: RemoteJob
    try {
      const { flags, env } = this.sshOptions(target, settings, auth, deadline, { poolFlags: ticket?.flags })
      const ttyFlags = options.tty === true ? ['-tt'] : []
      const startedAt = Date.now()
      const { handle, detach } = this.#spawn(program, [...flags, ...ttyFlags, this.authority(target), command], settings, env, controller, options.signal, options.stdin)
      // A backgrounded command holds its lease for its whole life, the same way it
      // holds an operation slot: the channel over the master is open until it ends.
      const finished = this.#settleAndDrain(handle, controller, deadline, options.signal, startedAt)
        .then((result: Collected) => {
          detach()
          this.noteShared(ticket, result.outcome === 'exit' && !this.sessionBroken(`${result.stderr}\n${result.stdout}`))
          return result
        })
        .catch((error: unknown) => {
          detach()
          this.noteShared(ticket, false)
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
          this.unshare(ticket)
          this.#controllers.delete(controller)
          this.#inFlight -= 1
        })
      job = {
        sources: streamSources(handle),
        kill: (): void => {
          controller.abort()
          handle.terminate()
        },
        finished,
      }
    } catch (error: unknown) {
      this.unshare(ticket)
      this.#controllers.delete(controller)
      this.#inFlight -= 1
      throw error
    }
    return job
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
    const deadline = options.timeoutMs ?? settings.remoteTimeoutMs
    const bounded: SshSettings = options.maxOutputBytes === undefined ? settings : { ...settings, maxOutputBytes: options.maxOutputBytes }
    const controller = this.#takeLane('remote command')
    const ticket = this.share(target, auth)
    try {
      const { flags, env } = this.sshOptions(target, bounded, auth, deadline, { poolFlags: ticket?.flags })
      const program = await this.resolveSsh(controller.signal)
      if (program === undefined) {
        return {
          at: new Date().toISOString(),
          status: 'ssh-missing',
          durationMs: 0,
          stderr: 'No ssh program was found: PATH and the usual install locations were tried.',
        }
      }
      // `-tt` must precede the destination, like every other ssh option. Two t's,
      // not one: a single `-t` defers to the local side having a terminal, which a
      // spawned child never does.
      const ttyFlags = options.tty === true ? ['-tt'] : []
      const collected = await this.#collect(program, [...flags, ...ttyFlags, this.authority(target), command], bounded, env, deadline, controller, options.signal, options.stdin)
      const text = `${collected.stdout}\n${collected.stderr}`
      const status: RemoteStatus = collected.outcome === 'cancelled'
        ? 'cancelled'
        : collected.outcome === 'timeout'
          ? 'timeout'
          : collected.outcome === 'error'
            ? 'failed'
            : classifyRun(collected.exitCode, text)
      // A command that ran, even badly, proved the connection is worth reusing. One
      // that timed out or came apart mid-stream did not, and the next call dials.
      this.noteShared(ticket, (status === 'succeeded' || status === 'exit-nonzero') && !this.sessionBroken(text))
      const result: RemoteRunResult = classifyCollectedRun(collected, {
        ...(options.tty === true ? { tty: true } : {}),
        ...(options.stdin === undefined ? {} : { stdinBytes: Buffer.byteLength(options.stdin, 'utf8') }),
      })
      return withRunNote(result, ticket)
    } finally {
      this.unshare(ticket)
      this.#controllers.delete(controller)
      this.#inFlight -= 1
    }
  }
}
