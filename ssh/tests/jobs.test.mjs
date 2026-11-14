// The background-job adapter: what the harness registry sees, and how each
// remote outcome is classified once the child settles.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startRemoteJob } from '../lib/jobs.js'

function fakeRegistry () {
  const registry = { start (spec) { this.spec = spec; return 'ssh-j1' } }
  return registry
}

function live (finished, over = {}) {
  return {
    sources: [
      { channel: 'stdout', read: from => ({ text: 'chunk', nextOffset: from + 5, lossy: false }) },
      { channel: 'stderr', read: from => ({ text: 'e', nextOffset: from + 1, lossy: true }) }
    ],
    kill () { this.kills = (this.kills ?? 0) + 1 },
    finished,
    ...over
  }
}

test('a clean zero exit completes with the summary the reader polls for', async () => {
  const registry = fakeRegistry()
  const jobId = startRemoteJob(registry, {
    label: 'Proxy: uptime',
    owner: 'session-77',
    toolCall: { callId: 'c1', rootCallId: 'r1' },
    start: async () => live(Promise.resolve({ outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 5, truncated: false }))
  })
  assert.equal(jobId, 'ssh-j1')
  const spec = registry.spec
  assert.equal(spec.kind, 'ssh')
  assert.equal(spec.owner, 'session-77')
  assert.deepEqual(spec.toolCall, { callId: 'c1', rootCallId: 'r1' })
  assert.deepEqual(spec.output.map(s => s.channel), ['stdout', 'stderr'])
  const hooks = spec.run({})
  assert.deepEqual(await hooks.done, { status: 'completed', detail: 'exit=0 · 5 ms', result: 'exit=0 · 5 ms' })
})

test('a stopped job is reported as stopped, whatever the client exited with', async () => {
  const registry = fakeRegistry()
  let resolveStart
  const started = new Promise(r => { resolveStart = r })
  const spec = (startRemoteJob(registry, {
    label: 'Proxy: sleep 300',
    start: () => started
  }), registry.spec)
  const hooks = spec.run({})
  // The reader stops it while the child is still being resolved.
  hooks.cancel('the reader asked')
  const child = live(Promise.resolve({ outcome: 'exit', exitCode: 255, stdout: '', stderr: '', durationMs: 900, truncated: false }))
  resolveStart(child)
  const outcome = await hooks.done
  assert.equal(outcome.status, 'killed')
  assert.equal(outcome.detail, 'the reader asked')
  assert.equal(child.kills, 1) // the late child was killed the moment it existed
  assert.match(outcome.result, /stopped after 900 ms/)
  assert.match(outcome.result, /the ssh client exited 255/)
})

test('an externally cancelled command settles killed without a reader reason', async () => {
  const registry = fakeRegistry()
  startRemoteJob(registry, { label: 'x', start: async () => live(Promise.resolve({ outcome: 'cancelled', exitCode: 255, stdout: '', stderr: '', durationMs: 4, truncated: false })) })
  assert.deepEqual(await registry.spec.run({}).done, { status: 'killed', detail: 'the job was stopped', result: 'stopped after 4 ms' })
})

test('timeouts, start failures, and nonzero exits all say what happened', async () => {
  const timeout = fakeRegistry()
  startRemoteJob(timeout, { label: 'x', start: async () => live(Promise.resolve({ outcome: 'timeout', exitCode: null, stdout: '', stderr: '', durationMs: 1800000, truncated: false })) })
  assert.deepEqual(await timeout.spec.run({}).done, { status: 'failed', detail: 'the command ran out of its deadline', result: 'timed out after 1800000 ms' })

  const unresolvable = fakeRegistry()
  startRemoteJob(unresolvable, { label: 'x', start: async () => ({ message: 'No ssh program was found: PATH and the usual install locations were tried.' }) })
  assert.deepEqual(await unresolvable.spec.run({}).done, { status: 'failed', detail: 'No ssh program was found: PATH and the usual install locations were tried.' })

  const boom = fakeRegistry()
  startRemoteJob(boom, { label: 'x', start: async () => { throw new Error('spawn exploded') } })
  assert.deepEqual(await boom.spec.run({}).done, { status: 'failed', detail: 'spawn exploded' })

  const nonzero = fakeRegistry()
  startRemoteJob(nonzero, { label: 'x', start: async () => live(Promise.resolve({ outcome: 'error', error: 'ENOENT', exitCode: null, stdout: '', stderr: '', durationMs: 1, truncated: false })) })
  assert.deepEqual(await nonzero.spec.run({}).done, { status: 'failed', detail: 'ENOENT' })

  const failing = fakeRegistry()
  startRemoteJob(failing, { label: 'x', start: async () => live(Promise.resolve({ outcome: 'exit', exitCode: 3, stdout: '', stderr: '', durationMs: 20, truncated: true })) })
  assert.deepEqual(await failing.spec.run({}).done, { status: 'failed', detail: 'exit=3 · 20 ms · output truncated', result: 'exit=3 · 20 ms · output truncated' })
})

test('stream sources answer reads before the child exists, then pass them through', async () => {
  const registry = fakeRegistry()
  let resolveStart
  const started = new Promise(r => { resolveStart = r })
  startRemoteJob(registry, { label: 'x', start: () => started })
  const spec = registry.spec
  const before = spec.output[0].read(0)
  assert.deepEqual(before, { text: '', nextOffset: 0, lossy: false }) // not an error, just "nothing yet"
  spec.run({})
  resolveStart(live(new Promise(() => {})))
  // The starter resolves on a microtask: let the loop turn once before reading.
  await new Promise(resolve => setImmediate(resolve))
  const after = spec.output[1].read(3)
  assert.deepEqual(after, { text: 'e', nextOffset: 4, lossy: true })
})
