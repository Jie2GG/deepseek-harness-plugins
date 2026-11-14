// The storage domain's schemas: every bound the settings page states, and the
// guards that keep a hand-edited file from smuggling a bad record in.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DOMAIN_NAME, DOMAIN_VERSION, COMPATIBLE_VERSIONS, MAX_CONNECTIONS, MAX_CONCURRENT_PROBES,
  MAX_ALLOWED_COMMANDS, BACKGROUND_DEADLINE_MS, DEFAULT_SETTINGS,
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
  assert.equal(DOMAIN_VERSION, 3)
  assert.deepEqual([...COMPATIBLE_VERSIONS], [1, 2])
  assert.deepEqual(Object.keys(sshTargetsDomain.tables).sort(), ['connections', 'sessions'])
})

test('a stored record fills the safe defaults for the agent fields', () => {
  const out = connectionRecordSchema.parse(base)
  assert.equal(out.auth, 'key')
  assert.equal(out.agentAccess, 'on')
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

test('settings land on their defaults and every bound is enforced', () => {
  const out = settingsRecordSchema.parse({})
  assert.deepEqual(out, DEFAULT_SETTINGS)
  assert.throws(() => settingsRecordSchema.parse({ command: 'my ssh' })) // whitespace in an executable name
  assert.equal(settingsRecordSchema.parse({ command: '/usr/bin/ssh' }).command, '/usr/bin/ssh')
  assert.equal(settingsRecordSchema.parse({ command: 'ssh-ng' }).command, 'ssh-ng')
  assert.throws(() => settingsRecordSchema.parse({ probeTimeoutMs: 999 }))
  assert.throws(() => settingsRecordSchema.parse({ probeTimeoutMs: 120_001 }))
  assert.throws(() => settingsRecordSchema.parse({ remoteTimeoutMs: 300_001 }))
  assert.throws(() => settingsRecordSchema.parse({ maxOutputBytes: 1023 }))
  assert.throws(() => settingsRecordSchema.parse({ maxOutputBytes: 4_194_305 }))
  assert.equal(settingsRecordSchema.parse({ maxTransferBytes: 536_870_912 }).maxTransferBytes, 536_870_912)
  assert.equal(BACKGROUND_DEADLINE_MS, 1_800_000)
  assert.equal(MAX_CONNECTIONS, 64)
  assert.equal(MAX_CONCURRENT_PROBES, 4)
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

test('transfer and session inputs demand what they need; secrets are never blank', () => {
  assert.throws(() => transferInputSchema.parse({ path: '/x' })) // localPath required
  assert.throws(() => transferInputSchema.parse({ path: '/x', localPath: 'a', maxBytes: 1023 }))
  assert.throws(() => sessionTargetInputSchema.parse({ sessionId: '' }))
  assert.equal(sessionTargetInputSchema.parse({ sessionId: 's' }).targetId, undefined)
  assert.throws(() => secretPatchSchema.parse({ password: '' })) // empty is absent, not blank
  assert.equal(secretPatchSchema.parse({ password: null }).password, null)
  assert.equal(secretPatchSchema.parse({ passphrase: 'p'.repeat(4096) }).passphrase.length, 4096)
  assert.throws(() => probeDraftSchema.parse({ host: 'h', label: 'no' })) // a draft has no label to save
})
