// The match-and-replace rules of `edit`: exact, counted, and refusing to guess.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEdit } from '../lib/edit.js'

const req = over => ({ content: 'alpha\nbeta\ngamma\n', oldText: 'beta', newText: 'BETA', ...over })

test('a single exact match replaces and reports both byte sizes', () => {
  const out = applyEdit(req())
  assert.equal(out.ok, true)
  assert.equal(out.text, 'alpha\nBETA\ngamma\n')
  assert.equal(out.count, 1)
  assert.equal(out.bytesBefore, Buffer.byteLength('alpha\nbeta\ngamma\n'))
  assert.equal(out.bytesAfter, Buffer.byteLength('alpha\nBETA\ngamma\n'))
})

test('an empty needle or an identical swap is refused before anything is written', () => {
  assert.equal(applyEdit(req({ oldText: '' })).reason, 'empty')
  assert.equal(applyEdit(req({ newText: 'beta' })).reason, 'identical')
})

test('a missing needle says so, and hints to copy from a read', () => {
  const out = applyEdit(req({ oldText: 'delta' }))
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'not-found')
  assert.match(out.hint, /Read the file first/)
})

test('an ambiguous match counts itself and refuses to choose', () => {
  const out = applyEdit(req({ content: 'x x x', oldText: 'x', newText: 'y' }))
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'ambiguous')
  assert.equal(out.found, 3)
  assert.match(out.message, /appears 3 times/)
  assert.match(out.hint, /all \(or replaceFirst\)/)
})

test('all replaces every occurrence; replaceFirst takes only the head', () => {
  const many = applyEdit(req({ content: 'x x x', oldText: 'x', newText: 'y', all: true }))
  assert.equal(many.ok, true)
  assert.equal(many.text, 'y y y')
  assert.equal(many.count, 3)
  const one = applyEdit(req({ content: 'x x x', oldText: 'x', newText: 'y', replaceFirst: true }))
  assert.equal(one.ok, true)
  assert.equal(one.text, 'y x x')
  assert.equal(one.count, 1)
})

test('an empty newText deletes the matched text', () => {
  const out = applyEdit(req({ newText: '' }))
  assert.equal(out.ok, true)
  assert.equal(out.text, 'alpha\n\ngamma\n')
})

test('whitespace and indentation are part of the needle', () => {
  assert.equal(applyEdit(req({ oldText: 'beta ', newText: 'x' })).reason, 'not-found')
  const indented = applyEdit({ content: '  beta\n', oldText: '  beta', newText: 'x' })
  assert.equal(indented.ok, true)
})

// ── previewEdit: what a dry run shows, and what it admits it cut ───────────
import { previewEdit } from '../lib/edit.js'

test('previewEdit trims the unchanged ends and shows only the change with context', () => {
  const before = ['one', 'two', 'three', 'four', 'five'].join('\n')
  const after = ['one', 'two', 'TWO', 'four', 'five'].join('\n')
  const out = previewEdit(before, after)
  assert.equal(out.text, after)
  assert.deepEqual(out.diff.split('\n'), [' one', ' two', '-three', '+TWO', ' four', ' five'])
  assert.equal(out.truncated, false)
  assert.equal(out.bytesBefore, Buffer.byteLength(before))
  assert.equal(out.bytesAfter, Buffer.byteLength(after))
})

test('previewEdit caps a long change and says so instead of drowning the reader', () => {
  const before = Array.from({ length: 100 }, (_, i) => `old ${String(i)}`).join('\n')
  const after = Array.from({ length: 100 }, (_, i) => `new ${String(i)}`).join('\n')
  const out = previewEdit(before, after, 10)
  const lines = out.diff.split('\n')
  assert.equal(lines.length, 11)
  assert.match(lines[10], /90 more line\(s\) not shown/)
  assert.equal(out.truncated, true)
})

test('previewEdit of an identical text is an empty diff, not a fake hunk', () => {
  const same = 'x\ny\n'
  const out = previewEdit(same, same)
  assert.equal(out.diff, '')
  assert.equal(out.truncated, false)
})

// ── the shell sequence one guarded edit runs, stated where it can be read ───
const guards = await import('../lib/edit.js')

test('the edit read asks for the file, its version, and its digest in one round trip', () => {
  const command = guards.buildEditRead("'/etc/f'")
  assert.match(command, /^if \[ ! -f '\/etc\/f' \]; then exit 20; fi/)
  assert.match(command, /stat -c '%i\|%s\|%y' -- '\/etc\/f'/)
  // The digest marker is what lets a later claim be about content and not about
  // length, so it has to arrive before the body does.
  assert.match(command, /printf 'ssh-plugin-sha256: %s\\n'/)
  assert.match(command, /sha256sum -- '\/etc\/f'/)
  assert.match(command, /shasum -a 256 -- '\/etc\/f'/)
  assert.match(command, /openssl dgst -sha256 '\/etc\/f'/)
  assert.ok(command.indexOf("ssh-plugin-sha256") < command.indexOf('cat --'), 'the marker must precede the body')
  assert.ok(command.indexOf('printf') < command.indexOf('cat --'), 'the marker must precede the body')
})

test('the version and digest markers split from the file without touching either', () => {
  const split = guards.splitEditVersion("ssh-plugin: 7|5|2026-01-01 00:00:00.0 +0800\nssh-plugin-sha256: aa\nfirst line\nsecond\n")
  assert.equal(split.version, '7|5|2026-01-01 00:00:00.0 +0800')
  assert.equal(split.digest, 'aa')
  assert.equal(split.content, 'first line\nsecond\n')
  // A server with no checksum tool prints the marker empty: the edit runs, and the
  // result says the content was never digested.
  const noTool = guards.splitEditVersion('ssh-plugin: 7|5|t\nssh-plugin-sha256: \nbody\n')
  assert.equal(noTool.version, '7|5|t')
  assert.equal(noTool.digest, undefined)
  assert.equal(noTool.content, 'body\n')
  // A server whose `stat` cannot answer leaves the first marker empty.
  const blind = guards.splitEditVersion('ssh-plugin: \nssh-plugin-sha256: bb\nbody\n')
  assert.equal(blind.version, undefined)
  assert.equal(blind.digest, 'bb')
  assert.equal(blind.content, 'body\n')
  // The shape this protocol had before the digest existed is still read correctly:
  // the body starts at the second line, and nothing claims a digest was taken.
  const legacy = guards.splitEditVersion('ssh-plugin: 7|5|t\nbody\n')
  assert.equal(legacy.version, '7|5|t')
  assert.equal(legacy.digest, undefined)
  assert.equal(legacy.content, 'body\n')
  // A reply with no marker at all is plain file text, exactly as the read path has
  // always treated it — including a file whose own first line looks like a digest.
  const plain = guards.splitEditVersion('just a file\n')
  assert.equal(plain.version, undefined)
  assert.equal(plain.digest, undefined)
  assert.equal(plain.content, 'just a file\n')
  assert.equal(guards.splitEditVersion('').content, '')
})

// ── K-6: the split is by position and value-shape, never by "this line looks ──
// ── like a marker", so a file that speaks the plugin's own vocabulary is kept ──
test('the read carries the body byte count so the split can be proved, not guessed', () => {
  const command = guards.buildEditRead("'/etc/f'")
  assert.match(command, /printf 'ssh-plugin-bytes: %s\\n'/u, 'the header states how many bytes of file follow')
  assert.match(command, /wc -c < '\/etc\/f'/u, 'and it asks the server, not this process, for that count')
  // The count marker rides between the digest and the body: header first, then the
  // file, so nothing the file says can be read back as part of the header.
  assert.ok(command.indexOf('ssh-plugin-bytes') < command.indexOf('cat --'), 'the byte count precedes the body')
  // A modern read answers three header lines then the file; the split consumes all
  // three and hands back the declared count.
  const hex = 'a'.repeat(64)
  const body = 'first line\nsecond\n'
  const read = `ssh-plugin: 7|${Buffer.byteLength(body)}|2026-01-01 00:00:00.000000000 +0800\nssh-plugin-sha256: ${hex}\nssh-plugin-bytes: ${String(Buffer.byteLength(body))}\n${body}`
  const split = guards.splitEditVersion(read)
  assert.equal(split.version, `7|${Buffer.byteLength(body)}|2026-01-01 00:00:00.000000000 +0800`)
  assert.equal(split.digest, hex)
  assert.equal(split.bodyBytes, Buffer.byteLength(body), 'the declared body size is surfaced for a caller to verify')
  assert.equal(split.content, body, 'and the body is exactly the file, not one line short')
})

test('a body whose own lines look like markers is never eaten by the split', () => {
  // The whole K-6 hazard: a file that begins with text shaped like the plugin's
  // headers. Under the old prefix-only split these lines were stripped as if they
  // were the read's own markers. They are the file.
  const hex = 'b'.repeat(64)
  const body = [
    'ssh-plugin-sha256: not-the-real-digest-line',
    'ssh-plugin: 999|888|looks-like-a-version-token',
    'ssh-plugin-bytes: 424242',
    'ssh-plugin: a plain sentence that is not a stat token',
    'the real end',
  ].join('\n')
  const read = `ssh-plugin: 7|${Buffer.byteLength(body)}|2026-01-01 00:00:00.000000000 +0800\nssh-plugin-sha256: ${hex}\nssh-plugin-bytes: ${String(Buffer.byteLength(body))}\n${body}`
  const split = guards.splitEditVersion(read)
  assert.equal(split.content, body, 'the file keeps every one of its marker-looking lines')
  assert.equal(split.digest, hex, 'only the real header digest is taken')
  assert.equal(split.bodyBytes, Buffer.byteLength(body))
  assert.equal(split.version, `7|${Buffer.byteLength(body)}|2026-01-01 00:00:00.000000000 +0800`)
})

test('a version marker is only a header when its value is a stat token or empty', () => {
  // A shell that could not run `printf` at all, so the read answered with the file
  // alone — and that file's first line begins with the plugin's own word. The old
  // split saw `ssh-plugin:` and ate the line; the shape test refuses to, because
  // `a note about the plugin` is not `123|456|…`.
  const file = 'ssh-plugin: a note about the plugin\nsecond line\n'
  const split = guards.splitEditVersion(file)
  assert.equal(split.version, undefined, 'a non-stat line is not a version marker')
  assert.equal(split.digest, undefined)
  assert.equal(split.content, file, 'so the whole text is the file, line one included')
  // The same holds one layer down: a body whose first line looks like the digest
  // marker, with no version marker ahead of it, is not a header at all.
  const shaFile = 'ssh-plugin-sha256: deadbeefcafe\nnext\n'
  assert.equal(guards.splitEditVersion(shaFile).content, shaFile)
  // But a version line with an empty value (this server\'s `stat` could not answer)
  // IS still a header, so the guard machinery knows it was offered and got nothing.
  const emptyVersion = guards.splitEditVersion('ssh-plugin: \nssh-plugin-sha256: \nssh-plugin-bytes: \nbody\n')
  assert.equal(emptyVersion.version, undefined)
  assert.equal(emptyVersion.digest, undefined)
  assert.equal(emptyVersion.bodyBytes, undefined)
  assert.equal(emptyVersion.content, 'body\n', 'the three empty-valued markers are consumed, the file is not')
})

test('the edit write guards, copies, replaces, and re-checks by digest, in that order', () => {
  const command = guards.buildEditWrite({
    pathArg: "'/etc/f'",
    backupArg: "'/etc/f.dsh-bak'",
    version: '7|15|2026-01-01 00:00:00.000000000 +0800',
    originalSha256: 'o'.repeat(64),
    expectedBytes: 13,
    expectedSha256: 'e'.repeat(64),
    keepBackup: true
  })
  const at = needle => command.indexOf(needle)
  const steps = [at('cp -p --'), at('cat > '), at('"$size" != 13'), at('"$now" !=')]
  assert.ok(steps.every(index => index > 0), JSON.stringify(steps))
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b), 'the order is the promise')
  // The pre-write digest is taken before the file is truncated, and any refusal it
  // supports comes before the copy: a content change since the read means this edit
  // is not the one the reader is looking at.
  assert.ok(at('pre=$(') < at('cp -p --'), 'the state before the write is measured first')
  assert.ok(at('"$pre" !=') < at('cp -p --'), 'a same-size rewrite since the read is refused before anything moves')
  // The point of the whole exercise: the digest of what **landed** is compared after
  // the write, and the byte count alone no longer closes the command.
  assert.ok(at('"$now" =') === -1 && at('"$now" !=') > at('cat > '), 'the content is digested from what landed, not from what was sent')
  assert.match(command, /exit 21/) // a change since the read stops the edit
  assert.match(command, /exit 22/) // no safety copy, no write
  assert.match(command, /exit 23/) // the body stopped arriving
  assert.match(command, /exit 24/) // a short write is not a success
  assert.match(command, /exit 28/) // same length, different bytes
  assert.match(command, /exit 29/) // same length, and nothing on this server can tell
  assert.equal(command.includes('mv '), false, 'a rename would move the inode out from under the links')
  assert.equal(command.includes('rm -f'), false, 'the reader asked for the backup to stay')
})

test('a version token is quoted as one word, and an absent one leaves no guard behind', () => {
  const odd = guards.buildEditWrite({ pathArg: "'/f'", backupArg: "'/b'", version: "7|1|it's 00:00", originalSha256: 'a'.repeat(64), expectedBytes: 2, expectedSha256: 'b'.repeat(64), keepBackup: true })
  assert.match(odd, /!= '7\|1\|it'\\''s 00:00'/u)
  const blind = guards.buildEditWrite({ pathArg: "'/f'", backupArg: "'/b'", version: undefined, expectedBytes: 2, expectedSha256: 'b'.repeat(64), keepBackup: false })
  assert.equal(blind.includes('stat -c'), false)
  assert.match(blind, /cp -p -- '\/f' '\/b'/) // the copy is not optional
  assert.match(blind, /rm -f -- '\/b'/) // and it goes away once the write is verified
  // A write with no original digest to compare against still checks what landed —
  // the guard is one-sided, the verification is not.
  assert.match(blind, /if \[ -n "\$pre" \] && \[ -n '' \]/u) // nothing to compare the read's digest against
  assert.ok(blind.includes(`"$now" != '${'b'.repeat(64)}'`), 'the digest this edit promised is the one that closes it')
})

test('the repair child states its verdict together with the evidence behind it', () => {
  const command = guards.buildEditRestore({ pathArg: "'/f'", backupArg: "'/b'", originalBytes: 15, intendedBytes: 13, expectedSha256: 'e'.repeat(64), originalSha256: 'o'.repeat(64), keepBackup: true })
  // A write that landed is not undone: the content is checked before the copy is read.
  assert.ok(command.indexOf('landed digest') < command.indexOf('cp -p --'), 'the landed answer comes first')
  assert.match(command, /ssh-plugin: landed digest \$size \$now/u)
  assert.match(command, /ssh-plugin: landed sizeonly \$size -/u) // a server with no tool still says landed, quietly
  assert.match(command, /if \[ ! -f '\/b' \]/u)
  assert.match(command, /ssh-plugin: intact digest \$size \$now/u)
  assert.match(command, /ssh-plugin: intact sizeonly \$size -/u)
  assert.match(command, /ssh-plugin: intact none \$size -/u) // no reference to compare, so no proof
  assert.match(command, /ssh-plugin: unrecoverable/u) // the copy could not be applied
  assert.match(command, /ssh-plugin: partial/u) // it came back as something else
  // A restore is only `restored` when the file digests as the copy it came from.
  assert.match(command, /"\$after" = "\$bak"/u)
  assert.match(command, /echo "ssh-plugin: restored digest \$size \$after"; true; exit 0; fi/u)
  // An unreadable file states `-` for its size rather than inventing a zero.
  assert.match(command, /size=\$\{size:--\}/u)
  const cleaned = guards.buildEditRestore({ pathArg: "'/f'", backupArg: "'/b'", originalBytes: 15, intendedBytes: 13, expectedSha256: 'e'.repeat(64), keepBackup: false })
  assert.match(cleaned, /restored digest \$size \$after"; rm -f -- '\/b'/u)
  const refused = guards.buildEditRestore({ pathArg: "'/f'", backupArg: "'/b'", originalBytes: 15, intendedBytes: 13, expectedSha256: 'e'.repeat(64), preSha256: 'p'.repeat(64), keepBackup: false })
  assert.match(refused, /partial digest \$size \$after"; exit 26/u)
  assert.equal(refused.indexOf('rm -f --') > refused.indexOf('partial digest'), false, 'a verdict this plugin cannot vouch for keeps the copy')
})

test('a write answer counts as verified only when it carries a digest', () => {
  const verified = guards.parseWriteReport(`ssh-plugin: pre ${'p'.repeat(64)}\nssh-plugin: ok digest ${'d'.repeat(64)}`)
  assert.equal(verified.evidence, 'digest')
  assert.equal(verified.sha256, 'd'.repeat(64))
  assert.equal(verified.preSha256, 'p'.repeat(64))
  const counted = guards.parseWriteReport(`ssh-plugin: pre ${'p'.repeat(64)}\nssh-plugin: ok sizeonly 17`)
  assert.equal(counted.evidence, 'sizeonly')
  assert.equal(counted.sha256, undefined)
  assert.equal(counted.bytes, 17)
  const collision = guards.parseWriteReport(`ssh-plugin: pre -\nssh-plugin: mismatch 17 ${'x'.repeat(64)}`)
  assert.equal(collision.evidence, 'digest', 'a refusal to match is still a digest of the real file')
  assert.equal(collision.sha256, 'x'.repeat(64))
  assert.equal(collision.preSha256, undefined, 'a dash is the server saying it has no digest, not a digest named dash')
  assert.equal(collision.bytes, 17)
  // An answer that never arrived, or arrived as anything else, is not evidence.
  assert.equal(guards.parseWriteReport(undefined).evidence, 'none')
  assert.equal(guards.parseWriteReport('').evidence, 'none')
  assert.equal(guards.parseWriteReport('ssh-plugin: ok digest').evidence, 'none')
})

test('a repair verdict needs a digest to be believed', () => {
  const restored = guards.parseRepairReport('ssh-plugin: restored digest 17 abc')
  assert.equal(restored.verdict, 'restored')
  assert.equal(restored.contentVerified, true)
  assert.equal(restored.bytes, 17)
  assert.equal(restored.sha256, 'abc')
  // The same verdict reached by counting is a different claim, and the caller has
  // to be able to tell them apart.
  const counted = guards.parseRepairReport('ssh-plugin: restored sizeonly 17 -')
  assert.equal(counted.verdict, 'restored')
  assert.equal(counted.contentVerified, false)
  assert.equal(counted.sha256, undefined)
  const unattributed = guards.parseRepairReport('ssh-plugin: intact none 17 -')
  assert.equal(unattributed.evidence, 'none')
  assert.equal(unattributed.contentVerified, false)
  const unreadable = guards.parseRepairReport('ssh-plugin: unrecoverable sizeonly - -')
  assert.equal(unreadable.verdict, 'unrecoverable')
  assert.equal(unreadable.bytes, undefined, 'the server could not read the file, and says so')
  assert.equal(guards.parseRepairReport('').verdict, undefined)
  assert.equal(guards.parseRepairReport('cat: /f: No such file\nssh-plugin: landed digest 3 abc').verdict, 'landed')
  assert.equal(guards.parseRepairReport('ssh-plugin: landed 13').contentVerified, false, 'the old two-word marker proves nothing')
})

test('the digest a local edit is checked against is the digest of the bytes sent', () => {
  // NIST's own vectors, so a changed algorithm or encoding shows up here first.
  assert.equal(guards.digestHex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(guards.digestHex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(guards.digestHex('alpha\nbeta\ngamma\n'), guards.digestHex('alpha\nbeta\ngamma\n'), 'and it is stable')
  assert.notEqual(guards.digestHex('alpha\nbeta\ngamma\n'), guards.digestHex('alpha\nBETA\ngamma\n'), 'a same-size change moves it')
})
