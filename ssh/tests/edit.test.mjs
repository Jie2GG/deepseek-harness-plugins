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
