// The bounds layer: the order the layers win in, what a cap does to a number above
// it, and what comes back so a reader can tell. This is the piece the settings page
// and every call hang off, so it is tested at its own seam, with no transport.
import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultBounds, resolveSettings, resolveDeadline, readBounds } from '../lib/bounds.js'
import { DEFAULTS, Config } from '../lib/config.js'
import { MAX_CONCURRENT_OPS, MAX_JOB_LANES, FOREGROUND_RESERVED_OPS } from '../lib/storage.js'

const VOLATILE = values => ({
  timeoutMs: { get: () => values.timeoutMs ?? DEFAULTS.timeoutMs },
  maxTimeoutMs: { get: () => values.maxTimeoutMs ?? DEFAULTS.maxTimeoutMs },
  outputBytes: { get: () => values.outputBytes ?? DEFAULTS.outputBytes },
  maxOutputBytes: { get: () => values.maxOutputBytes ?? DEFAULTS.maxOutputBytes },
  maxSpillBytes: { get: () => values.maxSpillBytes ?? DEFAULTS.maxSpillBytes },
  transferBytes: { get: () => values.transferBytes ?? DEFAULTS.transferBytes },
  maxTransferBytes: { get: () => values.maxTransferBytes ?? DEFAULTS.maxTransferBytes },
  transferTimeoutMs: { get: () => values.transferTimeoutMs ?? DEFAULTS.transferTimeoutMs },
  maxTransferTimeoutMs: { get: () => values.maxTransferTimeoutMs ?? DEFAULTS.maxTransferTimeoutMs },
  maxTransferFiles: { get: () => values.maxTransferFiles ?? DEFAULTS.maxTransferFiles },
  maxTransferTotalBytes: { get: () => values.maxTransferTotalBytes ?? DEFAULTS.maxTransferTotalBytes },
  maxConcurrentTransfers: { get: () => values.maxConcurrentTransfers ?? DEFAULTS.maxConcurrentTransfers },
  maxRunningJobs: { get: () => values.maxRunningJobs ?? DEFAULTS.maxRunningJobs },
  probeTimeoutMs: { get: () => values.probeTimeoutMs ?? DEFAULTS.probeTimeoutMs },
  statTimeoutMs: { get: () => values.statTimeoutMs ?? DEFAULTS.statTimeoutMs },
  promoteOnTimeout: { get: () => values.promoteOnTimeout ?? DEFAULTS.promoteOnTimeout },
  graceMs: { get: () => values.graceMs ?? DEFAULTS.graceMs }
})

test('the published defaults are the defaults, and every cap sits at or above its default', () => {
  const bounds = defaultBounds()
  assert.deepEqual(
    { timeoutMs: bounds.timeoutMs, maxTimeoutMs: bounds.maxTimeoutMs },
    { timeoutMs: DEFAULTS.timeoutMs, maxTimeoutMs: DEFAULTS.maxTimeoutMs }
  )
  assert.ok(bounds.maxTimeoutMs >= bounds.timeoutMs)
  assert.ok(bounds.maxOutputBytes >= bounds.outputBytes)
  assert.ok(bounds.maxTransferBytes >= bounds.transferBytes)
  // Two budgets on purpose: the download's size pre-check must not inherit a
  // connectivity test's patience.
  assert.ok(bounds.probeTimeoutMs !== bounds.statTimeoutMs)
  assert.equal(bounds.notes.length, 0)
})

test('a configuration whose cap sits below its default is corrected out loud', () => {
  const bounds = readBounds(VOLATILE({ timeoutMs: 120_000, maxTimeoutMs: 60_000 }))
  assert.equal(bounds.maxTimeoutMs, 120_000) // raised, not silently obeyed
  assert.equal(bounds.notes.length, 1)
  assert.match(bounds.notes[0], /cap 60000 is below the default 120000/)
})

test('layers win in this order: call, target, profile, configured default', () => {
  const bounds = defaultBounds()
  assert.equal(resolveSettings(bounds, { stored: { remoteTimeoutMs: 45_000 } }).settings.remoteTimeoutMs, 45_000)
  assert.equal(resolveSettings(bounds, { stored: { remoteTimeoutMs: 45_000 }, target: { remoteTimeoutMs: 20_000 } }).settings.remoteTimeoutMs, 20_000)
  assert.equal(resolveSettings(bounds, { stored: { remoteTimeoutMs: 45_000 }, target: { remoteTimeoutMs: 20_000 }, call: { timeoutMs: 10_000 } }).settings.remoteTimeoutMs, 10_000)
  assert.equal(resolveSettings(bounds).settings.remoteTimeoutMs, DEFAULTS.timeoutMs)
  // No floor but a positive number: the two-sided range is gone, so 500 ms is a
  // decision someone can make, not a mistake the plugin refuses to hear about.
  assert.equal(resolveSettings(bounds, { stored: { remoteTimeoutMs: 500 } }).settings.remoteTimeoutMs, 500)
})

test('a value past the cap comes down to it, says so, and is never a refusal', () => {
  const bounds = defaultBounds()
  const out = resolveSettings(bounds, { call: { timeoutMs: 900_000, maxOutputBytes: 9_999_999, maxBytes: 10 ** 12 } })
  assert.equal(out.settings.remoteTimeoutMs, bounds.maxTimeoutMs)
  assert.equal(out.settings.maxOutputBytes, bounds.maxOutputBytes)
  assert.equal(out.settings.maxTransferBytes, bounds.maxTransferBytes)
  assert.equal(out.notes.length, 3)
  assert.match(out.notes.join('\n'), /command timeout asked for 900000 and was capped to 300000/)
  assert.match(out.notes.join('\n'), /output ceiling asked for 9999999 and was capped to 4194304/)
  assert.match(out.notes.join('\n'), /transfer ceiling asked for/)
})

test('only a value that cannot mean a deadline is refused, and the hint states the new rule', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    let thrown
    try {
      resolveDeadline(defaultBounds(), undefined, bad)
    } catch (error) { thrown = error }
    assert.equal(thrown?.code, 'bad-input', `${String(bad)} must be refused`)
    assert.match(thrown.hint ?? '', /is capped to it/)
  }
  // A fraction is not a refusal: `clampTimeout` validates the shape, not the
  // tidiness of the number, and a 1500 ms ask is a decision rather than a mistake.
  assert.equal(resolveDeadline(defaultBounds(), undefined, 1_500.5).value, 1_500.5)
  // A number larger than everything the harness can schedule is still just a
  // number: it comes down to the cap.
  assert.equal(resolveDeadline(defaultBounds(), undefined, 10 ** 9).value, 300_000)
})

test('the resolved view carries every ceiling a call needs, including the ones with no stored layer', () => {
  const settings = resolveSettings(defaultBounds()).settings
  assert.deepEqual(settings, {
    remoteTimeoutMs: DEFAULTS.timeoutMs,
    maxOutputBytes: DEFAULTS.outputBytes,
    maxTransferBytes: DEFAULTS.transferBytes,
    transferTimeoutMs: DEFAULTS.transferTimeoutMs,
    maxTransferFiles: DEFAULTS.maxTransferFiles,
    maxTransferTotalBytes: DEFAULTS.maxTransferTotalBytes,
    maxConcurrentTransfers: DEFAULTS.maxConcurrentTransfers,
    maxRunningJobs: DEFAULTS.maxRunningJobs,
    probeTimeoutMs: DEFAULTS.probeTimeoutMs,
    statTimeoutMs: DEFAULTS.statTimeoutMs,
    maxSpillBytes: DEFAULTS.maxSpillBytes,
    graceMs: DEFAULTS.graceMs
  })
  // A transfer does not inherit the command's 30 s: the copy budget is its own,
  // and it sits above the command default on purpose.
  assert.ok(DEFAULTS.transferTimeoutMs > DEFAULTS.timeoutMs)
})

test('a transfer deadline follows the same layering as every other number', () => {
  const bounds = defaultBounds()
  assert.equal(resolveSettings(bounds, { call: { timeoutMs: 60_000 } }).settings.transferTimeoutMs, 60_000)
  const capped = resolveSettings(bounds, { call: { timeoutMs: 7_200_000 } })
  assert.equal(capped.settings.transferTimeoutMs, bounds.maxTransferTimeoutMs)
  assert.ok(capped.notes.includes('transfer timeout asked for 7200000 and was capped to 1800000'))
})

test('the config schema validates a profile row and fills the defaults', () => {
  // Schemastery owns this schema (not zod): a schema **is** its validator, and
  // `.volatile()` is what makes each field arrive as a live `{ get() }` so a profile
  // edit reaches the next call instead of the next restart.
  const filled = Config({})
  assert.equal(typeof filled.timeoutMs.get, 'function')
  assert.equal(filled.timeoutMs.get(), DEFAULTS.timeoutMs)
  assert.equal(filled.maxTransferBytes.get(), DEFAULTS.maxTransferBytes)
  const edited = Config({ timeoutMs: 5_000, maxSpillBytes: 0 })
  assert.equal(edited.timeoutMs.get(), 5_000)
  assert.equal(edited.maxSpillBytes.get(), 0) // zero is a real choice: no spill file
  assert.throws(() => Config({ timeoutMs: 0 })) // a zero deadline is not a deadline
  assert.throws(() => Config({ timeoutMs: 1.5 })) // natural() means whole
  assert.throws(() => Config({ timeoutMs: 'soon' }))
})

// ── the job lane: a ceiling with a reservation behind it ────────────────────

test('the job lane ceiling is capped to the slots a job may hold, and the cap is the reservation', () => {
  // Three numbers have to be the same number in three places — the schema's maximum,
  // the default this module publishes, and the rest of the table after what foreground
  // calls keep. Stated as an equation rather than as prose, because prose is how 0.0.36
  // ended up promising eight reserved slots while its schema let a profile take all 16.
  assert.equal(DEFAULTS.maxRunningJobs, MAX_JOB_LANES)
  assert.equal(MAX_JOB_LANES, MAX_CONCURRENT_OPS - FOREGROUND_RESERVED_OPS)
  assert.equal(defaultBounds().maxRunningJobs, MAX_JOB_LANES)
  assert.throws(() => Config({ maxRunningJobs: MAX_JOB_LANES + 1 }), /expected number <= 8/u, 'the schema will not accept one more')
  assert.equal(Config({ maxRunningJobs: 1 }).maxRunningJobs.get(), 1, 'and a smaller allowance is still a free choice')
})

test('a settings object that still carries a 16 is capped at read, corrected out loud, and stays capped to the transport', () => {
  const bounds = readBounds(VOLATILE({ maxRunningJobs: 16 }))
  assert.equal(bounds.maxRunningJobs, 8, 'the number a job lane is admitted against')
  const note = bounds.notes.find(line => line.includes('maxRunningJobs'))
  assert.ok(note, 'the correction is a sentence the page can show, not a silent clamp')
  assert.match(String(note), /the configured 16 is outside the range 1 to 8/u)
  assert.match(String(note), /8 of the 16 operation slots stay held back for foreground calls/u)
  // The ceilings a call actually runs with come from the same read, so the page, the
  // refusal, and the transport cannot each hold a different version of this number.
  const resolved = resolveSettings(bounds)
  assert.equal(resolved.settings.maxRunningJobs, 8)
  assert.ok(resolved.notes.includes(note), 'and the correction travels with the call that was corrected')
  // The reverse direction is a choice, not a fault: fewer jobs is always allowed.
  const fewer = resolveSettings(readBounds(VOLATILE({ maxRunningJobs: 1 })))
  assert.equal(fewer.settings.maxRunningJobs, 1)
  assert.deepEqual(fewer.notes, [], 'and nothing is said about a number that was never out of range')
  // A configured zero would mean "no jobs at all", which the floor of 1 reads as a
  // mistake to correct rather than a policy to honour.
  assert.equal(readBounds(VOLATILE({ maxRunningJobs: 0 })).maxRunningJobs, 1)
})

test('the probe deadline is one number, from the config to the page to the child', () => {
  // The Host has dialed with 30 s since 0.0.23; 0.0.36's settings page still showed
  // 10 s to a Host that predated the `bounds` payload. The default lives in config.ts
  // and is surfaced through `bounds`, so a test can pin the whole chain in one place.
  assert.equal(DEFAULTS.probeTimeoutMs, 30_000)
  assert.equal(defaultBounds().probeTimeoutMs, 30_000)
  assert.equal(resolveSettings(defaultBounds()).settings.probeTimeoutMs, 30_000)
  assert.equal(readBounds(VOLATILE({})).probeTimeoutMs, 30_000)
  // It is a ceiling like any other: the profile's own number wins when it has one.
  assert.equal(readBounds(VOLATILE({ probeTimeoutMs: 5_000 })).probeTimeoutMs, 5_000)
})
