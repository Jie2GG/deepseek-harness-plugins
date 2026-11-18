// Shared helpers for the offline suites. Plain node:test + the shipped
// lib/ artifacts: run `pnpm run build` first, then `pnpm test`.
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { SshError } from '../lib/types.js'

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
  const state = { calls: [], runQueue: [], probeOutcome: null, resolveOut: null, startRunOut: null, executeOut: null, optionsSeen: [], shares: [] }
  const runner = {
    inFlight: 0,
    // What the pool looks like from ops.ts: ready, and holding nothing.
    liveMasters: 0,
    transfersInFlight: 0,
    // The job ceiling, asked without taking a slot: `execBackground` consults this
    // before it registers anything with the fake registry.
    // The job ceiling, asked without taking anything: `execBackground` consults
    // this before it registers a job, so a test can stand in for a full set of
    // running jobs without owning a process table.
    laneRoom: (lane) => (typeof state.laneRoom === 'function' ? state.laneRoom(lane) : true),
    laneUsage: (kind) => (typeof state.laneUsage === 'function' ? state.laneUsage(kind) : 0),
    // The shape the real transport reports through its `spill` getter.
    spill: { used: 0, files: 0, refusals: 0, max: 0 },
    mux: { ready: true, failure: undefined, liveMasters: 0 },
    /** A lease that shares nothing but records that a call asked. */
    share (target, auth) {
      const ticket = {
        flags: [],
        note: undefined,
        pooled: false,
        released: 0,
        marked: 0,
        dropped: 0,
        release () { this.released += 1 },
        markLive () { this.marked += 1 },
        drop () { this.dropped += 1 }
      }
      state.shares.push({ target, auth, ticket })
      return ticket
    },
    unshare (ticket) { ticket?.release() },
    noteShared (ticket, worked) {
      if (ticket === undefined) return
      if (worked) ticket.markLive()
      else ticket.drop()
    },
    sessionBroken () { return false },
    dispose () {},
    async run (target, settings, auth, command, options = {}) {
      // The real transport leases around a call; so does the stand-in, so a test
      // can see what a call would have handed the pool.
      const ticket = runner.share(target, auth)
      state.calls.push({ kind: 'run', command, options, target, auth, settings, maxOutputBytes: options.maxOutputBytes })
      try {
        const canned = typeof state.nextRun === 'function' ? state.nextRun(command, options) : state.runQueue.shift()
        return canned ?? { status: 'succeeded', at: new Date().toISOString(), exitCode: 0, stdout: '', stderr: '', durationMs: 1 }
      } finally {
        runner.noteShared(ticket, true)
        runner.unshare(ticket)
      }
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
    async execute (program, argvTail, settings, env, timeoutMs, label, signal, lane) {
      state.calls.push({ kind: 'execute', program, argvTail, timeoutMs, label, signal, lane })
      // A stand-in that lets one test play scp: the impl sees the argv tail (so it
      // can write the destination the way a real copy would) and may return the
      // Collected shape itself; returning nothing falls back to `executeOut`.
      if (typeof state.executeImpl === 'function') {
        const fromImpl = state.executeImpl(argvTail)
        if (fromImpl !== undefined) return fromImpl
      }
      return state.executeOut ?? { outcome: 'exit', exitCode: 0, stdout: '', stderr: '', durationMs: 3, truncated: false }
    },
    /**
     * The single-file channel: a stand-in for the counted copy the real transport
     * drives with `cat` on the far end. `streamImpl` plays the wire — it is handed
     * the argv tail and the copy request, and it may write the sink file (a
     * download) or read it (an upload) and answer with the byte count and outcome
     * the copy would have produced.
     */
    async streamFile (program, argvTail, settings, env, deadlineMs, label, copy, signal, lane) {
      state.calls.push({ kind: 'streamFile', program, argvTail, settings, env, timeoutMs: deadlineMs, label, copy, signal, lane })
      // A stand-in for the lane ceiling: the transport throws, and this lets a
      // test prove the transfer layer turns that into an outcome.
      if (state.streamFail !== undefined) {
        const refusal = state.streamFail
        throw new SshError(refusal.code, refusal.message, { hint: refusal.hint })
      }
      if (typeof state.streamImpl === 'function') {
        const fromImpl = await state.streamImpl(argvTail, copy)
        if (fromImpl !== undefined) return fromImpl
      }
      return state.streamOut ?? { outcome: 'exit', exitCode: 0, bytes: 0, stdout: '', stderr: '', durationMs: 3 }
    },
    // The real transport joins `[user@]host` the same way; transfers ask it
    // instead of hand-rolling the join, so the stand-in answers too.
    authority (target) {
      return target.user === undefined || target.user === '' ? target.host : `${target.user}@${target.host}`
    },
    async resolveExecutable (name) {
      state.calls.push({ kind: 'resolveExecutable', name })
      return name === 'scp' ? '/usr/bin/scp' : '/usr/bin/ssh'
    },
    async resolveSsh () {
      state.calls.push({ kind: 'resolveSsh' })
      return '/usr/bin/ssh'
    },
    async resolveScp () {
      state.calls.push({ kind: 'resolveScp' })
      return '/usr/bin/scp'
    }
  }
  return { runner, state }
}

/** A small stand-in for TargetStore, with the methods ops.ts calls. */
export function fakeStore ({ records = [], settings, session = null } = {}) {
  const rows = new Map(records.map(row => [row.id, row]))
  const sessions = new Map(session === null ? [] : [[session.sessionId, session]])
  const defaults = {
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
    async create (input) { const record = { auth: 'key', agentAccess: 'on', allowedCommands: [], ...input, id: 'ssh-new0000001', createdAt: 'c', updatedAt: 'u' }; rows.set(record.id, record); store.calls.push(['create', input]); return record },
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
    pool: 'on',
    allowedCommands: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

export function fakeSecrets (status = { password: false, passphrase: false, root: false }, values = {}) {
  return {
    applied: [],
    async status () { return status },
    async read (id, kind) { return values[kind] },
    async apply (id, patch) { this.applied.push({ id, patch }) },
    async clearAll (id) { this.applied.push({ id, patch: { password: null, passphrase: null } }) }
  }
}
