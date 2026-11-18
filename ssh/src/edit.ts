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

import { createHash } from 'node:crypto'
import { shellQuote } from './transport.ts'

/**
 * The SHA-256 of one body, hex, exactly as {@link buildEditWrite} will send it.
 * @param text - the bytes the write child is about to push through stdin.
 * @returns 64 lowercase hex characters.
 */
export function digestHex (text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * One POSIX substitution that answers with the file's SHA-256, or with nothing
 * when this server cannot state one.
 *
 * `sha256sum` is what a Linux server has; `shasum -a 256` is what a FreeBSD or
 * macOS one has; `openssl dgst -sha256` is the last reach for a box with neither
 * coreutils nor perl. All three print the digest in a different shape, so the
 * sed pair reduces every one of them to bare hex: the first expression keeps the
 * leading 64 hex characters a checksum tool prints, the second takes what
 * follows the `= ` an openssl line puts between its label and its digest. When no
 * tool exists the substitution is empty, and empty means **no evidence** — not a
 * digest of an empty file, which is a real value (`e3b0c442…`) and must never be
 * confused with "could not ask".
 * @param pathArg - the remote path, already shaped for the remote shell.
 * @returns a `$( … )` expression usable inside a double-quoted shell word.
 */
export function remoteDigest (pathArg: string): string {
  return `$( ( sha256sum -- ${pathArg} 2>/dev/null || shasum -a 256 -- ${pathArg} 2>/dev/null || openssl dgst -sha256 ${pathArg} 2>/dev/null || true ) | head -n 1 | sed -e 's/^\\([0-9a-f]\\{64\\}\\).*/\\1/' -e 's/.*= *//' )`
}

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
/** The write ended at the right size but with **different bytes** than were sent. */
export const EDIT_CONTENT_MISMATCH = 28
/** The write ended at the right size, and this server cannot state a digest to prove it is the right content. */
export const EDIT_CONTENT_UNVERIFIED = 29

/**
 * The read an edit begins from: the file's bytes, and what the server says about
 * those bytes at the same moment.
 *
 * The first line is a marker holding `stat`'s inode, size, and nanosecond
 * modification time; the second line is the digest **the server itself** computed
 * over those bytes, and everything after them is the file. Asking in the same
 * round trip is deliberate — a second `stat` after the read would describe a file
 * that had another trip's worth of time to change under it. A server whose `stat`
 * cannot answer leaves the first marker empty, and a server with no checksum tool
 * leaves the second one empty; either way the edit still runs, because the safety
 * copy and the checks that follow still stand, and the result says plainly which
 * guard was in force.
 *
 * The digest is asked from the server rather than computed here from the decoded
 * text: a file that is not valid UTF-8 round-trips through this read into
 * something whose byte count *and* content differ from what is on disk, and a
 * number measured on the server cannot be fooled by that.
 * @param pathArg - the remote path, already shaped for the remote shell.
 * @returns one POSIX command whose stdout is the two marker lines and the file.
 */
export function buildEditRead (pathArg: string): string {
  return `if [ ! -f ${pathArg} ]; then exit ${EDIT_MISSING}; fi; `
    + `printf 'ssh-plugin: %s\\n' "$(stat -c '%i|%s|%y' -- ${pathArg} 2>/dev/null)"; `
    + `printf 'ssh-plugin-sha256: %s\\n' "${remoteDigest(pathArg)}"; `
    + `cat -- ${pathArg}`
}

/**
 * Split the markers a read answered with from the file itself.
 * @param text - the raw stdout of {@link buildEditRead}.
 * @returns the token to guard a write with and the digest the server stated (each
 *   `undefined` when this server could not state it), and the file's text.
 */
export function splitEditVersion (text: string): { version: string | undefined; digest: string | undefined; content: string } {
  const newline = text.indexOf('\n')
  const head = (newline === -1 ? text : text.slice(0, newline)).trim()
  const match = /^ssh-plugin:\s*(.*)$/u.exec(head)
  if (match === null) {
    // No marker at all: a shell that could not run `printf` the way the command
    // asked, or an old server. The whole body is the file, and no guard applies.
    return { version: undefined, digest: undefined, content: text }
  }
  const token = (match[1] ?? '').trim()
  const rest = newline === -1 ? '' : text.slice(newline + 1)
  const second = rest.indexOf('\n')
  const secondLine = (second === -1 ? rest : rest.slice(0, second)).trim()
  const stated = /^ssh-plugin-sha256:\s*(.*)$/u.exec(secondLine)
  if (stated === null) {
    // A read from before this protocol, or a shell that printed the version line
    // and nothing else: the body starts at the second line, and there is no
    // digest to verify anything against.
    return { version: token === '' ? undefined : token, digest: undefined, content: rest }
  }
  const digest = (stated[1] ?? '').trim()
  return {
    version: token === '' ? undefined : token,
    digest: digest === '' ? undefined : digest,
    content: second === -1 ? '' : rest.slice(second + 1),
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
 * the mode, and every hardlink pointed at it. What comes after the write is what
 * this call is allowed to claim: first the byte count, because a short body is a
 * truncation and not an edit, and then a **digest of the bytes that are in the
 * file now**, compared with the digest of the bytes that were sent. Equal size is
 * not equal content — a second writer can leave behind a body of exactly this
 * length that is not this edit's body — so the size check on its own no longer
 * ends this command, and a server that cannot state a digest ends it with 29,
 * which says "the bytes count out" without saying "the bytes are right".
 *
 * The digest is asked of the server for the same reason the version token is: it
 * describes what is on disk, not what this process believes it pushed. One
 * computed locally over the text to be written would prove only the transport,
 * and the transport is already covered by the exit code.
 * @param guards - the paths, the token and the digest the read found (either
 *   `undefined` when this server could not state one), the byte count and the
 *   digest the write must leave behind, and whether the copy of the previous
 *   content stays for the reader to find.
 * @returns one POSIX command; the payload is its stdin.
 */
export function buildEditWrite (guards: {
  pathArg: string
  backupArg: string
  version: string | undefined
  originalSha256?: string | undefined
  expectedBytes: number
  expectedSha256: string
  keepBackup: boolean
}): string {
  const { pathArg, backupArg, version, originalSha256, expectedBytes, expectedSha256, keepBackup } = guards
  const guard = version === undefined
    ? ''
    : `if [ "$(stat -c '%i|%s|%y' -- ${pathArg} 2>/dev/null)" != ${shellQuote(version)} ]; then echo 'ssh-plugin: the file changed after it was read' >&2; exit ${EDIT_STALE}; fi; `
  // A same-size rewrite can hide from `stat`'s size field, and from a coarse
  // mtime; a digest cannot be hidden from. Both sides have to hold one for this
  // to mean anything, which is why the empty string is tested before comparing.
  const stated = shellQuote(originalSha256 ?? '')
  const digestGuard = `if [ -n "$pre" ] && [ -n ${stated} ] && [ "$pre" != ${stated} ]; then echo 'ssh-plugin: the content changed after it was read' >&2; exit ${EDIT_STALE}; fi; `
  const drop = keepBackup ? '' : ` rm -f -- ${backupArg};`
  return `if [ ! -f ${pathArg} ]; then exit ${EDIT_MISSING}; fi; `
    + guard
    + `pre=${remoteDigest(pathArg)}; `
    + digestGuard
    + `printf 'ssh-plugin: pre %s\\n' "\${pre:--}"; `
    + `cp -p -- ${pathArg} ${backupArg} || exit ${EDIT_BACKUP_FAILED}; `
    + `cat > ${pathArg}; rc=$?; `
    + `if [ "$rc" -ne 0 ]; then exit ${EDIT_WRITE_FAILED}; fi; `
    + `size=$(wc -c < ${pathArg} | tr -dc 0-9); `
    + `if [ "$size" != ${String(expectedBytes)} ]; then exit ${EDIT_SIZE_MISMATCH}; fi; `
    + `now=${remoteDigest(pathArg)}; `
    + `if [ -z "$now" ]; then echo "ssh-plugin: ok sizeonly $size"; exit ${EDIT_CONTENT_UNVERIFIED}; fi; `
    + `if [ "$now" != ${shellQuote(expectedSha256)} ]; then echo "ssh-plugin: mismatch $size $now"; exit ${EDIT_CONTENT_MISMATCH}; fi; `
    + `echo "ssh-plugin: ok digest $now";`
    + drop
}

/** What the write child's own answer says about the server's file. */
export interface WriteReport {
  /** The digest the file held **before** this write truncated it, when the server stated one. */
  preSha256?: string
  /** The digest the file holds now, when the server stated one. */
  sha256?: string
  /** How much the answer can be trusted: a digest, a byte count only, or nothing. */
  evidence: 'digest' | 'sizeonly' | 'none'
  /** Bytes the server counted after the write, when it said. */
  bytes?: number
}

/**
 * Read the markers {@link buildEditWrite} answers with.
 * @param stdout - the raw stdout of the write child.
 * @returns what the server attested, with `evidence: 'none'` for an answer that
 *   never arrived or carried no marker at all.
 */
export function parseWriteReport (stdout: string | undefined): WriteReport {
  const text = stdout ?? ''
  const report: WriteReport = { evidence: 'none' }
  const pre = /^ssh-plugin: pre (\S+)/mu.exec(text)?.[1]
  if (pre !== undefined && pre !== '-') report.preSha256 = pre
  const ok = /^ssh-plugin: ok (digest|sizeonly) (\S+)/mu.exec(text)
  if (ok !== null) {
    const stated = ok[2]
    if (ok[1] === 'digest' && stated !== undefined) {
      report.evidence = 'digest'
      report.sha256 = stated
    } else if (ok[1] === 'sizeonly' && stated !== undefined) {
      report.evidence = 'sizeonly'
      report.bytes = Number(stated)
    }
    // A marker whose shape is incomplete says nothing beyond `none`: a caller that
    // reads evidence from a half-line would be inventing the rest of it.
    return report
  }
  const mismatch = /^ssh-plugin: mismatch (\d+|-) (\S+)/mu.exec(text)
  if (mismatch !== null) {
    const counted = mismatch[1]
    const stated = mismatch[2]
    if (counted !== undefined && counted !== '-') report.bytes = Number(counted)
    if (stated !== undefined) report.evidence = 'digest'
    if (stated !== undefined && stated !== '-') report.sha256 = stated
  }
  return report
}

/**
 * The child that looks at the file after a write went wrong, and puts right what
 * it can.
 *
 * It answers with a marker line rather than only an exit code, because there are
 * several different things that can be true at this moment and a caller that
 * guesses between them will write a sentence the server does not support:
 *
 * - `landed` — the intended content is in the file and only the answer was lost,
 *   so restoring would undo an edit that finished;
 * - `intact` — the file still holds the bytes this call measured before it
 *   truncated anything, so the write never landed and there is nothing to put
 *   back;
 * - `restored` — the copy was still there, and the file holds what the copy holds;
 * - `unrecoverable` — the content is not the one this call read and there is no
 *   copy left to put back, or the copy itself failed to arrive;
 * - `partial` — the copy was put back, but it is not provably the content this
 *   call read.
 *
 * Every one of those markers carries **how the server knows**, because a verdict
 * earned by counting bytes is not the same claim as one earned by comparing
 * digests: the second field is `digest`, `sizeonly`, or `none`. Nothing in this
 * command may report a successful edit or a successful restore on `sizeonly`
 * evidence alone, and that is why the byte count no longer settles the question.
 *
 * Restoring goes *through* the file, not around it: `cp -p` onto an existing inode
 * keeps the owner, the mode, and the hardlinks the edit itself was careful to
 * keep. The copy is only dropped on a branch that proved its way there, because a
 * safety copy is worth nothing if the caller is told the file is fine when the
 * server only counted it.
 * @param restore - the paths, the copy to restore from, the digest the file had
 *   when the read finished, the digest the file held the moment before this write
 *   truncated it (when the write child got that far), the digest and the size the
 *   edit meant to leave, the size the file had before, and whether the copy stays
 *   where the reader can find it.
 * @returns one POSIX command.
 */
export function buildEditRestore (restore: {
  pathArg: string
  backupArg: string
  originalBytes: number
  intendedBytes: number
  expectedSha256?: string | undefined
  originalSha256?: string | undefined
  preSha256?: string | undefined
  keepBackup: boolean
}): string {
  const { pathArg, backupArg, originalBytes, intendedBytes, keepBackup } = restore
  const expected = shellQuote(restore.expectedSha256 ?? '')
  // What the file held the moment before this write truncated it. The write child
  // states it; when that child died before printing anything, there is no
  // reference to compare against, and an untouched file is then only *sized*.
  const before = shellQuote(restore.preSha256 ?? restore.originalSha256 ?? '')
  const finish = keepBackup ? 'true' : `rm -f -- ${backupArg}`
  return `size=$(wc -c < ${pathArg} 2>/dev/null | tr -dc 0-9); size=\${size:--}; `
    + `now=${remoteDigest(pathArg)}; `
    + `if [ -n "$now" ] && [ -n ${expected} ] && [ "$now" = ${expected} ]; then echo "ssh-plugin: landed digest $size $now"; exit ${EDIT_LANDED_UNCONFIRMED}; fi; `
    + `if [ -z "$now" ] && [ "$size" = ${String(intendedBytes)} ]; then echo "ssh-plugin: landed sizeonly $size -"; exit ${EDIT_LANDED_UNCONFIRMED}; fi; `
    + `if [ ! -f ${backupArg} ]; then `
    + `if [ -n "$now" ]; then `
    + `if [ -n ${before} ] && [ "$now" = ${before} ]; then echo "ssh-plugin: intact digest $size $now"; exit 0; fi; `
    + `if [ -n ${before} ]; then echo "ssh-plugin: unrecoverable digest $size $now"; exit ${EDIT_RESTORE_FAILED}; fi; `
    + `if [ "$size" = ${String(originalBytes)} ]; then echo "ssh-plugin: intact none $size -"; exit 0; fi; `
    + `echo "ssh-plugin: unrecoverable digest $size $now"; exit ${EDIT_RESTORE_FAILED}; `
    + `fi; `
    + `if [ "$size" = ${String(originalBytes)} ]; then echo "ssh-plugin: intact sizeonly $size -"; exit 0; fi; `
    + `echo "ssh-plugin: unrecoverable sizeonly $size -"; exit ${EDIT_RESTORE_FAILED}; `
    + `fi; `
    + `cp -p -- ${backupArg} ${pathArg} || { if [ -n "$now" ]; then echo "ssh-plugin: unrecoverable digest $size $now"; else echo "ssh-plugin: unrecoverable sizeonly $size -"; fi; exit ${EDIT_RESTORE_FAILED}; }; `
    + `after=${remoteDigest(pathArg)}; `
    + `bak=${remoteDigest(backupArg)}; `
    + `if [ -n "$after" ] && [ "$after" = "$bak" ] && { [ -z ${before} ] || [ "$bak" = ${before} ]; }; then echo "ssh-plugin: restored digest $size $after"; ${finish}; exit 0; fi; `
    + `if [ -z "$after" ] && [ -z "$bak" ] && [ "$size" = ${String(originalBytes)} ]; then echo "ssh-plugin: restored sizeonly $size -"; ${finish}; exit 0; fi; `
    + `if [ -n "$after" ]; then echo "ssh-plugin: partial digest $size $after"; exit ${EDIT_RESTORE_UNVERIFIED}; fi; `
    + `echo "ssh-plugin: partial sizeonly $size -"; exit ${EDIT_RESTORE_UNVERIFIED}`
}

/** How much a repair answer can be trusted. */
export type RepairEvidence = 'digest' | 'sizeonly' | 'none'

/** What the repair child's answer says about the server's file. */
export interface RepairReport {
  /** The verdict the server reached, or `undefined` when it never said one. */
  verdict: 'landed' | 'intact' | 'restored' | 'unrecoverable' | 'partial' | undefined
  /** How the server knows it: a digest, a byte count only, or nothing stated. */
  evidence: RepairEvidence
  /** Only true when a digest backs the verdict — the whole point of this file. */
  contentVerified: boolean
  /** Bytes the server counted, when it said. */
  bytes?: number
  /** The digest the file holds now, when the server stated one. */
  sha256?: string
}

/**
 * Read the markers {@link buildEditRestore} answers with.
 *
 * The rule lives here rather than in the caller's prose, because there are two
 * callers of this and a third coming: a verdict backed by a byte count only is
 * reported as **unknown**, never as the good-sounding word the marker used.
 * @param stdout - the raw stdout of the repair child.
 * @returns the verdict, its evidence, and what the server stated about the file.
 */
export function parseRepairReport (stdout: string | undefined): RepairReport {
  const match = /^ssh-plugin: (landed|intact|restored|unrecoverable|partial) (digest|sizeonly|none) (\d+|-)( (\S+))?/mu.exec(stdout ?? '')
  if (match === null) return { verdict: undefined, evidence: 'none', contentVerified: false }
  const evidence = match[2] as RepairEvidence
  const counted = match[3]
  const stated = match[5]
  return {
    verdict: match[1] as RepairReport['verdict'],
    evidence,
    contentVerified: evidence === 'digest',
    ...(counted !== undefined && counted !== '-' ? { bytes: Number(counted) } : {}),
    ...(stated !== undefined && stated !== '-' ? { sha256: stated } : {}),
  }
}
