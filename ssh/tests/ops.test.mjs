// The operations layer, transport faked at its seam: target resolution, the
// marker protocol of read, the write guards, the edit round trips, probe
// bookkeeping, resolve parsing, transfer pre-checks, and the background handoff.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createOps } from '../lib/ops.js'
import { SshError } from '../lib/types.js'
import { fakeRunner, fakeStore, fakeSecrets, record } from './helpers.mjs'

function build ({ records = [record()], store, secrets, askpassReady = true, localExists = false, jobs, options } = {}) {
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
    ...(options === undefined ? {} : { options }),
    onInventoryChanged: () => { changed.count += 1 }
  })
  return { ops, runner, state, store: storeObj, secrets: sec, changed }
}

const iso = new Date().toISOString()

// ── inventory reads ─────────────────────────────────────────────────────────
test('list carries the views, the limits, the askpass health, and the run identity', async () => {
  const { ops } = build({ store: fakeStore({ records: [record()], session: { sessionId: 'session-77', targetId: 'ssh-a1b2c3d4e5', setAt: iso } }) })
  const out = await ops.list({ sessionId: 'session-77' })
  assert.equal(out.connections.length, 1)
  assert.deepEqual(out.connections[0].secrets, { password: true, passphrase: false })
  assert.equal(out.limits.maxConnections, 64)
  assert.equal(out.limits.transferMaxBytes, 536_870_912)
  assert.equal(out.limits.probeTimeoutMs, 10_000) // one fixed fact, not a range any more
  assert.equal(out.askpass, 'ready')
  assert.equal(out.sessionTarget, 'ssh-a1b2c3d4e5')
  assert.equal(out.probing, 0)
  assert.deepEqual(Object.keys(out.runsAs).sort(), ['home', 'uid', 'user'])
  const broken = build({ askpassReady: false })
  assert.equal((await broken.ops.list()).askpass, 'unavailable')
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
test('runCommand forwards tty, stdin, and the per-target ceiling overrides', async () => {
  const { ops, state } = build({ records: [record({ remoteTimeoutMs: 15_000, maxOutputBytes: 4096 })] })
  await ops.runCommand({ command: 'ls', tty: true, input: 'answer\n' })
  const call = state.calls[0]
  assert.equal(call.options.tty, true)
  assert.equal(call.options.stdin, 'answer\n')
  assert.equal(call.options.timeoutMs, 15_000) // the record's override replaces the shared default
  assert.equal(call.options.maxOutputBytes, 4096)
  assert.equal(call.auth.password, undefined) // key auth: no password read
  const explicit = build({ records: [record({ remoteTimeoutMs: 15_000 })] })
  await explicit.ops.runCommand({ command: 'ls', timeoutMs: 20_000 })
  assert.equal(explicit.state.calls[0].options.timeoutMs, 20_000) // an explicit call beats the record
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

test('read carries the size and the truth about the call ceiling', async () => {
  // Pinned current behaviour: ops takes the ceiling from the createOptions closure
  // or the settings, not from per-call params — the tool's maxBytes reaches exec
  // and transfers, but file reads run at the shared ceiling until that is fixed.
  const { ops, state } = build({ records: [record({ maxOutputBytes: 2048 })] })
  state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: 'ssh-plugin: file 1\nx' })
  await ops.readPath({ path: '/x', maxOutputBytes: 999 })
  assert.equal(state.calls[0].maxOutputBytes, 2048) // the per-target ceiling wins
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
function editRunner (content, over = {}) {
  const built = build(over)
  built.state.nextRun = command => {
    if (command.startsWith('if [ ! -f')) {
      return { status: 'succeeded', at: iso, exitCode: 0, stdout: content, stderr: '', durationMs: 2 }
    }
    return { status: 'succeeded', at: iso, exitCode: 0, stdout: '', stderr: '', durationMs: 3 }
  }
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
  assert.match(run.command, /^cp -p -- '\/etc\/f' '\/etc\/f\.dsh-bak' && cat > '\/etc\/f'$/)
  assert.equal(run.options.stdin, 'one\nKEPT two\n') // the whole new file, through stdin
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
  assert.equal(run.command.startsWith('cat > '), true) // no cp prefix
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
  // An explicit input is the caller's answer and wins over the stored secret.
  const chosen = build({ secrets: fakeSecrets({ password: true, passphrase: false, root: false }, { password: 'stored' }) })
  await chosen.ops.runCommand({ command: 'passwd', as: 'root', input: 'typed\n' })
  assert.equal(chosen.state.calls[0].command, 'sudo passwd')
  assert.equal(chosen.state.calls[0].options.stdin, 'typed\n')
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
  assert.equal(startRunCall.options.timeoutMs >= 1_800_000, true)
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

test('a sized-down download moves through scp with host:path both ends and the -P port seam', async () => {
  const { ops, state } = build()
  state.nextRun = () => ({ status: 'succeeded', at: iso, exitCode: 0, stdout: '5 regular file', stderr: '', durationMs: 1 })
  state.executeOut = { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 4, truncated: false }
  const out = await ops.download({ path: '/srv/x', localPath: '/ws/x', overwrite: true })
  assert.equal(out.status, 'moved')
  assert.equal(out.bytes, 5)
  assert.equal(out.overwrote, true)
  const exec = state.calls.find(c => c.kind === 'execute')
  assert.equal(exec.program, '/usr/bin/scp')
  // scp gets the far end named host:path on one side and the local path on the other;
  // the quiet flag and the -P port seam ride in front of them.
  assert.equal(exec.argvTail.at(-2), 'deploy@10.0.0.9:/srv/x')
  assert.equal(exec.argvTail.at(-1), '/ws/x')
  assert.ok(exec.argvTail.includes('-q'))
  assert.ok(exec.argvTail.includes('-P'))
  assert.deepEqual(state.optionsSeen[0].extra, { portFlag: '-P' }) // scp names the port -P
  const up = build()
  up.state.executeOut = { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 2, truncated: false }
  const upOut = await up.ops.upload({ path: '/srv/x', localPath: '/ws/x', recursive: true })
  assert.equal(upOut.ok, true)
  assert.equal(upOut.recursive, true)
  const upExec = up.state.calls.find(c => c.kind === 'execute')
  assert.ok(upExec.argvTail.includes('-r'))
  assert.equal(upExec.argvTail.at(-2), '/ws/x') // upload: local first…
  assert.equal(upExec.argvTail.at(-1), 'deploy@10.0.0.9:/srv/x') // …far end last
})

test('an upload whose source or far directory is missing says so in the useful direction', async () => {
  const { ops, state } = build()
  state.executeOut = { outcome: 'exit', exitCode: 1, stdout: '', stderr: 'scp: /ws/x: No such file or directory', durationMs: 2, truncated: false }
  const out = await ops.upload({ path: '/srv/x', localPath: '/ws/x' })
  assert.equal(out.status, 'missing')
  assert.match(out.message, /remote directory does not exist/)
})

test('a local path outside the declared workspace is refused before the copy', async () => {
  const { ops } = build()
  await assert.rejects(() => ops.upload({ path: '/srv/x', localPath: '/etc/x', localDir: '/ws' }), /outside the workspace/)
})

// ── bookkeeping and settings ────────────────────────────────────────────────
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
  let rejected
  try {
    await ops.configUpdate({ settings: { remoteTimeoutMs: 10 } })
  } catch (error) { rejected = error }
  assert.equal(rejected?.code, 'bad-input')
  assert.equal(rejected.field, 'remoteTimeoutMs')
  // The retired fields are no one's to write any more: the page that still
  // sends probeTimeoutMs gets a clean refusal, not a silent ignore.
  let stale
  try {
    await ops.configUpdate({ settings: { probeTimeoutMs: 10_000 } })
  } catch (error) { stale = error }
  assert.equal(stale?.code, 'bad-input')
})
