/**
 * File transfer between this machine and a stored target, over the same OpenSSH
 * transport the probes and commands use.
 *
 * **One file rides a raw `ssh` channel.** The far end is `cat`, the near end is
 * this process's own byte counter, and the ceiling is applied to *the bytes that
 * move* — not to a number `stat` quoted before they started. That distinction is
 * the whole reason this module does not hand every copy to `scp`: a file that
 * grows while it is being carried has already passed the pre-checked number by
 * the time anybody notices, and `scp` moves bytes without telling anybody how
 * many. Here the count is a fact either way, and a copy that crosses the ceiling
 * is stopped: the pump ends, the child is taken down through the managed range,
 * and the destination is never opened.
 *
 * **A directory still rides `scp -r`**, because that is the tool present wherever
 * `ssh` is, and because its layout is the one callers expect: `dest` becomes the
 * tree when it does not exist yet, and holds `dest/<basename>` when it does. Its
 * ceilings are **pre-checks** in both directions — the cycle-guarded local walk
 * for an upload, a `find`-and-sum enumeration for a download — and the outcome
 * says so with `limitMode: 'pre-check'` while a single file says
 * `limitMode: 'in-flight'`. `rsync` is deliberately not assumed (this machine has
 * no rsync), and neither is `tar`: a tree carried through an archive would
 * quietly change what a symlink means on the way.
 *
 * Both directions are also guarded where they land:
 *
 * - **download**: the bytes land in a uniquely-named `.dsh-part-<…>` sibling and
 *   are renamed into place only after a clean finish, so a copy that was
 *   cancelled, timed out, refused by the ceiling, or died halfway leaves no half
 *   file at the destination. A recursive copy into an existing **non-empty**
 *   directory is refused before anything moves: that rename can only fail, and it
 *   used to fail after taking the finished tree with it.
 * - **upload**: the local file's existence, readability, and size are checked, a
 *   tree's file count and cumulative bytes with it, and the remote destination is
 *   asked about before it is touched. The bytes land in a sibling the final name
 *   is built from, and only then move into place: onto an existing file *through*
 *   it, so the inode, owner, mode, and hardlinks survive the overwrite exactly as
 *   `scp` left them (measured on a live server: inode and `640` kept, and a
 *   second link to the same inode seeing the new content), and onto a fresh name
 *   by rename, with the source's permission bits re-applied through the server's
 *   umask — which is what `scp` produced, and what drops the executable bit off a
 *   uploaded script if nobody thinks about it.
 *
 * @module @jie2gg/dsh-plugin-ssh/transfer
 */

import { access, constants, lstat, opendir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { remotePathArg, shellQuote, TRANSFER_LANE } from './transport.ts'
import type { RemoteAuth, RemoteTarget, SshTransport } from './transport.ts'
import { SshError } from './types.ts'
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
  /**
   * Ceiling one file may reach, in bytes. For a single-file copy this is enforced
   * against the bytes as they move; for a tree it is the per-file ceiling the
   * pre-check measures against.
   */
  maxBytes: number
  /** Pre-check cap on the file count of one recursive transfer. */
  maxFiles: number
  /** Pre-check cap on the cumulative bytes of one recursive transfer. */
  maxTotalBytes: number
  /**
   * Whether the download's final path already exists, noticed by the caller.
   * Carried so a successful overwrite can report `overwrote: true` truthfully
   * instead of claiming a replacement that never happened, and so a recursive
   * copy into a directory that is already occupied can be refused before the
   * bytes move rather than after.
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
  /**
   * Bytes this transfer can account for: the ones that crossed the local end for
   * a single file, the ones the pre-check measured for a tree that went through,
   * or the ones counted when a copy was stopped for being too big.
   */
  bytes?: number
  /** Files counted by the walk or the enumeration, for a recursive transfer. */
  files?: number
  /** `file` or `directory`, when the far end could be stated. */
  kind?: string
  /** Seconds spent, including the pre-check. */
  durationMs: number
  /** Plain-language reason for a refusal or a failure. */
  message?: string
  /** The next step the refusal itself knows how to suggest, e.g. a full lane. */
  hint?: string
  /** Whether the destination already existed and was replaced. */
  overwrote?: boolean
  /**
   * Which kind of ceiling the copy was held to, stated because the two are not the
   * same promise: `in-flight` means the bytes that moved were counted and stopped
   * at the line, `pre-check` means what a `stat` or a walk said before they moved.
   */
  limitMode: 'in-flight' | 'pre-check'
  /**
   * Objective sentences about what this outcome does and does not guarantee —
   * the tree that was not enumerated, the numbers that came from a pre-check, the
   * server-side copy a stopped upload left behind to clean up.
   */
  notes?: readonly string[]
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

/** What one remote enumeration answered about a path. */
export interface RemoteFacts {
  /** `tree` for a directory, `file` for one file, `missing` for nothing, `unknown` for a server this command cannot ask. */
  kind: 'tree' | 'file' | 'missing' | 'unknown'
  /** Bytes, as the enumeration or the `stat` reported them. */
  bytes: number
  /** Files, counted for a tree and pinned to 1 for one file. */
  files: number
}

/** The error code of an fs failure, or `''` when there is none. */
function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : ''
}

/** The message of any failure, in the one shape every refusal here quotes. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Split one remote path into the directory it sits in and the name it has, so a
 * sibling temp file can be built without string games at the call sites.
 * @param path - the path as the caller named it, absolute or `~/`-rooted.
 * @returns the parent, in the form that still expands (`~` for a home-relative
 *   path, `/` for a root child), and the final segment.
 */
export function remoteParts(path: string): { parent: string; base: string } {
  const clean = path.length > 1 ? path.replace(/\/+$/u, '') : path
  const cut = clean.lastIndexOf('/')
  if (cut === 0) return { parent: '/', base: clean.slice(1) }
  if (cut < 0) return { parent: '', base: clean }
  // `~/x` keeps its `~` as the parent so the sibling built from it still starts
  // with `~/`, which is the only form `remotePathArg` knows how to expand.
  return { parent: cut === 1 && clean.startsWith('~') ? '~' : clean.slice(0, cut), base: clean.slice(cut + 1) }
}

/**
 * Suffix that makes one temp name this process's own: its id in base 36 plus four
 * bytes of entropy, because two conversations may pull the same remote file into
 * the same directory at the same moment.
 *
 * The same token doubles as a copy's **task identity** on the server (K-4), which
 * is why it is wider than a temp name alone would need: nothing may be killed on
 * the strength of a tag that two live copies could share, and four bytes make a
 * collision inside one Host process a one-in-four-billion event rather than a
 * one-in-sixteen-million one. It stays `[a-z0-9-]` on purpose: that shape cannot
 * be mistaken for a shell or a regex metacharacter wherever it is embedded.
 * @returns the middle of a temp name, and the identity of one copy.
 */
function entropy(): string {
  return `${process.pid.toString(36)}-${randomBytes(4).toString('hex')}`
}

/**
 * Measure one remote path: its size and kind, or nothing when it is not there.
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
  const run = await transport.run(target, settings, auth, `stat -c '%s %F' -- ${remotePathArg(path)}`, {
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
 * Count one remote path the way `scp -r` would carry it: files, and their bytes
 * added up.
 *
 * A tree's ceilings have to be measured somewhere before the bytes move, and this
 * is the one round trip that does it: `find -L` follows the same symlinks `scp`
 * follows, `-printf '%s\n'` prints one size per file, and `awk` adds them. The
 * probe in front is what keeps a server without GNU `find` honest — `-printf` is
 * not a POSIX predicate, and a `find` that ignores an unknown one quietly reports
 * an empty tree, which reads exactly like a directory with nothing in it. That
 * answer arrives as `unknown`, and the caller says out loud that the tree was not
 * pre-checked instead of pretending the zeroes were.
 * @param transport - the shared transport.
 * @param target - where to look.
 * @param settings - the pre-check deadline and the ssh options.
 * @param auth - credentials to answer a prompt with.
 * @param path - the remote file or directory.
 * @param signal - the transfer's own cancellation.
 * @returns what the tree holds, or `unknown` when the server cannot be asked.
 */
export async function remoteTree(
  transport: SshTransport,
  target: RemoteTarget,
  settings: SshSettings,
  auth: RemoteAuth,
  path: string,
  signal?: AbortSignal,
): Promise<RemoteFacts> {
  const arg = remotePathArg(path)
  const command =
    `if [ ! -d ${arg} ]; then `
    + `if [ -f ${arg} ]; then printf 'ssh-plugin: 1 file %s\\n' "$(wc -c < ${arg} | tr -dc 0-9)"; exit 0; fi; `
    + `printf 'ssh-plugin: 0 missing 0\\n'; exit 20; fi; `
    + `if [ "$(find ${arg} -maxdepth 0 -type d -printf gnu 2>/dev/null)" != gnu ]; then printf 'ssh-plugin: 0 unknown 0\\n'; exit 0; fi; `
    + `find -L ${arg} -type f -printf '%s\\n' 2>/dev/null `
    + `| awk '{ n += 1; t += $1 } END { printf "ssh-plugin: %d tree %d\\n", n + 0, t + 0 }'`
  const run = await transport.run(target, settings, auth, command, {
    timeoutMs: settings.statTimeoutMs,
    ...(signal === undefined ? {} : { signal }),
  })
  if (run.status === 'cancelled') throw new Error('The transfer was cancelled before it started.')
  const match = /^ssh-plugin:\s+(\d+)\s+(tree|file|missing|unknown)\s+(\d+)$/u.exec((run.stdout ?? '').trim())
  if (match === null) return { kind: 'unknown', bytes: 0, files: 0 }
  const files = Number(match[1])
  const bytes = Number(match[3])
  if (!Number.isFinite(files) || !Number.isFinite(bytes)) return { kind: 'unknown', bytes: 0, files: 0 }
  return { kind: (match[2] ?? 'unknown') as RemoteFacts['kind'], bytes, files }
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
      return { status: 'failed', message: `${target} could not be stated: ${messageOf(error)}` }
    }
    if (st.isDirectory()) return { bytes: 0, kind: 'directory' }
    if (st.isFile()) return { bytes: st.size, kind: 'file' }
    return { status: 'failed', message: `${target} is neither a regular file nor a directory, and neither a copy nor a channel can carry it.` }
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
    return { ok: false, refusal: { status: 'failed', message: `${path} could not be stated: ${messageOf(error)}` } }
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
      return { ok: false, refusal: { status: 'failed', message: `${directory} could not be listed: ${messageOf(error)}` } }
    }
    let stopped: LocalRefusal | undefined
    // Read entry-by-entry rather than for-await: a refusal has to stop the walk
    // mid-stream, and this keeps that exit explicit.
    for (;;) {
      let entry: Dirent | null
      try {
        entry = await handle.read()
      } catch (error: unknown) {
        stopped = { status: 'failed', message: `${directory} could not be listed: ${messageOf(error)}` }
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
        stopped = { status: 'failed', message: `${child} is neither a regular file nor a directory, and neither a copy nor a channel can carry it.` }
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
        stopped = { status: 'failed', message: `${child} is neither a regular file nor a directory, and neither a copy nor a channel can carry it.` }
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

/** One entry of a local tree, counted or refused. */
type EntryState = { bytes: number } | LocalRefusal

/**
 * Move one file through an `ssh` channel, counting the bytes that cross the local
 * end, and put them in place only once all of them have arrived.
 * @param transport - the shared transport, which owns the executable lookup, the
 *   concurrency lanes, and the channel itself.
 * @param target - the server end.
 * @param settings - the shared ceilings and the transfer deadline.
 * @param auth - the credentials for this target.
 * @param request - what to move, and the limits to honour.
 * @param program - the resolved ssh executable.
 * @param startedAt - the millisecond the pre-checks began, so the duration quotes
 *   the whole call rather than the copy alone.
 * @param known - the byte and file counts a pre-check produced, if any.
 * @param overwrote - whether the destination existed and was allowed to be replaced.
 * @param notes - the sentences accumulated before the copy started.
 * @returns the outcome of the attempt.
 */
async function copyStream(
  transport: SshTransport,
  target: RemoteTarget,
  settings: SshSettings,
  auth: RemoteAuth,
  request: TransferRequest,
  program: string,
  startedAt: number,
  known: { bytes?: number; files?: number },
  overwrote: boolean,
  notes: string[],
): Promise<TransferOutcome> {
  /** The sibling a stopped copy leaves behind, in whichever filesystem it lives in. */
  const tag = entropy()
  const parts = remoteParts(request.remotePath)
  const localPart = request.direction === 'download'
    ? join(dirname(request.localPath), `${basename(request.localPath)}.dsh-part-${tag}`)
    : undefined
  const remotePart = request.direction === 'upload'
    ? `${parts.parent === '/' ? '' : parts.parent}/${parts.base}.dsh-part-${tag}`
    : undefined
  // The permission bits to carry onto a fresh destination — the same ones `scp`
  // carried, read after a symlink was followed, because a link's own `777` is not
  // the mode of the file it points at.
  const sourceStat = request.direction === 'upload'
    ? await stat(request.localPath).catch(() => undefined)
    : undefined
  const sourceMode = sourceStat === undefined ? undefined : sourceStat.mode & 0o7777
  // The sink is the part path for a download and the source path for an upload:
  // either way, the number the ceiling is checked against is counted here, at the
  // end of the channel this process controls.
  const sinkPath = request.direction === 'download' ? (localPart as string) : request.localPath
  const destArg = remotePathArg(request.remotePath)
  // A download announces its mover and then becomes it (K-4), so the pid the
  // cleanup has to aim at is a number this copy learned from its own channel. An
  // upload's stream mover needs no announcement: it reads the channel, so it dies
  // on the EOF the teardown sends. The upload's stranded mover is the **publish**
  // step, and that one is framed where it is built.
  const command = request.direction === 'download'
    ? downloadMoverCommand(destArg, tag)
    : `cat > ${remotePathArg(remotePart as string)}`
  /** Take back the partial sink, in whichever filesystem it was written to. */
  const abandon = async (): Promise<void> => {
    if (localPart !== undefined) {
      await rm(localPart, { force: true }).catch(() => undefined)
      return
    }
    if (remotePart !== undefined) {
      // A stopped upload has to ask the server to forget it. This child is
      // best-effort by design: a copy that failed because the link died may not be
      // able to open another one, and a leftover temp is a smaller lie than a
      // refusal that turned into a timeout.
      try {
        await transport.run(target, settings, auth, `rm -f -- ${remotePathArg(remotePart)}`, {
          timeoutMs: settings.statTimeoutMs,
        })
      } catch {
        notes.push(`The stopped copy left a temp file at ${remotePart} that this call could not remove.`)
      }
    }
  }
  const lease = transport.share(target, auth)
  try {
    const { flags, env } = transport.sshOptions(target, settings, auth, request.timeoutMs, {
      poolFlags: lease?.flags,
    })
    const copy = await transport.streamFile(
      program,
      [...flags, transport.authority(target), command],
      settings,
      env,
      request.timeoutMs,
      'file transfer',
      { direction: request.direction, localPath: sinkPath, maxBytes: request.maxBytes },
      request.signal,
      { kind: TRANSFER_LANE, cap: settings.maxConcurrentTransfers },
    )
    // This plugin's own mover marker travels on stderr so a cleanup can name the
    // process it is allowed to touch. Everywhere the channel's output is read as an
    // *explanation* — a classification, or the sentence a failure quotes back — the
    // marker is edited out first: a pid is not a reason.
    const copyDetail = stripMoverMarker(copy.stderr)
    const text = `${copyDetail}\n${copy.stdout}`
    // A copy that ran to an ending proved the connection; one stopped by its
    // ceiling, by the clock, or by the reader did not, and the master goes back.
    transport.noteShared(lease, copy.outcome === 'exit' && (copy.exitCode ?? 0) === 0 && !transport.sessionBroken(text))
    // A copy stopped short can leave a mover stranded on the server. Only a
    // **download** does this in a way the local teardown cannot reach: its mover
    // parks in a fifo with no writer without ever touching the channel, so closing
    // that channel signals it nothing (K-4). Upload stream movers read the channel
    // and die on EOF, and never get this far with a stranded child. The cleanup is
    // best-effort and bounded, and its note is appended only when it had something
    // to say — including the case where there is no pid to aim at, which is said
    // out loud rather than passed over as though the server had been tidied.
    const mover = moverPid(copy.stderr, tag)
    const reapDownload = async (): Promise<string | undefined> => {
      if (request.direction !== 'download') return undefined
      if (mover === undefined) return moverPidMissingNote(copy.outcome, copy.bytes, request.remotePath)
      return await reapStoppedMover(transport, target, settings, auth, mover, destArg, request.remotePath)
    }
    if (copy.outcome === 'over-limit') {
      await abandon()
      const reap = await reapDownload()
      const stated = known.bytes
      const grew = stated !== undefined && copy.bytes > stated
      return {
        status: 'refused-size',
        bytes: copy.bytes,
        ...(stated === undefined ? {} : { kind: 'file' }),
        durationMs: Date.now() - startedAt,
        limitMode: 'in-flight',
        message: request.direction === 'download'
          ? `${request.remotePath} crossed the ${String(request.maxBytes)} byte ceiling while it was being carried: the copy stopped after ${String(copy.bytes)} bytes, with more where they came from${stated === undefined ? '' : ` — the file measured ${String(stated)} bytes when the copy started${grew ? ' and grew while it ran' : ''}`}. The destination was left as it was.`
          : `${request.localPath} crossed the ${String(request.maxBytes)} byte ceiling while it was being sent: the copy stopped after ${String(copy.bytes)} bytes, with more to send${stated === undefined ? '' : ` — it measured ${String(stated)} bytes at the pre-check${grew ? ' and grew after that' : ''}`}. Nothing was written on the server.`,
        overwrote: false,
        ...(reap === undefined ? {} : { notes: [...notes, reap] }),
      }
    }
    if (copy.outcome === 'timeout') {
      await abandon()
      const reap = await reapDownload()
      return { status: 'failed', durationMs: copy.durationMs, message: 'The transfer ran out of its deadline.', overwrote: false, limitMode: 'in-flight', notes: [...notes, `The copy had moved ${String(copy.bytes)} bytes when the deadline took it down.`, ...(reap === undefined ? [] : [reap])] }
    }
    if (copy.outcome === 'cancelled') {
      await abandon()
      const reap = await reapDownload()
      return { status: 'failed', durationMs: copy.durationMs, message: 'The transfer was cancelled; the destination was left as it was.', overwrote: false, limitMode: 'in-flight', ...(reap === undefined ? { notes } : { notes: [...notes, reap] }) }
    }
    if (copy.outcome === 'error') {
      await abandon()
      const reap = await reapDownload()
      return {
        status: 'failed',
        durationMs: copy.durationMs,
        message: (copy.error ?? text.trim()).slice(0, 512),
        overwrote: false,
        limitMode: 'in-flight',
        ...(reap === undefined ? {} : { notes: [...notes, reap] }),
      }
    }
    if ((copy.exitCode ?? 0) !== 0) {
      await abandon()
      if (/no such file or directory/iu.test(text) && request.direction === 'upload') {
        return {
          status: 'missing',
          durationMs: copy.durationMs,
          message: `The local file ${request.localPath} could not be read, or the remote directory does not exist.`,
          overwrote: false,
          limitMode: 'in-flight',
          notes,
        }
      }
      if (/cannot open a directory|is a directory/iu.test(text) && request.direction === 'download') {
        return { status: 'refused-size', kind: 'directory', durationMs: copy.durationMs, message: `${request.remotePath} is a directory; ask for it recursively.`, overwrote: false, limitMode: 'in-flight', notes }
      }
      return {
        status: 'failed',
        durationMs: copy.durationMs,
        message: text.trim() === '' ? `The copy exited with ${String(copy.exitCode ?? 'signal')}.` : text.trim().slice(0, 512),
        overwrote: false,
        limitMode: 'in-flight',
        ...(copy.exitCode === null ? {} : { kind: 'file' }),
      }
    }
    if (request.direction === 'download') {
      // Same-directory rename: one filesystem, POSIX-atomic for a reader who
      // opens the destination afterwards. A rename that fails (a destination
      // directory that is not empty, a read-only mount) is reported as the
      // failure it is — never as a completed download.
      try {
        await rename(localPart as string, request.localPath)
      } catch (error: unknown) {
        await abandon()
        const existed = codeOf(error) === 'ENOTDIR' || codeOf(error) === 'EEXIST' || codeOf(error) === 'EISDIR'
        return {
          status: existed ? 'refused-exists' : 'failed',
          durationMs: Date.now() - startedAt,
          message: existed
            ? `The copy finished, but ${request.localPath} appeared as a destination this plugin cannot replace in one step; pass overwrite and try again.`
            : `The copy finished but could not replace ${request.localPath}: ${messageOf(error)}`,
          overwrote: false,
          limitMode: 'in-flight',
          notes,
        }
      }
      return {
        status: 'moved',
        durationMs: Date.now() - startedAt,
        overwrote,
        bytes: copy.bytes,
        ...(known.files === undefined ? {} : { files: known.files }),
        limitMode: 'in-flight',
        notes,
      }
    }
    // Publish: the whole payload is already on the server, so the last step is one
    // small remote command. Through an existing file it goes *in place* — that is
    // the shape `scp` had, and the one that keeps a hardlinked, `640`, owned file
    // the same file after the overwrite. For a fresh name it is a rename, and the
    // source's permission bits are re-applied the way the server would have
    // applied them to a new file.
    const published = await transport.run(target, settings, auth, publishCommand(remotePart as string, destArg, sourceMode, tag), {
      timeoutMs: Math.min(request.timeoutMs, PUBLISH_BUDGET_MS),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    if (published.status !== 'succeeded') {
      const why = stripMoverMarker(published.stderr ?? '').trim()
      // A publish that ran out of its own budget most often did so writing through
      // a fifo with no reader (K-4): the local ssh was taken down, but the server's
      // `cat -- part > dest` is blocked in a write the channel cannot interrupt, so
      // it lingers holding the part file. That branch reports its pid before it
      // blocks, so the cleanup has the same per-task handle a download gets — and
      // a branch that reported no pid had no mover to wait on, which is said rather
      // than passed off as a tidy server. This does not touch the part file itself:
      // the complete bytes are kept for the reader, exactly as the message says.
      const publishedMover = moverPid(published.stderr, tag)
      const reap = publishedMover === undefined
        ? 'the stuck publish never reported a mover pid, which says it was not writing through an existing destination — the rename branch has no mover that could stall: nothing was killed on the server.'
        : await reapStoppedMover(transport, target, settings, auth, publishedMover, remotePathArg(remotePart as string), remotePart as string)
      return {
        status: 'failed',
        durationMs: Date.now() - startedAt,
        message: `The copy reached ${target.host} but could not take its final place: ${why === '' ? `the server exited ${String(published.exitCode ?? 'signal')}` : why.slice(0, 400)}. The complete bytes are still at ${remotePart}.`,
        overwrote: false,
        limitMode: 'in-flight',
        notes: [...notes, `The published bytes are still at ${remotePart}; remove it once the destination is settled.`, ...(reap === undefined ? [] : [reap])],
      }
    }
    return {
      status: 'moved',
      durationMs: Date.now() - startedAt,
      overwrote,
      bytes: copy.bytes,
      ...(known.files === undefined ? {} : { files: known.files }),
      limitMode: 'in-flight',
      notes,
    }
  } finally {
    // Whatever happened between `share` and here — a throw from the option
    // builder, a rename failure, a refusal from the lane ceiling — the ticket
    // comes back exactly once, and every failure path above already abandoned
    // its partial file. No path reaches a returned outcome with the local temp
    // left behind; a server-side one is named in the notes when it survives.
    transport.unshare(lease)
  }
}

/** How long the publish step may take on its own: a server-side copy, no network. */
export const PUBLISH_BUDGET_MS = 120_000

/** How long one best-effort server-side cleanup command may take before it is given up on. */
const REAP_BUDGET_MS = 10_000

/** What the copy's own server-side mover is called with, as its first argument. */
const MOVER_PROGRAM = 'cat'

/**
 * The line a copy's server-side mover prints about itself, on **stderr**.
 *
 * `dsh-mover <pid> <tag>`. The pid is the process doing the moving, not the shell
 * that started it: a download ends its shell with `exec` so the two are the same
 * process, and a publish starts its mover as a background job and records *that*
 * job's pid. The tag is the copy's own task identity, echoed back so the near end
 * can prove the line came from the command it ran and not from something the
 * server printed on its own. It travels on stderr because stderr is a channel this
 * copy's parent already reads whole, whatever direction the bytes are moving, and
 * because stdout is the payload itself.
 */
const MOVER_MARKER = /^dsh-mover ([0-9]{1,7}) ([a-z0-9-]+)$/mu

/**
 * What one cleanup child says about the process it was pointed at.
 *
 * - `gone` — the recorded pid is no longer running: the mover noticed the channel
 *   close on its own, which is the healthy answer and gets no note.
 * - `killed` — the pid was running **and its recorded command line was this
 *   copy's mover**, and SIGKILL was delivered.
 * - `killed-unverified` — the pid was killed on the strength of the recorded number
 *   alone, because this server states no readable `/proc/<pid>/cmdline` (not Linux,
 *   or `/proc` mounted `hidepid`).
 * - `foreign` — the pid is running something that is not this copy's mover: either
 *   the mover already finished and the number was handed to another process, or the
 *   process has no command line to check (a zombie, a kernel thread). Nothing was
 *   touched, because killing an unrelated process is worse than a leftover mover.
 * - `refused` — the server would not let this user signal that pid.
 * - `unanswered` — the cleanup child itself never got an answer to read: the call
 *   timed out, the channel died, or the shell could not run the script.
 */
export type MoverVerdict = 'gone' | 'killed' | 'killed-unverified' | 'foreign' | 'refused' | 'unanswered'

/** The verdicts a cleanup child may print, and nothing else, counts as an answer. */
const REAP_VERDICT = /^dsh-reap (gone|killed|killed-unverified|foreign|refused)$/mu

/**
 * The one line {@link MOVER_MARKER} matches, as a command.
 * @param pidExpression - what to report: this shell's `$$`, or a background job's `$!`.
 * @param tag - this copy's task identity, echoed so the near end can bind the line.
 * @returns a `printf` that writes the marker to stderr and a `; ` to follow.
 */
function moverMarker (pidExpression: string, tag: string): string {
  return `printf 'dsh-mover %s %s\\n' ${pidExpression} ${shellQuote(tag)} >&2; `
}

/**
 * The remote command one download runs: announce the mover's pid, then **become**
 * the mover.
 *
 * `exec` is what makes the announcement true. sshd starts a shell for the command
 * line; `$$` is that shell, and `exec cat -- <path>` replaces it with the same
 * process, so the number printed and the number holding the file descriptor are
 * one number. Without `exec` the recorded pid would name a shell that is waiting,
 * and the stranded `cat` would be its child — the exact shape a path-matching
 * `pkill` was invented to work around, and the shape that could not tell two
 * concurrent copies of the same file apart (K-4).
 * @param destArg - the remote source, already shaped for the remote shell.
 * @param tag - this copy's task identity.
 * @returns one POSIX command whose stdout is the file.
 */
export function downloadMoverCommand (destArg: string, tag: string): string {
  return `${moverMarker('"$$"', tag)}exec ${MOVER_PROGRAM} -- ${destArg}`
}

/**
 * The first two arguments a mover this plugin started is seen with, in `/proc` form.
 *
 * `/proc` is only a fact if the expected shape is stated, so both ends of the check
 * are built here: these two fields, and the script in {@link reapMoverCommand} that
 * reads them back one per line. The third field is the path, and it comes from the
 * caller because it is the one thing the server may still expand (`~/x`).
 *
 * A `cat` pointed at the same path by a *different* task looks identical to this
 * check, which is why the check is run against **this task's recorded pid** and never
 * against a pattern searched across the whole process table.
 * @returns the program name and its `--`, in the order `tr '\\0' '\\n'` prints them.
 */
function moverArgvLines (): readonly [string, string] {
  return [MOVER_PROGRAM, '--']
}

/**
 * Take back, on the server, the mover an interrupted copy left stranded.
 *
 * Killing the **local** `ssh` child only guarantees the local half is gone. OpenSSH
 * without a pseudo-terminal does not signal a remote command that is parked in a
 * syscall it never completes against the channel — a `cat` blocked in `open()`/
 * `read()` on a fifo nobody is writing, or blocked in `write()` on a fifo nobody is
 * reading. Those writers of bytes exit when the channel closes (stdin EOF, stdout
 * SIGPIPE), but those two readers/writers of a *fifo* do not touch the channel at
 * all, so sshd lets them sit; on a live server they were seen outliving their calls
 * by eight to eleven hours.
 *
 * What gets killed is therefore **the pid this copy reported**, and the pid alone:
 * a `pkill -f` pattern built from a remote path cannot separate two copies of the
 * same file, because the path is the one thing they share, and a path is a regular
 * expression to `pkill -f` besides (`[`, `*`, `?`, `+` and `.` are all legal in a
 * remote path). This command needs no `pkill` and no `pgrep` either — `kill -0`,
 * `kill -9`, `tr` and `sed` are the whole toolkit, which is a wider set of servers
 * than 0.0.36 could clean at all.
 *
 * Before the signal, the target is identified from the inside out: `/proc/<pid>/cmdline`
 * is read one argument per line and compared, as plain strings, with the argv this
 * plugin handed that process (`cat`, `--`, and the path *the server's own shell*
 * expanded, which is why the path word is assigned to a variable rather than
 * quoted twice — `~/x` has to expand the same way it did for the mover). A pid
 * whose command line says something else is left alone and reported, because a
 * recycled number is not this copy's mover.
 * @param pid - the number the mover reported about itself.
 * @param pathWord - the remote path in the exact shell shape the mover was given.
 * @returns one POSIX command that answers with one `dsh-reap <verdict>` line.
 */
export function reapMoverCommand (pid: number, pathWord: string): string {
  const [program, dashdash] = moverArgvLines()
  return `P=${shellQuote(String(pid))}; p=${pathWord}; `
    + `if ! kill -0 "$P" 2>/dev/null; then echo 'dsh-reap gone'; exit 0; fi; `
    + `if [ ! -r /proc/"$P"/cmdline ]; then if kill -9 "$P" 2>/dev/null; then echo 'dsh-reap killed-unverified'; else echo 'dsh-reap refused'; fi; exit 0; fi; `
    + `a=$(tr '\\0' '\\n' < /proc/"$P"/cmdline 2>/dev/null); `
    + `if [ "$(printf '%s\\n' "$a" | sed -n 1p)" != ${shellQuote(program)} ] || [ "$(printf '%s\\n' "$a" | sed -n 2p)" != ${shellQuote(dashdash)} ] || [ "$(printf '%s\\n' "$a" | sed -n 3p)" != "$p" ]; then echo 'dsh-reap foreign'; exit 0; fi; `
    + `if kill -9 "$P" 2>/dev/null; then echo 'dsh-reap killed'; else echo 'dsh-reap refused'; fi`
}

/**
 * The pid a stopped copy's mover reported, when it reported one.
 * @param stderr - the stderr this copy collected from its own channel.
 * @param tag - the identity this copy wrote into the marker, which is what makes
 *   the line *this* copy's and not a stray line that happens to look like one.
 * @returns the mover's pid, or `undefined` when this copy never got one.
 */
export function moverPid (stderr: string | undefined, tag: string): number | undefined {
  const marker = MOVER_MARKER.exec(stderr ?? '')
  if (marker === null || marker[2] !== tag) return undefined
  const pid = Number(marker[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Remove this plugin's own mover marker from a copy's stderr.
 *
 * The stderr of a stopped copy is quoted back to the reader as the explanation, and
 * a line about a pid is not an explanation — it would sit in front of the server's
 * own sentence, and on a copy that produced nothing else it would *be* the sentence.
 * @param stderr - the raw stderr tail the channel carried.
 * @returns the same text with the marker line(s) dropped.
 */
export function stripMoverMarker (stderr: string | undefined): string {
  return (stderr ?? '').split('\n').filter(line => !MOVER_MARKER.test(line)).join('\n')
}

/**
 * Read the one verdict a cleanup child stated.
 * @param stdout - the raw stdout of the cleanup child.
 * @returns the verdict, or `unanswered` when the server said none of them.
 */
export function parseMoverVerdict (stdout: string | undefined): MoverVerdict {
  const verdict = REAP_VERDICT.exec(stdout ?? '')
  return verdict?.[1] === undefined ? 'unanswered' : verdict[1] as Exclude<MoverVerdict, 'unanswered'>
}

/**
 * Say what one cleanup attempt achieved, in the words the evidence supports.
 * @param verdict - what the server reported about the pid it was pointed at.
 * @param pid - the mover pid this copy had recorded.
 * @param path - the remote path, named so a reader knows which file is at stake.
 * @param host - the server, for the sentences that need one.
 * @returns a note to show the reader, or `undefined` when there is nothing to tell.
 * @throws never: a failed cleanup is a sentence, not a second failure.
 */
export function moverVerdictNote (
  verdict: MoverVerdict,
  pid: number,
  path: string,
  host: string,
): string | undefined {
  switch (verdict) {
    case 'gone':
      // The mover closed with the channel on its own. Silence is the honest answer:
      // 0.0.36 called this "matched nothing" and said nothing either.
      return undefined
    case 'killed':
      return `the interrupted copy ended its own server-side mover of ${path} (pid ${String(pid)}), confirmed from that pid's command line before the signal.`
    case 'killed-unverified':
      return `the interrupted copy ended its server-side mover of ${path} (pid ${String(pid)}); ${host} states no readable /proc entry for that pid, so the kill was taken on the recorded number alone.`
    case 'foreign':
      return `the pid this copy recorded as its mover of ${path} (pid ${String(pid)}) is now running something else, so nothing was killed: the mover had already gone, and an unrelated process holds that number.`
    case 'refused':
      return `the interrupted copy could not end its own server-side mover of ${path} (pid ${String(pid)}): ${host} refused the signal, so that mover may still be running.`
    case 'unanswered':
      return `the interrupted copy asked ${host} to end its own server-side mover of ${path} (pid ${String(pid)}) and got no answer, so this plugin cannot say whether that mover is gone.`
  }
}

/**
 * The note for a stopped copy that never learned its mover's pid.
 *
 * Two ways this happens, and they deserve different sentences. A copy whose channel
 * never carried a command (a connection that died, a credential the server refused)
 * has no mover and should stay quiet. A copy that moved bytes into a fifo and then
 * stopped *had* a mover, and the honest report is that this plugin cannot name it.
 * @param outcome - how the copy ended.
 * @param bytes - how many bytes crossed the channel.
 * @param path - the remote path.
 * @returns a note, or `undefined` when nothing was started.
 */
function moverPidMissingNote (outcome: string, bytes: number, path: string): string | undefined {
  if (outcome === 'error' && bytes === 0) return undefined
  return `the interrupted copy never reported a server-side mover pid for ${path}, so no process was killed on the server: a mover may still be holding that fifo or file, and this plugin will not guess at which one.`
}

/**
 * End one stranded mover, identified by the pid it reported.
 * @param transport - the shared transport, to spend one small child on the cleanup.
 * @param target - the server the mover is parked on.
 * @param settings - the ceilings the cleanup child runs under.
 * @param auth - the credentials for this target.
 * @param pid - the mover pid this copy recorded on its own channel.
 * @param pathWord - the remote path in the shell shape the mover was handed.
 * @param path - the path as the reader names it, for the note.
 * @returns a sentence when there was one to tell, otherwise `undefined`.
 */
async function reapStoppedMover (
  transport: SshTransport,
  target: RemoteTarget,
  settings: SshSettings,
  auth: RemoteAuth,
  pid: number,
  pathWord: string,
  path: string,
): Promise<string | undefined> {
  let reaped
  try {
    reaped = await transport.run(target, settings, auth, reapMoverCommand(pid, pathWord), {
      timeoutMs: Math.min(settings.statTimeoutMs, REAP_BUDGET_MS),
    })
  } catch {
    // The copy already said what went wrong. Here the cleanup could not even be
    // asked, which is a residual worth naming rather than a silence: 0.0.36 said
    // nothing in exactly this case and read as though the server had been tidied.
    return moverVerdictNote('unanswered', pid, path, target.host)
  }
  const verdict = parseMoverVerdict(reaped.stdout)
  if (verdict === 'unanswered' && reaped.status !== 'succeeded') {
    // The child answered, but not with a verdict: a shell that could not parse the
    // script, or a server that ended it. Same residual, same honesty.
    return moverVerdictNote('unanswered', pid, path, target.host)
  }
  return moverVerdictNote(verdict, pid, path, target.host)
}

/**
 * The longest one transfer call can wait, on the ceilings its own steps run under.
 *
 * A copy is not one child. It is a pre-check, the channel, a publish step the
 * server runs on its own disk, and — when the copy was stopped — one more small
 * child to take the temp file back. Each of those is waited on under its own
 * deadline and each is given the kill grace and pipe drain it needs on the way
 * out, so the honest sum is larger than the copy alone, and the tool's declared
 * call budget has to sit above it: a wrapper that answers first replaces this
 * plugin's classified sentence with a generic timeout one.
 * @param ceilings - the pre-check deadline, the transfer deadline, and the grace.
 * @returns the worst case in milliseconds.
 */
export function transferCallCeiling (ceilings: {
  statTimeoutMs: number
  transferTimeoutMs: number
  graceMs: number
}): number {
  const DRAIN_WITH_GRACE_MS = 400 + ceilings.graceMs
  return 2 * ceilings.statTimeoutMs
    + ceilings.transferTimeoutMs
    + PUBLISH_BUDGET_MS
    + 4 * DRAIN_WITH_GRACE_MS
}

/**
 * The remote command that moves a finished temp file into its final place.
 *
 * The two branches answer a question this plugin cannot freeze between its own
 * round trips — does the destination exist yet — and they are not
 * interchangeable. Replacing an existing file *through* it (`cat -- part > dest`)
 * keeps the inode, the owner, the mode, and every hardlink pointing at it, which
 * is what the overwrite branch of `scp` did and what a `mv` would quietly undo. A
 * fresh name has nothing to keep, so it is renamed — and then carries the source's
 * permission bits filtered through the server's umask, the measured `scp` outcome
 * (`777` arrived as `755` under `umask 0022`, `640` stayed `640`) and the
 * difference between an uploaded script that still runs and one that stopped.
 *
 * The overwrite branch runs its mover **as a background job and waits for it**, and
 * that shape is not cosmetic (K-4): the script has something to do after the mover
 * (`rm` the part, and only on success), so the shell cannot `exec` its way into the
 * copy, so the mover is a child with a pid of its own. Reporting `$!` on stderr
 * before blocking is the only way the near end ever learns which process to take
 * back, and `wait` still hands the copy's own exit status to the caller's `&&`. Measured
 * on a live server in `sh`, `dash` and `bash`: a good copy leaves the destination
 * holding the payload with the part gone and status 0, and a destination that
 * cannot be written (a directory in the way) still reports the server's own sentence
 * with a nonzero status and the part file kept.
 *
 * A `chmod` the server refuses does not fail a copy whose bytes already landed:
 * the mode was the thing being carried, and the content already is.
 * @param remotePart - the server path holding the complete payload.
 * @param destArg - the destination, already shaped for the remote shell.
 * @param sourceMode - this machine's permission bits for the source, when one
 *   could be stated; omit it and a fresh destination keeps the server's default.
 * @param tag - this copy's task identity, echoed in the mover's marker line.
 * @returns one POSIX shell command, with nothing from the caller outside quotes.
 */
export function publishCommand(remotePart: string, destArg: string, sourceMode?: number, tag = ''): string {
  const partArg = remotePathArg(remotePart)
  // The mode is this plugin's own number, rendered octal with the leading `0` the
  // shell's arithmetic needs; nothing caller-shaped reaches here unquoted. Three
  // assignments and a guard, rather than one nested substitution: the nested shape
  // (`chmod "$(printf '%o' $(( … ) ))"`) parses differently across `sh`, `dash`,
  // and `bash` — measured on a live server it died with `Unterminated quoted
  // string` in two of the three, and in the one that “worked” it handed `chmod` an
  // empty argument and left the uploaded file at mode `000`.
  const carry = sourceMode === undefined
    ? ''
    : ` && { u=$(umask); m=$((0${sourceMode.toString(8)} & ~(0$u))); c=$(printf "%o" "$m"); if [ -n "$c" ]; then chmod "$c" ${destArg}; fi; }`
  return `if [ -e ${destArg} ] || [ -L ${destArg} ]; then cat -- ${partArg} > ${destArg} & mp=$!; `
    + `${moverMarker('"$mp"', tag)}wait $mp && rm -f ${partArg}; `
    + `else mv -f ${partArg} ${destArg}${carry}; fi`
}

/**
 * Move one file or tree with `scp`.
 * @param transport - the shared transport.
 * @param target - the server end.
 * @param settings - the shared ceilings and the transfer deadline.
 * @param auth - the credentials for this target.
 * @param request - what to move, and the limits to honour.
 * @param program - the resolved scp executable.
 * @param startedAt - the millisecond the pre-checks began.
 * @param known - the byte and file counts a pre-check produced, if any.
 * @param overwrote - whether the destination existed and was allowed to be replaced.
 * @param notes - the sentences accumulated before the copy started.
 * @returns the outcome of the attempt.
 */
async function copyTree(
  transport: SshTransport,
  target: RemoteTarget,
  settings: SshSettings,
  auth: RemoteAuth,
  request: TransferRequest,
  program: string,
  startedAt: number,
  known: { bytes?: number; files?: number },
  overwrote: boolean,
  notes: string[],
): Promise<TransferOutcome> {
  const authority = transport.authority(target)
  const remote = `${authority}:${request.remotePath}`
  const partPath = request.direction === 'download'
    ? join(dirname(request.localPath), `${basename(request.localPath)}.dsh-part-${entropy()}`)
    : undefined
  const src = request.direction === 'upload' ? request.localPath : remote
  const dst = partPath ?? remote
  const abandon = async (): Promise<void> => {
    if (partPath === undefined) return
    // recursive because a finished tree download is a directory, and a partial
    // one is a directory with partial children inside.
    await rm(partPath, { force: true, recursive: request.recursive === true }).catch(() => undefined)
  }
  const lease = transport.share(target, auth)
  try {
    const { flags, env } = transport.sshOptions(target, settings, auth, request.timeoutMs, {
      portFlag: '-P',
      poolFlags: lease?.flags,
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
      { kind: TRANSFER_LANE, cap: settings.maxConcurrentTransfers },
    )
    const text = `${collected.stderr}\n${collected.stdout}`
    transport.noteShared(lease, collected.outcome === 'exit' && !transport.sessionBroken(text))
    if (collected.outcome === 'timeout') {
      await abandon()
      return { status: 'failed', durationMs: collected.durationMs, message: 'The transfer ran out of its deadline.', overwrote: false, limitMode: 'pre-check', notes }
    }
    if (collected.outcome === 'cancelled') {
      await abandon()
      return { status: 'failed', durationMs: collected.durationMs, message: 'The transfer was cancelled; the destination was left as it was.', overwrote: false, limitMode: 'pre-check', notes }
    }
    if (collected.outcome !== 'exit' || (collected.exitCode ?? 0) !== 0) {
      await abandon()
      if (/no such file|not found|no such directory|permission denied.*stat/iu.test(text) && request.direction === 'upload') {
        return { status: 'missing', durationMs: collected.durationMs, message: `The local file ${request.localPath} could not be read, or the remote directory does not exist.`, overwrote: false, limitMode: 'pre-check', notes }
      }
      return {
        status: 'failed',
        durationMs: collected.durationMs,
        message: text.trim() === '' ? `scp exited with ${String(collected.exitCode ?? 'signal')}.` : text.trim().slice(0, 512),
        overwrote: false,
        limitMode: 'pre-check',
        notes,
      }
    }
    let moved = known
    let measured = false
    if (partPath !== undefined) {
      // A finished tree is a directory, and what it holds is the honest answer to
      // “how much moved” — `scp -q` never says. Walking the part tree before the
      // rename costs one local pass and turns a bare `directory` into numbers.
      const local = await scanLocal(partPath, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, true)
      if (local.ok) {
        moved = { bytes: local.bytes, files: local.files }
        measured = true
        if (local.bytes > request.maxTotalBytes || local.files > request.maxFiles) {
          notes.push(`The tree had grown to ${String(local.bytes)} bytes in ${String(local.files)} files by the time it landed, past the pre-check ceilings.`)
        }
      }
      try {
        await rename(partPath, request.localPath)
      } catch (error: unknown) {
        await abandon()
        const existed = codeOf(error) === 'ENOTDIR' || codeOf(error) === 'EEXIST' || codeOf(error) === 'EISDIR'
        return {
          status: existed ? 'refused-exists' : 'failed',
          durationMs: Date.now() - startedAt,
          message: existed
            ? `The copy finished, but ${request.localPath} appeared as a destination this plugin cannot replace in one step; pass overwrite and try again.`
            : `The copy finished but could not replace ${request.localPath}: ${messageOf(error)}`,
          overwrote: false,
          limitMode: 'pre-check',
          notes,
        }
      }
    }
    return {
      status: 'moved',
      durationMs: Date.now() - startedAt,
      overwrote,
      ...(moved.bytes === undefined ? {} : { bytes: moved.bytes }),
      ...(moved.files === undefined ? {} : { files: moved.files }),
      kind: 'directory',
      limitMode: 'pre-check',
      notes: measured || request.direction === 'upload' ? notes : [...notes, 'The bytes of this copy were never counted: scp -r moves a tree without reporting how much it carried.'],
    }
  } finally {
    transport.unshare(lease)
  }
}

/**
 * Move one file or directory between this machine and a stored target.
 * @param transport - the shared transport, which owns the executable lookup and
 *   the concurrency lanes.
 * @param target - the server end.
 * @param settings - the shared ceilings and the transfer deadline.
 * @param auth - the credentials for this target.
 * @param request - what to move, and the limits to honour.
 * @returns the outcome of the attempt.
 */
export async function transfer(
  transport: SshTransport,
  target: RemoteTarget,
  settings: SshSettings,
  auth: RemoteAuth,
  request: TransferRequest,
): Promise<TransferOutcome> {
  const startedAt = Date.now()
  const recursive = request.recursive === true
  const notes: string[] = []
  const refuse = (refusal: LocalRefusal): TransferOutcome => ({
    status: refusal.status,
    durationMs: Date.now() - startedAt,
    message: refusal.message,
    overwrote: false,
    limitMode: recursive ? 'pre-check' : 'in-flight',
    ...(refusal.status === 'refused-size' && !recursive ? { notes: ['The ceiling was checked against the bytes as they moved, not against a number quoted beforehand.'] } : {}),
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
    limitMode: recursive ? 'pre-check' : 'in-flight',
    notes,
  })
  // A function, not a property read: `aborted` flips while this body is parked
  // at an await, and a direct comparison past the first check would be a
  // narrowing TS would (correctly) call impossible.
  const stopped = (): boolean => request.signal?.aborted === true

  // The payload this call can account for. For a single file the honest number is
  // the one the copy itself counts; a pre-check is only ever the refusal, and the
  // starting value a growth story is told against.
  let knownBytes: number | undefined
  let knownFiles: number | undefined
  let overwrote = false

  if (request.direction === 'upload') {
    // Local side first: existence, readability, and the size ceilings — for a
    // tree as well as for one file, so `recursive` cannot walk around them.
    const local = await scanLocal(request.localPath, request.maxBytes, request.maxFiles, request.maxTotalBytes, recursive)
    if (!local.ok) return refuse(local.refusal)
    if (stopped()) return cancelledOutcome()
    knownBytes = recursive ? local.bytes : (local.kind === 'file' ? local.bytes : undefined)
    knownFiles = recursive ? local.files : undefined
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
          limitMode: recursive ? 'pre-check' : 'in-flight',
          ...(stated.kind.includes('directory') ? { kind: 'directory' } : {}),
          notes,
        }
      }
      overwrote = true
    }
  } else if (recursive) {
    // A tree gets enumerated on the server before it is carried: the ceilings that
    // apply to one file have to apply to the sum somewhere, and discovering an
    // oversized tree at the end of the copy leaves the destination holding it.
    let scan: RemoteFacts
    try {
      scan = await remoteTree(transport, target, settings, auth, request.remotePath, request.signal)
    } catch (error: unknown) {
      if (stopped()) return cancelledOutcome()
      throw error
    }
    if (stopped()) return cancelledOutcome()
    if (scan.kind === 'missing') {
      return { status: 'missing', durationMs: Date.now() - startedAt, message: `Nothing at ${request.remotePath} on ${target.host}.`, overwrote: false, limitMode: 'pre-check', notes }
    }
    if (scan.kind === 'unknown') {
      notes.push('This server could not be asked for the size of the tree, so the copy ran under the deadline and the cancel button, but not under a size ceiling.')
    } else {
      // One ceiling per question: a path that turns out to be a single file is held
      // to the file ceiling, and only a real tree answers to the count and the sum.
      if (scan.kind === 'file' && scan.bytes > request.maxBytes) {
        return { status: 'refused-size', bytes: scan.bytes, kind: 'file', durationMs: Date.now() - startedAt, message: `That file is ${String(scan.bytes)} bytes, over the ${String(request.maxBytes)} byte transfer ceiling.`, overwrote: false, limitMode: 'pre-check', notes }
      }
      if (scan.files > request.maxFiles) {
        return { status: 'refused-size', files: scan.files, bytes: scan.bytes, durationMs: Date.now() - startedAt, message: `That tree holds ${String(scan.files)} files, over the ${String(request.maxFiles)} file ceiling.`, overwrote: false, limitMode: 'pre-check', notes }
      }
      if (scan.bytes > request.maxTotalBytes) {
        return { status: 'refused-size', files: scan.files, bytes: scan.bytes, durationMs: Date.now() - startedAt, message: `That tree adds up to ${String(scan.bytes)} bytes, over the ${String(request.maxTotalBytes)} byte ceiling for one recursive copy.`, overwrote: false, limitMode: 'pre-check', notes }
      }
      knownBytes = scan.bytes
      knownFiles = scan.files
    }
    // `scp -r` cannot land a tree on top of a directory that already holds
    // something: the part sibling is renamed to the final name, and a rename onto
    // a non-empty directory is always `ENOTEMPTY` — a refusal this module used to
    // answer *after* copying the whole tree, and then deleting it again.
    overwrote = request.destinationExists === true && request.overwrite === true
    if (request.destinationExists === true) {
      const occupants = await readdir(request.localPath).catch(() => undefined)
      if (occupants !== undefined && occupants.length > 0) {
        return {
          status: 'refused-exists',
          durationMs: Date.now() - startedAt,
          message: `${request.localPath} is an existing directory with ${String(occupants.length)} file(s) in it, and a recursive copy lands its tree *as* that path rather than into it.`,
          overwrote: false,
          limitMode: 'pre-check',
          kind: 'directory',
          notes: [...notes, 'The tree was never asked to move: nothing was copied, and nothing was deleted.'],
        }
      }
    }
  } else {
    // A pre-check beats discovering an oversized copy at the end: the destination
    // is untouched when the copy has not started. The stated size is kept only as
    // the starting value — the number the result reports is the one that moved.
    const stated = await statRemote()
    if (stopped()) return cancelledOutcome()
    if (stated === undefined) {
      return { status: 'missing', durationMs: Date.now() - startedAt, message: `Nothing at ${request.remotePath} on ${target.host}.`, overwrote: false, limitMode: 'in-flight', notes }
    }
    if (stated.kind.includes('directory')) {
      return { status: 'refused-size', bytes: stated.bytes, kind: stated.kind, durationMs: Date.now() - startedAt, message: `${request.remotePath} is a directory; ask for it recursively.`, overwrote: false, limitMode: 'in-flight', notes }
    }
    if (stated.bytes > request.maxBytes) {
      return {
        status: 'refused-size',
        bytes: stated.bytes,
        kind: stated.kind,
        durationMs: Date.now() - startedAt,
        message: `That file is ${String(stated.bytes)} bytes, over the ${String(request.maxBytes)} byte transfer ceiling.`,
        overwrote: false,
        limitMode: 'in-flight',
        notes,
      }
    }
    knownBytes = stated.bytes
    overwrote = request.destinationExists === true && request.overwrite === true
  }

  const program = recursive
    ? await transport.resolveScp(request.signal)
    : await transport.resolveSsh(request.signal)
  if (program === undefined) {
    return {
      status: 'failed',
      durationMs: Date.now() - startedAt,
      message: recursive
        ? 'No scp program was found: PATH and the usual install locations were tried.'
        : 'No ssh program was found: PATH and the usual install locations were tried.',
      overwrote: false,
      limitMode: recursive ? 'pre-check' : 'in-flight',
      notes,
    }
  }
  const known = { ...(knownBytes === undefined ? {} : { bytes: knownBytes }), ...(knownFiles === undefined ? {} : { files: knownFiles }) }
  try {
    // A tree goes to `scp -r` and its layout stays the one OpenSSH's own tool
    // defines; one file rides a counted channel, because that is the only way the
    // ceiling can be about the bytes and not about a number they had a moment ago.
    return recursive
      ? await copyTree(transport, target, settings, auth, request, program, startedAt, known, overwrote, notes)
      : await copyStream(transport, target, settings, auth, request, program, startedAt, known, overwrote, notes)
  } catch (error: unknown) {
    // The transfer ceiling answers a third copy by refusing it, and the refusal
    // lives in the transport as an error. It leaves this layer as an outcome: a
    // reader of `upload` should get the same vocabulary — status, words, and the
    // next step — whether the copy was too big, too late, or simply not welcome
    // while two others were already moving.
    if (error instanceof SshError && error.code === 'busy') {
      return {
        status: 'failed',
        durationMs: Date.now() - startedAt,
        message: error.message,
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        overwrote: false,
        limitMode: recursive ? 'pre-check' : 'in-flight',
        notes,
      }
    }
    throw error
  }
}
