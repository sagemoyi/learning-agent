import { describe, expect, it } from 'vitest'
import { newId, ulid } from '../src/ids.ts'

describe('ids', () => {
  it('sorts ids made in the same millisecond in the order they were made', () => {
    const ids = Array.from({ length: 500 }, () => ulid(1_700_000_000_000))
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('carries through the random part and still sorts by time across milliseconds', () => {
    const ids = Array.from({ length: 40 }, (_, index) => ulid(1_700_000_001_000 + Math.floor(index / 10)))
    expect([...ids].sort()).toEqual(ids)
    expect(ids.every(id => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true)
  })

  it('keeps ids of different kinds ordered when made back to back', () => {
    const made = Array.from({ length: 200 }, (_, index) => newId(index % 2 ? 'log' : 'attempt').split('_')[1]!)
    expect([...made].sort()).toEqual(made)
  })
})
