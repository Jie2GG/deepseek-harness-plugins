/**
 * SSH target manager — Host half.
 *
 * The plugin owns one storage domain (`ssh_targets`) and one browser route
 * (`/api/ssh/rpc`); the settings page in `src/client.ts` is its only surface.
 * Nothing is written to the user's profile patch file, and saving never
 * restarts this plugin: the domain absorbs every change.
 *
 * @module @jie2gg/dsh-plugin-ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-subprocess'
import { sshTargetsDomain } from './storage.ts'
import { TargetStore } from './store.ts'
import { SshRunner } from './ssh.ts'
import { createOps } from './ops.ts'
import { createRpcHandler } from './rpc.ts'
import { RPC_ROUTE_PATH, SshError } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'ssh'

/**
 * Services this plugin needs. Each one is a hard requirement because the
 * settings page is the plugin's only product surface: a profile without the
 * `/api` carrier, the subprocess provider, or the domain facility has nothing
 * for this plugin to do, so the plugin stays inactive there instead of throwing.
 */
export const inject = ['connection', 'subprocess', 'storageDomain'] as const

/**
 * Activate the plugin: open the storage domain, then publish the route the
 * settings page calls.
 *
 * @param ctx - Host plugin context carrying `connection`, `subprocess`, and
 *   `storageDomain`.
 */
export function apply(ctx: Context): void {
  const runner = new SshRunner(ctx)

  let store: TargetStore | undefined
  let openFailure: string | undefined
  const opened: Promise<TargetStore> = ctx.storageDomain.open(sshTargetsDomain).then(
    domain => {
      const next = new TargetStore(domain)
      store = next
      return next
    },
    (error: unknown) => {
      openFailure = error instanceof Error ? error.message : String(error)
      ctx.logger.error(`ssh: the ${sshTargetsDomain.name} storage domain could not open: ${openFailure}`)
      throw error
    },
  )
  // The rejection is surfaced per request; do not also leave it unhandled.
  void opened.catch(() => undefined)

  const requireStore = async (): Promise<TargetStore> => {
    if (store !== undefined) return store
    try {
      return await opened
    } catch {
      throw new SshError('storage-error', 'This plugin cannot reach its stored SSH connections.', {
        hint: openFailure === undefined ? 'Check the Host log for the storage failure.' : openFailure.slice(0, 512),
      })
    }
  }

  const ops = createOps({ runner, store: requireStore })
  const handler = createRpcHandler(ops)

  ctx.effect(() => {
    const api = ctx.connection.fetch
    if (api === undefined) {
      ctx.logger.warn(`ssh: this transport exposes no /api fetch channel, so the ${RPC_ROUTE_PATH} route stays unavailable`)
      return (): void => {
        runner.dispose()
      }
    }
    const dispose = api.register({
      path: RPC_ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: handler,
    })
    return async (): Promise<void> => {
      runner.dispose()
      await dispose()
    }
  }, `ssh: ${RPC_ROUTE_PATH}`)

  ctx.effect(() => async (): Promise<void> => {
    const current = store
    if (current === undefined) {
      // The domain may still be opening; closing it as soon as it lands is the
      // facility's own job, so a late open here needs no second disposer.
      await opened.catch(() => undefined)
    }
    await store?.close()
  }, `ssh: ${sshTargetsDomain.name} domain`)
}
