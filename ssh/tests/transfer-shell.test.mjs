// K-4, run against the real kernel instead of a faked seam: these tests park a
// genuine mover (a `cat` blocked on a fifo with no writer — the shape that stranded
// on live servers for eight to eleven hours), read the identity marker it prints on
// its own stderr, and run the real cleanup script the plugin generates. `/proc` here
// is the kernel's, so every verdict is checked against process facts: does the
// number still exist, does it still carry the same start time, was anything left
// SIGSTOPped, and did an unrelated process (the sentinel) feel none of it.
//
// What the faked-transport suite cannot prove and this one can: that the identity
// checks are not decoration around the kill. A wrong start time — the shape a
// recycled pid wears — is refused before any signal; a mover with no recorded start
// time is refused instead of killed on the number alone (0.0.37's
// `killed-unverified`, retired by K-4); and the freeze protocol guarantees the
// process whose identity was verified is the process the signal lands on.
import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { spawn } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadMoverCommand, publishCommand, reapMoverCommand, moverPid, parseMoverVerdict } from '../lib/transfer.js'

const SH = existsSync('/bin/sh') ? '/bin/sh' : null
const DASH = existsSync('/bin/dash') ? '/bin/dash' : null
const SKIP = SH === null
  ? 'no POSIX shell on this machine'
  : !existsSync('/proc/self/stat') || !existsSync('/proc/self/cmdline')
    ? 'no /proc to verify process identity against'
    : false

const dir = mkdtempSync(join(tmpdir(), 'dshssh-reap-'))
const spawned = []
let seq = 0

after(() => {
  for (const child of spawned) {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }
  rmSync(dir, { recursive: true, force: true })
})

const shellQuote = (word) => `'${word.replace(/'/gu, `'\\''`)}'`
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** One fifo per scenario: `cat -- fifo` with no writer parks in open(), like K-4. */
function fifo () {
  const p = join(dir, `f-${String(seq++)}`)
  const made = spawnSync(SH ?? '/bin/sh', ['-c', `mkfifo ${shellQuote(p)}`])
  assert.equal(made.status, 0, 'this machine can make fifos, the shape K-4’s stranded movers wait on')
  return p
}

/** Await one command through the given shell; no stdin, capped by the test clock. */
function run (bin, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-c', command])
    spawned.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    // `close`, not `exit`: the verdict line must have finished crossing the pipe
    // before the answer is parsed — `exit` fires while stdout is still draining,
    // and a cleanup whose answer was read too early reads as `unanswered`.
    child.once('close', status => resolve({ status, stdout, stderr }))
  })
}

/**
 * Kernel facts about a pid, read fresh: is it alive, what state is it in, and which
 * start time does the number carry right now. `starttime` is field 20 of the text
 * after the last `) ` in `/proc/<pid>/stat` — the same counting the cleanup script
 * does, done independently here in JavaScript so the test never borrows the
 * implementation's own arithmetic.
 */
function procFacts (pid) {
  if (!existsSync(`/proc/${String(pid)}`)) return { alive: false, state: null, starttime: null }
  let stat = ''
  let state = null
  try {
    stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    state = /^State:\s*(\S)/mu.exec(readFileSync(`/proc/${String(pid)}/status`, 'utf8'))?.[1] ?? null
  } catch {
    return { alive: false, state: null, starttime: null } // it exited mid-read: that is "gone"
  }
  const tail = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
  return { alive: true, state, starttime: tail[19] ?? null }
}

/**
 * Start a mover command for real and wait for the identity line it prints, exactly
 * the way the transport collects it: off the child's stderr, bound to this copy's
 * tag before the pid counts as anything.
 * @returns the live child plus the `{ pid, starttime }` it announced.
 */
async function startMover (bin, command, tag) {
  const child = spawn(bin, ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
  spawned.push(child)
  child.stdout.resume() // keep a mover that starts flowing from ever blocking on a full pipe
  let buf = ''
  const identity = await new Promise((resolve) => {
    // Not unref'd: if the marker never arrives, this timer is what lets the test
    // fail with a sentence instead of stranding the runner on a pending promise.
    const timer = setTimeout(() => resolve(undefined), 5_000)
    const tryParse = () => {
      const found = moverPid(buf, tag)
      if (found !== undefined) {
        clearTimeout(timer)
        resolve(found)
      }
    }
    child.stderr.on('data', chunk => {
      buf += String(chunk)
      tryParse()
    })
    tryParse()
  })
  if (identity === undefined) {
    child.kill('SIGKILL')
    assert.fail(`the mover never announced its identity on stderr (tag ${tag}, saw ${JSON.stringify(buf.slice(0, 80))})`)
  }
  return { child, identity }
}

/** Ask the real kernel about a real pid through the real cleanup script. */
async function reap (bin, pid, starttime, word) {
  const res = await run(bin, reapMoverCommand(pid, starttime, word))
  return {
    verdict: parseMoverVerdict(res.stdout),
    stdout: res.stdout.trim(),
    // Kept for a failing assertion's sentence: an answer that never mentions a
    // verdict is a script that stopped early, and *where* it stopped is in stderr
    // and the exit status.
    stderr: res.stderr.trim(),
    status: res.status,
    command: reapMoverCommand(pid, starttime, word),
  }
}

/** Until the number stops existing (or is a reaped-out zombie), capped. */
async function awaitGone (pid, capMs = 3_000) {
  const deadline = Date.now() + capMs
  while (Date.now() < deadline) {
    const facts = procFacts(pid)
    if (!facts.alive || facts.state === 'Z') return true
    await sleep(25)
  }
  return false
}

// ── B. the mover lifecycle, under every shell the plugin promises to speak ──

for (const bin of [SH, DASH].filter(Boolean)) {
  test(`a parked mover is ended by its own cleanup, and says killed (${bin})`, { skip: SKIP }, async () => {
    const path = fifo()
    const mover = await startMover(bin, downloadMoverCommand(shellQuote(path), 'aaa1-bbbbbbbb'), 'aaa1-bbbbbbbb')
    // The mover `exec`s into cat, so the pid in the marker *is* the process, and
    // the start time it carried across the exec is the kernel's own for that number.
    assert.ok(mover.identity.starttime > 0, 'a server with /proc states a real start time')
    assert.equal(procFacts(mover.child.pid).starttime, String(mover.identity.starttime), 'the marker’s time is the kernel’s time for this pid')
    const first = await reap(bin, mover.child.pid, mover.identity.starttime, shellQuote(path))
    assert.equal(first.verdict, 'killed', `the cleanup said ${JSON.stringify(first.stdout)}`)
    assert.ok(await awaitGone(mover.child.pid), 'the parked mover left the process table')
    // Idempotent: a second cleanup of the same identity says gone, never a second kill.
    const again = await reap(bin, mover.child.pid, mover.identity.starttime, shellQuote(path))
    assert.equal(again.verdict, 'gone', `a repeat cleanup cannot claim a second kill (out ${JSON.stringify(again.stdout)} err ${JSON.stringify(again.stderr)} status ${String(again.status)})`)
    mover.child.kill()
  })

  test(`a mover that finished on its own is gone, and nobody else is touched (${bin})`, { skip: SKIP }, async () => {
    const path = join(dir, `plain-${String(seq++)}`)
    writeFileSync(path, 'payload\n')
    // A mover on a regular file EOFs at once: the cleanup meets a dead number.
    const mover = await startMover(bin, downloadMoverCommand(shellQuote(path), 'aaa2-bbbbbbbb'), 'aaa2-bbbbbbbb')
    await new Promise(resolve => { mover.child.once('exit', resolve); setTimeout(resolve, 3_000).unref?.() })
    assert.ok(await awaitGone(mover.child.pid), 'the mover exited when its file ended')
    const r = await reap(bin, mover.child.pid, mover.identity.starttime, shellQuote(path))
    assert.equal(r.verdict, 'gone', `an exited mover is accounted, not guessed: ${JSON.stringify(r.stdout)}`)
  })

  test(`a wrong start time reads as a recycled pid and stops short of the signal (${bin})`, { skip: SKIP }, async () => {
    const path = fifo()
    const mover = await startMover(bin, downloadMoverCommand(shellQuote(path), 'aaa3-bbbbbbbb'), 'aaa3-bbbbbbbb')
    const before = procFacts(mover.child.pid)
    // Alive, right argv — only the *time* disagrees, the shape of a number whose
    // first owner left and whose new owner happens to run the very same command.
    // Killing on the number alone is what K-4 forbids.
    const r = await reap(bin, mover.child.pid, mover.identity.starttime - 1, shellQuote(path))
    assert.equal(r.verdict, 'foreign', `the identity mismatch refused: ${JSON.stringify(r.stdout)}`)
    const after = procFacts(mover.child.pid)
    assert.equal(after.alive, true, 'the living process was not killed')
    assert.notEqual(after.state, 'T', 'and it was never frozen by the refused cleanup (R→S scheduling moves are not signals)')
    assert.equal(after.starttime, before.starttime, 'still the same process start time and all')
    // Aimed correctly, the very same mover is killed — the refusal was about the
    // identity, not about an inability to clean at all.
    const right = await reap(bin, mover.child.pid, mover.identity.starttime, shellQuote(path))
    assert.equal(right.verdict, 'killed')
    await awaitGone(mover.child.pid)
    mover.child.kill()
  })

  test(`a recorded start time of zero is refused, never killed on the number alone (${bin})`, { skip: SKIP }, async () => {
    // The heart of K-4. 0.0.37 answered “this server states no readable /proc
    // entry” with a SIGKILL taken on the recorded pid alone — `killed-unverified`.
    // If the number had been recycled, that strike landed on somebody else's work.
    // Now the cleanup refuses: no SIGSTOP, no SIGKILL, an explicit verdict, and the
    // stranded mover named as a cost rather than papered over.
    const path = fifo()
    const mover = await startMover(bin, downloadMoverCommand(shellQuote(path), 'aaa4-bbbbbbbb'), 'aaa4-bbbbbbbb')
    const before = procFacts(mover.child.pid)
    const r = await reap(bin, mover.child.pid, 0, shellQuote(path))
    assert.equal(r.verdict, 'unverifiable', `the refusal is explicit: ${JSON.stringify(r.stdout)}`)
    assert.doesNotMatch(r.stdout, /killed/u, 'and nothing is claimed as ended')
    const after = procFacts(mover.child.pid)
    assert.equal(after.alive, true, 'the process survives the refused cleanup')
    assert.notEqual(after.state, 'T', 'it received no unexpected stop, continue, or kill (its R→S scheduling is its own)')
    assert.equal(after.starttime, before.starttime, 'and it is the same process start time and all')
    mover.child.kill()
  })

  test(`an unrelated mover-shaped process on the same path is left alone by time and by word (${bin})`, { skip: SKIP }, async () => {
    // The sentinel, addressed the two ways a stranger can look like a mover: it
    // runs the same argv on the same path (so the argv check alone would pass), and
    // the only fact that separates it from this copy's long-dead mover is the start
    // time. The second direction matters too: right pid, right time, wrong path
    // word — the cleanup still refuses, because the third argv field must match.
    const path = fifo()
    const sentinel = spawn('/bin/cat', ['--', path], { stdio: ['ignore', 'ignore', 'pipe'] })
    spawned.push(sentinel)
    await sleep(150)
    const facts = procFacts(sentinel.pid)
    assert.equal(facts.alive, true, 'the sentinel parked on the same fifo, argv shaped like a mover')
    const recycled = await reap(bin, sentinel.pid, Number(facts.starttime) + 1, shellQuote(path))
    assert.equal(recycled.verdict, 'foreign', `a borrowed number with the wrong time refuses: ${JSON.stringify(recycled.stdout)}`)
    const during = procFacts(sentinel.pid)
    assert.equal(during.alive, true, 'the sentinel is alive')
    assert.equal(during.state !== 'T', true, 'and it was not left stopped by the refused attempt')
    const wrongPath = await reap(bin, sentinel.pid, Number(facts.starttime), shellQuote(join(dir, 'not-my-file')))
    assert.equal(wrongPath.verdict, 'foreign', 'the same process under the right time still fails the path word')
    const lastFacts = procFacts(sentinel.pid)
    assert.equal(lastFacts.alive, true, 'and the sentinel felt neither refusal')
    assert.equal(lastFacts.starttime, facts.starttime, 'same process throughout')
    sentinel.kill('SIGKILL')
  })

  test(`two movers on one path: each cleanup ends exactly its own process (${bin})`, { skip: SKIP }, async () => {
    // A/B, the regression 0.0.37 shipped and 0.0.38 must not lose: one path is not
    // an identity. A's cleanup may not touch B's process, and B's payload still
    // flows down B's own channel afterwards.
    const path = fifo()
    const a = await startMover(bin, downloadMoverCommand(shellQuote(path), 'aaaa-aaaaaaaa'), 'aaaa-aaaaaaaa')
    const b = await startMover(bin, downloadMoverCommand(shellQuote(path), 'bbbb-bbbbbbbb'), 'bbbb-bbbbbbbb')
    assert.notEqual(a.child.pid, b.child.pid, 'two movers, two numbers')
    // Two movers spawned inside the same scheduler tick share a start time: the
    // identity is the *pair* (pid, time) bound to this copy's marker, never either
    // number alone — which is exactly why A's cleanup carries A's pair and cannot
    // name B, whose number is different whatever the clock says.
    const ra = await reap(bin, a.child.pid, a.identity.starttime, shellQuote(path))
    assert.equal(ra.verdict, 'killed', `A's own cleanup: ${JSON.stringify(ra.stdout)}`)
    const bFacts = procFacts(b.child.pid)
    assert.equal(bFacts.alive, true, 'B is still parked on the shared path — A’s cleanup never reached it')
    assert.equal(bFacts.state !== 'T', true, 'and B was never frozen by it')
    // B still delivers: feed the fifo, read B's own stdout.
    const chunks = []
    b.child.stdout.on('data', chunk => chunks.push(String(chunk)))
    const writer = spawn('/bin/sh', ['-c', `printf 'for-B\\n' > ${shellQuote(path)}`])
    spawned.push(writer)
    let delivered = ''
    for (let wait = 0; wait < 40 && !delivered.includes('for-B'); wait += 1) {
      await sleep(50)
      delivered = chunks.join('')
    }
    assert.match(delivered, /for-B/u, 'B carried its payload through its own channel, untouched by A’s cleanup')
    const rb = await reap(bin, b.child.pid, b.identity.starttime, shellQuote(path))
    assert.ok(['killed', 'gone'].includes(rb.verdict), `B's own cleanup after delivery: ${rb.verdict}`)
    a.child.kill(); b.child.kill()
  })

  test(`a mover that exits mid-cleanup is accounted honestly, sentinel untouched (${bin})`, { skip: SKIP }, async () => {
    // The race the freeze protocol exists for: the target leaves during the
    // cleanup. The answer must be honest (`gone` or `killed`, never a claim about
    // a stranger), nothing may be left SIGSTOPped under the mover's number, and an
    // unrelated process beside it must feel nothing.
    const path = fifo()
    const mover = await startMover(bin, downloadMoverCommand(shellQuote(path), 'aaa5-bbbbbbbb'), 'aaa5-bbbbbbbb')
    const otherPath = fifo()
    const sentinel = spawn('/bin/cat', ['--', otherPath], { stdio: ['ignore', 'ignore', 'pipe'] })
    spawned.push(sentinel)
    await sleep(100)
    const before = procFacts(sentinel.pid)
    // Release the mover while the cleanup is in flight: a writer unblocks cat's
    // open(), cat EOFs, and the process table loses the number at an unknown point
    // inside the script's own sequence of checks.
    const writer = spawn('/bin/sh', ['-c', `printf 'x\\n' > ${shellQuote(path)}`])
    spawned.push(writer)
    const r = await reap(bin, mover.child.pid, mover.identity.starttime, shellQuote(path))
    assert.ok(['gone', 'killed', 'foreign'].includes(r.verdict), `a self-exiting mover is still accounted: ${JSON.stringify(r.stdout)}`)
    assert.notEqual(r.verdict, 'unverifiable', 'this server states /proc, so the identity was verifiable')
    const after = procFacts(sentinel.pid)
    assert.equal(after.alive, true, 'the sentinel ran through the whole race')
    assert.equal(after.state, before.state, 'and it received no unexpected stop or continue')
    assert.equal(after.starttime, before.starttime, 'the same process, start time and all')
    const mv = procFacts(mover.child.pid)
    assert.equal(mv.state === 'T', false, 'no half-finished cleanup left a stopped stranger under that number')
    await awaitGone(mover.child.pid)
    mover.child.kill(); sentinel.kill('SIGKILL')
  })
}

// ── the publish shape: a backgrounded mover with its own pid and start time ──

test('a backgrounded publish mover reports its own identity, and is ended by it', { skip: SKIP }, async () => {
  const part = join(dir, 'pub.part')
  // Bigger than the pipe buffer: once open completes, the write itself parks.
  writeFileSync(part, 'p'.repeat(256 * 1024))
  // A fifo destination keeps the mover blocked in write() — the stranded shape
  // K-4 was built for — while the publish script backgrounds it and reports "$mp".
  // A reader that opens and never consumes is what lets the mover get past open()
  // into its exec, so the cleanup meets a real `cat` argv and a real blocked write.
  const dest = fifo()
  const reader = spawn(SH ?? '/bin/sh', ['-c', `exec 3< ${shellQuote(dest)}; sleep 30`], { stdio: ['ignore', 'ignore', 'ignore'] })
  spawned.push(reader)
  const mover = await startMover(SH ?? '/bin/sh', publishCommand(part, shellQuote(dest), undefined, 'pub1-bbbbbbbb'), 'pub1-bbbbbbbb')
  assert.ok(mover.identity.starttime > 0, 'the backgrounded mover has a start time of its own')
  assert.notEqual(mover.identity.pid, mover.child.pid, 'and the marker names the mover, not the shell that started it')
  const facts = procFacts(mover.identity.pid)
  assert.equal(facts.alive, true, 'the mover is parked writing the fifo')
  assert.equal(facts.starttime, String(mover.identity.starttime), 'the number carries exactly the time the marker claimed')
  const facts0 = procFacts(mover.identity.pid)
  assert.equal(facts0.alive, true, 'the parked mover is a cat holding the blocked write')
  // The publish mover's argv is `cat -- <part>`: the destination lives in the
  // shell's redirect, not in the argument list, so the identity word the cleanup
  // compares is the part file — the same pairing the publish failure path uses.
  assert.equal(/^(?:\/\S+\/)?cat$/u.test(readFileSync(`/proc/${String(mover.identity.pid)}/cmdline`, 'utf8').split('\0')[0] ?? ''), true, 'the exec completed: the number really runs the mover program')
  const r = await reap(SH ?? '/bin/sh', mover.identity.pid, mover.identity.starttime, shellQuote(part))
  assert.equal(r.verdict, 'killed', `the publish mover is ended on its full identity: ${JSON.stringify(r.stdout)}`)
  assert.ok(await awaitGone(mover.identity.pid), 'and the kernel agrees it left')
  assert.equal(existsSync(part), true, 'the part file is kept for the reader, exactly as the message promises')
  mover.child.kill(); reader.kill()
})

// ── the probe: field 20 counted after the last parenthesis, in a real shell ──

test('the probe survives a comm that contains a parenthesis', { skip: SKIP }, async () => {
  // The cleanup counts fields after the **last** `) ` because a comm may hold
  // anything at all — including `) `. Run the mover from a script path that puts
  // exactly that shape in the *shell's* own comm, and show the reported time still
  // matches the kernel's for the pid after the exec.
  const script = join(dir, 'weird comm) x.sh')
  const park = fifo()
  writeFileSync(script, `#!/bin/sh\n${downloadMoverCommand(shellQuote(park), 'wr1-bbbbbbbb')}\n`)
  const chmod = await run(SH ?? '/bin/sh', `chmod +x ${shellQuote(script)}`)
  assert.equal(chmod.status, 0)
  const child = spawn(script, [], { stdio: ['ignore', 'pipe', 'pipe'] })
  spawned.push(child)
  // The exec replaces this process; its comm is `cat`, but the *shell's* comm was
  // `weird comm) x.sh` — a parenthesis after the mover's own probe ran.
  let buf = ''
  const identity = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 5_000)
    timer.unref?.()
    child.stderr.on('data', chunk => {
      buf += String(chunk)
      const found = moverPid(buf, 'wr1-bbbbbbbb')
      if (found !== undefined) { clearTimeout(timer); resolve(found) }
    })
  })
  if (identity === undefined) {
    child.kill('SIGKILL')
    assert.fail('the oddly named script never announced its mover identity')
  }
  const facts = procFacts(child.pid)
  assert.equal(facts.alive, true, 'the execed cat is still parked on the fifo')
  assert.equal(facts.starttime, String(identity.starttime), 'and the pre-exec probe reported the kernel time the exec kept')
  child.kill('SIGKILL')
})

// ── C. the cleanup never reaches sideways: paths, repetition, and metacharacters ──

test('a path full of shell and glob metacharacters is one string comparison, never a pattern', { skip: SKIP }, async () => {
  const path = join(dir, 'a b [x] * ? + .f#ÿ')
  const made = spawnSync(SH ?? '/bin/sh', ['-c', `mkfifo ${shellQuote(path)}`])
  assert.equal(made.status, 0)
  const mover = await startMover(SH ?? '/bin/sh', downloadMoverCommand(shellQuote(path), 'odd1-bbbbbbbb'), 'odd1-bbbbbbbb')
  const sentinel = spawn('/bin/cat', ['--', path], { stdio: ['ignore', 'ignore', 'pipe'] })
  spawned.push(sentinel)
  await sleep(150)
  const before = procFacts(sentinel.pid)
  const r = await reap(SH ?? '/bin/sh', mover.child.pid, mover.identity.starttime, shellQuote(path))
  assert.equal(r.verdict, 'killed', `the odd path is one quoted argument against the mover's own argv: ${JSON.stringify(r.stdout)}`)
  await awaitGone(mover.child.pid)
  const after = procFacts(sentinel.pid)
  assert.equal(after.alive, true, 'the sentinel sharing that exact path survived the kill')
  assert.equal(after.state, before.state, 'and it never stopped')
  sentinel.kill('SIGKILL')
  mover.child.kill()
})

test('repeated cleanups of one identity are idempotent and never widen the blast', { skip: SKIP }, async () => {
  const path = fifo()
  const mover = await startMover(SH ?? '/bin/sh', downloadMoverCommand(shellQuote(path), 'rep1-bbbbbbbb'), 'rep1-bbbbbbbb')
  const first = await reap(SH ?? '/bin/sh', mover.child.pid, mover.identity.starttime, shellQuote(path))
  assert.equal(first.verdict, 'killed')
  await awaitGone(mover.child.pid)
  for (let round = 0; round < 3; round += 1) {
    const again = await reap(SH ?? '/bin/sh', mover.child.pid, mover.identity.starttime, shellQuote(path))
    assert.equal(again.verdict, 'gone', `cleanup ${String(round + 2)} of a departed mover says gone`)
  }
  // And a cleanup of the same number with a wrong time, after the mover left:
  // still nothing to kill, still an honest gone (or foreign if something returned).
  const late = await reap(SH ?? '/bin/sh', mover.child.pid, 1, shellQuote(path))
  assert.ok(['gone', 'foreign'].includes(late.verdict), `a late, mis-stamped cleanup is still accounted: ${late.verdict}`)
  mover.child.kill()
})
