/**
 * The plugin's own bounds configuration.
 *
 * The harness does not carry a two-sided range anywhere. A knob is a **default**
 * plus a single **cap**, both configuration; an override that arrives out of
 * range is capped and then echoed back as the effective value, and only a value
 * that is not a positive finite number is refused at all (`bash-local` declares
 * exactly this pair for its command budget, and `tool-jobs` caps a wait the same
 * way). This module is where this plugin stopped inventing something else: the
 * three ranges the settings page used to publish as `1 s – 300 s`,
 * `1 KiB – 4 MiB`, and `1 KiB – 512 MiB` are now `{name}` (default) and
 * `max{Name}` (cap) here, retunable from the profile without a code release.
 *
 * Every field is `.volatile()`, so a profile edit lands on the next call rather
 * than on the next restart. That is the whole point of reading them through
 * {@link ./bounds.ts} at use time instead of snapshotting them here.
 *
 * @module @jie2gg/dsh-plugin-ssh/config
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/**
 * A whole positive number of bytes. Schemastery has no `.int()`: `natural` is the
 * non-negative integer, and `min(1)` moves the zero out of it.
 */
const bytes = z.natural().min(1)

/** A whole positive number of milliseconds, within what a Node timer can hold. */
const ms = z.natural().min(1).max(2_147_483_647)

/** A whole positive count of files; the schema bound is a sanity ceiling, not the policy. */
const files = z.natural().min(1).max(1_000_000)

/**
 * A whole positive count of concurrent transfers; 16 is every operation slot the
 * plugin can hand out at once, which is the only ceiling this number can have.
 */
const lanes = z.natural().min(1).max(16)

/**
 * Bounds as this plugin reads them, every one a live value.
 *
 * `@deepseek-ai/cordis` brands volatile fields as {@link Volatile}, so a reader
 * has to ask for the current value; that is deliberate — a snapshot taken at
 * activation would silently keep last week's cap.
 */
export interface SshConfig {
  /** Default deadline for one foreground remote command, in milliseconds. */
  timeoutMs: Volatile<number>
  /**
   * Cap on any command deadline, whether the page stored it or a call asked for it.
   *
   * Live for every call, with one exception worth naming rather than hiding: the
   * plugin also declares a **tool call** budget to the harness (`maxTimeoutMs` plus
   * the kill grace, the drain, and slack), and that declaration is fixed when the
   * tool registers. Raising this cap above the default therefore needs a Host
   * restart before a call is allowed to run the whole longer distance; until then
   * the harness wrapper answers first, at the budget the running Host registered.
   */
  maxTimeoutMs: Volatile<number>
  /** Default per-stream capture ceiling, in bytes. */
  outputBytes: Volatile<number>
  /** Cap on any per-stream capture ceiling. */
  maxOutputBytes: Volatile<number>
  /** Cap on the full-stream spill file a capped capture leaves behind; 0 disables spilling. */
  maxSpillBytes: Volatile<number>
  /** Default ceiling for one file transfer, in bytes. */
  transferBytes: Volatile<number>
  /** Cap on any transfer ceiling. */
  maxTransferBytes: Volatile<number>
  /**
   * Default whole-budget deadline for one file transfer, in milliseconds.
   *
   * Transfers do not borrow the 30 s command default: a copy of a permitted file
   * over a slow link is the one call that legitimately runs for minutes, and a
   * command deadline that killed it would kill it mid-stream. This is the default
   * for the whole `scp` child, pre-check round trip included; a call may still
   * ask for longer, up to {@link maxTransferTimeoutMs}.
   */
  transferTimeoutMs: Volatile<number>
  /** Cap on any transfer deadline, whether stored or asked. */
  maxTransferTimeoutMs: Volatile<number>
  /**
   * Cap on how many files one recursive upload may carry.
   *
   * A pre-check bound, not a hard limit: it counts what the local tree holds at
   * the moment the walk runs, so a directory that grows during the copy can still
   * push more files through `scp -r`.
   */
  maxTransferFiles: Volatile<number>
  /**
   * Cap on the cumulative bytes one recursive upload may carry, in bytes.
   *
   * The same pre-check caveat as {@link maxTransferFiles}: the total is the sum
   * of the `stat` sizes at walk time, not a gate on the bytes that move.
   */
  maxTransferTotalBytes: Volatile<number>
  /**
   * How many file transfers may occupy a child slot at once, out of the
   * plugin's total concurrent-operation ceiling. Reserving capacity this way is
   * what keeps two 500 MiB copies from starving every other call.
   */
  maxConcurrentTransfers: Volatile<number>
  /**
   * How many background jobs may hold a child slot at once.
   *
   * A job arms no timer — it runs until it settles, is killed, or loses its
   * conversation — so it can hold one of the 16 operation slots indefinitely.
   * The ceiling reserves the rest for foreground calls: even with the job
   * allowance full, eight slots always stay open for interactive work. Commands
   * that merely *might* promote (a foreground run that outlives its window) are
   * not counted against it; only jobs started with `background: true` are.
   */
  maxRunningJobs: Volatile<number>
  /** Deadline for one connectivity probe, in milliseconds. */
  probeTimeoutMs: Volatile<number>
  /** Deadline for the size-and-type pre-check one download asks, in milliseconds. */
  statTimeoutMs: Volatile<number>
  /** Hand a foreground command that runs out of time to the job registry instead of killing it. */
  promoteOnTimeout: Volatile<boolean>
  /** Grace a child gets between SIGTERM and SIGKILL before it is given up on, in milliseconds. */
  graceMs: Volatile<number>
}

/**
 * The defaults, stated once and named so a reader of the settings page can tell a
 * default from a cap.
 *
 * The command default stays at 30 s rather than borrowing bash's 120 s: a remote
 * command pays for a network round trip bash does not have, and the page's own
 * reader asked for the shorter number. The cap stays 300 s, which is also the
 * ceiling this plugin's tool call budget is built against (`maxTimeoutMs` plus the
 * drain and kill grace, pinned by a test in `tool.ts`'s own shape).
 */
export const DEFAULTS = {
  timeoutMs: 30_000,
  maxTimeoutMs: 300_000,
  outputBytes: 65_536,
  maxOutputBytes: 4_194_304,
  maxSpillBytes: 67_108_864,
  transferBytes: 33_554_432,
  maxTransferBytes: 536_870_912,
  // A transfer gets its own clock: five minutes by default, thirty at the cap —
  // long enough for a permitted file over a real link, short enough that a dead
  // connection does not hold a lane for an hour.
  transferTimeoutMs: 300_000,
  maxTransferTimeoutMs: 1_800_000,
  maxTransferFiles: 500,
  maxTransferTotalBytes: 536_870_912,
  // Two copies at once, so the 16 operation slots keep room for commands even
  // while big files are moving. Half the ceiling for jobs: an explicitly
  // backgrounded command can hold its slot forever, and eight such jobs must
  // never be able to busy-lock the plugin.
  maxConcurrentTransfers: 2,
  maxRunningJobs: 8,
  probeTimeoutMs: 30_000,
  statTimeoutMs: 10_000,
  promoteOnTimeout: true,
  graceMs: 2_000,
} as const

/** One row of the settings card: the default, the cap, and what is applied now. */
export const Config = z.object({
  timeoutMs: ms.default(DEFAULTS.timeoutMs).volatile(),
  maxTimeoutMs: ms.default(DEFAULTS.maxTimeoutMs).volatile(),
  outputBytes: bytes.default(DEFAULTS.outputBytes).volatile(),
  maxOutputBytes: bytes.default(DEFAULTS.maxOutputBytes).volatile(),
  maxSpillBytes: z.natural().default(DEFAULTS.maxSpillBytes).volatile(),
  transferBytes: bytes.default(DEFAULTS.transferBytes).volatile(),
  maxTransferBytes: bytes.default(DEFAULTS.maxTransferBytes).volatile(),
  transferTimeoutMs: ms.default(DEFAULTS.transferTimeoutMs).volatile(),
  maxTransferTimeoutMs: ms.default(DEFAULTS.maxTransferTimeoutMs).volatile(),
  maxTransferFiles: files.default(DEFAULTS.maxTransferFiles).volatile(),
  maxTransferTotalBytes: bytes.default(DEFAULTS.maxTransferTotalBytes).volatile(),
  maxConcurrentTransfers: lanes.default(DEFAULTS.maxConcurrentTransfers).volatile(),
  maxRunningJobs: lanes.default(DEFAULTS.maxRunningJobs).volatile(),
  probeTimeoutMs: ms.default(DEFAULTS.probeTimeoutMs).volatile(),
  statTimeoutMs: ms.default(DEFAULTS.statTimeoutMs).volatile(),
  promoteOnTimeout: z.boolean().default(DEFAULTS.promoteOnTimeout).volatile(),
  graceMs: ms.default(DEFAULTS.graceMs).volatile(),
})
