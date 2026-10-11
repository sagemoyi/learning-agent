// Database ids sort in the order they were made (contracts §4.2): within one millisecond they count up, so a sort that
// breaks ties by id (e.g. assess choosing between equally good problems) keeps creation order instead of a random one.
import { expect, it } from 'vitest'
import { newId, ulid } from '@learning-agent/contracts'

it('counts ids made in the same millisecond up, and starts afresh in a new one', () => {
  const at = Date.UTC(2026, 9, 11, 2, 0, 0)
  const same = Array.from({ length: 200 }, () => ulid(at))
  expect([...same].sort()).toEqual(same)
  expect(new Set(same).size).toBe(same.length)
  expect(same.every(id => id.slice(0, 10) === same[0]!.slice(0, 10))).toBe(true)
  const later = ulid(at + 1)
  expect(later > same.at(-1)!).toBe(true)
  // Ids made in a row by newId keep their order too.
  const made = Array.from({ length: 50 }, () => newId('problem'))
  expect([...made].sort()).toEqual(made)
})
