// The operations layer, transport faked at its seam: target resolution, the
// marker protocol of read, the write guards, the edit round trips, probe
// bookkeeping, resolve parsing, transfer pre-checks, and the background handoff.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOps } from '../lib/ops.js'
import { DEFAULTS } from '../lib/config.js'
import { SshError } from '../lib/types.js'
import { createHash } from 'node:crypto'
import { fakeRunner, fakeStore, fakeSecrets, record } from './helpers.mjs'

const sha256Hex = text => createHash('sha256').update(text, 'utf8').digest('hex')
import { defaultBounds } from '../lib/bounds.js'

function build ({ records = [record()], store, secrets, askpassReady = true, localExists = false, jobs, bounds } = {}) {
  const { runner, state } = fakeRunner()
  const storeObj = store ?? fakeStore({ records })
  const sec = secrets ?? fakeSecrets({ password: true, passphrase: false })
  const changed = { count: 0 }
  const ops = createOps({
    runner,
    store: async () => storeObj,
    secrets: () => sec,
    askpass: () => (askpassReady ? { ready: true, path: '/tmp/h/askpass.sh' } : { ready: false, failure: 'no tmp dir' }),
    localExists: async () => localExists,
    ...(jobs === undefined ? {} : { jobs }),
    ...(bounds === undefined ? {} : { bounds }),
    onInventoryChanged: () => { changed.count += 1 }
  })
  return { ops, runner, state, store: storeObj, secrets: sec, changed }
}

const iso = new Date().toISOString()

// ── inventory reads ─────────────────────────────────────────────────────────
test('list carries the views, the limits, the pool state, and the askpass health', async () => {
  const { ops } = build({ store: fakeStore({ records: [record()], session: { sessionId: 'session-77', targetId: 'ssh-a1b2c3d4e5', setAt: iso } }) })
  const out = await ops.list({ sessionId: 'session-77' })
  assert.equal(out.connections.length, 1)
  assert.deepEqual(out.connections[0].secrets, { password: true, passphrase: false })
  assert.equal(out.limits.maxConnections, 64)
  // The ceilings moved out of `limits` and into a resolved view: a default, a cap,
  // and what a call with no override would run with.
  assert.equal(out.bounds.maxTransferBytes, 536_870_912)
  assert.equal(out.bounds.probeTimeoutMs, 30_000)
  assert.equal(out.bounds.effective.remoteTimeoutMs, 30_000)
  assert.equal(out.limits.concurrentOps, 16)
  assert.equal(out.limits.maxLiveMasters, 8)
  assert.equal(out.limits.controlPersistSeconds, 300)
  assert.deepEqual(out.pool, { ready: true, liveMasters: 0, transfers: 0, jobs: 0 })
  // The lane numbers the page prints come from this Host, not from a copy of them in
  // the browser: what a job may hold, what stays held back for a call that waits, and
  // the total they are both cut out of.
  assert.equal(out.bounds.maxRunningJobs, 8)
  assert.equal(out.bounds.foregroundReservedOps, 8)
  assert.equal(out.bounds.concurrentOps, 16)
  assert.equal(out.bounds.maxConcurrentTransfers, 2)
  // The resource answers the page needs when an answer says "truncated" or a file
  // it expected is gone: what the spill budget holds, and what this Host's startup
  // collected from its own temp namespace.
  assert.deepEqual(out.spill, { used: 0, files: 0, refusals: 0, max: 0 })
  assert.equal(out.temp, undefined, 'an assembly that never swept says nothing rather than zero')
  assert.equal(out.askpass, 'ready')
  assert.equal(out.sessionTarget, 'ssh-a1b2c3d4e5')
  assert.equal(out.probing, 0)
  const broken = build({ askpassReady: false })
  assert.equal((await broken.ops.list()).askpass, 'unavailable')
})

test('every remote call carries the target id and its sharing choice to the transport', async () => {
  const { ops, state } = build({ records: [record({ pool: 'off' })] })
  await ops.runCommand({ command: 'uptime' })
  const shared = state.shares[0]
  // The pool keys a master by the id: an edited target must not inherit the
  // connection its predecessor left open, and `pool: off` is a per-target wish.
  assert.equal(shared.target.id, 'ssh-a1b2c3d4e5')
  assert.equal(shared.target.pool, 'off')
  assert.equal(shared.ticket.released, 1) // a lease always comes back
})

test('an unreadable askpass reports why, and stored records keep their probe', async () => {
  const { ops } = build()
  const out = await ops.list()
  assert.equal(out.askpass, 'ready')
  assert.equal(out.connections[0].lastProbe, undefined)
})

// ── target resolution, shared by every remote call ─────────────────────────
test('pickTarget answers by reference, by session, or by the lone row, and names the candidates when lost', async () => {
  const two = [record(), record({ id: 'ssh-b2c3d4e5f6', label: 'Build', host: '10.0.0.8' })]
  for (const target of ['ssh-a1b2c3d4e5', ' proxy ', '10.0.0.9', 'deploy@10.0.0.9']) {
    const { ops, state } = build({ records: two })
    await ops.runCommand({ command: 'uptime', target })
    assert.equal(state.calls[0].target.host, '10.0.0.9', target)
  }
  const session = build({ store: fakeStore({ records: two, session: { sessionId: 's1', targetId: 'ssh-b2c3d4e5f6', setAt: iso } }) })
  await session.ops.runCommand({ command: 'uptime', sessionId: 's1' })
  assert.equal(session.state.calls[0].target.host, '10.0.0.8')
  const lost = build({ records: two })
  let thrown
  try {
    await lost.ops.runCommand({ command: 'uptime', target: 'nope' })
  } catch (error) { thrown = error }
  assert.equal(thrown?.code, 'not-found')
  assert.match(thrown.hint, /Known targets: Build, Proxy/)
  const ambiguous = build({ records: two })
  await assert.rejects(() => ambiguous.ops.runCommand({ command: 'uptime' }), /2 targets are saved/)
  const off = build({ records: [record({ agentAccess: 'off' })] })
  await assert.rejects(() => off.ops.readPath({ path: '/x' }), /agent access off/)
})

// ── exec ────────────────────────────────────────────────────────────────────
test('runCommand resolves the ceilings it hands the transport, in layer order', async () => {
  const { ops, state } = build({ records: [record({ remoteTimeoutMs: 15_000, maxOutputBytes: 4096 })] })
  await ops.runCommand({ command: 'ls', tty: true, input: 'answer\n' })
  const call = state.calls[0]
  assert.equal(call.options.tty, true)
  assert.equal(call.options.stdin, 'answer\n')
  // The resolved ceilings travel in `settings`: the transport no longer re-decides
  // which layer won, because one place (bounds.ts) resolved call > target > profile
  // > default and capped the result.
  assert.equal(call.settings.remoteTimeoutMs, 15_000) // the record's override replaces the shared default
  assert.equal(call.settings.maxOutputBytes, 4096)
  assert.equal(call.auth.password, undefined) // key auth: no password read
  const explicit = build({ records: [record({ remoteTimeoutMs: 15_000 })] })
  await explicit.ops.runCommand({ command: 'ls', timeoutMs: 20_000 })
  assert.equal(explicit.state.calls[0].settings.remoteTimeoutMs, 20_000) // an explicit call beats the record
  // Past the cap there is no refusal any more: the number comes down to the cap,
  // the effective value is echoed, and the correction is stated.
  const capped = build()
  const cappedOut = await capped.ops.runCommand({ command: 'ls', timeoutMs: 900_000 })
  assert.equal(cappedOut.run.timeoutMs, 300_000)
  assert.equal(cappedOut.run.outputBytes, 65_536)
  assert.match((cappedOut.run.notes ?? []).join('\n'), /command timeout asked for 900000 and was capped to 300000/)
})

test('a bad command line is a bad-input refusal naming the field', async () => {
  const { ops } = build()
  let thrown
  try {
    await ops.runCommand({ command: '' })
  } catch (error) { thrown = error }
  assert.equal(thrown?.code, 'bad-input')
  assert.equal(thrown.field, 'command')
})

// ── read: the marker protocol in one round trip ─────────────────────────────
async function readWith (stdout, over = {}) {
  const built = build()
  built.state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout, ...over })
  return await built.ops.readPath({ path: '/srv/x' })
}

test('read answers file, directory, other, and missing from one marker line', async () => {
  const file = await readWith('ssh-plugin: file 6\nhello\n')
  assert.equal(file.type, 'file')
  assert.equal(file.content, 'hello\n')
  assert.equal(file.size, 6)
  assert.equal(file.lines, 2)
  const dir = await readWith('ssh-plugin: directory\ntotal 0\ndrwxr-xr-x 2 root root 4096 .\n')
  assert.equal(dir.type, 'directory')
  assert.ok(dir.entriesText.startsWith('total 0'))
  assert.equal(dir.content, undefined)
  const other = await readWith('ssh-plugin: other\nsrw-rw---- 1 root root 0 sock\n')
  assert.equal(other.type, 'other')
  // A miss really exits 20 on the far side; the classifier has not seen a
  // fingerprint, so the marker alone names the fact and ok follows the status.
  const goneRead = build()
  goneRead.state.nextRun = () => ({ status: 'exit-nonzero', at: iso, exitCode: 20, stdout: 'ssh-plugin: missing\n', stderr: '', durationMs: 1 })
  const missing = await goneRead.ops.readPath({ path: '/srv/x' })
  assert.equal(missing.type, 'missing')
  assert.equal(missing.ok, false)
  assert.match(missing.hint, /List the parent directory/)
  // A shell that could not run the test still produced plain text: take it as a file.
  const fallback = await readWith('just some text\n')
  assert.equal(fallback.type, 'file')
  assert.equal(fallback.content, 'just some text\n')
  // A clipped body must say the read was truncated.
  const clipped = await readWith('ssh-plugin: file 99999\npartial', { truncated: true })
  assert.equal(clipped.truncated, true)
})

test('read carries the size and honours the ceiling this call asked for', async () => {
  // Fixed in 0.0.24: a `read` that asks for `maxOutputBytes` used to run at the
  // shared ceiling anyway, and the old suite pinned that. The per-call value now
  // wins over the target's, and both are held to the configured cap.
  const { ops, state } = build({ records: [record({ maxOutputBytes: 2048 })] })
  state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: 'ssh-plugin: file 1\nx' })
  const out = await ops.readPath({ path: '/x', maxOutputBytes: 999 })
  assert.equal(state.calls[0].settings.maxOutputBytes, 999)
  assert.equal(out.outputBytes, 999)
  const over = await ops.readPath({ path: '/x', maxOutputBytes: 9_999_999 })
  assert.equal(state.calls[1].settings.maxOutputBytes, 4_194_304) // capped, not refused
  assert.match((over.notes ?? []).join('\n'), /output ceiling asked for 9999999 and was capped to 4194304/)
})

test('a relative or punctuated path refuses before any round trip', async () => {
  const { ops, state } = build()
  let thrown
  try {
    await ops.readPath({ path: 'relative/x' })
  } catch (error) { thrown = error }
  assert.equal(thrown?.code, 'bad-input')
  assert.equal(thrown.field, 'path')
  assert.equal(state.calls.length, 0)
})

// ── write: the overwrite guard and the parent mkdir ─────────────────────────
test('write builds one shell line: guard, mkdir, redirect, content through stdin', async () => {
  const guarded = build()
  guarded.state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '', stderr: '', durationMs: 3 })
  await guarded.ops.writeRemote({ path: '/srv/dir/f.txt', content: 'abc' })
  const command = guarded.state.calls[0].command
  assert.match(command, /if \[ -e '/)
  assert.match(command, /exit 17/)
  assert.match(command, /mkdir -p -- '\/srv\/dir'/)
  assert.match(command, /cat > '\/srv\/dir\/f\.txt'/)
  assert.equal(guarded.state.calls[0].options.stdin, 'abc')
  const forced = build()
  forced.state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, durationMs: 1 })
  const overwrote = await forced.ops.writeRemote({ path: '/f', content: 'x', overwrite: true, mkdir: false })
  assert.equal(forced.state.calls[0].command.includes('exit 17'), false)
  assert.equal(forced.state.calls[0].command.includes('mkdir'), false)
  assert.equal(overwrote.overwrote, true)
  const appended = build()
  appended.state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, durationMs: 1 })
  await appended.ops.writeRemote({ path: '/f', content: 'x', append: true })
  assert.match(appended.state.calls[0].command, /cat >> '\/f'/)
  // A remote refusal text is translated into plain language.
  const clash = build()
  clash.state.nextRun = () => ({ status: 'exit-nonzero', at: iso, exitCode: 17, stdout: '', stderr: "ssh-plugin: refusing to overwrite an existing file\n", durationMs: 1 })
  const refused = await clash.ops.writeRemote({ path: '/f', content: 'x' })
  assert.equal(refused.ok, false)
  assert.equal(refused.status, 'exit-nonzero')
  assert.match(refused.message, /already exists/)
  assert.match(refused.hint, /overwrite/)
})

// ── edit: read, decide locally, back up, write through the same inode ───────
/**
 * A server that speaks the edit protocol, in memory. It answers the read with the
 * version token and the digest it computed over the bytes it holds, applies a write
 * to its own copy, and re-digests whatever landed. `over` is where a test says what
 * kind of server it is: one with no checksum tool (`noSha`), one whose bytes came
 * out different from the bytes sent (`landing`), one whose answer never arrived
 * (`lostAnswer`), one whose repair found something other than the copy (`repair`).
 * The commands themselves are checked by tests/edit-shell.test.mjs, which runs them
 * under a real /bin/sh; what is under test here is how ops.ts reads the answers.
 */
function editRunner (content, over = {}) {
  const built = build(over)
  const marked = content.startsWith('ssh-plugin:')
  const head = marked ? content.slice(0, content.indexOf('\n')) : ''
  const server = { file: marked ? content.slice(content.indexOf('\n') + 1) : content, copy: null }
  const version = head.startsWith('ssh-plugin: ') ? head.slice('ssh-plugin: '.length) : ''
  const noSha = over.noSha === true
  const done = (stdout, extra = {}) => ({
    status: 'succeeded', at: iso, exitCode: 0, stdout: `${stdout}\n`, stderr: '', durationMs: 3, ...extra
  })
  const failed = (exitCode, stdout, stderr = '') => ({
    status: 'exit-nonzero', at: iso, exitCode, stdout: `${stdout}\n`, stderr, durationMs: 3
  })
  const stated = over.repair === undefined ? null : over.repair
  // The write command opens with the same `if [ ! -f` as the read does, so the
  // copy-and-replace pair is what tells the two apart.
  // The write command opens with the same `if [ ! -f` as the read does, so the
  // copy-and-replace pair is what tells the two apart.
  let promised = null // what the edit intended to send, as the write understood it
  built.state.nextRun = (command, options = {}) => {
    if (over.beforeWrite !== undefined && command.includes('cp -p --') && server.file !== over.beforeWrite) {
      server.file = String(over.beforeWrite) // a second writer got there first
    }
    const pre = noSha ? '-' : sha256Hex(server.file)
    const preLine = `ssh-plugin: pre ${pre}`
    if (command.includes('cp -p --') && command.includes('cat >')) {
      if (over.staleContent === true) return failed(21, '', 'ssh-plugin: the content changed after it was read\n')
      const guard = /"\$pre" != '([0-9a-f]{64})'/u.exec(command)?.[1]
      if (guard !== undefined && pre !== '-' && guard !== pre) {
        // Refused before the copy: this call never truncated the file.
        return failed(21, '', 'ssh-plugin: the content changed after it was read\n')
      }
      const landed = over.landing ?? String(options.stdin ?? '')
      const bytes = Buffer.byteLength(landed)
      if (over.failCopy === true) return failed(22, '')
      if (over.failWrite === true) return failed(23, preLine)
      server.copy = server.file
      server.file = landed
      promised = /"\$now" != '([0-9a-f]{64})'/u.exec(command)?.[1] ?? sha256Hex(landed)
      const short = Number(/if \[ "\$size" != (\d+) \]/u.exec(command)?.[1])
      if (short !== undefined && short !== bytes) return failed(24, preLine)
      if (over.lostAnswer === true) return { status: 'timeout', at: iso, exitCode: undefined, stdout: `${preLine}\n`, stderr: 'ssh: write timed out\n', durationMs: 4 }
      if (noSha) return failed(29, `${preLine}\nssh-plugin: ok sizeonly ${bytes}`)
      if (guard !== undefined || promised !== sha256Hex(landed)) {
        if (promised !== sha256Hex(landed)) return failed(28, `${preLine}\nssh-plugin: mismatch ${bytes} ${sha256Hex(landed)}`)
      }
      return done(`${preLine}\nssh-plugin: ok digest ${sha256Hex(landed)}`)
    }
    if (command.startsWith('if [ ! -f')) {
      // The read answer is the marker lines and then the file's bytes **exactly as
      // `cat` sends them**. `done()` appends a newline a *marker* wants and a *body*
      // may not have, and the K-6 check now tells those apart: the byte count and the
      // digest the server states must describe the body it hands over, trailing
      // newline included or not. A fixture framed any other way is a server that
      // would not survive a read-back of its own answer.
      const body = server.file
      // `readBytes` / `readDigest` let one fixture stand for a server whose framing
      // and payload disagree, which is the K-6 case: the markers are the read's own
      // claim about the bytes that follow, and the guard has to notice when they do
      // not describe the body that arrived.
      const stated = over.readDigest === undefined ? (noSha ? '' : sha256Hex(body)) : over.readDigest
      const lines = [`ssh-plugin: ${version}`, `ssh-plugin-sha256: ${stated}`]
      if (over.noBytes !== true) lines.push(`ssh-plugin-bytes: ${String(over.readBytes === undefined ? Buffer.byteLength(body) : over.readBytes)}`)
      return { status: 'succeeded', at: iso, exitCode: 0, stdout: `${lines.join('\n')}\n${body}`, stderr: '', durationMs: 3 }
    }
    if (command.startsWith('size=$(wc -c')) {
      if (stated === 'died') return { status: 'timeout', at: iso, exitCode: undefined, stdout: '', stderr: 'ssh: read timed out\n', durationMs: 4 }
      if (stated !== null) {
        const at = stated.bytes ?? Buffer.byteLength(stated.content ?? server.file)
        const hex = stated.sha ?? (stated.content === undefined ? undefined : sha256Hex(stated.content))
        const evidence = stated.evidence ?? (hex === undefined ? 'sizeonly' : 'digest')
        const exit = stated.exit ?? (evidence === 'digest' ? 25 : 25)
        const marker = `ssh-plugin: ${stated.verdict} ${evidence} ${at}${evidence === 'digest' ? ` ${hex}` : ' -'}`
        return exit === 0 ? done(marker) : failed(exit, marker)
      }
      // Nothing was forced: answer the way the shell sequence does, by re-digesting
      // what is actually on the server.
      if (promised !== null && sha256Hex(server.file) === promised) {
        return failed(27, `ssh-plugin: landed digest ${Buffer.byteLength(server.file)} ${sha256Hex(server.file)}`)
      }
      if (server.copy !== null) {
        server.file = server.copy
        return done(`ssh-plugin: restored digest ${Buffer.byteLength(server.file)} ${sha256Hex(server.file)}`)
      }
      return done(`ssh-plugin: intact digest ${Buffer.byteLength(server.file)} ${sha256Hex(server.file)}`)
    }
    return done('')
  }
  built.server = server
  return built
}

test('edit replaces one exact match, backs up with cp -p, and writes with cat >', async () => {
  const built = editRunner('one\nTARGET two\n')
  const out = await built.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.ok, true)
  assert.equal(out.replaced, 1)
  assert.equal(out.backup, '/etc/f.dsh-bak')
  assert.equal(out.bytesBefore, 15) // one\nTARGET two\n
  assert.equal(out.bytesAfter, 13) // one\nKEPT two\n
  const run = built.state.calls.find(call => call.command.includes('cp -p'))
  // The write is one child that guards, copies, replaces, and re-checks in that
  // order — and the replacement goes *through* the file, not around it.
  assert.match(run.command, /cp -p -- '\/etc\/f' '\/etc\/f\.dsh-bak' \|\| exit 22/)
  assert.match(run.command, /cat > '\/etc\/f'; rc=\$\?/)
  assert.match(run.command, /if \[ "\$size" != 13 \]; then exit 24; fi/)
  assert.equal(run.command.includes('mv '), false)
  assert.equal(run.options.stdin, 'one\nKEPT two\n') // the whole new file, through stdin
  // This fake server states no version (its read answer carries no marker line),
  // and the result says the guard was off rather than pretending it ran.
  assert.equal(out.versionChecked, false)
  assert.equal(run.command.includes('stat -c'), false)
})

test('edit guards the write with the version the read was told, on a server that states one', async () => {
  const built = editRunner(`ssh-plugin: 7|15|2026-01-01 00:00:00.000000000 +0800\none\nTARGET two\n`)
  const out = await built.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.ok, true)
  assert.equal(out.versionChecked, true)
  assert.equal(out.bytesBefore, 15, 'the marker line is not part of the file')
  assert.equal(out.bytesAfter, 13)
  const run = built.state.calls.find(call => call.command.includes('cp -p'))
  assert.match(run.command, /if \[ "\$\(stat -c '%i\|%s\|%y' -- '\/etc\/f' 2>\/dev\/null\)" != '7\|15\|2026-01-01 00:00:00\.000000000 \+0800' \]/)
  // The read and the write are the only two children a clean guarded edit needs.
  assert.equal(built.state.calls.filter(call => call.kind === 'run').length, 2)
})

test('an ambiguous match reports the count and writes nothing', async () => {
  const built = editRunner('x x x')
  const out = await built.ops.editRemote({ path: '/f', oldText: 'x', newText: 'y' })
  assert.equal(out.ok, false)
  assert.equal(out.matches, 3)
  assert.match(out.message, /appears 3 times/)
  assert.equal(built.state.calls.filter(c => c.command.includes('cp -p')).length, 0)
  // replaceFirst and all both proceed, with the right counts.
  const once = editRunner('x x x')
  const oneOut = await once.ops.editRemote({ path: '/f', oldText: 'x', newText: 'y', replaceFirst: true })
  assert.equal(oneOut.replaced, 1)
  const every = editRunner('x x x')
  const allOut = await every.ops.editRemote({ path: '/f', oldText: 'x', newText: 'y', all: true })
  assert.equal(allOut.replaced, 3)
})

test('edit refuses what it cannot see whole, and skips the backup on request', async () => {
  const missing = build()
  missing.state.nextRun = () => ({ status: 'exit-nonzero', at: iso, exitCode: 20, stdout: '', stderr: '', durationMs: 1 })
  const gone = await missing.ops.editRemote({ path: '/nope', oldText: 'a', newText: 'b' })
  assert.equal(gone.type, 'missing')
  assert.match(gone.message, /no regular file/)
  const clipped = build()
  clipped.state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: 'partial', stderr: '', durationMs: 1, truncated: true })
  const tooBig = await clipped.ops.editRemote({ path: '/huge', oldText: 'a', newText: 'b' })
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.message, /larger than the read ceiling/)
  const noBackup = editRunner('abc')
  const out = await noBackup.ops.editRemote({ path: '/f', oldText: 'b', newText: 'z', backup: false })
  assert.equal(out.backup, undefined)
  const run = noBackup.state.calls.find(c => c.command.includes('cat >'))
  // `backup: false` is a promise about what is *left behind*, not about whether
  // the edit kept a way back: the copy is still taken, under a private name, and
  // removed only once the write has been verified. An edit that cannot make that
  // copy refuses rather than betting the file on the channel.
  assert.match(run.command, /cp -p -- '\/f' '\/f\.dsh-snap-/)
  assert.match(run.command, /rm -f -- '\/f\.dsh-snap-/)
  assert.equal(run.command.includes('.dsh-bak'), false)
})

test('a clean edit is reported as landed, with the digest the server read back', async () => {
  const built = editRunner('one\nTARGET two\n')
  const out = await built.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.ok, true)
  assert.equal(out.verdict, 'landed')
  assert.equal(out.contentVerified, true)
  assert.equal(out.sha256, sha256Hex('one\nKEPT two\n'), 'the digest stated is the digest of the bytes that landed')
})

test('bytes that land at the right length and the wrong content are refused, and put back', async () => {
  // The case the byte check used to wave through: same size, different file.
  const built = editRunner('one\nTARGET two\n', { landing: 'one\nKEPT txo\n' })
  assert.equal(Buffer.byteLength('one\nKEPT txo\n'), 13, 'and it really is the length this edit sent')
  const out = await built.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.ok, false)
  assert.equal(out.restored, true, 'the copy went back, and the server digested it as the content this call read')
  assert.equal(out.verdict, 'restored')
  assert.equal(out.contentVerified, true)
  assert.equal(out.sha256, sha256Hex('one\nTARGET two\n'))
  const repair = built.state.calls.find(call => call.command.startsWith('size=$(wc -c'))
  assert.ok(repair !== undefined, 'a refused content is repaired, not just reported')
})

test('a server with no checksum tool is refused before writing, and its file is left alone', async () => {
  // K-1: the capability is checked from the read, not after the fact. A server that
  // cannot state a SHA-256 gets a refusal, not a write that lands unverified: the
  // file was never copied and never truncated.
  const built = editRunner('abc\n', { noSha: true })
  const out = await built.ops.editRemote({ path: '/f', oldText: 'b', newText: 'z' })
  assert.equal(out.ok, false, 'an unverifiable edit is refused outright')
  assert.equal(out.contentVerified, false)
  assert.equal(out.verdict, undefined, 'no write ran, so there is no write verdict to report')
  assert.equal(out.backup, undefined, 'no safety copy was taken: the refusal came first')
  assert.match(out.message, /not written/)
  assert.match(out.message, /file is unchanged/)
  assert.match(out.hint, /sha256sum, shasum, or openssl/)
  // Only the read child ran. The write — `cp -p` and the truncating `cat >` — was
  // never attempted, which is what "the file is unchanged" has to mean in fact.
  assert.equal(built.state.calls.filter(c => c.command.includes('cp -p')).length, 0, 'no safety copy')
  assert.equal(built.state.calls.filter(c => c.command.includes('cat >')).length, 0, 'no truncating write')
  assert.equal(built.state.calls.filter(c => c.command.startsWith('if [ ! -f')).length, 1, 'exactly the one read')
  assert.equal(built.server.file, 'abc\n', 'the bytes on the server are exactly what the read saw')
  // A dry run on the same tool-less server still previews the change, and says the
  // matching real edit would be refused — so a reader is not surprised by a yes that
  // turns into a refusal.
  const dry = editRunner('abc\n', { noSha: true })
  const preview = await dry.ops.editRemote({ path: '/f', oldText: 'b', newText: 'z', dryRun: true })
  assert.equal(preview.ok, true)
  assert.equal(preview.dryRun, true)
  assert.ok(preview.notes?.some(note => /is refused before anything is copied or written/u.test(String(note))), 'the preview warns the real run refuses')
  // K-1: the hint may not read as though `dryRun` were the thing in the way. On this
  // server no setting of the flag lets the overwrite through.
  assert.match(String(preview.hint), /would be refused on this server/u)
  assert.equal(/without dryRun applies this change/u.test(String(preview.hint)), false, 'the preview does not promise a write that cannot happen')
  const withSha = editRunner('abc\n', {})
  const realPreview = await withSha.ops.editRemote({ path: '/f', oldText: 'b', newText: 'z', dryRun: true })
  assert.match(String(realPreview.hint), /without dryRun applies this change/u, 'a server that can attest the bytes keeps the plain promise')
  assert.equal(realPreview.notes, undefined, 'and is not told about a guard that was in force')
})

test('a repair the server could only count is reported as unknown, never as restored', async () => {
  const built = editRunner('one\nTARGET two\n', {
    landing: 'one\nKEPTX tww\n',
    repair: { verdict: 'restored', evidence: 'sizeonly', bytes: 15, exit: 0 },
  })
  const out = await built.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.restored, undefined, 'the flag is only set when a digest vouches for the content')
  assert.equal(out.verdict, 'unknown')
  assert.equal(out.contentVerified, false)
  assert.match(out.message, /no checksum/)
})

test('a repair that cannot put the content back says unrecoverable and names the copy', async () => {
  const built = editRunner('one\nTARGET two\n', {
    failWrite: true,
    repair: { verdict: 'unrecoverable', content: 'half a file\n', exit: 25 },
  })
  const out = await built.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.ok, false)
  assert.equal(out.restored, false)
  assert.equal(out.verdict, 'unrecoverable')
  assert.equal(out.backup, '/etc/f.dsh-bak', 'the reader is told where the previous content still is')
  assert.match(out.hint, /Read \/etc\/f\.dsh-bak/)
})

test('a write whose answer was lost is landed only when the digest agrees', async () => {
  const proven = editRunner('one\nTARGET two\n', { lostAnswer: true })

  const out = await proven.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.ok, false, 'this call cannot claim it applied — but the file is claimed for')
  assert.equal(out.verdict, 'landed')
  assert.equal(out.contentVerified, true)
  assert.match(out.message, /the change is on the server/)
  const counted = editRunner('one\nTARGET two\n', {
    lostAnswer: true,
    repair: { verdict: 'landed', evidence: 'sizeonly', bytes: 13, exit: 27 },
  })
  const quiet = await counted.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(quiet.verdict, 'unknown', 'the right byte count is not the right file')
  assert.equal(quiet.contentVerified, false)
})

test('a repair child that never answered leaves the verdict unknown', async () => {
  const built = editRunner('one\nTARGET two\n', { failWrite: true, repair: 'died' })
  const out = await built.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.ok, false)
  assert.equal(out.restored, false)
  assert.equal(out.verdict, 'unknown')
  assert.equal(out.contentVerified, false)
  assert.match(out.message, /cannot say what state \/etc\/f is in/)
})

test('a same-size rewrite between the read and the write stops before anything moves', async () => {
  // The hole the size check left open: another writer replaces the file with a body
  // of the very same length, so the version token and the byte count both still fit.
  const built = editRunner('one\nTARGET two\n', { beforeWrite: 'one\nTARGET twO\n' })
  const out = await built.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.ok, false)
  assert.equal(out.stale, true)
  assert.equal(out.verdict, undefined, 'this call never truncated the file, so it has no verdict on its content')
  assert.match(out.message, /content no longer matches the digest/)
  assert.equal(built.server.copy, null, 'and it made no copy, because it never wrote')
  assert.equal(built.state.calls.filter(call => call.kind === 'run').length, 2)
})

// ── elevation: as (sudo) and su (root's own secret) ────────────────────────
test('as: elevates through sudo, forces a terminal, and answers from the stored login password', async () => {
  const withPw = build({ secrets: fakeSecrets({ password: true, passphrase: false, root: false }, { password: 'hunter2' }) })
  await withPw.ops.runCommand({ command: 'systemctl restart nginx', as: 'root' })
  const call = withPw.state.calls[0]
  assert.equal(call.command, 'sudo systemctl restart nginx')
  assert.equal(call.options.tty, true)
  assert.equal(call.options.stdin, 'hunter2\n') // injected by the plugin, never echoed back
  const other = build({ secrets: fakeSecrets({ password: true, passphrase: false, root: false }, { password: 'pw' }) })
  await other.ops.runCommand({ command: 'psql -c "select 1"', as: 'postgres' })
  assert.equal(other.state.calls[0].command, "sudo -u 'postgres' psql -c \"select 1\"")
  // A caller who wrote their own sudo line keeps it verbatim.
  const mine = build({ secrets: fakeSecrets({ password: true, passphrase: false, root: false }, { password: 'pw' }) })
  await mine.ops.runCommand({ command: 'sudo apt update', as: 'root' })
  assert.equal(mine.state.calls[0].command, 'sudo apt update')
  // No stored password: sudo -n, so a NOPASSWD host answers at once and a
  // prompting one fails fast rather than waiting out the deadline.
  const bare = build()
  await bare.ops.runCommand({ command: 'whoami', as: 'root' })
  assert.equal(bare.state.calls[0].command, 'sudo -n whoami')
  assert.equal(bare.state.calls[0].options.stdin, undefined)
  // Elevation and an input body share one stdin, and the prompt reads first:
  // with a stored password on hand, the pair is refused before anything runs —
  // the old behaviour silently spent the body's first line as the answer.
  const chosen = build({ secrets: fakeSecrets({ password: true, passphrase: false, root: false }, { password: 'stored' }) })
  let conflict
  try {
    await chosen.ops.runCommand({ command: 'passwd', as: 'root', input: 'typed\n' })
  } catch (error) { conflict = error }
  assert.equal(conflict?.code, 'bad-input')
  assert.equal(conflict.field, 'input')
  assert.match(conflict.hint, /without input/)
  assert.equal(chosen.state.calls.length, 0) // refused before the server was dialed
  // The one coexistence that is real: no stored password, `sudo -n`, no prompt
  // to eat anything — a NOPASSWD host takes the body, any other fails fast.
  const bareBody = build()
  await bareBody.ops.runCommand({ command: 'tee /tmp/x', as: 'root', input: 'body\n' })
  assert.equal(bareBody.state.calls[0].command, 'sudo -n tee /tmp/x')
  assert.equal(bareBody.state.calls[0].options.stdin, 'body\n')
})

test('su: reaches root through its own stored password, and refuses cleanly without one', async () => {
  const withRoot = build({ secrets: fakeSecrets({ password: false, passphrase: false, root: true }, { root: 'rootpw' }) })
  await withRoot.ops.runCommand({ command: "id && hostname", su: true })
  const call = withRoot.state.calls[0]
  assert.equal(call.command, "su root -c 'id && hostname'") // the whole line moves into one -c word
  assert.equal(call.options.tty, true)
  assert.equal(call.options.stdin, 'rootpw\n')
  assert.notEqual(call.command.includes('rootpw'), true) // the secret is in stdin, not the command line
  const missing = build()
  let thrown
  try {
    await missing.ops.runCommand({ command: 'id', su: true })
  } catch (error) { thrown = error }
  assert.equal(thrown?.code, 'bad-input')
  assert.equal(thrown.field, 'su')
  assert.match(thrown.hint, /as: "root"/)
  // su and an input body cannot share the one stdin, stored secret or not.
  let suConflict
  try {
    await withRoot.ops.runCommand({ command: 'id', su: true, input: 'body\n' })
  } catch (error) { suConflict = error }
  assert.equal(suConflict?.code, 'bad-input')
  assert.equal(suConflict.field, 'input')
  assert.match(suConflict.hint, /printf/)
})

test('as and su together never reach the server: the schema refuses first', async () => {
  const { ops } = build()
  let thrown
  try {
    await ops.runCommand({ command: 'id', as: 'root', su: true })
  } catch (error) { thrown = error }
  assert.equal(thrown?.code, 'bad-input')
  assert.equal(thrown.field, 'su')
})

test('backgrounded elevation is refused: a job has no stdin channel to inject into', async () => {
  const jobs = { start () { return 'ssh-j1' } }
  const { ops } = build({ jobs })
  let thrown
  try {
    await ops.execBackground({ command: 'apt update', as: 'root' })
  } catch (error) { thrown = error }
  assert.equal(thrown?.code, 'bad-input')
  assert.equal(thrown.field, 'background')
  assert.match(thrown.hint, /NOPASSWD/)
})

// ── probes ──────────────────────────────────────────────────────────────────
test('a stored probe persists onto the record; a draft probe never does', async () => {
  const { ops, store } = build()
  const out = await ops.probe({ id: 'ssh-a1b2c3d4e5' })
  // For a stored target the outcome rides home as lastProbe, not as a stray field.
  assert.equal(out.connections[0].lastProbe.status, 'reachable')
  assert.equal(store.calls.some(c => c[0] === 'recordProbe'), true)
  const draft = build()
  const draftOut = await draft.ops.probe({ draft: { host: 'fresh.example', auth: 'password' }, secrets: { password: 'transient' } })
  assert.equal(draftOut.probe.status, 'reachable')
  assert.equal(draftOut.connection, undefined)
  assert.equal(draft.store.calls.length, 0)
  assert.equal(draft.state.calls[0].auth.password, 'transient') // transient wins, and is never stored
  assert.equal(draft.state.calls[0].auth.mode, 'password')
})

test('probeAll covers at most twelve and collects per-target failures', async () => {
  const many = Array.from({ length: 13 }, (_, i) => record({ id: `ssh-000000000${i}`, label: `T${i}` }))
  const { ops } = build({ records: many })
  const out = await ops.probeAll()
  assert.equal(out.probed, 12)
  assert.equal(out.skipped, 1)
  assert.equal(out.failures.length, 0)
  const oneThrows = build({ records: [record()] })
  oneThrows.state.probeOutcome = 'throw'
  oneThrows.runner.probe = async () => { throw new SshError('busy', 'all lanes full') }
  const failed = await oneThrows.ops.probeAll()
  assert.deepEqual(failed.failures, [{ id: 'ssh-a1b2c3d4e5', message: 'all lanes full' }])
})

// ── resolve ─────────────────────────────────────────────────────────────────
test('resolve parses the ssh -G keys this plugin acts on, and flags drift', async () => {
  const out = 'hostname build.example\nport 22022\nuser deploy\nidentityfile /home/h/id_ed25519\nidentityfile /home/h/id_rsa\nproxyjump jump1\nproxycommand none\n'
  const { ops, state } = build()
  state.resolveOut = { outcome: 'exit', exitCode: 0, stdout: out, stderr: '', durationMs: 30 }
  const resolved = await ops.resolveRemote({ target: 'Proxy' })
  assert.equal(resolved.ok, true)
  assert.deepEqual(resolved.resolved, {
    hostname: 'build.example',
    port: 22022,
    user: 'deploy',
    identityFiles: ['/home/h/id_ed25519', '/home/h/id_rsa'],
    proxyJump: 'jump1'
  })
  assert.equal(resolved.differs, true) // the alias resolves elsewhere: exactly what the chip is for
  assert.equal(resolved.text.includes('hostname build.example'), true)
  const same = build()
  same.state.resolveOut = { outcome: 'exit', exitCode: 0, stdout: 'hostname 10.0.0.9\nport 22022\nuser deploy\nproxyjump none\nproxycommand none\n', stderr: '', durationMs: 20 }
  const aligned = await same.ops.resolveRemote({ target: 'Proxy' })
  assert.equal(aligned.differs, false)
  const bad = build()
  bad.state.resolveOut = { outcome: 'exit', exitCode: 255, stdout: '', stderr: "ssh: illegal option", durationMs: 1 }
  const failed = await bad.ops.resolveRemote({ target: 'Proxy' })
  assert.equal(failed.ok, false)
  assert.match(failed.message, /illegal option/)
})

// ── background ──────────────────────────────────────────────────────────────
test('a backgrounded run hands the registry a label, an owner, and a late-killing start', async () => {
  const specs = []
  const jobs = { start (spec) { specs.push(spec); return 'ssh-j9' } }
  const liveHolder = { sources: [], kill () {}, finished: new Promise(() => {}) }
  const { ops, state } = build({ jobs })
  state.startRunOut = liveHolder
  const out = await ops.execBackground({ command: 'make world', sessionId: 'session-77', callId: 'c1', rootCallId: 'r1' })
  assert.equal(out.ok, true)
  assert.equal(out.jobId, 'ssh-j9')
  assert.equal(out.status, 'started')
  assert.match(out.hint, /job_output/)
  const spec = specs[0]
  assert.equal(spec.label, 'Proxy: make world')
  assert.equal(spec.owner, 'session-77')
  const hooks = spec.run({})
  assert.equal(typeof hooks.cancel, 'function')
  assert.ok(hooks.done instanceof Promise)
  // The spawn is asynchronous: give the starter one loop to reach the transport.
  await new Promise(resolve => setImmediate(resolve))
  // callId/rootCallId went to the job record, not into the strict run schema.
  const startRunCall = state.calls.find(c => c.kind === 'startRun')
  // 0.0.26: a started job carries no deadline of its own — `0` means the timeout
  // library arms no timer, and only the child, `job_kill`, or teardown ends it.
  assert.equal(startRunCall.options.timeoutMs, 0)
})

test('backgrounding is refused, with a hint, when the profile has no registry', async () => {
  const { ops } = build()
  let thrown
  try {
    await ops.execBackground({ command: 'x' })
  } catch (error) { thrown = error }
  assert.equal(thrown?.code, 'bad-input')
  assert.equal(thrown.field, 'background')
  assert.match(thrown.hint, /Drop background/)
})

// ── transfers ───────────────────────────────────────────────────────────────
test('a download refuses to land on an existing local file it was not told to replace', async () => {
  const { ops, state } = build({ localExists: true })
  const out = await ops.download({ path: '/srv/x', localPath: '/ws/x' })
  assert.equal(out.status, 'refused-exists')
  assert.match(out.hint, /Pass overwrite/)
  assert.equal(state.calls.length, 0) // refused before any remote byte moved
})

test('a download consults the server first: missing, directory, and oversized all refuse with a next step', async () => {
  const gone = build()
  gone.state.nextRun = () => ({ status: 'exit-nonzero', at: iso, exitCode: 1, stdout: '', stderr: 'stat: cannot stat', durationMs: 1 })
  const missingOut = await gone.ops.download({ path: '/srv/nope', localPath: '/ws/nope' })
  assert.equal(missingOut.status, 'missing')
  assert.match(missingOut.hint, /List the remote directory/)
  const dir = build()
  dir.state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '4096 directory', stderr: '', durationMs: 1 })
  const dirOut = await dir.ops.download({ path: '/srv/dir', localPath: '/ws/dir' })
  assert.equal(dirOut.status, 'refused-size')
  assert.match(dirOut.message, /recursively/)
  const big = build()
  big.state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '40000000 regular file', stderr: '', durationMs: 1 })
  const bigOut = await big.ops.download({ path: '/srv/big', localPath: '/ws/big' })
  assert.equal(bigOut.status, 'refused-size')
  assert.match(bigOut.message, /over the 33554432 byte transfer ceiling/)
  assert.match(bigOut.hint, /Raise the transfer ceiling/)
})

function tempTree () {
  const dir = mkdtempSync(join(tmpdir(), 'dshssh-ops-'))
  return dir
}

test('a single-file download rides a counted channel and lands by rename, not in place', async () => {
  const dir = tempTree()
  const local = join(dir, 'x')
  const { ops, state } = build()
  state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '5 regular file', stderr: '', durationMs: 1 })
  // The stand-in for the channel is handed the sink path the copy asked for: it
  // writes there, and the test can see that the bytes did *not* land on the final
  // path until the copy said it was whole.
  state.streamImpl = (argvTail, copy) => {
    writeFileSync(copy.localPath, 'hello')
    return { outcome: 'exit', exitCode: 0, bytes: 5, stdout: '', stderr: '', durationMs: 4 }
  }
  const out = await ops.download({ path: '/srv/x', localPath: local })
  assert.equal(out.status, 'moved')
  // The number the result quotes is the one the copy counted, and the payload says
  // so: `in-flight` is a different promise from a pre-check, and the reader is told
  // which one answered.
  assert.equal(out.bytes, 5)
  assert.equal(out.limitMode, 'in-flight')
  assert.equal(out.overwrote, undefined)
  const stream = state.calls.find(c => c.kind === 'streamFile')
  assert.equal(stream.program, '/usr/bin/ssh')
  // The far end is a `cat` of the quoted path that first reports its own pid, so a
  // cleanup can name the process it is allowed to kill; the sink is a sibling temp
  // file with this process's id and four bytes of entropy in its name.
  const mover = String(stream.argvTail.at(-1))
  assert.match(mover, /^ms=0; \{ IFS= read -r _t <\/proc\/"\$\$"\/stat .*printf 'dsh-mover %s %s %s\\n' "\$\$" '[a-z0-9]+-[a-f0-9]{8}' "\$ms" >&2; exec cat -- '\/srv\/x'$/u, 'the mover announces its pid and start time, then becomes the mover')
  const localTag = /x\.dsh-part-([a-z0-9]+-[a-f0-9]{8})/.exec(stream.copy.localPath)?.[1]
  const remoteTag = /'([a-z0-9]+-[a-f0-9]{8})'/.exec(mover)?.[1]
  assert.ok(localTag !== undefined && remoteTag !== undefined && localTag === remoteTag, 'the copy has one identity: the temp name and the mover marker carry the same tag')
  assert.match(stream.copy.localPath, /x\.dsh-part-/)
  assert.notEqual(stream.copy.localPath, local)
  assert.equal(stream.copy.direction, 'download')
  assert.equal(stream.copy.maxBytes, DEFAULTS.transferBytes)
  assert.deepEqual(stream.lane, { kind: 'file transfers', cap: DEFAULTS.maxConcurrentTransfers })
  // The copy ran on its own clock, not the command's 30 s default.
  assert.equal(out.timeoutMs, DEFAULTS.transferTimeoutMs)
  assert.equal(stream.timeoutMs, DEFAULTS.transferTimeoutMs)
  // A streamed copy speaks to `ssh`, so the port rides `-p` like every other
  // command does — the `-P` seam belongs to scp, and only the tree path asks for it.
  assert.deepEqual(state.optionsSeen[0].extra, { poolFlags: [] })
  const lease = state.shares.find(entry => entry.target.host === '10.0.0.9')
  assert.ok(lease, 'the copy leased a connection')
  assert.equal(lease.ticket.released, 1) // and handed it back once the bytes moved
  // The rename replaced the part-file: the workspace holds exactly the answer.
  assert.equal(readFileSync(local, 'utf8'), 'hello')
  assert.deepEqual(readdirSync(dir), ['x'])
  // An overwrite of an existing file says so honestly.
  const over = build({ localExists: true })
  over.state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '5 regular file', stderr: '', durationMs: 1 })
  over.state.streamImpl = (argvTail, copy) => {
    writeFileSync(copy.localPath, 'hello2')
    return { outcome: 'exit', exitCode: 0, bytes: 6, stdout: '', stderr: '', durationMs: 2 }
  }
  const overOut = await over.ops.download({ path: '/srv/x', localPath: local, overwrite: true })
  assert.equal(overOut.overwrote, true)
  assert.equal(readFileSync(local, 'utf8'), 'hello2')
})

test('a recursive copy still rides scp, with host:path and the -P port seam', async () => {
  const dir = tempTree()
  const local = join(dir, 'dl')
  const { ops, state } = build()
  // A tree's pre-check is the one thing that changed: the server is asked for the
  // file count and the sum of sizes before a byte moves.
  state.nextRun = command => command.includes('find')
    ? { status: 'succeeded', at: iso, exitCode: 0, stdout: 'ssh-plugin: 2 tree 8', stderr: '', durationMs: 1 }
    : { status: 'succeeded', at: iso, exitCode: 0, stdout: '4096 directory', stderr: '', durationMs: 1 }
  state.executeImpl = argvTail => {
    // The tree lands in the part sibling; the measure pass then walks it.
    const dst = argvTail[argvTail.length - 1]
    mkdirSync(dst, { recursive: true })
    writeFileSync(join(dst, 'a'), 'aaa')
    writeFileSync(join(dst, 'b'), 'bbb')
  }
  state.executeOut = { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 4, truncated: false }
  const out = await ops.download({ path: '/srv/tree', localPath: local, recursive: true })
  assert.equal(out.status, 'moved')
  assert.equal(out.limitMode, 'pre-check')
  // What landed is measured, not guessed: scp -q never reports a byte count, so the
  // tree is walked once on the way in and the numbers come from that walk.
  assert.equal(out.bytes, 6)
  assert.equal(out.files, 2)
  assert.equal(out.recursive, true)
  const exec = state.calls.find(c => c.kind === 'execute')
  assert.equal(exec.program, '/usr/bin/scp')
  assert.equal(exec.argvTail.at(-2), 'deploy@10.0.0.9:/srv/tree')
  assert.match(exec.argvTail.at(-1), /dl\.dsh-part-/)
  assert.ok(exec.argvTail.includes('-q'))
  assert.ok(exec.argvTail.includes('-r'))
  assert.ok(exec.argvTail.includes('-P')) // scp names the port -P, and only scp does
  assert.equal(exec.lane.kind, 'file transfers')
  assert.equal(exec.lane.cap, DEFAULTS.maxConcurrentTransfers)
  const scanned = state.calls.filter(c => c.kind === 'run' && String(c.command).includes('find'))
  assert.equal(scanned.length, 1, 'the tree was enumerated exactly once, before the copy')
  assert.ok(scanned[0].command.includes('-maxdepth 0'), 'a server without GNU find is told apart from an empty directory')
  assert.equal(scanned[0].settings.statTimeoutMs, DEFAULTS.statTimeoutMs)
  // Upload: a real local source, and scp -r for a tree.
  const srcDir = tempTree()
  writeFileSync(join(srcDir, 'a'), 'aaa')
  const up = build()
  up.state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '', stderr: '', durationMs: 1 })
  up.state.executeOut = { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 2, truncated: false }
  const upOut = await up.ops.upload({ path: '/srv/x', localPath: srcDir, recursive: true })
  assert.equal(upOut.ok, true)
  assert.equal(upOut.recursive, true)
  assert.equal(upOut.files, 1)
  assert.equal(upOut.limitMode, 'pre-check')
  const upExec = up.state.calls.find(c => c.kind === 'execute')
  assert.ok(upExec.argvTail.includes('-r'))
  assert.equal(upExec.argvTail.at(-2), srcDir) // upload: local first…
  assert.equal(upExec.argvTail.at(-1), 'deploy@10.0.0.9:/srv/x') // …far end last
})

test('a recursive download into a directory that is not empty is refused before anything moves', async () => {
  // `scp -r` cannot land a tree on top of a directory that holds something: the
  // part sibling is renamed to the final name, and a rename onto a non-empty
  // directory is always ENOTEMPTY — which this plugin used to discover *after*
  // copying the whole tree, and then it deleted the tree it had just copied.
  const dir = tempTree()
  const local = join(dir, 'dl')
  mkdirSync(local)
  writeFileSync(join(local, 'keep.txt'), 'mine')
  const { ops, state } = build({ localExists: true })
  state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: 'ssh-plugin: 2 tree 8', stderr: '', durationMs: 1 })
  const out = await ops.download({ path: '/srv/tree', localPath: local, recursive: true, overwrite: true })
  assert.equal(out.status, 'refused-exists')
  assert.match(out.message, /rather than into it/)
  assert.equal(state.calls.filter(c => c.kind === 'execute').length, 0) // scp never ran
  assert.equal(readFileSync(join(local, 'keep.txt'), 'utf8'), 'mine')
  assert.deepEqual(readdirSync(local), ['keep.txt'])
})

test('an upload is guarded at both ends: a missing source, and an existing destination', async () => {
  const dir = tempTree()
  // Missing local source: refused before the server is asked anything at all.
  const gone = build()
  const goneOut = await gone.ops.upload({ path: '/srv/x', localPath: join(dir, 'nope') })
  assert.equal(goneOut.status, 'missing')
  assert.match(goneOut.message, /Nothing at .* to upload\./)
  assert.equal(gone.state.calls.filter(c => c.kind === 'execute').length, 0)
  assert.equal(gone.state.calls.filter(c => c.kind === 'streamFile').length, 0)
  // An existing remote destination, no overwrite: the guard names it and refuses.
  const exists = build()
  exists.state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '9 regular file', stderr: '', durationMs: 1 })
  const local = join(dir, 'x')
  writeFileSync(local, '123456789')
  const existsOut = await exists.ops.upload({ path: '/srv/x', localPath: local })
  assert.equal(existsOut.status, 'refused-exists')
  assert.match(existsOut.message, /already exists on 10\.0\.0\.9/)
  assert.match(existsOut.hint, /Pass overwrite to replace the remote file/)
  assert.equal(exists.state.calls.filter(c => c.kind === 'execute').length, 0) // the copy never started
  assert.equal(exists.state.calls.filter(c => c.kind === 'streamFile').length, 0)
  // With overwrite the same copy proceeds and says it replaced something.
  exists.state.streamImpl = (argvTail, copy) => ({ outcome: 'exit', exitCode: 0, bytes: 9, stdout: '', stderr: '', durationMs: 2 })
  exists.state.executeOut = { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 2, truncated: false }
  const overOut = await exists.ops.upload({ path: '/srv/x', localPath: local, overwrite: true })
  assert.equal(overOut.status, 'moved')
  assert.equal(overOut.overwrote, true)
  assert.equal(overOut.bytes, 9)
})

test('a single-file upload stops at a temp sibling and only then takes the final name', async () => {
  const dir = tempTree()
  const local = join(dir, 'x')
  writeFileSync(local, 'payload')
  const { ops, state } = build()
  // The stat pre-check answers with an unparsable line: the destination is absent,
  // so the copy runs and the publish step has the fresh-name branch to take.
  state.nextRun = command => command.startsWith('stat ')
    ? { status: 'succeeded', at: iso, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }
    : { status: 'succeeded', at: iso, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }
  let sent = null
  state.streamImpl = (argvTail, copy) => {
    sent = { argv: argvTail[argvTail.length - 1], sink: copy.localPath }
    return { outcome: 'exit', exitCode: 0, bytes: 7, stdout: '', stderr: '', durationMs: 3 }
  }
  const out = await ops.upload({ path: '/srv/x', localPath: local })
  assert.equal(out.status, 'moved')
  // The copy was told to write a sibling of the destination, not the destination:
  // that is the whole difference between “the copy failed” and “the copy failed and
  // took the old file with it”.
  assert.match(sent.argv, /^cat > '\/srv\/x\.dsh-part-/)
  // The publish step is one small remote command over the same connection.
  const publish = state.calls.filter(c => c.kind === 'run').map(c => c.command).find(command => command.includes('if [ -e'))
  assert.ok(publish, 'the copy asked the server to move the temp into place')
  assert.match(publish, /cat -- '\/srv\/x\.dsh-part-[^']*' > '\/srv\/x' & mp=\$!;/u) // through the existing file
  // The mover is a background job *because* the script has something to do after it,
  // so the one number that names it is `$!`, reported before the copy can park in a
  // fifo nobody is reading, and `wait` still hands the copy's status to the `&&`.
  assert.match(publish, /printf 'dsh-mover %s %s %s\\n' "\$mp" '[a-z0-9]+-[a-f0-9]{8}' "\$ms" >&2; wait \$mp && rm -f '\/srv\/x\.dsh-part-[a-z0-9-]*'/u)
  assert.match(publish, /rm -f/)
  assert.match(publish, /mv -f/) // and the fresh-name branch, chosen by the server, not by a stale pre-check
  assert.match(publish, /chmod/) // with the source's bits carried over
})

test('a copy the lane refused reaches the model as an ordinary failure, and touches nothing', async () => {
  const dir = tempTree()
  const local = join(dir, 'x')
  writeFileSync(local, 'ORIGINAL')
  const { ops, state } = build()
  // The far end is there and the local end is writable, so the refusal the test is
  // about has to be the one that arrives: an unreachable path would have been
  // answered before the channel was ever asked for.
  state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '8 regular file', stderr: '', durationMs: 1 })
  // The transport throws when a third copy asks for the two-slot lane; the
  // transfer layer turns that into the same shape every other refusal has. This
  // is the compatibility question the design draft left open: a caller that only
  // reads `status` must still learn why nothing moved, and must not have to catch
  // an exception the way it would have to against the real transport.
  state.streamFail = {
    code: 'busy',
    message: 'At most 2 file transfers may run at once, and all 2 slots are taken.',
    hint: 'Wait for one to finish (it also frees room for other calls), stop a job with `job_kill`, or raise the ceiling in the plugin’s configuration.',
  }
  const out = await ops.download({ path: '/srv/x', localPath: local })
  assert.equal(out.ok, false)
  assert.equal(out.status, 'failed')
  assert.match(out.message, /At most 2 file transfers may run at once/)
  assert.match(String(out.hint), /raise the ceiling/u, 'and the answer says where the number comes from')
  // The refusal is counted as in-flight-limit work, the same way a copy stopped by
  // its byte ceiling is, so a reader sorting failures finds them together.
  assert.equal(out.limitMode, 'in-flight')
  assert.equal(out.overwrote, undefined, 'and it never claims to have replaced anything')
  // The pre-flight question was still asked — a `stat` child costs one round trip
  // and is what tells the caller the path is even there — but the copy itself was
  // refused, so the local file kept the bytes it had and no part file was left.
  assert.equal(state.calls.filter(c => c.kind === 'streamFile').length, 1, 'one copy child was asked for, and it was refused')
  assert.equal(readFileSync(local, 'utf8'), 'ORIGINAL')
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('dsh-part')), [], 'and nothing was left behind to clean up')
})
test('an upload whose remote directory vanished between guard and copy says so in the useful direction', async () => {
  const dir = tempTree()
  const local = join(dir, 'x')
  writeFileSync(local, 'hi')
  const { ops, state } = build()
  state.streamOut = { outcome: 'exit', exitCode: 1, bytes: 0, stdout: '', stderr: "sh: cannot create /srv/x.dsh-part-1-2f3a: No such file or directory", durationMs: 2 }
  const out = await ops.upload({ path: '/srv/x', localPath: local })
  assert.equal(out.status, 'missing')
  assert.match(out.message, /remote directory does not exist/)
  // A stopped copy asks the server to forget its temp — one more small child, on
  // the same connection, best-effort by design.
  const cleanup = state.calls.filter(c => c.kind === 'run').map(c => c.command).find(command => command.startsWith('rm -f -- '))
  assert.ok(cleanup, 'the temp file was named back to the server')
  assert.match(cleanup, /\/srv\/x\.dsh-part-/)
})

test('a local path outside the declared workspace is refused before the copy', async () => {
  const { ops } = build()
  await assert.rejects(() => ops.upload({ path: '/srv/x', localPath: '/etc/x', localDir: '/ws' }), /outside the workspace/)
})

// ── bookkeeping and settings ────────────────────────────────────────────────
test('the policy fields the page now edits ride save into storage unchanged', async () => {
  // agentAccess and allowedCommands used to be reachable only by hand-editing the
  // storage file; the form gained controls in 2B, and this pins the path the UI
  // takes: page payload -> ops.save -> the store's create/edit input.
  const { ops, store } = build()
  const out = await ops.save({
    connection: { label: 'Guarded', host: 'h3', agentAccess: 'off', allowedCommands: ['git', 'uptime'] }
  })
  assert.equal(out.connection.agentAccess, 'off')
  assert.deepEqual(out.connection.allowedCommands, ['git', 'uptime'])
  const created = store.calls.find(call => call[0] === 'create')
  assert.deepEqual(created[1].allowedCommands, ['git', 'uptime'])
  // And an edit that empties the list clears it rather than leaving the old names.
  const back = await ops.save({
    id: out.connection.id,
    connection: { id: out.connection.id, label: 'Guarded', host: 'h3', agentAccess: 'on', allowedCommands: [] }
  })
  assert.equal(back.connection.agentAccess, 'on')
  assert.deepEqual(back.connection.allowedCommands, [])
})

test('save and remove move secrets and inventory notifications together', async () => {
  const { ops, secrets, changed } = build()
  const saved = await ops.save({ connection: { label: 'New', host: 'h2' }, secrets: { password: 'pw' } })
  assert.equal(saved.connection.id, 'ssh-new0000001')
  assert.deepEqual(secrets.applied, [{ id: 'ssh-new0000001', patch: { password: 'pw' } }])
  assert.equal(changed.count, 1)
  const edited = await ops.save({ connection: { id: 'ssh-a1b2c3d4e5', label: 'Proxy2', host: '10.0.0.9' } })
  assert.equal(edited.connection.label, 'Proxy2')
  assert.equal(changed.count, 2)
  const removed = await ops.remove({ id: 'ssh-a1b2c3d4e5' })
  assert.equal(removed.removed, true)
  assert.equal(removed.orphanSecrets, false)
  assert.equal(changed.count, 3)
  const gone = build()
  await assert.rejects(() => gone.ops.remove({ id: 'ssh-zzzzzzzzzz' }), /No stored SSH target carries/)
  await assert.rejects(() => gone.ops.remove({}), /Remove needs the id/)
})

test('the session target writes only when a real row is named, and the settings patch merges', async () => {
  const { ops } = build()
  assert.deepEqual(await ops.setSessionTarget({ sessionId: 's' }), { sessionTarget: null }) // absent targetId: clear without storage
  const set = await ops.setSessionTarget({ sessionId: 's', targetId: 'ssh-a1b2c3d4e5' })
  assert.equal(set.sessionTarget.targetId, 'ssh-a1b2c3d4e5')
  assert.equal((await ops.list({ sessionId: 's' })).sessionTarget, 'ssh-a1b2c3d4e5')
  await ops.clearSessionTarget({ sessionId: 's' })
  assert.equal((await ops.list({ sessionId: 's' })).sessionTarget, undefined)
  const cfg = await ops.configUpdate({ settings: { remoteTimeoutMs: 45_000 } })
  assert.equal(cfg.settings.remoteTimeoutMs, 45_000)
  // The saved slot carries only the three ceilings: the next save drops whatever
  // pre-0.0.18 keys the stored file still had.
  assert.deepEqual(Object.keys(cfg.settings).sort(), ['maxOutputBytes', 'maxTransferBytes', 'remoteTimeoutMs'])
  assert.equal(cfg.effective.remoteTimeoutMs, 45_000)
  assert.deepEqual(cfg.notes, [])
  // A stored 10 ms is no longer refused: the two-sided range is gone, and a value
  // that means something is used as given. Only a value that cannot mean a deadline
  // at all is a refusal.
  const tiny = await ops.configUpdate({ settings: { remoteTimeoutMs: 10 } })
  assert.equal(tiny.settings.remoteTimeoutMs, 10)
  assert.equal(tiny.effective.remoteTimeoutMs, 10)
  // Past the cap it is stored and capped where used, with the receipt on the way by.
  const big = await ops.configUpdate({ settings: { remoteTimeoutMs: 900_000 } })
  assert.equal(big.settings.remoteTimeoutMs, 900_000)
  assert.equal(big.effective.remoteTimeoutMs, 300_000)
  assert.match(big.notes.join('\n'), /capped to 300000/)
  // `null` drops the override, which is how a profile gets back to the default.
  const cleared = await ops.configUpdate({ settings: { remoteTimeoutMs: null } })
  assert.equal(cleared.settings.remoteTimeoutMs, undefined)
  assert.equal(cleared.effective.remoteTimeoutMs, 30_000)
  let nonsensical
  try {
    await ops.configUpdate({ settings: { remoteTimeoutMs: 0 } })
  } catch (error) { nonsensical = error }
  assert.equal(nonsensical?.code, 'bad-input')
  assert.equal(nonsensical.field, 'remoteTimeoutMs')
  // The retired fields are no one's to write any more: the page that still
  // sends probeTimeoutMs gets a clean refusal, not a silent ignore.
  let stale
  try {
    await ops.configUpdate({ settings: { probeTimeoutMs: 10_000 } })
  } catch (error) { stale = error }
  assert.equal(stale?.code, 'bad-input')
})

// ── promoting a call that outlives its own deadline ─────────────────────────
/** A live job whose output is already partly there, and either settles or does not. */
function liveJob ({ settle, text = 'half-done' } = {}) {
  const killed = { count: 0 }
  return {
    killed,
    job: {
      sources: [
        { channel: 'stdout', read: () => ({ text, nextOffset: text.length, lossy: false }) },
        { channel: 'stderr', read: () => ({ text: '', nextOffset: 0, lossy: false }) }
      ],
      kill () { killed.count += 1 },
      finished: settle === undefined ? new Promise(() => {}) : Promise.resolve(settle)
    }
  }
}

/** A registry that takes the hand-over, or refuses it. */
function registry (refuse = false) {
  const seen = []
  return {
    seen,
    start (spec) {
      if (refuse) throw new Error('background job limit reached for this owner (limit: 10); use job_kill to stop an unneeded job')
      seen.push(spec)
      spec.run()
      return 'ssh-j1'
    },
    async read () { return undefined },
    async kill () { return undefined }
  }
}

test('a call that settles in time answers as a normal foreground run, through the job-capable path', async () => {
  const { ops, state } = build({ jobs: registry() })
  const { job } = liveJob({ settle: { outcome: 'exit', exitCode: 0, stdout: 'done\n', stderr: '', durationMs: 12, truncated: false } })
  state.startRunOut = job
  const out = await ops.runCommand({ command: 'uptime' })
  assert.equal(out.run.status, 'succeeded')
  assert.equal(out.run.stdout, 'done\n')
  assert.equal(state.calls.some(c => c.kind === 'startRun'), true) // no deadline of its own
  // Zero means "arm no timer": the command outlives the reply window by design, and
  // only the child settling or the caller cancelling can end it.
  assert.equal(state.calls.find(c => c.kind === 'startRun').options.timeoutMs, 0)
  assert.equal(state.calls.some(c => c.kind === 'run'), false)
})

test('a call that outlives its deadline is handed over, with the output it already produced', async () => {
  const jobs = registry()
  const { ops, state } = build({ records: [record({ remoteTimeoutMs: 5 })], jobs })
  state.startRunOut = liveJob().job // never settles
  const out = await ops.runCommand({ command: 'make world', sessionId: 's-1', callId: 'c-1', rootCallId: 'r-1' })
  assert.equal(out.run.status, 'promoted')
  assert.equal(out.run.ok ?? true, true)
  assert.equal(out.run.jobId, 'ssh-j1')
  assert.equal(out.run.stdout, 'half-done') // what it said before the window closed
  // `truncated` belongs to a clipped stream, not to a command that is still writing
  // one: claiming it here made the transcript report a missing spill file that was
  // never needed.
  assert.equal(out.run.truncated, undefined)
  assert.match(out.run.message ?? '', /how far it had got/)
  assert.match(out.run.message ?? '', /outlived the 5 ms/)
  assert.match(out.run.hint ?? '', /job_output/)
  assert.match(out.run.hint ?? '', /timeoutMs/)
  assert.equal(out.run.timeoutMs, 5) // the deadline that was in force is echoed
  // The job the registry received is attributed like one started with `background`:
  // same owner, same call, so `job_output` and the trajectory land in the right place.
  const spec = jobs.seen[0]
  assert.equal(spec.kind, 'ssh')
  assert.equal(spec.owner, 's-1')
  assert.deepEqual(spec.toolCall, { callId: 'c-1', rootCallId: 'r-1' })
  assert.match(spec.label, /Proxy: make world/)
  assert.equal(spec.output.length, 2) // both channels keep streaming after the hand-over
})

test('a refused hand-over falls back to the old kill and says which happened', async () => {
  const { ops, state } = build({ records: [record({ remoteTimeoutMs: 5 })], jobs: registry(true) })
  const { job, killed } = liveJob()
  state.startRunOut = job
  const out = await ops.runCommand({ command: 'sleep 100' })
  assert.equal(out.run.status, 'timeout')
  assert.equal(killed.count, 1) // the child is stopped, as before 0.0.26
  assert.match(out.run.message ?? '', /could not be left running/)
  assert.match(out.run.hint ?? '', /job_kill/)
})

test('a profile that turns promotion off keeps the plain bounded wait', async () => {
  const { ops, state } = build({ jobs: registry(), bounds: () => ({ ...defaultBounds(), promoteOnTimeout: false }) })
  const out = await ops.runCommand({ command: 'uptime' })
  assert.equal(out.run.status, 'succeeded')
  assert.equal(state.calls.some(c => c.kind === 'run'), true)
  assert.equal(state.calls.some(c => c.kind === 'startRun'), false)
})

test('a background call past the job ceiling is refused in its own frame, not as a failed job', async () => {
  const starts = []
  const jobs = {
    start (spec) {
      starts.push(spec.label)
      let done
      const settled = new Promise(resolve => { done = resolve })
      // The registry contract: hooks come back synchronously, and `done` is what
      // the registry waits on to settle the job.
      void settled
      return `ssh-job-${String(starts.length)}`
    }
  }
  const { ops, state } = build({ jobs })
  state.laneRoom = (lane) => lane.kind === 'background jobs' ? false : true
  const out = await ops.execBackground({ command: 'make world' })
  assert.equal(out.ok, false)
  assert.equal(out.status, 'refused')
  assert.equal(out.jobId, undefined, 'no id is handed back for a command that never started')
  assert.match(out.message, /At most 8 background jobs may run at once, and all 8 slots are taken\./)
  assert.match(out.hint, /job_kill/)
  assert.deepEqual(starts, [], 'the registry was never asked to start it')
  // The lane is only *asked*, never taken: the ceiling still belongs to the child.
  assert.equal(state.calls.filter(call => call.kind === 'startRun').length, 0)
  state.laneRoom = () => true
  const room = await ops.execBackground({ command: 'make world' })
  assert.equal(room.ok, true)
  assert.equal(room.status, 'started')
  assert.equal(starts.length, 1, 'and the next call does register')
})

test('a profile with no job registry never attempts a hand-over', async () => {
  const { ops, state } = build()
  await ops.runCommand({ command: 'uptime' })
  assert.equal(state.calls.some(c => c.kind === 'run'), true)
  assert.equal(state.calls.some(c => c.kind === 'startRun'), false)
})

test('edit dryRun previews the change without writing, backing up, or re-reading more', async () => {
  const { ops, state } = build()
  state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: 'alpha\nbeta\ngamma', stderr: '', durationMs: 3, truncated: false })
  const out = await ops.editRemote({ path: '/srv/x', oldText: 'beta', newText: 'BETA', dryRun: true })
  assert.equal(out.dryRun, true)
  assert.equal(out.replaced, 1)
  assert.match(out.diff, /-beta/)
  assert.match(out.diff, /\+BETA/)
  assert.equal(out.backup, undefined) // no backup: nothing was written
  assert.equal(state.calls.filter(c => c.kind === 'run').length, 1) // only the read it needed
  // The match rules are the real rules: an ambiguous dry run refuses exactly as
  // the write would, and counts the matches.
  const twice = build()
  twice.state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: 'beta\nbeta', stderr: '', durationMs: 3, truncated: false })
  const amb = await twice.ops.editRemote({ path: '/srv/x', oldText: 'beta', newText: 'BETA', dryRun: true })
  assert.equal(amb.ok, false)
  assert.equal(amb.matches, 2)
  assert.equal(amb.dryRun, undefined)
  assert.equal(twice.state.calls.filter(c => c.kind === 'run').length, 1)
})

// ── cancellation: the caller's signal rides every child this layer starts ──
test('the call cancellation reaches the transport for each remote action', async () => {
  const controller = new AbortController()
  const { ops, state } = build() // no jobs: the plain bounded wait runs
  await ops.runCommand({ command: 'uptime' }, controller.signal)
  assert.equal(state.calls[0].kind, 'run')
  assert.equal(state.calls[0].options.signal, controller.signal)
  const fileOps = build()
  await fileOps.ops.readPath({ path: '/srv/x' }, controller.signal)
  assert.equal(fileOps.state.calls[0].options.signal, controller.signal)
  await fileOps.ops.writeRemote({ path: '/srv/x', content: 'hi' }, controller.signal)
  assert.equal(fileOps.state.calls.at(-1).options.signal, controller.signal)
  fileOps.state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: 'abc', stderr: '', durationMs: 1 })
  await fileOps.ops.editRemote({ path: '/srv/x', oldText: 'a', newText: 'z' }, controller.signal)
  const editCalls = fileOps.state.calls.filter(c => c.kind === 'run')
  assert.ok(editCalls.length >= 2, 'edit is read plus write')
  assert.ok(editCalls.every(c => c.options.signal === controller.signal), 'both edit children are cancellable')
  // Transfers carry the signal into the copy child — whichever kind of copy it is
  // — and into the stat pre-check that runs before it, so a cancel lands wherever
  // the call happens to be standing.
  const dir = tempTree()
  const local = join(dir, 'x')
  writeFileSync(local, 'hello')
  const xfer = build()
  xfer.state.streamOut = { outcome: 'exit', exitCode: 0, bytes: 5, stdout: '', stderr: '', durationMs: 2 }
  xfer.state.executeOut = { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 2, truncated: false }
  await xfer.ops.upload({ path: '/srv/x', localPath: local }, controller.signal)
  const streamed = xfer.state.calls.find(c => c.kind === 'streamFile')
  assert.equal(streamed.signal, controller.signal)
  assert.deepEqual(streamed.lane, { kind: 'file transfers', cap: DEFAULTS.maxConcurrentTransfers })
  const stats = xfer.state.calls.filter(c => c.kind === 'run' && /^stat /.test(c.command ?? ''))
  assert.ok(stats.length >= 1 && stats.every(c => c.options.signal === controller.signal))
  // The tree path is the one that still hands the signal to scp.
  const tree = build()
  tree.state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: 'ssh-plugin: 1 tree 5', stderr: '', durationMs: 1 })
  tree.state.executeOut = { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 2, truncated: false }
  await tree.ops.upload({ path: '/srv/x', localPath: local, recursive: true }, controller.signal)
  const execCall = tree.state.calls.find(c => c.kind === 'execute')
  assert.equal(execCall.signal, controller.signal)
  assert.deepEqual(execCall.lane, { kind: 'file transfers', cap: DEFAULTS.maxConcurrentTransfers })
})

test('a promoted hand-over stays cancellable while the call waits, and the started job is not', async () => {
  // A job the registry already holds outlives the call that started it, so
  // execBackground never forwards the caller's signal to the child; a foreground
  // run that could get promoted is the opposite case — until the hand-over
  // happens, the signal still owns the child.
  const started = build({ jobs: registry() })
  let resolveFinished
  started.state.startRunOut = {
    sources: [
      { channel: 'stdout', read: () => ({ text: '', nextOffset: 0, lossy: false }) },
      { channel: 'stderr', read: () => ({ text: '', nextOffset: 0, lossy: false }) }
    ],
    kill: () => {},
    finished: new Promise(resolve => { resolveFinished = resolve })
  }
  const controller = new AbortController()
  const waiting = started.ops.runCommand({ command: 'sleep 120' }, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 20))
  const startRun = started.state.calls.find(c => c.kind === 'startRun')
  assert.equal(startRun.options.signal, controller.signal)
  // The command settles inside the wait window: a plain classified answer, and
  // the promoted path never armed a kill the reader did not ask for.
  resolveFinished({ outcome: 'exit', exitCode: 0, stdout: 'done\n', stderr: '', durationMs: 21, truncated: false })
  const out = await waiting
  assert.equal(out.run.status, 'succeeded')
  // And backgrounding hands over without the caller's signal: cancelling the
  // tool call after the job id arrived must not stop the running command.
  const bg = build({ jobs: registry() })
  bg.state.startRunOut = liveJob().job
  const bgOut = await bg.ops.execBackground({ command: 'make world', callId: 'c1', rootCallId: 'r1' })
  assert.equal(bgOut.status, 'started')
  const bgRun = bg.state.calls.find(c => c.kind === 'startRun')
  assert.equal(bgRun.options.signal, undefined)
  assert.equal(bgRun.options.timeoutMs, 0) // a job arms no timer of its own
  assert.equal(bgRun.options.job, true) // and it counts against the job ceiling
}
)

// ── K-6: the body an edit is about to write has to be the file it read ───────

test('a body shorter than the count the server gave is refused before the match, not edited', async () => {
  // The byte count is the framing a tool-less server can still state, so that is the
  // case where a disagreement has to stop the call. Where a digest *was* stated and the
  // body matches it, a stale count is not a fault: the body is provably the bytes the
  // server digested, and the version token re-stats the file at the write.
  const built = editRunner('one\nTARGET two\n', { noSha: true, readBytes: 99 })
  const out = await built.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.ok, false, 'the edit stops')
  assert.match(out.message, /is not provably the file, so nothing was written and the file is unchanged/u)
  assert.match(out.message, /short of the file on disk/u, 'and says which way it disagrees')
  assert.equal(out.matches, undefined, 'the needle was never even counted: a preview of a truncated file is not a preview')
  assert.equal(built.state.calls.filter(c => c.command.includes('cp -p')).length, 0, 'no safety copy')
  assert.equal(built.state.calls.filter(c => c.command.includes('cat >')).length, 0, 'no truncating write')
  assert.equal(built.server.file, 'one\nTARGET two\n', 'the server keeps its file')
  // A dry run is refused by the same rule: the framing is what makes either answer
  // worth reading, and it failed.
  const dry = editRunner('one\nTARGET two\n', { noSha: true, readBytes: 99 })
  const preview = await dry.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT', dryRun: true })
  assert.equal(preview.ok, false, 'a preview built on a body that is not the file is not offered')
  assert.match(preview.message, /not provably the file/u)
  assert.equal(dry.state.calls.filter(c => c.kind === 'run').length, 1, 'and only the read ran')
})

test('a body longer than the count the server gave is refused, because the stream carried more than the file', async () => {
  const built = editRunner('one\nTARGET two\n', { noSha: true, readBytes: 3 })
  const out = await built.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.ok, false)
  assert.match(out.message, /longer than the file on disk/u)
  assert.match(out.hint, /Read the file again/u, 'and points at the re-read, not at the ceiling')
  assert.equal(built.state.calls.filter(c => c.command.includes('cat >')).length, 0)
  assert.equal(built.server.file, 'one\nTARGET two\n')
})

test('a matching digest no longer outranks a disagreeing byte count — K-6 closes the waiver (0.0.38)', async () => {
  // 0.0.37 pinned the opposite answer here (“the digest describes the bytes handed
  // over; the count was taken at another instant”), and that pin was the bug: a read
  // whose two markers contradict each other is a read nobody can size, and an edit
  // built on it writes bytes the server never agreed to. The version token still
  // guards a file that grew *between* the read and the write; it cannot say what the
  // body *was* when the two claims disagreed inside one read. So the refusal comes
  // before the match, before the copy, and before anything is truncated.
  const built = editRunner('one\nTARGET two\n', { readBytes: 99 })
  const out = await built.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.ok, false, 'the count’s disagreement is not waived by the digest')
  assert.equal(out.contentVerified, false)
  assert.match(out.message, /is not provably the file, so nothing was written and the file is unchanged/u)
  assert.match(out.message, /short of the file on disk/u, 'named as the length fault it is')
  assert.match(out.message, /do digest to the SHA-256 the server stated/u, 'and the sentence says the digest matched anyway — the read contradicts itself')
  assert.equal(built.state.calls.filter(c => c.command.includes('cp -p')).length, 0, 'no safety copy')
  assert.equal(built.state.calls.filter(c => c.command.includes('cat >')).length, 0, 'no truncating write')
  assert.equal(built.server.file, 'one\nTARGET two\n', 'the server keeps its file')
  // A dry run is refused by the same rule: a preview sized from a self-contradictory
  // read is as untrustworthy as an edit built on one.
  const dry = editRunner('one\nTARGET two\n', { readBytes: 99 })
  const preview = await dry.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT', dryRun: true })
  assert.equal(preview.ok, false, 'and the preview is not offered either')
  assert.match(preview.message, /not provably the file/u)
  assert.equal(dry.state.calls.filter(c => c.kind === 'run').length, 1, 'only the read ran')
})

test('bytes that decode to something other than what the server digested are refused', async () => {
  // The case a length cannot see: the digest was taken over the file's own bytes, and
  // the body in hand is what a lossy UTF-8 decode made of them. Same-looking,
  // different-bytes — and an edit here would push the replacements into the file.
  const built = editRunner('one\nTARGET two\n', { readDigest: 'f'.repeat(64) })
  const out = await built.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.ok, false)
  assert.equal(out.contentVerified, false)
  assert.match(out.message, /do not digest to the SHA-256 the server stated/u)
  assert.match(out.hint, /not valid UTF-8|changed while it was being read/u)
  assert.equal(built.state.calls.filter(c => c.kind === 'run').length, 1, 'one read, and no write at all')
  // A stated value that is not a digest at all is read as no digest, which sends the
  // call to the K-1 gate rather than to a comparison with a word.
  const odd = editRunner('one\nTARGET two\n', { readDigest: 'sha256sum: /etc/f: Permission denied' })
  const oddOut = await odd.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(oddOut.ok, false)
  assert.match(oddOut.message, /stated no usable SHA-256/u, 'and the refusal says it had nothing to check against')
})

test('a read that states no framing still edits, on the digest alone', async () => {
  // The legacy shape (two markers, no byte count) predates the framing claim, so the
  // guard rests on the digest and says nothing about a length it was never given.
  const built = editRunner('one\nTARGET two\n', { noBytes: true })
  const out = await built.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(out.ok, true, 'the edit is not refused for want of a marker this server never had')
  assert.equal(out.contentVerified, true, 'and the digest that was stated is what proves it')
  // With neither marker, nothing is provable: the K-1 gate stops the write, and the
  // preview still runs.
  const bare = editRunner('one\nTARGET two\n', { noBytes: true, noSha: true })
  const bareOut = await bare.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT' })
  assert.equal(bareOut.ok, false)
  assert.match(bareOut.message, /stated no usable SHA-256/u)
  const bareDry = editRunner('one\nTARGET two\n', { noBytes: true, noSha: true })
  const preview = await bareDry.ops.editRemote({ path: '/etc/f', oldText: 'TARGET', newText: 'KEPT', dryRun: true })
  assert.equal(preview.ok, true, 'a preview costs nothing the server cannot attest')
  assert.equal(preview.diff.includes('KEPT'), true)
})
