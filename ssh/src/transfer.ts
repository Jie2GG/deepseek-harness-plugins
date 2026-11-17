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
 * Both directions are pre-checked before `scp` is asked to move anything:
 *
 * - **download**: the remote size and type via `stat`, and the copy lands in a
 *   `.dsh-part-<…>` sibling that is renamed into place only after a clean
 *   finish — a cancelled, timed out, or failed copy leaves no half file at the
 *   destination. The final path's own overwrite policy is decided by the caller
 *   (`ops.ts`), which owns the file pipeline's say on local writes.
 * - **upload**: the local file's existence, readability, and size; for a tree,
 *   the file count and cumulative bytes too, with a cycle-guarded walk that
 *   resolves each symlinked directory at most once; and the remote destination,
 *   which is left alone unless `overwrite` says otherwise.
 *
 * All of these are **pre-checks against what `stat` said at that moment**, not
 * gates on the bytes that move: a file that grows during a copy, or a tree that
 * gains entries after the walk, can still push more through than the numbers
 * quoted. `scp` itself is the hard limit there, and it has none.
 *
 * @module @jie2gg/dsh-plugin-ssh/transfer
 */

import { access, constants, lstat, opendir, realpath, rename, rm, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { shellQuote } from './transport.ts'
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
  /** Pre-check cap on the file count of one recursive upload. */
  maxFiles: number
  /** Pre-check cap on the cumulative bytes of one recursive upload. */
  maxTotalBytes: number
  /**
   * Whether the download's final path already exists, noticed by the caller.
   * Carried so a successful overwrite can report `overwrote: true` truthfully,
   * instead of claiming a replacement that never happened.
   */
  destinationExists?: boolean
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
  /** Files counted by the walk, for a recursive upload. */
  files?: number
  /** `file` or `directory`, when the far end could be stated. */
  kind?: string
  /** Seconds spent, including the pre-check. */
  durationMs: number
  /** Plain-language reason for a refusal or a failure. */
  message?: string
  /** Whether the destination already existed and was replaced. */
  overwrote?: boolean
}

/** One pre-check refusal: the status it maps to, and the words that explain it. */
interface LocalRefusal {
  readonly status: 'missing' | 'refused-size' | 'failed'
  readonly message: string
}

/** What a local pre-check learned before anything was asked to move. */
type LocalFacts =
  | { readonly ok: true; readonly bytes: number; readonly files: number; readonly kind: 'file' | 'directory' }
  | { readonly ok: false; readonly refusal: LocalRefusal }

/** The error code of an fs failure, or `''` when there is none. */
function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : ''
}

/** One child entry of {@link scanLocal}: measured, or refused with the reason. */
type EntryState = { bytes: number } | LocalRefusal

/**
 * State one remote path: its size and kind, or nothing when it does not exist.
 * @param transport - the shared transport.
 * @param target - where to look.
 * @param settings - ceilings and the executable.
 * @param auth - credentials to answer a prompt with.
 * @param path - the remote path.
 * @param signal - the transfer's own cancellation, so a cancel that arrives
 *   during the pre-check stops this child too, not just the copy.
 * @returns the size and type, or `undefined` when there is nothing there.
 */
export async function remoteStat(
  transport: SshTransport,
  target: RemoteTarget,
  settings: SshSettings,
  auth: RemoteAuth,
  path: string,
  signal?: AbortSignal,
): Promise<{ bytes: number; kind: string } | undefined> {
  const run = await transport.run(target, settings, auth, `stat -c '%s %F' -- ${shellQuote(path)}`, {
    // The pre-check keeps its own budget (`statTimeoutMs`, ten seconds by
    // default), separate from the probe's: it asks for one file's metadata, so a
    // server that has gone quiet should stall a copy, not stall it for as long as
    // a connectivity test is willing to wait.
    timeoutMs: settings.statTimeoutMs,
    ...(signal === undefined ? {} : { signal }),
  })
  if (run.status === 'cancelled') throw new Error('The transfer was cancelled before it started.')
  if (run.status !== 'succeeded') return undefined
  const match = /^(\d+)\s+(.+)$/u.exec((run.stdout ?? '').trim())
  if (match === null) return undefined
  return { bytes: Number(match[1]), kind: (match[2] ?? '').toLowerCase() }
}

/**
 * Measure one local path the way `scp` would carry it, against the ceilings,
 * before anything is put on the wire.
 *
 * A plain file must exist, be readable, and fit under `maxBytes`. A tree
 * (`recursive`) must additionally stay under `maxFiles` and `maxTotalBytes`;
 * every file in it must be readable and individually under `maxBytes`. Symlinks
 * are followed — one hop for files, cycle-guarded by realpath for directories —
 * because `scp` follows them too. Sockets, devices, and fifos are refused:
 * `scp` would either hang or copy nothing meaningful.
 * @param path - the local file or directory, already validated against the workspace.
 * @param maxBytes - the single-file ceiling.
 * @param maxFiles - the count ceiling, enforced for a tree.
 * @param maxTotalBytes - the cumulative ceiling, enforced for a tree.
 * @param recursive - whether a directory is allowed (and walked).
 * @returns the measured facts, or the refusal that explains them.
 */
export async function scanLocal(
  path: string,
  maxBytes: number,
  maxFiles: number,
  maxTotalBytes: number,
  recursive: boolean,
): Promise<LocalFacts> {
  /** Measure one path the way scp would see it: symlinks resolved to their target. */
  const measure = async (target: string): Promise<EntryState & { kind: string } | LocalRefusal> => {
    let st: Awaited<ReturnType<typeof stat>>
    try {
      st = await stat(target)
    } catch (error: unknown) {
      if (codeOf(error) === 'ENOENT') return { status: 'missing', message: `Nothing at ${target} to upload.` }
      return { status: 'failed', message: `${target} could not be stated: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (st.isDirectory()) return { bytes: 0, kind: 'directory' }
    if (st.isFile()) return { bytes: st.size, kind: 'file' }
    return { status: 'failed', message: `${target} is neither a regular file nor a directory; scp could not copy it.` }
  }
  /** Refuse unless this process can read the path. */
  const readable = async (target: string): Promise<LocalRefusal | undefined> => {
    try {
      await access(target, constants.R_OK)
      return undefined
    } catch {
      return { status: 'failed', message: `${target} could not be read: this process lacks permission.` }
    }
  }
  /** Count one file against the ceilings, or return what stopped the walk. */
  const count = (bytes: number, treeRoot: string): LocalRefusal | undefined => {
    if (bytes > maxBytes) {
      return { status: 'refused-size', message: `A file in the tree at ${treeRoot} is ${String(bytes)} bytes, over the ${String(maxBytes)} byte transfer ceiling.` }
    }
    files += 1
    total += bytes
    if (files > maxFiles) {
      return { status: 'refused-size', message: `The tree at ${treeRoot} holds more than ${String(maxFiles)} files; the upload ceiling stops at ${String(maxFiles)}.` }
    }
    if (total > maxTotalBytes) {
      return { status: 'refused-size', message: `The tree at ${treeRoot} adds up to more than ${String(maxTotalBytes)} bytes; raise the ceiling or copy less.` }
    }
    return undefined
  }

  let top: Awaited<ReturnType<typeof lstat>>
  try {
    top = await lstat(path)
  } catch (error: unknown) {
    if (codeOf(error) === 'ENOENT') return { ok: false, refusal: { status: 'missing', message: `Nothing at ${path} to upload.` } }
    return { ok: false, refusal: { status: 'failed', message: `${path} could not be stated: ${error instanceof Error ? error.message : String(error)}` } }
  }

  if (!top.isDirectory()) {
    // A file — or a symlink resolving to one. `scp` follows the link and moves
    // the target's bytes, so the measurement has to be the target's too.
    const stated = await measure(path)
    if ('status' in stated) return { ok: false, refusal: stated }
    if (stated.kind !== 'file') return { ok: false, refusal: { status: 'refused-size', message: `${path} is a directory; ask for it recursively.` } }
    const denied = await readable(path)
    if (denied !== undefined) return { ok: false, refusal: denied }
    if (stated.bytes > maxBytes) {
      return {
        ok: false,
        refusal: { status: 'refused-size', message: `${path} is ${String(stated.bytes)} bytes, over the ${String(maxBytes)} byte transfer ceiling.` },
      }
    }
    return { ok: true, bytes: stated.bytes, files: 1, kind: 'file' }
  }

  if (!recursive) {
    return { ok: false, refusal: { status: 'refused-size', message: `${path} is a directory; ask for it recursively.` } }
  }

  // The tree walk: bounded by the ceilings, cycle-guarded by realpaths. A
  // directory whose realpath was already visited is skipped, so a link loop is
  // walked once, not forever — the same tree reached twice would also charge its
  // bytes twice, which is what scp -r actually copies.
  let files = 0
  let total = 0
  const visited = new Set<string>()
  const queue: string[] = [path]
  let topReal: string
  try {
    topReal = await realpath(path)
  } catch {
    topReal = path
  }
  visited.add(topReal)
  while (queue.length > 0) {
    const directory = queue.shift() as string
    let handle: Awaited<ReturnType<typeof opendir>>
    try {
      handle = await opendir(directory)
    } catch (error: unknown) {
      return { ok: false, refusal: { status: 'failed', message: `${directory} could not be listed: ${error instanceof Error ? error.message : String(error)}` } }
    }
    let stopped: LocalRefusal | undefined
    // Read entry-by-entry rather than for-await: a refusal has to stop the walk
    // mid-stream, and this keeps that exit explicit.
    for (;;) {
      let entry: Dirent | null
      try {
        entry = await handle.read()
      } catch (error: unknown) {
        stopped = { status: 'failed', message: `${directory} could not be listed: ${error instanceof Error ? error.message : String(error)}` }
        break
      }
      if (entry === null) break
      if (entry.name === '.' || entry.name === '..') continue
      const child = join(directory, entry.name)
      if (entry.isDirectory()) {
        queue.push(child)
        continue
      }
      if (entry.isSymbolicLink()) {
        // Resolve one hop: a directory link joins the walk (cycle-guarded), a
        // file link is measured, anything else (broken link, device) is refused.
        const stated = await measure(child)
        if ('status' in stated) {
          stopped = stated
          break
        }
        if (stated.kind === 'directory') {
          let real: string
          try {
            real = await realpath(child)
          } catch {
            real = child
          }
          if (!visited.has(real)) {
            visited.add(real)
            queue.push(child)
          }
          continue
        }
        const denied = await readable(child)
        if (denied !== undefined) {
          stopped = denied
          break
        }
        const stoppedHere = count(stated.bytes, path)
        if (stoppedHere !== undefined) {
          stopped = stoppedHere
          break
        }
        continue
      }
      if (!entry.isFile()) {
        stopped = { status: 'failed', message: `${child} is neither a regular file nor a directory; scp could not copy it.` }
        break
      }
      const denied = await readable(child)
      if (denied !== undefined) {
        stopped = denied
        break
      }
      const stated = await measure(child)
      if ('status' in stated) {
        stopped = stated
        break
      }
      if (stated.kind !== 'file') {
        stopped = { status: 'failed', message: `${child} is neither a regular file nor a directory; scp could not copy it.` }
        break
      }
      const stoppedHere = count(stated.bytes, path)
      if (stoppedHere !== undefined) {
        stopped = stoppedHere
        break
      }
    }
    await handle.close().catch(() => undefined)
    if (stopped !== undefined) return { ok: false, refusal: stopped }
  }
  return { ok: true, bytes: total, files, kind: 'directory' }
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
  const refuse = (refusal: LocalRefusal): TransferOutcome => ({
    status: refusal.status,
    durationMs: Date.now() - startedAt,
    message: refusal.message,
    overwrote: false,
  })
  /**
   * One remote pre-check, with the caller's cancellation already folded in: a
   * cancel that lands while the `stat` is in flight is an outcome, not an
   * exception, so every path out of this module speaks the same vocabulary.
   */
  const statRemote = async (): Promise<{ bytes: number; kind: string } | undefined> => {
    try {
      return await remoteStat(transport, target, settings, auth, request.remotePath, request.signal)
    } catch (error: unknown) {
      if (request.signal?.aborted === true) return undefined
      throw error
    }
  }
  const cancelledOutcome = (): TransferOutcome => ({
    status: 'failed',
    durationMs: Date.now() - startedAt,
    message: 'The transfer was cancelled before it started.',
    overwrote: false,
  })
  // A function, not a property read: `aborted` flips while this body is parked
  // at an await, and a direct comparison past the first check would be a
  // narrowing TS would (correctly) call impossible.
  const stopped = (): boolean => request.signal?.aborted === true

  // The measured payload, when a pre-check produced one: the only byte count
  // either direction can honestly report is a stated one, since `scp -q` moves
  // bytes without telling anybody how many.
  let knownBytes: number | undefined
  let knownFiles: number | undefined
  let overwrote = false

  if (request.direction === 'upload') {
    // Local side first: existence, readability, and the size ceilings — for a
    // tree as well as for one file, so `recursive` cannot walk around them.
    const local = await scanLocal(request.localPath, request.maxBytes, request.maxFiles, request.maxTotalBytes, request.recursive === true)
    if (!local.ok) return refuse(local.refusal)
    if (stopped()) return cancelledOutcome()
    knownBytes = request.recursive === true ? local.bytes : (local.kind === 'file' ? local.bytes : undefined)
    knownFiles = request.recursive === true ? local.files : undefined
    // Remote side second: `scp` replaces what is there without a word, so the
    // destination is asked about before it is touched — the same guard `write`
    // makes with exit 17, stated here before bytes move instead of after.
    const stated = await statRemote()
    if (stopped()) return cancelledOutcome()
    if (stated !== undefined) {
      if (request.overwrite !== true) {
        return {
          status: 'refused-exists',
          durationMs: Date.now() - startedAt,
          message: `${request.remotePath} already exists on ${target.host} (${stated.kind}); pass overwrite to replace it.`,
          overwrote: false,
          ...(stated.kind.includes('directory') ? { kind: 'directory' } : {}),
        }
      }
      overwrote = true
    }
  } else {
    // A pre-check beats discovering an oversized copy at the end: the destination
    // is untouched when the copy has not started. The stated size is also the
    // only byte count a download can report, so it is kept for the success path.
    if (request.recursive !== true) {
      const stated = await statRemote()
      if (stopped()) return cancelledOutcome()
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
      knownBytes = stated.bytes
    }
    overwrote = request.destinationExists === true && request.overwrite === true
  }

  const program = await transport.resolveScp(request.signal)
  if (program === undefined) {
    return { status: 'failed', durationMs: Date.now() - startedAt, message: 'No scp program was found: PATH and the usual install locations were tried.' }
  }
  // scp identifies the far end by the `host:path` form of an argument, in both
  // directions: a download that passed the bare remote path copied from the local
  // filesystem instead, and reported the server's path as a missing local file.
  const authority = transport.authority(target)
  const remote = `${authority}:${request.remotePath}`
  // A download never writes the final path directly: the bytes land in a
  // uniquely-named sibling — pid plus entropy, because two conversations may
  // pull the same remote file into the same directory at the same moment — and
  // are renamed into place only after a clean finish, so a killed, timed out,
  // or failed copy leaves neither a half file nor a wrecked one.
  const partPath = request.direction === 'download'
    ? join(dirname(request.localPath), `${basename(request.localPath)}.dsh-part-${process.pid.toString(36)}-${randomBytes(3).toString('hex')}`)
    : undefined
  const src = request.direction === 'upload' ? request.localPath : remote
  const dst = partPath ?? remote
  const abandon = async (): Promise<void> => {
    if (partPath === undefined) return
    // recursive because a finished tree download is a directory, and a partial
    // one is a directory with partial children inside; force because most paths
    // here never created it at all (scp died before opening the destination).
    await rm(partPath, { force: true, recursive: request.recursive === true }).catch(() => undefined)
  }
  // scp takes -P for the port and -q to keep the transcript quiet; the ssh-side
  // defaults (accept-new, BatchMode, the askpass environment) come from the same
  // builder so a transfer authenticates exactly like the probe for that target.
  // The lease is held across the whole copy: a transfer is one long channel over
  // the master rather than a second connection, and the pool counts it as in use
  // until the bytes have moved.
  const ticket = transport.share(target, auth)
  try {
    const { flags, env } = transport.sshOptions(target, settings, auth, request.timeoutMs, {
      portFlag: '-P',
      poolFlags: ticket?.flags,
    })
    const argvTail = ['-q', ...flags, ...(request.recursive === true ? ['-r'] : []), src, dst]
    const collected = await transport.execute(
      program,
      argvTail,
      settings,
      env,
      request.timeoutMs,
      'file transfer',
      request.signal,
      { kind: 'file transfer', cap: settings.maxConcurrentTransfers },
    )
    const text = `${collected.stderr}\n${collected.stdout}`
    // A copy that ended — even one that ended over a missing file — proved the
    // connection. One that timed out, or said the session itself gave out, did not.
    transport.noteShared(ticket, collected.outcome === 'exit' && !transport.sessionBroken(text))
    if (collected.outcome === 'timeout') {
      await abandon()
      return { status: 'failed', durationMs: collected.durationMs, message: 'The transfer ran out of its deadline.', overwrote: false }
    }
    if (collected.outcome === 'cancelled') {
      await abandon()
      return { status: 'failed', durationMs: collected.durationMs, message: 'The transfer was cancelled; the destination was left as it was.', overwrote: false }
    }
    if (collected.outcome !== 'exit' || (collected.exitCode ?? 0) !== 0) {
      await abandon()
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
    if (partPath !== undefined) {
      // Same-directory rename: one filesystem, POSIX-atomic for a reader who
      // opens the destination afterwards. A rename that fails (a destination
      // directory that is not empty, a read-only mount) is reported as the
      // failure it is — never as a completed download.
      try {
        await rename(partPath, request.localPath)
      } catch (error: unknown) {
        await abandon()
        const existed = codeOf(error) === 'ENOTDIR' || codeOf(error) === 'EEXIST' || codeOf(error) === 'EISDIR'
        return {
          status: existed ? 'refused-exists' : 'failed',
          durationMs: Date.now() - startedAt,
          message: existed
            ? `The copy finished, but ${request.localPath} appeared as a destination scp cannot replace in one step; pass overwrite and try again.`
            : `The copy finished but could not replace ${request.localPath}: ${error instanceof Error ? error.message : String(error)}`,
          overwrote: false,
        }
      }
    }
    return {
      status: 'moved',
      durationMs: Date.now() - startedAt,
      overwrote,
      ...(knownBytes === undefined ? {} : { bytes: knownBytes }),
      ...(knownFiles === undefined ? {} : { files: knownFiles }),
      ...(request.recursive === true ? { kind: 'directory' } : {}),
    }
  } finally {
    // Whatever happened between `share` and here — a throw from the option
    // builder, a rename failure, a refusal from the lane ceiling — the ticket
    // comes back exactly once, and every failure path above already abandoned
    // its partial file. No path reaches a returned outcome with the temp left
    // behind.
    transport.unshare(ticket)
  }
}
