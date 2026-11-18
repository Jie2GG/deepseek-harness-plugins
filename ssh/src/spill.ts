/**
 * The spill this plugin is willing to ask the machine for.
 *
 * When a collected stream passes its ceiling, the subprocess provider writes the
 * **whole** stream to a file and hands the path back, which is what turns
 * “truncated” from a loss into a pointer — a 9 MiB log a command spilled is still
 * readable, just not inline. Those files are the provider's, in a directory of
 * the provider's own, and they are kept until something outside the process
 * cleans them: no consumer in this harness deletes one, and this plugin is not
 * the process that made them, so it does not get to unlink them either.
 *
 * What this plugin does control is the *asking*. Sixteen operation slots, two
 * streams each, and a per-stream ceiling of 64 MiB is a theoretical two gigabytes
 * of recovery files that one busy stretch could produce, and the number arrives
 * only if somebody multiplies three constants in a different file. So the ceiling
 * is stated here as one budget per Host process: streams are granted spill out of
 * what is left, and when the budget is spent the next child is asked to keep only
 * its in-memory tail — which is exactly the pre-spill behaviour, and the reason
 * the answer says so rather than reporting a bare `truncated`.
 *
 * A grant is not a reservation, and it is never cut down. Bytes leave the budget
 * when the provider *reports* a spill — after the child has settled — so the
 * moment a grant could be sized to what is left, the stream that receives it could
 * outgrow the grant and have its file deleted by the provider again, which is the
 * one outcome worse than no spill file: a truncated answer, a writer who tried,
 * and no path to read. So each stream is handed the ceiling it asked for (held to
 * the whole-process number), and the total is allowed to pass the ceiling by at
 * most one stream. The budget stops the *next* child, and the note it gets says
 * which of the two limits — bytes or files — was already spent.
 *
 * That makes the number a stopping condition rather than a hard cap, and the
 * difference matters enough to state: a profile that sets `maxSpillBytes` above the
 * budget will see exactly one stream larger than the budget, and no more.
 *
 * The count is taken from what the provider reports back (the whole-stream offset
 * of a read that named a spill file), not from a `stat` of somebody else's
 * directory: a spill larger than its own cap is discarded by the provider and
 * never named, so what is named is what is on disk.
 *
 * @module @jie2gg/dsh-plugin-ssh/spill
 */

/**
 * The whole-process byte budget: half the worst case the operation ceiling can
 * produce (sixteen slots, two streams each, at the default 64 MiB per stream).
 * Half rather than the whole number, because the worst case is a burst nobody
 * would notice and the total is a directory nobody will clean.
 */
export const SPILL_BUDGET_BYTES = 1_073_741_824

/**
 * The whole-process file budget. Spill files are small in count and large in
 * bytes, so this is the guard against a long tail of half-interested calls each
 * leaving a 60 MiB recovery file behind, and the reason a reader is told which
 * of the two limits answered.
 */
export const SPILL_BUDGET_FILES = 64

/** What the budget hands out for one stream of one child. */
export interface SpillGrant {
  /** Bytes of spill this child may create; `0` means ask the provider for none. */
  maxBytes: number
  /** The sentence the result owes the reader when the budget refused. */
  note: string | undefined
}

/**
 * One Host process's spill accounting.
 *
 * Deliberately stateless about *where* the files live: the provider owns the
 * paths, and this class only counts the ones it asked for. It is not a resource
 * pool with reclamation — a spill file that outlives its call stays counted, which
 * is the conservative direction, because nothing here can know when a reader is
 * finished with it.
 */
export class SpillBudget {
  #used = 0
  #files = new Set<string>()
  #refusals = 0
  readonly #max: number
  readonly #fileMax: number

  /**
   * @param max - the whole-process byte budget; `0` disables spilling, which is
   *   what a profile that set `maxSpillBytes: 0` already means.
   * @param fileMax - the whole-process file budget; `0` means no limit on count.
   */
  constructor (max: number = SPILL_BUDGET_BYTES, fileMax: number = SPILL_BUDGET_FILES) {
    this.#max = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0
    this.#fileMax = Number.isFinite(fileMax) && fileMax > 0 ? Math.floor(fileMax) : 0
  }

  /** Bytes of spill this process has been told about so far. */
  get used (): number {
    return this.#used
  }

  /** How many distinct spill files the provider has handed back. */
  get files (): number {
    return this.#files.size
  }

  /** How many children were asked to do without a spill file. */
  get refusals (): number {
    return this.#refusals
  }

  /** The budget this instance was built with. */
  get max (): number {
    return this.#max
  }

  /** The file limit this instance was built with. */
  get fileMax (): number {
    return this.#fileMax
  }

  /**
   * What one stream may ask the provider for.
   * @param wanted - the configured per-stream ceiling, in bytes.
   * @returns the ceiling to hand down, and the note to say out loud when the
   *   budget was what decided it.
   */
  ask (wanted: number): SpillGrant {
    if (this.#max === 0 || this.#fileMax === 0 || wanted <= 0) return { maxBytes: 0, note: undefined }
    // The budget is a stopping condition, not a reservation. Nothing here knows
    // how long a stream will turn out to be — the provider reports a spill file
    // once the child has settled — so a grant cannot be cut to the remainder
    // without risking the worse outcome: a file written and then *discarded*
    // because the stream outgrew the number it was handed, leaving the reader with
    // a truncated answer and no path at all. Each stream is therefore granted what
    // it asked for, held to the whole-process ceiling, and the total is allowed to
    // pass the ceiling by at most one stream — which is stated here rather than
    // hidden, because it is the price of the difference between "bounded" and
    // "hoped for".
    const spent = this.#used >= this.#max
    const full = this.#files.size >= this.#fileMax
    if (spent || full) {
      this.#refusals += 1
      const reason = spent
        ? `${String(this.#used)} of ${String(this.#max)} bytes already written`
        : `${String(this.#files.size)} of ${String(this.#fileMax)} files already written`
      return {
        maxBytes: 0,
        note: `the plugin's spill budget is spent (${reason}), so this output keeps only its in-memory tail and no full-output file`,
      }
    }
    return { maxBytes: Math.min(wanted, this.#max), note: undefined }
  }

  /**
   * Record the spill files one child reported.
   *
   * A read that reports no path wrote no file — a stream that stayed inside its
   * in-memory ceiling costs nothing, however long it was — so an entry without a
   * path is skipped rather than charged. Getting that wrong is how a quiet machine
   * looks out of budget: the bytes of every ordinary answer counted against a
   * limit meant only for the files on disk.
   * @param entries - one per face of one settled child: the spill path the
   *   provider reported, if any, and the whole-stream byte count it read back.
   * @returns the bytes newly taken out of the budget.
   */
  observe (entries: readonly { path: string | undefined; bytes: number }[]): number {
    let added = 0
    for (const entry of entries) {
      if (entry.path === undefined || entry.path === '') continue
      if (this.#files.has(entry.path)) continue
      this.#files.add(entry.path)
      const bytes = Number.isFinite(entry.bytes) && entry.bytes > 0 ? Math.floor(entry.bytes) : 0
      this.#used += bytes
      added += bytes
    }
    return added
  }

  /** The one line a settings card or a log wants. */
  summary (): string {
    return `${String(this.#used)} of ${String(this.#max)} bytes spilled in ${String(this.#files.size)} of ${String(this.#fileMax)} file(s), ${String(this.#refusals)} child(ren) asked without`
  }
}
