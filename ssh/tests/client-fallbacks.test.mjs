// The browser half, checked against the Host half without a browser.
//
// `client.ts` carries one fallback object for every number it shows a Host that
// predates the `bounds` payload, and it shows the Host's live value whenever one
// arrives. Both halves of that rule are easy to break from one side: a default moved
// in `config.ts`, and the page keeps printing the number the last release had. 0.0.36
// shipped exactly that disagreement — the Host had been dialing connectivity probes
// with 30 000 ms since 0.0.23 while the page's fallback still said 10 000 ms — so
// these assertions compare the page's copy against the running Host's payload rather
// than against a third copy of the number kept in a test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createOps } from '../lib/ops.js'
import { DEFAULTS } from '../lib/config.js'
import {
  CONTROL_PERSIST_SECONDS,
  FOREGROUND_RESERVED_OPS,
  MAX_CONCURRENT_OPS,
  MAX_CONNECTIONS,
  MAX_JOB_LANES,
  MAX_LIVE_MASTERS
} from '../lib/storage.js'
import { fakeRunner, fakeSecrets, fakeStore, record } from './helpers.mjs'

const CLIENT = join(import.meta.dirname, '..', 'src', 'client.ts')
const source = readFileSync(CLIENT, 'utf8')

/** The fallback object the page starts from, read out of its own source. */
function fallbackLimits () {
  const found = /const \[limits, setLimits\] = React\.useState\(\{([^}]*)\}\)/u.exec(source)
  assert.ok(found, 'the page keeps one fallback object for a Host that sends no bounds')
  const out = {}
  for (const pair of String(found[1]).split(',')) {
    const [key, value] = pair.split(':').map(part => part.trim())
    assert.ok(key !== undefined && value !== undefined, `unparsable entry ${JSON.stringify(pair)}`)
    const asNumber = Number(value.replace(/_/gu, ''))
    assert.ok(Number.isFinite(asNumber), `${key}: the fallback has to be a plain number, found ${value}`)
    out[key] = asNumber
  }
  return out
}

/** What a running Host actually answers with, through the same `list` the page calls. */
async function hostView () {
  const { runner } = fakeRunner()
  const store = fakeStore({ records: [record()] })
  const ops = createOps({
    runner,
    store: async () => store,
    secrets: () => fakeSecrets({ password: true, passphrase: false }),
    askpass: () => ({ ready: true, path: '/tmp/h/askpass.sh' }),
    localExists: async () => true
  })
  return ops.list({})
}

test('the fallback numbers are this release’s own defaults, not the last release’s', async () => {
  const limits = fallbackLimits()
  const listed = await hostView()
  // The one this whole file exists for: a Host with no `bounds` payload is still a Host
  // that dials probes with its configured deadline, so a page showing anything else is
  // describing a call nobody made.
  assert.equal(limits.probeTimeoutMs, DEFAULTS.probeTimeoutMs, 'probe timeout: the config default is the displayed default')
  assert.equal(limits.probeTimeoutMs, listed.bounds.probeTimeoutMs, 'and it equals what a Host that answers sends')
  assert.equal(limits.probeTimeoutMs, listed.bounds.effective.probeTimeoutMs, 'and what that Host would run with')
  assert.notEqual(limits.probeTimeoutMs, 10_000, 'the 0.0.36 fallback is gone, not just documented as wrong')
  // The ceilings the page states as ranges, and the table the lanes are cut from.
  assert.equal(limits.maxConnections, MAX_CONNECTIONS)
  assert.equal(limits.concurrentOps, MAX_CONCURRENT_OPS)
  assert.equal(limits.maxRunningJobs, MAX_JOB_LANES, 'the job ceiling the page falls back to is the ceiling the schema enforces')
  assert.equal(limits.foregroundReservedOps, FOREGROUND_RESERVED_OPS, 'and so is the reservation it explains')
  assert.equal(limits.maxLiveMasters, MAX_LIVE_MASTERS)
  assert.equal(limits.controlPersistSeconds, CONTROL_PERSIST_SECONDS)
  assert.equal(limits.remoteTimeoutMaxMs, DEFAULTS.maxTimeoutMs)
  assert.equal(limits.outputMaxBytes, DEFAULTS.maxOutputBytes)
  assert.equal(limits.transferMaxBytes, DEFAULTS.maxTransferBytes)
  assert.equal(limits.probeAllLimit, listed.limits.probeAllLimit, 'a per-round limit read from the Host, not invented here')
})

test('the job lane the page prints is the job lane the transport admits against', async () => {
  const limits = fallbackLimits()
  const listed = await hostView()
  assert.equal(limits.maxRunningJobs, MAX_JOB_LANES, 'the fallback is the ceiling a job may hold at all')
  assert.equal(limits.maxRunningJobs, MAX_CONCURRENT_OPS - FOREGROUND_RESERVED_OPS, 'and the reservation is what is left of the table')
  assert.equal(limits.foregroundReservedOps, listed.bounds.foregroundReservedOps, 'the page and the Host name the same held-back count')
  assert.equal(listed.bounds.maxRunningJobs, limits.maxRunningJobs, 'a new Host is shown the same number an old one is promised')
  assert.equal(listed.pool.jobs, 0, 'and the running count it pairs with the ceiling is reported, not assumed')
  // The card must prefer the Host's live value wherever one is sent — that is what
  // keeps a retunable profile from being displayed as a constant.
  assert.match(source, /bounds\?\.maxRunningJobs \?\? limits\.maxRunningJobs/u, 'the job row follows the Host when the Host answers')
  assert.match(source, /bounds\?\.probeTimeoutMs \?\? limits\.probeTimeoutMs/u, 'so does the probe row')
  assert.match(source, /bounds\?\.foregroundReservedOps \?\? limits\.foregroundReservedOps/u)
  assert.match(source, /pool\?\.jobs \?\? 0/u, 'and the running jobs come from the pool report')
  // A Host that predates all of this sends neither `pool` nor `bounds`: the card hides
  // the rows it cannot vouch for instead of printing this release's numbers for it.
  assert.match(source, /\.\.\.\(pooling \? \[/u, 'the sharing rows, the job row among them, stand or fall together')
})

test('every label the page asks for exists in both dictionaries', () => {
  // A missing key does not throw in the browser; it paints the key name into the
  // settings card. This is the cheapest way to notice one was added on one side only.
  const used = new Set([...source.matchAll(/\bt\('([a-zA-Z][a-zA-Z0-9]*)'\)/gu)].map(match => match[1]))
  assert.ok(used.size > 60, `only ${String(used.size)} dictionary keys were found in use — the scan has gone blind`)
  // Both dictionaries are required by the locale service, so a key defined once is a
  // key one of the two languages renders as its own name.
  const definitions = key => [...source.matchAll(new RegExp(String.raw`^\s{8}${key}: '`, 'gmu'))].length
  const oneSided = [...used].filter(key => definitions(key) !== 2).map(key => `${key}=${String(definitions(key))}`).sort()
  assert.deepEqual(oneSided, [], 'every label in use is defined exactly twice: en and zh')
  for (const key of ['boundsJobs', 'boundsJobsReserved', 'boundsTimeout']) {
    assert.equal(definitions(key), 2, `${key}: the row an earlier release added or reworded`)
  }
  // 0.0.40 re-laid the page out: the tabs went, three regions took their place, and
  // the parameters card grew the words it needs to tell an override from a default.
  // Each of these is a label the redesigned page asks for, so one side only means a
  // language rendering its own key name.
  for (const key of [
    'runtimeTitle', 'runtimeHint', 'runtimeStorageTitle', 'runtimeUsageFormat', 'runtimeBusy',
    'paramOverride', 'paramFollowDefault', 'paramCapped', 'paramBadNumber', 'paramDirty', 'paramReset',
    'defaultChip', 'defaultHint', 'spillFiles', 'spillBytes', 'listTotal', 'rowDetails', 'rowDetailsHide',
    'refresh', 'unitMs', 'unitBytes', 'storageConfigNote'
  ]) {
    assert.equal(definitions(key), 2, `${key}: the copy this release added`)
  }
  // The tab strip was the page's only reason to split its two views, and it is gone;
  // copy that named a tab would be a label with nothing left to label.
  for (const key of ['tabsLabel', 'tabList', 'tabSettings']) {
    assert.equal(definitions(key), 0, `${key}: the tabs it named no longer exist`)
  }
})
