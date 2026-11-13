/**
 * The browser-facing route handler: one JSON-RPC-shaped endpoint over the
 * shared `/api` channel.
 *
 * A third-party bundle has no Typert generator run, so the page does not get a
 * generated `ctx.remote` namespace; it calls this exact route instead. The
 * channel already carries the Host's trust and authentication policy, so only
 * the owner peer of the served page reaches it.
 *
 * @module @jie2gg/dsh-plugin-ssh/rpc
 */

import { RPC_METHODS, SshError } from './types.ts'
import type { Params } from './ops.ts'
import type { Ops } from './ops.ts'
import type { RpcMethod, SshErrorCode, SshFailure } from './types.ts'

/** HTTP status per failure code. */
const STATUS_OF: Record<SshErrorCode, number> = {
  'bad-input': 400,
  'not-found': 404,
  busy: 409,
  'storage-error': 500,
  'secret-error': 500,
  internal: 500,
}

/** Methods a GET may invoke; a GET carries no body, so it stays read-only. */
const READ_ONLY: readonly string[] = ['list']

/**
 * Decode one request into a method name and its parameters.
 * @param request - the incoming Fetch request.
 * @returns the method and parameters, or a `bad-input` failure.
 */
async function decode(request: Request): Promise<{ method: RpcMethod; params: Params }> {
  if (request.method === 'GET') {
    const query = new URL(request.url).searchParams
    const name = query.get('method') ?? 'list'
    if (!READ_ONLY.includes(name)) {
      throw new SshError('bad-input', `GET is only accepted for the read-only methods: ${READ_ONLY.join(', ')}.`)
    }
    return { method: name as RpcMethod, params: {} }
  }
  if (request.method !== 'POST') {
    throw new SshError('bad-input', `The ${routeName(request.url)} route accepts GET and POST only.`)
  }
  let body: unknown
  try {
    body = await request.json()
  } catch (error: unknown) {
    throw new SshError('bad-input', 'The request body is not JSON.', { cause: error })
  }
  const record = (body ?? {}) as Record<string, unknown>
  const name = typeof record.method === 'string' ? record.method : ''
  if (!(RPC_METHODS as readonly string[]).includes(name)) {
    throw new SshError('bad-input', `Unknown method "${name}". Expected one of: ${RPC_METHODS.join(', ')}.`, { field: 'method' })
  }
  const params = (typeof record.params === 'object' && record.params !== null ? record.params : {}) as Params
  return { method: name as RpcMethod, params }
}

/**
 * Name the route from its URL for an error message.
 * @param url - the request URL.
 * @returns the pathname.
 */
function routeName(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return '/api/ssh/rpc'
  }
}

/**
 * Build the Fetch handler that dispatches to {@link Ops}.
 * @param ops - the operations to call.
 * @returns a handler for one request.
 */
export function createRpcHandler(ops: Ops): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const answer = (body: unknown, status: number): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      })

    try {
      const { method, params } = await decode(request)
      const result = await dispatch(ops, method, params)
      return answer({ ok: true, result }, 200)
    } catch (error: unknown) {
      if (error instanceof SshError) {
        const failure: SshFailure = {
          code: error.code,
          message: error.message,
          ...(error.field === undefined ? {} : { field: error.field }),
          ...(error.hint === undefined ? {} : { hint: error.hint }),
        }
        return answer({ ok: false, error: failure }, STATUS_OF[error.code])
      }
      const message = error instanceof Error ? error.message : String(error)
      return answer({ ok: false, error: { code: 'internal', message: `ssh: ${message}`.slice(0, 512) } }, 500)
    }
  }
}

/**
 * Call one operation by name.
 * @param ops - the operations.
 * @param method - an already-allowlisted method.
 * @param params - its parameters.
 * @returns the JSON result.
 */
async function dispatch(ops: Ops, method: RpcMethod, params: Params): Promise<unknown> {
  switch (method) {
    case 'list':
      return await ops.list(params)
    case 'save':
      return await ops.save(params)
    case 'remove':
      return await ops.remove(params)
    case 'probe':
      return await ops.probe(params)
    case 'probeAll':
      return await ops.probeAll()
    case 'run':
      return await ops.runCommand(params)
    case 'upload':
      return await ops.upload(params)
    case 'download':
      return await ops.download(params)
    case 'setSessionTarget':
      return await ops.setSessionTarget(params)
    case 'clearSessionTarget':
      return await ops.clearSessionTarget(params)
    case 'configUpdate':
      return await ops.configUpdate(params)
  }
}
