// `useLoad`'s state (client.ts), kept apart so it can be tested without React. `deps` name the data: while the same data
// refreshes the old stays on screen, also when the refresh fails; once they change it is gone from that very render, so
// one course's data can neither show under nor be written back to another.

export interface LoadState<T> {
  readonly deps: readonly unknown[]
  readonly data?: T
  readonly error?: string
  readonly loading: boolean
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
}

function kept<T>(state: LoadState<T>, deps: readonly unknown[]): Pick<LoadState<T>, 'data'> {
  return sameDeps(state.deps, deps) && state.data !== undefined ? { data: state.data } : {}
}

/** A load of the data `deps` name has begun. */
export function loadStarted<T>(state: LoadState<T>, deps: readonly unknown[]): LoadState<T> {
  return { ...kept(state, deps), loading: true, deps }
}

/** It failed: what was on screen for the same data stays, beside the error. */
export function loadFailed<T>(state: LoadState<T>, deps: readonly unknown[], error: string): LoadState<T> {
  return { ...kept(state, deps), error, loading: false, deps }
}

/** What the page sees in a render with these `deps`, before their load has begun if they just changed. */
export function loadShown<T>(state: LoadState<T>, deps: readonly unknown[]): Pick<LoadState<T>, 'data' | 'error' | 'loading'> {
  if (!sameDeps(state.deps, deps)) return { loading: true }
  return state
}
