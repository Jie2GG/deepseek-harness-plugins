// The agent-facing surface: policy gate, target resolution, defensive argument
// reading, the model-visible wording, and every payload against the registry's
// own schema validator.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REMOTE_TOOL_ACTIONS,
  REMOTE_TOOL_NAME,
  REMOTE_TOOL_FALLBACK_NAME,
  decideAccess,
  findTarget,
  readArgs,
  gateRemoteCall,
  describeRemote,
  targetParamHint,
  buildRemoteTool
} from '../lib/tool.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { assertPayloadValid } from './helpers.mjs'

const snapshot = (over = {}) => ({
  id: 'ssh-a1b2c3d4e5',
  label: 'Proxy',
  host: '10.0.0.9',
  user: 'deploy',
  port: 22022,
  agentAccess: 'on',
  allowedCommands: [],
  ...over
})

test('the action list is the seven shipped verbs', () => {
  assert.deepEqual([...REMOTE_TOOL_ACTIONS], ['get_connection', 'exec', 'read', 'write', 'edit', 'upload', 'download'])
  assert.equal(REMOTE_TOOL_NAME, 'ssh_client')
  assert.equal(REMOTE_TOOL_FALLBACK_NAME, 'ssh_remote')
})

// ── ① the wording the model reads must match the gate that decides ──────────
test('describeRemote matches decideAccess on the empty-allowlist rule', () => {
  const text = describeRemote([{ label: 'Proxy', host: '10.0.0.9', user: 'deploy' }])
  // The corrected sentence: listed bare program runs unasked; empty list asks.
  assert.match(text, /runs unasked only when its one bare leading program is named by that target's command allowlist/)
  assert.match(text, /a fresh target names no programs there, so every command on it is asked about first/)
  assert.doesNotMatch(text, /runs freely unless/)
  assert.match(text, /`Proxy` \(deploy@10\.0\.0\.9\)/)
  const verdict = decideAccess(snapshot(), { action: 'exec', command: 'uptime' })
  assert.equal(verdict.verdict, 'ask') // empty allowlist -> every command asked
  const listed = decideAccess(snapshot({ allowedCommands: ['uptime'] }), { action: 'exec', command: 'uptime -p' })
  assert.equal(listed.verdict, 'allow')
})

test('the rendered inventory line tells the model an empty allowlist asks', () => {
  const definition = buildRemoteTool({ ops: async () => ({}), catalog: async () => [] })
  const lines = definition.output.render({ action: 'get_connection' }, {
    action: 'get_connection',
    ok: true,
    count: 1,
    targets: [{ id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9', auth: 'key', agentAccess: 'on', allowedCommands: [], hasPassword: false, hasPassphrase: false }],
    message: ''
  })
  assert.match(lines[0].text, /allowlist=none\(ask every command\)/)
  const listed = definition.output.render({ action: 'get_connection' }, {
    action: 'get_connection',
    ok: true,
    count: 1,
    targets: [{ id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9', auth: 'key', agentAccess: 'on', allowedCommands: ['git', 'uptime'], hasPassword: true, hasPassphrase: false }],
    message: ''
  })
  assert.match(listed[0].text, /allowlist=git,uptime/)
  assert.match(listed[0].text, /password stored/)
})

// ── ② every field the body consumes is now declared in parameters ──────────
test('parameters declare all twenty fields the body reads', () => {
  const definition = buildRemoteTool({ ops: async () => ({}), catalog: async () => [] })
  // defineTool compiles the parameter DSL into a JSON schema object.
  assert.equal(definition.parameters.type, 'object')
  const declared = Object.keys(definition.parameters.properties)
  for (const field of ['action', 'target', 'command', 'path', 'content', 'overwrite', 'append', 'mkdir',
    'localPath', 'recursive', 'timeoutMs', 'background', 'maxBytes', 'tty', 'input',
    'oldText', 'newText', 'all', 'replaceFirst', 'backup']) {
    assert.ok(declared.includes(field), `parameters schema is missing "${field}"`)
  }
  assert.equal(declared.length, 20)
  // The action enum and the required action field keep the shape honest.
  assert.deepEqual([...definition.parameters.properties.action.enum], [...REMOTE_TOOL_ACTIONS])
  assert.ok(definition.parameters.required.includes('action'))
})

// ── decideAccess: the whole policy matrix ──────────────────────────────────
test('reads are allowed, writes are asked, the off switch denies', () => {
  assert.equal(decideAccess(undefined, { action: 'exec', command: 'x' }).verdict, 'allow') // unresolved target: the body's problem
  for (const action of ['get_connection', 'read', 'download']) {
    assert.equal(decideAccess(snapshot(), { action, path: '/f' }).verdict, 'allow', action)
  }
  for (const action of ['write', 'edit', 'upload']) {
    const verdict = decideAccess(snapshot(), { action, path: '/f', localPath: 'a', oldText: 'x', newText: 'y' })
    assert.equal(verdict.verdict, 'ask', action)
    assert.deepEqual(Object.keys(verdict.display).sort(), ['en', 'zh'])
  }
  const off = decideAccess(snapshot({ agentAccess: 'off' }), { action: 'read', path: '/f' })
  assert.equal(off.verdict, 'deny')
  assert.match(off.reason, /agent access off/)
  // get_connection is a read of the local inventory: allowed even with the switch off.
  assert.equal(decideAccess(snapshot({ agentAccess: 'off' }), { action: 'get_connection' }).verdict, 'allow')
  // The write prompt quotes what will be replaced, trimmed to 120 characters.
  const edit = decideAccess(snapshot(), { action: 'edit', path: '/etc/hosts', oldText: 'x'.repeat(200), newText: 'y' })
  assert.ok(edit.reason.includes(`${'x'.repeat(120)}`))
  assert.ok(!edit.reason.includes(`${'x'.repeat(121)}`))
  // Pipelines never count as one program even when the leading name is listed;
  // the explanation of why lives in the human-facing prompt, not the machine reason.
  const pipe = decideAccess(snapshot({ allowedCommands: ['git'] }), { action: 'exec', command: 'git log | head' })
  assert.equal(pipe.verdict, 'ask')
  assert.match(pipe.display.en, /chains, redirects, or substitutes/)
  assert.match(pipe.display.zh, /串接、重定向或替换/)
  // A long command is sliced into the prompt, and the authority names the user.
  const run = decideAccess(snapshot({ allowedCommands: ['uptime'] }), { action: 'exec', command: `uptime ${'y'.repeat(400)}` })
  assert.equal(run.verdict, 'allow')
  const ask = decideAccess(snapshot({ user: undefined }), { action: 'exec', command: 'reboot' })
  assert.match(ask.reason, /Run on 10\.0\.0\.9: reboot/)
})

test('findTarget mirrors ops.pickTarget: reference, then session, then lone row', () => {
  const two = [snapshot(), snapshot({ id: 'ssh-b2c3d4e5f6', label: 'Build', host: '10.0.0.8', user: undefined })]
  assert.equal(findTarget(two, { target: 'ssh-a1b2c3d4e5' })?.id, 'ssh-a1b2c3d4e5')
  assert.equal(findTarget(two, { target: '  proxy ' })?.id, 'ssh-a1b2c3d4e5') // any case, trimmed
  assert.equal(findTarget(two, { target: 'DEPLOY@10.0.0.9' })?.id, 'ssh-a1b2c3d4e5')
  assert.equal(findTarget(two, { target: '10.0.0.8' })?.id, 'ssh-b2c3d4e5f6')
  assert.equal(findTarget(two, { target: 'Build' }, 'ssh-a1b2c3d4e5')?.id, 'ssh-b2c3d4e5f6') // explicit wins over session
  assert.equal(findTarget(two, {}, 'ssh-b2c3d4e5f6')?.id, 'ssh-b2c3d4e5f6') // the remembered session target
  assert.equal(findTarget(two, {}), undefined) // ambiguous on purpose
  assert.equal(findTarget([two[1]], {}), two[1]) // a lone row needs no name
  assert.equal(findTarget(two, { target: 'nope' }), undefined)
})

test('readArgs survives a malformed call without throwing or inventing values', () => {
  const bare = readArgs({ name: 'ssh_client' })
  assert.equal(bare.action, 'exec') // the defensive default
  assert.equal(bare.command, undefined)
  const typed = readArgs({
    name: 'ssh_client',
    arguments: {
      action: 'read', path: '/tmp/x', timeoutMs: '5000', maxBytes: NaN, background: 'yes',
      recursive: true, mkdir: false, newText: '', input: 42, all: 'true'
    }
  })
  assert.equal(typed.action, 'read')
  assert.equal(typed.timeoutMs, undefined) // a string is not a number
  assert.equal(typed.maxBytes, undefined) // NaN is not finite
  assert.equal(typed.background, undefined) // 'yes' is not a boolean
  assert.equal(typed.recursive, true)
  assert.equal(typed.mkdir, false)
  assert.equal(typed.newText, '') // empty replacement text survives (it deletes)
  assert.equal(typed.input, undefined)
  assert.equal(typed.all, undefined)
})

test('targetParamHint names every alias, or says none is saved', () => {
  assert.match(targetParamHint([]), /None is saved yet/)
  const hint = targetParamHint([{ label: 'Proxy', host: 'h' }, { label: 'Build', host: 'b' }])
  assert.match(hint, /`Proxy`, `Build`/)
})

// ── the pre-execute gate, end to end ───────────────────────────────────────
const pass = async () => ({ kind: 'allow' })

test('gateRemoteCall: allow passes through, deny refuses, ask carries both languages', async () => {
  const deps = { ops: async () => ({}), catalog: async () => [snapshot()] }
  assert.deepEqual(await gateRemoteCall(deps, { name: 'ssh_client', arguments: { action: 'read', path: '/x' } }, pass), { kind: 'allow' })

  const ask = await gateRemoteCall(deps, { name: 'ssh_client', arguments: { action: 'write', path: '/x', content: 'c' } }, pass)
  assert.equal(ask.kind, 'ask')
  assert.deepEqual(Object.keys(ask.displayReason).sort(), ['en', 'zh'])

  const deny = await gateRemoteCall({ ...deps, catalog: async () => [snapshot({ agentAccess: 'off' })] },
    { name: 'ssh_client', arguments: { action: 'exec', command: 'uptime' } }, pass)
  assert.equal(deny.kind, 'deny')
})

test('gateRemoteCall: an unreadable inventory denies, other tools are ignored', async () => {
  const broken = { ops: async () => ({}), catalog: async () => { throw new Error('disk on fire') } }
  const denied = await gateRemoteCall(broken, { name: 'ssh_client', arguments: { action: 'exec', command: 'x' } }, pass)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /could not read its saved targets/)
  // An action outside the list falls through to the registry's own validation,
  // and a throwing catalog proves the fall-through never consulted it.
  const untouched = { ops: async () => ({}), catalog: async () => { throw new Error('must not run') } }
  assert.deepEqual(await gateRemoteCall(untouched, { name: 'ssh_client', arguments: { action: 'teleport' } }, pass), { kind: 'allow' })
})

test('gateRemoteCall: a conversation that cannot answer gets the run, not a self-refusal', async () => {
  const deps = { ops: async () => ({}), catalog: async () => [snapshot()], approvalPolicyOf: () => 'never' }
  const result = await gateRemoteCall(deps, { name: 'ssh_client', arguments: { action: 'exec', command: 'reboot now' } }, pass)
  assert.equal(result.kind, 'allow') // the standing deployment decision is the consent
  // A deny is the user's own switch: `never` does not rescue it.
  const off = { ...deps, catalog: async () => [snapshot({ agentAccess: 'off' })] }
  assert.equal((await gateRemoteCall(off, { name: 'ssh_client', arguments: { action: 'exec', command: 'x' } }, pass)).kind, 'deny')
  // A policy read that throws falls back to asking rather than running blind.
  const flaky = { ...deps, approvalPolicyOf: () => { throw new Error('scope gone') } }
  assert.equal((await gateRemoteCall(flaky, { name: 'ssh_client', arguments: { action: 'write', path: '/x' } }, pass)).kind, 'ask')
  // A session target is consulted only when the call left target out.
  let seen
  const sessionDeps = {
    ops: async () => ({}),
    catalog: async () => [snapshot(), snapshot({ id: 'ssh-b2c3d4e5f6', label: 'Build', host: 'b' })],
    sessionOf: () => 'session-77',
    sessionTargetOf: (s) => { seen = s; return 'ssh-b2c3d4e5f6' }
  }
  await gateRemoteCall(sessionDeps, { name: 'ssh_client', arguments: { action: 'exec', command: 'uptime' } }, pass)
  assert.equal(seen, 'session-77') // unlisted program on the session target -> ask, after resolving via session
})

// ── execute: dispatch, refusals, session memory, payload-schema agreement ──
function fakeOps () {
  return {
    seen: [],
    async list () {
      return {
        connections: [{ id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9', user: 'deploy', auth: 'key', agentAccess: 'on', allowedCommands: [], secrets: { password: true, passphrase: false }, lastProbe: { status: 'reachable', at: '2026-01-01T00:00:00.000Z' } }],
        settings: { command: 'ssh', probeTimeoutMs: 10000, maxOutputBytes: 65536, remoteTimeoutMs: 30000, maxTransferBytes: 33554432 }
      }
    },
    async runCommand (params) {
      this.seen.push(['runCommand', params])
      return { run: { status: 'succeeded', at: 'x', exitCode: 0, stdout: 'ok\n', stderr: '', durationMs: 12 }, connection: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' } }
    },
    async execBackground (params) {
      this.seen.push(['execBackground', params])
      return { action: 'exec', ok: true, status: 'started', target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }, command: params.command, jobId: 'ssh-j1', connections: [] }
    },
    async readPath (params) {
      this.seen.push(['readPath', params])
      return { action: 'read', ok: true, status: 'succeeded', target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }, path: params.path, type: 'file', content: 'hello\n', bytes: 6, lines: 2, durationMs: 4 }
    },
    async writeRemote (params) {
      this.seen.push(['writeRemote', params])
      return { action: 'write', ok: true, status: 'succeeded', target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }, path: params.path, bytes: 3, durationMs: 4 }
    },
    async editRemote (params) {
      this.seen.push(['editRemote', params])
      return { action: 'edit', ok: true, status: 'succeeded', target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }, path: params.path, type: 'file', replaced: 1, bytesBefore: 12, bytesAfter: 12, backup: `${params.path}.dsh-bak`, durationMs: 9 }
    },
    async upload (params) {
      this.seen.push(['upload', params])
      return { action: 'upload', ok: true, status: 'moved', target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }, localPath: params.localPath, remotePath: params.path, bytes: 5, durationMs: 7 }
    },
    async download (params) {
      this.seen.push(['download', params])
      return { action: 'download', ok: true, status: 'moved', target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }, localPath: params.localPath, remotePath: params.path, bytes: 5, durationMs: 7 }
    },
    async setSessionTarget (params) { this.seen.push(['setSessionTarget', params]); return { sessionId: params.sessionId, targetId: params.targetId, setAt: 'x' } }
  }
}

function toolHarness (ops, extra = {}) {
  const sessionId = extra.sessionId ?? 'session-77'
  const definition = buildRemoteTool({
    ops: async () => ops,
    catalog: async () => [snapshot()],
    ...(sessionId === undefined ? {} : { sessionOf: () => sessionId }),
    ...extra.deps
  })
  const exec = { name: 'ssh_client', callId: 'c1', rootCallId: 'r1', agent: {} }
  return { definition, exec }
}

test('exec: foreground success carries a registry-valid payload and names the call', async () => {
  const ops = fakeOps()
  const { definition, exec } = toolHarness(ops)
  const payload = await definition.execute({ action: 'exec', command: 'uptime', target: 'Proxy' }, exec)
  assert.equal(payload.ok, true)
  assert.equal(payload.stdout, 'ok\n')
  assertPayloadValid(definition.output.schema, payload)
  assert.deepEqual(ops.seen[0], ['runCommand', { command: 'uptime', target: 'Proxy', sessionId: 'session-77' }])
  // An explicitly named target is remembered for the conversation.
  assert.deepEqual(ops.seen[1], ['setSessionTarget', { sessionId: 'session-77', targetId: 'ssh-a1b2c3d4e5' }])
  const rendered = definition.output.render({ action: 'exec', command: 'uptime' }, payload)[0].text
  assert.match(rendered, /Proxy\$ uptime/)
  assert.match(rendered, /status=succeeded · exit=0 · 12 ms/)
})

test('exec: backgrounding hands over the job identity and omits a premature exit code', async () => {
  const ops = fakeOps()
  const { definition, exec } = toolHarness(ops)
  const payload = await definition.execute({ action: 'exec', command: 'make world', background: true }, exec)
  assert.equal(payload.jobId, 'ssh-j1')
  assertPayloadValid(definition.output.schema, payload)
  const params = ops.seen[0][1]
  assert.equal(params.callId, 'c1')
  assert.equal(params.rootCallId, 'r1')
  const rendered = definition.output.render({ action: 'exec', command: 'make world' }, payload)[0].text
  assert.match(rendered, /Left running in the background as job ssh-j1/)
  assert.doesNotMatch(rendered, /exit=/) // a running command has no exit code to show
})

test('exec without a command, and the file actions without a path, refuse at the boundary', async () => {
  const ops = fakeOps()
  const { definition, exec } = toolHarness(ops)
  for (const args of [
    { action: 'exec' },
    { action: 'read' },
    { action: 'write', content: 'x' },
    { action: 'edit', path: '/f', newText: 'y' },
    { action: 'edit', path: '/f', oldText: 'x' }, // newText absent
    { action: 'upload', path: '/f' }, // localPath absent
    { action: 'download', localPath: 'a' } // path absent
  ]) {
    const payload = await definition.execute(args, exec)
    assert.equal(payload.ok, false, JSON.stringify(args))
    assert.equal(payload.action, args.action)
    assertPayloadValid(definition.output.schema, payload)
  }
})

test('read, write, and edit forward their fields and validate their payloads', async () => {
  const ops = fakeOps()
  const { definition, exec } = toolHarness(ops)
  const read = await definition.execute({ action: 'read', path: '/etc/hosts', maxBytes: 2048 }, exec)
  assertPayloadValid(definition.output.schema, read)
  assert.equal(ops.seen[0][1].maxOutputBytes, 2048)
  const wrote = await definition.execute({ action: 'write', path: '/tmp/x', content: 'abc', append: true, mkdir: false }, exec)
  assertPayloadValid(definition.output.schema, wrote)
  assert.equal(ops.seen[1][1].append, true)
  assert.equal(ops.seen[1][1].mkdir, false)
  const edited = await definition.execute({ action: 'edit', path: '/etc/hosts', oldText: 'a', newText: '', backup: false }, exec)
  assertPayloadValid(definition.output.schema, edited)
  assert.equal(ops.seen[2][1].newText, '') // empty replacement deletes
  assert.equal(ops.seen[2][1].backup, false) // the cp -p backup is skipped on purpose
})

test('transfers resolve the local side through the bridge and honour the write pipeline', async () => {
  const ops = fakeOps()
  const bridge = {
    dirOf: async () => '/ws',
    exists: async () => true,
    resolve: (p, dir) => {
      if (p === 'sub/a.txt') return `${dir}/sub/a.txt`
      throw new Error(`"${p}" is outside the conversation workspace /ws.`)
    },
    writeIntent: async () => ({ kind: 'createIfAbsent' })
  }
  const { definition, exec } = toolHarness(ops, { deps: { local: bridge } })
  const up = await definition.execute({ action: 'upload', path: '/srv/x', localPath: 'sub/a.txt' }, exec)
  assert.equal(up.ok, true)
  assert.equal(ops.seen[0][1].localPath, '/ws/sub/a.txt')
  assertPayloadValid(definition.output.schema, up)
  // A download the pipeline guards as create-only onto an existing file refuses before scp.
  const down = await definition.execute({ action: 'download', path: '/srv/x', localPath: 'sub/a.txt' }, exec)
  assert.equal(down.status, 'refused-exists')
  assert.match(down.message, /only allows a new file/)
  assertPayloadValid(definition.output.schema, down)
  // An escaping path is refused with the bridge's own explanation.
  const bad = await definition.execute({ action: 'upload', path: '/srv/x', localPath: '../../etc/x' }, exec)
  assert.equal(bad.ok, false)
  assert.match(bad.message, /outside the conversation workspace/)
  assertPayloadValid(definition.output.schema, bad)
})

test('replaceIfVersion cannot be honoured around scp unless overwrite was said', async () => {
  const ops = fakeOps()
  const bridge = { dirOf: async () => '/ws', exists: async () => true, resolve: p => `/ws/${p}`, writeIntent: async () => ({ kind: 'replaceIfVersion' }) }
  const { definition, exec } = toolHarness(ops, { deps: { local: bridge } })
  const payload = await definition.execute({ action: 'download', path: '/x', localPath: 'a' }, exec)
  assert.equal(payload.status, 'refused-exists')
  assert.match(payload.hint, /Pass overwrite/)
  const forced = await definition.execute({ action: 'download', path: '/x', localPath: 'a', overwrite: true }, exec)
  assert.equal(forced.ok, true)
})

test('get_connection names the server a later call would address, and never a secret value', async () => {
  const ops = fakeOps()
  const { definition, exec } = toolHarness(ops, { deps: { sessionTargetOf: () => 'ssh-a1b2c3d4e5' } })
  const payload = await definition.execute({ action: 'get_connection' }, exec)
  assert.equal(payload.selectedLabel, 'Proxy')
  assert.equal(payload.selectedVia, 'session')
  assert.equal(payload.targets[0].hasPassword, true)
  assert.ok(!JSON.stringify(payload).includes('hunter2'))
  assertPayloadValid(definition.output.schema, payload)
  const rendered = definition.output.render({}, payload)[0].text
  assert.match(rendered, /A later call would address: Proxy \(deploy@10\.0\.0\.9\) — reached by session/)
  assert.match(rendered, /password stored/)
})

test('presentationMeta and presentCall read only the canonical value', () => {
  const { definition } = toolHarness(fakeOps())
  const meta = definition.output.presentationMeta({}, { action: 'exec', ok: true, target: { label: 'Proxy', host: 'h' } })
  assert.deepEqual(meta, { action: 'exec', ok: true, label: 'Proxy' })
  const card = definition.presentCall({ action: 'write', path: '/tmp/x' })
  assert.equal(card.title, 'ssh_client write')
  assert.equal(card.kind, 'edit')
  assert.equal(definition.presentCall({ action: 'exec', command: 'uptime' }).kind, 'execute')
  assert.equal(definition.timeoutMs, 300_000)
})

test('every action keeps its schema honest when a producer forgets a field', () => {
  // A payload dropping the required ok must be rejected whole, the way the
  // registry rejects one when the call settles.
  const { definition } = toolHarness(fakeOps())
  assert.ok(validateJsonSchemaValue(definition.output.schema, { action: 'read', status: 'succeeded', path: '/x', target: { id: 'i', label: 'l', host: 'h' } }).length > 0)
})
