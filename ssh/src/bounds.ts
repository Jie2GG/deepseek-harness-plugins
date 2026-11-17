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
  return {
    timeoutMs,
    maxTimeoutMs,
    outputBytes,
    maxOutputBytes,
    maxSpillBytes: Math.max(0, config.maxSpillBytes.get()),
    transferBytes,
    maxTransferBytes,
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
 * The probe deadline, which has no stored layer: the page never edited it and the
 * plan is that it stays a rule rather than becoming a fourth field.
 * @param bounds - the live bounds.
 * @returns the deadline one probe waits to.
 */
export function resolveProbeTimeout(bounds: Bounds): number {
  return bounds.probeTimeoutMs
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
      probeTimeoutMs: bounds.probeTimeoutMs,
      statTimeoutMs: bounds.statTimeoutMs,
      maxSpillBytes: bounds.maxSpillBytes,
      graceMs: bounds.graceMs,
    },
    notes,
  }
}
