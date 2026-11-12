/**
 * SSH target manager — Host half.
 *
 * The plugin owns three pieces of state: a storage domain for the target list
 * and its settings, credential records for the passwords and passphrases, and a
 * private askpass helper that lets a spawned `ssh` answer a prompt without a
 * terminal. Its only surface is the settings page, which reaches all three over
 * one browser route.
 *
 * @module @jie2gg/dsh-plugin-ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-subprocess'
import { sshTargetsDomain } from './storage.ts'
import { TargetStore } from './store.ts'
import { TargetSecrets } from './secrets.ts'
import { AskPassHelper } from './askpass.ts'
import { SshRunner } from './ssh.ts'
import { createOps } from './ops.ts'
import { createRpcHandler } from './rpc.ts'
import { RPC_ROUTE_PATH, SshError } from './types.ts'

/** Cordis plugin name used by loader diagnostics, and the credential scope. */
export const name = 'ssh'

/**
 * Services this plugin needs. Each one is a hard requirement because the
 * settings page is the plugin's only product surface: a profile without the
 * `/api` carrier, a subprocess provider, the domain facility, or the credential
 * store has nothing for this plugin to do, so it stays inactive there instead of
 * throwing.
 */
export const inject = ['connection', 'subprocess', 'storageDomain', 'credentials'] as const

/**
 * Activate the plugin: open the storage domain, prepare the askpass helper, then
 * publish the route the settings page calls.
 *
 * @param ctx - Host plugin context carrying `connection`, `subprocess`,
 *   `storageDomain`, and `credentials`.
 */
export function apply(ctx: Context): void {
  const askpass = new AskPassHelper()
  const runner = new SshRunner(ctx, askpass)
  const secrets = new TargetSecrets(ctx.credentials)

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

  const ops = createOps({
    runner,
    store: requireStore,
    secrets: () => secrets,
    askpass: () => ({ ready: askpass.ready, ...(askpass.failure === undefined ? {} : { failure: askpass.failure }) }),
  })
  const handler = createRpcHandler(ops)

  ctx.effect(async () => {
    const helper = await askpass.prepare()
    if (helper === undefined) {
      ctx.logger.warn(`ssh: no askpass helper could be prepared, so a stored password or passphrase cannot be used: ${askpass.failure ?? 'unknown reason'}`)
    }
    return async () => {
      await askpass.dispose()
    }
  }, 'ssh: askpass helper')

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
    if (store === undefined) {
      // The domain may still be opening; the facility closes any domain it opens
      // when it unmounts, so a late open needs no second disposer.
      await opened.catch(() => undefined)
    }
    await store?.close()
  }, `ssh: ${sshTargetsDomain.name} domain`)
}
