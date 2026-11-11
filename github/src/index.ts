/**
 * GitHub CLI plugin: manages the `gh` installation and accounts of the machine this
 * Host runs on, and serves the settings page through one `/api/github/rpc` route.
 *
 * The Host half owns every `gh` call and every file write. The browser half
 * (`exports["./client"]`) renders the page and calls this route; no plugin code
 * runs in the browser beyond that.
 *
 * @module @jie2gg/dsh-plugin-github
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-config-editor'
import { Config, resolveConfig } from './config.ts'
import type { Config as GithubConfig } from './config.ts'
import { GhClient } from './gh.ts'
import { GithubInstaller } from './installer.ts'
import { JobTable } from './jobs.ts'
import { createOps } from './ops.ts'
import { createRpcHandler } from './rpc.ts'
import { GhError, RPC_ROUTE_PATH } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'github'

/**
 * Host services this plugin needs. Every one is mounted by the Web and SDK profiles;
 * a composition without them simply leaves this plugin inactive instead of throwing.
 */
export const inject = ['connection', 'subprocess', 'configEditor'] as const

/**
 * Activate the plugin: build the `gh` clients, register the page's route, and own the jobs.
 * @param ctx - Host plugin context.
 * @param config - validated row configuration; see {@link Config}.
 */
export function apply(ctx: Context, config: GithubConfig): void {
  const resolved = resolveConfig(config)
  const gh = new GhClient(ctx, resolved)
  const installer = new GithubInstaller(gh)
  const jobs = new JobTable()
  const entry = ctx.fiber.entry
  const editor = ctx.configEditor

  /**
   * Persist this plugin's own `command` value through the profile config editor.
   * @param command - absolute path or program name, or `null` to fall back to `gh` on `PATH`.
   * @throws {GhError} `config-rejected` when this profile cannot persist the edit.
   */
  const writeCommand = async (command: string | null): Promise<void> => {
    if (entry === undefined || editor === undefined) {
      throw new GhError(
        'config-rejected',
        'This profile cannot save plugin configuration.',
        'Edit the profile patch by hand: the github row, config.command.',
      )
    }
    try {
      await editor.edit(entry, current => {
        const next: Record<string, unknown> = { ...current }
        if (command === null) delete next.command
        else next.command = command
        return next
      })
    } catch (error) {
      throw new GhError(
        'config-rejected',
        `Could not save the gh path: ${(error as Error).message}`,
        'A higher-priority layer such as an agent preset may override this row; edit that layer instead.',
        { cause: error },
      )
    }
  }

  const ops = createOps({ gh, installer, jobs, config: resolved, writeCommand })
  const handler = createRpcHandler(ops)

  ctx.effect(() => {
    const fetch = ctx.connection.fetch
    if (fetch === undefined) {
      ctx.logger.warn('github: this transport exposes no /api fetch channel, so the settings page stays unavailable')
      jobs.dispose()
      return (): void => {}
    }
    const dispose = fetch.register({ path: RPC_ROUTE_PATH, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handler })
    // Disposal of this activation cancels running jobs and then removes the route, so a
    // configuration write never leaves a child process waiting behind a dead route.
    return async (): Promise<void> => {
      jobs.dispose()
      await dispose()
    }
  }, `github: ${RPC_ROUTE_PATH}`)
}

export { Config }
