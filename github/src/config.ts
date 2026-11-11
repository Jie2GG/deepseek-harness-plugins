/** Plugin configuration: the `gh` executable, its deadlines, and its output bounds. @module dsh-plugin-github/config */

import z from '@deepseek-ai/schemastery'

/** User-tunable settings of this plugin. Every field is optional; omission selects the default. */
export interface Config {
  /** `gh` executable name or absolute path. Defaults to `gh` resolved through `PATH`. */
  command?: string
  /** Milliseconds a single `gh` call may run. Defaults to 30000, clamped to 1000–300000. */
  timeoutMs?: number
  /** Bytes captured per `gh` output stream. Defaults to 65536, clamped to 1024–4194304. */
  maxOutputBytes?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  command: z.string(),
  timeoutMs: z.number(),
  maxOutputBytes: z.number(),
})

/** Default executable name, resolved through `PATH`. */
export const DEFAULT_COMMAND = 'gh'

/** Default deadline for one ordinary `gh` call, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Default captured bytes for one `gh` output stream. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024

/** Smallest accepted deadline; anything shorter cannot complete a local `gh` call. */
export const MIN_TIMEOUT_MS = 1_000

/** Largest accepted deadline; longer work belongs to a plugin job, not one call. */
export const MAX_TIMEOUT_MS = 300_000

/** Smallest accepted output window, in bytes. */
export const MIN_OUTPUT_BYTES = 1_024

/** Largest accepted output window, in bytes. */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** Deadline for a device-code sign-in job, which waits for the user's browser. */
export const LOGIN_JOB_TIMEOUT_MS = 5 * 60_000

/** Timeout for one downloaded-archive extraction. */
export const EXTRACT_TIMEOUT_MS = 120_000

/** Configuration with every default applied and every value clamped into range. */
export interface ResolvedConfig {
  command: string
  timeoutMs: number
  maxOutputBytes: number
  /** True when the row set `command` itself, which the page shows as the reason for the active path. */
  commandExplicit: boolean
}

/**
 * Clamp one integer into an inclusive range, keeping the fallback for a non-finite value.
 * @param value - configured value, possibly absent or out of range.
 * @param fallback - value used when nothing usable was configured.
 * @param min - lower bound, inclusive.
 * @param max - upper bound, inclusive.
 * @returns the integer to run with.
 */
function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Apply defaults and bounds to the configured values of one activation.
 * @param config - validated row configuration, with any field absent.
 * @returns the effective configuration every operation runs with.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const configured = typeof config.command === 'string' ? config.command.trim() : ''
  const command = configured === '' ? DEFAULT_COMMAND : configured
  return {
    command,
    commandExplicit: configured !== '',
    timeoutMs: clamp(config.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxOutputBytes: clamp(config.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
  }
}
