// The pure decision functions of the transport: quoting, program extraction,
// and the two fingerprint tables with their deliberate ordering difference.
import test from 'node:test'
import assert from 'node:assert/strict'
import { shellQuote, leadingProgram, classifyProbe, classifyRun, tail, HOST_KEY_SETTING } from '../lib/transport.js'

test('shellQuote makes any path one word for the remote shell', () => {
  assert.equal(shellQuote('/tmp/a b'), "'/tmp/a b'")
  assert.equal(shellQuote("/tmp/it's"), "'/tmp/it'\\''s'")
  assert.equal(shellQuote('a\\b'), "'a\\b'")
})

test('leadingProgram is conservative: one plain program or nothing', () => {
  assert.equal(leadingProgram('uptime'), 'uptime')
  assert.equal(leadingProgram('  git commit -m x  '), 'git')
  assert.equal(leadingProgram('/usr/bin/git status'), 'git') // the bare name is what an allowlist holds
  assert.equal(leadingProgram('systemctl status sshd'), 'systemctl')
  assert.equal(leadingProgram('rm -rf -- "a b"'), 'rm')
  assert.equal(leadingProgram(''), undefined)
  assert.equal(leadingProgram('ls | head'), undefined)
  assert.equal(leadingProgram('echo hi > /tmp/f'), undefined)
  assert.equal(leadingProgram('echo $(date)'), undefined)
  assert.equal(leadingProgram('FOO=1 bar'), undefined) // an assignment is not a program
  assert.equal(leadingProgram('Git'), undefined) // uppercase is not a name an allowlist can hold
  assert.equal(leadingProgram('a;b'), undefined)
  assert.equal(leadingProgram('echo \\; done'), undefined) // semicolons outside a program position too
})

test('the host key is recorded, never asked about', () => {
  assert.equal(HOST_KEY_SETTING, 'StrictHostKeyChecking=accept-new')
})

test('classifyProbe takes the exit code at its word first', () => {
  assert.equal(classifyProbe(0, 'anything'), 'reachable')
  assert.equal(classifyProbe(0, 'Host key verification failed.'), 'reachable') // the probe ran; the answer is the answer
  assert.equal(classifyProbe(255, 'ssh: connect to host 10.0.0.9 port 22: Connection refused'), 'unreachable')
  assert.equal(classifyProbe(255, 'Permission denied (publickey).'), 'auth-failed')
  assert.equal(classifyProbe(255, 'Permission denied (password).'), 'auth-failed')
  // A bare "please try again" carries no method tag: the table leaves it failed.
  assert.equal(classifyProbe(255, 'Permission denied, please try again.'), 'failed')
  assert.equal(classifyProbe(255, 'Too many authentication failures for deploy'), 'auth-failed')
  assert.equal(classifyProbe(255, 'Received disconnect: Server refused our key'), 'auth-failed')
  assert.equal(classifyProbe(255, 'no supported authentication methods'), 'auth-failed')
  // Elevation prompts answer to the same classification: spent secrets, wrong secrets.
  assert.equal(classifyProbe(1, 'sudo: 1 incorrect password attempt'), 'auth-failed')
  assert.equal(classifyProbe(1, 'sudo: a password is required'), 'auth-failed')
  assert.equal(classifyProbe(1, 'su: Authentication failure'), 'auth-failed')
  assert.equal(classifyProbe(255, 'Host key for example.com did not match.'), 'unknown-host')
  assert.equal(classifyProbe(255, 'Offending ED25519 key in /home/u/.ssh/known_hosts:3'), 'unknown-host')
  assert.equal(classifyProbe(255, 'REMOTE HOST IDENTIFICATION HAS CHANGED'), 'unknown-host') // case-insensitive
  assert.equal(classifyProbe(255, 'ssh: Could not resolve hostname nope: Name or service not known'), 'unreachable')
  assert.equal(classifyProbe(255, 'kex_exchange_identification: read: Connection reset by peer'), 'unreachable')
  assert.equal(classifyProbe(255, 'Connection timed out during banner exchange'), 'unreachable')
  assert.equal(classifyProbe(255, 'some other grief'), 'failed')
  assert.equal(classifyProbe(null, 'stopped by signal'), 'failed')
})

test('classifyRun reads the fingerprints first, because the server may echo either', () => {
  assert.equal(classifyRun(0, 'all good'), 'succeeded')
  assert.equal(classifyRun(0, 'Host key verification failed.'), 'unknown-host') // the opposite order from a probe, on purpose
  assert.equal(classifyRun(0, 'Permission denied (publickey).'), 'auth-failed')
  assert.equal(classifyRun(1, 'list failed'), 'exit-nonzero')
  assert.equal(classifyRun(2, ''), 'exit-nonzero')
  assert.equal(classifyRun(null, 'signalled away'), 'failed')
  assert.equal(classifyRun(255, 'ssh: connect to host x: Network is unreachable'), 'unreachable')
})

test('tail puts stderr first and keeps the last 2048 characters', () => {
  assert.equal(tail('', ''), undefined)
  assert.equal(tail('out', 'err'), 'err\nout')
  const long = 'a'.repeat(5000)
  const kept = tail(long, '')
  assert.equal(kept.length, 2048)
  assert.equal(kept, 'a'.repeat(2048)) // the tail of the stream, not the head
})
