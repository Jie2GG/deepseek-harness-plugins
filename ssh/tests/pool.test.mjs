// The connection pool's ledger: what a shared connection is named by, who may
// join one, which master gets retired when another server wants in, and what is
// closed when the plugin unmounts. No network, no ssh: the exiter is recorded.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { MuxPool, NO_SHARE_FLAGS, SOCKET_PATH_LIMIT } from '../lib/pool.js'
import { CONTROL_PERSIST_SECONDS, MAX_LIVE_MASTERS } from '../lib/storage.js'

/** The simplest credential shape: a key, no secret to fingerprint. */
const KEY = { mode: 'key' }

/** One stored target, with the id the pool keys by. */
const targetOf = (over = {}) => ({ host: '10.0.0.9', user: 'deploy', port: 22022, id: 'ssh-a1b2c3d4e5', ...over })

/**
 * A prepared pool plus the exits it asks for.
 * @returns the pool and the log its exiter wrote.
 */
async function ready () {
  const pool = new MuxPool()
  const exited = []
  pool.attach(async (socketPath, authority) => { exited.push({ socketPath, authority }) })
  await pool.prepare()
  return { pool, exited }
}

/** The control path one ticket carries. */
function pathOf (ticket) {
  const flag = ticket.flags.find(entry => entry.startsWith('ControlPath='))
  return flag === undefined ? undefined : flag.slice('ControlPath='.length)
}

test('a prepared pool hands out a socket inside its own private directory', async () => {
  const { pool } = await ready()
  const ticket = pool.claim(targetOf(), KEY)
  const path = pathOf(ticket)
  assert.equal(ticket.pooled, true)
  assert.ok(ticket.flags.includes('ControlMaster=auto'))
  assert.ok(ticket.flags.includes(`ControlPersist=${String(CONTROL_PERSIST_SECONDS)}`))
  assert.ok(pool.directory !== undefined && path !== undefined && path.startsWith(pool.directory))
  assert.equal(existsSync(pool.directory ?? ''), true)
  assert.ok(path.length <= SOCKET_PATH_LIMIT, `a control socket name has to fit sun_path: ${String(path.length)}`)
  assert.ok(path.includes('ssh-a1b2c3d4e5')) // the id is in the name, so an edit cannot inherit
  assert.match(path, /-[0-9a-f]{10}\.sock$/)
  await pool.dispose()
})

test('the same target and credential share one socket name, and any change moves it', async () => {
  const { pool } = await ready()
  const first = pathOf(pool.claim(targetOf(), KEY))
  assert.equal(pathOf(pool.claim(targetOf(), KEY)), first)
  for (const change of [
    { port: 22 },
    { user: 'root' },
    { identityFile: '/home/deploy/.ssh/id_ed25519' },
    { proxyJump: 'bastion' },
    { extraArgs: ['-4'] },
    { id: 'ssh-b2c3d4e5f6' }
  ]) {
    assert.notEqual(pathOf(pool.claim(targetOf(change), KEY)), first, `${JSON.stringify(change)} must not reuse the master`)
  }
  // A second password is a second connection: a draft probed with a typed secret
  // must not ride a master that authenticated with the stored one and report the
  // wrong secret as good.
  assert.notEqual(pathOf(pool.claim(targetOf(), { mode: 'password', password: 'hunter2' })), first)
  assert.notEqual(pathOf(pool.claim(targetOf(), { mode: 'password', password: 'hunter3' })), first)
  assert.equal(
    pathOf(pool.claim(targetOf(), { mode: 'password', password: 'hunter2' })),
    pathOf(pool.claim(targetOf(), { mode: 'password', password: 'hunter2' }))
  )
  // The secret is never in the name; a hand-edited file cannot read it back out.
  assert.ok(!String(first).includes('hunter'))
  await pool.dispose()
})

test('a target that declined to share, and a pool with no directory, both get the none flags', async () => {
  const { pool } = await ready()
  const off = pool.claim(targetOf({ pool: 'off' }), KEY)
  assert.deepEqual([...off.flags], [...NO_SHARE_FLAGS])
  assert.equal(off.pooled, false)
  assert.equal(off.note, undefined) // the reader chose this; nothing to explain

  const cold = new MuxPool()
  assert.equal(cold.ready, false)
  const before = cold.claim(targetOf(), KEY)
  assert.deepEqual([...before.flags], [...NO_SHARE_FLAGS])
  assert.match(before.note ?? '', /pool: /) // an accident deserves a reason
  await pool.dispose()
})

test('every master in use means the newcomer dials alone, and says why', async () => {
  const { pool, exited } = await ready()
  for (let index = 0; index < MAX_LIVE_MASTERS; index += 1) {
    // markLive without release: eight proven masters, all still in flight.
    pool.claim(targetOf({ id: `ssh-000000000${String(index)}` }), KEY).markLive()
  }
  assert.equal(pool.liveMasters, MAX_LIVE_MASTERS)
  const ninth = pool.claim(targetOf({ id: 'ssh-0000000009' }), KEY)
  assert.equal(ninth.pooled, false)
  assert.deepEqual([...ninth.flags], [...NO_SHARE_FLAGS])
  assert.match(ninth.note ?? '', new RegExp(`${String(MAX_LIVE_MASTERS)} masters`))
  assert.deepEqual(exited, []) // nothing idle to evict, so nobody is disturbed
  await pool.dispose()
})

test('the ninth server retires the idle master that has been quiet longest', async () => {
  const { pool, exited } = await ready()
  const paths = []
  for (let index = 0; index < MAX_LIVE_MASTERS; index += 1) {
    const ticket = pool.claim(targetOf({ id: `ssh-000000000${String(index)}` }), KEY)
    paths.push(pathOf(ticket))
    ticket.markLive()
    ticket.release()
  }
  assert.equal(pool.liveMasters, MAX_LIVE_MASTERS)
  const ninth = pool.claim(targetOf({ id: 'ssh-0000000009' }), KEY)
  assert.equal(ninth.pooled, true)
  assert.deepEqual(exited.map(entry => entry.socketPath), [paths[0]])
  assert.equal(exited[0].authority, 'deploy@10.0.0.9')
  assert.equal(pool.liveMasters, MAX_LIVE_MASTERS) // one out, one in
  await pool.dispose()
})

test('a dial that never proved a master gives its slot straight back', async () => {
  const { pool } = await ready()
  const slots = []
  for (let index = 0; index < MAX_LIVE_MASTERS + 1; index += 1) {
    const ticket = pool.claim(targetOf({ id: `ssh-000000000${String(index)}` }), KEY)
    ticket.release() // the child failed before it could authenticate
    slots.push(ticket.pooled)
  }
  assert.deepEqual(slots, Array(MAX_LIVE_MASTERS + 1).fill(true))
  assert.equal(pool.liveMasters, 0)
  await pool.dispose()
})

test('a dropped master is closed, not merely forgotten', async () => {
  const { pool, exited } = await ready()
  const ticket = pool.claim(targetOf(), KEY)
  const path = pathOf(ticket)
  ticket.markLive()
  ticket.drop()
  assert.equal(pool.liveMasters, 0)
  assert.deepEqual(exited.map(entry => entry.socketPath), [path])
  // Dropping twice does not send a second goodbye.
  ticket.drop()
  assert.equal(exited.length, 1)
  await pool.dispose()
})

test('a lease whose master was already evicted says nothing about a stranger', async () => {
  const { pool, exited } = await ready()
  const held = []
  for (let index = 0; index < MAX_LIVE_MASTERS; index += 1) {
    const ticket = pool.claim(targetOf({ id: `ssh-000000000${String(index)}` }), KEY)
    ticket.markLive()
    ticket.release()
    held.push(ticket)
  }
  pool.claim(targetOf({ id: 'ssh-0000000009' }), KEY) // evicts held[0]
  const evicted = held[0]
  evicted.markLive() // the evicted call finishes after the newcomer arrived
  evicted.release()
  assert.equal(exited.length, 1)
  await pool.dispose()
})

test('dispose closes every proven master and removes the socket directory', async () => {
  const { pool, exited } = await ready()
  const directory = pool.directory
  const proven = pool.claim(targetOf({ id: 'ssh-000000000a' }), KEY)
  const unproven = pool.claim(targetOf({ id: 'ssh-000000000b' }), KEY)
  proven.markLive()
  await pool.dispose()
  assert.deepEqual(exited.map(entry => entry.socketPath), [pathOf(proven)])
  assert.equal(existsSync(directory ?? ''), false)
  assert.equal(pool.ready, false)
  assert.equal(pool.liveMasters, 0)
  // A call still finishing when the plugin unmounts must not throw on its way out.
  proven.release()
  unproven.release()
})

test('the pool reports why it could not prepare, instead of failing the call', async () => {
  const pool = new MuxPool()
  assert.equal(pool.failure, undefined)
  assert.equal(pool.ready, false)
  const ticket = pool.claim(targetOf(), KEY)
  assert.deepEqual([...ticket.flags], [...NO_SHARE_FLAGS])
  assert.equal(typeof ticket.note, 'string')
  await pool.dispose() // disposing an unprepared pool is legal
})

// ── expiry: ControlPersist closes masters; the ledger has to notice ────────
test('a master past ControlPersist with no socket leaves the ledger, and a live one survives the sweep', async () => {
  let now = 1_770_000_000_000
  const pool = new MuxPool(() => now)
  const exited = []
  pool.attach(async (socketPath, authority) => { exited.push({ socketPath, authority }) })
  await pool.prepare()
  const ticket = pool.claim(targetOf(), KEY)
  const path = pathOf(ticket)
  ticket.markLive()
  ticket.release() // a finished call: the master stands, the lease does not
  assert.equal(pool.liveMasters, 1)
  // Idle but inside the persist window: nothing moves.
  now += (CONTROL_PERSIST_SECONDS - 5) * 1000
  assert.equal(pool.liveMasters, 1)
  // Past it, with no socket on disk: the master closed itself, and so does the
  // belief — silently, because there is nobody left to send `-O exit` to.
  now += 10_000
  assert.equal(pool.sweep(), 1)
  assert.equal(pool.liveMasters, 0)
  assert.deepEqual(exited, [])
  // A master whose socket is still answering stays counted across the sweep's
  // re-check window, and only leaves when the socket actually goes.
  const second = pool.claim(targetOf(), KEY)
  second.markLive()
  second.release()
  writeFileSync(pathOf(second), '') // a live master's socket
  now += (CONTROL_PERSIST_SECONDS + 60) * 1000
  assert.equal(pool.liveMasters, 1) // stated once, kept
  unlinkSync(pathOf(second))
  now += 1_000 // inside the 30 s re-stat window: the kept belief stands
  assert.equal(pool.liveMasters, 1)
  now += 31_000 // the window passes, the socket is gone: off the count
  assert.equal(pool.liveMasters, 0)
  await pool.dispose()
})

test('an expired ledger does not evict the live master a full ceiling would', async () => {
  let now = 1_770_000_000_000
  const pool = new MuxPool(() => now)
  const exited = []
  pool.attach(async (socketPath, authority) => { exited.push({ socketPath, authority }) })
  await pool.prepare()
  const tickets = []
  for (let i = 0; i < MAX_LIVE_MASTERS; i += 1) {
    const ticket = pool.claim(targetOf({ id: `ssh-old${String(i)}000000` }), KEY)
    ticket.markLive()
    ticket.release() // past calls finished; only the masters would remain
    tickets.push(ticket)
  }
  assert.equal(pool.liveMasters, MAX_LIVE_MASTERS)
  // Every one of those masters has expired and its socket is gone; a ninth call
  // must not retire any of them with an `-O exit` — it should simply find the
  // ledger empty and dial into a free slot.
  now += (CONTROL_PERSIST_SECONDS + 120) * 1000
  const ninth = pool.claim(targetOf({ id: 'ssh-new0000000' }), KEY)
  assert.equal(ninth.pooled, true)
  assert.deepEqual(exited, [])
  assert.equal(pool.liveMasters, 1)
  await pool.dispose()
})

test('an in-flight master is never swept, expired-looking or not', async () => {
  let now = 1_770_000_000_000
  const pool = new MuxPool(() => now)
  await pool.prepare()
  const held = pool.claim(targetOf(), KEY)
  held.markLive() // leased and still running: inFlight > 0 until release
  now += (CONTROL_PERSIST_SECONDS + 60) * 1000
  assert.equal(pool.sweep(), 0)
  assert.equal(pool.liveMasters, 1)
  // Released, past persist, no socket: now it can go. The release re-stamps the
  // idle clock, so the persist window starts from the release, not the claim.
  held.release()
  now += (CONTROL_PERSIST_SECONDS + 60) * 1000
  assert.equal(pool.sweep(), 1)
  await pool.dispose()
})
