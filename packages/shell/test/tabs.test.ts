import { describe, expect, it } from 'vitest'
import { HISTORY_LIMIT, NEW_TAB_PAGE, RECENT_LIMIT, current, go, mounted, navigate, readTab, remember, samePlace, target, touch, type Entry, type Tab } from '../src/client/tabs.ts'

let n = 0
const entry = (page: string, params: Record<string, unknown> = {}): Entry => ({ key: `e${n++}`, page, params, title: page })
const tabOf = (...pages: string[]): Tab => pages.reduce<Tab>((tab, page) => navigate(tab, entry(page)), { entries: [entry('start')], at: 0 })
const pages = (tab: Tab) => tab.entries.map(item => item.page)

describe('where a page opens', () => {
  it('replaces the current page, unless the tab is pinned, there is no tab, or the click asks for a new one', () => {
    expect(target({}, false, {})).toBe('current')
    expect(target({}, false, { pinned: true })).toBe('new')
    expect(target({}, false, undefined)).toBe('new')
    expect(target({}, true, {})).toBe('new')
    expect(target({ newTab: true }, false, {})).toBe('new')
  })

  it('puts a source in the right sidebar and a split in a new column, but a new-tab click still opens a tab', () => {
    expect(target({ side: true }, false, {})).toBe('side')
    expect(target({ side: true }, false, { pinned: true })).toBe('side')
    expect(target({ split: true }, false, {})).toBe('split')
    expect(target({ side: true }, true, {})).toBe('new')
  })

  it('treats params written in another order as the same place', () => {
    expect(samePlace({ page: 'textbook.reader', params: { id: 'ls_1', courseId: 'co_1' } }, 'textbook.reader', { courseId: 'co_1', id: 'ls_1' })).toBe(true)
    expect(samePlace({ page: 'textbook.reader', params: { id: 'ls_1' } }, 'textbook.reader', { id: 'ls_2' })).toBe(false)
    expect(samePlace({ page: 'textbook.reader', params: {} }, 'assess.tests', {})).toBe(false)
  })
})

describe('a tab\'s history', () => {
  it('goes back and forward, and drops what was ahead when it goes somewhere new', () => {
    const tab = tabOf('a', 'b', 'c')
    expect(current(tab).page).toBe('c')
    const back = go(go(tab, -1)!, -1)!
    expect(current(back).page).toBe('a')
    expect(go(back, -1)!.at).toBe(0)
    expect(go(go(back, -1)!, -1)).toBeUndefined()
    expect(current(go(back, 1)!).page).toBe('b')
    expect(go(tab, 1)).toBeUndefined()
    const branched = navigate(back, entry('d'))
    expect(pages(branched)).toEqual(['start', 'a', 'd'])
    expect(go(branched, 1)).toBeUndefined()
  })

  it('keeps the last 50 steps', () => {
    const long = tabOf(...Array.from({ length: HISTORY_LIMIT + 5 }, (_, index) => `p${index}`))
    expect(long.entries).toHaveLength(HISTORY_LIMIT)
    expect(current(long).page).toBe(`p${HISTORY_LIMIT + 4}`)
    expect(long.entries[0]!.page).toBe('p5')
  })

  it('keeps the current page mounted with two behind and one ahead', () => {
    const tab = tabOf('a', 'b', 'c', 'd')
    expect(mounted(tab).map(item => item.page)).toEqual(['b', 'c', 'd'])
    expect(mounted(go(go(tab, -1)!, -1)!).map(item => item.page)).toEqual(['start', 'a', 'b', 'c'])
  })

  it('reads a saved tab back, and gives up on one that is malformed', () => {
    const tab = { ...tabOf('a', 'b'), pinned: true }
    expect(readTab(JSON.parse(JSON.stringify(tab)))).toEqual(tab)
    expect(readTab({ ...tab, at: 9 })!.at).toBe(2)
    expect(readTab({ entries: [], at: 0 })).toBeUndefined()
    expect(readTab({ entries: [{ page: 'a' }], at: 0 })).toBeUndefined()
    expect(readTab({ page: 'library.sources', params: {} })).toBeUndefined()
  })
})

describe('tabs in the background and the recent list', () => {
  it('orders tabs by when they were last shown', () => {
    expect(touch(['t1', 't2', 't3'], 't3')).toEqual(['t3', 't1', 't2'])
    expect(touch([], 't1')).toEqual(['t1'])
  })

  it('lists each page once, newest first, without the new-tab page', () => {
    let list = remember([], { page: 'textbook.reader', params: { id: 'ls_1' }, title: '1.1' })
    list = remember(list, { page: 'assess.tests', params: {}, title: '测试' })
    list = remember(list, { page: 'textbook.reader', params: { id: 'ls_1' }, title: '1.1 压强' })
    list = remember(list, { page: NEW_TAB_PAGE, params: {}, title: '新标签页' })
    expect(list.map(item => item.title)).toEqual(['1.1 压强', '测试'])
    for (let index = 0; index < 20; index++) list = remember(list, { page: 'assess.test', params: { id: index }, title: `t${index}` })
    expect(list).toHaveLength(RECENT_LIMIT)
  })
})
