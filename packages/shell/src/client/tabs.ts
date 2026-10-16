// The rules of tabs (docs/shell/design.md "10-12 试用后的改版"): where `openPage` puts a page, each tab's
// back/forward history, which pages stay mounted, and the recently opened list. Pure, so they are tested
// without dockview; the shell keeps one `Tab` in each dockview panel's params, saved with the layout.

/** One step of a tab's history: a page with its params. */
export interface Entry {
  /** Unique in this browser: the page instance's React key and the key of its remembered scroll position. */
  readonly key: string
  readonly page: string
  readonly params: Readonly<Record<string, unknown>>
  readonly title: string
  /** Counted up by 刷新: the page mounts again and loads from scratch. */
  readonly reloads?: number
}

export interface Tab {
  readonly entries: readonly Entry[]
  readonly at: number
  /** A pinned tab is never navigated away: pages opened from it go to a new tab. */
  readonly pinned?: boolean
}

export const HISTORY_LIMIT = 50
/** Entries kept mounted around the current one, so going back or forward finds them as they were. */
export const KEEP_BEHIND = 2
export const KEEP_AHEAD = 1
/** Tabs whose pages stay mounted in the background, most recently shown first. */
export const LIVE_TABS = 8
export const RECENT_LIMIT = 12

/** The page a new tab shows ("+", or after the last tab is closed); the shell draws it itself. */
export const NEW_TAB_PAGE = 'shell.new-tab'

export function current(tab: Tab): Entry {
  return tab.entries[tab.at]!
}

/** Same page with the same params, whatever order their keys were written in. */
export function samePlace(entry: Pick<Entry, 'page' | 'params'>, page: string, params: Readonly<Record<string, unknown>>): boolean {
  return entry.page === page && canonical(entry.params) === canonical(params)
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : item))
}

/** Where a page opens: a modifier click or `newTab` wins; no tab or a pinned one means a new tab. */
export function target(options: { readonly newTab?: boolean; readonly split?: boolean; readonly side?: boolean }, modifier: boolean, active: { readonly pinned?: boolean } | undefined): 'new' | 'split' | 'side' | 'current' {
  if (options.newTab || modifier) return 'new'
  if (options.split) return 'split'
  if (options.side) return 'side'
  return !active || active.pinned ? 'new' : 'current'
}

/** Go to a page: what was ahead of the current entry is dropped, the oldest beyond the limit too. */
export function navigate(tab: Tab, entry: Entry): Tab {
  const entries = [...tab.entries.slice(0, tab.at + 1), entry].slice(-HISTORY_LIMIT)
  return { ...tab, entries, at: entries.length - 1 }
}

/** Back (-1) or forward (+1); undefined when there is nothing that way. */
export function go(tab: Tab, delta: number): Tab | undefined {
  const at = tab.at + delta
  return at >= 0 && at < tab.entries.length ? { ...tab, at } : undefined
}

export function updateEntry(tab: Tab, key: string, change: (entry: Entry) => Entry): Tab {
  return { ...tab, entries: tab.entries.map(entry => (entry.key === key ? change(entry) : entry)) }
}

/** The entries kept mounted: the current one, two behind and one ahead. */
export function mounted(tab: Tab): Entry[] {
  return tab.entries.slice(Math.max(0, tab.at - KEEP_BEHIND), tab.at + KEEP_AHEAD + 1)
}

/** A tab read back from saved params; anything malformed gives undefined (the layout is only a preference). */
export function readTab(value: unknown): Tab | undefined {
  const record = value as { entries?: unknown; at?: unknown; pinned?: unknown } | null
  if (!record || !Array.isArray(record.entries) || typeof record.at !== 'number') return undefined
  const entries = record.entries.filter((entry): entry is Entry => {
    const item = entry as Partial<Entry> | null
    return Boolean(item) && typeof item!.key === 'string' && typeof item!.page === 'string' && typeof item!.title === 'string' && Boolean(item!.params) && typeof item!.params === 'object'
  })
  if (entries.length !== record.entries.length || entries.length === 0) return undefined
  return { entries, at: Math.min(Math.max(0, Math.round(record.at)), entries.length - 1), ...(record.pinned === true ? { pinned: true } : {}) }
}

/** Move a tab to the front of the most-recently-shown order. */
export function touch(order: readonly string[], id: string): string[] {
  return [id, ...order.filter(item => item !== id)]
}

export interface Recent {
  readonly page: string
  readonly params: Readonly<Record<string, unknown>>
  readonly title: string
}

/** Put a page at the top of the recently opened list, once; the new-tab page itself is not listed. */
export function remember(list: readonly Recent[], item: Recent): Recent[] {
  if (item.page === NEW_TAB_PAGE) return [...list]
  return [{ page: item.page, params: item.params, title: item.title }, ...list.filter(other => !samePlace(other, item.page, item.params))].slice(0, RECENT_LIMIT)
}
