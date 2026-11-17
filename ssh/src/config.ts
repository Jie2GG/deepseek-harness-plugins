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
  probeTimeoutMs: ms.default(DEFAULTS.probeTimeoutMs).volatile(),
  statTimeoutMs: ms.default(DEFAULTS.statTimeoutMs).volatile(),
  promoteOnTimeout: z.boolean().default(DEFAULTS.promoteOnTimeout).volatile(),
  graceMs: ms.default(DEFAULTS.graceMs).volatile(),
})
