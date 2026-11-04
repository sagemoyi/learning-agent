// Where the focus goes in an open menu on a key. Disabled items are passed over.
import { expect, it } from 'vitest'
import { menuTarget } from '../src/client/menu-keys.ts'

const items = [{ label: '打开' }, { label: 'Pin', disabled: true }, { label: 'pdf' }, { label: '关闭' }, { label: 'Print' }]

it('moves with the arrows over disabled items, wrapping at the ends', () => {
  expect(menuTarget(items, -1, 'ArrowDown')).toBe(0)
  expect(menuTarget(items, 0, 'ArrowDown')).toBe(2)
  expect(menuTarget(items, 4, 'ArrowDown')).toBe(0)
  expect(menuTarget(items, 2, 'ArrowUp')).toBe(0)
  expect(menuTarget(items, 0, 'ArrowUp')).toBe(4)
})

it('goes to the ends with Home and End', () => {
  expect(menuTarget(items, 3, 'Home')).toBe(0)
  expect(menuTarget(items, 0, 'End')).toBe(4)
  expect(menuTarget([{ label: '甲', disabled: true }, { label: '乙' }], -1, 'Home')).toBe(1)
})

it('goes to the next item starting with a letter, ignoring case, and leaves other keys alone', () => {
  expect(menuTarget(items, 0, 'p')).toBe(2)
  expect(menuTarget(items, 2, 'P')).toBe(4)
  expect(menuTarget(items, 4, 'p')).toBe(2)
  expect(menuTarget(items, 0, '关')).toBe(3)
  expect(menuTarget(items, 0, 'z')).toBeUndefined()
  expect(menuTarget(items, 0, 'Shift')).toBeUndefined()
  expect(menuTarget(items, 0, ' ')).toBeUndefined()
})

it('has nowhere to go when all are disabled', () => {
  expect(menuTarget([{ label: '甲', disabled: true }], -1, 'ArrowDown')).toBeUndefined()
})
