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
import { createReadStream, createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import type { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MAX_CONCURRENT_OPS, SCP_EXECUTABLE, SCP_FALLBACK_PATHS, SSH_EXECUTABLE, SSH_FALLBACK_PATHS } from './storage.ts'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

/**
 * The timeout code this module stamps on its own deadline, so `timeoutOf` can tell
 * a timeout of ours apart from a caller's cancellation even when both were fused
 * into one signal. The harness names this per capability (`BASH_TIMEOUT`); the
 * symmetry is the point.
 */
const SSH_TIMEOUT = 'SSH_TIMEOUT'

/** The local-only budget for one `ssh -G` print; see {@link SshTransport.resolve}. */
const RESOLVE_BUDGET_MS = 5_000
import { NO_SHARE_FLAGS, type MuxSource, type PoolTicket } from './pool.ts'
import { SpillBudget } from './spill.ts'
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
 * The race's own sentence, said by a client that asked to join a master and found
 * one already listening: OpenSSH downgrades the late caller to a connection of its
 * own and runs the call on it, *successfully*. The earlier table read that sentence
 * as a broken session, so one first-contact collision between two concurrent calls
 * evicted — with a real `ssh -O exit` — the perfectly healthy master that had just
 * won the race. The downgrade is not a fault; a stale socket that blocks a master
 * dial says it without the fallback phrase, and stays in the table below.
 */
const BENIGN_MULTIPLEX_FALLBACK = /ControlSocket\b[^\n]*already exists, disabling multiplexing/giu

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
 * The reservation kind one file copy counts against, and the name a refusal
 * quotes. Named once because three places have to agree on it: the copy that
 * asks for the slot, the ceiling that answers in words, and the getter that
 * reports how full the lane is.
 */
export const TRANSFER_LANE = 'file transfers'

/** The reservation kind one explicitly backgrounded command counts against. */
export const JOB_LANE = 'background jobs'

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
  // The transfer block has no bearing on a teardown child — it never copies
  // anything — but the type carries the fields, so they stand at their floor.
  transferTimeoutMs: MASTER_EXIT_MS,
  maxTransferFiles: 1,
  maxTransferTotalBytes: 1_024,
  maxConcurrentTransfers: 1,
  maxRunningJobs: 1,
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
 * Shape one remote path so the **remote shell** can open it.
 *
 * `~/x` is a documented path form (`remotePathSchema`, `storage.ts`), and a fully
 * quoted `'~/x'` is not the same word to a shell: a tilde-prefix runs only to the
 * first *unquoted* `/`, so quoting the whole path leaves a word that literally
 * begins with a tilde. Measured on a live server in `sh`, `bash`, and `dash`, for
 * a read and for a redirection alike:
 *
 * - `cat -- '~/f.txt'` → `No such file or directory` — the shape this plugin used
 * - `cat -- ~'/f.txt'` → the same failure, because the slash sits inside the quotes
 * - `cat -- ~/'f.txt'` → the file, and `cat > ~/'a b/f.txt'` writes one whose name
 *   has a space in it
 *
 * So the `~/` stays outside the quotes where the shell can see it, and everything
 * after it stays inside them. Absolute paths keep the single-quoted word they had.
 * @param value - the path as the caller named it, absolute or `~/`-rooted.
 * @returns one word the remote shell expands to exactly that path.
 */
export function remotePathArg(value: string): string {
  return value.startsWith('~/') ? `~/${shellQuote(value.slice(2))}` : shellQuote(value)
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
  const notes: string[] = []
  if (collected.spillNote !== undefined) notes.push(collected.spillNote)
  return {
    at: new Date().toISOString(),
    ...(notes.length === 0 ? {} : { notes }),
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
  /** The raw stdin of a child spawned with `stdin: 'pipe'`; absent otherwise. */
  stdin?: Writable | undefined
  /** The raw stdout of a child spawned with `stdout: 'pipe'`; absent otherwise. */
  stdout?: Readable | undefined
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
function streamSources(handle: ChildHandle, budget?: SpillBudget): RemoteJobSource[] {
  const source = (channel: 'stdout' | 'stderr'): RemoteJobSource => ({
    channel,
    read: (fromByte: number) => {
      const reader = handle.collected[channel]
      if (reader === undefined) return { text: '', nextOffset: fromByte, lossy: false }
      const read = reader.readFrom(fromByte)
      // A background command's output is pumped repeatedly, so the budget sees the
      // same path over and over; `SpillBudget.observe` counts each one once.
      if (budget !== undefined && read.spillPath !== undefined) {
        budget.observe([{ path: read.spillPath, bytes: read.nextOffset }])
      }
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
  /**
   * Set when this plugin's spill budget decided a stream would keep only its
   * in-memory tail. A reader told “truncated” without this is being told a fact
   * and hidden the reason.
   */
  spillNote?: string
}

/** How many bytes a streamed copy has moved, and what stopped it moving them. */
export interface PumpState {
  /** Bytes counted at the local end — written by a download, read by an upload. */
  bytes: number
  /** True when the copy was stopped by the ceiling rather than by an ending. */
  over: boolean
  /** True when the local side reached the end of what it meant to move. */
  ended: boolean
  /** Why the pump could not move the bytes, when that is the answer. */
  error?: string
}

/** What one streamed copy of a single file produced. */
export interface StreamedCopy {
  /**
   * `exit` means the child ran to an ending and the pump stopped with it;
   * `over-limit` means this plugin stopped a copy that was still moving bytes,
   * which no pre-check of a `stat` number can tell from a copy that finished.
   */
  outcome: 'exit' | 'timeout' | 'cancelled' | 'error' | 'over-limit'
  /** The child's exit code, `null` when it never produced one. */
  exitCode: number | null
  /** Bytes that crossed the local end before the copy stopped. */
  bytes: number
  /** Whatever the child said on stderr, for the failure explanation. */
  stderr: string
  /** Whatever the child said on stdout (an upload has none; a download has the payload). */
  stdout: string
  /** Milliseconds from the start of the wait to the settled answer. */
  durationMs: number
  /** Why the provider or the pump failed outright, when that is the outcome. */
  error?: string
}

/** The face of one child a stream copy drives. */
export interface StreamCopy {
  /** Which way the bytes move, which decides which channel is raw. */
  direction: 'download' | 'upload'
  /** Absolute local path: written by a download, read by an upload. */
  localPath: string
  /** Hard ceiling on the bytes that may move, in bytes. */
  maxBytes: number
}

/** How long one non-piped face of a streamed copy keeps in memory: an explanation, not a payload. */
const STREAM_DETAIL_BYTES = 8_192

/**
 * Stop waiting once this signal is done, so a deadline can end a race that the
 * child and the pump are otherwise holding open.
 * @param signal - the fused deadline/cancellation signal.
 * @returns a promise that resolves on the first abort and never before.
 */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => {
      resolve()
    }, { once: true })
  })
}

/**
 * Wait for one writable to take more, treating its death as an answer.
 *
 * A child whose channel closed is not an error this plugin should invent: the
 * exit code and the child's own stderr already say what happened, and a pump that
 * kept feeding a dead pipe would only read the whole local file for nothing.
 * @param stream - the writable that refused the last chunk.
 * @returns `true` when it asked for more, `false` when it died instead.
 */
function drained(stream: Writable): Promise<boolean> {
  return new Promise(resolve => {
    const stop = (value: boolean): void => {
      stream.removeListener('drain', onDrain)
      stream.removeListener('error', onDeath)
      stream.removeListener('close', onDeath)
      resolve(value)
    }
    const onDrain = (): void => stop(true)
    const onDeath = (): void => stop(false)
    stream.once('drain', onDrain)
    stream.once('error', onDeath)
    stream.once('close', onDeath)
  })
}

/**
 * Close the write side of one stream and wait for the bytes it holds.
 *
 * A download's part file is not finished until the last buffered byte is with the
 * operating system, and a rename that beat that answer would move a short file
 * into place and call it a copy. A write side that was already destroyed — a
 * child the server closed, a sink that errored — never reports `finish`, so both
 * of its endings are answers here, and only one of them counts as delivered.
 * @param stream - the writable to end.
 * @returns `true` when it flushed, `false` when it failed or was already gone.
 */
function ended(stream: Writable): Promise<boolean> {
  return new Promise(resolve => {
    if (stream.destroyed) {
      resolve(false)
      return
    }
    stream.once('finish', () => {
      resolve(true)
    })
    stream.once('error', () => {
      resolve(false)
    })
    stream.once('close', () => {
      resolve(false)
    })
    stream.end()
  })
}

/**
 * The provider's own `EPIPE` phrasing, and the one Node uses once the stream is
 * already destroyed — both mean the far end stopped listening.
 * @param error - the failure the pump was handed.
 * @returns true when no more bytes could move, for a reason the child explains.
 */
function channelGone(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : ''
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END'
}

/** Runs probes, remote commands, and transfers through `ctx.subprocess`. */
export class SshTransport {
  readonly #ctx: Context
  readonly #askpass: AskPassSource | undefined
  readonly #pool: MuxSource | undefined
  readonly #spill: SpillBudget
  #inFlight = 0
  readonly #controllers = new Set<AbortController>()
  // Slots counted per reservation kind (file transfers for now, background jobs
  // next). The global ceiling bounds how many children exist at all; a kind
  // ceiling is what keeps two large copies from holding every slot a command
  // could have had, without anyone writing a second scheduler.
  readonly #lanesByKind = new Map<string, number>()
  // The programs the plugin dials with, found on first use: no page names them
  // any more. Only a hit is cached, so installing openssh between calls takes
  // effect without a restart; a miss re-runs the search.
  #sshPath: string | undefined
  #scpPath: string | undefined

  /**
   * @param ctx - Host context that carries `subprocess`.
   * @param askpass - the helper that answers a password or passphrase prompt.
   * @param pool - the per-target connection pool, when this profile has one.
   * @param spill - this process's spill budget; a profile that assembles its own
   *   transport can share one budget across them, and the shipped assembly does.
   */
  constructor(ctx: Context, askpass?: AskPassSource, pool?: MuxSource, spill?: SpillBudget) {
    this.#ctx = ctx
    this.#askpass = askpass
    this.#pool = pool
    this.#spill = spill ?? new SpillBudget()
  }

  /** What this process has asked the provider to keep on disk, and what it refused. */
  get spill (): { used: number; files: number; refusals: number; max: number } {
    return { used: this.#spill.used, files: this.#spill.files, refusals: this.#spill.refusals, max: this.#spill.max }
  }

  /** How many children this transport has running right now. */
  get inFlight(): number {
    return this.#inFlight
  }

  /** How many servers are holding an open shared connection right now. */
  get liveMasters(): number {
    return this.#pool?.liveMasters ?? 0
  }

  /**
   * How many children of one reservation kind are holding a slot right now.
   *
   * The ceiling is only worth having if a reader can see it being reached: the
   * settings card, the `get_connection` payload, and a real-host check all ask
   * “how many copies are moving at this moment”, and until now the only answer
   * this class could give was the count of *all* children.
   * @param kind - the reservation name the calls asked for, e.g. {@link JOB_LANE}.
   * @returns how many of them are in flight.
   */
  laneUsage(kind: string): number {
    return this.#lanesByKind.get(kind) ?? 0
  }

  /** How many single-file or tree copies are holding a transfer slot right now. */
  get transfersInFlight(): number {
    return this.laneUsage(TRANSFER_LANE)
  }

  /**
   * Whether one reservation still has room, asked without taking anything.
   *
   * The caller that owns a *job* needs this before it registers: the registry
   * hands back an id the moment it is told to start, and a start that the lane
   * then refuses arrives as a finished job the reader never saw running — a
   * `started` that turns into `failed` in the next frame, which is a strange thing
   * to tell a model that is deciding whether to poll. Asking first costs one
   * comparison, and the reservation it is checking is still made the ordinary way.
   * @param lane - the kind and the ceiling the call will ask against.
   * @returns true when a child started now would be admitted.
   */
  laneRoom(lane: { readonly kind: string; readonly cap: number }): boolean {
    if (this.#inFlight >= MAX_CONCURRENT_OPS) return false
    return (this.#lanesByKind.get(lane.kind) ?? 0) < lane.cap
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
    // The benign concurrent-dial downgrade is edited out before the table runs;
    // everything else — including `already exists` *without* the fallback phrase,
    // which is a stale socket — still reads as the fault it is.
    return SESSION_SETUP_PATTERNS.some(pattern => pattern.test(text.replace(BENIGN_MULTIPLEX_FALLBACK, '')))
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
    // A named identity comes with its authentication order pinned: without
    // `IdentitiesOnly`, an ssh-agent holding several keys tries them *first* and
    // a server with the usual three-attempt limit locks the caller out before the
    // named key is ever offered (`too many authentication failures` is in the
    // classification table for exactly that reason). The flag only lands when the
    // reader named a key themselves — omit it and the client's own defaults,
    // agent included, stay in charge. `extraArgs` lands after these, so a target
    // that wants the old behavior can still write `-o IdentitiesOnly=no`.
    if (target.identityFile !== undefined) flags.push('-i', target.identityFile, '-o', 'IdentitiesOnly=yes')
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
   * @param lane - an optional reservation against a per-kind ceiling (transfers
   *   hold far fewer slots than the global ceiling allows, so a long copy can
   *   never starve every command); the kind name is what a refusal quotes back.
   * @returns the controller to hand to the child, already registered.
   */
  #takeLane(label: string, lane?: { readonly kind: string; readonly cap: number }): AbortController {
    if (this.#inFlight >= MAX_CONCURRENT_OPS) {
      throw new SshError('busy', `At most ${String(MAX_CONCURRENT_OPS)} remote operations may run at once.`, {
        hint: `Wait for the running ${label} to finish.`,
      })
    }
    if (lane !== undefined) {
      const used = this.#lanesByKind.get(lane.kind) ?? 0
      if (used >= lane.cap) {
        throw new SshError('busy', `At most ${String(lane.cap)} ${lane.kind} may run at once, and all ${String(lane.cap)} slots are taken.`, {
          hint: 'Wait for one to finish (it also frees room for other calls), stop a job with `job_kill`, or raise the ceiling in the plugin\u2019s configuration.',
        })
      }
      this.#lanesByKind.set(lane.kind, used + 1)
    }
    this.#inFlight += 1
    const controller = new AbortController()
    this.#controllers.add(controller)
    return controller
  }

  /**
   * Give back one lane a taken slot occupied, in the single order the taker expects.
   * @param controller - the controller {@link #takeLane} handed out.
   * @param lane - the same reservation, when there was one.
   */
  #releaseLane(controller: AbortController, lane?: { readonly kind: string; readonly cap: number }): void {
    this.#controllers.delete(controller)
    this.#inFlight -= 1
    if (lane !== undefined) {
      const used = this.#lanesByKind.get(lane.kind) ?? 0
      if (used <= 1) this.#lanesByKind.delete(lane.kind)
      else this.#lanesByKind.set(lane.kind, used - 1)
    }
  }

  /**
   * Start one child through the provider and wire the cancellation edges.
   * @param program - the resolved executable.
   * @param argvTail - the arguments after the executable.
   * @param settings - the output ceiling the provider retains to.
   * @param env - extra environment entries, when a secret has to be answered.
   * @param controller - the lane controller this child is bound to.
   * @param external - the caller's own signal, which outranks the deadline.
   * @param stdin - text fed to the child, or nothing when stdin stays closed.
   * @param stream - which face of the child this call drives as a raw byte
   *   channel: `download` takes stdout, `upload` feeds stdin. A stream copy asks
   *   the provider for no spill on either face, because its payload is a file on
   *   disk and its transcript is only ever an explanation.
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
    stream?: 'download' | 'upload',
  ): { handle: ChildHandle; detach: () => void; spillNote: string | undefined } {
    // The budget is consulted per child, at the moment the child is assembled, so
    // a profile that raised `maxSpillBytes` is still held to one whole-process
    // number rather than to sixteen times its own ceiling.
    const grant = this.#spill.ask(stream === undefined ? settings.maxSpillBytes : 0)
    const handle = this.#ctx.subprocess.spawn({
      argv: [program, ...argvTail],
      cwd: process.env.HOME ?? process.cwd(),
      // The provider keeps an in-memory tail per stream and, when asked, writes the
      // complete stream to a file whose path it hands back. `spill` is opt-in —
      // omitting it is what used to make "truncated" mean "the rest is gone" — so a
      // ceiling that clips a stream now costs a temp file instead of the answer.
      stdio: (() => {
        if (stream !== undefined) {
          // Exactly one raw channel, one small explanation, and nothing spilled:
          // a copy that moved 400 MiB should not also have written 400 MiB of
          // transcript into the provider's spill file to say so.
          return stream === 'download'
            ? { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: STREAM_DETAIL_BYTES } }
            : { stdin: 'pipe', stdout: { maxBytes: STREAM_DETAIL_BYTES }, stderr: { maxBytes: STREAM_DETAIL_BYTES } }
        }
        const collect = () => ({
          maxBytes: settings.maxOutputBytes,
          ...(grant.maxBytes > 0 ? { spill: { maxBytes: grant.maxBytes } } : {}),
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
    return { handle, spillNote: grant.note, detach: () => { external?.removeEventListener('abort', onExternalAbort) } }
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
    spillNote?: string,
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
    // The provider reports a spill path only for a stream it wrote whole, so the
    // whole-stream offset it hands back with it is the number to charge the
    // budget — no `stat` of a directory this plugin does not own.
    this.#spill.observe([
      { path: stdoutRead?.spillPath, bytes: stdoutRead?.nextOffset ?? 0 },
      { path: stderrRead?.spillPath, bytes: stderrRead?.nextOffset ?? 0 },
    ])
    return {
      ...(spillNote === undefined ? {} : { spillNote }),
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
    const { handle, detach, spillNote } = this.#spawn(program, argvTail, settings, env, controller, external, stdin)
    try {
      return await this.#settleAndDrain(handle, controller, deadlineMs, external, startedAt, spillNote)
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
    lane?: { readonly kind: string; readonly cap: number },
  ): Promise<Collected> {
    const controller = this.#takeLane(label, lane)
    try {
      return await this.#collect(program, argvTail, settings, env, deadlineMs, controller, external)
    } finally {
      this.#releaseLane(controller, lane)
    }
  }

  /**
   * Move one file's bytes through one `ssh` child, counting them as they move.
   *
   * A ceiling that only reads a `stat` number before the copy starts is a
   * statement about the past: a file that grows while it is being carried has
   * already passed the number by the time anybody notices. Here the count is taken
   * at the local end — the bytes a download wrote into its part file, the bytes an
   * upload read out of the source — and the moment the next chunk would cross the
   * ceiling the pump stops, the child is taken down through the same managed range
   * every other child uses, and `over-limit` is the answer. Nothing about the
   * destination is touched by a copy that never finished: a download leaves its
   * part file to the caller's cleanup, and an upload never gets to its publish step.
   * @param program - the resolved ssh executable.
   * @param argvTail - the option flags, the authority, and the remote command.
   * @param settings - the ceilings, the grace, and the option budget.
   * @param env - the askpass entries, when a secret has to be answered.
   * @param deadlineMs - the whole budget for the copy.
   * @param label - what is running, for the concurrency refusal.
   * @param copy - which way, to or from which local path, under what ceiling.
   * @param external - the caller's own cancellation.
   * @param lane - the per-kind ceiling the copy occupies a slot against.
   * @returns the settled copy, with the byte count it stopped at.
   */
  async streamFile(
    program: string,
    argvTail: readonly string[],
    settings: SshSettings,
    env: NodeJS.ProcessEnv | undefined,
    deadlineMs: number,
    label: string,
    copy: StreamCopy,
    external?: AbortSignal,
    lane?: { readonly kind: string; readonly cap: number },
  ): Promise<StreamedCopy> {
    const controller = this.#takeLane(label, lane)
    const startedAt = Date.now()
    const state: PumpState = { bytes: 0, over: false, ended: false }
    try {
      const { handle, detach } = this.#spawn(program, argvTail, settings, env, controller, external, undefined, copy.direction)
      const d = deadline(external, deadlineMs, SSH_TIMEOUT)
      // The pump and the child are waited on as one story: `#pump` never throws,
      // so whichever ends first is an answer rather than an exception, and the
      // other is still settled — with a bounded drain — before any byte count,
      // exit code, or stderr tail is read.
      const pumping = this.#pump(handle, copy, state)
      let child: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined
      let spawnFailure: string | undefined
      const watching = handle.done
        .then(outcome => {
          child = outcome
        })
        .catch((error: unknown) => {
          spawnFailure = error instanceof Error ? error.message : String(error)
        })
      let fired: 'timeout' | 'cancelled' | undefined
      try {
        const first = await Promise.race([
          pumping.then(() => 'pump' as const),
          watching.then(() => 'child' as const),
          aborted(d.signal).then(() => 'deadline' as const),
        ])
        if (first === 'deadline') {
          fired = timeoutOf(d.signal, SSH_TIMEOUT) === undefined ? 'cancelled' : 'timeout'
        }
        if (state.over === true || fired !== undefined || state.ended === false) {
          // A copy stopped by its ceiling, by the clock, or by a local end that
          // gave out all leave a `cat` with somewhere to write to and nobody
          // reading: end the range, and let the drain flush the pipes the way
          // every other interrupted child's does. Against a child that already
          // exited on its own the call is a no-op, which is why an unfinished
          // *pump* is allowed to ask for it.
          controller.abort()
          handle.terminate()
        }
        // Both halves still have to come in before an exit code or a byte count is
        // quoted, and neither is allowed to outlive a deadline that has already
        // fired — so each is raced against the signal. The wait for the process
        // range is then bounded by the kill grace the provider itself stages
        // TERM→KILL over, plus the short drain every collected child gets: for a
        // collected call the drain only has to make the answer readable, but for a
        // copy the channel closing is what stops the *server* writing, and the
        // caller's cleanup of a remote temp file is ordered behind that. Giving up
        // earlier would return a copy whose far half was still running.
        const drain = new AbortController()
        const drainMs = DRAIN_MS + settings.graceMs
        const drainTimer = setTimeout(() => { drain.abort() }, drainMs)
        try {
          await Promise.all([
            Promise.race([pumping, aborted(d.signal)]),
            Promise.race([watching, aborted(d.signal)]),
            handle.waitForExit(drain.signal).catch(() => false),
          ])
        } finally {
          clearTimeout(drainTimer)
        }
      } finally {
        detach()
        d[Symbol.dispose]()
      }
      // Only a copy that did not finish may be blamed on the clock: a deadline
      // that fires a beat after a completed copy is not a timeout, and calling it
      // one sends the reader off to fix a server that was answering normally.
      const unfinished = child === undefined || state.ended === false
      const stopped = unfinished && d.signal.aborted
        ? (timeoutOf(d.signal, SSH_TIMEOUT) === undefined ? 'cancelled' : 'timeout')
        : undefined
      if (child === undefined && spawnFailure === undefined && state.over === false && stopped === undefined) {
        // Neither the child nor the pump came back inside the drain: the copy is
        // over, but nothing here can honestly quote an exit status.
        spawnFailure = 'The ssh child did not settle before its pipes were given up on.'
      }
      const stdoutRead = handle.collected.stdout?.readFrom(0)
      const stderrRead = handle.collected.stderr?.readFrom(0)
      const outcome: StreamedCopy['outcome'] = state.over
        ? 'over-limit'
        : stopped === 'cancelled'
          ? 'cancelled'
          : stopped === 'timeout'
            ? 'timeout'
            : spawnFailure !== undefined
              ? 'error'
              : state.error !== undefined && state.ended === false
                ? 'error'
                : 'exit'
      return {
        outcome,
        exitCode: child?.exitCode ?? null,
        bytes: state.bytes,
        stdout: stdoutRead?.text ?? '',
        stderr: stderrRead?.text ?? '',
        durationMs: Date.now() - startedAt,
        ...(spawnFailure === undefined && state.error === undefined ? {} : { error: spawnFailure ?? state.error }),
      }
    } finally {
      this.#releaseLane(controller, lane)
    }
  }

  /**
   * Push one file through one raw channel and stop it at the ceiling.
   *
   * Never throws: every failure lands in {@link PumpState} so the caller's race
   * has one vocabulary. A write side that died — an `ssh` the server closed, a
   * disk that filled — ends the pump instead of letting it read a whole local file
   * into a channel nobody is holding, and the child's own exit status is what then
   * explains the copy.
   * @param handle - the spawned child, with one raw face.
   * @param copy - which way, which local path, and the ceiling.
   * @param state - the running count this pump owns.
   * @returns resolution once the bytes stopped moving, for any reason.
   */
  async #pump(handle: ChildHandle, copy: StreamCopy, state: PumpState): Promise<void> {
    /** The byte length of one chunk, whoever produced it. */
    const size = (chunk: string | Buffer): number => typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length
    if (copy.direction === 'download') {
      const source = handle.stdout
      if (source === undefined) {
        state.error = 'The provider gave this copy no stdout to read.'
        return
      }
      const sink = createWriteStream(copy.localPath)
      // The sink's own failure — a disk that filled, a directory that is not
      // there — is the answer the reader needs, so it is kept rather than being
      // swallowed by the no-op listener that only exists to stop an unhandled
      // 'error' from ending the process.
      let sinkFailure: string | undefined
      sink.on('error', (error: Error) => {
        sinkFailure = error.message
      })
      let whole = true
      try {
        for await (const chunk of source) {
          const bytes = size(chunk as string | Buffer)
          if (state.bytes + bytes > copy.maxBytes) {
            // The chunk that crossed the line is not delivered: the count this
            // copy quotes is the bytes that arrived *and were accounted for*, and
            // the refusal says the ceiling was passed rather than padding the
            // number with a chunk the ceiling refused.
            state.over = true
            whole = false
            break
          }
          state.bytes += bytes
          if (!sink.write(chunk as Buffer) && !(await drained(sink))) {
            state.error = `The local file ${copy.localPath} could not be written to${sinkFailure === undefined ? '' : `: ${sinkFailure}`}.`
            whole = false
            break
          }
        }
      } catch (error: unknown) {
        whole = false
        if (state.over === false) state.error = error instanceof Error ? error.message : String(error)
      }
      const flushed = await ended(sink)
      if (!flushed && state.error === undefined) {
        state.error = `The copy reached ${copy.localPath} but could not be flushed to disk${sinkFailure === undefined ? '' : `: ${sinkFailure}`}.`
      }
      // `readableEnded` is the difference between a server that ran out of file
      // and a channel this side stopped: a destroyed stream ends without it, and a
      // copy that was cut short must never be reported as a completed one.
      state.ended = whole && flushed && source.readableEnded === true
      return
    }
    const sink = handle.stdin
    if (sink === undefined) {
      state.error = 'The provider gave this copy no stdin to write.'
      return
    }
    sink.on('error', () => undefined)
    const source = createReadStream(copy.localPath)
    source.on('error', () => undefined)
    let whole = true
    try {
      for await (const chunk of source) {
        const bytes = size(chunk)
        if (state.bytes + bytes > copy.maxBytes) {
          state.over = true
          whole = false
          break
        }
        state.bytes += bytes
        if (!sink.write(chunk) && !(await drained(sink))) {
          whole = false
          break
        }
      }
    } catch (error: unknown) {
      whole = false
      if (!channelGone(error)) state.error = error instanceof Error ? error.message : String(error)
    }
    void source.destroy()
    if (state.over === true) {
      // The end of file is what tells the far side a body is complete, so a copy
      // stopped by its ceiling never sends one: the partial temp stays partial,
      // and the child goes down with its write still open.
      state.ended = false
      return
    }
    // An upload that carried everything it meant to carries an explicit end of
    // file, which is what lets the far side close its write and exit 0 — and
    // `readableEnded` is what says the local file was read to its end rather than
    // abandoned half way.
    const delivered = await ended(sink)
    if (state.error === undefined) {
      if (whole && source.readableEnded === true && delivered) state.ended = true
      else state.error = `The copy of ${copy.localPath} could not be delivered to the server.`
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
      this.#releaseLane(controller)
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
      // The `ssh -G` view has to carry the same flag the real children get, or the
      // resolve card would show a configuration drift that does not exist.
      if (target.identityFile !== undefined) flags.push('-i', target.identityFile, '-o', 'IdentitiesOnly=yes')
      if (target.proxyJump !== undefined) flags.push('-J', target.proxyJump)
      if (target.extraArgs !== undefined) flags.push(...target.extraArgs)
      // The five seconds here is not a caller-facing ceiling and deliberately does
      // not join the bounds layer: `ssh -G` dials nothing, so this is only the
      // patience of a local config print. A profile's command or transfer budget
      // has no bearing on it, and it has no claim on theirs.
      return await this.#collect(program, ['-G', ...flags, this.authority(target)], settings, undefined, RESOLVE_BUDGET_MS, controller)
    } finally {
      this.#releaseLane(controller)
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
      /**
       * True for a command started *as* a job (`background: true`), which holds its
       * slot indefinitely and so counts against `maxRunningJobs`; false for a
       * foreground call that may promote, which keeps the ordinary lane rules.
       */
      readonly job?: boolean | undefined
    } = {},
  ): Promise<RemoteJob | undefined> {
    const deadline = options.timeoutMs ?? settings.remoteTimeoutMs
    const lane = options.job === true ? { kind: JOB_LANE, cap: settings.maxRunningJobs } : undefined
    const controller = this.#takeLane('background command', lane)
    const ticket = this.share(target, auth)
    const program = await this.resolveSsh(controller.signal)
    if (program === undefined) {
      this.unshare(ticket)
      this.#releaseLane(controller, lane)
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
      const { handle, detach, spillNote } = this.#spawn(program, [...flags, ...ttyFlags, this.authority(target), command], settings, env, controller, options.signal, options.stdin)
      const budget = this.#spill
      // A backgrounded command holds its lease for its whole life, the same way it
      // holds an operation slot: the channel over the master is open until it ends.
      const finished = this.#settleAndDrain(handle, controller, deadline, options.signal, startedAt, spillNote)
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
          this.#releaseLane(controller, lane)
        })
      job = {
        sources: streamSources(handle, budget),
        kill: (): void => {
          controller.abort()
          handle.terminate()
        },
        finished,
      }
    } catch (error: unknown) {
      this.unshare(ticket)
      this.#releaseLane(controller, lane)
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
      this.#releaseLane(controller)
    }
  }
}
