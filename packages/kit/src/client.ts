// Browser helpers shared by the units' pages (bundled into each; no shared state).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FeedMessage, Selection } from '@learning-agent/contracts'
import type { LearnShell, ShellScope } from '@learning-agent/contracts/client'

export interface Loaded<T> {
  readonly data: T | undefined
  readonly error: string | undefined
  readonly loading: boolean
  reload(): void
}

/**
 * Load page data and reload it when the change feed reports something relevant.
 * `refreshOn` picks feed messages by type prefix (default: every `learning/` event).
 */
export function useLoad<T>(
  shell: LearnShell,
  load: () => Promise<T>,
  deps: readonly unknown[],
  refreshOn: readonly string[] = ['learning/'],
): Loaded<T> {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true })
  const loadRef = useRef(load)
  loadRef.current = load
  const generation = useRef(0)

  const reload = useCallback(() => {
    const mine = ++generation.current
    setState(previous => ({ ...previous, loading: true }))
    loadRef.current().then(
      data => { if (mine === generation.current) setState({ data, loading: false }) },
      (error: unknown) => { if (mine === generation.current) setState(previous => ({ ...previous, error: describeError(error), loading: false })) },
    )
  }, [])

  useEffect(reload, deps)

  const refreshKey = refreshOn.join('|')
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const prefixes = refreshKey.split('|')
    const dispose = shell.onFeed((message: FeedMessage) => {
      if (!prefixes.some(prefix => message.type.startsWith(prefix))) return
      clearTimeout(timer)
      timer = setTimeout(reload, 150)
    })
    return () => {
      clearTimeout(timer)
      dispose()
    }
  }, [shell, reload, refreshKey])

  return { data: state.data, error: state.error, loading: state.loading, reload }
}

/** Run an action, keeping its busy flag and error for the button that triggered it. */
export function useAction(): { busy: boolean; error: string | undefined; run(action: () => Promise<unknown>): Promise<void> } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const run = useCallback(async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, run }
}

export function useScope(shell: LearnShell): ShellScope {
  return useSyncExternalStore(listener => shell.onScope(listener), () => shell.scope())
}

export function useSelection(shell: LearnShell): Selection | undefined {
  return useSyncExternalStore(listener => shell.onSelection(listener), () => shell.selection())
}

/** A readable message for errors thrown by `learnShell.call` (LearningError) or anything else. */
export function describeError(error: unknown): string {
  const record = error as { code?: unknown; message?: unknown } | null
  if (record && typeof record.code === 'string' && typeof record.message === 'string') return `${record.message}（${record.code}）`
  return String((error as Error)?.message ?? error)
}

/** Read a per-browser preference (layout, folded sections); storage may be missing or blocked. */
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(`learning:${key}`)
    return raw === null || raw === undefined ? fallback : JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeLocal(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(`learning:${key}`, JSON.stringify(value))
  } catch {
    // Preferences are a convenience; without storage they last until the page reloads.
  }
}

/** `useState` remembered in this browser (only for view preferences, never learning data). */
export function useLocalState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => readLocal(key, initial))
  const set = useCallback((next: T) => {
    setValue(next)
    writeLocal(key, next)
  }, [key])
  return [value, set]
}

/** `2026-10-03T11:06:26Z` → `10-03 19:06` in local time. */
export function shortTime(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
/** `今天 19:06`, `昨天 08:30`, `10月3日`: for lists where the day matters more than the minute. */
export function friendlyTime(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  const days = Math.round((new Date(new Date().toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000)
  if (days === 0) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (days === 1) return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export * from './client/ui.tsx'
