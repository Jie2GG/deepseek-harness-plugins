/**
 * SSH target manager — Host half.
 *
 * The plugin owns three pieces of state: a storage domain for the target list
 * and its settings, credential records for the passwords and passphrases, and a
 * private askpass helper that lets a spawned `ssh` answer a prompt without a
 * terminal. Alongside them it holds one transient thing it never persists: the
 * control sockets of the per-target connection pool, which live in a private
 * temporary directory for the length of one activation. Its only surface is the
 * settings page, which reaches all of it over one browser route.
 *
 * @module @jie2gg/dsh-plugin-ssh
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-working-directory'
import { sshTargetsDomain } from './storage.ts'
// `Config` itself is re-exported below for the loader; only its type is used here.
import { type SshConfig } from './config.ts'
import { readBounds } from './bounds.ts'
import { resolveLocalInside } from './local-path.ts'
import type { JobRegistry } from './jobs.ts'
import { effectiveApprovalPolicy } from './approval.ts'
import { TargetStore } from './store.ts'
import { TargetSecrets } from './secrets.ts'
import { AskPassHelper } from './askpass.ts'
import { MuxPool } from './pool.ts'
import { SshTransport } from './transport.ts'
import { createOps } from './ops.ts'
import { registerRemoteTool } from './tool.ts'
import type { RemoteToolDeps, RemoteToolHandle, TargetBrief } from './tool.ts'
import type { TargetSnapshot } from './tool.ts'
import { createRpcHandler } from './rpc.ts'
import { RPC_ROUTE_PATH, SshError } from './types.ts'

/** Cordis plugin name used by loader diagnostics, and the credential scope. */
export const name = 'ssh'

/**
 * The plugin's bounds: a default and a cap per ceiling, every one live. Re-exported
 * from `config.ts` so the bundle row's `config:` keys are validated against it,
 * which is the point — retuning a ceiling is profile configuration, not a code
 * release.
 */
export { Config } from './config.ts'

/**
 * Services this plugin needs. Each one is a hard requirement because the
 * settings page is the plugin's only product surface: a profile without the
 * `/api` carrier, a subprocess provider, the domain facility, or the credential
 * store has nothing for this plugin to do, so it stays inactive there instead of
 * throwing.
 */
export const inject = ['connection', 'subprocess', 'storageDomain', 'credentials', 'tools', 'fs', 'workingDirectory'] as const

/**
 * Activate the plugin: open the storage domain, prepare the askpass helper, then
 * publish the route the settings page calls.
 *
 * @param ctx - Host plugin context carrying `connection`, `subprocess`,
 *   `storageDomain`, and `credentials`.
 * @param config - this plugin's validated bounds, read live on every call rather
 *   than snapshotted here.
 */
export function apply(ctx: Context, config: SshConfig): void {
  const askpass = new AskPassHelper()
  // The pool owns control sockets; the transport owns the children that open and
  // close them, so the pool is handed back the way to say `-O exit`.
  const mux = new MuxPool()
  const runner = new SshTransport(ctx, askpass, mux)
  mux.attach((socketPath, authority) => runner.exitMaster(socketPath, authority))
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
    askpass: () => ({ ready: askpass.ready, ...(askpass.path === undefined ? {} : { path: askpass.path }), ...(askpass.failure === undefined ? {} : { failure: askpass.failure }) }),
    localExists: path => existsLocally(path),
    // Read, not injected: a profile without the job registry still gets the plugin,
    // it simply refuses to background a command there. The cast absorbs the two
    // nominal id types each copy of the jobs package brands its own way.
    jobs: ctx.get('jobs') === undefined ? undefined : (ctx.get('jobs') as unknown as JobRegistry),
    // Read per call, never snapshotted: a volatile config value that was copied at
    // activation would keep last week's cap until the Host restarted.
    bounds: () => readBounds(config),
    // The model chooses between the saved aliases, and the tool's description is
    // frozen at definition time, so an inventory change means re-registering.
    onInventoryChanged: () => { rerenderRemoteTool() },
  })

  /** The agent-facing view of the stored targets, for the gate and for `targets`. */
  const catalog = async (): Promise<TargetSnapshot[]> => {
    const state = await requireStore()
    return state.list().map(row => ({
      id: row.id,
      label: row.label,
      host: row.host,
      ...(row.user === undefined ? {} : { user: row.user }),
      ...(row.port === undefined ? {} : { port: row.port }),
      agentAccess: row.agentAccess,
      allowedCommands: row.allowedCommands,
      pool: row.pool,
    }))
  }
  /** Whether a local path is already taken, asked through the mounted provider. */
  async function existsLocally(localPath: string): Promise<boolean> {
    try {
      return (await ctx.fs.stat(await ctx.fs.resolve(localPath))) !== undefined
    } catch {
      return false
    }
  }

  /** The aliases as the model sees them, cached so a registration is synchronous. */
  let briefs: TargetBrief[] = []
  let handle: RemoteToolHandle | undefined
  let refreshing = false

  /**
   * Re-claim the tool so its description and its `target` hint list the aliases
   * that exist right now.
   * @returns nothing; the work runs on the activation fiber.
   */
  function rerenderRemoteTool(): void {
    if (refreshing) return
    refreshing = true
    void (async () => {
      try {
        try {
          briefs = (await catalog()).map(row => ({
            label: row.label,
            host: row.host,
            ...(row.user === undefined ? {} : { user: row.user }),
          }))
        } catch {
          // A failed read keeps the last list rather than blanking the model's hint.
        }
        handle?.dispose()
        handle = registerRemoteTool(ctx, remoteToolDeps())
      } finally {
        refreshing = false
      }
    })()
  }

  /** The dependencies of one `remote` registration, read at claim time. */
  function remoteToolDeps(): RemoteToolDeps {
    return {
      ops: async () => ops,
    catalog,
    local: {
      async dirOf(exec) {
        const agent = exec.agent
        if (agent === undefined) return undefined
        return await ctx.workingDirectory.ensure(agent as never)
      },
      exists: existsLocally,
      resolve: (localPath, dir) => resolveLocalInside(localPath, dir),
      async writeIntent(localPath, exec) {
        // Same actor, same waterfall the shipped file tool dispatches, and fired
        // before the external writer runs — that is what makes a downloaded file
        // show up in the conversation's change list.
        const target = await ctx.fs.resolve(localPath)
        const intent = await ctx.waterfall('fs/write-intent', target, exec as never, () => undefined)
        const kind = (intent as { kind?: string } | undefined)?.kind
        return kind === 'createIfAbsent' || kind === 'replaceIfVersion' ? { kind } : undefined
      },
    },
      sessionOf: exec => (exec.agent as { id?: string } | undefined)?.id,
      sessionTargetOf: sessionId => store?.getSessionTarget(sessionId)?.targetId,
      targetsOf: () => briefs,
      // Read without injecting: a profile with no approval service must still get the
      // tool, it simply cannot be asked anything.
      approvalPolicyOf: exec => effectiveApprovalPolicy(ctx.get('approval'), exec.agent),
      boundsOf: () => readBounds(config),
    }
  }

  handle = registerRemoteTool(ctx, remoteToolDeps())
  // First read of the inventory lands the real alias list into the description.
  rerenderRemoteTool()
  const handler = createRpcHandler(ops)

  ctx.effect(async () => {
    const helper = await askpass.prepare()
    if (helper === undefined) {
      ctx.logger.warn(`ssh: no askpass helper could be prepared, so a stored password or passphrase cannot be used: ${askpass.failure ?? 'unknown reason'}`)
    }
    const sockets = await mux.prepare()
    if (sockets === undefined) {
      ctx.logger.warn(`ssh: no private directory for control sockets, so calls will not share connections: ${mux.failure ?? 'unknown reason'}`)
    }
    return async () => {
      // Close the masters first: the exits are children, and the askpass helper is
      // the last thing any of them could still need.
      await mux.dispose()
      await askpass.dispose()
    }
  }, 'ssh: askpass helper and connection pool')

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
