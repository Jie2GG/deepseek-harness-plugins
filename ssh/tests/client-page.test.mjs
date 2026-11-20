// The settings page, checked without a browser.
//
// `client.ts` is one classic script whose factory closes over every helper, so a
// test cannot import the pieces it wants to exercise. This suite therefore does
// two different things, and says which is which:
//
//   * it lifts the page's own ceiling-box reader out of the source and *runs* it,
//     then feeds what that reader produces through the real `ops` layer — the
//     page's empty / number / nonsense rule against the Host's default / override /
//     cap rule, end to end;
//   * it asserts the shape of the page from its source, for the things only a
//     layout decision carries: the three regions and their order, the collapsed
//     runtime card, the live counts coming from the Host rather than from a
//     constant, and the narrow-window rules.
//
// A source assertion proves a decision was made, not that pixels landed. The
// second half of each of those claims is a real browser, and `client-fallbacks`
// covers the numbers. Nothing here is offered as visual verification.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOps } from '../lib/ops.js'
import { DEFAULTS } from '../lib/config.js'
import { MAX_CONNECTIONS } from '../lib/storage.js'
import { fakeRunner, fakeSecrets, fakeStore, record } from './helpers.mjs'

const CLIENT = join(import.meta.dirname, '..', 'src', 'client.ts')
const source = readFileSync(CLIENT, 'utf8')

/**
 * Lift the page's own ceiling-box reader out of the factory and make it callable.
 *
 * The body is plain JavaScript — the only type annotations live in the signature
 * this slice stops at — so running it is honest: the test exercises the page's
 * rule rather than a copy of it written here.
 * @returns `readCeiling(text)` as the page defines it.
 */
const readCeiling = (() => {
  // The greedy `[^\n]*` stops at the last brace on the signature line, which is the
  // body's opener — the return type's own braces sit earlier on that same line.
  const found = /function readCeiling\(text: string\)[^\n]*\{([\s\S]*?)\n {4}\}/u.exec(source)
  assert.ok(found, 'the page reads its three ceiling boxes through one function')
  // eslint-disable-next-line no-new-func
  return new Function('text', found[1])
})()

/**
 * Build the `configUpdate` body the page would send for these box contents: an
 * empty box writes `null`, a readable number writes itself, an unreadable one is
 * left out — which is the page's rule, asserted here through the shape it hands
 * the Host rather than through a screenshot.
 * @param boxes - one text per ceiling key.
 * @returns the request body.
 */
function bodyOf (boxes) {
  const body = {}
  for (const [key, text] of Object.entries(boxes)) {
    const read = readCeiling(text)
    if (read.at === 'clear') body[key] = null
    else if (read.at === 'set') body[key] = read.value
  }
  return body
}

const KEYS = ['remoteTimeoutMs', 'maxOutputBytes', 'maxTransferBytes']

/** One Host with nothing stored, which is the state a fresh profile opens in. */
function freshOps (settings = {}) {
  const { runner } = fakeRunner()
  const store = fakeStore({ records: [record()], settings })
  // The shared fake store answers a write with the value it was handed and keeps
  // nothing, which is what the transport suites want and what this one cannot: the
  // page re-reads after a save, so the stored slot has to be stateful here.
  let slot = { ...settings }
  store.settings = () => ({ ...slot })
  store.saveSettings = async next => { slot = { ...next }; store.calls.push(['saveSettings', next]); return slot }
  const ops = createOps({
    runner,
    store: async () => store,
    secrets: () => fakeSecrets({ password: false, passphrase: false, root: false }),
    askpass: () => ({ ready: true, path: '/tmp/h/askpass.sh' }),
    localExists: async () => true
  })
  return { ops, store }
}

// ── what the page sends, and what the Host then reports back ────────────────

test('an empty box asks the Host to drop the override, and the default comes back', async () => {
  for (const text of ['', '   ']) {
    assert.deepEqual(readCeiling(text), { at: 'clear' }, `${JSON.stringify(text)}: empty is a choice, not a value`)
  }
  const { ops } = freshOps({ remoteTimeoutMs: 45_000 })
  const saved = await ops.configUpdate({ settings: bodyOf({ remoteTimeoutMs: '' }) })
  assert.equal(saved.settings.remoteTimeoutMs, undefined, 'the stored slot no longer carries the key')
  assert.equal(saved.effective.remoteTimeoutMs, DEFAULTS.timeoutMs, 'and the call runs with the configured default')
})

test('a number the page can read travels whole, one per ceiling', async () => {
  const wanted = { remoteTimeoutMs: '45000', maxOutputBytes: '131072', maxTransferBytes: '67108864' }
  for (const key of KEYS) {
    const read = readCeiling(wanted[key])
    assert.equal(read.at, 'set')
    assert.equal(read.value, Number(wanted[key]))
  }
  const { ops } = freshOps()
  const saved = await ops.configUpdate({ settings: bodyOf(wanted) })
  assert.deepEqual(
    { ...saved.settings },
    { remoteTimeoutMs: 45_000, maxOutputBytes: 131_072, maxTransferBytes: 67_108_864 },
    'all three overrides land in one write')
  assert.equal(saved.effective.remoteTimeoutMs, 45_000, 'and each is what the next call resolves to')
  assert.equal(saved.effective.maxOutputBytes, 131_072)
  assert.equal(saved.effective.maxTransferBytes, 67_108_864)
  // The page re-seeds its boxes from this answer, so the read-back has to be the
  // same object the boxes showed — otherwise a save that capped a value prints a
  // number the reader never typed.
  const listed = await ops.list({})
  assert.deepEqual({ ...listed.settings }, { ...saved.settings })
  assert.equal(listed.bounds.effective.remoteTimeoutMs, 45_000)
})

test('a box the page cannot read is reported where it was typed, never sent', async () => {
  for (const text of ['0', '-5', '1.5', 'abc', '10 000', 'Infinity', 'NaN', '30s']) {
    assert.equal(readCeiling(text).at, 'bad', `${JSON.stringify(text)}: not a positive whole number`)
  }
  // The old handler dropped these silently, and the card answered `Saved.` about a
  // number that had never left the browser. Dropping the send while keeping the
  // text is what the two assertions below pin.
  assert.deepEqual(bodyOf({ remoteTimeoutMs: '1.5', maxOutputBytes: '45000' }), { maxOutputBytes: 45_000 })
  const { ops } = freshOps()
  let refused
  try {
    await ops.configUpdate({ settings: { remoteTimeoutMs: 0 } })
  } catch (error) { refused = error }
  assert.equal(refused?.code, 'bad-input', 'and a nonsense deadline is still the Host’s to refuse')
  assert.equal(refused.field, 'remoteTimeoutMs', 'naming the box the page highlights')
})

test('a value above the cap is stored as typed and reported as capped', async () => {
  const { ops } = freshOps()
  const saved = await ops.configUpdate({ settings: { maxTransferBytes: 900_000_000 } })
  assert.equal(saved.settings.maxTransferBytes, 900_000_000, 'the box keeps showing what was stored')
  assert.equal(saved.effective.maxTransferBytes, DEFAULTS.maxTransferBytes, 'while the Host says what actually applies')
  assert.match(saved.notes.join('\n'), /capped to 536870912/, 'and the correction is a receipt, not a rumour')
  // The card prints both facts, so the source has to read both fields.
  assert.match(source, /storedValue !== undefined && storedValue !== null/u, 'the override is a fact the card states')
  assert.match(source, /Number\(effective\) !== Number\(storedValue\)/u, 'and a capped value is detectable from the pair')
})

test('the page never invents a default: the placeholder is the Host’s default', () => {
  // The boxes are empty when nothing is stored, so the only number a reader sees
  // there is the one this Host resolved. A hard-coded placeholder is how 0.0.36
  // came to describe a deadline the Host was not dialing with.
  assert.match(source, /placeholder: defValue === undefined \? '' : String\(defValue\)/u)
  assert.match(source, /defValue = bounds\?\.\[field\.defaultKey\]/u)
  assert.ok(!/placeholder: '[0-9]+'/u.test(source), 'no ceiling is typed into the page as a literal')
})

// ── the page's own shape, stated from its source ────────────────────────────

test('the page is three regions in the order a reader uses them', () => {
  const root = /return h\('div', \{ class: 'dshssh-root' \},([\s\S]*?)\n {6}\)/u.exec(source)
  assert.ok(root, 'one root element holds the page')
  const children = String(root[1]).match(/\b(targetsCard|paramsCard|runtimeCard|header|noticeRegion|askpassNotice)\b/gu) ?? []
  assert.deepEqual(
    children.filter(name => name.endsWith('Card')),
    ['targetsCard', 'paramsCard', 'runtimeCard'],
    'targets first, then the parameters, then the runtime card')
  assert.ok(children.indexOf('header') < children.indexOf('targetsCard'), 'the title stands above all three')
})

test('the runtime region is collapsed by default and re-read when it opens', () => {
  assert.match(source, /h\('details', \{ class: 'dshssh-runtime', onToggle: props\.onToggle \}/u)
  assert.ok(!/\{\s*open:/.test(source), 'nothing ships the card already open')
  assert.match(source, /if \(event\?\.target\?\.open === true\) void refreshRuntime\(\)/u, 'opening it asks the Host again')
  // A collapsed card must not be a frozen one: the refresh reads every live number
  // again, and it is the same `list` the page mounted on.
  assert.match(source, /async function refreshRuntime\(\)[\s\S]*?applyList\(result, false\)/u)
  assert.match(source, /setSettingsDraft\(\{[^}]*remoteTimeoutMs: String\(result\.settings\?\.remoteTimeoutMs \?\? ''\)/u, 'and only the first load re-seeds the boxes')
})

test('every runtime metric the old tabs published is still stated', () => {
  const card = /function RuntimeCardView\(props: any\): any \{([\s\S]*?)\n {4}\}/u.exec(source) ?? []
  const body = card[0] ?? ''
  assert.ok(body.length > 500, 'the runtime card is still one component')
  for (const key of [
    'boundsTargets', 'boundsOps', 'boundsMasters', 'boundsCopies', 'boundsJobs', 'boundsJobsReserved',
    'boundsSpill', 'spillBytes', 'boundsPersist', 'boundsPerRound', 'boundsTimeout',
    'boundsRemoteTimeout', 'boundsOutput', 'boundsTransfer', 'boundsRunning',
    'boundsFromConfig', 'poolOff', 'tempCollected'
  ]) {
    // A row names its metric either to `t` directly or through `bound`'s label
    // argument; both are the row this card used to carry.
    assert.match(body, new RegExp(String.raw`t\('${key}'\)|'${key}'`, 'u'), `${key}: the row this card used to carry`)
  }
  // The three resolved ceilings are stated as default / cap / in force, which is
  // what makes a capped call legible to the reader who hit it.
  assert.match(body, /ceilingText\(t, bounds\.timeoutMs, bounds\.maxTimeoutMs/u)
  assert.match(body, /ceilingText\(t, bounds\.outputBytes, bounds\.maxOutputBytes/u)
  assert.match(body, /ceilingText\(t, bounds\.transferBytes, bounds\.maxTransferBytes/u)
})

test('the runtime card prints what the Host is doing, not what a layout wanted', () => {
  // Each live count is read off the pool report or the operation counter. A constant
  // here would be the page describing itself.
  for (const pattern of [
    /lane\(limits\.concurrentOps, probing\)/u,
    /lane\(limits\.maxLiveMasters, pool\?\.liveMasters\)/u,
    /pool\?\.transfers \?\? 0/u,
    /pool\?\.jobs \?\? 0/u,
    /spill\.files/u, /spill\.used/u, /spill\.max/u, /spill\.refusals/u,
    /temp\.removed\.length/u, /temp\.scanned/u
  ]) {
    assert.match(source, pattern)
  }
  assert.ok(!/setInterval|setTimeout\(\s*\(\)\s*=>\s*\{?\s*void load/u.test(source), 'the page does not invent its own polling loop')
})

test('no page chrome is left without a function', () => {
  // The two tabs are gone, so the strip that carried them must not be called at all:
  // a tablist whose panels all render is a control that moves nothing.
  assert.ok(!source.includes('TAB_BASE'), 'the tab ids went with the tabs')
  assert.equal([...source.matchAll(/h\(SshSegment, \{/gu)].length, 1, 'the segmented strip is the authentication choice only')
  assert.match(source, /h\(SshSegment, \{\s*\n?\s*id: AUTH_BASE,\s*\n?\s*role: 'radio'/u)
})

test('the target list states its count, its limit, and the one default it can name', () => {
  assert.match(source, /format\(t\('listTotal'\), \{ count: String\(connections\.length\) \}\)/u, 'the card head counts the servers')
  assert.equal(MAX_CONNECTIONS, 64)
  // The marker is the Host's own rule, not a stored field the page made up: a lone
  // target is the one every unnamed call lands on.
  assert.match(source, /connections\.length === 1 \? connections\[0\]\?\.id : undefined/u)
  assert.match(source, /isDefault: defaultId === record\.id/u)
  assert.match(source, /t\('defaultHint'\)/u, 'and the rule is written where a reader can find it')
})

test('a stored secret is named on the row and never shown', () => {
  for (const pattern of [
    /record\.secrets\?\.passphrase === true/u,
    /record\.secrets\?\.password === true/u,
    /record\.secrets\?\.root === true/u
  ]) {
    assert.match(source, pattern, 'presence is the only fact the list carries')
  }
  assert.ok(!/\brecord\.(password|passphrase|root)\b/u.test(source), 'no row ever reads a secret value back')
  const diagnostics = /const payload = JSON\.stringify\(\{[\s\S]*?\n {8}\}, null, 2\)/u.exec(source)
  assert.ok(diagnostics, 'the copied diagnostics are one explicit object, not the whole record')
  assert.ok(!/"(password|passphrase|root)":/u.test(diagnostics[0]), 'and it carries no secret either')
})

test('a save keeps the text a reader typed and refuses a second write while one runs', () => {
  const start = source.indexOf('async function act(key: string')
  assert.ok(start > 0, 'one handler owns busy, failure and notice')
  const end = source.indexOf('\n      }\n', start)
  const act = source.slice(start, end)
  assert.ok(act.includes('setFailure(next)'), 'the failure is recorded in that handler')
  assert.ok(!act.includes('setSettingsDraft'), 'a refused write leaves the boxes holding what was typed')
  assert.match(source, /disabled: locked \|\| props\.dirty !== true \|\| props\.invalid === true/u, 'the save button is down while a write runs')
  assert.match(source, /props\.busy === 'settings' \? t\('saving'\) : t\('settingsSave'\)/u, 'and says which it is doing')
  assert.match(source, /type: 'number',\s*\n\s*inputMode: 'numeric',\s*\n\s*min: '1',\s*\n\s*step: '1'/u, 'the boxes are numeric inputs, not free text')
})

test('the page declares no width the settings shell cannot give it', () => {
  // Overflow is a layout decision, not a browser mystery: every flex child that can
  // hold text says `min-width: 0`, every control counts its own padding, and the
  // action strips wrap rather than push the row past the column.
  for (const pattern of [
    /\.dshssh-input,\.dshssh-textarea\{box-sizing:border-box;width:100%;min-width:0/u,
    /\.dshssh-root\{[^}]*max-width:660px/u,
    /\.dshssh-actions\{[^}]*flex-wrap:wrap/u,
    /\.dshssh-row-main\{[^}]*min-width:0;flex:1 1 220px/u,
    /minmax\(min\(100%,220px\),1fr\)/u,
    /@media \(max-width:560px\)/u
  ]) {
    assert.match(source, pattern)
  }
  assert.ok(!/\.dshssh-root\{[^}]*overflow-x/u.test(source), 'the page scrolls with the shell, not inside itself')
})

test('the styles read host theme tokens, both the card and the fixed limits', () => {
  // A plugin page that paints a literal colour is a plugin page that breaks in dark
  // theme; `verification.md` asks for tokens, so the rule is asserted here rather
  // than eyeballed in a browser this suite does not have.
  const css = /const CSS = `([\s\S]*?)`/u.exec(source)
  assert.ok(css, 'one stylesheet still ships with the page')
  const declarations = String(css[1])
  assert.match(declarations, /var\(--dsw-alias-settings-card-fill\)/u)
  assert.match(declarations, /var\(--dsw-alias-settings-card-stroke\)/u)
  assert.match(declarations, /var\(--dsw-alias-label-tertiary\)/u)
  const hex = declarations.match(/#[0-9a-fA-F]{3,8}\b/gu) ?? []
  assert.ok(hex.length <= 1, `only an off-palette colour may be literal, found ${hex.join(', ')}`)
})
