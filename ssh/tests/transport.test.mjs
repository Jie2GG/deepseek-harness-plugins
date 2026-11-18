// The pure decision functions of the transport: quoting, program extraction, the
// two fingerprint tables with their deliberate ordering difference, and the flags
// a call is handed about sharing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { shellQuote, leadingProgram, classifyProbe, classifyRun, classifyCollectedRun, tail, HOST_KEY_SETTING, SshTransport, probeArgvTail, remotePathArg, TRANSFER_LANE } from '../lib/transport.js'

test('shellQuote makes any path one word for the remote shell', () => {
  assert.equal(shellQuote('/tmp/a b'), "'/tmp/a b'")
  assert.equal(shellQuote("/tmp/it's"), "'/tmp/it'\\''s'")
  assert.equal(shellQuote('a\\b'), "'a\\b'")
})

test('leadingProgram is conservative: one plain program or nothing', () => {
  assert.equal(leadingProgram('uptime'), 'uptime')
  assert.equal(leadingProgram('  git commit -m x  '), 'git')
  assert.equal(leadingProgram('/usr/bin/git status'), 'git') // the bare name is what an allowlist holds
  assert.equal(leadingProgram('systemctl status sshd'), 'systemctl')
  assert.equal(leadingProgram('rm -rf -- "a b"'), 'rm')
  assert.equal(leadingProgram(''), undefined)
  assert.equal(leadingProgram('ls | head'), undefined)
  assert.equal(leadingProgram('echo hi > /tmp/f'), undefined)
  assert.equal(leadingProgram('echo $(date)'), undefined)
  assert.equal(leadingProgram('FOO=1 bar'), undefined) // an assignment is not a program
  assert.equal(leadingProgram('Git'), undefined) // uppercase is not a name an allowlist can hold
  assert.equal(leadingProgram('a;b'), undefined)
  assert.equal(leadingProgram('echo \\; done'), undefined) // semicolons outside a program position too
})

test('the host key is recorded, never asked about', () => {
  assert.equal(HOST_KEY_SETTING, 'StrictHostKeyChecking=accept-new')
})

test('classifyProbe takes the exit code at its word first', () => {
  assert.equal(classifyProbe(0, 'anything'), 'reachable')
  assert.equal(classifyProbe(0, 'Host key verification failed.'), 'reachable') // the probe ran; the answer is the answer
  assert.equal(classifyProbe(255, 'ssh: connect to host 10.0.0.9 port 22: Connection refused'), 'unreachable')
  assert.equal(classifyProbe(255, 'Permission denied (publickey).'), 'auth-failed')
  assert.equal(classifyProbe(255, 'Permission denied (password).'), 'auth-failed')
  // A bare "please try again" carries no method tag: the table leaves it failed.
  assert.equal(classifyProbe(255, 'Permission denied, please try again.'), 'failed')
  assert.equal(classifyProbe(255, 'Too many authentication failures for deploy'), 'auth-failed')
  assert.equal(classifyProbe(255, 'Received disconnect: Server refused our key'), 'auth-failed')
  assert.equal(classifyProbe(255, 'no supported authentication methods'), 'auth-failed')
  // Elevation prompts answer to the same classification: spent secrets, wrong secrets.
  assert.equal(classifyProbe(1, 'sudo: 1 incorrect password attempt'), 'auth-failed')
  assert.equal(classifyProbe(1, 'sudo: a password is required'), 'auth-failed')
  assert.equal(classifyProbe(1, 'su: Authentication failure'), 'auth-failed')
  assert.equal(classifyProbe(255, 'Host key for example.com did not match.'), 'unknown-host')
  assert.equal(classifyProbe(255, 'Offending ED25519 key in /home/u/.ssh/known_hosts:3'), 'unknown-host')
  assert.equal(classifyProbe(255, 'REMOTE HOST IDENTIFICATION HAS CHANGED'), 'unknown-host') // case-insensitive
  assert.equal(classifyProbe(255, 'ssh: Could not resolve hostname nope: Name or service not known'), 'unreachable')
  assert.equal(classifyProbe(255, 'kex_exchange_identification: read: Connection reset by peer'), 'unreachable')
  assert.equal(classifyProbe(255, 'Connection timed out during banner exchange'), 'unreachable')
  assert.equal(classifyProbe(255, 'some other grief'), 'failed')
  assert.equal(classifyProbe(null, 'stopped by signal'), 'failed')
})

test('classifyRun reads the fingerprints first, because the server may echo either', () => {
  assert.equal(classifyRun(0, 'all good'), 'succeeded')
  assert.equal(classifyRun(0, 'Host key verification failed.'), 'unknown-host') // the opposite order from a probe, on purpose
  assert.equal(classifyRun(0, 'Permission denied (publickey).'), 'auth-failed')
  assert.equal(classifyRun(1, 'list failed'), 'exit-nonzero')
  assert.equal(classifyRun(2, ''), 'exit-nonzero')
  assert.equal(classifyRun(null, 'signalled away'), 'failed')
  assert.equal(classifyRun(255, 'ssh: connect to host x: Network is unreachable'), 'unreachable')
})

test('tail puts stderr first and keeps the last 2048 characters', () => {
  assert.equal(tail('', ''), undefined)
  assert.equal(tail('out', 'err'), 'err\nout')
  const long = 'a'.repeat(5000)
  const kept = tail(long, '')
  assert.equal(kept.length, 2048)
  assert.equal(kept, 'a'.repeat(2048)) // the tail of the stream, not the head
})

// ── what the transport hands a child about sharing ─────────────────────────
const CEILINGS = { maxOutputBytes: 65_536, remoteTimeoutMs: 30_000, maxTransferBytes: 33_554_432 }
const bare = new SshTransport({})

test('a call that leased nothing is told not to share', () => {
  const { flags } = bare.sshOptions({ host: '10.0.0.9' }, CEILINGS, {}, 10_000)
  assert.ok(flags.includes('ControlPath=none'))
  assert.ok(flags.includes('ControlMaster=no'))
  assert.ok(!flags.includes('ControlMaster=auto'))
  // `none` is not decoration: the Host account's own ~/.ssh/config may name a
  // ControlPath, and a child that inherited it would share a master nobody here
  // is counting, on credentials nobody here chose.
})

test('leased flags land before the target’s own arguments, so a written -o still wins', () => {
  const poolFlags = ['-o', 'ControlMaster=auto', '-o', 'ControlPath=/tmp/dsh-ssh-mux-x/ssh-a1b2c3d4e5-cafe.sock', '-o', 'ControlPersist=300']
  const own = '-oControlPath=/home/deploy/.ssh/cm-%h.sock'
  const { flags } = bare.sshOptions({ host: '10.0.0.9', extraArgs: [own] }, CEILINGS, {}, 10_000, { poolFlags })
  const socket = flags.indexOf('ControlPath=/tmp/dsh-ssh-mux-x/ssh-a1b2c3d4e5-cafe.sock')
  assert.ok(socket >= 0)
  assert.ok(socket < flags.indexOf(own))
  assert.ok(flags.includes('ControlPersist=300'))
  assert.ok(flags.indexOf('BatchMode=yes') < socket) // the base options keep their order
})

test('a multiplexing complaint is told apart from a server refusing the call', () => {
  assert.equal(bare.sessionBroken('session setup failed: too many sessions'), true)
  assert.equal(bare.sessionBroken('channel open failed: open failed'), true)
  assert.equal(bare.sessionBroken('mux_handler: read error'), true)
  // Two callers dialed the same master at first contact: the late one downgrades
  // to its own connection and *succeeds*. Reading that sentence as a broken session
  // used to evict the healthy master the race had just produced.
  assert.equal(bare.sessionBroken('ControlSocket /tmp/x already exists, disabling multiplexing'), false)
  // The same complaint with real grief underneath stays broken, and the phrase
  // without the fallback clause is a stale socket, not a race.
  assert.equal(bare.sessionBroken('ControlSocket /tmp/x already exists, disabling multiplexing\r\nsession setup failed: overflow'), true)
  assert.equal(bare.sessionBroken('ControlSocket /tmp/x already exists'), true)
  assert.equal(bare.sessionBroken('Permission denied (publickey).'), false) // the credential, not the channel
  assert.equal(bare.sessionBroken('ssh: connect to host x: Connection refused'), false)
})

test('a lease is settled by whether the call reached a session at all', () => {
  const seen = []
  const ticket = {
    pooled: true, flags: [], note: undefined,
    release () {}, markLive () { seen.push('live') }, drop () { seen.push('drop') }
  }
  bare.noteShared(ticket, true)
  bare.noteShared(ticket, false)
  assert.deepEqual(seen, ['live', 'drop'])
  const unshared = {
    pooled: false, flags: [], note: undefined,
    release () {}, markLive () { seen.push('should not happen') }, drop () { seen.push('should not happen') }
  }
  bare.noteShared(unshared, true)
  bare.noteShared(undefined, true) // a call with no pool assembled is a normal day
  assert.deepEqual(seen, ['live', 'drop'])
})

test('a probe on a leased connection stops at login, and one dialing alone still runs a command', () => {
  const leased = probeArgvTail(['-o', 'BatchMode=yes'], 'deploy@10.0.0.9', true)
  // `-N` belongs with the options: the destination is what ends the option list.
  assert.deepEqual(leased.slice(-2), ['-N', 'deploy@10.0.0.9'])
  assert.ok(!leased.includes('true'))
  const alone = probeArgvTail(['-o', 'BatchMode=yes'], 'deploy@10.0.0.9', false)
  assert.deepEqual(alone.slice(-2), ['deploy@10.0.0.9', 'true'])
  assert.ok(!alone.includes('-N')) // no master to leave behind, so -N would idle to the deadline
})

test('a probe that ended by signal is still classed by what the client printed', () => {
  // `-N` on a leased call exits 0 on its own; the failure shapes are the ones the
  // live measurement produced, not inventions.
  assert.equal(classifyProbe(255, 'jiegg@10.100.1.1: Permission denied (publickey,password).'), 'auth-failed')
  assert.equal(classifyProbe(255, 'Connection closed by 10.0.0.9 port 22'), 'unreachable')
  assert.equal(classifyProbe(0, ''), 'reachable')
})

test('a background call refused before its child started hands back the slot and the lease', async () => {
  const claims = []
  const pool = {
    ready: true,
    failure: undefined,
    liveMasters: 0,
    claim () {
      const ticket = {
        flags: [], note: undefined, pooled: true, released: 0,
        release () { this.released += 1 }, markLive () {}, drop () {}
      }
      claims.push(ticket)
      return ticket
    }
  }
  const ctx = { subprocess: { resolveExecutable: async () => '/usr/bin/ssh', spawn: () => { throw new Error('the child must not start') } } }
  const transport = new SshTransport(ctx, undefined, pool)
  // A password with no askpass helper is refused by the option builder, after the
  // slot was taken and the lease claimed — and both have to come back.
  await assert.rejects(
    () => transport.startRun({ host: '10.0.0.9' }, CEILINGS, { mode: 'password', password: 'p' }, 'sleep 100'),
    /askpass/
  )
  assert.equal(transport.inFlight, 0)
  assert.equal(claims[0].released, 1)
})

// ── the spill file the provider can write, and the path it reports ─────────
/**
 * A subprocess provider that records what it was asked for and answers with a
 * clipped stream whose full text lives at a path.
 */
function spillProvider (paths) {
  const seen = []
  return {
    seen,
    subprocess: {
      resolveExecutable: async () => '/usr/bin/ssh',
      spawn (spec) {
        seen.push(spec)
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: 'the tail', nextOffset: 8, lossy: true, ...(paths.stdout === undefined ? {} : { spillPath: paths.stdout }) }) },
            stderr: { readFrom: () => ({ text: 'the err tail', nextOffset: 13, lossy: true, ...(paths.stderr === undefined ? {} : { spillPath: paths.stderr }) }) }
          },
          terminate () {},
          waitForExit: async () => true
        }
      }
    }
  }
}

test('a ceiling with a spill budget asks the provider for the file', async () => {
  const provider = spillProvider({ stdout: '/tmp/dsh-subprocess-1/out.log', stderr: '/tmp/dsh-subprocess-1/err.log' })
  const transport = new SshTransport(provider)
  const out = await transport.execute('/usr/bin/ssh', ['true'], { ...CEILINGS, maxSpillBytes: 64 * 1024 * 1024 }, undefined, 5_000, 'test call')
  const stdio = provider.seen[0].stdio
  assert.deepEqual(stdio.stdout, { maxBytes: 65_536, spill: { maxBytes: 67_108_864 } })
  assert.deepEqual(stdio.stderr, { maxBytes: 65_536, spill: { maxBytes: 67_108_864 } })
  // Both tails stay in the answer, and each points at the file holding its whole stream.
  assert.equal(out.truncated, true)
  assert.equal(out.stdoutSpillPath, '/tmp/dsh-subprocess-1/out.log')
  assert.equal(out.stderrSpillPath, '/tmp/dsh-subprocess-1/err.log')
})

test('a spill budget of zero means no file is asked for, and nothing is promised', async () => {
  const provider = spillProvider({})
  const transport = new SshTransport(provider)
  const out = await transport.execute('/usr/bin/ssh', ['true'], { ...CEILINGS, maxSpillBytes: 0 }, undefined, 5_000, 'test call')
  assert.deepEqual(provider.seen[0].stdio.stdout, { maxBytes: 65_536 })
  assert.equal('spill' in provider.seen[0].stdio.stdout, false)
  assert.equal(out.truncated, true)
  assert.equal(out.stdoutSpillPath, undefined) // the renderer's "(no spill file configured)" branch
})

// ── the first cause of an interrupted child ────────────────────────────────
/** A provider whose child never settles on its own, so only a deadline can end it. */
function hangingProvider () {
  return {
    subprocess: {
      resolveExecutable: async () => '/usr/bin/ssh',
      spawn () {
        return {
          done: new Promise(() => {}),
          collected: {
            stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
          },
          terminate () {},
          waitForExit: async () => true
        }
      }
    }
  }
}

test('a child that runs past its deadline is a timeout, and one the caller stopped is a cancellation', async () => {
  const transport = new SshTransport(hangingProvider())
  const settings = { ...CEILINGS, maxSpillBytes: 0, probeTimeoutMs: 30_000, statTimeoutMs: 10_000, graceMs: 100 }
  const timedOut = await transport.execute('/usr/bin/ssh', ['true'], settings, undefined, 30, 'test call')
  assert.equal(timedOut.outcome, 'timeout')

  const stopped = new AbortController()
  stopped.abort(new Error('the reader pressed stop'))
  const cancelled = await transport.execute('/usr/bin/ssh', ['true'], settings, undefined, 5_000, 'test call', stopped.signal)
  assert.equal(cancelled.outcome, 'cancelled') // not a timeout: nobody should go blame the server

  // A caller who hands over an already-dead signal and a short deadline together is
  // still a cancellation, whichever timer was armed first: the fused deadline keeps
  // one cause, which is the whole reason this replaced a guess.
  const both = new AbortController()
  both.abort()
  const bothOut = await transport.execute('/usr/bin/ssh', ['true'], settings, undefined, 1, 'test call', both.signal)
  assert.equal(bothOut.outcome, 'cancelled')
})

test('no deadline means no timer: only the caller can end the wait', async () => {
  const transport = new SshTransport(hangingProvider())
  const settings = { ...CEILINGS, maxSpillBytes: 0, probeTimeoutMs: 30_000, statTimeoutMs: 10_000, graceMs: 100 }
  const controller = new AbortController()
  const running = transport.execute('/usr/bin/ssh', ['true'], settings, undefined, 0, 'background command', controller.signal)
  let settled = false
  void running.then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(settled, false) // 0 arms no timer at all, which is how a job outlives its reply
  controller.abort()
  assert.equal((await running).outcome, 'cancelled')
})

// ── the lane ceilings: per-kind room and the global count ──────────────────
test('a per-kind lane ceiling refuses the copy over the ceiling, not over the global room', async () => {
  const transport = new SshTransport(hangingProvider())
  const settings = { ...CEILINGS, maxSpillBytes: 0, probeTimeoutMs: 30_000, statTimeoutMs: 10_000, graceMs: 100, maxConcurrentTransfers: 1 }
  const lane = { kind: 'file transfers', cap: 1 }
  const firstStop = new AbortController()
  const first = transport.execute('/usr/bin/scp', ['-q', 'a', 'b'], settings, undefined, 0, 'file transfer', firstStop.signal, lane)
  let err
  try {
    await transport.execute('/usr/bin/scp', ['-q', 'c', 'd'], settings, undefined, 0, 'file transfer', undefined, lane)
  } catch (error) { err = error }
  // The refusal says which ceiling it hit — a full transfer lane, not the plugin's
  // 16 slots, which still had thirteen free — so the reader waits for the right thing.
  assert.equal(err?.code, 'busy')
  assert.match(err.message, /At most 1 file transfers?/)
  // And the room for a plain command survived the crowded transfer lane:
  const room = await transport.run({ host: '10.0.0.9' }, settings, {}, 'true', { timeoutMs: 1, maxOutputBytes: 64 })
  assert.ok(room.durationMs >= 0)
  firstStop.abort()
  assert.equal((await first).outcome, 'cancelled')
  // A released lane admits the next copy; the counters returned to zero with it.
  const nextStop = new AbortController()
  const next = transport.execute('/usr/bin/scp', ['-q', 'e', 'f'], settings, undefined, 0, 'file transfer', nextStop.signal, lane)
  nextStop.abort()
  assert.equal((await next).outcome, 'cancelled')
  assert.equal(transport.inFlight, 0)
})

test('the lane can be asked about without spending it, and reports full when it is', async () => {
  const provider = streamProvider(() => undefined)
  const transport = new SshTransport(provider)
  const lane = { kind: 'background jobs', cap: 1 }
  assert.equal(transport.laneRoom(lane), true)
  const held = transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /a'], { ...COPY_SETTINGS, maxRunningJobs: 1 }, undefined, 0, 'file transfer', { direction: 'download', localPath: join(mkdtempSync(join(tmpdir(), 'dshssh-lane-')), 'f'), maxBytes: 64 }, undefined, lane)
  // Asking did not take the slot: the copy that arrives next still gets refused.
  assert.equal(transport.laneRoom({ kind: 'file transfers', cap: 2 }), true)
  assert.equal(transport.laneRoom(lane), false)
  assert.equal(transport.inFlight, 1, 'exactly one child for one call, however often it was peeked at')
  provider.children[0].stdout?.destroy()
  await held
  assert.equal(transport.laneRoom(lane), true, 'and the peek reads true again once it is back')
})

test('eight jobs cannot busy-lock the plugin: the job ceiling stops starts, not foreground calls', async () => {
  // A provider whose child answers to the kill: `job_kill` aborts the lane
  // controller, and only a fake that honours that signal can show the slot
  // coming back when a job ends.
  const transport = new SshTransport({
    subprocess: {
      resolveExecutable: async () => '/usr/bin/ssh',
      spawn (options) {
        return {
          done: new Promise(resolve => {
            options.signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }))
          }),
          collected: {
            stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
          },
          terminate () {},
          waitForExit: async () => true
        }
      }
    }
  })
  const settings = { ...CEILINGS, maxSpillBytes: 0, probeTimeoutMs: 30_000, statTimeoutMs: 10_000, graceMs: 100, maxRunningJobs: 1 }
  const job = await transport.startRun({ host: '10.0.0.9' }, settings, {}, 'make world', { timeoutMs: 0, job: true })
  assert.ok(job)
  let err
  try {
    await transport.startRun({ host: '10.0.0.9' }, settings, {}, 'sleep 1d', { timeoutMs: 0, job: true })
  } catch (error) { err = error }
  assert.equal(err?.code, 'busy')
  assert.match(err.message, /At most 1 background jobs/)
  assert.match(err.hint, /job_kill/)
  // The reservation is against jobs only: a foreground command — even one that
  // might later promote — still gets a slot while the job lane is full.
  const plain = await transport.startRun({ host: '10.0.0.9' }, settings, {}, 'uptime', { timeoutMs: 0 })
  assert.ok(plain)
  // And the quota reopens the moment a job ends: kill releases the count.
  job.kill()
  await job.finished
  const after = await transport.startRun({ host: '10.0.0.9' }, settings, {}, 'sleep 1d', { timeoutMs: 0, job: true })
  assert.ok(after)
  after.kill()
  await after.finished
  plain.kill()
  await plain.finished
  assert.equal(transport.inFlight, 0)
})

test('sixteen children fill the global ceiling and the seventeenth is refused', async () => {
  const transport = new SshTransport(hangingProvider())
  const settings = { ...CEILINGS, maxSpillBytes: 0, probeTimeoutMs: 30_000, statTimeoutMs: 10_000, graceMs: 100 }
  const stops = []
  const running = []
  for (let i = 0; i < 16; i += 1) {
    const controller = new AbortController()
    stops.push(controller)
    // `timeoutMs: 0` arms no timer: each child waits only for its own controller.
    running.push(transport.execute('/usr/bin/ssh', ['true'], settings, undefined, 0, 'remote command', controller.signal))
  }
  assert.equal(transport.inFlight, 16)
  let err
  try {
    await transport.execute('/usr/bin/ssh', ['true'], settings, undefined, 0, 'remote command')
  } catch (error) { err = error }
  assert.equal(err?.code, 'busy')
  assert.match(err.message, /At most 16 remote operations/)
  for (const controller of stops) controller.abort()
  for (const settled of await Promise.all(running)) assert.equal(settled.outcome, 'cancelled')
  assert.equal(transport.inFlight, 0)
  // And the machine works again: cancellation did not corrupt the count.
  const after = new AbortController()
  const ok = transport.execute('/usr/bin/ssh', ['true'], settings, undefined, 0, 'remote command', after.signal)
  after.abort()
  assert.equal((await ok).outcome, 'cancelled')
})

// ── a named identity pins the authentication order ─────────────────────────
test('a named identityFile arrives with IdentitiesOnly, and only when one is named', () => {
  const plain = bare.sshOptions({ host: '10.0.0.9' }, CEILINGS, { mode: 'key' }, 10_000).flags
  assert.ok(!plain.includes('IdentitiesOnly=yes')) // no named key: the client's own defaults stand
  assert.ok(!plain.includes('-i'))
  const named = bare.sshOptions({ host: '10.0.0.9', identityFile: '/home/deploy/.ssh/id_ed25519' }, CEILINGS, { mode: 'key' }, 10_000).flags
  const at = named.indexOf('-i')
  assert.ok(at >= 0)
  assert.equal(named[at + 1], '/home/deploy/.ssh/id_ed25519')
  // The option rides right behind the key it belongs to, and before the user's
  // own extra arguments, so `-o IdentitiesOnly=no` there still wins.
  assert.equal(named[at + 2], '-o')
  assert.equal(named[at + 3], 'IdentitiesOnly=yes')
  const overridden = bare.sshOptions({ host: '10.0.0.9', identityFile: '/k', extraArgs: ['-o', 'IdentitiesOnly=no'] }, CEILINGS, { mode: 'key' }, 10_000).flags
  assert.ok(overridden.indexOf('IdentitiesOnly=yes') < overridden.indexOf('IdentitiesOnly=no'))
})

test('the ssh -G view carries the same IdentitiesOnly a real child gets', async () => {
  const seen = []
  const transport = new SshTransport({
    subprocess: {
      resolveExecutable: async () => '/usr/bin/ssh',
      spawn (options) {
        seen.push(options.argv)
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: 'hostname 10.0.0.9\n', nextOffset: 18, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
          },
          terminate () {},
          waitForExit: async () => true
        }
      }
    }
  })
  await transport.resolve({ host: '10.0.0.9', identityFile: '/home/deploy/.ssh/id_ed25519' }, CEILINGS)
  const argv = seen[0].join(' ')
  // A resolve card that showed a different configuration than the children run
  // would manufacture drift out of nothing.
  assert.match(argv, /-i \/home\/deploy\/\.ssh\/id_ed25519 -o IdentitiesOnly=yes/u)
})

// ── the spill budget: what this process will ask the provider to keep ───────
test('a spent spill budget stops asking the provider for a file, and says so', async () => {
  const { SpillBudget } = await import('../lib/spill.js')
  // A budget two of these streams fit into and a third does not.
  const budget = new SpillBudget(20, 64)
  const wanted = 16  // 8 bytes of stdout + 13 of stderr outgrows it on the first child
  const provider = spillProvider({
    stdout: '/tmp/dsh-subprocess-9-1-aaaa-stdout.log',
    stderr: '/tmp/dsh-subprocess-9-1-bbbb-stderr.log'
  })
  const transport = new SshTransport(provider, undefined, undefined, budget)
  const settings = { ...CEILINGS, maxSpillBytes: wanted }
  const first = await transport.execute('/usr/bin/ssh', ['true'], settings, undefined, 5_000, 'test call')
  // The first child is handed the ceiling it configured, and the provider's answer
  // is charged against the process: 8 bytes of stdout reported with a spill path.
  assert.deepEqual(provider.seen[0].stdio.stdout, { maxBytes: 65_536, spill: { maxBytes: wanted } })
  assert.equal(first.stdoutSpillPath, '/tmp/dsh-subprocess-9-1-aaaa-stdout.log')
  assert.equal(first.spillNote, undefined)
  // Both faces of one child are counted: the whole-stream offset the provider
  // reported with each path is the number that left the budget, 8 bytes of stdout
  // and 13 of stderr.
  assert.equal(budget.used, 21, 'the whole-stream offsets are what get counted')
  assert.equal(budget.files, 2, 'one child can account for two files')
  assert.equal(transport.spill.files, 2)
  assert.equal(transport.spill.max, 20)

  const second = await transport.execute('/usr/bin/ssh', ['true'], settings, undefined, 5_000, 'test call')
  // The budget is spent, so this child is asked for no file at all — and the
  // result carries the reason instead of a bare truncation.
  assert.equal('spill' in provider.seen[1].stdio.stdout, false)
  assert.equal('spill' in provider.seen[1].stdio.stderr, false)
  assert.match(String(second.spillNote), /spill budget is spent/u)
  const shaped = classifyCollectedRun(second, {})
  assert.ok(Array.isArray(shaped.notes), 'the note reaches the payload the reader sees')
  assert.match(shaped.notes.join(' '), /keeps only its in-memory tail and no full-output file/u)
  assert.equal(budget.refusals, 1)

  // The files the provider already wrote are still reported: refusing to ask for
  // more is not the same as pretending the earlier answer was shorter.
  assert.equal(second.truncated, true)
  assert.equal(second.stdoutSpillPath, '/tmp/dsh-subprocess-9-1-aaaa-stdout.log')
})

test('one transport carries one ledger for all its children, and a second transport starts clean', async () => {
  const { SpillBudget } = await import('../lib/spill.js')
  const budget = new SpillBudget(20, 64)
  const provider = spillProvider({
    stdout: '/tmp/dsh-subprocess-9-1-aaaa-stdout.log',
    stderr: '/tmp/dsh-subprocess-9-1-bbbb-stderr.log'
  })
  const transport = new SshTransport(provider, undefined, undefined, budget)
  const settings = { ...CEILINGS, maxSpillBytes: 16 }
  const first = await transport.execute('/usr/bin/ssh', ['true'], settings, undefined, 5_000, 'test call')
  assert.equal(first.spillNote, undefined, 'the first child is asked for a file')
  const second = await transport.execute('/usr/bin/ssh', ['true'], settings, undefined, 5_000, 'test call')
  // Not a per-server or per-conversation question: the ledger belongs to the
  // transport, and the production wiring builds one transport per activation, so
  // one Host process — however many targets it reaches — answers from one number.
  assert.match(String(second.spillNote), /spill budget is spent/u, 'the second child on the same transport hears the refusal')
  const alone = new SshTransport(provider, undefined, undefined)
  assert.equal(alone.spill.used, 0)
  assert.equal(alone.spill.max, 1_073_741_824, 'the shipped default, not the test’s small one')
  const clean = await alone.execute('/usr/bin/ssh', ['true'], settings, undefined, 5_000, 'test call')
  assert.equal(clean.spillNote, undefined, 'and a second activation is not punished for the first one’s output')
})
test('a stream copy never asks for a spill file, whatever the budget says', async () => {
  const { SpillBudget } = await import('../lib/spill.js')
  const budget = new SpillBudget(1024, 8)
  const provider = streamProvider(child => {
    child.push('data')
    child.exit(0)
  })
  const transport = new SshTransport(provider, undefined, undefined, budget)
  const dir = mkdtempSync(join(tmpdir(), 'dshssh-spill-'))
  await transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /f'], { ...COPY_SETTINGS, maxSpillBytes: 1024 }, undefined, 5_000, 'file transfer', { direction: 'download', localPath: join(dir, 'f'), maxBytes: 64 })
  // The payload of a copy is the file on disk; spilling its transcript to a second
  // file would double the very thing the ceiling exists to bound.
  assert.equal('spill' in provider.seen[0].stdio.stderr, false)
  assert.equal(budget.used, 0)
})

// ── the counted channel: where the transfer ceiling is actually enforced ────
/**
 * A subprocess provider that speaks the stream half of the contract: one raw
 * channel in the direction the call asked for, a collect face for the
 * explanation, and a `terminate` that closes both the way the real provider's
 * managed range does. The test drives the child through the handle it is handed
 * at spawn, so a copy crossing its ceiling is measured, not asserted blind.
 */
function streamProvider (script, detail = '') {
  const seen = []
  const children = []
  const reader = text => ({ readFrom: () => ({ text, nextOffset: Buffer.byteLength(text, 'utf8'), lossy: false }) })
  return {
    seen,
    children,
    subprocess: {
      resolveExecutable: async () => '/usr/bin/ssh',
      spawn (spec) {
        seen.push(spec)
        // A queue-backed readable, not a PassThrough: the async iterator reads
        // without a size hint, which hands it everything buffered at that moment
        // and quietly merges four chunks into one. A copy that stops at its
        // ceiling has to be measured against chunk boundaries, so the fake keeps
        // them the way a socket arriving one segment at a time would.
        const queue = []
        let wanted = null
        const pumpQueue = () => {
          for (;;) {
            if (wanted === null || queue.length === 0) return
            const take = wanted
            wanted = null
            take(queue.shift())
          }
        }
        const stdout = spec.stdio.stdout === 'pipe'
          ? new Readable({
              read (size) {
                const take = (chunk) => {
                  if (chunk === null) this.push(null)
                  else this.push(chunk)
                  pumpQueue()
                }
                if (queue.length > 0) {
                  const next = queue.shift()
                  this.push(next === undefined ? null : next)
                  pumpQueue()
                  return
                }
                wanted = take
              }
            })
          : undefined
        const written = []
        let stdinEnded = false
        const stdin = spec.stdio.stdin === 'pipe'
          ? new Writable({
              write (chunk, _encoding, callback) {
                written.push(Buffer.from(chunk))
                callback()
              }
            })
          : undefined
        if (stdin !== undefined) stdin.on('finish', () => { stdinEnded = true })
        let settled = false
        let finish
        const done = new Promise(resolve => { finish = resolve })
        const child = {
          stdout,
          stdin,
          written,
          get stdinEnded () { return stdinEnded },
          /** Push one chunk the way the far end would. */
          push (text) {
            if (stdout === undefined) return
            queue.push(Buffer.from(text, 'utf8'))
            pumpQueue()
          },
          /** End the channel and settle the child, the way a finished `cat` does. */
          exit (code = 0) {
            if (stdout !== undefined) { queue.push(null); pumpQueue() }
            if (settled) return
            settled = true
            finish({ exitCode: code, signal: null })
          },
          get terminated () { return terminations },
          done
        }
        let terminations = 0
        const handle = {
          stdin,
          stdout,
          collected: {
            ...(spec.stdio.stdout === 'pipe' ? {} : { stdout: reader(detail.stdout ?? '') }),
            stderr: reader(detail.stderr ?? '')
          },
          done,
          terminate () {
            terminations += 1
            if (stdout !== undefined && !stdout.destroyed) stdout.destroy()
            if (stdin !== undefined && !stdin.destroyed) stdin.destroy()
            if (!settled) {
              settled = true
              finish({ exitCode: null, signal: 'SIGTERM' })
            }
          },
          waitForExit: async () => true
        }
        // The provider's contract: an aborted signal starts the same termination
        // the explicit call does, so the pump can never be left holding a channel
        // nobody will close.
        spec.signal.addEventListener('abort', () => handle.terminate(), { once: true })
        children.push(child)
        if (typeof script === 'function') script(child)
        return handle
      }
    }
  }
}

const COPY_SETTINGS = {
  ...CEILINGS,
  maxSpillBytes: 0,
  transferTimeoutMs: 30_000,
  maxConcurrentTransfers: 2,
  graceMs: 100
}

function tempLocal (text = '') {
  const dir = mkdtempSync(join(tmpdir(), 'dshssh-stream-'))
  const path = join(dir, 'f')
  writeFileSync(path, text)
  return { dir, path, text }
}

test('a streamed download reads the channel into the sink and counts what arrived', async () => {
  const local = tempLocal()
  const provider = streamProvider(child => {
    child.push('hello ')
    child.push('world')
    child.exit(0)
  })
  const transport = new SshTransport(provider)
  const out = await transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /srv/f'], COPY_SETTINGS, undefined, 5_000, 'file transfer', { direction: 'download', localPath: local.path, maxBytes: 1024 })
  assert.equal(out.outcome, 'exit')
  assert.equal(out.exitCode, 0)
  assert.equal(out.bytes, 11)
  assert.equal(readFileSync(local.path, 'utf8'), 'hello world')
  // One raw channel, one small explanation, and no spill asked for: a 400 MiB
  // copy must not also write a 400 MiB transcript to a provider file.
  const spec = provider.seen[0]
  assert.equal(spec.stdio.stdout, 'pipe')
  assert.equal(spec.stdio.stdin, 'ignore')
  assert.equal(spec.stdio.stderr.maxBytes, 8_192)
  assert.equal('spill' in spec.stdio.stderr, false)
  assert.equal(transport.transfersInFlight, 0)
})

test('a streamed download stops at the ceiling, writes only what fit, and ends its child', async () => {
  const local = tempLocal()
  const provider = streamProvider(child => {
    // The chunk that crosses the line is counted as arrived but not written: the
    // refusal quotes the wire, the half file stays inside the ceiling.
    child.push('aaaa')
    child.push('bbbb')
    child.push('cccc')
    child.push('dddd')
  })
  const transport = new SshTransport(provider)
  const out = await transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /srv/f'], COPY_SETTINGS, undefined, 5_000, 'file transfer', { direction: 'download', localPath: local.path, maxBytes: 8 })
  assert.equal(out.outcome, 'over-limit')
  assert.equal(out.bytes, 8) // two chunks fit; the third crossed the line and was not delivered
  assert.equal(readFileSync(local.path, 'utf8'), 'aaaabbbb')
  assert.equal(provider.children[0].terminated >= 1, true)
  assert.equal(provider.children[0].stdout.destroyed, true)
  assert.equal(transport.transfersInFlight, 0)
})

test('a download whose local file cannot be written is an error, not a silent short copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshssh-stream-'))
  const provider = streamProvider(child => {
    child.push('data')
    child.exit(0)
  })
  const transport = new SshTransport(provider)
  // The sink sits inside a directory that does not exist: the channel is fine, the
  // disk answer is not, and only the local side can say so.
  const out = await transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /srv/f'], COPY_SETTINGS, undefined, 5_000, 'file transfer', { direction: 'download', localPath: join(dir, 'gone', 'f'), maxBytes: 1024 })
  assert.equal(out.outcome, 'error')
  assert.match(String(out.error), /ENOENT|no such file/iu)
  assert.equal(out.exitCode, 0) // the server did its part; saying so keeps the reader hunting in the right place
})

test('a local sink that died is reported at once, not after the whole deadline', async () => {
  // The case the running product found: a download whose destination sits at a path
  // that cannot hold a file. The write stream errors and closes before the pump
  // asks it for room, so a listener waiting for `drain` is waiting for an event
  // that already happened — and the copy then spends its entire deadline (five
  // minutes, measured) arriving as a timeout that blames the server.
  const dir = mkdtempSync(join(tmpdir(), 'dshssh-sink-'))
  // The channel keeps talking: a sink that refused one chunk must not leave the
  // far end writing into a stream nobody reads.
  const asDirectory = join(dir, 'blocked')
  mkdirSync(asDirectory)
  // Two ways the local end can refuse the file: the path is a directory, and the
  // directory the file should land in does not exist. Both used to arrive as a
  // timeout after the copy had sat out its entire deadline.
  const missingParent = join(dir, 'no-such-directory', 'f')
  for (const [label, localPath] of [['a directory in the way', asDirectory], ['a parent directory that does not exist', missingParent]]) {
    const transport = new SshTransport(streamProvider(child => {
      for (let i = 0; i < 40; i += 1) child.push('x'.repeat(16 * 1024))
    }))
    const began = Date.now()
    const out = await transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /f'], COPY_SETTINGS, undefined, 30_000, 'file transfer', { direction: 'download', localPath, maxBytes: 8 * 1024 * 1024 })
    const took = Date.now() - began
    assert.equal(out.outcome, 'error', label)
    assert.match(String(out.error), /ENOENT|EISDIR|could not be written|no such file/iu, label)
    assert.ok(took < 5_000, `${label}: the answer came back in ${String(took)} ms, not at the 30 s deadline`)
    assert.equal(transport.inFlight, 0, `${label}: the refused copy gave its operation slot back`)
  }
})

test('a deadline that fires while the channel is still healthy stays a timeout', async () => {
  // The pair to the case above: an answer must not start calling every slow copy a
  // local failure. Nothing is wrong with the sink here — the far end simply has
  // more to say than the deadline allows.
  const dir = mkdtempSync(join(tmpdir(), 'dshssh-slow-'))
  const provider = streamProvider(child => {
    child.push('first chunk')
    // and then silence: the child never settles and never ends its channel
  })
  const transport = new SshTransport(provider)
  const out = await transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /f'], COPY_SETTINGS, undefined, 120, 'file transfer', { direction: 'download', localPath: join(dir, 'f'), maxBytes: 8 * 1024 * 1024 })
  assert.equal(out.outcome, 'timeout')
  assert.equal(out.bytes, 11)
})

test('a streamed upload feeds the channel and closes it only once the file is done', async () => {
  const local = tempLocal('payload-bytes')
  const provider = streamProvider(child => {
    // A Writable answers `end()` with `finish`: that is the moment the whole body
    // has been handed over, which is what an upload's exit code may be read from.
    child.stdin.on('finish', () => { child.exit(0) })
  })
  const transport = new SshTransport(provider)
  const out = await transport.streamFile('/usr/bin/ssh', ['host', 'cat > /srv/f'], COPY_SETTINGS, undefined, 5_000, 'file transfer', { direction: 'upload', localPath: local.path, maxBytes: 1024 })
  assert.equal(out.outcome, 'exit')
  assert.equal(out.exitCode, 0)
  assert.equal(out.bytes, 13)
  assert.equal(Buffer.concat(provider.children[0].written).toString('utf8'), 'payload-bytes')
  assert.equal(provider.children[0].stdinEnded, true) // the EOF is what tells the server the body is complete
  const spec = provider.seen[0]
  assert.equal(spec.stdio.stdin, 'pipe')
  assert.equal(spec.stdio.stdout.maxBytes, 8_192)
})

test('a streamed upload over the ceiling stops before it promises the server a whole file', async () => {
  const local = tempLocal('0123456789abcdef') // 16 bytes, one chunk at the default high-water mark
  const provider = streamProvider(() => undefined)
  const transport = new SshTransport(provider)
  const out = await transport.streamFile('/usr/bin/ssh', ['host', 'cat > /srv/f'], COPY_SETTINGS, undefined, 5_000, 'file transfer', { direction: 'upload', localPath: local.path, maxBytes: 8 })
  assert.equal(out.outcome, 'over-limit')
  // Nothing was fed: the first chunk already crossed the line, and an upload that
  // cannot promise a complete body must not start sending a partial one.
  assert.equal(out.bytes, 0)
  // Nothing crossed the line, so nothing was fed: an over-limit upload must not
  // leave the far end with a plausible-looking truncated file and a closed stdin.
  assert.equal(provider.children[0].written.length, 0)
  assert.equal(provider.children[0].stdinEnded, false)
  assert.equal(provider.children[0].terminated >= 1, true)
})

test('a copy that outlives its deadline is a timeout, and one the reader stopped is a cancellation', async () => {
  const local = tempLocal()
  const hanging = streamProvider(() => undefined) // the child never settles and never ends its channel
  const transport = new SshTransport(hanging)
  const timed = await transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /srv/f'], COPY_SETTINGS, undefined, 30, 'file transfer', { direction: 'download', localPath: local.path, maxBytes: 1024 })
  assert.equal(timed.outcome, 'timeout')
  assert.equal(hanging.children[0].terminated >= 1, true)

  const stoppedByReader = new AbortController()
  stoppedByReader.abort(new Error('the conversation went away'))
  const cancelled = await transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /srv/f'], COPY_SETTINGS, undefined, 5_000, 'file transfer', { direction: 'download', localPath: join(mkdtempSync(join(tmpdir(), 'dshssh-stream-')), 'g'), maxBytes: 1024 }, stoppedByReader.signal)
  assert.equal(cancelled.outcome, 'cancelled') // not a timeout: nobody should go blame the server
})

test('the transfer lane comes back whole after success, failure, a timeout, and a cancellation', async () => {
  // A slot that leaked on one of these four endings would look like a healthy
  // plugin until the copy count crept to the ceiling and stayed there, so each
  // ending is checked the same way: the copy is over, the counters read zero, and
  // the next copy is admitted rather than refused.
  const lane = { kind: 'file transfers', cap: 1 }
  const sink = () => join(mkdtempSync(join(tmpdir(), 'dshssh-whole-')), 'f')
  const endings = [
    ['a clean exit', child => { child.push('hello'); child.exit(0) }],
    ['a failing exit', child => { child.exit(1) }],
    ['a deadline it outlived', () => undefined],
    ['a reader that stopped', () => undefined],
  ]
  for (const [name, firstChild] of endings) {
    let spawned = 0
    const provider = streamProvider(child => {
      spawned += 1
      // The first copy plays the ending; the copy that follows has to answer, or
      // the test would only be proving that a refusal was late.
      if (spawned === 1) firstChild(child)
      else { child.push('next'); child.exit(0) }
    })
    const transport = new SshTransport(provider)
    const settings = { ...COPY_SETTINGS, graceMs: 10 }
    const controller = new AbortController()
    // A reader that had already gone when the call was made is the case that can
    // leak: the slot was taken before the child was asked for anything, and only
    // the `finally` around the copy gives it back. The cancellation that lands
    // mid-copy, with bytes on the wire, is the live check's question, not this one.
    if (name === 'a reader that stopped') controller.abort(new Error('the conversation went away'))
    const deadlineMs = name === 'a deadline it outlived' ? 30 : 5_000
    const out = await transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /a'], settings, undefined, deadlineMs, 'file transfer', { direction: 'download', localPath: sink(), maxBytes: 1024 }, controller.signal, lane)
    const expected = name === 'a deadline it outlived' ? 'timeout' : name === 'a reader that stopped' ? 'cancelled' : 'exit'
    assert.equal(out.outcome, expected, `${name}: ended as ${expected}`)
    assert.equal(transport.transfersInFlight, 0, `${name}: the lane was handed back`)
    assert.equal(transport.inFlight, 0, `${name}: and so was the operation slot`)
    const next = await transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /b'], settings, undefined, 5_000, 'file transfer', { direction: 'download', localPath: sink(), maxBytes: 1024 }, undefined, lane)
    assert.equal(next.outcome, 'exit', `${name}: the copy after it got in`)
    assert.equal(transport.transfersInFlight, 0)
  }
})

test('a copy whose child exits nonzero keeps the server’s explanation', async () => {
  const local = tempLocal()
  const provider = streamProvider(child => {
    child.exit(1)
  }, { stderr: "cat: /srv/f: Permission denied\n" })
  const transport = new SshTransport(provider)
  const out = await transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /srv/f'], COPY_SETTINGS, undefined, 5_000, 'file transfer', { direction: 'download', localPath: local.path, maxBytes: 1024 })
  assert.equal(out.outcome, 'exit')
  assert.equal(out.exitCode, 1)
  assert.match(out.stderr, /Permission denied/)
})

test('the copies over the ceiling are refused against the same lane the commands share', async () => {
  // The ceiling a model hits is the one it is told about in words, and the count
  // behind it has to be readable from outside: `transfersInFlight` is what a
  // settings card and a real-host check both quote.
  const provider = streamProvider(() => undefined)
  const transport = new SshTransport(provider)
  const lane = { kind: 'file transfers', cap: 2 }
  const sink = () => join(mkdtempSync(join(tmpdir(), 'dshssh-stream-')), 'f')
  const first = transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /a'], COPY_SETTINGS, undefined, 0, 'file transfer', { direction: 'download', localPath: sink(), maxBytes: 1024 }, undefined, lane)
  const second = transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /b'], COPY_SETTINGS, undefined, 0, 'file transfer', { direction: 'download', localPath: sink(), maxBytes: 1024 }, undefined, lane)
  assert.equal(transport.transfersInFlight, 2)
  assert.equal(transport.laneUsage('background jobs'), 0) // the lanes are separate reservations
  let err
  try {
    await transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /c'], COPY_SETTINGS, undefined, 0, 'file transfer', { direction: 'download', localPath: sink(), maxBytes: 1024 }, undefined, lane)
  } catch (error) { err = error }
  assert.equal(err?.code, 'busy')
  assert.match(err.message, /At most 2 file transfers may run at once/)
  assert.equal(transport.transfersInFlight, 2, 'a refusal spends no slot')
  // The refusal lands where the lane is taken, before the child exists: the third
  // copy asked the provider for nothing, so it moved no bytes, opened no part
  // file, and left the server untouched. A ceiling that refused only after
  // spawning would still be a ceiling, but it would be paying for the answer.
  assert.equal(provider.children.length, 2, 'the refused copy never reached the wire')
  // A plain command is not stopped by a crowded transfer lane: that reservation
  // exists so a long copy can never busy-lock the plugin.
  const room = await transport.run({ host: '10.0.0.9' }, { ...COPY_SETTINGS, maxSpillBytes: 0 }, {}, 'true', { timeoutMs: 30 })
  assert.ok(room.durationMs >= 0)
  // End the two held copies and the lane opens again — no count left behind.
  provider.children.forEach(child => child.stdout?.destroy())
  await Promise.all([first, second])
  assert.equal(transport.transfersInFlight, 0)
  const third = transport.streamFile('/usr/bin/ssh', ['host', 'cat -- /d'], COPY_SETTINGS, undefined, 30, 'file transfer', { direction: 'download', localPath: sink(), maxBytes: 1024 }, undefined, lane)
  assert.equal(transport.transfersInFlight, 1)
  provider.children.at(-1).stdout?.destroy()
  await third
  assert.equal(transport.transfersInFlight, 0)
})

