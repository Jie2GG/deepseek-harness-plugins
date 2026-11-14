// The one rule a transfer's local side obeys: it stays inside the conversation workspace.
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveLocalInside } from '../lib/local-path.js'

test('workspace-relative and inside-absolute paths resolve onto the root', () => {
  assert.equal(resolveLocalInside('a.txt', '/ws'), '/ws/a.txt')
  assert.equal(resolveLocalInside('sub/a.txt', '/ws'), '/ws/sub/a.txt')
  assert.equal(resolveLocalInside('/ws/sub/a.txt', '/ws'), '/ws/sub/a.txt')
  assert.equal(resolveLocalInside('/ws', '/ws'), '/ws')
  assert.equal(resolveLocalInside('  a.txt ', '/ws'), '/ws/a.txt') // trimmed like every other path
})

test('a root written with a trailing slash still roots the join', () => {
  assert.equal(resolveLocalInside('a.txt', '/ws/'), '/ws/a.txt')
})

test('escaping the workspace is a bad-input refusal naming the field', () => {
  for (const [value, message] of [
    ['../outside.txt', /walks out of the conversation workspace/],
    ['/etc/passwd', /outside the conversation workspace/]
  ]) {
    let thrown
    try {
      resolveLocalInside(value, '/ws')
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown, `${value} should refuse`)
    assert.equal(thrown.code, 'bad-input')
    assert.equal(thrown.field, 'localPath')
    assert.match(thrown.message, message)
  }
})

test('a sibling whose name starts like the root is not inside it', () => {
  assert.throws(() => resolveLocalInside('/wslurp/x', '/ws'), /outside the conversation workspace/)
})

test('empty and line-broken paths refuse before any joining', () => {
  assert.throws(() => resolveLocalInside('', '/ws'), /A local path is required/)
  assert.throws(() => resolveLocalInside('a\nb', '/ws'), /cannot contain a line break/)
  assert.throws(() => resolveLocalInside('a', ''), /workspace directory is unknown/)
})
