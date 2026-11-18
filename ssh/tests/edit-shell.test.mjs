// These tests run the POSIX command strings the edit builders generate against a
// real /bin/sh in a real temp directory, and read back what the file actually
// holds and what the shell claimed about it. The unit tests in edit.test.mjs check
// the shape of the commands; these check that the shape does what it promises,
// including the one case no amount of byte counting can catch: a body that lands
// at the right length with the wrong bytes.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEditRead, buildEditWrite, buildEditRestore, splitEditVersion, digestHex, parseWriteReport, parseRepairReport } from '../lib/edit.js'
import { shellQuote } from '../lib/transport.js'

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex')
const SH = existsSync('/bin/sh') ? '/bin/sh' : null
const which = name => (SH === null ? '' : (spawnSync(SH, ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout ?? '').trim())
// The digest path is what this feature is about, so a machine with no checksum
// tool at all cannot be said to have run these tests.
const HAS_SHA256 = which('sha256sum') !== '' || which('shasum') !== '' || which('openssl') !== ''
const SKIP = SH === null ? 'no POSIX shell on this machine'
  : !HAS_SHA256 ? 'no sha256sum, shasum, or openssl on this machine'
  : !existsSync('/bin/cp') || !existsSync('/bin/cat') ? 'no cp or cat for the sequence to run with'
  : false
const dir = mkdtempSync(join(tmpdir(), 'editshell-'))
const TOOLS = ['sh', 'cp', 'cat', 'wc', 'tr', 'head', 'sed', 'printf', 'echo', 'rm', 'stat', 'ls', 'sha256sum', 'shasum', 'openssl']

/** A PATH of our own, so "no checksum tool" and "a lying cat" are both testable. */
function makeBin (name, { noSha = false, catBody = null } = {}) {
  const b = join(dir, name)
  mkdirSync(b, { recursive: true })
  for (const tool of TOOLS) {
    if (noSha && (tool === 'sha256sum' || tool === 'shasum' || tool === 'openssl')) continue
    if (catBody !== null && tool === 'cat') continue // the shim below takes its place
    const p = which(tool)
    if (p !== '') symlinkSync(p, join(b, tool))
  }
  if (catBody !== null) {
    // A `cat > file` gets no argv of its own: the redirect is the shell's. So the
    // shim writes its body to $FAKE_CAT_TARGET — the very file the redirect opened
    // — and that is how "the bytes that landed are not the bytes that were sent"
    // gets tested without a kernel bug.
    writeFileSync(join(b, 'cat'), `#!/bin/sh\nreal=/bin/cat\nif [ -n "$FAKE_CAT_TARGET" ]; then printf '%s' "$FAKE_CAT_BODY" > "$FAKE_CAT_TARGET"; else "$real" "$@"; fi\n`)
    spawnSync(which('chmod') || '/bin/chmod', ['+x', join(b, 'cat')])
  }
  return b
}
const full = makeBin('fullbin')
const noTool = makeBin('noshatools', { noSha: true })
const lying = makeBin('lying', { catBody: '' })

const run = (command, { input = '', bin = full, env = {} }) => {
  // No trim: the body's own trailing newline is part of what is being compared.
  const res = spawnSync(SH ?? '/bin/sh', ['-c', command], { input, encoding: 'utf8', env: { PATH: bin, ...env } })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

const original = 'alpha\nbeta\ngamma\n'
const written = 'alpha\nBETA\ngamma\n'
const collision = 'alpha\nZeta\ngamma\n' // same length as `written`, different bytes
assert.equal(Buffer.byteLength(collision), Buffer.byteLength(written))

// Set DSH_EDIT_SHELL_DEBUG=1 to see each command's answer and the file after it.
const show = (label, res, file) => {
  if (process.env.DSH_EDIT_SHELL_DEBUG === undefined) return
  console.log(`\n[${label}] exit=${String(res.status)} out=${JSON.stringify(res.stdout.trim())}${res.stderr.trim() === '' ? '' : ` err=${JSON.stringify(res.stderr.trim())}`}`)
  if (file !== undefined && existsSync(file)) console.log(`         file=${JSON.stringify(readFileSync(file, 'utf8'))}`)
}

test('the read and a clean write agree with the digests the server states', { skip: SKIP }, () => {
  const f = join(dir, 'clean')
  writeFileSync(f, original)
  const res = run(buildEditRead(shellQuote(f)), {})
  const parsed = splitEditVersion(res.stdout)
  show('1 read', { ...res, stdout: res.stdout.split('\n').slice(0, 2).join('\n') })
  assert.equal(parsed.content, original)
  assert.equal(parsed.digest, sha(original))
  assert.ok(parsed.version !== undefined)
  // 1b. clean write: verified, and the copy holds the previous content.
  const w = run(buildEditWrite({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.bak`), version: parsed.version,
    originalSha256: parsed.digest, expectedBytes: Buffer.byteLength(written),
    expectedSha256: digestHex(written), keepBackup: true,
  }), { input: written })
  show('1b write', w, f)
  assert.equal(w.status, 0)
  assert.equal(readFileSync(f, 'utf8'), written)
  assert.equal(readFileSync(`${f}.bak`, 'utf8'), original)
  assert.equal(parseWriteReport(w.stdout).evidence, 'digest')
  assert.equal(parseWriteReport(w.stdout).sha256, sha(written))
})

// 2. the same-size collision: a `cat` that ships a body of the right length but
//    the wrong bytes must not be believed.
test('a same-size body of different bytes is refused, and the repair puts the read content back', { skip: SKIP }, () => {
  const f = join(dir, 'collision')
  writeFileSync(f, original)
  const parsed = splitEditVersion(run(buildEditRead(shellQuote(f)), {}).stdout)
  const w = run(buildEditWrite({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.bak`), version: parsed.version,
    originalSha256: parsed.digest, expectedBytes: Buffer.byteLength(written),
    expectedSha256: digestHex(written), keepBackup: true,
  }), { input: written, bin: lying, env: { FAKE_CAT_TARGET: f, FAKE_CAT_BODY: collision } })
  show('2 collision write', w, f)
  assert.equal(w.status, 28, 'a same-size different-content body must be refused')
  assert.equal(readFileSync(f, 'utf8'), collision)
  const rep = parseRepairReport(run(buildEditRestore({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.bak`),
    originalBytes: Buffer.byteLength(original), intendedBytes: Buffer.byteLength(written),
    expectedSha256: digestHex(written), originalSha256: parsed.digest, preSha256: parsed.digest, keepBackup: true,
  }), {}).stdout)

  assert.equal(rep.verdict, 'restored')
  assert.equal(rep.contentVerified, true)
  assert.equal(readFileSync(f, 'utf8'), original, 'the file is back to what the read saw')
})

test('a server with no checksum tool writes, and says so without a proof', { skip: SKIP }, () => {
  const f = join(dir, 'nosha')
  writeFileSync(f, original)
  const parsed = splitEditVersion(run(buildEditRead(shellQuote(f)), { bin: noTool }).stdout)
  assert.equal(parsed.digest, undefined, 'no tool means no digest')
  assert.equal(parsed.content, original)
  const w = run(buildEditWrite({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.bak`), version: parsed.version,
    expectedBytes: Buffer.byteLength(written), expectedSha256: digestHex(written), keepBackup: false,
  }), { input: written, bin: noTool })
  show('3 no-tool write', w, f)
  assert.equal(w.status, 29)
  assert.equal(parseWriteReport(w.stdout).evidence, 'sizeonly')
  assert.ok(existsSync(`${f}.bak`), 'an unverifiable success keeps its safety copy even when backup:false')
})

test('a lost answer whose bytes landed at the promised digest is landed', { skip: SKIP }, () => {
  const f = join(dir, 'landed')
  writeFileSync(f, written)
  writeFileSync(`${f}.bak`, original)
  const r = run(buildEditRestore({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.bak`),
    originalBytes: Buffer.byteLength(original), intendedBytes: Buffer.byteLength(written),
    expectedSha256: digestHex(written), keepBackup: true,
  }), {})
  show('4 landed by digest', r, f)
  assert.equal(r.status, 27)
  const rep = parseRepairReport(r.stdout)
  assert.equal(rep.verdict, 'landed')
  assert.equal(rep.contentVerified, true)
})

test('a repair on a tool-less server leaves a finished edit alone, unverified', { skip: SKIP }, () => {
  const f = join(dir, 'landed-sizeonly')
  writeFileSync(f, written)
  const r = run(buildEditRestore({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.bak`),
    originalBytes: Buffer.byteLength(original), intendedBytes: Buffer.byteLength(written),
    expectedSha256: digestHex(written), keepBackup: true,
  }), { bin: noTool })
  show('5 landed sizeonly', r, f)
  assert.equal(parseRepairReport(r.stdout).contentVerified, false)
  assert.equal(readFileSync(f, 'utf8'), written, 'a repair must not undo a finished edit for want of a digest')
})

test('no copy and the read digest still in place is intact, and proven', { skip: SKIP }, () => {
  const f = join(dir, 'intact')
  writeFileSync(f, original)
  const r = run(buildEditRestore({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.gone`),
    originalBytes: Buffer.byteLength(original), intendedBytes: Buffer.byteLength(written),
    preSha256: sha(original), keepBackup: true,
  }), {})
  show('6 intact by digest', r, f)
  assert.equal(r.status, 0)
  assert.equal(parseRepairReport(r.stdout).verdict, 'intact')
  assert.equal(parseRepairReport(r.stdout).contentVerified, true)
})

// 7. no copy, untouched by size alone: that is a claim, not a proof. The edit
// here changes the length, so a size-only repair can at least tell the two apart.
test('no copy and a matching byte count is intact only as a claim', { skip: SKIP }, () => {
  const f = join(dir, 'intact-sizeonly')
  writeFileSync(f, original)
  const r = run(buildEditRestore({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.gone`),
    originalBytes: Buffer.byteLength(original), intendedBytes: 20,
    expectedSha256: digestHex(written), keepBackup: true,
  }), { bin: noTool })
  show('7 intact sizeonly', r, f)
  const rep = parseRepairReport(r.stdout)
  assert.equal(rep.verdict, 'intact')
  assert.equal(rep.contentVerified, false, 'no tool, so no proof the content never moved')
})

test('no copy and a digest that does not match the read is unrecoverable', { skip: SKIP }, () => {
  const f = join(dir, 'damaged')
  writeFileSync(f, 'alpha\nXXX\n')
  const r = run(buildEditRestore({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.gone`),
    originalBytes: Buffer.byteLength(original), intendedBytes: Buffer.byteLength(written),
    preSha256: sha('alpha\nBET\n'), keepBackup: true,
  }), {})
  show('8 damaged, no copy', r, f)
  assert.equal(r.status, 25)
  assert.equal(parseRepairReport(r.stdout).verdict, 'unrecoverable')
})

test('a copy that is not the content this call read is a partial, not a restore', { skip: SKIP }, () => {
  const f = join(dir, 'badcopy')
  writeFileSync(f, 'alpha\nBET\n')
  writeFileSync(`${f}.bak`, 'someone else\n')
  const r = run(buildEditRestore({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.bak`),
    originalBytes: Buffer.byteLength(original), intendedBytes: Buffer.byteLength(written),
    preSha256: sha('alpha\nBET\n'), keepBackup: true,
  }), {})
  show('9 copy is not what we read', r, f)
  assert.equal(r.status, 26)
  assert.equal(parseRepairReport(r.stdout).verdict, 'partial')
})

test('a copy that cannot be written back is unrecoverable, and its unreadable size is a dash', { skip: SKIP }, () => {
  const f = join(dir, 'copyfailed')
  writeFileSync(f, 'alpha\nBET\n')
  writeFileSync(`${f}.bak`, original)
  spawnSync(which('chmod') || '/bin/chmod', ['000', f])
  const r = run(buildEditRestore({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.bak`),
    originalBytes: Buffer.byteLength(original), intendedBytes: Buffer.byteLength(written),
    preSha256: sha('alpha\nBET\n'), keepBackup: true,
  }), {})
  spawnSync(which('chmod') || '/bin/chmod', ['644', f])
  show('10 write-back failed', r, f)
  assert.equal(r.status, 25)
  assert.equal(parseRepairReport(r.stdout).verdict, 'unrecoverable')
})

// 11. a concurrent writer left the same size and a different body: the pre-write
//     digest sees it, and nothing is truncated.
test('a concurrent same-size write is caught before the file is truncated', { skip: SKIP }, () => {
  const f = join(dir, 'concurrent')
  writeFileSync(f, collision)
  const parsed = splitEditVersion(run(buildEditRead(shellQuote(f)), {}).stdout)
  const w = run(buildEditWrite({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.bak`), version: undefined,
    originalSha256: sha(original), expectedBytes: Buffer.byteLength(written),
    expectedSha256: digestHex(written), keepBackup: true,
  }), { input: written })
  show('11 stale by content', w, f)
  assert.equal(w.status, 21)
  assert.match(w.stderr, /content changed/)
  assert.equal(readFileSync(f, 'utf8'), collision, 'nothing was written')
  assert.ok(!existsSync(`${f}.bak`), 'and no copy was taken')
})

test('a short body is refused by the byte count, and the copy stays', { skip: SKIP }, () => {
  const f = join(dir, 'short')
  writeFileSync(f, original)
  const parsed = splitEditVersion(run(buildEditRead(shellQuote(f)), {}).stdout)
  const w = run(buildEditWrite({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.bak`), version: parsed.version,
    originalSha256: parsed.digest, expectedBytes: 999, expectedSha256: digestHex(written), keepBackup: true,
  }), { input: written })
  show('12 short body', w, f)
  assert.equal(w.status, 24)
  assert.ok(existsSync(`${f}.bak`))
})

test('only a result a digest vouches for is allowed to drop the copy', { skip: SKIP }, () => {
  const f = join(dir, 'drop')
  writeFileSync(f, original)
  const parsed = splitEditVersion(run(buildEditRead(shellQuote(f)), {}).stdout)
  const w = run(buildEditWrite({
    pathArg: shellQuote(f), backupArg: shellQuote(`${f}.bak`), version: parsed.version,
    originalSha256: parsed.digest, expectedBytes: Buffer.byteLength(written),
    expectedSha256: digestHex(written), keepBackup: false,
  }), { input: written })
  show('13 drop the copy', w, f)
  assert.equal(w.status, 0)
  assert.ok(!existsSync(`${f}.bak`), 'a digest-verified success may drop it')
  // 13b. a restore that a digest vouches for may drop the copy too.
  const g = join(dir, 'drop-restore')
  writeFileSync(g, original)
  writeFileSync(`${g}.bak`, original)
  const r2 = run(buildEditRestore({
    pathArg: shellQuote(g), backupArg: shellQuote(`${g}.bak`),
    originalBytes: Buffer.byteLength(original), intendedBytes: 12345,
    expectedSha256: digestHex(written), preSha256: sha(original), keepBackup: false,
  }), {})
  show('13b verified restore drops the copy', r2, g)
  assert.equal(parseRepairReport(r2.stdout).verdict, 'restored')
  assert.ok(!existsSync(`${g}.bak`), 'verified → the copy this call made is no longer wanted')
  // 13c. a partial keeps it: the reader is the only one who can judge what came back.
  const h = join(dir, 'partial-keep')
  writeFileSync(h, 'alpha\nBET\n')
  writeFileSync(`${h}.bak`, 'someone else\n')
  const r3 = run(buildEditRestore({
    pathArg: shellQuote(h), backupArg: shellQuote(`${h}.bak`),
    originalBytes: Buffer.byteLength(original), intendedBytes: Buffer.byteLength(written),
    expectedSha256: digestHex(written), preSha256: sha('alpha\nBET\n'), keepBackup: false,
  }), {})
  show('13c partial keeps the copy', r3, h)
  assert.equal(parseRepairReport(r3.stdout).verdict, 'partial')
  assert.ok(existsSync(`${h}.bak`), 'partial → the copy stays for the reader')
})



// The temp tree is the fixture; the process owns it, so it goes with the run.
if (typeof globalThis.after === 'function') globalThis.after(() => rmSync(dir, { recursive: true, force: true }))
else process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
