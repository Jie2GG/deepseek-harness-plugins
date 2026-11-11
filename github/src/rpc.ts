/** HTTP face of the GitHub plugin: one `/api/github/rpc` route the settings page can call. @module dsh-plugin-github/rpc */

import type { GithubOps } from './ops.ts'
import { optionalScopes, requireCommand, requireHost, requireProtocol, requireToken } from './ops.ts'
import type { RpcMethod, RpcParams, RpcResult } from './types.ts'
import { GhError, RPC_METHODS } from './types.ts'

/** HTTP status each refusal code answers with, so a command-line caller can tell retryable from wrong. */
const STATUS_OF: Record<string, number> = {
  'bad-input': 400,
  'gh-missing': 424,
  'gh-failed': 502,
  timeout: 408,
  network: 502,
  checksum: 502,
  extract: 500,
  permission: 500,
  'unsupported-platform': 400,
  busy: 409,
  'config-rejected': 400,
  internal: 500,
}

/** Methods a plain GET may reach; everything that changes state needs a POST body. */
const READ_ONLY: readonly RpcMethod[] = ['status', 'authStatus', 'releaseCheck', 'jobPoll']

/**
 * Read one required job id from RPC parameters.
 * @param params - request parameters.
 * @returns the job id.
 * @throws {GhError} `bad-input` when it is missing or not text.
 */
function requireJobId(params: RpcParams): string {
  const id = params.id ?? params.jobId
  if (typeof id !== 'string' || id.trim() === '') throw new GhError('bad-input', 'A job id is required.')
  return id.trim()
}

/**
 * Run one RPC method against the operations object.
 * @param ops - the activation's operations.
 * @param method - validated method name.
 * @param params - validated-as-used parameters.
 * @returns the method's result value.
 */
async function dispatch(ops: GithubOps, method: RpcMethod, params: RpcParams): Promise<unknown> {
  switch (method) {
    case 'status':
      return await ops.status()
    case 'authStatus':
      return await ops.authStatus()
    case 'authToken':
      return await ops.authToken(stringOrUndefined(params.host), stringOrUndefined(params.user))
    case 'authLoginToken':
      return await ops.authLoginToken(
        requireToken(params.token),
        requireHost(stringOrUndefined(params.host)),
        requireProtocol(stringOrUndefined(params.gitProtocol)),
        optionalScopes(params.scopes),
      )
    case 'authLoginWeb':
      return await ops.authLoginWeb(
        requireHost(stringOrUndefined(params.host)),
        requireProtocol(stringOrUndefined(params.gitProtocol)),
        optionalScopes(params.scopes),
      )
    case 'authLogout':
      return await ops.authLogout(requireHost(stringOrUndefined(params.host)), stringOrUndefined(params.user))
    case 'authSwitch':
      return await ops.authSwitch(requireHost(stringOrUndefined(params.host)), requireUser(params.user))
    case 'releaseCheck':
      return await ops.releaseCheck()
    case 'installStart':
      return await ops.installStart()
    case 'removeManaged':
      return await ops.removeManaged()
    case 'configUpdate':
      return await ops.configUpdate(requireCommand(params.command === undefined ? null : params.command))
    case 'jobPoll':
      return await ops.jobPoll(requireJobId(params))
    case 'jobCancel':
      return await ops.jobCancel(requireJobId(params))
  }
}

/**
 * Read one optional string parameter.
 * @param value - whatever the page sent.
 * @returns the value when it is usable text, otherwise `undefined`.
 */
function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Read one required account name.
 * @param value - whatever the page sent.
 * @returns the trimmed name.
 * @throws {GhError} `bad-input` when it is absent.
 */
function requireUser(value: unknown): string {
  const user = stringOrUndefined(value)
  if (user === undefined) throw new GhError('bad-input', 'An account name is required.')
  return user.trim()
}

/**
 * Serialize one answer, keeping the same envelope for successes and refusals.
 * @param body - the envelope to send.
 * @param status - HTTP status to answer with.
 * @returns the response the shared `/api` channel forwards to the page.
 */
function answer(body: RpcResult<unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

/**
 * Create the Fetch handler for one plugin activation.
 * @param ops - the operations this activation serves.
 * @returns a handler the connection's `/api` channel can register.
 */
export function createRpcHandler(ops: GithubOps): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let method: string
    let params: RpcParams = {}
    try {
      if (request.method === 'GET') {
        const query = new URL(request.url).searchParams
        method = query.get('method') ?? 'status'
        for (const [key, value] of query.entries()) if (key !== 'method') params[key] = value
      } else {
        const body: unknown = await request.json().catch((): Record<string, unknown> => ({}))
        if (typeof body !== 'object' || body === null) throw new GhError('bad-input', 'The request body must be a JSON object.')
        const record = body as { method?: unknown; params?: unknown }
        method = typeof record.method === 'string' ? record.method : ''
        params = typeof record.params === 'object' && record.params !== null ? { ...(record.params as RpcParams) } : {}
      }
      if (!(RPC_METHODS as readonly string[]).includes(method)) {
        throw new GhError('bad-input', `Unknown method "${method}".`, `Use one of: ${RPC_METHODS.join(', ')}.`)
      }
      const rpcMethod = method as RpcMethod
      if (request.method === 'GET' && !READ_ONLY.includes(rpcMethod)) {
        throw new GhError('bad-input', `${rpcMethod} needs POST with a JSON body.`, 'Only status, authStatus, releaseCheck, and jobPoll answer GET.')
      }
      const result = await dispatch(ops, rpcMethod, params)
      return answer({ ok: true, result }, 200)
    } catch (error) {
      if (error instanceof GhError) {
        return answer({ ok: false, error: { code: error.code, message: error.message, ...error.hint === undefined ? {} : { hint: error.hint } } }, STATUS_OF[error.code] ?? 400)
      }
      return answer({ ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }, 500)
    }
  }
}
