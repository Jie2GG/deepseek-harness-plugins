// Shared helpers for the offline suites. Plain node:test + the shipped
// lib/ artifacts: run `pnpm run build` first, then `pnpm test`.
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

/** The oneOf branch whose action const/enum matches the payload. */
export function branchFor (schema, action) {
  const found = schema.oneOf.find(branch => {
    const spec = branch.properties?.action
    return spec?.const === action || (Array.isArray(spec?.enum) && spec.enum.includes(action))
  })
  if (found === undefined) throw new Error(`no output branch for action "${action}"`)
  return found
}

/** Assertable: the payload matches exactly the branch its action names. */
export function assertPayloadValid (schema, payload) {
  const errors = validateJsonSchemaValue(branchFor(schema, payload.action), payload)
  if (errors.length > 0) throw new Error(`payload rejected:\n  ${errors.join('\n  ')}`)
}

/** A recorded fake transport for ops: canned results, in call order or by command. */
export function fakeRunner () {
  const state = { calls: [], runQueue: [], probeOutcome: null, resolveOut: null, startRunOut: null, executeOut: null, optionsSeen: [] }
  const runner = {
    inFlight: 0,
    dispose () {},
    async run (target, settings, auth, command, options = {}) {
      state.calls.push({ kind: 'run', command, options, target, auth, maxOutputBytes: options.maxOutputBytes })
      const canned = typeof state.nextRun === 'function' ? state.nextRun(command, options) : state.runQueue.shift()
      return canned ?? { status: 'succeeded', at: new Date().toISOString(), exitCode: 0, stdout: '', stderr: '', durationMs: 1 }
    },
    async probe (target, settings, auth) {
      state.calls.push({ kind: 'probe', target, auth })
      return state.probeOutcome ?? { at: new Date().toISOString(), status: 'reachable', durationMs: 2 }
    },
    async resolve (target, _settings) {
      state.calls.push({ kind: 'resolve', target })
      return state.resolveOut ?? { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 2 }
    },
    async startRun (target, settings, auth, command, options = {}) {
      state.calls.push({ kind: 'startRun', command, options })
      return state.startRunOut
    },
    sshOptions (target, settings, auth, timeoutMs, extra = {}) {
      state.optionsSeen.push({ target, auth, timeoutMs, extra })
      return { flags: [...(extra.portFlag === '-P' ? ['-P', String(target.port ?? 22)] : []), `-o`, 'BatchMode=yes'], env: {}, needsSecret: false }
    },
    async execute (program, argvTail, settings, env, timeoutMs, label, _signal) {
      state.calls.push({ kind: 'execute', program, argvTail, timeoutMs, label })
      return state.executeOut ?? { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 3, truncated: false }
    },
    async resolveExecutable (name) {
      state.calls.push({ kind: 'resolveExecutable', name })
      return name === 'scp' ? '/usr/bin/scp' : '/usr/bin/ssh'
    }
  }
  return { runner, state }
}

/** A small stand-in for TargetStore, with the methods ops.ts calls. */
export function fakeStore ({ records = [], settings, session = null } = {}) {
  const rows = new Map(records.map(row => [row.id, row]))
  const sessions = new Map(session === null ? [] : [[session.sessionId, session]])
  const defaults = {
    command: 'ssh',
    probeTimeoutMs: 10_000,
    maxOutputBytes: 65_536,
    remoteTimeoutMs: 30_000,
    maxTransferBytes: 33_554_432
  }
  const store = {
    calls: [],
    list () { return [...rows.values()].sort((a, b) => a.label.localeCompare(b.label)) },
    get (id) { return rows.get(id) },
    settings () { return settings ?? defaults },
    async saveSettings (next) { store.calls.push(['saveSettings', next]); return next },
    async create (input) { const record = { ...input, id: 'ssh-new0000001', createdAt: 'c', updatedAt: 'u', auth: 'key', agentAccess: 'on', allowedCommands: [] }; rows.set(record.id, record); store.calls.push(['create', input]); return record },
    async edit (id, input) { const record = { ...rows.get(id), ...input, updatedAt: 'u2' }; rows.set(id, record); store.calls.push(['edit', id, input]); return record },
    async remove (id) { return rows.delete(id) },
    async recordProbe (id, outcome) { const row = rows.get(id); if (row === undefined) return undefined; rows.set(id, { ...row, lastProbe: outcome }); store.calls.push(['recordProbe', id, outcome]); return rows.get(id) },
    getSessionTarget (sessionId) { return sessions.get(sessionId) },
    async setSessionTarget (sessionId, targetId) { const row = { sessionId, targetId, setAt: 'x' }; sessions.set(sessionId, row); return row },
    async clearSessionTarget (sessionId) { return sessions.delete(sessionId) },
    async forgetSessionTargetsFor (targetId) { let n = 0; for (const [k, v] of sessions) { if (v.targetId === targetId) { sessions.delete(k); n += 1 } } return n },
    async close () {}
  }
  return store
}

/** One seeded stored target shaped like a ConnectionRecord. */
export function record (over = {}) {
  return {
    id: 'ssh-a1b2c3d4e5',
    label: 'Proxy',
    host: '10.0.0.9',
    user: 'deploy',
    port: 22022,
    auth: 'key',
    agentAccess: 'on',
    allowedCommands: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

export function fakeSecrets (status = { password: false, passphrase: false }, values = {}) {
  return {
    applied: [],
    async status () { return status },
    async read (id, kind) { return values[kind] },
    async apply (id, patch) { this.applied.push({ id, patch }) },
    async clearAll (id) { this.applied.push({ id, patch: { password: null, passphrase: null } }) }
  }
}
