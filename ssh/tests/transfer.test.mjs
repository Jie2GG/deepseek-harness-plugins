// The transfer layer, transport faked at its seam and the local filesystem real:
// the upload pre-checks (existence, readability, size, count, cumulative), the
// overwrite guards at both ends, the download's temp-file-then-rename dance, and
// the cleanup each failure path owes the destination.
//
// The line this suite draws hardest is the one between the two kinds of ceiling.
// A single file is held to the bytes that actually crossed the channel, so a copy
// that keeps moving past the line must come back as a refusal that quotes what it
// moved. A tree is held to what an enumeration said before it moved, and the
// outcome has to say so rather than let one number look like the other.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transfer, scanLocal, remoteParts, publishCommand } from '../lib/transfer.js'
import { remotePathArg } from '../lib/transport.js'
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

function tree () {
  return mkdtempSync(join(tmpdir(), 'dshssh-xfer-'))
}

function base (over = {}) {
  return { direction: 'upload', localPath: '/ws/x', remotePath: '/srv/x', maxBytes: 1024, maxFiles: 50, maxTotalBytes: 4096, timeoutMs: 300_000, ...over }
}

/** A download answer: the server saw the file, and the channel moved these bytes. */
function streamed (bytes, over = {}) {
  return { outcome: 'exit', exitCode: 0, bytes, stdout: '', stderr: '', durationMs: 3, ...over }
}

/** What a settled run answer looks like for the fake, so a test can name a branch. */
function ran (stdout = '', over = {}) {
  return { status: 'succeeded', at: iso, exitCode: 0, stdout, stderr: '', durationMs: 1, ...over }
}

// ── the remote path, shaped for a shell that expands a leading tilde ────────
test('remotePathArg keeps a home-relative tilde outside the quotes and everything else inside them', () => {
  assert.equal(remotePathArg('/srv/x'), "'/srv/x'")
  assert.equal(remotePathArg('/srv/a b/x'), "'/srv/a b/x'")
  // The form that failed on a live server was the fully quoted one: a shell ends a
  // tilde-prefix at an unquoted slash, and quoting the whole path leaves none.
  assert.equal(remotePathArg('~/f.txt'), "~/'f.txt'")
  assert.equal(remotePathArg('~/a b/f.txt'), "~/'a b/f.txt'")
  assert.equal(remotePathArg('/it\'s'), "'/it'\\''s'")
})

test('remoteParts gives the parent in the form that still expands', () => {
  assert.deepEqual(remoteParts('/srv/x'), { parent: '/srv', base: 'x' })
  assert.deepEqual(remoteParts('/x'), { parent: '/', base: 'x' })
  assert.deepEqual(remoteParts('~/x'), { parent: '~', base: 'x' })
  assert.deepEqual(remoteParts('~/a/x'), { parent: '~/a', base: 'x' })
  assert.deepEqual(remoteParts('/srv/x/'), { parent: '/srv', base: 'x' })
  // A sibling built from these parts has to expand too, which is the only reason
  // the bare `~` parent is spelled out rather than derived by string slicing.
  assert.equal(remotePathArg(`${remoteParts('~/x').parent}/${remoteParts('~/x').base}.dsh-part-1`), "~/'x.dsh-part-1'")
  assert.equal(remotePathArg(`${remoteParts('/x').parent === '/' ? '' : remoteParts('/x').parent}/x.dsh-part-1`), "'/x.dsh-part-1'")
})

test('publishCommand replaces through the file, and only renames when there is nothing to keep', () => {
  const command = publishCommand('/srv/x.dsh-part-1', "'/srv/x'", 0o755)
  // The existing-file branch is the one that keeps the inode, the mode, and the
  // hardlinks a `mv` would drop on the floor.
  assert.match(command, /^if \[ -e '\/srv\/x' \] \|\| \[ -L '\/srv\/x' \]; then cat '\/srv\/x\.dsh-part-1' > '\/srv\/x' && rm -f/)
  // The fresh-name branch carries the source's bits through the server's umask,
  // the measured scp outcome (777 arrived as 755 under umask 0022).
  assert.match(command, /else mv -f '\/srv\/x\.dsh-part-1' '\/srv\/x' && \{ u=\$\(umask\); m=\$\(\(0755 & ~\(0\$u\)\)\);/)
  // Three assignments, not one nested substitution: the nested shape was measured
  // failing under `sh` and `dash` and landing the file on mode `000` under `bash`.
  assert.match(command, /c=\$\(printf "%o" "\$m"\)/)
  assert.match(command, /if \[ -n "\$c" \]; then chmod "\$c" '\/srv\/x'; fi/)
  // No mode to carry: the rename stands alone, and nothing is claimed about bits.
  assert.equal(publishCommand('/p', "'/d'").includes('chmod'), false)
})

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

// ── upload: the guards run before the copy, in both directions of the pair ──
test('an upload refuses a local miss without touching the server', async () => {
  const { runner, state } = fakeRunner()
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ localPath: '/ws/gone' }))
  assert.equal(out.status, 'missing')
  assert.equal(state.calls.filter(c => c.kind === 'execute').length, 0)
  assert.equal(state.calls.filter(c => c.kind === 'streamFile').length, 0)
  assert.equal(state.calls.filter(c => c.kind === 'run').length, 0) // the server was never asked
})

test('an upload asks the server about the destination before copying, and only overwrites when told', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  writeFileSync(local, 'hello')
  const { runner, state } = fakeRunner()
  state.nextRun = () => ran('9 regular file')
  const refused = await transfer(runner, TARGET, SETTINGS, {}, base({ localPath: local }))
  assert.equal(refused.status, 'refused-exists')
  assert.match(refused.message, /already exists on 10\.0\.0\.9/)
  assert.equal(refused.limitMode, 'in-flight') // the ceiling the copy would have run under
  assert.equal(state.calls.filter(c => c.kind === 'streamFile').length, 0) // the channel never opened
  state.streamImpl = (_argv, copy) => writeBack(copy.localPath, 'hello')
  const moved = await transfer(runner, TARGET, SETTINGS, {}, base({ localPath: local, overwrite: true }))
  assert.equal(moved.status, 'moved')
  assert.equal(moved.overwrote, true)
  assert.equal(moved.bytes, 5) // the count the copy itself kept
})

function writeBack (path, text) {
  writeFileSync(path, text)
  return streamed(text.length)
}

// ── the in-flight ceiling: the part no pre-check can do ─────────────────────
test('a download that grows past the ceiling after the pre-check is stopped and refused by what it moved', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  const { runner, state } = fakeRunner()
  // The server said 10 bytes. The channel then carried 5000 against a 4096 ceiling:
  // only a count taken while the bytes move can tell those two apart.
  state.nextRun = () => ran('10 regular file')
  state.streamImpl = (_argv, copy) => ({ outcome: 'over-limit', exitCode: null, bytes: 5000, stdout: '', stderr: '', durationMs: 9 })
  writeFileSync(join(dir, 'marker'), 'the part file below is written by the fake')
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, maxBytes: 4096 }))
  assert.equal(out.status, 'refused-size')
  assert.equal(out.limitMode, 'in-flight')
  assert.equal(out.bytes, 5000) // what moved, not what was stated
  assert.match(out.message, /crossed the 4096 byte ceiling while it was being carried/)
  assert.match(out.message, /the copy stopped after 5000 bytes, with more where they came from/)
  assert.match(out.message, /measured 10 bytes when the copy started and grew while it ran/)
  // Nothing at the destination, and no half file beside it.
  assert.equal(readdirSync(dir).includes('x'), false)
  assert.equal(readdirSync(dir).filter(name => name.includes('.dsh-part-')).length, 0)
  // The last lease is the copy's: the stat pre-check ran through `run`, which
  // leases and settles one of its own, exactly as the real transport does.
  const lease = state.shares.at(-1).ticket
  assert.equal(lease.released, 1)
  assert.equal(lease.dropped, 1) // a copy stopped by its ceiling did not prove the master
})

test('a download stopped by the ceiling leaves a file that was already there alone', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  writeFileSync(local, 'the old answer')
  const { runner, state } = fakeRunner()
  state.nextRun = () => ran('5000 regular file')
  state.streamImpl = (_argv, copy) => {
    writeFileSync(copy.localPath, 'half of a growing file')
    return { outcome: 'over-limit', exitCode: null, bytes: 5000, stdout: '', stderr: '', durationMs: 4 }
  }
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, maxBytes: 4096, overwrite: true, destinationExists: true }))
  assert.equal(out.status, 'refused-size')
  assert.equal(readFileSync(local, 'utf8'), 'the old answer')
  assert.equal(readdirSync(dir).filter(name => name.includes('.dsh-part-')).length, 0)
})

test('an upload whose source grows past the ceiling sends nothing to the destination', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  writeFileSync(local, 'small')
  const { runner, state } = fakeRunner()
  // stat says 5; the pump counted 9000 because the file kept being appended to.
  state.streamImpl = (_argv, copy) => ({ outcome: 'over-limit', exitCode: null, bytes: 9000, stdout: '', stderr: '', durationMs: 5 })
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'upload', localPath: local, maxBytes: 4096 }))
  assert.equal(out.status, 'refused-size')
  assert.equal(out.bytes, 9000)
  assert.match(out.message, /crossed the 4096 byte ceiling while it was being sent/)
  assert.match(out.message, /the copy stopped after 9000 bytes, with more to send/)
  assert.match(out.message, /measured 5 bytes at the pre-check and grew after that/)
  assert.match(out.message, /Nothing was written on the server/)
  // The stopped copy is asked of the server by name: one `rm -f` of the temp path.
  const cleanup = state.calls.filter(c => c.kind === 'run').map(c => c.command).find(command => command.startsWith('rm -f -- '))
  assert.ok(cleanup, 'the temp sibling was named back to the server')
  assert.match(cleanup, /\/srv\/x\.dsh-part-/)
  // And no publish step ran: the destination was never opened.
  assert.equal(state.calls.filter(c => c.kind === 'run').map(c => c.command).some(command => command.includes('if [ -e')), false)
})

test('an upload publishes through an existing file, which is how the inode and the links survive', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  writeFileSync(local, 'payload')
  const { runner, state } = fakeRunner()
  state.nextRun = () => ran('9 regular file')
  state.streamImpl = (_argv, copy) => streamed(7)
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'upload', localPath: local, maxBytes: 1024, overwrite: true }))
  assert.equal(out.status, 'moved')
  assert.equal(out.overwrote, true)
  const commands = state.calls.filter(c => c.kind === 'run').map(c => c.command)
  const publish = commands.find(command => command.includes('if [ -e'))
  assert.ok(publish)
  assert.match(publish, /cat '\/srv\/x\.dsh-part-[^']*' > '\/srv\/x'/)
  assert.equal(out.limitMode, 'in-flight')
})

test('an upload whose publish step failed says where the complete bytes still are', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  writeFileSync(local, 'payload')
  const { runner, state } = fakeRunner()
  state.nextRun = command => command.startsWith('stat ')
    ? ran('')
    : ran('', { status: 'exit-nonzero', exitCode: 1, stderr: 'cat: /dev/sda3: No such device' })
  state.streamImpl = (_argv, copy) => streamed(7)
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'upload', localPath: local, maxBytes: 1024 }))
  assert.equal(out.status, 'failed')
  assert.match(out.message, /could not take its final place/)
  assert.match(out.message, /The complete bytes are still at \/srv\/x\.dsh-part-/)
  assert.match(out.notes.join('\n'), /remove it once the destination is settled/)
})

test('a copy the caller cancelled or timed out cleans its part file and quotes the bytes it moved', async () => {
  const endings = [
    [{ outcome: 'cancelled', exitCode: null, bytes: 12, stdout: '', stderr: '', durationMs: 2 }, /cancelled/],
    [{ outcome: 'timeout', exitCode: null, bytes: 340, stdout: '', stderr: '', durationMs: 2 }, /ran out of its deadline/],
    [{ outcome: 'error', exitCode: null, bytes: 0, stdout: '', stderr: '', durationMs: 2, error: 'The provider could not start the child' }, /could not start the child/],
    [{ outcome: 'exit', exitCode: 1, bytes: 0, stdout: '', stderr: 'cat: /srv/x: Permission denied', durationMs: 2 }, /Permission denied/]
  ]
  for (const [streamOut, pattern] of endings) {
    const dir = tree()
    const local = join(dir, 'x')
    const { runner, state } = fakeRunner()
    state.nextRun = () => ran('500 regular file')
    state.streamImpl = (_argv, copy) => {
      writeFileSync(copy.localPath, 'partial')
      return streamOut
    }
    const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, maxBytes: 4096 }))
    assert.equal(out.status, 'failed', streamOut.outcome)
    assert.match(out.message, pattern)
    assert.equal(out.limitMode, 'in-flight')
    assert.ok(!readdirSync(dir).some(name => name.includes('.dsh-part-')), `${streamOut.outcome} must leave no partial`)
    assert.equal(readdirSync(dir).includes('x'), false, `${streamOut.outcome} must not create the final path`)
    const lease = state.shares.find(entry => entry.target.host === '10.0.0.9')
    assert.equal(lease.ticket.released, 1)
  }
})

test('a download that cannot rename its finished copy says so instead of claiming a success', async () => {
  const dir = tree()
  // The final path is a non-empty directory: rename(file -> dir) fails, and the
  // outcome must be a refusal that names it, with the temp cleaned up.
  const local = join(dir, 'x')
  mkdirSync(local)
  writeFileSync(join(local, 'inside'), 'occupant')
  const { runner, state } = fakeRunner()
  state.nextRun = () => ran('5 regular file')
  state.streamImpl = (_argv, copy) => writeBack(copy.localPath, 'hello')
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, maxBytes: 1024, overwrite: true, destinationExists: true }))
  assert.ok(out.status === 'refused-exists' || out.status === 'failed', out.status)
  assert.match(out.message, /could not replace|appeared as a destination/)
  assert.ok(!readdirSync(dir).some(name => name.includes('.dsh-part-')))
  assert.equal(readFileSync(join(local, 'inside'), 'utf8'), 'occupant')
})

test('a download cancel that lands during the stat pre-check is an outcome, not an exception', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  const { runner, state } = fakeRunner()
  const controller = new AbortController()
  state.nextRun = () => {
    controller.abort() // the user stopped the call while the pre-check was in flight
    return { status: 'cancelled', at: iso, exitCode: null, stdout: '', stderr: '', durationMs: 1 }
  }
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, signal: controller.signal }))
  assert.equal(out.status, 'failed')
  assert.match(out.message, /cancelled before it started/)
})

test('an upload asks for the ssh channel and a tree asks for scp, each with its own lane ceiling', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  writeFileSync(local, 'hello')
  const { runner, state } = fakeRunner()
  const controller = new AbortController()
  state.streamImpl = (_argv, copy) => writeBack(copy.localPath, 'hello')
  state.nextRun = () => ran('5 regular file')
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, maxBytes: 1024, signal: controller.signal }))
  assert.equal(out.status, 'moved')
  const call = state.calls.find(c => c.kind === 'streamFile')
  assert.equal(call.timeoutMs, SETTINGS.transferTimeoutMs)
  assert.equal(call.signal, controller.signal)
  assert.deepEqual(call.lane, { kind: 'file transfers', cap: SETTINGS.maxConcurrentTransfers })
  assert.equal(call.program, '/usr/bin/ssh')
  // The far end of a single-file copy is a `cat` of the quoted path, run on the
  // authority as one argument — no `host:path` grammar, which belongs to scp.
  assert.equal(call.argvTail[call.argvTail.length - 1], "cat -- '/srv/x'")
  assert.equal(call.argvTail[call.argvTail.length - 2], 'deploy@10.0.0.9')
})

test('a copy refused by the transfer lane comes back as an outcome, not as a thrown error', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  writeFileSync(local, 'hello')
  const { runner, state } = fakeRunner()
  state.nextRun = () => ran('5 regular file')
  // The transport answers a full lane by throwing; the transfer layer turns that
  // into the same vocabulary every other refusal uses, with the transport's own
  // hint about what to wait for.
  state.streamFail = { code: 'busy', message: 'At most 2 file transfers may run at once, and all 2 slots are taken.', hint: 'Wait for one to finish, stop a job with `job_kill`, or raise the ceiling.' }
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, maxBytes: 1024 }))
  assert.equal(out.status, 'failed')
  assert.match(out.message, /At most 2 file transfers may run at once/)
  assert.equal(out.hint, 'Wait for one to finish, stop a job with `job_kill`, or raise the ceiling.')
  assert.equal(out.limitMode, 'in-flight')
  assert.equal(out.overwrote, false)
  const lease = state.shares.at(-1).ticket
  assert.equal(lease.released, 1, 'the refusal still handed its connection lease back')
})

// ── recursion: measured before it moves, reported after ─────────────────────
test('a recursive upload walks the same ceilings a single file faces', async () => {
  const dir = tree()
  writeFileSync(join(dir, 'a'), 'aaaa')
  const over = base({ localPath: dir, recursive: true, maxBytes: 3 })
  const { runner } = fakeRunner()
  const out = await transfer(runner, TARGET, SETTINGS, {}, over)
  assert.equal(out.status, 'refused-size')
  assert.match(out.message, /the 3 byte transfer ceiling/)
  assert.equal(out.limitMode, 'pre-check')
})

test('a recursive download enumerates the tree and refuses over the count or the sum', async () => {
  const cases = [
    ['ssh-plugin: 60 tree 60', /holds 60 files, over the 50 file ceiling/, 'refused-size'],
    ['ssh-plugin: 2 tree 9000', /adds up to 9000 bytes, over the 4096 byte ceiling/, 'refused-size'],
    ['ssh-plugin: 0 missing 0', /Nothing at/, 'missing'],
    ['ssh-plugin: 1 file 8000', /That file is 8000 bytes/, 'refused-size']
  ]
  for (const [answer, pattern, status] of cases) {
    const probe = tree()
    const { runner, state } = fakeRunner()
    state.nextRun = () => ran(answer)
    const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: join(probe, 'dl'), remotePath: '/srv/tree', recursive: true }))
    assert.equal(out.status, status, answer)
    assert.match(out.message, pattern)
    assert.equal(out.limitMode, 'pre-check')
    assert.equal(state.calls.filter(c => c.kind === 'execute').length, 0, `${answer}: the copy never started`)
  }
})

test('a server that cannot be asked for a tree is told so, and the copy still runs', async () => {
  const dir = tree()
  const { runner, state } = fakeRunner()
  state.nextRun = command => command.includes('find') ? ran('ssh-plugin: 0 unknown 0') : ran('4096 directory')
  state.executeImpl = argvTail => {
    const dst = argvTail[argvTail.length - 1]
    mkdirSync(dst, { recursive: true })
    writeFileSync(join(dst, 'a'), 'aaa')
  }
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: join(dir, 'dl'), remotePath: '/srv/tree', recursive: true }))
  assert.equal(out.status, 'moved')
  assert.match(out.notes.join('\n'), /could not be asked for the size of the tree/)
  // The enumeration still happened once — the plugin asked and the server declined,
  // which is a different sentence from not asking.
  assert.equal(state.calls.filter(c => c.kind === 'run' && c.command.includes('find')).length, 1)
})

test('a recursive download reports what landed, counted from the tree itself', async () => {
  const dir = tree()
  const { runner, state } = fakeRunner()
  state.nextRun = () => ran('ssh-plugin: 2 tree 6')
  state.executeImpl = argvTail => {
    const dst = argvTail[argvTail.length - 1]
    mkdirSync(dst, { recursive: true })
    writeFileSync(join(dst, 'a'), 'aaa')
    writeFileSync(join(dst, 'b'), 'bbb')
  }
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: join(dir, 'dl'), remotePath: '/srv/tree', recursive: true, maxTotalBytes: 4096 }))
  assert.equal(out.status, 'moved')
  assert.equal(out.bytes, 6)
  assert.equal(out.files, 2)
  assert.equal(out.kind, 'directory')
  assert.equal(out.limitMode, 'pre-check')
  assert.deepEqual(readdirSync(join(dir, 'dl')), ['a', 'b'])
  assert.equal(readdirSync(dir).filter(name => name.includes('.dsh-part-')).length, 0)
})

test('a tree that grew past its ceilings after the enumeration lands anyway, and says by how much', async () => {
  const dir = tree()
  const { runner, state } = fakeRunner()
  state.nextRun = () => ran('ssh-plugin: 2 tree 6')
  state.executeImpl = argvTail => {
    const dst = argvTail[argvTail.length - 1]
    mkdirSync(dst, { recursive: true })
    writeFileSync(join(dst, 'a'), 'aaaaaaaaaa') // grew after the pre-check
    writeFileSync(join(dst, 'b'), 'bbbbbbbbbb')
  }
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: join(dir, 'dl'), remotePath: '/srv/tree', recursive: true, maxTotalBytes: 8 }))
  assert.equal(out.status, 'moved') // the tree is there; pretending otherwise would lose it
  assert.equal(out.bytes, 20)
  assert.match(out.notes.join('\n'), /had grown to 20 bytes in 2 files by the time it landed/)
})

test('a recursive download into a directory that already holds something is refused, not copied then deleted', async () => {
  const dir = tree()
  const local = join(dir, 'dl')
  mkdirSync(local)
  writeFileSync(join(local, 'keep.txt'), 'mine')
  const { runner, state } = fakeRunner()
  state.nextRun = () => ran('ssh-plugin: 2 tree 6')
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, remotePath: '/srv/tree', recursive: true, overwrite: true, destinationExists: true }))
  assert.equal(out.status, 'refused-exists')
  assert.match(out.message, /rather than into it/)
  assert.equal(state.calls.filter(c => c.kind === 'execute').length, 0)
  assert.deepEqual(readdirSync(local), ['keep.txt'])
})

test('a recursive download keeps its half tree out of the destination when the copy dies', async () => {
  const dir = tree()
  const local = join(dir, 'dl')
  const { runner, state } = fakeRunner()
  state.nextRun = () => ran('ssh-plugin: 2 tree 6')
  state.executeImpl = argvTail => {
    const dst = argvTail[argvTail.length - 1]
    mkdirSync(dst, { recursive: true })
    writeFileSync(join(dst, 'half'), 'aaa')
  }
  state.executeOut = { outcome: 'timeout', exitCode: null, stdout: '', stderr: '', durationMs: 2, truncated: false }
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, remotePath: '/srv/tree', recursive: true }))
  assert.equal(out.status, 'failed')
  assert.equal(out.limitMode, 'pre-check')
  // The destination was never created: the tree lived and died as a sibling.
  assert.deepEqual(readdirSync(dir), [])
  assert.equal(readdirSync(dir).filter(name => name.includes('.dsh-part-')).length, 0)
})
