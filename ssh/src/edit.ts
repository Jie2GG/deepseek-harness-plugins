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
