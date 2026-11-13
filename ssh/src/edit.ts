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
