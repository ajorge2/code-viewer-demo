import test from 'node:test'
import assert from 'node:assert/strict'

import { sourceRangeLabel } from '../client/src/lib/sourceRange.js'

const text = 'alpha\nbeta\ngamma'

test('source range labels a single highlighted line', () => {
  assert.equal(sourceRangeLabel(text, { start: 6, end: 10 }), 'Line 2')
})

test('source range labels every line touched by a highlight', () => {
  assert.equal(sourceRangeLabel(text, { start: 2, end: 9 }), 'Lines 1–2')
})

test('source range treats the end offset as exclusive', () => {
  assert.equal(sourceRangeLabel(text, { start: 0, end: 6 }), 'Line 1')
})

test('source range keeps the existing fallback for unresolved selections', () => {
  assert.equal(sourceRangeLabel('', { start: 0, end: 1 }), 'Selection')
  assert.equal(sourceRangeLabel(text, null), 'Selection')
})
