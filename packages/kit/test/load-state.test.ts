// useLoad's state: `deps` name the data. The old data stays while the same data refreshes, also when that fails; once
// they change it is gone from that very render, so one course's data can neither show under nor be written to another.
import { expect, it } from 'vitest'
import { loadFailed, loadShown, loadStarted, type LoadState } from '../src/load-state.ts'

const A = ['A'], B = ['B']
const loaded = (deps: readonly unknown[], data: string): LoadState<string> => ({ deps, data, loading: false })

it('shows nothing of the old course in the render that switches, while it loads, or when it fails', () => {
  const inA = loaded(A, 'A 的会话')
  expect(loadShown(inA, A).data).toBe('A 的会话')
  // Before the effect that starts B's load has run.
  expect(loadShown(inA, B)).toEqual({ loading: true })
  const loadingB = loadStarted(inA, B)
  expect(loadShown(loadingB, B)).toMatchObject({ loading: true })
  expect(loadShown(loadingB, B).data).toBeUndefined()
  const failedB = loadFailed(loadingB, B, '读不出来')
  expect(loadShown(failedB, B)).toMatchObject({ error: '读不出来', loading: false })
  expect(loadShown(failedB, B).data).toBeUndefined()
  // Going back asks for A again from nothing.
  expect(loadStarted(failedB, A).data).toBeUndefined()
})

it('keeps the data while the same data refreshes, also when the refresh fails', () => {
  const inA = loaded(A, '第一版')
  const refreshing = loadStarted(inA, ['A'])
  expect(loadShown(refreshing, A)).toMatchObject({ data: '第一版', loading: true })
  expect(loadShown(loadFailed(refreshing, A, '断线了'), A)).toMatchObject({ data: '第一版', error: '断线了', loading: false })
})

it('compares deps one by one', () => {
  expect(loadShown(loaded(['A', undefined], 'x'), ['A', undefined]).data).toBe('x')
  expect(loadShown(loaded(['A', 1], 'x'), ['A', 2]).data).toBeUndefined()
  expect(loadShown(loaded(['A'], 'x'), ['A', 1]).data).toBeUndefined()
  // A load that gave nothing for this course is not data to keep.
  expect(loadStarted({ deps: A, loading: false }, A)).toEqual({ deps: A, loading: true })
})
