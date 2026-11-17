// The pure decision functions of the transport: quoting, program extraction, the
// two fingerprint tables with their deliberate ordering difference, and the flags
// a call is handed about sharing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { shellQuote, leadingProgram, classifyProbe, classifyRun, tail, HOST_KEY_SETTING, SshTransport, probeArgvTail } from '../lib/transport.js'

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
  assert.equal(bare.sessionBroken('ControlSocket /tmp/x already exists, disabling multiplexing'), true)
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
  const lane = { kind: 'file transfer', cap: 1 }
  const firstStop = new AbortController()
  const first = transport.execute('/usr/bin/scp', ['-q', 'a', 'b'], settings, undefined, 0, 'file transfer', firstStop.signal, lane)
  let err
  try {
    await transport.execute('/usr/bin/scp', ['-q', 'c', 'd'], settings, undefined, 0, 'file transfer', undefined, lane)
  } catch (error) { err = error }
  // The refusal says which ceiling it hit — a full transfer lane, not the plugin's
  // 16 slots, which still had thirteen free — so the reader waits for the right thing.
  assert.equal(err?.code, 'busy')
  assert.match(err.message, /At most 1 file transfer/)
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
