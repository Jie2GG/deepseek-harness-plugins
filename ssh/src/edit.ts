/**
 * The one calculation a remote edit cannot get wrong on the server: how many
 * times a string appears, and whether replacing it is a decision or a guess.
 *
 * The plugin reads the remote file, applies this function, and writes the result
 * back, so the matching rules are ordinary local code the suites can exercise
 * without a server. Doing it on the server with `sed` would have meant escaping the
 * caller's text into a shell expression and inventing different semantics for
 * slashes, newlines, and `&`.
 *
 * @module @jie2gg/dsh-plugin-ssh/edit
 */

import { shellQuote } from './transport.ts'

/** What the caller asked to replace. */
export interface EditRequest {
  /** The file's current text. */
  content: string
  /** The exact text to find. */
  oldText: string
  /** The text to put in its place. */
  newText: string
  /** Replace every occurrence rather than refusing an ambiguous match. */
  all?: boolean
  /** Replace only the first occurrence, which never asks for context. */
  replaceFirst?: boolean
}

/** Why one edit was refused. */
export type EditRefusal = 'empty' | 'identical' | 'not-found' | 'ambiguous'

/** The outcome of one edit calculation. */
export type EditOutcome =
  | {
      /** The replacement applies. */
      ok: true
      /** The text to write back. */
      text: string
      /** How many places were changed. */
      count: number
      /** Byte size before and after, for the reader and for a sanity check. */
      bytesBefore: number
      bytesAfter: number
    }
  | {
      /** The replacement is refused before anything is written. */
      ok: false
      /** What stopped it. */
      reason: EditRefusal
      /** How many times the text was found, when that is the question. */
      found: number
      /** Plain-language next step. */
      message: string
      hint: string
    }

/**
 * Work out one remote edit against the text as it stands now.
 *
 * Matching is exact and non-overlapping, counted by splitting on the needle. An
 * ambiguous match is refused rather than guessed: on a remote file there is no
 * diff view to notice a wrong choice in.
 * @param request - the file text and what to replace in it.
 * @returns the new text, or the refusal with the reason and the next step.
 */
export function applyEdit(request: EditRequest): EditOutcome {
  const { content, oldText, newText } = request
  const bytesBefore = Buffer.byteLength(content, 'utf8')
  if (oldText === '') {
    return {
      ok: false,
      reason: 'empty',
      found: 0,
      message: 'An edit needs the exact text to find; an empty needle would match everywhere.',
      hint: 'Pass oldText: the current lines to change, copied from a read.',
    }
  }
  if (oldText === newText) {
    return {
      ok: false,
      reason: 'identical',
      found: 0,
      message: 'The text to replace and the replacement are the same, so nothing would change.',
      hint: 'Pass the new content as newText.',
    }
  }
  const found = content.split(oldText).length - 1
  if (found === 0) {
    return {
      ok: false,
      reason: 'not-found',
      found: 0,
      message: 'That text is not in the file.',
      hint: 'Read the file first and copy the exact lines, including indentation and line breaks.',
    }
  }
  if (found > 1 && request.all !== true && request.replaceFirst !== true) {
    return {
      ok: false,
      reason: 'ambiguous',
      found,
      message: `That text appears ${String(found)} times in the file.`,
      hint: 'Include more surrounding lines so it matches once, or pass all (or replaceFirst) on purpose.',
    }
  }
  const count = found > 1 && request.replaceFirst === true ? 1 : found
  const text = count === 1
    ? `${content.slice(0, content.indexOf(oldText))}${newText}${content.slice(content.indexOf(oldText) + oldText.length)}`
    : content.split(oldText).join(newText)
  return {
    ok: true,
    text,
    count,
    bytesBefore,
    bytesAfter: Buffer.byteLength(text, 'utf8'),
  }
}

/** What one dry-run preview reports. */
export interface EditPreview {
  /** The text that would be written. */
  text: string
  /** A line view of what changes, capped so the answer stays readable. */
  diff: string
  /** Byte size before and after, for the reader and for a sanity check. */
  bytesBefore: number
  bytesAfter: number
  /** True when `diff` was cut short and does not show every changed line. */
  truncated: boolean
}

/**
 * Render a line-oriented preview of an edit that has not been written.
 *
 * The diff is computed where the text actually differs — a common prefix and a
 * common suffix are trimmed, and what sits between them is what would change.
 * That is exact for the single replacement this tool makes per call, and honest
 * for the multi-replacement (`all`) case, which can only ever show the outermost
 * span. Context lines around the change make the answer readable in a transcript;
 * the whole body is capped, because a preview that dumps 4 MiB has stopped being
 * a preview.
 * @param before - the text as it stands on the server.
 * @param after - the text the edit would write.
 * @param maxLines - how many diff lines the answer may carry before it is cut.
 * @returns the preview, its byte sizes, and whether the diff was cut short.
 */
export function previewEdit(before: string, after: string, maxLines = 80): EditPreview {
  const bytesBefore = Buffer.byteLength(before, 'utf8')
  const bytesAfter = Buffer.byteLength(after, 'utf8')
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  let head = 0
  while (head < beforeLines.length && head < afterLines.length && beforeLines[head] === afterLines[head]) head += 1
  let tailBefore = beforeLines.length
  let tailAfter = afterLines.length
  while (tailBefore > head && tailAfter > head && beforeLines[tailBefore - 1] === afterLines[tailAfter - 1]) {
    tailBefore -= 1
    tailAfter -= 1
  }
  const removed = beforeLines.slice(head, tailBefore)
  const added = afterLines.slice(head, tailAfter)
  // Nothing between the trimmed ends: the texts are equal, and an honest preview
  // says so with an empty diff instead of dressing unchanged lines up as a hunk.
  if (removed.length === 0 && added.length === 0) {
    return { text: after, diff: '', bytesBefore, bytesAfter, truncated: false }
  }
  const context = Math.min(2, head)
  const body = [
    ...beforeLines.slice(Math.max(0, head - context), head).map(line => ` ${line}`),
    ...removed.map(line => `-${line}`),
    ...added.map(line => `+${line}`),
    ...beforeLines.slice(tailBefore, Math.min(beforeLines.length, tailBefore + context)).map(line => ` ${line}`),
  ]
  const truncated = body.length > maxLines
  const shown = truncated ? body.slice(0, maxLines) : body
  if (truncated) shown.push(`… ${String(body.length - maxLines)} more line(s) not shown`)
  return { text: after, diff: shown.join('\n'), bytesBefore, bytesAfter, truncated }
}

/**
 * The exit codes one remote edit answers with, and what each one means about the
 * server's file. They are stated apart from the shell text so `ops.ts` can map
 * each to a sentence without re-reading the command, and so a test can name the
 * branch it is driving.
 */
/** The file was gone by the time the child looked at it. */
export const EDIT_MISSING = 20
/** Another writer had already changed it, so this edit stopped. */
export const EDIT_STALE = 21
/** The safety copy could not be made, so nothing was written. */
export const EDIT_BACKUP_FAILED = 22
/** The body stopped arriving, or the child died with it half way in. */
export const EDIT_WRITE_FAILED = 23
/** The write ended but left a different number of bytes than were sent. */
export const EDIT_SIZE_MISMATCH = 24
/** The previous content could not be put back. */
export const EDIT_RESTORE_FAILED = 25
/** The copy came back, but not at the size it started at. */
export const EDIT_RESTORE_UNVERIFIED = 26
/** The answer never arrived, but the bytes did: there is nothing to put back. */
export const EDIT_LANDED_UNCONFIRMED = 27

/**
 * The read an edit begins from: the file's bytes, and what the server says about
 * those bytes at the same moment.
 *
 * The first line is a marker holding `stat`'s inode, size, and nanosecond
 * modification time; everything after it is the file. Asking in the same round
 * trip is deliberate — a second `stat` after the read would describe a file that
 * had another trip's worth of time to change under it. A server whose `stat`
 * cannot answer leaves the marker empty, and the edit then runs **without** the
 * version guard rather than refusing: the safety copy and the byte check still
 * stand, and the result says plainly that no version was compared.
 * @param pathArg - the remote path, already shaped for the remote shell.
 * @returns one POSIX command whose stdout is the marker line and the file.
 */
export function buildEditRead (pathArg: string): string {
  return `if [ ! -f ${pathArg} ]; then exit ${EDIT_MISSING}; fi; `
    + `printf 'ssh-plugin: %s\\n' "$(stat -c '%i|%s|%y' -- ${pathArg} 2>/dev/null)"; `
    + `cat -- ${pathArg}`
}

/**
 * Split the version marker a read answered with from the file itself.
 * @param text - the raw stdout of {@link buildEditRead}.
 * @returns the token to guard a write with (`undefined` when this server could
 *   not state one), and the file's text.
 */
export function splitEditVersion (text: string): { version: string | undefined; content: string } {
  const newline = text.indexOf('\n')
  const head = (newline === -1 ? text : text.slice(0, newline)).trim()
  const match = /^ssh-plugin:\s*(.*)$/u.exec(head)
  if (match === null) {
    // No marker at all: a shell that could not run `printf` the way the command
    // asked, or an old server. The whole body is the file, and no guard applies.
    return { version: undefined, content: text }
  }
  const token = (match[1] ?? '').trim()
  return {
    version: token === '' ? undefined : token,
    content: newline === -1 ? '' : text.slice(newline + 1),
  }
}

/**
 * The write child: guard, copy, replace, and check — in that order, in one child.
 *
 * The order is the design. The version guard runs *inside* the same shell that
 * truncates the file, so the window between noticing a change and making one is
 * a shell builtin apart rather than a network round trip apart (and it is a
 * window still, not a closed door: say so rather than implying a transaction).
 * The safety copy comes before any write, because an edit that cannot make one
 * has no way back, and an edit that writes anyway is betting someone else's
 * file on a channel staying open. The body goes in through stdin, into the file
 * itself — `cat >` through the existing inode, which is what keeps the owner,
 * the mode, and every hardlink pointed at it. The size check at the end is what
 * tells a completed write from a short one, which is the difference between
 * reporting an edit and reporting a truncation.
 * @param guards - the paths, the token from the read, the byte count the write
 *   must leave behind, and whether the copy of the previous content stays for
 *   the reader to find.
 * @returns one POSIX command; the payload is its stdin.
 */
export function buildEditWrite (guards: {
  pathArg: string
  backupArg: string
  version: string | undefined
  expectedBytes: number
  keepBackup: boolean
}): string {
  const { pathArg, backupArg, version, expectedBytes, keepBackup } = guards
  const guard = version === undefined
    ? ''
    : `if [ "$(stat -c '%i|%s|%y' -- ${pathArg} 2>/dev/null)" != ${shellQuote(version)} ]; then echo 'ssh-plugin: the file changed after it was read' >&2; exit ${EDIT_STALE}; fi; `
  const drop = keepBackup ? '' : ` rm -f -- ${backupArg};`
  return `if [ ! -f ${pathArg} ]; then exit ${EDIT_MISSING}; fi; `
    + guard
    + `cp -p -- ${pathArg} ${backupArg} || exit ${EDIT_BACKUP_FAILED}; `
    + `cat > ${pathArg}; rc=$?; `
    + `if [ "$rc" -ne 0 ]; then exit ${EDIT_WRITE_FAILED}; fi; `
    + `size=$(wc -c < ${pathArg} | tr -dc 0-9); `
    + `if [ "$size" != ${String(expectedBytes)} ]; then exit ${EDIT_SIZE_MISMATCH}; fi;`
    + drop
}

/**
 * The child that looks at the file after a write went wrong, and puts right what
 * it can.
 *
 * It answers with a marker line rather than only an exit code, because there are
 * four different things that can be true at this moment and a caller that guesses
 * between them will write a sentence the server does not support:
 *
 * - `landed` — the new bytes are there and only the answer was lost, so restoring
 *   would undo an edit that finished;
 * - `intact` — the file still holds the size it had before this call, which means
 *   the write never truncated it and there is nothing to put back;
 * - `restored` — the copy was still there, and the file came back at the size it
 *   started at;
 * - an exit of 25 or 26 — the copy is gone or the write back failed, and the file
 *   is whatever half a body it happens to hold.
 *
 * Restoring goes *through* the file, not around it: `cp -p` onto an existing inode
 * keeps the owner, the mode, and the hardlinks the edit itself was careful to
 * keep.
 * @param restore - the paths, the copy to restore from, the size the file had
 *   before this edit, the size the edit meant to leave, and whether the copy of
 *   the previous content stays where the reader can find it.
 * @returns one POSIX command.
 */
export function buildEditRestore (restore: {
  pathArg: string
  backupArg: string
  originalBytes: number
  intendedBytes: number
  keepBackup: boolean
}): string {
  const { pathArg, backupArg, originalBytes, intendedBytes, keepBackup } = restore
  const finish = keepBackup ? 'true' : `rm -f -- ${backupArg}`
  return `size=$(wc -c < ${pathArg} 2>/dev/null | tr -dc 0-9); `
    + `if [ "$size" = ${String(intendedBytes)} ]; then echo 'ssh-plugin: landed'; exit ${EDIT_LANDED_UNCONFIRMED}; fi; `
    + `if [ ! -f ${backupArg} ]; then echo "ssh-plugin: intact $size"; exit 0; fi; `
    + `cp -p -- ${backupArg} ${pathArg} || { echo "ssh-plugin: unrecoverable $(wc -c < ${pathArg} 2>/dev/null | tr -dc 0-9)"; exit ${EDIT_RESTORE_FAILED}; }; `
    + `after=$(wc -c < ${pathArg} | tr -dc 0-9); `
    + `if [ "$after" != ${String(originalBytes)} ]; then echo "ssh-plugin: partial $after"; exit ${EDIT_RESTORE_UNVERIFIED}; fi; `
    + `echo 'ssh-plugin: restored'; ${finish}`
}
