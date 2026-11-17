// The storage domain's schemas: every bound the settings page states, and the
// guards that keep a hand-edited file from smuggling a bad record in.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DOMAIN_NAME, DOMAIN_VERSION, COMPATIBLE_VERSIONS, MAX_CONNECTIONS, MAX_CONCURRENT_OPS,
  MAX_LIVE_MASTERS, CONTROL_PERSIST_SECONDS, poolChoiceSchema,
  MAX_ALLOWED_COMMANDS, DEFAULT_SETTINGS,
  SSH_EXECUTABLE, SSH_FALLBACK_PATHS,
  connectionRecordSchema, connectionInputSchema, settingsRecordSchema, remotePathSchema,
  remoteRunSchema, transferInputSchema, secretPatchSchema, probeDraftSchema,
  sessionTargetInputSchema, probeOutcomeSchema, sshTargetsDomain
} from '../lib/storage.js'

const base = {
  id: 'ssh-a1b2c3d4e5',
  label: 'Proxy',
  host: '10.0.0.9',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

test('the domain declares its version ladder and tables', () => {
  assert.equal(DOMAIN_NAME, 'ssh_targets')
  assert.equal(DOMAIN_VERSION, 6)
  assert.deepEqual([...COMPATIBLE_VERSIONS], [1, 2, 3, 4, 5])
  assert.deepEqual(Object.keys(sshTargetsDomain.tables).sort(), ['connections', 'sessions'])
})

test('a stored record fills the safe defaults for the agent fields', () => {
  const out = connectionRecordSchema.parse(base)
  assert.equal(out.auth, 'key')
  assert.equal(out.agentAccess, 'on')
  // Version 4 wrote no `pool` at all; sharing is what it meant, and what it gets.
  assert.equal(out.pool, 'on')
  assert.deepEqual([...out.allowedCommands], [])
})

test('identity fields are strict about shape, and strict really means strict', () => {
  assert.throws(() => connectionRecordSchema.parse({ ...base, id: 'proxy-1' })) // ids are ssh-<10 hex>
  assert.throws(() => connectionRecordSchema.parse({ ...base, host: 'a host' }))
  assert.throws(() => connectionRecordSchema.parse({ ...base, host: '-oProxy' }))
  assert.throws(() => connectionRecordSchema.parse({ ...base, host: 'user=host' }))
  assert.throws(() => connectionRecordSchema.parse({ ...base, host: '~/alias' }))
  assert.throws(() => connectionRecordSchema.parse({ ...base, port: 0 }))
  assert.throws(() => connectionRecordSchema.parse({ ...base, port: 65_536 }))
  assert.throws(() => connectionRecordSchema.parse({ ...base, label: 'x'.repeat(65) }))
  assert.throws(() => connectionRecordSchema.parse({ ...base, oops: 1 }))
  assert.throws(() => connectionRecordSchema.parse({ ...base, extraArgs: ['verbose'] })) // every entry starts with -
  assert.equal(connectionRecordSchema.parse({ ...base, extraArgs: ['-4', '-oConnectTimeout=5'] }).extraArgs.length, 2)
  assert.throws(() => connectionRecordSchema.parse({ ...base, allowedCommands: ['./git'] })) // bare names only
  assert.throws(() => connectionRecordSchema.parse({ ...base, allowedCommands: Array(33).fill('git') }))
  assert.throws(() => connectionRecordSchema.parse({ ...base, allowedCommands: ['g'.repeat(65)] }))
  assert.equal(MAX_ALLOWED_COMMANDS, 32)
})

test('a page input may carry an id or clear an override with null, and never key+password', () => {
  const input = { label: 'P', host: 'h' }
  assert.equal(connectionInputSchema.parse({ ...input, id: base.id }).id, base.id)
  assert.equal(connectionInputSchema.parse({ ...input, remoteTimeoutMs: null }).remoteTimeoutMs, null)
  assert.throws(() => connectionInputSchema.parse({ ...input, auth: 'key+password' }))
  // Stored-only fields are not the page's to write: the input schema is strict too.
  assert.throws(() => connectionInputSchema.parse(base))
  assert.equal(probeOutcomeSchema.parse({ at: '2026-01-01T00:00:00.000Z', status: 'reachable' }).status, 'reachable')
  assert.throws(() => probeOutcomeSchema.parse({ at: '2026-01-01T00:00:00.000Z', status: 'sort-of' }))
})

test('settings hold overrides, and every one of them may be absent', () => {
  // 0.0.24 moved the default and the cap into the plugin's config, so the stored
  // slot is no longer the whole answer: an absent key means "follow configuration".
  assert.deepEqual(DEFAULT_SETTINGS, {})
  assert.deepEqual(settingsRecordSchema.parse({}), {})
  assert.equal(settingsRecordSchema.parse({ remoteTimeoutMs: 900_000 }).remoteTimeoutMs, 900_000) // over the old max, and still storable
  assert.equal(settingsRecordSchema.parse({ maxOutputBytes: 1023 }).maxOutputBytes, 1023) // no floor but a positive one
  assert.throws(() => settingsRecordSchema.parse({ remoteTimeoutMs: 0 }))
  assert.throws(() => settingsRecordSchema.parse({ maxOutputBytes: -1 }))
  assert.throws(() => settingsRecordSchema.parse({ oops: 1 }))
  assert.equal(MAX_CONNECTIONS, 64)
  // The lane count is no longer "probes": it counts every remote operation, page
  // and conversation alike, because sharing moved the connection ceiling elsewhere.
  assert.equal(MAX_CONCURRENT_OPS, 16)
  assert.equal(MAX_LIVE_MASTERS, 8)
  assert.equal(CONTROL_PERSIST_SECONDS, 300)
})

test('sharing is a per-target choice the page may state either way', () => {
  assert.equal(connectionRecordSchema.parse({ ...base, pool: 'off' }).pool, 'off')
  assert.throws(() => connectionRecordSchema.parse({ ...base, pool: 'sometimes' }))
  assert.throws(() => connectionRecordSchema.parse({ ...base, pool: true }))
  // The page sends the field only when the loaded Host has a pool to receive it.
  const input = { label: 'P', host: 'h' }
  assert.equal(connectionInputSchema.parse(input).pool, undefined)
  assert.equal(connectionInputSchema.parse({ ...input, pool: 'off' }).pool, 'off')
  // An unsaved form probes with the same switch it would save with.
  assert.equal(probeDraftSchema.parse({ host: 'h', pool: 'off' }).pool, 'off')
  assert.equal(poolChoiceSchema.parse('on'), 'on')
})

test('a pre-0.0.18 global slot still opens: the retired fields are accepted, ignored, ranged', () => {
  const legacy = settingsRecordSchema.parse({
    command: '/opt/openssh-portable/bin/ssh',
    probeTimeoutMs: 45_000,
    maxOutputBytes: 65_536,
    remoteTimeoutMs: 30_000,
    maxTransferBytes: 33_554_432
  })
  assert.equal(legacy.command, '/opt/openssh-portable/bin/ssh') // present but read by no one
  assert.equal(legacy.probeTimeoutMs, 45_000)
  // The old bounds still apply to the old keys, so a hand-mangled value is
  // still a storage-error rather than a silently ignored one.
  assert.throws(() => settingsRecordSchema.parse({ command: 'x'.repeat(257) }))
  assert.throws(() => settingsRecordSchema.parse({ probeTimeoutMs: 999 }))
  // The values the plugin now uses are configuration, not stored config — since
  // 0.0.24 the probe and the pre-check deadlines live in the plugin's own config
  // (`probeTimeoutMs` / `statTimeoutMs`, two budgets so retuning one cannot triple
  // the other), which `bounds.test.mjs` pins.
  assert.equal(SSH_EXECUTABLE, 'ssh')
  assert.ok(SSH_FALLBACK_PATHS.includes('/usr/bin/ssh'))
})

test('remote paths are absolute or ~/, and never carry shell punctuation', () => {
  for (const good of ['/etc/hosts', '~/notes.md', '/data/a b/c']) assert.equal(remotePathSchema.parse(good), good)
  for (const bad of ['notes.md', '/etc/hosts;rm', '/a$(id)', '/a`b', '/a{b,c}', '/a\\b', '/a\nb', 'x'.repeat(4097)]) {
    assert.throws(() => remotePathSchema.parse(bad), null, JSON.stringify(bad))
  }
})

test('a remote command line has a length bound, no NUL, and a bounded stdin', () => {
  assert.equal(remoteRunSchema.parse({ command: 'uptime' }).command, 'uptime')
  assert.throws(() => remoteRunSchema.parse({ command: '  ' }))
  assert.throws(() => remoteRunSchema.parse({ command: 'x'.repeat(8193) }))
  assert.throws(() => remoteRunSchema.parse({ command: 'a\0b' }))
  assert.equal(remoteRunSchema.parse({ command: 'cat', input: 'y'.repeat(1_000_000) }).input.length, 1_000_000)
  assert.throws(() => remoteRunSchema.parse({ command: 'cat', input: 'y'.repeat(1_000_001) }))
  assert.throws(() => remoteRunSchema.parse({ command: 'x', sessionId: 's', stray: 1 }))
})

test('elevation fields: sudo wants a bare account name, and one mechanism per call', () => {
  assert.equal(remoteRunSchema.parse({ command: 'id', as: 'postgres' }).as, 'postgres')
  assert.equal(remoteRunSchema.parse({ command: 'id', su: true }).su, true)
  assert.throws(() => remoteRunSchema.parse({ command: 'id', as: 'Postgres' })) // POSIX names are lowercase
  assert.throws(() => remoteRunSchema.parse({ command: 'id', as: 'a b' }))
  assert.throws(() => remoteRunSchema.parse({ command: 'id', as: '$(id)' })) // not one for the shell either
  assert.throws(() => remoteRunSchema.parse({ command: 'id', as: 'root', su: true })) // alternatives, pinned to su
  // The root password rides the save patch, with the same tri-state as the others.
  assert.equal(secretPatchSchema.parse({ root: 'pw' }).root, 'pw')
  assert.equal(secretPatchSchema.parse({ root: null }).root, null)
  assert.throws(() => secretPatchSchema.parse({ root: '' }))
  // A draft probe still speaks only login and passphrase: root is stored, never transient.
  assert.throws(() => draftSecretSchema.parse({ root: 'pw' }))
})

test('transfer and session inputs demand what they need; secrets are never blank', () => {
  assert.throws(() => transferInputSchema.parse({ path: '/x' })) // localPath required
  // A tiny ceiling is storable now: 0.0.24 dropped the two-sided range, so a value
  // above the cap is capped at use and a small positive one is simply what the
  // caller asked for.
  assert.equal(transferInputSchema.parse({ path: '/x', localPath: '/y', maxBytes: 1023 }).maxBytes, 1023)
  assert.throws(() => transferInputSchema.parse({ path: '/x', localPath: 'a', maxBytes: 0 }))
  assert.throws(() => sessionTargetInputSchema.parse({ sessionId: '' }))
  assert.equal(sessionTargetInputSchema.parse({ sessionId: 's' }).targetId, undefined)
  assert.throws(() => secretPatchSchema.parse({ password: '' })) // empty is absent, not blank
  assert.equal(secretPatchSchema.parse({ password: null }).password, null)
  assert.equal(secretPatchSchema.parse({ passphrase: 'p'.repeat(4096) }).passphrase.length, 4096)
  assert.throws(() => probeDraftSchema.parse({ host: 'h', label: 'no' })) // a draft has no label to save
})
