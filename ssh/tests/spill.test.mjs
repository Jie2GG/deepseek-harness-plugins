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

// ── the shipped numbers: what a Host process is actually holding itself to ────
test('the shipped spill budget is one gigabyte and sixty-four files, stated as constants', () => {
  // Nothing else in the suite anchors the default, and this is the number the
  // design draft, the README and the delivery report have each quoted differently.
  // A silent change here is a policy change, so it has to break a test.
  assert.equal(spill.SPILL_BUDGET_BYTES, 1_073_741_824)
  assert.equal(spill.SPILL_BUDGET_FILES, 64)
  const budget = new spill.SpillBudget()
  assert.deepEqual([budget.max, budget.fileMax], [spill.SPILL_BUDGET_BYTES, spill.SPILL_BUDGET_FILES])
  // The single-stream ceiling a profile may set (64 MiB by default) is smaller
  // than the whole-process budget, which is the arithmetic the constant is
  // derived from: sixteen slots, two faces each, at that per-stream default.
  assert.equal(budget.ask(67_108_864).maxBytes, 67_108_864, 'a default child is granted its whole configured ceiling')
  assert.equal(budget.ask(2 * spill.SPILL_BUDGET_BYTES).maxBytes, spill.SPILL_BUDGET_BYTES, 'and a profile above the budget is held to it')
})

test('the threshold is a stopping condition: one settled child is allowed past it, and the next is refused', () => {
  // The claim the prose has to keep honest. A grant is never cut to the
  // remainder, and bytes are charged when a child settles, so the total passes
  // the number by the faces of the child whose report tipped it — and stops.
  const budget = new spill.SpillBudget(100, 64)
  const wanted = 60
  for (let child = 0; child < 5; child += 1) {
    if (budget.ask(wanted).maxBytes === 0) break
    budget.observe([
      { path: `/tmp/dsh-subprocess-1-${String(child)}-aaaa-stdout.log`, bytes: wanted },
      { path: `/tmp/dsh-subprocess-1-${String(child)}-bbbb-stderr.log`, bytes: wanted },
    ])
  }
  assert.equal(budget.used, 120, 'passed the threshold by one child, not clamped to it')
  assert.ok(budget.used - 100 <= 2 * wanted, 'and a serial run overshoots by at most one child’s two faces')
  assert.equal(budget.refusals, 1, 'the next child is the one that hears about it')
  assert.match(budget.ask(wanted).note ?? '', /spill budget is spent \(120 of 100 bytes already written\)/u)
})

test('one budget instance says nothing to another, which is what per Host process means', () => {
  // The ledger belongs to the object, not to the module: two transports — two
  // plugin activations in one process, or this suite and a running Host — do not
  // see each other's spend. The production wiring builds exactly one transport
  // per activation, so one Host process carries exactly one of these.
  const first = new spill.SpillBudget(10, 64)
  const second = new spill.SpillBudget(10, 64)
  first.observe([{ path: '/tmp/a.log', bytes: 40 }])
  assert.equal(first.used, 40)
  assert.equal(second.used, 0)
  assert.equal(second.ask(8).maxBytes, 8, 'and the second still grants its child a spill file')
})

test('a background file that grows is charged up to its newest size, not frozen at the first', async () => {
  // K-8: a streamed job re-reads its own spill file as the stream lengthens, so the
  // same path comes back with a larger whole-stream offset each time. Charging only
  // the first left the ledger a permanent understatement of the bytes actually on
  // disk — a 900-byte file counted as 400 forever. The fix tops the account up by
  // the difference, so `used` equals what the provider really wrote.
  const budget = new spill.SpillBudget(1_000, 2)
  assert.equal(budget.observe([{ path: '/tmp/j.log', bytes: 400 }]), 400, 'the first report charges its whole offset')
  assert.equal(budget.used, 400)
  assert.equal(budget.observe([{ path: '/tmp/j.log', bytes: 900 }]), 500, 'the next report charges only the growth')
  assert.equal(budget.used, 900, 'the ledger now matches the file on disk')
  assert.equal(budget.files, 1, 'and it is still one file')
  // Equal and smaller re-reports never refund: the file on disk did not shrink, and
  // a re-count of the whole offset would empty the budget out of one long log.
  assert.equal(budget.observe([{ path: '/tmp/j.log', bytes: 900 }]), 0, 'an equal report charges nothing')
  assert.equal(budget.observe([{ path: '/tmp/j.log', bytes: 500 }]), 0, 'and so does a smaller one')
  assert.equal(budget.used, 900, 'used never moves backward, and never double-counts')
  // The file limit still answers on the second distinct path; the byte ledger, now
  // correctly at 900 of 1_000, has not yet tipped the byte limit on its own.
  budget.observe([{ path: '/tmp/k.log', bytes: 300 }])
  assert.equal(budget.used, 1_200, 'the second file tops up on top of the first')
  const refused = budget.ask(64)
  assert.equal(refused.maxBytes, 0)
  // Either limit could answer here; the byte limit is the one that tipped first as
  // the growing file pushed `used` past the ceiling, so the note says so.
  assert.match(String(refused.note), /spill budget is spent/u)
  assert.match(String(refused.note), /1200 of 1000 bytes already written/u)
})
