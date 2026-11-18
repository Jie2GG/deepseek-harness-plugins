// The two ledgers this plugin keeps about the machine it runs on: the spill it is
// willing to ask the subprocess provider for, and the temp directories its own
// dead generations left behind. Both are about resources the plugin does not own
// and must therefore be careful about — counting somebody else's files is fine,
// deleting them is not.
import test from 'node:test'
import assert from 'node:assert/strict'


// ── the budget: one process, one number, and a refusal that says which limit ──
const spill = await import('../lib/spill.js')

test('the budget grants spill until it is spent, then refuses with the reason named', () => {
  const budget = new spill.SpillBudget(100, 3)
  assert.deepEqual(budget.ask(64), { maxBytes: 64, note: undefined })
  // A grant is not a reservation: bytes are counted when the provider reports a
  // spill, so two children asking in the same instant are each handed the ceiling,
  // and the budget is what turns the next one away.
  assert.equal(budget.ask(64).maxBytes, 64)
  budget.observe([{ path: '/tmp/dsh-subprocess-1-a-stdout.log', bytes: 64 }])
  assert.equal(budget.used, 64)
  assert.equal(budget.files, 1)
  // The budget is a stopping condition, not a reservation: this stream is still
  // granted its ceiling even though 36 bytes of room remain, because cutting the
  // grant is how a provider ends up deleting a file it just wrote.
  assert.equal(budget.ask(64).maxBytes, 64)
  budget.observe([{ path: '/tmp/dsh-subprocess-1-b-stdout.log', bytes: 64 }])
  assert.equal(budget.used, 128, 'the total passed the ceiling by one stream, as documented')
  // Now the next child is refused, and told which limit answered.
  const refused = budget.ask(64)
  assert.equal(refused.maxBytes, 0)
  assert.match(String(refused.note), /spill budget is spent \(128 of 100 bytes already written\)/u)
  assert.match(String(refused.note), /keeps only its in-memory tail and no full-output file/u)
  assert.equal(budget.refusals, 1)
})

test('the file limit is a separate answer, and it names itself', () => {
  const budget = new spill.SpillBudget(1_000_000, 2)
  budget.observe([
    { path: '/tmp/a.log', bytes: 10 },
    { path: '/tmp/b.log', bytes: 10 },
  ])
  assert.equal(budget.used, 20, 'the bytes still have room')
  const refused = budget.ask(64)
  assert.equal(refused.maxBytes, 0)
  assert.match(String(refused.note), /2 of 2 files already written/u)
})

test('a per-stream ceiling above the budget gets the budget once, not a refusal', () => {
  const budget = new spill.SpillBudget(100, 8)
  // A profile that raised maxSpillBytes past the whole-process number still spills
  // once — the grant is clamped to the ceiling, and the overshoot is one stream.
  assert.equal(budget.ask(4096).maxBytes, 100)
  budget.observe([{ path: '/tmp/a.log', bytes: 400 }])
  assert.equal(budget.ask(4096).maxBytes, 0, 'and the next one is refused')
})

test('the same spill path is counted once, however often a reader comes back for it', () => {
  const budget = new spill.SpillBudget(1000)
  const entry = { path: '/tmp/dsh-subprocess-1-1-x-stdout.log', bytes: 300 }
  budget.observe([entry])
  budget.observe([entry])
  budget.observe([entry, { path: '', bytes: 500 }])
  assert.equal(budget.files, 1)
  assert.equal(budget.used, 300)
  assert.equal(budget.ask(64).maxBytes, 64)
})

test('a zero budget means no spilling at all, and asks for nothing', () => {
  const off = new spill.SpillBudget(0)
  assert.equal(off.ask(64 * 1024 * 1024).maxBytes, 0)
  assert.equal(off.ask(64 * 1024 * 1024).note, undefined, 'disabled is not refused')
  assert.equal(off.max, 0)
  const wanted0 = new spill.SpillBudget(1000)
  assert.equal(wanted0.ask(0).maxBytes, 0, 'a call that wants no spill is not charged either')
})

test('a stream that never spilled costs the budget nothing', () => {
  const budget = new spill.SpillBudget(1000, 8)
  // The common case: both faces stayed inside their in-memory ceiling, so the
  // provider reported no path — and a budget that charged those bytes would be
  // emptied by ordinary answers and refuse the one stream that needed a file.
  budget.observe([
    { path: undefined, bytes: 900 },
    { path: undefined, bytes: 900 },
    { path: '', bytes: 10 },
  ])
  assert.equal(budget.used, 0)
  assert.equal(budget.files, 0)
  assert.equal(budget.ask(64).maxBytes, 64, 'and the next child is still granted its file')
})

test('the summary line quotes both budgets and the refusals, for the settings card', () => {
  const budget = new spill.SpillBudget(1000, 2)
  budget.observe([
    { path: '/tmp/a.log', bytes: 40 },
    { path: '/tmp/b.log', bytes: 30 },
  ])
  assert.equal(budget.ask(64).maxBytes, 0, 'the file limit answered before the byte limit did')
  assert.equal(budget.summary(), '70 of 1000 bytes spilled in 2 of 2 file(s), 1 child(ren) asked without')
})
