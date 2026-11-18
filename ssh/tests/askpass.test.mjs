// The askpass helper answers from the slot the prompt names — and only from
// that slot. These tests run the real script the helper writes, with the real
// shell, because the failure being pinned (a login password spent on a
// passphrase prompt, burning the one allowed attempt) lives in the shell text,
// not in any TypeScript that wraps it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { AskPassHelper } from '../lib/askpass.js'

const hasShell = process.platform !== 'win32'

function answer (script, prompt, env) {
  const out = spawnSync('/bin/sh', [script, prompt], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env }
  })
  assert.equal(out.status, 0, out.stderr)
  return out.stdout.replace(/\n$/u, '')
}

test('each prompt is answered by its own slot, and never by the other one', { skip: !hasShell }, async () => {
  const helper = new AskPassHelper()
  const script = await helper.prepare()
  assert.ok(script)
  const both = { DSH_SSH_ASKPASS_PASSWORD: 'pw', DSH_SSH_ASKPASS_PASSPHRASE: 'pp' }
  assert.equal(answer(script, 'Enter passphrase for key "/home/u/.ssh/id_ed25519":', both), 'pp')
  assert.equal(answer(script, 'deploy@10.0.0.9\u2019s password:', both), 'pw')
  // Only one secret on hand: the other prompt gets an empty answer — not the
  // wrong-but-present one. This is the cross-fallback the plugin used to have,
  // and it cost the one allowed prompt attempt the prompt it borrowed.
  assert.equal(answer(script, 'Enter passphrase for key "/home/u/.ssh/id_ed25519":', { DSH_SSH_ASKPASS_PASSWORD: 'pw', DSH_SSH_ASKPASS_PASSPHRASE: '' }), '')
  assert.equal(answer(script, 'deploy@10.0.0.9\u2019s password:', { DSH_SSH_ASKPASS_PASSWORD: '', DSH_SSH_ASKPASS_PASSPHRASE: 'pp' }), '')
  // An unrecognised prompt shape — keyboard-interactive, a challenge — answers
  // from the password slot only, exactly as a terminal would.
  assert.equal(answer(script, 'Response to keyboard-interactive challenge:', { DSH_SSH_ASKPASS_PASSWORD: 'pw', DSH_SSH_ASKPASS_PASSPHRASE: 'pp' }), 'pw')
  // A capitalised passphrase prompt still reads as one: ssh has spelled it both
  // ways across versions.
  assert.equal(answer(script, 'Enter Passphrase:', { DSH_SSH_ASKPASS_PASSWORD: 'pw', DSH_SSH_ASKPASS_PASSPHRASE: 'pp' }), 'pp')
  await helper.dispose()
})

test('the helper script itself answers nothing and leaks nothing to argv', { skip: !hasShell }, async () => {
  const helper = new AskPassHelper()
  const script = await helper.prepare()
  // The secret travels in the environment the child carries, never on a
  // command line a sibling process could read from the process list.
  const source = readFileSync(script, 'utf8')
  assert.ok(!source.includes('pw'), 'no secret text is baked into the script')
  assert.match(source, /printf '%s\\n' "\$answer"/u)
  await helper.dispose()
})

test('a helper taken away between calls is put back where the transport will look', async () => {
  // The reason the temp-namespace sweep is safe to run at all: a newer generation
  // may collect a legacy-named helper directory, and the generation using it has
  // to notice and rebuild rather than fail a password prompt with a message about
  // a secret nobody got wrong.
  const { rmSync, existsSync, readFileSync } = await import('node:fs')
  const helper = new AskPassHelper()
  const first = await helper.prepare()
  assert.ok(typeof first === 'string')
  const directory = helper.directory
  assert.ok(typeof directory === 'string' && existsSync(directory), 'the directory is reported')
  rmSync(directory, { recursive: true, force: true })
  assert.equal(existsSync(first), false, 'the sweep took it')
  const again = helper.path
  assert.equal(typeof again, 'string', 'the read hands back a path anyway')
  assert.equal(existsSync(again), true, 'and the file is really there to be execed')
  assert.equal(readFileSync(again, 'utf8').includes('DSH_SSH_ASKPASS_PASSPHRASE'), true, 'the rebuilt helper is the real one')
  assert.equal(helper.ready, true)
  assert.equal(helper.directory, directory, 'rebuilt under the same name, so the transport never sees two paths')
  await helper.dispose()
  assert.equal(existsSync(directory), false, 'and the disposal still owns it')
})

test('using the helper keeps its directory young, which is what the idle rule reads', async () => {
  const { utimesSync, statSync } = await import('node:fs')
  const helper = new AskPassHelper()
  const script = await helper.prepare()
  assert.ok(typeof script === 'string')
  const directory = helper.directory
  const back = new Date(Date.now() - 5 * 60 * 60 * 1000)
  utimesSync(directory, back, back)
  assert.ok(statSync(directory).mtimeMs < Date.now() - 4 * 60 * 60 * 1000, 'stale to begin with')
  helper.path
  assert.ok(statSync(directory).mtimeMs > Date.now() - 60_000, 'the read renewed it')
  await helper.dispose()
})
