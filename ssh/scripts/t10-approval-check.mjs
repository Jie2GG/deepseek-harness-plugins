/**
 * The approval scenarios a running Host can hide from a unit test.
 *
 * The plugin's gate answers three questions before a remote mutation runs: can
 * this conversation be asked at all, does the user's standing decision say ask or
 * never, and what should happen when nobody can answer. The offline suite covers
 * all three against a fake approval service. What it cannot show is what the
 * **core** does with the ask the plugin hands it when the approval service is
 * missing, unmounted, unanswerable, or wrong — which is the half that decides
 * whether a silently-allowed write or a fail-closed refusal is what the model
 * reads.
 *
 * So this script boots real Hosts — each in an isolated `$DSH_HOME`, each with its
 * own patch overlay, none of them touching the production profile — and drives one
 * gated `ssh_client` write through a real session, recording what the pipeline
 * decided:
 *
 *   ask + allow        the answer arrives at the client, the write runs
 *   ask + reject       the deny is the user's word, and nothing was written
 *   no approval entry  the service is absent: fail closed, with the core's sentence
 *   no answerer        the service is present but nobody can be reached: fail closed
 *   handler throws     the answerer is broken: fail closed, not treated as consent
 *   never              the user's standing decision is honoured, and no ask happens
 *
 * Run it with:
 *
 *     node scripts/t10-approval-check.mjs                     # all six
 *     node scripts/t10-approval-check.mjs no-approval         # one scenario
 *
 * Requirements: a writable `$DSH_TEST_HOME` (default `/data/dsh-home-test`) with
 * the `sdk` profile initialised, this bundle installed into it
 * (`dsh plugin --profile sdk add <this directory>`), a copy of the operator's
 * credentials and `storages/ssh_targets.json`, the model patch at
 * `/tmp/t10-patches/provider.yml`, and the scenario patch at
 * `/tmp/t10-patches/no-approval.yml`. Every file it writes is under the test home
 * or `/tmp`, and the remote files it creates live in one `/tmp` directory on the
 * target, which the operator can list afterwards.
 *
 * @module scripts/t10-approval-check
 */

import { DeepSeekHarness } from '/data/deepseek-harness/packages/sdk/client/lib/index.js'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const TEST_HOME = process.env.DSH_TEST_HOME ?? '/data/dsh-home-test'
const PROVIDER_PATCH = process.env.DSH_T10_PROVIDER ?? '/tmp/t10-patches/provider.yml'
const NO_APPROVAL_PATCH = process.env.DSH_T10_NO_APPROVAL ?? '/tmp/t10-patches/no-approval.yml'
const TARGET = process.env.DSH_T10_TARGET ?? 'proxy'
const REMOTE_DIR = `/tmp/dsh-ssh-t10-${Date.now().toString(36)}`
const ONLY = process.argv.slice(2)[0]

/** One line of the table, printed as it is decided. */
const rows = []
function record (scenario, expect, observed, passed, detail) {
  rows.push({ scenario, expect, observed, passed, detail })
  process.stdout.write(`${passed === true ? '✓' : '✗'} ${scenario} — asked: ${observed.asked ? 'yes' : 'no'}; write: ${observed.written ? 'ran' : 'refused'}\n    ${detail.slice(0, 300)}\n`)
}

const scenarios = [
  {
    name: 'ask-allow',
    expect: 'the client is asked, and its one-time grant lets the write run',
    approvalRequests: true,
    answer: () => ({ outcome: 'allowed-once' }),
    want: { asked: true, written: true, denial: undefined },
  },
  {
    name: 'ask-reject',
    expect: 'the client is asked, and a refusal denies with the user’s own word',
    approvalRequests: true,
    answer: () => ({ outcome: 'rejected' }),
    want: { asked: true, written: false, denial: /the user rejected/iu },
  },
  {
    name: 'no-approval-service',
    expect: 'with the approval entry unmounted, the ask fails closed — never silently allowed',
    approvalRequests: true,
    patches: [NO_APPROVAL_PATCH],
    answer: () => ({ outcome: 'allowed-once' }),
    // 0.0.34's last round moved the sentence: with no approval service mounted, the
    // plugin's own gate now says "no approval channel is available" instead of
    // borrowing the core's older "not yet supported" wording, so either one is the
    // fail-closed answer this scenario is about. What must never appear is a write.
    want: { asked: false, written: false, denial: /requires approval|not yet supported|no approval channel is available|cannot be asked/iu },
  },
  {
    name: 'no-answerer',
    expect: 'with the service mounted but no client able to answer, the ask fails closed',
    approvalRequests: false,
    want: { asked: false, written: false, denial: /no approval channel is available/iu },
  },
  {
    name: 'answerer-throws',
    expect: 'a broken answerer is a refusal, not a consent',
    approvalRequests: true,
    answer: () => { throw new Error('the answerer is on fire') },
    want: { asked: true, written: false, denial: /rejected|approval/iu },
  },
  {
    name: 'policy-never',
    expect: 'the standing full-access decision is honoured: no ask, and the write runs',
    approvalRequests: true,
    env: { DSH_PERMISSION_MODE: 'danger-full-access' },
    answer: () => ({ outcome: 'rejected' }),
    want: { asked: false, written: true, denial: undefined },
  },
]

/**
 * The environment names the provider patch reads keys from, resolved out of the
 * isolated home's credential file. The refs section is where the harness keeps
 * named environment secrets, and a launched Host inherits nothing from the shell
 * that started it unless it is handed the value.
 * @returns the pairs to add to the child environment.
 */
function apiKeys () {
  const values = {}
  const file = join(TEST_HOME, '.credentials.yaml')
  if (!existsSync(file)) return values
  const text = readFileSync(file, 'utf8')
  const refs = text.slice(text.indexOf('\nrefs:'))
  for (const match of refs.replaceAll(/^\s+/gm, '').split('\n')) {
    const pair = /^([A-Z0-9_]+):\s*(.+)$/.exec(match)
    if (pair !== null && pair[1] !== undefined && pair[2] !== undefined) values[pair[1]] = pair[2].replaceAll(/^["']|["']$/gu, '')
  }
  return values
}

/**
 * Drive one scenario: boot a Host in the isolated home, run one gated call, and
 * report what the pipeline actually did with it.
 * @param scenario - the case, its expectations and its patch overlay.
 * @returns the observed facts, for the table and for the exit code.
 */
async function runScenario (scenario) {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-t10-ws-'))
  const path = `${REMOTE_DIR}/${scenario.name}.txt`
  const observed = { asked: false, written: false, writeEvents: [], denials: [], approvalEvents: [], error: undefined }
  const previous = Object.entries(scenario.env ?? {})
  for (const [key, value] of previous) process.env[key] = value
  const harness = new DeepSeekHarness({
    profile: 'sdk',
    dshHome: TEST_HOME,
    processCwd: workspace,
    // The SDK pins a route per session unless the caller names one, and its
    // default is the provider this deployment has no key for. The patch file adds
    // the provider; these two lines choose it, so the turn runs on the model the
    // operator actually configured.
    provider: 'v100s',
    model: 'Qwen3.8-Flash-Next',
    reasoningEffort: 'low',
    patches: [PROVIDER_PATCH, ...(scenario.patches ?? [])],
    // The child gets the model key the provider patch names, read from the same
    // credential store the Host itself uses — never printed, never in a patch file.
    env: { ...process.env, ...apiKeys() },
    ...(scenario.approvalRequests === true ? { approvalRequests: true } : {}),
  })
  try {
    harness.client.start()
    if (scenario.approvalRequests === true && typeof scenario.answer === 'function') {
      harness.client.onRequest(async (method) => {
        if (method !== 'approval/request') throw new Error(`unexpected request ${method}`)
        observed.asked = true
        return scenario.answer()
      })
    }
    // Four string arguments, and nothing else. Booleans are left out on purpose:
    // a small model asked to send `mkdir=true` sends the *string* "True", the call
    // fails the parameter schema, and the scenario then measures a schema rejection
    // instead of the approval decision it was built to observe. `target` is required
    // because this home has more than one saved server, and the plugin says so.
    const prompt = [
      `Call the ssh_client tool exactly once, with exactly these four string arguments and no others:`,
      `action="write", target="${TARGET}", path="${path}", content="${scenario.name}".`,
      `Do not send any other argument, and do not send booleans or numbers.`,
      `Do not call read, exec, or any other tool. Do not retry the call if it fails.`,
      `After the tool returns, reply with two lines: the tool's own status word, then the tool's`,
      `message text quoted exactly as it came back (or NONE if it returned no message). Do not paraphrase that line.`,
      `Reply DONE on a third line.`,
    ].join(' ')
    const result = await harness.run(prompt, {
      onNotification: (notification) => {
        const text = JSON.stringify(notification)
        // The session events carry the tool's own answer, which is the only
        // statement here worth trusting: the model's prose is a claim about the
        // call, while the event is the call.
        if (/\"action\":\"write\"/.test(text) && /\"status\":\"succeeded\"/.test(text)) observed.writeEvents.push(text.slice(0, 200))
        const denial = /requires approval[^"]{0,80}|no approval channel is available[^"]{0,40}|cannot be asked[^"]{0,120}|the user rejected[^"]{0,60}/iu.exec(text)
        if (denial !== null && denial?.[0] !== undefined) observed.denials.push(denial[0].slice(0, 160))
        if (text.includes('approval/request')) observed.approvalEvents.push(text.slice(0, 160))
      },
    })
    observed.finalResponse = String(result?.finalResponse ?? '').slice(0, 200)
    // The SDK turn does not surface the tool payload to a notification listener,
    // so this column is only what the turn reported. The authority is the probe
    // file on the server — the script prints the one command that settles it, and
    // a scenario is not "verified" until somebody runs it.
    observed.written = observed.writeEvents.length > 0
      || /succeeded|wrote|replaced/iu.test(observed.finalResponse ?? '')
    for (const needle of ['not yet supported', 'no approval channel is available', 'cannot be asked', 'the user rejected', 'requires approval']) {
      const said = (observed.finalResponse ?? '').toLowerCase()  // the turn quotes the tool's own message verbatim on request
      const at = said.indexOf(needle)
      if (at >= 0) observed.denials.push(`(model line) ${observed.finalResponse.slice(Math.max(0, at - 40), at + 120)}`)
    }
    observed.probePath = path
    return observed
  } catch (error) {
    observed.error = error instanceof Error ? error.message : String(error)
    return observed
  } finally {
    for (const [key] of previous) delete process.env[key]
    // The client owns the subprocess and reaps it through its async-disposal hook.
    const dispose = harness[Symbol.asyncDispose] ?? harness.close
    if (typeof dispose === 'function') await dispose.call(harness)
  }
}

const selected = ONLY === undefined ? scenarios : scenarios.filter(scenario => scenario.name === ONLY)
if (selected.length === 0) {
  process.stdout.write(`no such scenario: ${ONLY}\nknown: ${scenarios.map(scenario => scenario.name).join(', ')}\n`)
  process.exitCode = 2
} else {
  process.stdout.write(`\napproval fail-closed check — isolated home ${TEST_HOME}, target "${TARGET}"\nremote probe files: ${REMOTE_DIR}/\n\n`)
  for (const scenario of selected) {
    process.stdout.write(`── ${scenario.name}: ${scenario.expect}\n`)
    const observed = await runScenario(scenario)
    const askedRight = observed.asked === scenario.want.asked
    const writtenRight = observed.written === scenario.want.written
    const denialRight = scenario.want.denial === undefined
      ? observed.denials.length === 0 || observed.written
      : observed.denials.some(line => scenario.want.denial?.test(line) === true)
    record(scenario.name, scenario.expect, observed,
      askedRight && writtenRight && denialRight && observed.error === undefined,
      observed.error !== undefined
        ? `host error: ${observed.error}`
        : [
            `ask reached the client: ${observed.asked ? 'yes' : 'no'}`,
            `write reported run: ${observed.written ? 'yes' : 'no'} (authority: ssh ${TARGET} ls -l ${dirname(observed.probePath)})`,
            observed.denials.length > 0 ? `deny: ${JSON.stringify(observed.denials[0])}` : 'deny: none',
            // The turn's own two lines are the audit trail: a refusal that was never
            // quoted is a judgement the reader cannot check from this output alone.
            `the session's answer: ${JSON.stringify(String(observed.finalResponse ?? '').slice(0, 180))}`,
            `expectations: asked=${String(scenario.want.asked)} written=${String(scenario.want.written)} ${denialRight ? 'deny-shape ok' : 'deny-shape MISSING'}`,
          ].join('\n    '))
    process.stdout.write('\n')
  }
  const failed = rows.filter(row => row.passed !== true).length
  process.stdout.write(`probe files: ${REMOTE_DIR} (verify with: ssh ${TARGET} ls -l ${REMOTE_DIR})\n${String(rows.length - failed)} of ${String(rows.length)} scenarios behaved as designed\n`)
  process.stdout.write(`verify the server side with: ssh ${TARGET} ls -l ${REMOTE_DIR}\n`)
  process.exitCode = failed === 0 ? 0 : 1
  if (!existsSync('/tmp')) process.exitCode = 1
  writeFileSync(join(tmpdir(), 'dsh-t10-last-run.json'), JSON.stringify({ remoteDir: REMOTE_DIR, rows }, null, 2))
}
