// The agent-facing surface: policy gate, target resolution, defensive argument
// reading, the model-visible wording, and every payload against the registry's
// own schema validator.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

/** The digest this plugin would expect for a body, used to speak the server's side of the protocol. */
const sha256Hex = (text) => createHash('sha256').update(text ?? '', 'utf8').digest('hex')
import { DRAIN_MS } from '../lib/transport.js'
import { createOps } from '../lib/ops.js'
import { transferCallCeiling } from '../lib/transfer.js'
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
test('the parameter text tells the model what each ceiling actually governs', () => {
  // These sentences are the contract for a model that has never read the README:
  // a ceiling described as an output limit, when it is also the transfer limit, is
  // how an agent ends up asking for a 4 MiB copy of a 32 MiB file and being
  // surprised by the refusal.
  const { definition } = toolHarness(fakeOps())
  const params = definition.parameters.properties
  assert.match(params.maxBytes.description, /For `exec` and `read`/)
  assert.match(params.maxBytes.description, /For `upload` and `download`/)
  assert.match(params.maxBytes.description, /enforced against the bytes as they move/)
  assert.match(params.maxBytes.description, /what the server enumerated before the copy started/)
  assert.match(params.timeoutMs.description, /For `exec`, `upload`, and `download`/)
  // Measured on a live server: an upload that ran out at each of its remote children
  // answered 3.65 s after a 1.5 s call. The text has to say what the number bounds —
  // one remote child — because "the whole budget, pre-check and publish included"
  // was a promise the copy itself did not keep.
  assert.match(params.timeoutMs.description, /per remote child/)
  assert.match(params.timeoutMs.description, /not one shared clock for the whole call/)
  assert.doesNotMatch(params.timeoutMs.description, /pre-check and publish included/)
  // `~/` is offered in the path description, and 0.0.34 is the round it expanded.
  assert.match(params.path.description, /starting with `~\/`/)
})

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
  // …and the refusal has to read as a missing channel, not as a human's no. The
  // core quotes whatever reason this gate hands it and appends nothing, so a
  // deployment with no approval service would otherwise show the very sentence it
  // would have shown a person — which is how the live check found it looking.
  assert.match(deafOut.reason, /^Run on deploy@10\.0\.0\.9: reboot now — refused because/u)
  assert.match(deafOut.reason, /refused because this conversation cannot be asked/u)
  assert.match(deafOut.reason, /no approval service/u)
  assert.match(deafOut.reason, /Nothing was run/u)
  // An answerable ask keeps the short sentence: the person reading it is deciding,
  // not debugging the deployment.
  const answerable = { ...deps, approvalPolicyOf: () => 'ask' }
  const asked = await gateRemoteCall(answerable, { name: 'ssh_client', arguments: { action: 'exec', command: 'reboot now' } }, pass)
  assert.equal(asked.kind, 'ask')
  assert.equal(asked.reason.includes('cannot be asked'), false)
  assert.deepEqual(Object.keys(asked).sort(), ['displayReason', 'kind', 'reason'])
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
function recordingOps () {
  const ops = fakeOps()
  const seen = []
  const wrapped = {
    ...ops,
    async upload (params, signal) { seen.push(['upload', params, signal]); return ops.upload(params, signal) },
    async download (params, signal) { seen.push(['download', params, signal]); return ops.download(params, signal) },
    async readPath (params, signal) { seen.push(['readPath', params, signal]); return ops.readPath(params, signal) },
  }
  return { ops: wrapped, seen }
}

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
          effective: { maxOutputBytes: 65536, remoteTimeoutMs: 30000, maxTransferBytes: 33554432, probeTimeoutMs: 30000, statTimeoutMs: 10000, maxSpillBytes: 67108864, graceMs: 2000, maxConcurrentTransfers: 2, maxRunningJobs: 8, maxTransferFiles: 500, maxTransferTotalBytes: 536870912, transferTimeoutMs: 300000 },
          notes: []
        },
        // The live lane counts, which is how a reader of this call learns that a
        // copy was turned away for want of a slot rather than for want of size.
        pool: { ready: true, liveMasters: 1, transfers: 2 },
        probing: 3
      }
    },
    async runCommand (params, signal) {
      this.seen.push(['runCommand', params])
      this.signals.push(['runCommand', signal])
      return { run: { status: 'succeeded', at: 'x', exitCode: 0, stdout: 'ok\n', stderr: '', durationMs: 12 }, connection: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' } }
    },
    async execBackground (params) {
      this.seen.push(['execBackground', params])
      if (params.command === 'full lane') {
        // The shape `ops.execBackground` answers with when the job ceiling is
        // already reached: refused in the frame, with no id to poll.
        return { action: 'exec', ok: false, status: 'refused', target: { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }, command: params.command, message: 'At most 8 background jobs may run at once, and all 8 slots are taken.', hint: 'Stop one with `job_kill`, wait for one to settle, or raise the ceiling in the plugin\u2019s configuration.', connections: [] }
      }
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

test('a refused background call reaches the model refused, with no id to poll', async () => {
  const { definition } = toolHarness(fakeOps())
  const payload = await definition.execute({ action: 'exec', command: 'full lane', background: true }, { agent: { id: 's1' } })
  assertPayloadValid(definition.output.schema, payload)
  assert.equal(payload.ok, false)
  assert.equal(payload.status, 'refused')
  assert.equal(payload.jobId, undefined, 'the frame carries no job that does not exist')
  const rendered = definition.output.render({ action: 'exec', command: 'full lane', background: true }, payload).map(line => line.text).join('\\n')
  assert.match(rendered, /At most 8 background jobs/)
  assert.match(rendered, /status=refused/)
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

test('a transfer call forwards its own deadline, not just the ceiling', async () => {
  // The 0.0.32 `dryRun` hole, in the same place: a parameter that is declared,
  // read by the body, and never handed to the operation. A copy's deadline is the
  // one number its caller is most likely to want to shorten — a stalled or
  // unwritable landing path should cost the call, not five minutes.
  const { ops, seen } = recordingOps()
  const { definition } = toolHarness(ops)
  await definition.execute({ action: 'download', path: '/srv/x', localPath: '/ws/x', timeoutMs: 5_000, maxBytes: 4_096 }, { agent: { id: 's1' } })
  const download = seen.find(entry => entry[0] === 'download')
  assert.equal(download[1].timeoutMs, 5_000, 'the copy ran on the deadline the call asked for')
  assert.equal(download[1].maxBytes, 4_096)
  await definition.execute({ action: 'upload', path: '/srv/x', localPath: '/ws/x', timeoutMs: 60_000 }, { agent: { id: 's1' } })
  const upload = seen.find(entry => entry[0] === 'upload')
  assert.equal(upload[1].timeoutMs, 60_000)
  // A call that says nothing about the deadline still gets the configured default,
  // which is what `ops` resolves — the tool only forwards what was asked.
  await definition.execute({ action: 'read', path: '/srv/x' }, { agent: { id: 's1' } })
  const read = seen.find(entry => entry[0] === 'readPath')
  assert.equal(read[1].timeoutMs, undefined)
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
  // The transfer side is quoted from the same helper the tool builds its budget
  // from: pre-check, channel, publish, and the cleanup a stopped copy asks the
  // server for. An inline sum here is how the two drifted apart last time.
  const transferPath = transferCallCeiling({
    statTimeoutMs: bounds.statTimeoutMs,
    transferTimeoutMs: bounds.maxTransferTimeoutMs,
    graceMs: bounds.graceMs,
  })
  assert.ok(transferPath > bounds.statTimeoutMs + bounds.maxTransferTimeoutMs)
  const expected = Math.max(bounds.maxTimeoutMs, transferPath) + bounds.graceMs + DRAIN_MS + 5_000
  assert.equal(definition.timeoutMs, expected)
  // And the promise the budget makes to the model stays honest at the cap: the
  // longest copy this plugin will wait for fits inside the call it declared.
  assert.ok(definition.timeoutMs > transferPath, 'the declared budget must outlast the longest transfer call')
})

test('a transfer result tells the model which ceiling answered, in the transcript', async () => {
  const { definition } = toolHarness(fakeOps())
  const target = { id: 'ssh-a1b2c3d4e5', label: 'Proxy', host: '10.0.0.9' }
  const stopped = {
    action: 'download',
    ok: false,
    status: 'refused-size',
    target,
    localPath: '/ws/x',
    remotePath: '/srv/x',
    bytes: 4096,
    bytesLimit: 4096,
    timeoutMs: 300_000,
    limitMode: 'in-flight',
    message: "/srv/x crossed the 4096 byte ceiling while it was being carried: 4096 bytes had arrived, and the file measured 10 bytes when the copy started — it grew while it ran. The destination was left as it was.",
    notes: ['A recursive copy is bounded before it moves, not while it does.'],
    durationMs: 120
  }
  assertPayloadValid(definition.output.schema, stopped)
  const rendered = definition.output.render({ action: 'download', path: '/srv/x', localPath: '/ws/x' }, stopped)
  const text = rendered.map(line => line.text).join('\n')
  // The transcript is what the model reads. A ceiling it cannot see is a ceiling
  // it will argue with, and a note that only lives in the payload is invisible.
  assert.match(text, /crossed the 4096 byte ceiling while it was being carried/)
  assert.match(text, /it grew while it ran/)
  assert.match(text, /\[A recursive copy is bounded before it moves, not while it does\.\]/)
  const tree = {
    action: 'upload',
    ok: true,
    status: 'moved',
    target,
    localPath: '/ws/dir',
    remotePath: '/srv/dir',
    bytes: 6,
    files: 2,
    recursive: true,
    limitMode: 'pre-check',
    bytesLimit: 33_554_432,
    timeoutMs: 300_000,
    durationMs: 30
  }
  assertPayloadValid(definition.output.schema, tree)
  const treeText = definition.output.render({ action: 'upload', path: '/srv/dir', localPath: '/ws/dir', recursive: true }, tree).map(line => line.text).join('\n')
  assert.match(treeText, /6 bytes \(directory\)/)
})

test('get_connection carries the transfer lane, in the payload and in the sentence', async () => {
  const { definition } = toolHarness(fakeOps())
  const payload = await definition.execute({ action: 'get_connection' }, { agent: { id: 's1' } })
  assertPayloadValid(definition.output.schema, payload)
  assert.equal(payload.transfers, 2)
  assert.match(payload.message, /file copies at once 2, 2 running now/)
  // A ceiling the reader cannot see being used is a ceiling they only meet as a
  // refusal, so the standing numbers travel with the standing limits.
  const rendered = definition.output.render({ action: 'get_connection' }, payload).map(line => line.text).join('\n')
  assert.match(rendered, /2 running now/)
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
/**
 * A fake that plays a remote file through the three children one guarded edit
 * runs: the read that also states a version, the write that copies, replaces and
 * re-checks in one shell, and the repair child that puts the previous content
 * back. The knobs are the failures the acceptance list asks about — a file that
 * changed under the read, a body that stopped arriving, a copy that could not be
 * made, a repair that itself failed — and every one of them is answered the way
 * the real command answers it, by an exit code this plugin maps to a sentence.
 */
function remoteEditHarness (initial, path = '/srv/x', knobs = {}) {
  const { runner, state } = fakeRunner()
  const store = fakeStore({ records: [record()] })
  const bytes = (text) => Buffer.byteLength(text ?? '', 'utf8')
  const server = {
    files: new Map([[path, initial]]),
    versions: new Map([[path, `7|${bytes(initial)}|2026-01-01 00:00:00.000000000 +0800`]]),
    writes: 0,
    backups: [],
    commands: [],
    /** Change the file the way another process would, without the guard seeing it. */
    touch (next) {
      server.files.set(path, next)
      const [, , mtime] = (server.versions.get(path) ?? '').split('|')
      server.versions.set(path, `7|${bytes(next)}|${knobs.staleMtime ?? '2026-01-01 00:00:01.000000000 +0800'}`)
      void mtime
    }
  }
  const at = () => new Date().toISOString()
  const answer = (exitCode, over = {}) => ({ status: exitCode === 0 ? 'succeeded' : 'exit-nonzero', at: at(), exitCode, stdout: '', stderr: '', durationMs: 2, ...over })
  const marker = (verdict, evidence, at, sha) => `ssh-plugin: ${verdict} ${evidence} ${String(at)} ${sha ?? '-'}`
  state.nextRun = (command, options) => {
    server.commands.push({ command, stdin: options.stdin })
    const gone = !server.files.has(path)
    const noTool = knobs.noSha === true
    // Which of the three children is asking, told apart by what only that one says:
    // the read prints the digest marker, the write both copies and replaces, and the
    // repair opens by counting the bytes it is about to overwrite.
    if (command.includes("printf 'ssh-plugin-sha256:")) {
      // The read: a version token, the digest of the bytes it is about to hand over,
      // then the body — or the file is gone, which is exit 20.
      if (gone) return answer(20)
      const version = knobs.noVersion === true ? '' : server.versions.get(path)
      const file = server.files.get(path) ?? ''
      return answer(0, { stdout: `ssh-plugin: ${version ?? ''}\nssh-plugin-sha256: ${noTool ? '' : sha256Hex(file)}\n${file}` })
    }
    if (command.includes('cp -p --') && command.includes('cat >')) {
      if (gone) return answer(20)
      // A writer outside this call, landing in the window between the read and the
      // write: the guard exists to notice exactly this.
      if (knobs.changedBeforeWrite !== undefined) {
        server.files.set(path, knobs.changedBeforeWrite)
        const stampVersion = `9|${bytes(knobs.changedBeforeWrite)}|2026-01-01 00:00:01.500000000 +0800`
        server.versions.set(path, stampVersion)
      }
      const before = server.files.get(path) ?? ''
      const pre = noTool ? null : sha256Hex(before)
      const preLine = `ssh-plugin: pre ${pre ?? '-'}`
      // 1. the version guard, then the content guard, in the order the shell runs them
      const wanted = /2>\/dev\/null\)" != '([^']*)'/u.exec(command)?.[1]
      if (wanted !== undefined && wanted !== (server.versions.get(path) ?? '')) {
        return answer(21, { stderr: 'ssh-plugin: the file changed after it was read' })
      }
      const promised = /\[ "\$pre" != '([0-9a-f]{64})' \]/u.exec(command)?.[1]
      if (pre !== null && promised !== undefined && promised !== pre) {
        // A same-length rewrite the version token could not see, stopped before the
        // copy was made and before the file was truncated.
        return answer(21, { stderr: 'ssh-plugin: the content changed after it was read' })
      }
      // 2. the safety copy, which must succeed before anything is written
      if (knobs.failCopy === true) return answer(22, { stdout: preLine, stderr: 'cp: cannot create regular file: No space left' })
      const backupArg = /cp -p -- '[^']*' ('[^']*)'/u.exec(command)?.[1] ?? "'/srv/x.dsh-bak'"
      const backupPath = backupArg.replaceAll(/^'|'$/gu, '')
      server.backups.push({ backupPath, content: before, sha: pre })
      server.pre = pre
      if (knobs.copyTampered !== undefined && server.backups.length > 0) {
        // Something else wrote over the safety copy between the copy and the repair.
        const taken = server.backups.at(-1)
        taken.content = String(knobs.copyTampered)
        taken.sha = noTool ? null : sha256Hex(String(knobs.copyTampered))
      }
      // 3. the body, through the file's own inode
      const body = options.stdin ?? ''
      // The length and the digest this write has to leave behind are both stated in
      // the command, so the fake reads its own marching orders rather than being
      // told the answer by the test.
      const expectedBytes = Number(/if \[ "\$size" != (\d+) \]/u.exec(command)?.[1] ?? bytes(body))
      const expectedSha = /\[ "\$now" != '([0-9a-f]{64})' \]/u.exec(command)?.[1]
      if (knobs.lostAnswer === true) {
        // The bytes all arrived and the server was done with them; only the exit
        // status failed to come home. Restoring here would undo a finished edit.
        server.writes += 1
        server.files.set(path, body)
        server.versions.set(path, `7|${bytes(body)}|2026-01-01 00:00:02.000000000 +0800`)
        return answer(23, { stdout: preLine })
      }
      if (knobs.childDied === true) {
        server.files.set(path, body.slice(0, Math.floor(body.length / 2)))
        server.writes += 1
        return answer(23, { stdout: preLine, stderr: 'ssh: kex_exchange_identification: Connection closed by remote host' })
      }
      const landed = typeof knobs.collision === 'string'
        ? knobs.collision
        : knobs.shortWrite === true
          ? body.slice(0, Math.max(0, body.length - 3))
          : body
      server.writes += 1
      server.files.set(path, landed)
      server.versions.set(path, `7|${bytes(landed)}|2026-01-01 00:00:02.000000000 +0800`)
      // 4. the length check, and only then the digest check
      if (bytes(landed) !== expectedBytes) return answer(24, { stdout: preLine })
      if (noTool) return answer(29, { stdout: `${preLine}\nssh-plugin: ok sizeonly ${bytes(landed)}` })
      if (expectedSha !== undefined && expectedSha !== sha256Hex(landed)) {
        return answer(28, { stdout: `${preLine}\nssh-plugin: mismatch ${bytes(landed)} ${sha256Hex(landed)}` })
      }
      // 5. the snapshot goes away when the reader never asked for a backup, and only
      // on this path: a write the digest could not vouch for keeps it.
      if (command.includes('rm -f --')) server.backups = server.backups.filter(entry => entry.backupPath !== backupPath)
      return answer(0, { stdout: `${preLine}\nssh-plugin: ok digest ${sha256Hex(landed)}` })
    }
    if (command.startsWith('size=$(wc -c')) {
      // The repair child: it digests the file before it touches anything, then says
      // which of the outcomes turned out to be true, and on what evidence. The
      // markers are part of the contract `ops.ts` writes its sentences from, so the
      // fake answers by re-measuring its own state the way the shell would.
      const file = server.files.get(path) ?? ''
      const atBytes = bytes(file)
      const now = noTool ? null : sha256Hex(file)
      const expected = /\[ "\$now" = '([0-9a-f]{64})' \]; then echo "ssh-plugin: landed digest/u.exec(command)?.[1]
      const intended = Number(/\[ "\$size" = (\d+) \]; then echo "ssh-plugin: landed sizeonly/u.exec(command)?.[1])
      const original = Number(/\[ "\$size" = (\d+) \]; then echo "ssh-plugin: intact sizeonly/u.exec(command)?.[1])
      const known = /\[ "\$bak" = '([0-9a-f]{64})' \]/u.exec(command)?.[1]
      if (now !== null && expected !== undefined && now === expected) return answer(27, { stdout: `${marker('landed', 'digest', atBytes, now)}\n` })
      if (now === null && atBytes === intended) return answer(27, { stdout: `${marker('landed', 'sizeonly', atBytes)}\n` })
      const backup = server.backups.at(-1)
      if (backup === undefined) {
        // Nothing to put back: either the file never changed, or it is somebody
        // else's now and this call cannot say which.
        if (now !== null && (server.pre === null || server.pre === undefined || now === server.pre)) {
          return answer(0, { stdout: `${marker('intact', 'digest', atBytes, now)}\n` })
        }
        if (now === null) {
          return atBytes === original
            ? answer(0, { stdout: `${marker('intact', 'sizeonly', atBytes)}\n` })
            : answer(25, { stdout: `${marker('unrecoverable', 'sizeonly', atBytes)}\n` })
        }
        return answer(25, { stdout: `${marker('unrecoverable', 'digest', atBytes, now)}\n` })
      }
      if (knobs.failRestore === true) {
        return answer(25, {
          stdout: `${marker('unrecoverable', noTool ? 'sizeonly' : 'digest', atBytes, now)}\n`,
          stderr: 'cp: /dev/sda: Read-only file system',
        })
      }
      server.files.set(path, backup.content)
      const back = bytes(backup.content)
      const bak = noTool ? null : sha256Hex(backup.content)
      if (bak !== null) {
        if (known === undefined || bak === known) {
          if (command.includes('rm -f --')) server.backups = server.backups.filter(entry => entry.backupPath !== backup.backupPath)
          return answer(0, { stdout: `${marker('restored', 'digest', back, bak)}\n` })
        }
        return answer(26, { stdout: `${marker('partial', 'digest', back, bak)}\n` })
      }
      if (atBytes === original) {
        if (command.includes('rm -f --')) server.backups = server.backups.filter(entry => entry.backupPath !== backup.backupPath)
        return answer(0, { stdout: `${marker('restored', 'sizeonly', back)}\n` })
      }
      return answer(26, { stdout: `${marker('partial', 'sizeonly', back)}\n` })
    }
    return answer(0)
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
  if (process.env.DEBUG_EDIT !== undefined) console.error('payload', JSON.stringify(payload), 'commands', JSON.stringify(h.server.commands.map(c => c.command.slice(0, 40))))
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
  assert.deepEqual(
    h.server.backups.map(({ backupPath, content }) => ({ backupPath, content })),
    [{ backupPath: `${h.path}.dsh-bak`, content: 'one\nbeta two\n' }],
  )
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

// ── the guarded write: what happens when the edit does not go quietly ───────
test('an edit that finds the file changed under its read stops before writing anything', async () => {
  const initial = 'one\nbeta two\n'
  const h = remoteEditHarness(initial, '/srv/x', { changedBeforeWrite: 'someone else here\n' })
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA' }, h.exec)
  assert.equal(payload.ok, false)
  assert.equal(payload.stale, true)
  assert.equal(payload.versionChecked, true)
  assert.match(payload.message, /changed on 10\.0\.0\.9 between reading it and editing it/)
  assert.match(payload.hint, /Read the file again/)
  assertPayloadValid(h.definition.output.schema, payload)
  // The other writer's bytes stand untouched: the guard ran in the same shell that
  // would have truncated the file, before the copy and before the write.
  assert.equal(h.server.files.get(h.path), 'someone else here\n')
  assert.equal(h.server.writes, 0)
  assert.deepEqual(h.server.backups, [])
})

test('a write that dies half way leaves the file exactly as it was, and says so', async () => {
  const initial = 'one\nbeta two\n'
  const h = remoteEditHarness(initial, '/srv/x', { childDied: true })
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'A MUCH LONGER REPLACEMENT' }, h.exec)
  assert.equal(payload.ok, false)
  assert.equal(payload.restored, true)
  assert.equal(payload.backup, '/srv/x.dsh-bak')
  assert.match(payload.message, /the write child ended|kex_exchange_identification/)
  assert.match(payload.message, /previous content was put back/)
  // The point of the exercise: the server holds the original bytes, not half a
  // replacement, and not a truncated file the reader has to discover later.
  assert.equal(h.server.files.get(h.path), initial)
  assert.equal(h.server.writes, 1, 'one write child ran before the repair')
  assertPayloadValid(h.definition.output.schema, payload)
})

test('a write that arrives short is caught by the byte check and repaired', async () => {
  const initial = 'one\nbeta two\n'
  const h = remoteEditHarness(initial, '/srv/x', { shortWrite: true })
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA' }, h.exec)
  assert.equal(payload.ok, false)
  assert.equal(payload.restored, true)
  assert.equal(h.server.files.get(h.path), initial)
})

test('a write whose answer was lost is not undone, because the bytes did arrive', async () => {
  const h = remoteEditHarness('one\nbeta two\n', '/srv/x', { lostAnswer: true })
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA' }, h.exec)
  assert.equal(payload.ok, false)
  assert.equal(payload.restored, undefined)
  assert.match(payload.message, /the change is on the server/)
  // Restoring a completed edit would be its own kind of damage: the repair child
  // looks at the size first, and this is that promise being kept.
  assert.equal(h.server.files.get(h.path), 'one\nBETA two\n')
  assertPayloadValid(h.definition.output.schema, payload)
})

test('an edit that cannot make its safety copy never touches the file', async () => {
  const initial = 'one\nbeta two\n'
  const h = remoteEditHarness(initial, '/srv/x', { failCopy: true })
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA' }, h.exec)
  assert.equal(payload.ok, false)
  assert.equal(payload.backup, undefined)
  assert.match(payload.message, /could not make its safety copy/)
  assert.match(payload.hint, /Free space/)
  assert.equal(h.server.writes, 0)
  assert.equal(h.server.files.get(h.path), initial)
  assert.deepEqual(h.server.backups, [])
})

test('a failed repair says where the previous content is instead of claiming success', async () => {
  const initial = 'one\nbeta two\n'
  const h = remoteEditHarness(initial, '/srv/x', { childDied: true, failRestore: true })
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA' }, h.exec)
  assert.equal(payload.ok, false)
  assert.equal(payload.restored, false)
  assert.equal(payload.backup, '/srv/x.dsh-bak')
  assert.match(payload.message, /could not be put back where it started/)
  assert.match(payload.message, /holds \d+ bytes, digest [0-9a-f]{64}; the content this call read was 13 bytes/)
  assert.equal(payload.verdict, 'unrecoverable')
  assert.match(payload.hint, /Read \/srv\/x\.dsh-bak to recover the previous content by hand/)
  assertPayloadValid(h.definition.output.schema, payload)
})

test('a server that cannot state a checksum is refused before writing, and keeps its file', async () => {
  // K-1 at the product seam: the capability is read from the server, and a server
  // that cannot state a SHA-256 never sees a byte of the file moved. The refusal is
  // not "written but unverified" anymore — it is "not written at all".
  const initial = 'one\nbeta two\n'
  const h = remoteEditHarness(initial, '/srv/x', { noSha: true })
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA' }, h.exec)
  assert.equal(payload.ok, false)
  assert.equal(payload.contentVerified, false)
  assert.equal(payload.verdict, undefined, 'nothing was written, so there is no write verdict')
  assert.equal(payload.sha256, undefined)
  assert.equal(payload.backup, undefined, 'no copy was taken — the refusal came before the copy step')
  assert.equal(payload.dryRun, undefined, 'a refusal to write is not a preview')
  assert.match(payload.message, /not written/)
  assert.match(payload.message, /file is unchanged/)
  assert.match(payload.hint, /sha256sum, shasum, or openssl/)
  assertPayloadValid(h.definition.output.schema, payload)
  const rendered = h.definition.output.render({ action: 'edit', path: h.path }, payload)[0].text
  assert.match(rendered, /not written/)
  // The proof the task asks for: the server\'s file is byte-for-byte what it was, and
  // no truncating write and no safety copy were ever attempted.
  assert.equal(h.server.files.get(h.path), initial, 'the remote file did not change')
  assert.equal(h.server.writes, 0, 'no body was pushed through the channel')
  assert.deepEqual(h.server.backups, [], 'and no copy was left behind')
  assert.ok(!h.server.commands.some(entry => entry.command.includes('cp -p')), 'the copy child never ran')
  assert.ok(!h.server.commands.some(entry => entry.command.includes('cat >')), 'the write child never ran')
})

test('a same-length body of different bytes is refused at the tool layer, and the file comes back', async () => {
  // The case the byte check could never see: 13 bytes went down, and they are not
  // the 13 bytes this edit composed.
  const initial = 'one\nbeta two\n'
  const h = remoteEditHarness(initial, '/srv/x', { collision: 'one\nBETx two\n' })
  assert.equal(Buffer.byteLength('one\nBETx two\n'), Buffer.byteLength('one\nBETA two\n'))
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA' }, h.exec)
  assert.equal(payload.ok, false)
  assert.equal(payload.verdict, 'restored')
  assert.equal(payload.restored, true)
  assert.equal(payload.contentVerified, true)
  assert.equal(payload.sha256, sha256Hex(initial))
  assert.match(payload.message, /previous content was put back/)
  assertPayloadValid(h.definition.output.schema, payload)
  assert.equal(h.server.files.get(h.path), initial)
  const commands = h.server.commands.map(entry => entry.command)
  assert.ok(commands.some(command => command.startsWith('size=$(wc -c')), 'the repair child ran')
})

test('an edit with backup off still copies the file first, and cleans the copy up after', async () => {
  const initial = 'one\nbeta two\n'
  const h = remoteEditHarness(initial, '/srv/x')
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA', backup: false }, h.exec)
  assert.equal(payload.ok, true)
  assert.equal(payload.backup, undefined)
  assert.equal(h.server.writes, 1)
  // The snapshot existed long enough to be the undo, then went away with the
  // success: the reader asked for no backup and got none left on their server.
  assert.deepEqual(h.server.backups, [])
  const write = h.server.commands.find(entry => entry.command.includes('cat >'))
  assert.match(write.command, /cp -p -- '\/srv\/x' '\/srv\/x\.dsh-snap-/)
  assert.match(write.command, /rm -f -- '\/srv\/x\.dsh-snap-/)
  assert.equal(h.server.files.get(h.path), 'one\nBETA two\n')
})

test('a server that states no version still edits, and says the guard was off', async () => {
  const h = remoteEditHarness('one\nbeta two\n', '/srv/x', { noVersion: true })
  const payload = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA' }, h.exec)
  assert.equal(payload.ok, true)
  assert.equal(payload.versionChecked, false)
  const write = h.server.commands.find(entry => entry.command.includes('cat >'))
  // No comparison against a version token it never got — the stat guard is simply
  // absent. The digest guard, the copy and the size check are still there, which is
  // what makes the sentence honest.
  assert.equal(write.command.includes("stat -c '%i|%s|%y'"), false)
  assert.match(write.command, /cp -p --/)
  assert.match(write.command, /if \[ "\$size" != \d+ \]/u)
  // A preview on such a server warns the reader rather than implying a guard it
  // cannot offer.
  const preview = await h.definition.execute({ action: 'edit', path: h.path, oldText: 'BETA', newText: 'beta', dryRun: true }, h.exec)
  assert.equal(preview.versionChecked, false)
  const rendered = h.definition.output.render({ action: 'edit', path: h.path }, preview).map(line => line.text).join('\n')
  assert.match(rendered, /this server stated no file version/)
})

test('the guarded write replaces through the inode, never around it', async () => {
  const h = remoteEditHarness('one\nbeta two\n', '/srv/x')
  await h.definition.execute({ action: 'edit', path: h.path, oldText: 'beta', newText: 'BETA' }, h.exec)
  const write = h.server.commands.find(entry => entry.command.includes('cat >'))
  // The order the promise rests on: guard, copy, write, check, then cleanup.
  const order = [
    write.command.indexOf(')" != '),
    write.command.indexOf('cp -p --'),
    write.command.indexOf('cat >'),
    write.command.indexOf('$size" !='),
  ]
  assert.ok(order.every(at => at > 0), `every step must be present: ${JSON.stringify(order)}`)
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the steps must run in that order, in one child')
  assert.equal(write.command.includes('mv '), false, 'a rename would change the inode and break the links')
  assert.equal(write.command.includes('rm -rf'), false)
})

test('readArgs maps dryRun like every other field the interface declares', () => {
  assert.equal(readArgs({ name: 'ssh_client', arguments: { action: 'edit', dryRun: true } }).dryRun, true)
  assert.equal(readArgs({ name: 'ssh_client', arguments: { action: 'edit', dryRun: false } }).dryRun, false)
  assert.equal(readArgs({ name: 'ssh_client', arguments: { action: 'edit', dryRun: 'yes' } }).dryRun, undefined) // a string is not a boolean
})
