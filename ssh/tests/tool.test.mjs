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
import { defaultBounds } from '../lib/bounds.js'
import { DRAIN_MS } from '../lib/transport.js'
import { createOps } from '../lib/ops.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { assertPayloadValid, fakeRunner, fakeStore, fakeSecrets, record } from './helpers.mjs'

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
  assert.match(text, /Pass `as: "root"` \(or another account\) to elevate through sudo/)
  assert.match(text, /no password ever appears in the conversation/)
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
    targets: [{ id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9', auth: 'key', agentAccess: 'on', allowedCommands: ['git', 'uptime'], hasPassword: true, hasPassphrase: false, hasRoot: true }],
    message: ''
  })
  assert.match(listed[0].text, /allowlist=git,uptime/)
  assert.match(listed[0].text, /password stored/)
  assert.match(listed[0].text, /root password stored/)
})

// ── ② every field the body consumes is now declared in parameters ──────────
test('parameters declare all twenty-three fields the body reads', () => {
  const definition = buildRemoteTool({ ops: async () => ({}), catalog: async () => [] })
  // defineTool compiles the parameter DSL into a JSON schema object.
  assert.equal(definition.parameters.type, 'object')
  const declared = Object.keys(definition.parameters.properties)
  for (const field of ['action', 'target', 'command', 'path', 'content', 'overwrite', 'append', 'mkdir',
    'localPath', 'recursive', 'timeoutMs', 'background', 'maxBytes', 'tty', 'input',
    'oldText', 'newText', 'all', 'replaceFirst', 'backup', 'dryRun', 'as', 'su']) {
    assert.ok(declared.includes(field), `parameters schema is missing "${field}"`)
  }
  assert.equal(declared.length, 23)
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

test('elevation always asks, names the account, and says which secret it spends', () => {
  // Even when the inner command is fully allowlisted: sudo is a master key, and
  // a hit on systemctl does not consent to running it as another account.
  const sudo = decideAccess(snapshot({ allowedCommands: ['systemctl'] }), { action: 'exec', command: 'systemctl restart nginx', as: 'root' })
  assert.equal(sudo.verdict, 'ask')
  assert.match(sudo.reason, /Run elevated as root on deploy@10\.0\.0\.9/)
  assert.match(sudo.display.en, /sudo, with the stored login password/)
  assert.match(sudo.display.zh, /sudo：用已存的登录密码应答/)
  const su = decideAccess(snapshot({ allowedCommands: ['id'] }), { action: 'exec', command: 'id', su: true })
  assert.equal(su.verdict, 'ask')
  assert.match(su.display.en, /su, with the stored root password/)
  // A foreign account shows up in the human prompt too.
  const pg = decideAccess(snapshot(), { action: 'exec', command: 'psql', as: 'postgres' })
  assert.match(pg.reason, /elevated as postgres/)
  // No elevation flags keeps the plain matrix: allowlist hits run free.
  assert.equal(decideAccess(snapshot({ allowedCommands: ['systemctl'] }), { action: 'exec', command: 'systemctl status' }).verdict, 'allow')
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
      recursive: true, mkdir: false, newText: '', input: 42, all: 'true', as: 'postgres', su: 'yes'
    }
  })
  assert.equal(typed.action, 'read')
  assert.equal(typed.timeoutMs, undefined) // a string is not a number
  assert.equal(typed.maxBytes, undefined) // NaN is not finite
  assert.equal(typed.background, undefined) // 'yes' is not a boolean
  assert.equal(typed.su, undefined) // 'yes' is not a boolean here either
  assert.equal(typed.as, 'postgres')
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

test('gateRemoteCall: `never` runs; an unreachable approval surface asks and lets the core refuse', async () => {
  const deps = { ops: async () => ({}), catalog: async () => [snapshot()], approvalPolicyOf: () => 'never' }
  const result = await gateRemoteCall(deps, { name: 'ssh_client', arguments: { action: 'exec', command: 'reboot now' } }, pass)
  assert.equal(result.kind, 'allow') // the standing deployment decision is the consent
  // The distinction task book §3.5 asks to keep: `unavailable` (no approval
  // service, or no session to route through) is NOT that consent. Asking is
  // what makes the core answer with its fail-closed denial that names the
  // missing piece — the plugin never invents an approval nobody gave.
  const deaf = { ...deps, approvalPolicyOf: () => 'unavailable' }
  const deafOut = await gateRemoteCall(deaf, { name: 'ssh_client', arguments: { action: 'exec', command: 'reboot now' } }, pass)
  assert.equal(deafOut.kind, 'ask')
  // And a read never depended on the policy: it passes whatever the answer is.
  assert.equal((await gateRemoteCall(deaf, { name: 'ssh_client', arguments: { action: 'read', path: '/x' } }, pass)).kind, 'allow')
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

test('execute: every remote action forwards the call cancellation to ops', async () => {
  const flows = [
    ['runCommand', { action: 'exec', command: 'uptime' }],
    ['readPath', { action: 'read', path: '/srv/x' }],
    ['writeRemote', { action: 'write', path: '/srv/x', content: 'hi' }],
    ['editRemote', { action: 'edit', path: '/srv/x', oldText: 'a', newText: 'b' }],
    ['upload', { action: 'upload', path: '/srv/x', localPath: '/ws/x', recursive: true }],
    ['download', { action: 'download', path: '/srv/x', localPath: '/ws/x' }]
  ]
  for (const [method, args] of flows) {
    const ops = fakeOps()
    const { definition, exec } = toolHarness(ops)
    await definition.execute(args, exec)
    const sent = ops.signals.filter(entry => entry[0] === method)
    assert.ok(sent.length >= 1, `${method} was called`)
    assert.ok(sent.every(entry => entry[1] === exec.signal), `${method} must forward exec.signal`)
  }
  // A started background job is the one case that must NOT be cancelled with the
  // call: the job outlives the call that started it — that is the whole bargain —
  // so its child is stopped by `job_kill`, not by this signal.
  const bg = fakeOps()
  const { definition, exec } = toolHarness(bg)
  await definition.execute({ action: 'exec', command: 'make world', background: true }, exec)
  assert.deepEqual(bg.signals.filter(entry => entry[0] === 'execBackground'), [])
})

// ── execute: dispatch, refusals, session memory, payload-schema agreement ──
function fakeOps () {
  return {
    seen: [],
    // What each remote-facing call was handed as the caller's cancellation.
    signals: [],
    async list () {
      return {
        connections: [{ id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9', user: 'deploy', auth: 'key', agentAccess: 'on', allowedCommands: [], secrets: { password: true, passphrase: false }, lastProbe: { status: 'reachable', at: '2026-01-01T00:00:00.000Z' } }],
        settings: { maxOutputBytes: 65536, remoteTimeoutMs: 30000, maxTransferBytes: 33554432 },
        // The resolved view the page and this model-facing line both read from.
        bounds: {
          timeoutMs: 30000, maxTimeoutMs: 300000,
          outputBytes: 65536, maxOutputBytes: 4194304,
          transferBytes: 33554432, maxTransferBytes: 536870912,
          probeTimeoutMs: 30000, statTimeoutMs: 10000, maxSpillBytes: 67108864, graceMs: 2000,
          promoteOnTimeout: true,
          effective: { maxOutputBytes: 65536, remoteTimeoutMs: 30000, maxTransferBytes: 33554432, probeTimeoutMs: 30000, statTimeoutMs: 10000, maxSpillBytes: 67108864, graceMs: 2000 },
          notes: []
        }
      }
    },
    async runCommand (params, signal) {
      this.seen.push(['runCommand', params])
      this.signals.push(['runCommand', signal])
      return { run: { status: 'succeeded', at: 'x', exitCode: 0, stdout: 'ok\n', stderr: '', durationMs: 12 }, connection: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' } }
    },
    async execBackground (params) {
      this.seen.push(['execBackground', params])
      return { action: 'exec', ok: true, status: 'started', target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }, command: params.command, jobId: 'ssh-j1', connections: [] }
    },
    async readPath (params, signal) {
      this.seen.push(['readPath', params])
      this.signals.push(['readPath', signal])
      return { action: 'read', ok: true, status: 'succeeded', target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }, path: params.path, type: 'file', content: 'hello\n', bytes: 6, lines: 2, durationMs: 4 }
    },
    async writeRemote (params, signal) {
      this.seen.push(['writeRemote', params])
      this.signals.push(['writeRemote', signal])
      return { action: 'write', ok: true, status: 'succeeded', target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }, path: params.path, bytes: 3, durationMs: 4 }
    },
    async editRemote (params, signal) {
      this.seen.push(['editRemote', params])
      this.signals.push(['editRemote', signal])
      return { action: 'edit', ok: true, status: 'succeeded', target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }, path: params.path, type: 'file', replaced: 1, bytesBefore: 12, bytesAfter: 12, backup: `${params.path}.dsh-bak`, durationMs: 9 }
    },
    async upload (params, signal) {
      this.seen.push(['upload', params])
      this.signals.push(['upload', signal])
      // Mirrors what ops really hands back, stamped fields included: a branch schema
      // that forgets one of them fails here, not against a live server.
      return { action: 'upload', ok: true, status: 'moved', target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }, localPath: params.localPath, remotePath: params.path, bytes: 5, durationMs: 7, bytesLimit: 33_554_432, timeoutMs: 30_000, ...(params.recursive === true ? { recursive: true, files: 1 } : {}) } // ops omits an empty notes list entirely
    },
    async download (params, signal) {
      this.seen.push(['download', params])
      this.signals.push(['download', signal])
      return { action: 'download', ok: true, status: 'moved', target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }, localPath: params.localPath, remotePath: params.path, bytes: 5, durationMs: 7, bytesLimit: 33_554_432, timeoutMs: 30_000, notes: ['transfer ceiling asked for 999999999 and was capped to 536870912'] }
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
  // The harness hands every call a cancellation; forwarding it is what the
  // `timeoutMs` declaration promises, so the tests carry one like the core does.
  const controller = new AbortController()
  const exec = { name: 'ssh_client', callId: 'c1', rootCallId: 'r1', agent: {}, signal: controller.signal, controller }
  return { definition, exec }
}

test('exec: foreground success carries a registry-valid payload and names the call', async () => {
  const ops = fakeOps()
  const { definition, exec } = toolHarness(ops)
  const payload = await definition.execute({ action: 'exec', command: 'uptime', target: 'Proxy' }, exec)
  assert.equal(payload.ok, true)
  assert.equal(payload.stdout, 'ok\n')
  assertPayloadValid(definition.output.schema, payload)
  assert.deepEqual(ops.seen[0], ['runCommand', {
    command: 'uptime',
    target: 'Proxy',
    sessionId: 'session-77',
    // 0.0.26: the call ids travel on a foreground run too, because a command that
    // outlives its deadline is handed to the registry, and that job has to name the
    // call that started it. `ops` reads them off before validating the strict schema.
    callId: 'c1',
    rootCallId: 'r1'
  }])
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

test('elevated exec echoes the account and swaps the credential hint', async () => {
  const ops = fakeOps()
  ops.runCommand = async () => ({
    run: { status: 'auth-failed', at: 'x', exitCode: 1, stdout: '', stderr: 'sudo: 1 incorrect password attempt', durationMs: 40, elevated: 'root' },
    connection: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' },
  })
  const { definition, exec } = toolHarness(ops)
  const payload = await definition.execute({ action: 'exec', command: 'apt update', as: 'root' }, exec)
  assert.equal(payload.ok, false)
  assert.equal(payload.elevated, 'root')
  assert.match(payload.hint, /elevation prompt/)
  assertPayloadValid(definition.output.schema, payload)
  const rendered = definition.output.render({ action: 'exec', command: 'apt update' }, payload)[0].text
  assert.match(rendered, /elevated=root/)
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
  // The declared call budget has to sit **above** the longest wait this plugin can
  // have on either of its clocks — the capped command deadline, or the capped
  // transfer deadline plus the stat pre-check that runs before a copy — plus the
  // kill grace and the pipe drain. An equality (or anything smaller) would let
  // `guard/timeout-policy` win the race and replace the plugin's own classified
  // answer with its generic `TOOL_TIMEOUT` sentence, which is exactly the
  // collision the shipped 300s/300s pair used to have.
  const bounds = defaultBounds()
  assert.ok(definition.timeoutMs > bounds.maxTimeoutMs + bounds.graceMs + DRAIN_MS)
  const longestTransfer = bounds.statTimeoutMs + bounds.maxTransferTimeoutMs
  assert.ok(definition.timeoutMs > longestTransfer + bounds.graceMs + DRAIN_MS)
  const expected = Math.max(bounds.maxTimeoutMs, longestTransfer) + bounds.graceMs + DRAIN_MS + 5_000
  assert.equal(definition.timeoutMs, expected)
})

test('only the reads are declared concurrency-safe, and the description says so too', () => {
  const { definition } = toolHarness(fakeOps())
  const safe = definition.isConcurrencySafe
  assert.ok(safe, 'the classifier must be declared, not left to the exclusive default')
  for (const args of [{ action: 'get_connection' }, { action: 'read', path: '/x' }]) {
    assert.equal(safe(args), true, JSON.stringify(args))
  }
  // Every mutating action — and anything the classifier cannot read — stays
  // exclusive. The transport could run them at once; the remote filesystem
  // cannot promise what happens when two do.
  for (const args of [
    { action: 'exec', command: 'ls' },
    { action: 'write', path: '/x', content: 'c' },
    { action: 'edit', path: '/x', oldText: 'a', newText: 'b' },
    { action: 'upload', path: '/x', localPath: '/y' },
    { action: 'download', path: '/x', localPath: '/y' },
    { action: 'teleport' },
    {},
    null
  ]) {
    assert.equal(safe(args), false, JSON.stringify(args))
  }
  // The sentence the model reads matches the classifier: reads may parallelize,
  // changes run one at a time — no more promising what the declaration refuses.
  const text = describeRemote([{ label: 'Proxy', host: '10.0.0.9' }])
  assert.match(text, /Several `get_connection` or `read` calls may run at once/)
  assert.match(text, /everything that changes something runs one at a time/)
  assert.doesNotMatch(text, /which is why several can run at once/)
})

test('an edit dry run renders as a preview and validates against its branch', () => {
  const { definition } = toolHarness(fakeOps())
  const payload = {
    action: 'edit',
    ok: true,
    status: 'succeeded',
    target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' },
    path: '/srv/x',
    type: 'file',
    dryRun: true,
    replaced: 1,
    bytesBefore: 17,
    bytesAfter: 17,
    diff: ' one\n-two\n+TWO\n five',
    hint: 'Dry run: nothing was written and no backup was taken.'
  }
  assertPayloadValid(definition.output.schema, payload)
  const lines = definition.output.render({ action: 'edit', path: '/srv/x' }, payload)
  const text = lines.map(entry => entry.text).join('\n')
  assert.match(text, /edit \/srv\/x \(dry run\)/)
  assert.match(text, /would replace 1 place, 17 -> 17 bytes/)
  assert.match(text, /\| -two/)
  assert.ok(!text.includes('backup:')) // a preview takes none
})

test('every action keeps its schema honest when a producer forgets a field', () => {
  // A payload dropping the required ok must be rejected whole, the way the
  // registry rejects one when the call settles.
  const { definition } = toolHarness(fakeOps())
  assert.ok(validateJsonSchemaValue(definition.output.schema, { action: 'read', status: 'succeeded', path: '/x', target: { id: 'i', label: 'l', host: 'h' } }).length > 0)
})

test('a promoted exec renders as a hand-over, not as a failure, and validates', async () => {
  const ops = fakeOps()
  ops.runCommand = async () => ({
    run: {
      status: 'promoted',
      at: new Date().toISOString(),
      durationMs: 30_000,
      jobId: 'ssh-j7',
      stdout: 'make: Entering directory\n',
      timeoutMs: 30_000,
      outputBytes: 65_536,
      message: 'The command is still running on the server: it outlived the 30000 ms this call was willing to wait. The text below is only how far it had got by then.',
      hint: 'Read the whole stream with `job_output` (job ssh-j7) — it starts from the beginning — and stop it with `job_kill`.'
    },
    connection: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' },
    connections: []
  })
  const { definition, exec } = toolHarness(ops)
  const payload = await definition.execute({ action: 'exec', command: 'make world' }, exec)
  // ok:true is the load-bearing part: a handed-over command is not a failed call,
  // and a model that reads it as one would start the build again from nothing.
  assert.equal(payload.ok, true)
  assert.equal(payload.status, 'promoted')
  assert.equal(payload.jobId, 'ssh-j7')
  assertPayloadValid(definition.output.schema, payload)
  const rendered = definition.output.render({ action: 'exec', command: 'make world' }, payload)[0].text
  assert.match(rendered, /Still running past this call's deadline, so it was left going as job ssh-j7/)
  assert.match(rendered, /job_output/)
  assert.match(rendered, /status=promoted/)
  // A hand-over is not a clipped stream: no truncation sentence, and no claim about
  // a spill file that was never in play.
  assert.doesNotMatch(rendered, /no spill file configured/)
  // A cap that moved a number the model asked for is stated in the text the model
  // reads, not only in the structured fields.
  const capped = await (async () => {
    const ops2 = fakeOps()
    ops2.runCommand = async () => ({
      run: { status: 'succeeded', at: new Date().toISOString(), exitCode: 0, stdout: 'ok\n', durationMs: 31_000, timeoutMs: 300_000, outputBytes: 65_536, notes: ['command timeout asked for 900000 and was capped to 300000'] },
      connection: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' },
      connections: []
    })
    const harness = toolHarness(ops2)
    const body = await harness.definition.execute({ action: 'exec', command: 'sleep 1' }, harness.exec)
    return harness.definition.output.render({ action: 'exec', command: 'sleep 1' }, body)[0].text
  })()
  assert.match(capped, /\[command timeout asked for 900000 and was capped to 300000\]/)
})

// ── ⑤ the edit assembly wired to the real ops, on a server that keeps score ─
// The 0.0.32 defect, in one sentence: the parameter schema declared `dryRun`,
// the model sent it, and the edit case quietly never handed it to ops — so the
// "preview" really wrote the file and left a `.dsh-bak` behind. The `fakeOps`
// above cannot catch that class of bug: it answers from its own copy of the
// params either way, and a field the executor forgot to set looks identical to
// a field nobody sent. These tests run the shipped `execute` against the real
// `ops.editRemote` on a fake transport that plays the server — the file's
// contents, the backup, and the write count are assertable facts — and capture
// the params at the tool-to-ops seam, where the boolean was being dropped.
function remoteEditHarness (initial, path = '/srv/x') {
  const { runner, state } = fakeRunner()
  const store = fakeStore({ records: [record()] })
  const server = { files: new Map([[path, initial]]), writes: 0, backups: [] }
  const at = () => new Date().toISOString()
  state.nextRun = (command, options) => {
    if (command.startsWith('if [ ! -f')) {
      return server.files.has(path)
        ? { status: 'succeeded', at: at(), exitCode: 0, stdout: server.files.get(path), stderr: '', durationMs: 2 }
        : { status: 'exit-nonzero', at: at(), exitCode: 20, stdout: '', stderr: '', durationMs: 1 }
    }
    // The real write round trip is an optional `cp -p` chained to an in-place
    // `cat >`; playing both is what lets a test check the promise instead of
    // trusting it.
    if (command.includes('cp -p')) server.backups.push({ backupPath: `${path}.dsh-bak`, content: server.files.get(path) })
    if (command.includes('cat >')) {
      server.writes += 1
      server.files.set(path, options.stdin ?? '')
    }
    return { status: 'succeeded', at: at(), exitCode: 0, stdout: '', stderr: '', durationMs: 3 }
  }
  const real = createOps({
    runner,
    store: async () => store,
    secrets: () => fakeSecrets({ password: true, passphrase: false }),
    askpass: () => ({ ready: true, path: '/tmp/h/askpass.sh' }),
    onInventoryChanged: () => {}
  })
  const seen = []
  const ops = {
    ...real,
    async editRemote (params, signal) {
      seen.push(params)
      return real.editRemote(params, signal)
    }
  }
  const { definition, exec } = toolHarness(ops)
  return { definition, exec, seen, server, state, path }
}

test('edit dryRun reaches ops through the executor and previews without touching the server', async () => {
  const h = remoteEditHarness('one\nbeta two\n')
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA', dryRun: true }, h.exec)
  // ① The seam that was broken: ops must receive the flag the model sent.
  assert.equal(h.seen.length, 1)
  assert.equal(h.seen[0].dryRun, true, 'the executor must forward dryRun to ops')
  // ② The ops preview branch ran: a preview result with the diff, registry-valid.
  assert.equal(payload.ok, true)
  assert.equal(payload.dryRun, true)
  assert.match(payload.diff, /-beta/)
  assert.match(payload.diff, /\+BETA/)
  assert.equal(payload.backup, undefined)
  assertPayloadValid(h.definition.output.schema, payload)
  // ③ And the server says the preview was real: no write child, no backup file,
  // the bytes exactly as they were, and only the one read the check needed.
  assert.equal(h.server.writes, 0)
  assert.deepEqual(h.server.backups, [])
  assert.equal(h.server.files.get(h.path), 'one\nbeta two\n')
  assert.equal(h.state.calls.filter(c => c.kind === 'run').length, 1)
  // The reader-facing text names the preview too.
  const rendered = h.definition.output.render({ action: 'edit', path: h.path }, payload)[0].text
  assert.match(rendered, /\(dry run\)/)
  assert.match(rendered, /would replace/)
})

test('an ambiguous dry run refuses at the match check, before any write, like the real edit would', async () => {
  const h = remoteEditHarness('beta\nbeta')
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA', dryRun: true }, h.exec)
  assert.equal(payload.ok, false)
  assert.equal(payload.matches, 2)
  assert.equal(payload.dryRun, undefined) // a refusal is not a preview result
  assertPayloadValid(h.definition.output.schema, payload)
  assert.equal(h.server.writes, 0)
  assert.deepEqual(h.server.backups, [])
})

test('an edit without dryRun still writes through and keeps its backup', async () => {
  const h = remoteEditHarness('one\nbeta two\n')
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA' }, h.exec)
  assert.equal(h.seen[0].dryRun, undefined) // absent means write, the old default
  assert.equal(payload.dryRun, undefined)
  assert.equal(payload.ok, true)
  assert.equal(payload.backup, `${h.path}.dsh-bak`)
  assertPayloadValid(h.definition.output.schema, payload)
  assert.equal(h.server.writes, 1)
  assert.equal(h.server.files.get(h.path), 'one\nBETA two\n')
  assert.deepEqual(h.server.backups, [{ backupPath: `${h.path}.dsh-bak`, content: 'one\nbeta two\n' }])
})

test('dryRun false is a real edit, exactly like dryRun absent', async () => {
  const h = remoteEditHarness('alpha\nbeta\ngamma')
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA', dryRun: false }, h.exec)
  assert.equal(h.seen[0].dryRun, undefined) // an explicit false never enters the preview branch
  assert.equal(payload.dryRun, undefined)
  assert.equal(payload.ok, true)
  assertPayloadValid(h.definition.output.schema, payload)
  assert.equal(h.server.writes, 1)
  assert.equal(h.server.files.get(h.path), 'alpha\nBETA\ngamma')
  assert.equal(h.server.backups.length, 1) // the default backup stands
})

test('backup false, all, and replaceFirst ride the same path unbroken', async () => {
  // The three edit booleans that worked before must keep working after: a fix
  // that added dryRun by rebuilding the assembly would regress exactly here.
  const noBackup = remoteEditHarness('abc')
  const skipped = await noBackup.definition.execute({ action: 'edit', path: noBackup.path, oldText: 'b', newText: 'z', backup: false }, noBackup.exec)
  assert.equal(noBackup.seen[0].backup, false)
  assert.equal(noBackup.seen[0].dryRun, undefined)
  assert.equal(skipped.backup, undefined)
  assert.equal(noBackup.server.backups.length, 0)
  assert.equal(noBackup.server.writes, 1)
  assert.equal(noBackup.server.files.get(noBackup.path), 'azc')
  const many = remoteEditHarness('x x x')
  const every = await many.definition.execute({ action: 'edit', path: many.path, oldText: 'x', newText: 'y', all: true }, many.exec)
  assert.equal(many.seen[0].all, true)
  assert.equal(every.replaced, 3)
  assert.equal(many.server.files.get(many.path), 'y y y')
  const once = remoteEditHarness('x x x')
  const first = await once.definition.execute({ action: 'edit', path: once.path, oldText: 'x', newText: 'y', replaceFirst: true }, once.exec)
  assert.equal(once.seen[0].replaceFirst, true)
  assert.equal(first.replaced, 1)
  assert.equal(once.server.files.get(once.path), 'y x x')
})

test('readArgs maps dryRun like every other field the interface declares', () => {
  assert.equal(readArgs({ name: 'ssh_client', arguments: { action: 'edit', dryRun: true } }).dryRun, true)
  assert.equal(readArgs({ name: 'ssh_client', arguments: { action: 'edit', dryRun: false } }).dryRun, false)
  assert.equal(readArgs({ name: 'ssh_client', arguments: { action: 'edit', dryRun: 'yes' } }).dryRun, undefined) // a string is not a boolean
})
