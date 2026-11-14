/**
 * File transfer between this machine and a stored target, over the same OpenSSH
 * transport the probes and commands use.
 *
 * `scp` is the worker: it is present wherever `ssh` is, it speaks the same host
 * key and credential rules, and it takes the remote end as one `host:path`
 * argument, so no local shell is ever involved and a path never needs quoting at
 * the argument level. Directories go through `scp -r`. `rsync` is deliberately
 * not assumed — the machine this plugin runs on has no rsync installed.
 *
 * @module @jie2gg/dsh-plugin-ssh/transfer
 */

import { shellQuote } from './transport.ts'
import { PROBE_TIMEOUT_MS } from './storage.ts'
import type { AskPassSource, RemoteAuth, RemoteTarget, SshTransport } from './transport.ts'
import type { SshSettings } from './types.ts'

/** One transfer request. */
export interface TransferRequest {
  /** Which way the bytes move. */
  direction: 'upload' | 'download'
  /** Absolute path on this machine, already validated against the workspace. */
  localPath: string
  /** Absolute path on the server, or one starting with `~/`. */
  remotePath: string
  /** Move a directory rather than one file. */
  recursive?: boolean
  /** Replace what already exists at the destination. */
  overwrite?: boolean
  /** Ceiling to refuse an oversized payload, in bytes. */
  maxBytes: number
  /** Whole budget for the copy, in milliseconds. */
  timeoutMs: number
  /** Caller cancellation. */
  signal?: AbortSignal | undefined
}

/** What a completed or refused transfer reports. */
export interface TransferOutcome {
  /** `moved`, `refused-size`, `refused-exists`, `missing`, or the classified failure. */
  status: 'moved' | 'refused-size' | 'refused-exists' | 'missing' | 'failed'
  /** Bytes reported by the size check, when one ran. */
  bytes?: number
  /** `file` or `directory`, when the remote end could be stated. */
  kind?: string
  /** Seconds spent, including the pre-check. */
  durationMs: number
  /** Plain-language reason for a refusal or a failure. */
  message?: string
  /** Whether the destination already existed and was replaced. */
  overwrote?: boolean
}

/**
 * State one remote path: its size and kind, or nothing when it does not exist.
 * @param transport - the shared transport.
 * @param target - where to look.
 * @param settings - ceilings and the executable.
 * @param auth - credentials to answer a prompt with.
 * @param path - the remote path.
 * @returns the size and type, or `undefined` when there is nothing there.
 */
export async function remoteStat(
  transport: SshTransport,
  target: RemoteTarget,
  settings: SshSettings,
  auth: RemoteAuth,
  path: string,
): Promise<{ bytes: number; kind: string } | undefined> {
  const run = await transport.run(target, settings, auth, `stat -c '%s %F' -- ${shellQuote(path)}`, {
    timeoutMs: PROBE_TIMEOUT_MS,
  })
  if (run.status !== 'succeeded') return undefined
  const match = /^(\d+)\s+(.+)$/u.exec((run.stdout ?? '').trim())
  if (match === null) return undefined
  return { bytes: Number(match[1]), kind: (match[2] ?? '').toLowerCase() }
}

/**
 * Move one file or directory with `scp`.
 * @param transport - the shared transport, which owns the executable lookup and
 *   the concurrency lanes.
 * @param askpass - the helper face, needed because scp prompts the same way.
 * @param target - the server end.
 * @param settings - the shared ceilings and deadline defaults.
 * @param auth - the credentials for this target.
 * @param request - what to move, and the limits to honour.
 * @returns the outcome of the attempt.
 */
export async function transfer(
  transport: SshTransport,
  askpass: AskPassSource,
  target: RemoteTarget,
  settings: SshSettings,
  auth: RemoteAuth,
  request: TransferRequest,
): Promise<TransferOutcome> {
  const startedAt = Date.now()
  // scp identifies the far end by the `host:path` form of an argument, in both
  // directions: a download that passed the bare remote path copied from the local
  // filesystem instead, and reported the server's path as a missing local file.
  const authority = `${target.user === undefined || target.user === '' ? '' : `${target.user}@`}${target.host}`
  const remote = `${authority}:${request.remotePath}`
  const src = request.direction === 'upload' ? request.localPath : remote
  const dst = request.direction === 'upload' ? remote : request.localPath

  // A pre-check beats discovering an oversized copy at the end: the destination
  // is untouched when the copy has not started. The stated size is also the only
  // byte count a download can report, so it is kept for the success path.
  let knownBytes: number | undefined
  if (request.recursive !== true) {
    const stated = request.direction === 'download'
      ? await remoteStat(transport, target, settings, auth, request.remotePath)
      : undefined
    if (stated !== undefined) knownBytes = stated.bytes
    if (request.direction === 'download') {
      if (stated === undefined) {
        return { status: 'missing', durationMs: Date.now() - startedAt, message: `Nothing at ${request.remotePath} on ${target.host}.` }
      }
      if (stated.kind.includes('directory')) {
        return { status: 'refused-size', bytes: stated.bytes, kind: stated.kind, durationMs: Date.now() - startedAt, message: `${request.remotePath} is a directory; ask for it recursively.`, overwrote: false }
      }
      if (stated.bytes > request.maxBytes) {
        return {
          status: 'refused-size',
          bytes: stated.bytes,
          kind: stated.kind,
          durationMs: Date.now() - startedAt,
          message: `That file is ${String(stated.bytes)} bytes, over the ${String(request.maxBytes)} byte transfer ceiling.`,
          overwrote: false,
        }
      }
    }
  }

  const program = await transport.resolveScp(request.signal)
  if (program === undefined) {
    return { status: 'failed', durationMs: Date.now() - startedAt, message: 'No scp program was found: PATH and the usual install locations were tried.' }
  }
  // scp takes -P for the port and -q to keep the transcript quiet; the ssh-side
  // defaults (accept-new, BatchMode, the askpass environment) come from the same
  // builder so a transfer authenticates exactly like the probe for that target.
  const { flags, env } = transport.sshOptions(target, settings, auth, request.timeoutMs, { portFlag: '-P' })
  const argvTail = ['-q', ...flags, ...(request.recursive === true ? ['-r'] : []), src, dst]
  const collected = await transport.execute(program, argvTail, settings, env, request.timeoutMs, 'file transfer', request.signal)
  if (collected.outcome === 'timeout') {
    return { status: 'failed', durationMs: collected.durationMs, message: 'The transfer ran out of its deadline.', overwrote: false }
  }
  if (collected.outcome !== 'exit' || (collected.exitCode ?? 0) !== 0) {
    const text = `${collected.stderr}\n${collected.stdout}`
    if (/no such file|not found|no such directory|permission denied.*stat/iu.test(text) && request.direction === 'upload') {
      return { status: 'missing', durationMs: collected.durationMs, message: `The local file ${request.localPath} could not be read, or the remote directory does not exist.`, overwrote: false }
    }
    return {
      status: 'failed',
      durationMs: collected.durationMs,
      message: text.trim() === '' ? `scp exited with ${String(collected.exitCode ?? 'signal')}.` : text.trim().slice(0, 512),
      overwrote: false,
    }
  }
  return {
    status: 'moved',
    durationMs: Date.now() - startedAt,
    overwrote: request.overwrite === true,
    ...(knownBytes === undefined ? {} : { bytes: knownBytes }),
    ...(request.recursive === true ? { kind: 'directory' } : {}),
  }
}
