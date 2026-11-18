// Who is allowed to collect what from the shared system temp directory.
//
// The rule this plugin settled on is narrow enough to state in one breath — only
// our own namespace, only our own uid, only a generation that is provably gone —
// and every one of those three limits has a case here, because each is a
// different way to delete somebody else's running system. The tests build a real
// directory tree in a real temp root and use a real listening unix socket for the
// one case that cannot be faked without lying: a control socket whose master is
// still up, however old the directory holding it has become.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pidOf, socketLive, sweep, classify, LEGACY_STALE_MS, TEMP_PREFIXES } from '../lib/tmpgc.js'

const uid = process.getuid?.() ?? 0

/** A fresh temp root to stage directories inside, named so it sweeps itself away. */
async function stage () {
  const base = await mkdtemp(join(tmpdir(), 'dshssh-gc-'))
  return base
}

/** Backdate one directory, so "old" is a fact the filesystem agrees with. */
function aged (path, ageMs) {
  const when = new Date(Date.now() - ageMs)
  utimesSync(path, when, when)
  return path
}

/**
 * One namespace directory, with whatever files its generation left behind.
 *
 * Aging touches the directory *and* everything inside it: the idle rule the sweep
 * applies to an askpass directory reads the helper's own timestamps as well, so a
 * fixture that only aged the parent would be claiming something was unused while
 * leaving the evidence that it was not.
 */
function make (base, prefix, name, options = {}) {
  const path = join(base, `${prefix}${name}`)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  for (const [file, content] of Object.entries(options.files ?? {})) {
    writeFileSync(join(path, file), content, { mode: 0o600 })
  }
  if (options.ageMs === undefined) return path
  aged(path, options.ageMs)
  for (const file of Object.keys(options.files ?? {})) aged(join(path, file), options.ageMs)
  return path
}

/** Age one file inside an existing directory, leaving the directory itself alone. */
function ageFile (path, ageMs) {
  return aged(path, ageMs)
}

/** A pid that has certainly exited, so a liveness probe has something dead to name. */
function deadPid () {
  const child = spawnSync('/bin/sh', ['-c', 'exit 0'])
  const pid = child?.pid
  assert.ok(typeof pid === 'number' && pid > 0, 'the probe must have had a process id')
  // `spawnSync` reaps it, so the id is gone: the one dead thing a test can be
  // sure of without waiting on the process table.
  assert.equal(isAlive(pid), false, `pid ${String(pid)} should already be reaped`)
  return pid
}

function isAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ── the name carries the generation ─────────────────────────────────────────
test('the process id in a directory name is read back, and a name without one is legacy', () => {
  assert.equal(pidOf('dsh-ssh-mux-p4242-Q7dKz3', 'dsh-ssh-mux-'), 4242)
  assert.equal(pidOf('dsh-ssh-askpass-p1-abcDEF', 'dsh-ssh-askpass-'), 1)
  assert.equal(pidOf('dsh-ssh-mux-XxYyZz', 'dsh-ssh-mux-'), undefined)
  assert.equal(pidOf('dsh-ssh-mux-pQ7dKz3', 'dsh-ssh-mux-'), undefined)
  assert.equal(pidOf('dsh-ssh-mux-p0-x', 'dsh-ssh-mux-'), undefined, 'pid 0 is not a generation')
  assert.equal(pidOf('dsh-ssh-mapping-p9-x', 'dsh-ssh-mux-'), undefined, 'a neighbour that merely starts similarly')
})

test('the prefixes the sweep will touch are exactly the two this plugin makes', () => {
  assert.deepEqual([...TEMP_PREFIXES], ['dsh-ssh-askpass-', 'dsh-ssh-mux-'])
})

// ── the decisions ───────────────────────────────────────────────────────────
test('a dead generation is collected and a running one is left alone', async () => {
  const base = await stage()
  const dead = deadPid()
  const gone = make(base, 'dsh-ssh-askpass-', `p${String(dead)}-gone000`, { files: { 'askpass.sh': '#!/bin/sh\n' } })
  const live = make(base, 'dsh-ssh-askpass-', `p${String(process.pid)}-live00`, { files: { 'askpass.sh': '#!/bin/sh\n' } })
  const ours = make(base, 'dsh-ssh-mux-', `p${String(process.pid)}-self0`, { files: { 'ssh-a-1.sock': '' } })
  const result = await sweep({ root: base, uid, self: [ours] })
  assert.deepEqual(result.removed.map(entry => entry.path), [gone])
  assert.equal(result.removed[0]?.verdict.reason, 'dead-pid')
  assert.equal(existsSync(gone), false, 'the dead generation is gone')
  assert.equal(readFileSync(join(live, 'askpass.sh'), 'utf8'), '#!/bin/sh\n', 'a running Host keeps its helper')
  assert.equal(existsSync(ours), true, 'this activation keeps its own directory')
  const reasons = new Map(result.kept.map(entry => [entry.path, entry.verdict.reason]))
  assert.equal(reasons.get(live), 'alive')
  assert.equal(reasons.get(ours), 'ours')
})

test('a socket whose master is still listening is never collected, whatever its name says', async () => {
  const base = await stage()
  const dead = deadPid()
  const held = make(base, 'dsh-ssh-mux-', `p${String(dead)}-hold00`)
  const socketPath = join(held, 'ssh-0ec928ba3a-610986449f.sock')
  const server = createServer(connection => { connection.end() })
  await new Promise(resolve => { server.listen(socketPath, resolve) })
  try {
    assert.equal(await socketLive(socketPath), true, 'the probe itself must see the live socket')
    const result = await sweep({ root: base, uid })
    assert.deepEqual(result.removed, [], 'a live master owns that path until it decides otherwise')
    assert.equal(result.kept[0]?.verdict.reason, 'live-socket')
    assert.equal(existsSync(socketPath), true)
  } finally {
    await new Promise(resolve => { server.close(resolve) })
    rmSync(socketPath, { force: true })
  }
})

test('a socket file nobody is listening on is residue, and its directory goes with it', async () => {
  const base = await stage()
  const dead = deadPid()
  const stale = make(base, 'dsh-ssh-mux-', `p${String(dead)}-stale0`, { files: { 'ssh-a-1.sock': '' } })
  assert.equal(await socketLive(join(stale, 'ssh-a-1.sock')), false, 'an unclaimed socket answers nothing')
  const result = await sweep({ root: base, uid })
  assert.deepEqual(result.removed.map(entry => entry.path), [stale])
  assert.equal(existsSync(stale), false)
})

test('an old directory whose helper was used yesterday is not residue', async () => {
  // The rule the shorter window got wrong on a live machine: a Host that has been
  // up for days, using its helper daily, has an *old directory* and a young file.
  const base = await stage()
  const held = make(base, 'dsh-ssh-askpass-', 'lfVmHf', { ageMs: LEGACY_STALE_MS + 60_000, files: { 'askpass.sh': '#!/bin/sh\n' } })
  ageFile(join(held, 'askpass.sh'), 60_000)
  const result = await sweep({ root: base, uid })
  assert.deepEqual(result.removed, [], 'the helper says somebody used it')
  assert.equal(result.kept[0]?.verdict.reason, 'young')
  assert.equal(existsSync(join(held, 'askpass.sh')), true)
})

test('a helper a running process names in its environment is kept whatever its timestamps', async () => {
  const base = await stage()
  const held = make(base, 'dsh-ssh-askpass-', 'p0oldold', { ageMs: LEGACY_STALE_MS + 60_000, files: { 'askpass.sh': '#!/bin/sh\n' } })
  ageFile(join(held, 'askpass.sh'), LEGACY_STALE_MS + 60_000)
  const other = await stage()
  const unclaimed = make(other, 'dsh-ssh-askpass-', 'p0oldold', { ageMs: LEGACY_STALE_MS + 60_000, files: { 'askpass.sh': '#!/bin/sh\n' } })
  ageFile(join(unclaimed, 'askpass.sh'), LEGACY_STALE_MS + 60_000)
  const before = await sweep({ root: other, uid, claims: new Set() })
  assert.deepEqual(before.removed.map(entry => entry.path), [unclaimed], 'with nobody claiming it, it is residue')
  const again = await sweep({ root: base, uid, claims: new Set([join(held, 'askpass.sh')]) })
  assert.deepEqual(again.removed, [], 'a running Host naming it settles the question')
  assert.equal(again.kept[0]?.verdict.reason, 'in-use')
})

test('legacy names are judged by age, and only by age once they are old enough', async () => {
  const base = await stage()
  const fresh = make(base, 'dsh-ssh-askpass-', 'YQ4RqT', { files: { 'askpass.sh': 'x' } })
  const old = make(base, 'dsh-ssh-askpass-', 'jRRpbw', { ageMs: LEGACY_STALE_MS + 60_000, files: { 'askpass.sh': 'x' } })
  const result = await sweep({ root: base, uid })
  assert.deepEqual(result.removed.map(entry => entry.path), [old])
  assert.equal(result.removed[0]?.verdict.reason, 'legacy-age')
  const reasons = new Map(result.kept.map(entry => [entry.path, entry.verdict.reason]))
  assert.equal(reasons.get(fresh), 'young', 'a generation that may still be starting up is not disturbed')
})

test('the sweep stops at its own namespace: another provider files are not this plugin business', async () => {
  const base = await stage()
  // The subprocess provider per-process directory, with a completed spill file in
  // it — the residue this plugin explicitly refuses to collect, because the
  // provider owns it, names it to readers, and never expects a consumer to unlink
  // it. Then two neighbours that are close enough to confuse a prefix-free sweep.
  const provider = join(base, 'dsh-subprocess-K7RcSY')
  mkdirSync(provider, { recursive: true, mode: 0o700 })
  writeFileSync(join(provider, 'dsh-subprocess-1-2-abcd-stdout.log'), 'the whole output')
  const neighbour = make(base, 'dsh-ssh-mapping-', 'p1-x')
  const file = join(base, 'dsh-ssh-mux-p1-notadir')
  writeFileSync(file, 'a file wearing a directory name')
  const dangling = join(base, 'dsh-ssh-mux-p1-dangle')
  symlinkSync(join(base, 'nowhere-at-all'), dangling)
  const result = await sweep({ root: base, uid })
  assert.deepEqual(result.removed, [])
  // Two of the six staged entries are in this plugin's namespace (the file and
  // the symlink that only look like directories); the provider directory and the
  // neighbour plugin prefix are never even asked about.
  assert.equal(result.scanned, 2, 'only the namespace entries were looked at')
  assert.equal(readFileSync(join(provider, 'dsh-subprocess-1-2-abcd-stdout.log'), 'utf8'), 'the whole output')
  assert.equal(existsSync(neighbour), true)
  assert.equal(existsSync(file), true, 'a file is not a directory this plugin made')
  const reasons = new Map(result.kept.map(entry => [entry.path, entry.verdict.reason]))
  assert.equal(reasons.get(file), 'not-a-directory')
  assert.equal(reasons.get(dangling), 'not-a-directory', 'a dangling symlink is not collected as a directory')
})

test('a sweep run by another uid collects nothing of ours', async () => {
  const base = await stage()
  const dead = deadPid()
  const gone = make(base, 'dsh-ssh-askpass-', `p${String(dead)}-x`, { files: { 'askpass.sh': 'x' } })
  const result = await sweep({ root: base, uid: uid + 1000 })
  assert.deepEqual(result.removed, [])
  assert.equal(result.kept[0]?.verdict.reason, 'not-owned')
  assert.equal(existsSync(gone), true, 'somebody else pid may as well be somebody else file')
})

test('a removal that fails is reported and does not end the sweep', async () => {
  const base = await stage()
  const dead = deadPid()
  const first = make(base, 'dsh-ssh-askpass-', `p${String(dead)}-one`)
  const second = make(base, 'dsh-ssh-askpass-', `p${String(dead)}-two`)
  const seen = []
  const result = await sweep({
    root: base,
    uid,
    remove: async (path) => {
      seen.push(path)
      if (path === first) throw new Error('EBUSY: the directory is not ready')
      rmSync(path, { recursive: true, force: true })
    }
  })
  assert.equal(seen.length, 2, 'the sweep kept going after the first refusal')
  assert.deepEqual(result.removed.map(entry => entry.path), [second])
  assert.deepEqual(result.errors, [{ path: first, message: 'EBUSY: the directory is not ready' }])
  assert.equal(existsSync(second), false)
})

test('a candidate that cannot be stated is kept as unreadable rather than assumed dead', async () => {
  const base = await stage()
  const entry = await classify(join(base, 'dsh-ssh-mux-p1-gone'), 'dsh-ssh-mux-', { uid, now: Date.now(), self: new Set() })
  assert.equal(entry.verdict.reason, 'unreadable')
  assert.equal(entry.pid, 1, 'the name is still read, so a log line can quote it')
})

test('a liveness probe that says alive wins over the pid table', async () => {
  const base = await stage()
  const kept = make(base, 'dsh-ssh-mux-', 'p999999-probe', { files: { 'ssh-a-1.sock': '' } })
  const result = await sweep({ root: base, uid, alive: () => true })
  assert.deepEqual(result.removed, [])
  assert.equal(existsSync(kept), true)
})

test('the real temp directory can be walked without touching what a running Host owns', async () => {
  // A read-only pass over the machine's actual residue: the sweep must neither
  // throw nor propose removing a directory the process asking is itself using.
  const mine = await mkdtemp(join(tmpdir(), 'dsh-ssh-askpass-p'))
  const result = await sweep({ root: tmpdir(), uid, self: [mine], remove: async () => undefined })
  assert.equal(existsSync(mine), true)
  assert.ok(result.kept.some(entry => entry.path === mine), 'the directory just made is recognised as ours')
  assert.ok(!result.removed.some(entry => entry.path === mine))
  assert.ok(result.scanned >= 1, 'this machine has namespace entries to look at')
  rmSync(mine, { recursive: true, force: true })
})
