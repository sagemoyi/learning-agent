// kit (useLoad in src/client.ts): which change-feed messages reload a page's data. `[]` means none: an editor that
// reads once must not be reloaded by an unrelated push and lose what the learner typed.
import { expect, it } from 'vitest'
import { EVERY_CHANGE, reloadsOn } from '../src/feed.ts'

it('reloads on the chosen prefixes, on every learning event by default, and on nothing for an empty list', () => {
  expect(reloadsOn(['learning/textbook-', 'learning/doc-'], 'learning/doc-changed')).toBe(true)
  expect(reloadsOn(['learning/textbook-'], 'learning/test-finished')).toBe(false)
  expect(reloadsOn(EVERY_CHANGE, 'learning/test-finished')).toBe(true)
  expect(reloadsOn(EVERY_CHANGE, 'session/updated')).toBe(false)
  for (const type of ['learning/doc-changed', 'learning/test-finished', '']) expect(reloadsOn([], type)).toBe(false)
  expect(reloadsOn([''], 'learning/doc-changed')).toBe(false)
})
