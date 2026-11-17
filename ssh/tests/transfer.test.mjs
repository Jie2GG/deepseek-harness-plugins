// The transfer layer, transport faked at its seam and the local filesystem real:
// the upload pre-checks (existence, readability, size, count, cumulative), the
// overwrite guards at both ends, the download's temp-file-then-rename dance, and
// the cleanup each failure path owes the destination. The ceilings are pre-checks
// against `stat`, and these tests state which side of the copy each one runs on.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transfer, scanLocal } from '../lib/transfer.js'
import { fakeRunner } from './helpers.mjs'

const iso = new Date().toISOString()
const SETTINGS = {
  maxOutputBytes: 65_536,
  remoteTimeoutMs: 30_000,
  maxTransferBytes: 33_554_432,
  transferTimeoutMs: 300_000,
  maxTransferFiles: 500,
  maxTransferTotalBytes: 536_870_912,
  maxConcurrentTransfers: 2,
  probeTimeoutMs: 30_000,
  statTimeoutMs: 10_000,
  maxSpillBytes: 0,
  graceMs: 500
}
const TARGET = { id: 'ssh-a1b2c3d4e5', host: '10.0.0.9', user: 'deploy' }
const ASKPASS = { path: '/tmp/h/askpass.sh', failure: undefined }

function tree () {
  return mkdtempSync(join(tmpdir(), 'dshssh-xfer-'))
}

function base (over = {}) {
  return { direction: 'upload', localPath: '/ws/x', remotePath: '/srv/x', maxBytes: 1024, maxFiles: 50, maxTotalBytes: 4096, timeoutMs: 300_000, ...over }
}

// ── scanLocal: the walk every upload runs through ──────────────────────────
test('scanLocal measures one readable file and stops at the ceiling', async () => {
  const dir = tree()
  const file = join(dir, 'x')
  writeFileSync(file, 'hello')
  const ok = await scanLocal(file, 1024, 50, 4096, false)
  assert.deepEqual(ok, { ok: true, bytes: 5, files: 1, kind: 'file' })
  const big = await scanLocal(file, 4, 50, 4096, false)
  assert.equal(big.ok, false)
  assert.equal(big.refusal.status, 'refused-size')
  assert.match(big.refusal.message, /over the 4 byte transfer ceiling/)
  const gone = await scanLocal(join(dir, 'nope'), 1024, 50, 4096, false)
  assert.equal(gone.refusal.status, 'missing')
  const asDir = await scanLocal(dir, 1024, 50, 4096, false)
  assert.equal(asDir.ok, false)
  assert.match(asDir.refusal.message, /ask for it recursively/)
})

test('scanLocal walks a tree under the count and cumulative ceilings, and refuses over them', async () => {
  const dir = tree()
  for (let i = 0; i < 6; i += 1) writeFileSync(join(dir, `f${String(i)}`), '12345')
  const nested = join(dir, 'sub')
  mkdirSync(nested)
  writeFileSync(join(nested, 'deep'), '67890')
  const ok = await scanLocal(dir, 1024, 50, 1_000_000, true)
  assert.deepEqual(ok, { ok: true, bytes: 35, files: 7, kind: 'directory' })
  const tooMany = await scanLocal(dir, 1024, 3, 1_000_000, true)
  assert.equal(tooMany.ok, false)
  assert.match(tooMany.refusal.message, /more than 3 files/)
  const tooHeavy = await scanLocal(dir, 1024, 50, 20, true)
  assert.equal(tooHeavy.ok, false)
  assert.match(tooHeavy.refusal.message, /more than 20 bytes/)
  const oneBig = await scanLocal(dir, 4, 50, 1_000_000, true)
  assert.equal(oneBig.ok, false)
  assert.match(oneBig.refusal.message, /is 5 bytes, over the 4 byte transfer ceiling/)
})

test('scanLocal follows symlinks the way scp does, and a link loop is walked once', async () => {
  const dir = tree()
  const sub = join(dir, 'sub')
  mkdirSync(sub)
  writeFileSync(join(sub, 'f'), 'abc')
  symlinkSync(dir, join(sub, 'loop')) // a loop: sub -> parent -> sub...
  const out = await scanLocal(dir, 1024, 50, 1_000_000, true)
  assert.equal(out.ok, true)
  assert.equal(out.files, 1) // `f` counted once: the loop landed in an already-visited realpath
})

test('scanLocal refuses an unreadable file and a special one, when the platform can show either', async () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    // root reads anything; the permission half of this test cannot mean anything.
    return
  }
  const dir = tree()
  const sub = join(dir, 'sub')
  mkdirSync(sub)
  const denied = join(sub, 'secret')
  writeFileSync(denied, 'x')
  chmodSync(denied, 0o000)
  const out = await scanLocal(dir, 1024, 50, 1_000_000, true)
  assert.equal(out.ok, false)
  assert.match(out.refusal.message, /could not be read/)
  const other = tree()
  if (typeof fs.mkfifoSync !== 'function') return // no mkfifo on this platform
  try {
    fs.mkfifoSync(join(other, 'p'))
  } catch {
    return // refused anyway: the platform cannot show one
  }
  const fifoOut = await scanLocal(other, 1024, 50, 1_000_000, true)
  assert.equal(fifoOut.ok, false)
  assert.match(fifoOut.refusal.message, /neither a regular file nor a directory/)
})

// ── upload: the guards run before scp, in both directions of the pair ──────
test('an upload refuses a local miss without touching the server', async () => {
  const { runner, state } = fakeRunner()
  const out = await transfer(runner, ASKPASS, TARGET, SETTINGS, {}, base({ localPath: '/ws/gone' }))
  assert.equal(out.status, 'missing')
  assert.equal(state.calls.filter(c => c.kind === 'execute').length, 0)
  assert.equal(state.calls.filter(c => c.kind === 'run').length, 0) // the server was never asked
})

test('an upload asks the server about the destination before copying, and only overwrites when told', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  writeFileSync(local, 'hello')
  const { runner, state } = fakeRunner()
  state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '9 regular file', stderr: '', durationMs: 1 })
  const refused = await transfer(runner, ASKPASS, TARGET, SETTINGS, {}, base({ localPath: local }))
  assert.equal(refused.status, 'refused-exists')
  assert.match(refused.message, /already exists on 10\.0\.0\.9/)
  assert.equal(state.calls.filter(c => c.kind === 'execute').length, 0) // scp never ran
  state.executeOut = { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 2, truncated: false }
  const moved = await transfer(runner, ASKPASS, TARGET, SETTINGS, {}, base({ localPath: local, overwrite: true }))
  assert.equal(moved.status, 'moved')
  assert.equal(moved.overwrote, true)
  assert.equal(moved.bytes, 5) // the local stat is the honest byte count
})

test('an upload to a fresh destination moves, reports bytes, and rides a transfer lane', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  writeFileSync(local, 'hello')
  const { runner, state } = fakeRunner()
  // the default fake `run` answers every stat with an unparsable empty stdout:
  // the destination reads as absent, and the copy proceeds.
  state.executeOut = { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 2, truncated: false }
  const controller = new AbortController()
  const out = await transfer(runner, ASKPASS, TARGET, SETTINGS, {}, base({ localPath: local, signal: controller.signal }))
  assert.equal(out.status, 'moved')
  assert.equal(out.overwrote, false)
  const exec = state.calls.find(c => c.kind === 'execute')
  assert.equal(exec.timeoutMs, SETTINGS.transferTimeoutMs)
  assert.equal(exec.signal, controller.signal)
  assert.deepEqual(exec.lane, { kind: 'file transfers', cap: SETTINGS.maxConcurrentTransfers })
  const lease = state.shares.find(entry => entry.target.host === '10.0.0.9')
  assert.equal(lease.ticket.released, 1)
})

// ── download: temp file in, final path out, nothing left behind on failure ──
function downloaded (dir, name = 'x') {
  const entries = readdirSync(dir)
  const part = entries.filter(e => e.includes('.dsh-part-'))
  assert.deepEqual(part, [], `no partial file should survive: ${part.join(', ')}`)
  assert.ok(entries.includes(name), `expected ${name} in ${entries.join(', ')}`)
}

test('a clean download renames the part-file onto the final path and leaves nothing behind', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  const { runner, state } = fakeRunner()
  state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '5 regular file', stderr: '', durationMs: 1 })
  state.executeImpl = argvTail => {
    writeFileSync(argvTail[argvTail.length - 1], 'hello')
  }
  state.executeOut = { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 2, truncated: false }
  const out = await transfer(runner, ASKPASS, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local }))
  assert.equal(out.status, 'moved')
  assert.equal(out.bytes, 5)
  assert.equal(readFileSync(local, 'utf8'), 'hello')
  downloaded(dir)
})

test('a download that is cancelled, times out, or fails cleans up its part-file and answers honestly', async () => {
  const endings = [
    [{ outcome: 'cancelled', exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '', durationMs: 2, truncated: false }, /cancelled/],
    [{ outcome: 'timeout', exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 2, truncated: false }, /ran out of its deadline/],
    [{ outcome: 'exit', exitCode: 1, signal: null, stdout: '', stderr: 'scp: Connection closed', durationMs: 2, truncated: false }, /Connection closed/]
  ]
  for (const [executeOut, pattern] of endings) {
    const dir = tree()
    const local = join(dir, 'x')
    const { runner, state } = fakeRunner()
    state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '5 regular file', stderr: '', durationMs: 1 })
    state.executeImpl = argvTail => {
      writeFileSync(argvTail[argvTail.length - 1], 'half') // bytes started moving
    }
    state.executeOut = executeOut
    const out = await transfer(runner, ASKPASS, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local }))
    assert.equal(out.status, 'failed', executeOut.outcome)
    assert.match(out.message, pattern)
    assert.ok(!readdirSync(dir).some(e => e.includes('.dsh-part-')), `${executeOut.outcome} must leave no partial`)
    assert.equal(readdirSync(dir).includes('x'), false, `${executeOut.outcome} must not create the final path`)
  }
})

test('a failed download does not touch a final file that was already there', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  writeFileSync(local, 'the old answer')
  const { runner, state } = fakeRunner()
  state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '9 regular file', stderr: '', durationMs: 1 })
  state.executeOut = { outcome: 'timeout', exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 2, truncated: false }
  const out = await transfer(runner, ASKPASS, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, overwrite: true, destinationExists: true }))
  assert.equal(out.status, 'failed')
  assert.equal(readFileSync(local, 'utf8'), 'the old answer')
})

test('a download that cannot rename its finished copy says so instead of claiming a success', async () => {
  const dir = tree()
  // The final path is a non-empty directory: rename(file -> dir) fails, and the
  // outcome must be a refusal that names it, with the temp cleaned up.
  const local = join(dir, 'x')
  mkdirSync(local)
  writeFileSync(join(local, 'inside'), 'occupant')
  const { runner, state } = fakeRunner()
  state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '5 regular file', stderr: '', durationMs: 1 })
  state.executeImpl = argvTail => {
    writeFileSync(argvTail[argvTail.length - 1], 'hello')
  }
  state.executeOut = { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 2, truncated: false }
  const out = await transfer(runner, ASKPASS, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, overwrite: true, destinationExists: true }))
  assert.ok(out.status === 'refused-exists' || out.status === 'failed', out.status)
  assert.match(out.message, /could not replace|appeared as a destination/)
  assert.ok(!readdirSync(dir).some(e => e.includes('.dsh-part-')))
  assert.equal(readFileSync(join(local, 'inside'), 'utf8'), 'occupant')
})

test('a download cancel that lands during the stat pre-check is an outcome, not an exception', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  const { runner, state } = fakeRunner()
  const controller = new AbortController()
  state.nextRun = () => {
    controller.abort() // the user stopped the call while the pre-check was in flight
    return { status: 'cancelled', at: iso, exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 1 }
  }
  const out = await transfer(runner, ASKPASS, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, signal: controller.signal }))
  assert.equal(out.status, 'failed')
  assert.match(out.message, /cancelled before it started/)
})

test('a recursive upload walks the same ceilings a single file faces', async () => {
  const dir = tree()
  writeFileSync(join(dir, 'a'), 'aaaa')
  const over = base({ localPath: dir, recursive: true, maxBytes: 3 })
  const { runner } = fakeRunner()
  const out = await transfer(runner, ASKPASS, TARGET, SETTINGS, {}, over)
  assert.equal(out.status, 'refused-size')
  assert.match(out.message, /the 3 byte transfer ceiling/)
})
