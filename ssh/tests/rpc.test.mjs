// The browser-facing route: method allowlisting, GET's read-only rule, the
// closed failure vocabulary mapped to statuses, and the response headers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRpcHandler } from '../lib/rpc.js'
import { SshError, RPC_METHODS } from '../lib/types.js'

function spyOps () {
  const ops = {}
  for (const method of RPC_METHODS) {
    ops[method] = async params => ({ marker: method, params })
  }
  return ops
}

async function call (handler, init) {
  const response = await handler(new Request('http://h/api/ssh/rpc', init))
  return { response, body: await response.json() }
}

test('POST dispatches every allowlisted method and envelopes the result', async () => {
  const handler = createRpcHandler(spyOps())
  const { response, body } = await call(handler, { method: 'POST', body: JSON.stringify({ method: 'probe', params: { id: 'ssh-a1b2c3d4e5' } }) })
  assert.equal(response.status, 200)
  assert.deepEqual(body, { ok: true, result: { marker: 'probe', params: { id: 'ssh-a1b2c3d4e5' } } })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.match(response.headers.get('content-type'), /application\/json/)
})

test('an unknown, missing, or foreign method is a bad-input refusal, not a dispatch', async () => {
  const handler = createRpcHandler(spyOps())
  for (const bodyIn of [{ method: 'deleteEverything' }, {}, { method: 'constructor' }, { method: 7 }]) {
    const { response, body } = await call(handler, { method: 'POST', body: JSON.stringify(bodyIn) })
    assert.equal(response.status, 400, JSON.stringify(bodyIn))
    assert.equal(body.error.code, 'bad-input')
    assert.match(body.error.message, /Expected one of/)
  }
  const broken = await call(handler, { method: 'POST', body: 'not json' })
  assert.equal(broken.response.status, 400)
  assert.equal(broken.body.error.message, 'The request body is not JSON.')
})

test('GET reaches only list', async () => {
  const handler = createRpcHandler(spyOps())
  const ok = await call(handler, { method: 'GET' })
  assert.deepEqual(ok.body.result, { marker: 'list', params: {} })
  const query = await call(handler, { method: 'GET' })
  assert.equal(query.response.status, 200)
  const denied = await handler(new Request('http://h/api/ssh/rpc?method=save'))
  assert.equal(denied.status, 400)
  const wrongVerb = await handler(new Request('http://h/api/ssh/rpc', { method: 'DELETE' }))
  assert.equal(wrongVerb.status, 400)
})

test('SshError codes map onto the documented statuses, field and hint included', async () => {
  for (const [code, status] of [['bad-input', 400], ['not-found', 404], ['busy', 409], ['storage-error', 500], ['secret-error', 500], ['internal', 500]]) {
    const ops = { ...spyOps(), list: async () => { throw new SshError(code, 'because', { field: 'target', hint: 'do this' }) } }
    const { response, body } = await call(createRpcHandler(ops), { method: 'POST', body: JSON.stringify({ method: 'list' }) })
    assert.equal(response.status, status, code)
    assert.deepEqual(body.error, { code, message: 'because', field: 'target', hint: 'do this' })
  }
})

test('an unexpected throw becomes a prefixed internal, never a stack dump', async () => {
  const ops = { ...spyOps(), runCommand: async () => { throw new Error('boom of the store') } }
  const { response, body } = await call(createRpcHandler(ops), { method: 'POST', body: JSON.stringify({ method: 'run', params: { command: 'x' } }) })
  assert.equal(response.status, 500)
  assert.equal(body.error.code, 'internal')
  assert.ok(body.error.message.startsWith('ssh: boom'))
  assert.ok(body.error.message.length <= 512 + 8)
})
