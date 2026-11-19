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

/** The whole transfer module, for the K-4 helpers a named import would only clutter. */
const guards = await import('../lib/transfer.js')

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

/**
 * The task identity this plugin wrote into a mover command's marker line.
 * @param command - the remote command string the copy was given.
 * @returns the tag, or `undefined` when the command carries no marker.
 */
function tagOf (command) {
  return /printf 'dsh-mover %s %s %s\\n' "\$(?:\$|mp)" '([a-z0-9-]+)' "\$ms" >&2/u.exec(String(command))?.[1]
}

/**
 * What a real mover answers with on its own stderr: the pid it reported, this
 * copy's tag, and the kernel start time that number carried. The fake derives the
 * first two from the command the plugin actually sent, so a test cannot pass by
 * hard-coding an identity the copy never asked for.
 * @param argvTail - the argv the copy was handed, whose last entry is the mover command.
 * @param pid - the number to answer with, standing in for the server's own.
 * @param starttime - the start time to stamp beside it; `0` stands for a server
 *   with no readable `/proc`, the shape K-4 must refuse to kill on.
 * @returns the marker line, newline included.
 */
function moverStderr (argvTail, pid = 4242, starttime = 1700000000) {
  const tag = tagOf(String(argvTail.at(-1)))
  return `dsh-mover ${String(pid)} ${tag ?? 'untagged'} ${String(starttime)}\n`
}

/** Is this command the cleanup child aimed at a recorded mover identity? */
function isReap (command) {
  return /^P='[0-9]+'; K='[0-9]*'; p=/.test(String(command))
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
  const command = publishCommand('/srv/x.dsh-part-1', "'/srv/x'", 0o755, 'aaa1-bbbbbbbb')
  // The existing-file branch is the one that keeps the inode, the mode, and the
  // hardlinks a `mv` would drop on the floor.
  assert.match(command, /^if \[ -e '\/srv\/x' \] \|\| \[ -L '\/srv\/x' \]; then cat -- '\/srv\/x\.dsh-part-1' > '\/srv\/x' & mp=\$!;/u)
  // The mover is a background job with its pid reported before it can block, because
  // this script has work left to do after the copy — so `$$` would name the wrong
  // process, and K-4 needs the one that holds the part file (0.0.36 settled for
  // killing anything whose command line looked like this copy's, which on a shared
  // path is not the same thing).
  assert.match(command, /printf 'dsh-mover %s %s %s\\n' "\$mp" 'aaa1-bbbbbbbb' "\$ms" >&2; wait \$mp && rm -f '\/srv\/x\.dsh-part-1'/u)
  // K-4: the marker carries a kernel start time, read from the mover's own `/proc`
  // entry, because a bare pid is a number that gets recycled and an heir must not
  // eat the cleanup's SIGKILL. The `0` default is the shape of a server that states
  // no `/proc` at all — which the cleanup then refuses to kill on.
  assert.match(command, /ms=0; \{ IFS= read -r _t <\/proc\/"\$mp"\/stat/u, 'the mover’s start time is probed before it is announced')
  // `wait` hands the copy's own status to the `&&`, so a mover that died keeps the
  // part file for the reader exactly as the sequential form did.
  // The fresh-name branch carries the source's bits through the server's umask,
  // the measured scp outcome (777 arrived as 755 under umask 0022).
  assert.match(command, /else mv -f '\/srv\/x\.dsh-part-1' '\/srv\/x' && \{ u=\$\(umask\); m=\$\(\(0755 & ~\(0\$u\)\)\);/)
  // Three assignments, not one nested substitution: the nested shape was measured
  // failing under `sh` and `dash` and landing the file on mode `000` under `bash`.
  assert.match(command, /c=\$\(printf "%o" "\$m"\)/)
  assert.match(command, /if \[ -n "\$c" \]; then chmod "\$c" '\/srv\/x'; fi/)
  // No mode to carry: the rename stands alone, and nothing is claimed about bits.
  assert.equal(publishCommand('/p', "'/d'", undefined, 'aaa1-cccccccc').includes('chmod'), false)
  // The rename branch has no mover that could stall, so it gets no marker — and the
  // copy layer says so rather than reporting a pid it never learned.
  assert.ok(command.indexOf('dsh-mover') < command.indexOf('else mv -f'), 'the marker sits in the overwrite branch only')
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
  state.nextRun = command => isReap(command) ? ran('dsh-reap killed') : ran('10 regular file')
  state.streamImpl = (argv, copy) => ({ outcome: 'over-limit', exitCode: null, bytes: 5000, stdout: '', stderr: moverStderr(argv), durationMs: 9 })
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
  // The copy that a ceiling stopped must not vouch for the master: it is the one
  // lease dropped (the pre-check and the K-4 cleanup child each prove their own and
  // come back marked), so it is identified by what happened to it, not by position.
  const copyLease = state.shares.find(entry => entry.ticket.dropped === 1)?.ticket
  assert.ok(copyLease, 'the stopped copy dropped exactly one lease')
  assert.equal(copyLease.released, 1, 'and released it on the way out')
  // K-4: a stopped download asks the server to end **the mover it created**, named by
  // the pid that mover reported on the channel. A channel close cannot reach a `cat`
  // parked in a fifo with no writer, and a pattern searched across the process table
  // cannot tell this copy's mover from another copy of the same file.
  const reaper = state.calls.filter(c => c.kind === 'run').map(c => c.command).find(isReap)
  assert.ok(reaper, 'the interrupted download fired a cleanup child')
  assert.match(String(reaper), /^P='4242'; K='1700000000'; p='\/srv\/x'; /u, 'aimed at the recorded pid and its start time, with the path only as the identity to confirm')
  assert.equal(String(reaper).includes('pkill'), false, 'and nothing is killed for matching a path')
  assert.match(String(out.notes?.join(' ') ?? ''), /ended its own server-side mover of \/srv\/x \(pid 4242\), confirmed from that pid's command line/u, 'the result says what the cleanup proved')
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
  assert.match(publish, /cat -- '\/srv\/x\.dsh-part-[^']*' > '\/srv\/x' & mp=\$!;/u)
  assert.ok(tagOf(publish) !== undefined, 'and the mover it backgrounded announced the identity the cleanup will need')
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

test('a failed publish asks the server to end the mover it left writing the part file', async () => {
  // K-4: a publish that ran out of its budget writing through a fifo with no reader
  // strands a server-side `cat -- part > dest`. That mover reported its pid before it
  // blocked, so the cleanup names one process rather than every process that looks
  // like this copy.
  const dir = tree()
  const local = join(dir, 'x')
  writeFileSync(local, 'payload')
  const { runner, state } = fakeRunner()
  let part = ''
  state.nextRun = command => {
    if (command.startsWith('stat ')) return ran('')
    if (isReap(command)) { part = command; return ran('dsh-reap killed') }
    // the publish itself: the server had no reader for the fifo, so it came back
    // stalled, and its stderr carries the marker the backgrounded mover printed.
    return ran('', { status: 'timeout', exitCode: null, stderr: `${moverStderr([command], 4711)}ssh: timed out` })
  }
  state.streamImpl = (_argv, copy) => streamed(7)
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'upload', localPath: local, maxBytes: 1024 }))
  assert.equal(out.status, 'failed')
  assert.match(out.message, /could not take its final place/)
  assert.match(part, /^P='4711'; K='1700000000'; p='\/srv\/x\.dsh-part-[a-z0-9-]+'; /u, 'the cleanup names the pid and the start time this publish reported, and its own part file')
  assert.equal(part.includes('pkill'), false, 'it does not search the process table for a path')
  assert.match(out.notes.join('\n'), /ended its own server-side mover of \/srv\/x\.dsh-part-/u, 'and the result says the cleanup ran')
  assert.match(out.notes.join('\n'), /confirmed from that pid's command line/u, 'saying what the kill was proved by')
  // The part file itself is NOT removed by a publish failure — the complete bytes are
  // kept for the reader — so the reaper is a kill, not an rm.
  assert.ok(!state.calls.some(c => c.kind === 'run' && /^rm -f/.test(c.command)), 'no temp removal was ordered for a copy that reached the server whole')
})

test('a publish that never reached the overwrite branch says it killed nothing', async () => {
  // The rename branch has no mover, so there is no pid to name. The honest answer is
  // that nothing was killed, not a claim about a process this call never met.
  const dir = tree()
  const local = join(dir, 'x')
  writeFileSync(local, 'payload')
  const { runner, state } = fakeRunner()
  state.nextRun = command => command.startsWith('stat ')
    ? ran('')
    : ran('', { status: 'exit-nonzero', exitCode: 1, stderr: 'mv: cannot move to /srv/x: Read-only file system' })
  state.streamImpl = (_argv, copy) => streamed(7)
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'upload', localPath: local, maxBytes: 1024 }))
  assert.equal(out.status, 'failed')
  assert.match(out.message, /mv: cannot move/, "the server's own sentence is what the reader is told")
  assert.match(out.notes.join('\n'), /never reported a mover pid/u)
  assert.match(out.notes.join('\n'), /nothing was killed on the server/u)
  assert.equal(state.calls.filter(c => c.kind === 'run' && isReap(c.command)).length, 0, 'and no cleanup child was spent on a pid that was never named')
})

test('a download the clock stopped on a server that cannot be asked says so instead of blaming the copy', async () => {
  // K-4 best-effort honesty: the cleanup child could not answer — here it timed out.
  // The transfer still refuses the way the deadline dictates, and the note names the
  // residual rather than claiming the server was tidied.
  const dir = tree()
  const local = join(dir, 'x')
  const { runner, state } = fakeRunner()
  state.nextRun = command => isReap(command)
    ? { status: 'timeout', at: iso, exitCode: null, stdout: '', stderr: 'ssh: timed out', durationMs: 10_000 }
    : ran('10 regular file')
  state.streamImpl = (argv, copy) => ({ outcome: 'timeout', exitCode: null, bytes: 340, stdout: '', stderr: moverStderr(argv), durationMs: 4 })
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, maxBytes: 4096 }))
  assert.equal(out.status, 'failed')
  assert.match(out.message, /ran out of its deadline/, 'the refusal stands on its own')
  assert.match(out.notes.join('\n'), /got no answer, so this plugin cannot say whether that mover is gone/u)
  assert.equal(/ended its own server-side mover/u.test(out.notes.join('\n')), false, 'and no success is claimed for a cleanup that never reported one')
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
  // The far end of a single-file download is a `cat` of the quoted path, run on the
  // authority as one argument — no `host:path` grammar, which belongs to scp — and it
  // says its own pid on stderr first, so a stopped copy has one process to name.
  const remote = String(call.argvTail[call.argvTail.length - 1])
  assert.match(remote, /^ms=0; \{ IFS= read -r _t <\/proc\/"\$\$"\/stat 2>\/dev\/null && \{ set -- \$\{_t##\*\) \}; ms=\$\{20:-0\}; \}; \} 2>\/dev\/null; printf 'dsh-mover %s %s %s\\n' "\$\$" '[a-z0-9-]+' "\$ms" >&2; exec cat -- '\/srv\/x'$/u)
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

// ── K-4: one copy, one identity, one process it is allowed to kill ───────────

test('a mover on a server that states no start time is refused, not killed on the number alone (K-4)', async () => {
  // 0.0.37 answered “no readable /proc entry” with `killed-unverified`: a SIGKILL
  // aimed at a bare number, which lands on whoever inherited that number if the
  // mover had already left. The 0.0.38 cleanup refuses instead, and the copy's note
  // says the mover was left running rather than dressing a refused cleanup as one
  // that ended something.
  const dir = tree()
  const local = join(dir, 'x')
  const { runner, state } = fakeRunner()
  let reaped
  state.nextRun = command => isReap(command)
    ? (reaped = command, ran('dsh-reap unverifiable'))
    : ran('99 regular file')
  // The marker carries the pid, the tag, and a start time of `0` — the shape of a
  // server whose `/proc` is absent or hidden.
  state.streamImpl = argv => ({ outcome: 'timeout', exitCode: null, bytes: 10, stdout: '', stderr: moverStderr(argv, 909, 0), durationMs: 2 })
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, remotePath: '/srv/x', maxBytes: 4096 }))
  assert.equal(out.status, 'failed')
  assert.match(String(reaped), /^P='909'; K='0'; p='\/srv\/x'; /u, 'the cleanup carries the recorded zero and must refuse on it')
  const note = out.notes.join('\n')
  assert.match(note, /left its server-side mover of \/srv\/x \(pid 909\) running/u, 'the residual is named as still running')
  assert.match(note, /could not be proved still its mover's/u, 'and the reason is the missing identity, not a failure to try')
  assert.equal(/ended its .*mover/u.test(note), false, 'and nothing is claimed as ended')
  assert.equal(/killed-unverified/u.test(note), false, 'the unverified kill is gone from the vocabulary')
})

test('two downloads of the same remote path each clean up only their own mover', async () => {
  // The 0.0.36 mechanism and the reason it is not a fix: two conversations pulling
  // the same file put the same words in `pkill -f`'s pattern, so the copy that was
  // interrupted took the copy that was still running down with it. Here the only thing
  // the cleanup has in common with its target is the pid that mover reported.
  const dir = tree()
  const localA = join(dir, 'a')
  const localB = join(dir, 'b')
  const reaps = []
  const mk = pid => {
    const { runner, state } = fakeRunner()
    state.nextRun = command => {
      if (!isReap(command)) return ran('99 regular file')
      reaps.push({ pid: command.match(/^P='([0-9]+)'/u)?.[1], command })
      return ran('dsh-reap killed')
    }
    state.streamImpl = argv => ({ outcome: 'timeout', exitCode: null, bytes: 120, stdout: '', stderr: moverStderr(argv, pid), durationMs: 3 })
    return { runner, local: pid === 4242 ? localA : localB }
  }
  const a = mk(4242)
  const b = mk(9999)
  const both = await Promise.all([
    transfer(a.runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: a.local, maxBytes: 4096 })),
    transfer(b.runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: b.local, maxBytes: 4096 })),
  ])
  assert.deepEqual(both.map(out => out.status), ['failed', 'failed'])
  assert.equal(reaps.length, 2, 'each stopped copy fired exactly one cleanup')
  assert.equal(new Set(reaps.map(r => r.pid)).size, 2, 'and the two cleanups named different processes')
  assert.notEqual(reaps[0].command.includes("P='9999'"), reaps[0].command.includes("P='4242'"), 'one command, one pid')
  for (const reap of reaps) {
    assert.match(String(reap.command), /p='\/srv\/x'; /u, 'the shared path is only the identity to confirm for that pid')
    assert.equal(reap.command.includes('pkill'), false)
    assert.equal(reap.command.includes('pgrep'), false, 'and no search of the process table is involved at all')
  }
  for (const out of both) assert.match(out.notes.join('\n'), /ended its own server-side mover/u)
})

test('every verdict a cleanup can give is reported for what it is', () => {
  // The note is the product here: 0.0.36 could answer a cleanup that had not run with
  // silence, and silence reads as tidied.
  assert.equal(guards.moverVerdictNote('gone', 7, '/srv/x', 'host'), undefined, 'a mover that left with the channel needs no sentence')
  assert.match(String(guards.moverVerdictNote('killed', 7, '/srv/x', 'host')), /ended its own server-side mover of \/srv\/x \(pid 7\), confirmed from that pid's command line/u)
  assert.match(String(guards.moverVerdictNote('unverifiable', 7, '/srv/x', 'host')), /states no readable \/proc entry/u)
  assert.match(String(guards.moverVerdictNote('unverifiable', 7, '/srv/x', 'host')), /so the number could not be proved still its mover's/u)
  assert.match(String(guards.moverVerdictNote('unverifiable', 7, '/srv/x', 'host')), /left its server-side mover .* running/u, 'the note says plainly that the mover was NOT ended')
  assert.match(String(guards.moverVerdictNote('killed', 7, '/srv/x', 'host')), /command line and start time/u, 'a kill is claimed only with both checks behind it')
  assert.match(String(guards.moverVerdictNote('killed', 7, '/srv/x', 'host')), /frozen with SIGSTOP/u, 'and the note says the identity was closed before the signal')
  assert.match(String(guards.moverVerdictNote('foreign', 7, '/srv/x', 'host')), /is no longer that mover.*so nothing was killed/u)
  assert.match(String(guards.moverVerdictNote('refused', 7, '/srv/x', 'host')), /host refused the signal, so that mover may still be running/u)
  assert.match(String(guards.moverVerdictNote('unanswered', 7, '/srv/x', 'host')), /cannot say whether that mover is gone/u)
  for (const verdict of ['killed', 'unverifiable', 'foreign', 'refused', 'unanswered']) {
    const note = String(guards.moverVerdictNote(verdict, 7, '/srv/x', 'host'))
    assert.ok(note.includes('/srv/x'), `${verdict}: names the file at stake`)
    assert.ok(note.includes('pid 7'), `${verdict}: names the process it spoke of`)
  }
})

test('the cleanup child is built from the mover identity and the path word, and answers with one verdict', () => {
  const command = guards.reapMoverCommand(4242, 1700000000, remotePathArg('/srv/a b [x] * ? + .f'))
  assert.ok(command.startsWith(`P='4242'; K='1700000000'; p=${remotePathArg('/srv/a b [x] * ? + .f')}; `), 'the pid and its start time are quoted as numbers and the path stays a shell word the server expands')
  for (const needle of ['kill -0 "$P"', '/proc/"$P"/cmdline', '/proc/"$P"/stat', "tr '\\0' '\\n'", "sed -n 3p", 'kill -STOP "$P"', 'kill -CONT "$P"', 'kill -9 "$P"', '= Z ]']) {
    assert.ok(command.includes(needle), `the script uses ${needle}`)
  }
  assert.equal(command.includes('pkill'), false, 'and it needs nothing that a server may not have installed')
  assert.equal(command.includes('killed-unverified'), false, 'the 0.0.37 kill-on-the-number-alone is gone from the script')
  for (const verdict of ['gone', 'killed', 'foreign', 'refused', 'unverifiable']) {
    assert.equal(guards.parseMoverVerdict(`dsh-reap ${verdict}\n`), verdict)
  }
  assert.equal(guards.parseMoverVerdict(''), 'unanswered', 'a server that said nothing is not a server that did nothing')
  assert.equal(guards.parseMoverVerdict('dsh-reap maybe'), 'unanswered')
  assert.equal(guards.parseMoverVerdict('cat: /proc/1/cmdline: Permission denied'), 'unanswered')
})

test('a mover pid is bound to the copy that reported it, not to any line that looks alike', () => {
  assert.deepEqual(guards.moverPid('dsh-mover 4242 aaa1-bbbbbbbb 1700000000\n', 'aaa1-bbbbbbbb'), { pid: 4242, starttime: 1700000000 })
  // A `0` start time is a server that states no `/proc`: the number is still this
  // copy's mover, and the cleanup will refuse to kill it on the number alone.
  assert.deepEqual(guards.moverPid('dsh-mover 4242 aaa1-bbbbbbbb 0\n', 'aaa1-bbbbbbbb'), { pid: 4242, starttime: 0 }, 'the missing time is kept as a known unknown')
  assert.equal(guards.moverPid('dsh-mover 4242 other-tag 1700000000\n', 'aaa1-bbbbbbbb'), undefined, 'another copy’s marker is not this copy’s mover')
  assert.equal(guards.moverPid('ssh: Permission denied\n', 'aaa1-bbbbbbbb'), undefined, 'and a server that never ran the command has no mover')
  assert.equal(guards.moverPid('dsh-mover not-a-number aaa1-bbbbbbbb\n', 'aaa1-bbbbbbbb'), undefined)
  assert.equal(guards.moverPid(undefined, 'aaa1-bbbbbbbb'), undefined)
  // The marker is this plugin's own sentence: it may not survive into the text the
  // reader is handed as the explanation of a failed copy.
  const stripped = guards.stripMoverMarker('dsh-mover 4242 aaa1-bbbbbbbb 1700000000\ncat: /srv/x: Permission denied\n')
  assert.equal(stripped.includes('dsh-mover'), false, 'the pid line is edited out')
  assert.match(stripped, /Permission denied/u, 'and the server’s own reason is kept')
})

test('a stopped download with a path full of shell and regex metacharacters kills by pid alone', async () => {
  // remotePathSchema allows spaces, brackets, glob characters and `+`; a `pkill -f`
  // pattern built from those is a regular expression built from a user's sentence.
  const weird = '/srv/a b [x] * ? + .f#~'
  const dir = tree()
  const local = join(dir, 'x')
  const { runner, state } = fakeRunner()
  let reaped
  state.nextRun = command => isReap(command)
    ? (reaped = command, ran('dsh-reap killed'))
    : ran('999 regular file')
  state.streamImpl = argv => ({ outcome: 'timeout', exitCode: null, bytes: 10, stdout: '', stderr: moverStderr(argv, 909), durationMs: 2 })
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, remotePath: weird, maxBytes: 4096 }))
  assert.equal(out.status, 'failed')
  assert.ok(reaped, 'the copy still cleaned up after itself')
  assert.match(String(reaped), /^P='909'; K='1700000000'; p='\/srv\/a b \[x\] \* \? \+ \.f#~'; /u, 'the odd path is one quoted argument, never a pattern')
  assert.match(String(reaped), /= "\$p"/u, 'and it is compared as a string against the mover’s own third argument')
  const note = out.notes.join('\n')
  assert.ok(note.includes(`ended its own server-side mover of ${weird} (pid 909)`), 'the note names this copy\u2019s path and its mover, in plain words, not as a pattern')
})

test('a download stopped before its mover spoke is told as an unnamed residual, not as a tidied server', async () => {
  const dir = tree()
  const local = join(dir, 'x')
  const { runner, state } = fakeRunner()
  let children = 0
  state.nextRun = command => {
    if (isReap(command)) children += 1
    return ran('900 regular file')
  }
  // The channel died with nothing on stderr: no marker, so no pid, so no kill.
  state.streamImpl = () => ({ outcome: 'timeout', exitCode: null, bytes: 512, stdout: '', stderr: 'ssh: connect to host closed\n', durationMs: 2 })
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: local, maxBytes: 4096 }))
  assert.equal(children, 0, 'no cleanup child was spent guessing at a process')
  assert.match(out.notes.join('\n'), /never reported a server-side mover pid for \/srv\/x/u)
  assert.match(out.notes.join('\n'), /a mover may still be holding that fifo or file/u)
  assert.equal(/ended .*mover/u.test(out.notes.join('\n')), false, 'and nothing is claimed as ended')
})

// ── K-4 / 执行层寻址: the mover and its cleanup address one and the same word ──

test('the cleanup names the path in the same shell shape the mover was given, for every path the gate accepts', async () => {
  // The identity check in `reapMoverCommand` compares the mover's third argv field
  // with `$p`, and `$p` is assigned from the path *word*, not from a string this
  // process reconstructed. If the two ever drifted — one quoted, one not, a tilde
  // expanded on one side only — a `~/x` copy would stop being killable, and the copy
  // would say so as a residual instead of killing the wrong process.
  const shapes = [
    '/srv/x',
    '/srv/a b/x',
    '/srv/a b [x] * ? + .f#~',
    '/srv/a\tb',
    "/srv/it's",
    '~/x',
    '~/a b/x',
    '/srv/x.bin',
    '/srv/ünïcode/x',
  ]
  const { remotePathSchema } = await import('../lib/storage.js')
  for (const path of shapes) {
    assert.ok(remotePathSchema.safeParse(path).success, `${path}: the gate admits this shape`)
    const word = remotePathArg(path)
    const mover = guards.downloadMoverCommand(word, 'aaa1-bbbbbbbb')
    const reaped = guards.reapMoverCommand(4242, 1700000000, word)
    const inMover = /exec cat -- (.+)$/.exec(mover)?.[1]
    const inReap = /^P='4242'; K='1700000000'; p=(.*?); if ! kill/.exec(reaped)?.[1]
    assert.equal(inMover, word, `${path}: the mover gets exactly the word the transport shaped`)
    assert.equal(inReap, word, `${path}: and the cleanup compares against that same word`)
    assert.equal(reaped.includes('pkill'), false, `${path}: no pattern is searched across the process table`)
  }
})

test('the gate refuses the shapes the mover command could not carry, and says so before a round trip', async () => {
  // Not a K-4 fix so much as the boundary that makes K-4 provable: a path with `;`,
  // a backtick, a `$`, a parenthesis or a newline in it is refused by
  // `remotePathSchema`, which is what lets `remotePathArg` and the `/proc` comparison
  // below it be one quoted word apiece. A test that only checks the accepted half
  // would pass even if the gate widened.
  const { remotePathSchema } = await import('../lib/storage.js')
  for (const path of ['/srv/a;b', '/srv/a|b', '/srv/a&b', '/srv/a<b', '/srv/a>b', '/srv/$(id)', '/srv/`id`', '/srv/a\nb', '/srv/a\rb', 'srv/x', './x', '']) {
    assert.equal(remotePathSchema.safeParse(path).success, false, `${JSON.stringify(path)}: refused at the gate`)
  }
  // A tab is *not* a shell word boundary once the path is quoted, and the gate knows
  // it: this is the shape that would have been refused by a `\s` ban, and the mover and
  // the `/proc` comparison both have to carry it unchanged to stay addressed.
  for (const path of ['/srv/a b', '/srv/a\tb', '/srv/[x]', '/srv/*.f', '/srv/x+y', '/srv/~x', '~/x', "/srv/it's"]) {
    assert.equal(remotePathSchema.safeParse(path).success, true, `${JSON.stringify(path)}: still addressable`)
  }
  // `transfer.ts` sits **below** the gate and still quotes whatever it is handed, so a
  // path that reached it by another route is still addressed as one word; the gate in
  // `ops.ts` is what keeps the *identity* comparison safe as well (the ops suite's
  // `a relative or punctuated path refuses before any round trip` pins that half).
  const dir = tree()
  const { runner, state } = fakeRunner()
  state.nextRun = () => ran('5 regular file')
  state.streamImpl = (_argv, copy) => writeBack(copy.localPath, 'hello')
  const out = await transfer(runner, TARGET, SETTINGS, {}, base({ direction: 'download', localPath: join(dir, 'x'), remotePath: '/srv/a;b', maxBytes: 1024 }))
  assert.equal(out.status, 'moved', 'the copy itself answered in the ordinary vocabulary')
  const stream = state.calls.find(c => c.kind === 'streamFile')
  assert.ok(stream, 'and it was dialed with the odd path inside one quoted word')
  assert.match(String(stream.argvTail.at(-1)), /exec cat -- '\/srv\/a;b'$/u)
})
