/**
 * GitHub CLI plugin — scaffold only in 0.1.0.
 *
 * The plugin activates and registers nothing: no agent tool, no command
 * execution, no Config fields, no Client surface. It exists so the capability
 * can be filled in behind a bundle layout that already satisfies the
 * repository's plugin spec.
 *
 * @module @jie2gg/dsh-plugin-github
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'github'

/**
 * Activate the plugin. Intentionally inert until the GitHub CLI capability lands.
 *
 * @param ctx - Host plugin context, unused by the 0.1.0 scaffold.
 */
export function apply(ctx: Context): void {
  void ctx
}
