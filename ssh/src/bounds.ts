/**
 * One place that turns the plugin's bounds into the number a call actually runs
 * with.
 *
 * Three layers can name a bound: the config default, the value the settings page
 * stored for this profile, and the value one call asked for. This module owns the
 * order (`call` beats `stored` beats `default`) and the one rule the harness
 * applies at every layer: a number that merely exceeds a cap is **capped**, not
 * refused, and the effective value is what comes back — so the caller and the
 * reader are both told what actually ran, instead of discovering the cap through a
 * failed save. Only a value that is not a positive finite number is an error at
 * all, because that is not a bound being reached but a value with no meaning.
 *
 * Before this module the plugin carried two-sided ranges (`1 s – 300 s` and
 * friends) enforced with `.min().max()` rejections, which is a shape no harness
 * tool uses; {@link ./config.ts} holds the default-plus-cap half, and this file
 * holds the ordering, the capping, and the trail of what it corrected.
 *
 * @module @jie2gg/dsh-plugin-ssh/bounds
 */

import { clampTimeout } from '@deepseek-ai/dsh-timeout'
import { DEFAULTS, type SshConfig } from './config.ts'
import { FOREGROUND_RESERVED_OPS, MAX_CONCURRENT_OPS, MAX_JOB_LANES } from './storage.ts'
import { SshError } from './types.ts'
import type { SshSettings, StoredSettings } from './types.ts'

/**
 * The bounds an assembly without a configuration runs under: the published
 * defaults, and nothing to correct.
 *
 * Exported for that one reason — a test, or a profile that mounted the plugin row
 * with no `config:` at all — so the numbers never come from a second copy of the
 * list, and a cap defaults to the same height as its default rather than to a
 * number someone remembered.
 * @returns the bounds built from {@link DEFAULTS}.
 */
export function defaultBounds(): Bounds {
  return {
    timeoutMs: DEFAULTS.timeoutMs,
    maxTimeoutMs: DEFAULTS.maxTimeoutMs,
    outputBytes: DEFAULTS.outputBytes,
    maxOutputBytes: DEFAULTS.maxOutputBytes,
    maxSpillBytes: DEFAULTS.maxSpillBytes,
    transferBytes: DEFAULTS.transferBytes,
    maxTransferBytes: DEFAULTS.maxTransferBytes,
    transferTimeoutMs: DEFAULTS.transferTimeoutMs,
    maxTransferTimeoutMs: DEFAULTS.maxTransferTimeoutMs,
    maxTransferFiles: DEFAULTS.maxTransferFiles,
    maxTransferTotalBytes: DEFAULTS.maxTransferTotalBytes,
    maxConcurrentTransfers: DEFAULTS.maxConcurrentTransfers,
    maxRunningJobs: DEFAULTS.maxRunningJobs,
    probeTimeoutMs: DEFAULTS.probeTimeoutMs,
    statTimeoutMs: DEFAULTS.statTimeoutMs,
    promoteOnTimeout: DEFAULTS.promoteOnTimeout,
    graceMs: DEFAULTS.graceMs,
    notes: [],
  }
}

/** A bound as this call sees it: the default, the cap, and what is live right now. */
export interface Bounds {
  readonly timeoutMs: number
  readonly maxTimeoutMs: number
  readonly outputBytes: number
  readonly maxOutputBytes: number
  readonly maxSpillBytes: number
  readonly transferBytes: number
  readonly maxTransferBytes: number
  /** Default whole-budget deadline for one file transfer. */
  readonly transferTimeoutMs: number
  /** Cap on any transfer deadline. */
  readonly maxTransferTimeoutMs: number
  /** Pre-check cap on the file count of one recursive upload. */
  readonly maxTransferFiles: number
  /** Pre-check cap on the cumulative bytes of one recursive upload. */
  readonly maxTransferTotalBytes: number
  /** How many file transfers may hold an operation slot at once. */
  readonly maxConcurrentTransfers: number
  /**
   * How many background jobs may hold an operation slot at once, after this module
   * clamped what the profile asked for to {@link MAX_JOB_LANES}: a job can outlive
   * every clock this plugin arms, so {@link FOREGROUND_RESERVED_OPS} of the
   * {@link MAX_CONCURRENT_OPS} slots are never a job's to take.
   */
  readonly maxRunningJobs: number
  readonly probeTimeoutMs: number
  readonly statTimeoutMs: number
  readonly promoteOnTimeout: boolean
  readonly graceMs: number
  /**
   * What this read had to correct in the profile's own configuration, in the words
   * a reader of the settings page needs. A cap set below a default is a mistake
   * worth naming rather than one worth silently honouring.
   */
  readonly notes: readonly string[]
}

/**
 * Read the live bounds out of the plugin's config.
 *
 * Volatile by design: a profile edit lands on the next call, so this is read per
 * resolution and never cached across calls.
 * @param config - the validated plugin configuration.
 * @returns the bounds, with any correction the config needed.
 */
export function readBounds(config: SshConfig): Bounds {
  const notes: string[] = []
  const pair = (label: string, def: number, max: number): readonly [number, number] => {
    if (max >= def) return [def, max] as const
    notes.push(`${label}: the configured cap ${String(max)} is below the default ${String(def)}, so this plugin raised it to the default`)
    return [def, def] as const
  }
  const [timeoutMs, maxTimeoutMs] = pair('timeoutMs', config.timeoutMs.get(), config.maxTimeoutMs.get())
  const [outputBytes, maxOutputBytes] = pair('outputBytes', config.outputBytes.get(), config.maxOutputBytes.get())
  const [transferBytes, maxTransferBytes] = pair('transferBytes', config.transferBytes.get(), config.maxTransferBytes.get())
  const [transferTimeoutMs, maxTransferTimeoutMs] = pair('transferTimeoutMs', config.transferTimeoutMs.get(), config.maxTransferTimeoutMs.get())
  // A job lane has a ceiling the profile does not get to choose: a background job can
  // hold its operation slot for the life of a conversation, so `MAX_JOB_LANES` of the
  // `MAX_CONCURRENT_OPS` slots are what jobs may ever occupy and the rest are held
  // back for calls a reader is waiting on. Asking above it is corrected here, in the
  // same voice every other correction in this file uses, so the settings page prints
  // the number the transport will actually run with rather than the one a profile
  // hoped for — and `transport.ts` clamps the same way again where the slot is taken.
  const jobLane = (label: string, asked: number, ceiling: number): number => {
    const value = Math.min(ceiling, Math.max(1, asked))
    if (value !== asked) {
      notes.push(`${label}: the configured ${String(asked)} is outside the range 1 to ${String(ceiling)}, and this plugin runs it as ${String(value)} — ${String(FOREGROUND_RESERVED_OPS)} of the ${String(MAX_CONCURRENT_OPS)} operation slots stay held back for foreground calls`)
    }
    return value
  }
  return {
    timeoutMs,
    maxTimeoutMs,
    outputBytes,
    maxOutputBytes,
    maxSpillBytes: Math.max(0, config.maxSpillBytes.get()),
    transferBytes,
    maxTransferBytes,
    transferTimeoutMs,
    maxTransferTimeoutMs,
    maxTransferFiles: Math.max(1, config.maxTransferFiles.get()),
    maxTransferTotalBytes: Math.max(1, config.maxTransferTotalBytes.get()),
    maxConcurrentTransfers: Math.min(MAX_CONCURRENT_OPS, Math.max(1, config.maxConcurrentTransfers.get())),
    maxRunningJobs: jobLane('maxRunningJobs', config.maxRunningJobs.get(), MAX_JOB_LANES),
    probeTimeoutMs: config.probeTimeoutMs.get(),
    statTimeoutMs: config.statTimeoutMs.get(),
    promoteOnTimeout: config.promoteOnTimeout.get(),
    graceMs: config.graceMs.get(),
    notes,
  }
}

/** Which layer supplied an effective value. */
export type ValueSource = 'call' | 'stored' | 'default'

/** One resolved bound, with the trail needed to say what happened out loud. */
export interface ResolvedValue {
  /** The number to run with. */
  readonly value: number
  /** Which layer it came from. */
  readonly source: ValueSource
  /** True when that layer sat above the cap and came down to it. */
  readonly capped: boolean
  /** The layer's value before capping, present only when it was capped. */
  readonly asked?: number
  /** The cap that applied, always stated so a reader can act on the capping. */
  readonly cap: number
}

/**
 * Resolve one bound across the three layers.
 * @param label - the knob's name, used in a refusal so a reader knows which field.
 * @param def - the config default.
 * @param max - the config cap the result is held to.
 * @param stored - the value the settings page stored for this profile, if any.
 * @param requested - the value this call asked for, if any.
 * @returns the effective value and what it took to get there.
 * @throws {SshError} `bad-input` naming this field, for a value with no meaning.
 */
function resolve(label: string, def: number, max: number, stored?: number, requested?: number): ResolvedValue {
  const layer = requested ?? stored
  let value: number
  try {
    value = clampTimeout(layer, def, max, `ssh.${label}`)
  } catch (error: unknown) {
    // Not a bound being reached — a value with no meaning. The hint is the part
    // that matters here: the old behaviour rejected an over-cap number too, and a
    // reader who has learned the new rule needs to be told where the line is.
    throw new SshError('bad-input', error instanceof Error ? error.message : String(error), {
      field: label,
      hint: `Any positive number of milliseconds is accepted; one above ${String(max)} is capped to it. Omit the field to take the default of ${String(def)}.`,
    })
  }
  if (layer === undefined) return { value, source: 'default', capped: false, cap: max }
  const capped = layer > max
  return {
    value,
    source: requested !== undefined ? 'call' : 'stored',
    capped,
    ...(capped ? { asked: layer } : {}),
    cap: max,
  }
}

/**
 * The deadline for one remote command: per-call override, then the page's stored
 * value, then the config default, capped at `maxTimeoutMs`.
 * @param bounds - the live bounds.
 * @param stored - the profile's stored default.
 * @param requested - what this call asked for.
 * @returns the effective deadline.
 */
export function resolveDeadline(bounds: Bounds, stored?: number, requested?: number): ResolvedValue {
  return resolve('timeoutMs', bounds.timeoutMs, bounds.maxTimeoutMs, stored, requested)
}

/**
 * The per-stream capture ceiling for one call.
 * @param bounds - the live bounds.
 * @param stored - the profile's stored default.
 * @param requested - what this call asked for.
 * @returns the effective ceiling.
 */
export function resolveOutputBytes(bounds: Bounds, stored?: number, requested?: number): ResolvedValue {
  return resolve('maxOutputBytes', bounds.outputBytes, bounds.maxOutputBytes, stored, requested)
}

/**
 * The transfer ceiling for one copy.
 * @param bounds - the live bounds.
 * @param stored - the profile's stored default.
 * @param requested - what this call asked for.
 * @returns the effective ceiling.
 */
export function resolveTransferBytes(bounds: Bounds, stored?: number, requested?: number): ResolvedValue {
  return resolve('maxTransferBytes', bounds.transferBytes, bounds.maxTransferBytes, stored, requested)
}

/**
 * The whole-budget deadline for one file transfer.
 *
 * A transfer carries its own clock: the command default (30 s) would kill a
 * permitted copy of a large file mid-stream on any slow link, which is exactly
 * the half-written payload the temp-file dance exists to avoid. The call's
 * `timeoutMs` lands here too, read as "how long to wait for the copy", and the
 * config cap holds it to `maxTransferTimeoutMs`.
 * @param bounds - the live bounds.
 * @param requested - what this call asked for, if anything.
 * @returns the effective transfer deadline and what it took to get there.
 */
export function resolveTransferDeadline(bounds: Bounds, requested?: number): ResolvedValue {
  return resolve('transferTimeoutMs', bounds.transferTimeoutMs, bounds.maxTransferTimeoutMs, undefined, requested)
}

/**
 * One short sentence naming what a resolution corrected, for the tail of a result
 * a reader is already looking at. Kept objective — the value and the cap, no
 * advice — because advice belongs in the card and the tool description.
 * @param label - what was capped, in the words a reader knows it by.
 * @param resolved - the resolution that capped it.
 * @returns the sentence, or `undefined` when nothing was capped.
 */
export function cappedNote(label: string, resolved: ResolvedValue): string | undefined {
  if (!resolved.capped || resolved.asked === undefined) return undefined
  return `${label} asked for ${String(resolved.asked)} and was capped to ${String(resolved.value)}`
}

/** The layers a ceiling may arrive from, most specific first. */
export interface CeilingLayers {
  /** What the settings page stored for this profile; absent keys follow the config default. */
  readonly stored?: StoredSettings | undefined
  /** What the resolved target carries for itself. */
  readonly target?: { readonly remoteTimeoutMs?: number | undefined; readonly maxOutputBytes?: number | undefined } | undefined
  /** What this call asked for. */
  readonly call?: {
    readonly timeoutMs?: number | undefined
    readonly maxOutputBytes?: number | undefined
    readonly maxBytes?: number | undefined
  } | undefined
}

/** A resolved set of ceilings, plus the receipts for what had to be corrected. */
export interface ResolvedSettings {
  readonly settings: SshSettings
  readonly notes: readonly string[]
}

/**
 * Resolve every ceiling one call runs under.
 *
 * This is the only place the layering is stated, and it replaced four hand-written
 * spreads in `ops.ts` that each re-decided which override won. Order is call, then
 * target, then the profile's stored value, then the config default; the config cap
 * sits over all four, and anything it pulled down is recorded in `notes` so a
 * reader is told what actually applied rather than being left to assume their
 * number was used.
 * @param bounds - the live bounds read from config.
 * @param layers - the overrides on offer, in any combination.
 * @returns the ceilings to hand the transport, and the notes to show alongside.
 */
export function resolveSettings(bounds: Bounds, layers: CeilingLayers = {}): ResolvedSettings {
  const notes: string[] = [...bounds.notes]
  const settled = (label: string, resolved: ResolvedValue): number => {
    const note = cappedNote(label, resolved)
    if (note !== undefined && !notes.includes(note)) notes.push(note)
    return resolved.value
  }
  const stored = layers.stored ?? {}
  const target = layers.target ?? {}
  const call = layers.call ?? {}
  return {
    settings: {
      remoteTimeoutMs: settled('command timeout', resolveDeadline(bounds, target.remoteTimeoutMs ?? stored.remoteTimeoutMs, call.timeoutMs)),
      maxOutputBytes: settled('output ceiling', resolveOutputBytes(bounds, target.maxOutputBytes ?? stored.maxOutputBytes, call.maxOutputBytes)),
      maxTransferBytes: settled('transfer ceiling', resolveTransferBytes(bounds, stored.maxTransferBytes, call.maxBytes)),
      transferTimeoutMs: settled('transfer timeout', resolveTransferDeadline(bounds, call.timeoutMs)),
      maxTransferFiles: bounds.maxTransferFiles,
      maxTransferTotalBytes: bounds.maxTransferTotalBytes,
      maxConcurrentTransfers: bounds.maxConcurrentTransfers,
      maxRunningJobs: bounds.maxRunningJobs,
      probeTimeoutMs: bounds.probeTimeoutMs,
      statTimeoutMs: bounds.statTimeoutMs,
      maxSpillBytes: bounds.maxSpillBytes,
      graceMs: bounds.graceMs,
    },
    notes,
  }
}
