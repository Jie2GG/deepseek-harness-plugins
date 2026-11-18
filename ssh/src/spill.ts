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
 * is stated here as one budget per Host process: each child is offered spill up to
 * the ceiling it asked for, the offer is withdrawn once the budget has been passed,
 * and the next child is then asked to keep only its in-memory tail — which is
 * exactly the pre-spill behaviour, and the reason the answer says so rather than
 * reporting a bare `truncated`.
 *
 * A grant is not a reservation, and it is never cut down. Bytes leave the budget
 * when the provider *reports* a spill — after the child has settled — so at the
 * moment a grant is handed out, nothing here can know how long the stream that
 * receives it will turn out to be. Sizing a grant to the remainder would risk the
 * one outcome worse than no spill file: a stream outgrowing the number it was
 * handed, its file deleted by the provider again, and the reader left with a
 * truncated answer, a writer who tried, and no path to read. So each child is
 * handed the ceiling it asked for (held to the whole-process number) and both of
 * its faces may write up to that, and the total is allowed to pass the number: by
 * the two faces of the child whose report tipped it, and by the faces of every
 * child already in flight at the moment it tipped.
 *
 * Which is to say the number is a **stopping condition, not a hard cap**: the
 * guarantee is that the asking stops, not that the provider's directory stays
 * under a size. At the defaults the worst case is the 2 GiB the arithmetic above
 * describes arriving on top of what had already been reported when the threshold
 * tipped, so a Host process is bounded near 3 GiB rather than at 1 GiB, and a
 * profile that raises `maxSpillBytes` raises that ceiling too — the per-stream
 * value is a configuration knob, the whole-process budget is a constant. The
 * budget stops the *next* child, and the note it gets says which of the two
 * limits — bytes or files — was already passed.
 *
 * The count is taken from what the provider reports back (the whole-stream offset
 * of a read that named a spill file), not from a `stat` of somebody else's
 * directory: a spill larger than its own cap is discarded by the provider and
 * never named, so what is named is what is on disk. Because the number is the
 * whole-stream offset rather than a delta, the same file reported again with a
 * **larger** offset means the file grew on disk — a background stream re-reads its
 * own spill as it lengthens — and the ledger is topped up by that difference, so
 * `used` follows the bytes actually written instead of freezing at the first
 * number ever seen for that path.
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

/** What the budget hands out for one child — both of its faces draw on this. */
export interface SpillGrant {
  /** Bytes of spill this child may create; `0` means ask the provider for none. */
  maxBytes: number
  /** The sentence the result owes the reader when the budget refused. */
  note: string | undefined
}

/**
 * One ledger of spilled bytes. It belongs to a transport instance, and the
 * production wiring creates one transport per plugin activation, so in the product
 * this is one accounting per Host process — shared by every target that process
 * reaches, not per server and not per conversation. A profile that assembles two
 * transports gets two ledgers, and neither knows what the other has spent.
 *
 * Deliberately stateless about *where* the files live: the provider owns the
 * paths, and this class only counts the ones it asked for. It is not a resource
 * pool with reclamation — a spill file that outlives its call stays counted, which
 * is the conservative direction, because nothing here can know when a reader is
 * finished with it. What is counted per path is the **largest** whole-stream offset
 * the provider has reported for it: a file that grows between reports (a background
 * stream read again after more of it spilled) is charged up to its new size, so the
 * byte ledger is a running sum of what is on disk under the paths this process
 * named, not a snapshot of the first report.
 */
export class SpillBudget {
  #used = 0
  /** Spilled files this process named, mapped to the largest whole-stream offset it has been told for each. */
  #files = new Map<string, number>()
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
   * What one child may ask the provider for.
   * @param wanted - the configured per-child ceiling, in bytes (the
   *   `maxSpillBytes` a target resolved to). A child's stdout and stderr draw on
   *   this one grant together, which is why the total can pass the budget by two
   *   faces rather than one.
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
    // a truncated answer and no path at all. Each child is therefore granted what
    // it asked for, held to the whole-process ceiling, and both faces of that child
    // draw on the one grant; the total is allowed to pass the ceiling by the faces
    // in flight when it tipped. Stated rather than hidden, because it is the price
    // of the difference between "bounded" and "hoped for".
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
   * Record the spill files one child reported, and top up the ledger for a file
   * that has grown since its last report.
   *
   * A read that reports no path wrote no file — a stream that stayed inside its
   * in-memory ceiling costs nothing, however long it was — so an entry without a
   * path is skipped rather than charged. Getting that wrong is how a quiet machine
   * looks out of budget: the bytes of every ordinary answer counted against a
   * limit meant only for the files on disk.
   *
   * The bytes are a **whole-stream offset**, not an increment, so the same path can
   * legitimately be reported more than once as a background stream keeps spilling.
   * The ledger tracks the largest offset seen per path: the first report charges
   * that many bytes, a later larger report charges only the difference, and a later
   * smaller-or-equal report charges nothing — a file the provider wrote does not
   * shrink on disk, so there is nothing to hand back, and re-counting the whole
   * offset again would empty the budget out of one long log. Counting it this way is
   * what keeps `used` equal to the bytes actually on disk under the paths this
   * process named, which is the whole point of the number.
   * @param entries - one per face of one child, reported after it settled or after a
   *   background read advanced its cursor: the spill path the provider named, if
   *   any, and the whole-stream byte count it read back.
   * @returns the bytes newly taken out of the budget.
   */
  observe (entries: readonly { path: string | undefined; bytes: number }[]): number {
    let added = 0
    for (const entry of entries) {
      if (entry.path === undefined || entry.path === '') continue
      const bytes = Number.isFinite(entry.bytes) && entry.bytes > 0 ? Math.floor(entry.bytes) : 0
      const seen = this.#files.get(entry.path)
      if (seen === undefined) {
        this.#files.set(entry.path, bytes)
        this.#used += bytes
        added += bytes
      } else if (bytes > seen) {
        const delta = bytes - seen
        this.#files.set(entry.path, bytes)
        this.#used += delta
        added += delta
      }
    }
    return added
  }

  /** The one line a settings card or a log wants. */
  summary (): string {
    return `${String(this.#used)} of ${String(this.#max)} bytes spilled in ${String(this.#files.size)} of ${String(this.#fileMax)} file(s), ${String(this.#refusals)} child(ren) asked without`
  }
}
