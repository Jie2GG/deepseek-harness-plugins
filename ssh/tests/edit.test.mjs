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

test('the edit read asks for the file and its version in the same round trip', () => {
  const command = guards.buildEditRead("'/etc/f'")
  assert.match(command, /^if \[ ! -f '\/etc\/f' \]; then exit 20; fi/)
  assert.match(command, /stat -c '%i\|%s\|%y' -- '\/etc\/f'/)
  assert.ok(command.indexOf('printf') < command.indexOf('cat --'), 'the marker must precede the body')
})

test('the version marker splits from the file without touching either', () => {
  const split = guards.splitEditVersion("ssh-plugin: 7|5|2026-01-01 00:00:00.0 +0800\nfirst line\nsecond\n")
  assert.equal(split.version, '7|5|2026-01-01 00:00:00.0 +0800')
  assert.equal(split.content, 'first line\nsecond\n')
  // A server whose `stat` cannot answer leaves the marker empty: the edit runs
  // without the guard, and the result says so rather than implying one ran.
  const blind = guards.splitEditVersion('ssh-plugin: \nbody\n')
  assert.equal(blind.version, undefined)
  assert.equal(blind.content, 'body\n')
  // A reply with no marker at all is taken as plain file text, exactly as the
  // read path has always treated it.
  const plain = guards.splitEditVersion('just a file\n')
  assert.equal(plain.version, undefined)
  assert.equal(plain.content, 'just a file\n')
  assert.equal(guards.splitEditVersion('').content, '')
})

test('the edit write guards, copies, replaces, and re-checks, in that order', () => {
  const command = guards.buildEditWrite({
    pathArg: "'/etc/f'",
    backupArg: "'/etc/f.dsh-bak'",
    version: '7|15|2026-01-01 00:00:00.000000000 +0800',
    expectedBytes: 13,
    keepBackup: true
  })
  const steps = [
    command.indexOf('cp -p --'),
    command.indexOf('cat > '),
    command.indexOf('"$size" != 13'),
  ]
  assert.ok(steps.every(at => at > 0), JSON.stringify(steps))
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b), 'the order is the promise')
  assert.match(command, /exit 21/) // a change since the read stops the edit
  assert.match(command, /exit 22/) // no safety copy, no write
  assert.match(command, /exit 23/) // the body stopped arriving
  assert.match(command, /exit 24/) // a short write is not a success
  assert.equal(command.includes('mv '), false, 'a rename would move the inode out from under the links')
  assert.equal(command.includes('rm -f'), false, 'the reader asked for the backup to stay')
})

test('a version token is quoted as one word, and an absent one leaves no guard behind', () => {
  const odd = guards.buildEditWrite({ pathArg: "'/f'", backupArg: "'/b'", version: "7|1|it's 00:00", expectedBytes: 2, keepBackup: true })
  assert.match(odd, /!= '7\|1\|it'\\''s 00:00'/u)
  const blind = guards.buildEditWrite({ pathArg: "'/f'", backupArg: "'/b'", version: undefined, expectedBytes: 2, keepBackup: false })
  assert.equal(blind.includes('stat -c'), false)
  assert.match(blind, /cp -p -- '\/f' '\/b'/) // the copy is not optional
  assert.match(blind, /rm -f -- '\/b'/) // and it goes away once the write is verified
})

test('the repair child reports which of four things it found', () => {
  const command = guards.buildEditRestore({ pathArg: "'/f'", backupArg: "'/b'", originalBytes: 15, intendedBytes: 13, keepBackup: true })
  // A write that landed is not undone: the size is checked before the copy is read.
  assert.ok(command.indexOf("= 13 ]; then exit 27") < command.indexOf('cp -p --'), 'the landed answer comes first')
  assert.match(command, /ssh-plugin: landed/)
  // No copy at all means nothing was ever truncated, which is a different sentence
  // from a repair, and must not be reported as one.
  assert.match(command, /if \[ ! -f '\/b' \]; then echo "ssh-plugin: intact \$size"; exit 0; fi/)
  assert.match(command, /ssh-plugin: unrecoverable/u) // the copy could not be applied
  assert.match(command, /ssh-plugin: partial/u) // it came back at the wrong size
  assert.match(command, /\$after" != 15/u)
  assert.match(command, /echo 'ssh-plugin: restored'; true$/)
  const cleaned = guards.buildEditRestore({ pathArg: "'/f'", backupArg: "'/b'", originalBytes: 15, intendedBytes: 13, keepBackup: false })
  assert.match(cleaned, /echo 'ssh-plugin: restored'; rm -f -- '\/b'$/)
})
