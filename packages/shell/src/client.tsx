// Shell, browser half. Takes over DSH's `root` slot (stage-0 V2) and owns the page frame: the rail of icons
// (course switcher, activities), the sidebar showing an activity's `learning.panel`, dockview tabs that each keep
// a back/forward history (rules in client/tabs.ts), the right sidebar (side chat, or a page opened with `side`),
// the status bar (`learning.status`) and the command palette. It declares the `learning.*` slots and provides
// `ctx.learnShell` (contracts §6.3): pages, scope, the active page, selection, the shared change-feed connection,
// endpoint calls and the shared Markdown renderer. Layout: docs/shell/design.md.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { DockviewReact, type DockviewApi, type DockviewGroupPanel, type DockviewTheme, type IDockviewHeaderActionsProps, type IDockviewPanel, type IDockviewPanelHeaderProps, type IDockviewPanelProps } from 'dockview'
import {
  ArrowLeft, ArrowRight, BookOpenText, ChevronRight, Clock, Columns2, CornerDownLeft, ExternalLink, File, GraduationCap, House, Maximize2,
  MessageCircleQuestion, Minimize2, Monitor, Moon, PanelLeftClose, PanelRightClose, Pin, PinOff, Plus, RotateCw, Search, Sun, SunMoon, X,
} from 'lucide-react'
import dockviewCss from 'dockview/dist/styles/dockview.css'
import katexCss from 'katex/dist/katex.min.css'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { API_CHANNEL, FEED_PATH, endpointName, type CitedChunk, type Course, type FeedMessage, type Id, type Selection } from '@learning-agent/contracts'
import type { ActivePage, ActivityItem, ClientContext, IconComponent, LearnShell, OpenOptions, PageFrame, ShellScope } from '@learning-agent/contracts/client'
import { ContextMenu, EmptyState, Kbd, Menu, Page, Section, readLocal, revealInList, writeLocal, type MenuEntry } from '@learning-agent/kit/client'
import { Markdown } from './client/markdown.tsx'
import { LIVE_TABS, NEW_TAB_PAGE, current, go, mounted, navigate, readTab, remember, samePlace, target, touch, updateEntry, type Entry, type Recent, type Tab } from './client/tabs.ts'
import shellCss from './shell.css'

export const name = 'learning-shell'
export const inject = ['slots', 'connection']

type Listener = () => void
type ThemePreference = 'light' | 'dark' | 'system'
type SideView = 'chat' | 'page'
/** The part of DSH's theme service (`ctx.theme`, dsh-client-ui-theme) the shell uses. */
interface ThemeService {
  getTheme(): { preference: string; active: { colorScheme: 'light' | 'dark' } }
  setTheme(id: string): void
}

const ICON = { size: 16, strokeWidth: 1.75 } as const
const APP_TITLE = '学习工作台'
const NEW_TAB_TITLE = '新标签页'
/** `--la-rail-w` in shell.css. */
const RAIL_W = 48
const PANEL_W = 264
const PANEL_MIN = 200
const PANEL_MAX = 420
/** Below these window widths the sidebar floats over the page, then the right sidebar too. */
const PANEL_FLOAT_BELOW = 1180
const DRAWER_BELOW = 1000
/** Narrowest a split-view column may get before the sidebar floats, then the right sidebar. */
const MIN_COLUMN = 360
const SIDE_MIN = 300
const SIDE_MAX = 760
const SIDE_WIDTH: Record<SideView, number> = { chat: 380, page: 520 }
/** How long a page coming back may take to grow tall enough for its remembered scroll position. */
const RESTORE_WAIT_MS = 4000

function scopeKey(scope: ShellScope): string {
  return scope.kind === 'course' ? `course:${scope.courseId}` : 'main'
}

/** The unit part of a page key: `assess.test` → `assess`. */
function unitOf(page: string): string {
  return page.split('.')[0] ?? page
}

let sequence = 0
function newKey(): string {
  return `${Date.now().toString(36)}${(sequence++).toString(36)}`
}

/** What a tab's panel params hold (dockview merges updates into them and saves them with the layout). */
function tabOf(panel: IDockviewPanel | undefined): Tab | undefined {
  return panel ? readTab(panel.params) : undefined
}

/** Observable shell state shared by the React tree and the `learnShell` service. */
class ShellState {
  activities: readonly ActivityItem[] = []
  scope: ShellScope = { kind: 'main' }
  selection: Selection | undefined
  courses: readonly Course[] = []
  coursesLoaded = false
  feed: 'connecting' | 'open' | 'error' = 'connecting'
  /** The right sidebar is open, on the side chat or on the page opened with `side`. */
  side = readLocal<boolean>('shell:side', false)
  sideView = readLocal<SideView>('shell:side-view', 'chat')
  sideWidths = { ...SIDE_WIDTH, ...readLocal<Partial<Record<SideView, number>>>('shell:side-widths', {}) }
  sidePage: Entry | undefined
  /** The activity whose panel the sidebar shows in this interface; null when folded, undefined before any choice. */
  panel: string | null | undefined
  panelWidth = readLocal<number>('shell:panel-width', PANEL_W)
  /** A floating sidebar (narrow window) is showing; it folds again after a pick or a click elsewhere. */
  peek = false
  viewport = typeof window === 'undefined' ? 1440 : window.innerWidth
  /** Split-view columns side by side in the tab area. */
  columns = 1
  palette = false
  menu: { readonly at: { readonly x: number; readonly y: number }; readonly entries: readonly MenuEntry[] } | undefined
  theme: 'light' | 'dark' = 'light'
  themePreference: ThemePreference | undefined
  /** Counts shown on rail buttons, by activity id. */
  badges: ReadonlyMap<string, number> = new Map()
  /** The page in the active tab, and its title. */
  active: (ActivePage & { readonly title: string }) | undefined
  /** A Ctrl/⌘-click or a middle click is being handled: pages it opens go to a new tab. */
  modifier = false
  /** Tab ids, most recently shown first: the first `LIVE_TABS` stay mounted in the background. */
  live: readonly string[] = []
  recent: readonly Recent[] = []
  /** Remembered scroll positions by entry key, for pages that mount again. */
  scrolls = new Map<string, number>()
  dock: DockviewApi | undefined
  private pending: (() => void)[] = []
  private readonly listeners = new Set<Listener>()
  private restoring = false
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private scrollTimer: ReturnType<typeof setTimeout> | undefined
  private startTimer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    this.loadScope()
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(): void {
    for (const listener of this.listeners) listener()
  }

  update(patch: Partial<Pick<ShellState, 'scope' | 'selection' | 'courses' | 'coursesLoaded' | 'feed' | 'side' | 'sideView' | 'sideWidths' | 'sidePage' | 'panel' | 'panelWidth' | 'peek' | 'viewport' | 'columns' | 'palette' | 'menu' | 'theme' | 'themePreference' | 'badges' | 'active' | 'live' | 'recent'>>): void {
    Object.assign(this, patch)
    if ('side' in patch) writeLocal('shell:side', this.side)
    if ('sideView' in patch) writeLocal('shell:side-view', this.sideView)
    if ('sideWidths' in patch) writeLocal('shell:side-widths', this.sideWidths)
    if ('sidePage' in patch) writeLocal(`shell:side-page:${scopeKey(this.scope)}`, this.sidePage ?? null)
    if ('panel' in patch) writeLocal(`shell:panel:${scopeKey(this.scope)}`, this.panel ?? null)
    if ('panelWidth' in patch) writeLocal('shell:panel-width', this.panelWidth)
    if ('recent' in patch) writeLocal(`shell:recent:${scopeKey(this.scope)}`, this.recent)
    this.emit()
  }

  /** This interface's own preferences: its open panel, recent pages, side page and scroll positions. */
  private loadScope(): void {
    const key = scopeKey(this.scope)
    this.panel = readLocal<string | null | undefined>(`shell:panel:${key}`, undefined)
    this.recent = readLocal<Recent[]>(`shell:recent:${key}`, [])
    this.sidePage = readLocal<Entry | null>(`shell:side-page:${key}`, null) ?? undefined
    this.scrolls = new Map(Object.entries(readLocal<Record<string, number>>(`shell:scrolls:${key}`, {})))
  }

  course(): Course | undefined {
    const scope = this.scope
    return scope.kind === 'course' ? this.courses.find(course => course.id === scope.courseId) : undefined
  }

  addActivity(item: ActivityItem): () => void {
    this.activities = [...this.activities, item].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    this.emit()
    this.scheduleStart()
    return () => {
      this.activities = this.activities.filter(existing => existing !== item)
      this.emit()
    }
  }

  /** Every button of the current scope, rail and foot alike. */
  scopedActivities(): ActivityItem[] {
    return this.activities.filter(item => item.scope === 'both' || item.scope === this.scope.kind)
  }

  /** The rail of the current scope; its first item is the start page. */
  visibleActivities(): ActivityItem[] {
    return this.scopedActivities().filter(item => item.placement !== 'foot')
  }

  footActivities(): ActivityItem[] {
    return this.scopedActivities().filter(item => item.placement === 'foot')
  }

  /** The activity a page belongs to: its own button, or the button of the same unit. */
  activityFor(page: string): ActivityItem | undefined {
    const visible = this.scopedActivities()
    return visible.find(item => item.page === page) ?? visible.find(item => unitOf(item.page) === unitOf(page))
  }

  /** The activity whose panel the sidebar shows; before the learner chooses, the first one that has a panel. */
  panelItem(): ActivityItem | undefined {
    const withPanel = this.visibleActivities().filter(item => item.panel)
    if (this.panel === undefined) return withPanel[0]
    return withPanel.find(item => item.id === this.panel)
  }

  /**
   * The sidebar floats when the window is narrow, or when docking it would squeeze the split-view columns under
   * `MIN_COLUMN`; it then shows only while the learner peeks at it.
   */
  get panelFloats(): boolean {
    if (this.viewport < PANEL_FLOAT_BELOW) return true
    const side = this.side && !this.sideFloatsWith(0) ? this.sideWidth : 0
    return this.viewport - RAIL_W - this.panelWidth - side < this.columns * MIN_COLUMN
  }

  get panelShown(): boolean {
    return Boolean(this.panelItem()) && (this.panelFloats ? this.peek : true)
  }

  /** The right sidebar floats over the page in a narrow window, or when docking it would squeeze the columns. */
  get drawer(): boolean {
    return this.sideFloatsWith(this.panelShown && !this.panelFloats ? this.panelWidth : 0)
  }

  private sideFloatsWith(panel: number): boolean {
    return this.viewport < DRAWER_BELOW || this.viewport - RAIL_W - panel - this.sideWidth < this.columns * MIN_COLUMN
  }

  get sideWidth(): number {
    return this.sideWidths[this.sideView]
  }

  /** A rail button: show its panel (folding the sidebar when it already shows), or open its page. */
  pressActivity(item: ActivityItem): void {
    if (!item.panel) {
      this.open(item.page, {}, { title: item.title })
      return
    }
    const showing = this.panelItem()?.id === item.id && this.panelShown
    if (this.panelFloats) this.update({ panel: item.id, peek: !showing })
    else this.update({ panel: showing ? null : item.id })
  }

  setBadge(activityId: string, count: number): void {
    if ((this.badges.get(activityId) ?? 0) === count) return
    const badges = new Map(this.badges)
    if (count > 0) badges.set(activityId, count)
    else badges.delete(activityId)
    this.update({ badges })
  }

  attachDock(dock: DockviewApi): void {
    this.dock = dock
    dock.onDidActivePanelChange(panel => {
      if (panel) this.update({ live: touch(this.live, panel.id) })
      this.syncActive()
    })
    dock.onDidLayoutChange(() => {
      this.syncActive()
      this.scheduleSave()
      // One column per distinct left edge: groups stacked in a column share theirs.
      const columns = Math.max(1, new Set(dock.groups.map(group => Math.round(group.element.getBoundingClientRect().left))).size)
      if (columns !== this.columns) this.update({ columns })
    })
    // A tab area is never empty: closing the last tab leaves a new one.
    dock.onDidRemovePanel(() => {
      if (!this.restoring && dock.panels.length === 0) this.addTab(this.entry(NEW_TAB_PAGE, {}, NEW_TAB_TITLE))
    })
    const pending = this.pending
    this.pending = []
    for (const run of pending) run()
    if (dock.panels.length === 0) this.restore()
  }

  private syncActive(): void {
    const tab = tabOf(this.dock?.activePanel)
    const entry = tab ? current(tab) : undefined
    const active = entry ? { page: entry.page, params: entry.params, title: entry.title } : undefined
    const same = active && this.active && active.page === this.active.page && active.title === this.active.title && JSON.stringify(active.params) === JSON.stringify(this.active.params)
    if (!same && (active || this.active)) this.update({ active })
  }

  /** Run once dockview is ready (pages may be opened before the first render). */
  withDock(run: (dock: DockviewApi) => void): void {
    if (this.dock) run(this.dock)
    else this.pending.push(() => run(this.dock!))
  }

  /** Units register their pages one by one; open the start page once they all have, if no tab is open. */
  private scheduleStart(): void {
    clearTimeout(this.startTimer)
    this.startTimer = setTimeout(() => this.withDock(dock => { if (dock.panels.length === 0 && !this.restoring) this.openStart() }), 30)
  }

  /** Open the scope's start page, its lowest-order activity, in a tab of its own. */
  openStart(): void {
    const start = this.visibleActivities()[0]
    if (start) this.withDock(() => this.addTab(this.entry(start.page, {}, start.title)))
  }

  entry(page: string, params: Readonly<Record<string, unknown>>, title: string): Entry {
    return { key: newKey(), page, params, title }
  }

  private titleOf(page: string): string {
    return this.activityFor(page)?.title ?? this.activities.find(item => item.page === page)?.title ?? page
  }

  open(page: string, params: Readonly<Record<string, unknown>>, options: OpenOptions = {}): void {
    const modifier = this.modifier
    const title = options.title ?? this.titleOf(page)
    this.withDock(dock => {
      const active = dock.activePanel
      const tab = tabOf(active)
      const where = target(options, modifier, tab)
      if (where === 'side') {
        this.update({ side: true, sideView: 'page', sidePage: this.entry(page, params, title) })
        return
      }
      if (this.peek) this.update({ peek: false })
      if (where === 'current' && active && tab) {
        if (samePlace(current(tab), page, params)) active.api.setActive()
        else this.setTab(active, navigate(tab, this.entry(page, params, title)))
        return
      }
      this.addTab(this.entry(page, params, title), where === 'split' ? 'right' : 'within')
    })
  }

  /** A new tab beside the active one (or at the end of `group`), showing `entry`. */
  addTab(entry: Entry, direction: 'within' | 'right' = 'within', group?: DockviewGroupPanel): void {
    const dock = this.dock
    if (!dock) return
    const reference = dock.activePanel
    const position = group
      ? { referenceGroup: group, direction: 'within' as const }
      : reference
        ? { referencePanel: reference.id, direction, ...(direction === 'within' ? { index: reference.group.panels.indexOf(reference) + 1 } : {}) }
        : undefined
    dock.addPanel({ id: `tab-${entry.key}`, component: 'page', title: entry.title, params: { entries: [entry], at: 0 }, ...(position ? { position } : {}) })
    this.update({ recent: remember(this.recent, entry) })
  }

  newTab(group?: DockviewGroupPanel): void {
    this.withDock(() => this.addTab(this.entry(NEW_TAB_PAGE, {}, NEW_TAB_TITLE), 'within', group))
  }

  private setTab(panel: IDockviewPanel, tab: Tab): void {
    panel.api.updateParameters({ entries: tab.entries, at: tab.at, pinned: tab.pinned || undefined })
    const entry = current(tab)
    if (panel.title !== entry.title) panel.api.setTitle(entry.title)
    if (!panel.api.isActive) panel.api.setActive()
    this.update({ recent: remember(this.recent, entry) })
    this.syncActive()
    this.scheduleSave()
  }

  private panelById(id: string): IDockviewPanel | undefined {
    return this.dock?.getPanel(id) ?? undefined
  }

  /** Back (-1) or forward (+1) in a tab, the active one by default. */
  go(delta: number, id?: string): void {
    const panel = id ? this.panelById(id) : this.dock?.activePanel
    const tab = tabOf(panel)
    const next = tab && go(tab, delta)
    if (panel && next) this.setTab(panel, next)
  }

  retitle(id: string, key: string, title: string): void {
    const panel = this.panelById(id)
    const tab = tabOf(panel)
    if (!panel || !tab || !title || tab.entries.find(entry => entry.key === key)?.title === title) return
    this.setTab(panel, updateEntry(tab, key, entry => ({ ...entry, title })))
  }

  reload(id: string): void {
    const panel = this.panelById(id)
    const tab = tabOf(panel)
    if (panel && tab) this.setTab(panel, updateEntry(tab, current(tab).key, entry => ({ ...entry, reloads: (entry.reloads ?? 0) + 1 })))
  }

  pin(id: string, pinned: boolean): void {
    const panel = this.panelById(id)
    const tab = tabOf(panel)
    if (panel && tab) this.setTab(panel, { ...tab, pinned: pinned || undefined })
  }

  /** The tab's page in a column to the right: the tab itself when its column has others, else a copy. */
  splitRight(id: string): void {
    const panel = this.panelById(id)
    const tab = tabOf(panel)
    if (!panel || !tab) return
    if (panel.group.panels.length > 1) {
      panel.api.moveTo({ group: panel.group, position: 'right' })
      return
    }
    const entry = current(tab)
    panel.api.setActive()
    this.addTab(this.entry(entry.page, entry.params, entry.title), 'right')
  }

  closeOthers(id: string): void {
    const panel = this.panelById(id)
    if (!panel) return
    for (const other of [...panel.group.panels]) if (other !== panel && !tabOf(other)?.pinned) other.api.close()
  }

  scrollToTop(id: string): void {
    document.querySelector<HTMLElement>(`.la-page[data-tab="${CSS.escape(id)}"][data-current]`)?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  /** The tab's live set: shown recently enough to stay mounted while out of sight. */
  isLive(id: string): boolean {
    const index = this.live.indexOf(id)
    return index >= 0 && index < LIVE_TABS
  }

  noteScroll(key: string, top: number): void {
    this.scrolls.set(key, top)
    clearTimeout(this.scrollTimer)
    const scope = scopeKey(this.scope)
    this.scrollTimer = setTimeout(() => this.saveScrolls(scope), 500)
  }

  /** Scroll positions of the entries still in some tab's history. */
  private saveScrolls(scope: string): void {
    if (scope !== scopeKey(this.scope) || !this.dock) return
    const keys = new Set(this.dock.panels.flatMap(panel => tabOf(panel)?.entries.map(entry => entry.key) ?? []))
    writeLocal(`shell:scrolls:${scope}`, Object.fromEntries([...this.scrolls].filter(([key, top]) => keys.has(key) && top > 0)))
  }

  /** Remember each interface's tabs, so leaving a course and coming back (or reloading) finds them as they were. */
  private scheduleSave(): void {
    if (this.restoring || !this.dock) return
    clearTimeout(this.saveTimer)
    const dock = this.dock
    const scope = scopeKey(this.scope)
    this.saveTimer = setTimeout(() => this.save(dock, scope), 300)
  }

  private save(dock: DockviewApi, scope: string): void {
    writeLocal(`shell:tabs:${scope}`, dock.panels.length ? dock.toJSON() : null)
    this.saveScrolls(scope)
  }

  private restore(): void {
    const dock = this.dock
    if (!dock) return
    const saved = readLocal<unknown>(`shell:tabs:${scopeKey(this.scope)}`, null)
    this.restoring = true
    try {
      if (saved) dock.fromJSON(saved as Parameters<DockviewApi['fromJSON']>[0])
      for (const panel of [...dock.panels]) if (!tabOf(panel)) panel.api.close()
    } catch {
      dock.clear()
    } finally {
      this.restoring = false
    }
    if (dock.panels.length === 0) this.scheduleStart()
    else this.update({ live: dock.activePanel ? [dock.activePanel.id] : [] })
    this.syncActive()
  }

  /** Switching scope swaps the tab set and the sidebar: they belong to the interface they were opened in. */
  switchScope(scope: ShellScope): void {
    if (this.dock) {
      clearTimeout(this.saveTimer)
      this.save(this.dock, scopeKey(this.scope))
    }
    this.scope = scope
    this.loadScope()
    this.update({ scope, selection: undefined, badges: new Map(), active: undefined, live: [], peek: false })
    writeLocal('shell:scope', scope)
    this.withDock(dock => {
      this.restoring = true
      dock.clear()
      this.restoring = false
      this.restore()
    })
  }
}

type RootProps = PropsRenderSlots<'learning.page' | 'learning.side-chat' | 'learning.panel' | 'learning.new-tab' | 'learning.status' | 'learning.figure'>
const RenderSlot = createContext<RootProps['renderSlot'] | undefined>(undefined)
const StateContext = createContext<ShellState | undefined>(undefined)
const ThemeContext = createContext<{ set(preference: ThemePreference): void } | undefined>(undefined)
/** Outside a tab (a panel, the status bar) a component is on screen and has no tab to name. */
const FrameContext = createContext<PageFrame>({ visible: true, where: 'tab', setTitle: () => {} })

export function apply(ctx: ClientContext): void {
  const state = new ShellState()
  const feedListeners = new Set<(message: FeedMessage) => void>()
  let themeService: ThemeService | undefined

  // Come back to the interface the learner was in before the page reloaded.
  const lastScope = readLocal<ShellScope | null>('shell:scope', null)
  if (lastScope?.kind === 'course' && typeof lastScope.courseId === 'string') state.switchScope(lastScope)

  async function call<T>(unit: string, method: string, payload: unknown = {}): Promise<T> {
    const result = await ctx.connection.rpc.call(API_CHANNEL, endpointName(unit, method), payload) as
      { ok: true; value: T } | { ok: false; error: unknown }
    if (!result.ok) throw result.error
    return result.value
  }

  async function refreshCourses(): Promise<void> {
    try {
      const courses = await call<Course[]>('core', 'courses')
      state.update({ courses, coursesLoaded: true })
      const scope = state.scope
      if (scope.kind === 'course' && !courses.some(course => course.id === scope.courseId)) state.switchScope({ kind: 'main' })
    } catch {
      // The path above the page falls back to the course id.
    }
  }

  const preview = (chunkId: string) => call<CitedChunk | null>('library', 'chunk', { chunkId }).then(chunk => (chunk ? { citation: chunk.citation, text: chunk.text, kind: chunk.kind } : undefined))

  const shell: LearnShell = {
    registerActivity: item => state.addActivity(item),
    setBadge: (activityId, count) => state.setBadge(activityId, count),
    openPage: (page, params = {}, options = {}) => state.open(page, params, options),
    usePage: () => useContext(FrameContext),
    activePage: () => state.active,
    onActivePage(listener) {
      let last = state.active
      return state.subscribe(() => {
        if (state.active === last) return
        last = state.active
        listener(state.active)
      })
    },
    showSideChat() {
      if (!state.side || state.sideView !== 'chat') state.update({ side: true, sideView: 'chat' })
    },
    scope: () => state.scope,
    enterCourse(courseId) {
      if (state.scope.kind === 'course' && state.scope.courseId === courseId) return
      state.switchScope({ kind: 'course', courseId: courseId as Id<'course'> })
      void refreshCourses()
    },
    leaveCourse() {
      if (state.scope.kind !== 'main') state.switchScope({ kind: 'main' })
    },
    onScope(listener) {
      let last = state.scope
      return state.subscribe(() => {
        if (state.scope === last) return
        last = state.scope
        listener(state.scope)
      })
    },
    selection: () => state.selection,
    select: selection => state.update({ selection }),
    onSelection(listener) {
      let last = state.selection
      return state.subscribe(() => {
        if (state.selection === last) return
        last = state.selection
        listener(state.selection)
      })
    },
    onFeed(listener) {
      feedListeners.add(listener)
      return () => { feedListeners.delete(listener) }
    },
    call,
    // A citation badge opens its source in the right sidebar, unless the page handles it; hovering one shows its text.
    Markdown: props => <Markdown {...props} onCite={props.onCite ?? (chunkId => state.open('library.sources', { chunkId }, { title: '出处', side: true }))} preview={preview} figure={props.figure ?? drawFigure} />,
    Figure: FigureSlot,
  }

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.owner = name
    style.textContent = `${dockviewCss}\n${katexCss}\n${shellCss}`
    document.head.append(style)
    return () => style.remove()
  }, 'learning-shell: styles')

  // Window title: the course when inside one.
  ctx.effect(() => {
    const previous = document.title
    const apply = () => { document.title = state.course() ? `${state.course()!.title} · ${APP_TITLE}` : APP_TITLE }
    apply()
    const off = state.subscribe(apply)
    return () => {
      off()
      document.title = previous
    }
  }, 'learning-shell: window title')

  // Window width decides where the sidebars float.
  ctx.effect(() => {
    const resize = () => { if (window.innerWidth !== state.viewport) state.update({ viewport: window.innerWidth }) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, 'learning-shell: viewport')

  // Ctrl/⌘+K opens the command palette; Alt+←/→ and the mouse's side buttons go back and forward in the active tab;
  // Esc folds a floating sidebar, unless a menu inside it took the Esc to close itself.
  ctx.effect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        state.update({ palette: !state.palette })
      } else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        // Without preventDefault the browser leaves the workbench for the previous site.
        event.preventDefault()
        state.go(event.key === 'ArrowLeft' ? -1 : 1)
      } else if (event.key === 'Escape' && state.peek && !event.defaultPrevented) {
        state.update({ peek: false })
      }
    }
    // Chrome navigates on the side buttons' mouseup unless it is cancelled; Firefox never hands them to pages.
    const sideButtons = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return
      event.preventDefault()
      state.go(event.button === 3 ? -1 : 1)
    }
    window.addEventListener('keydown', keys)
    window.addEventListener('mouseup', sideButtons, true)
    return () => {
      window.removeEventListener('keydown', keys)
      window.removeEventListener('mouseup', sideButtons, true)
    }
  }, 'learning-shell: shortcuts')

  // Ctrl/⌘-click on anything, or a middle click on a control marked `data-la-opens`, opens pages in a new tab:
  // the flag is up while the click's handlers run (openPage reads it synchronously).
  ctx.effect(() => {
    const opener = (event: MouseEvent) => (event.target as Element | null)?.closest?.('[data-la-opens]') as HTMLElement | null
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return
      state.modifier = true
      setTimeout(() => { state.modifier = false })
    }
    const middle = (event: MouseEvent) => {
      const element = event.button === 1 ? opener(event) : null
      if (!element) return
      event.preventDefault()
      state.modifier = true
      try {
        element.click()
      } finally {
        state.modifier = false
      }
    }
    // A middle press on such a control would start the browser's autoscroll.
    const press = (event: MouseEvent) => { if (event.button === 1 && opener(event)) event.preventDefault() }
    window.addEventListener('click', click, true)
    window.addEventListener('auxclick', middle, true)
    window.addEventListener('mousedown', press, true)
    return () => {
      window.removeEventListener('click', click, true)
      window.removeEventListener('auxclick', middle, true)
      window.removeEventListener('mousedown', press, true)
    }
  }, 'learning-shell: new-tab clicks')

  // Light or dark follows DSH's theme setting (light / dark / system); without it, the system's.
  ctx.effect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const fromSystem = () => { if (!themeService) state.update({ theme: media.matches ? 'dark' : 'light' }) }
    fromSystem()
    media.addEventListener('change', fromSystem)
    const off = state.subscribe(() => { document.documentElement.dataset.laTheme = state.theme })
    document.documentElement.dataset.laTheme = state.theme
    return () => {
      off()
      media.removeEventListener('change', fromSystem)
      delete document.documentElement.dataset.laTheme
    }
  }, 'learning-shell: theme')
  ctx.inject(['theme'], themeCtx => {
    const service = (themeCtx as unknown as { theme: ThemeService }).theme
    const sync = () => {
      const snapshot = service.getTheme()
      state.update({ theme: snapshot.active.colorScheme, themePreference: (['light', 'dark', 'system'].includes(snapshot.preference) ? snapshot.preference : 'system') as ThemePreference })
    }
    themeService = service
    sync()
    themeCtx.on('theme/change' as never, sync as never)
    themeCtx.effect(() => () => { themeService = undefined }, 'learning-shell: theme service')
  })
  const theme = {
    set(preference: ThemePreference) {
      if (themeService) themeService.setTheme(preference)
      else state.update({ theme: preference === 'dark' || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light', themePreference: preference })
    },
  }

  // One change-feed connection for every page (contracts §6.2).
  ctx.effect(() => {
    const source = new EventSource(FEED_PATH)
    source.addEventListener('ready', () => state.update({ feed: 'open' }))
    source.addEventListener('message', event => {
      const message = JSON.parse((event as MessageEvent<string>).data) as FeedMessage
      if (message.type === 'learning/course-created') void refreshCourses()
      for (const listener of feedListeners) {
        try {
          listener(message)
        } catch (error) {
          console.error('learning-shell: feed listener failed', error)
        }
      }
    })
    source.onerror = () => state.update({ feed: 'error' })
    return () => source.close()
  }, 'learning-shell: change feed')

  ctx.effect(() => {
    const dispose = ctx.reflect.provide('learnShell', shell)
    return () => { void dispose() }
  }, 'learning-shell: learnShell service')

  void refreshCourses()

  function Root({ renderSlot }: RootProps): ReactNode {
    return (
      <StateContext.Provider value={state}>
        <ThemeContext.Provider value={theme}>
          <RenderSlot.Provider value={renderSlot}>
            <Frame />
          </RenderSlot.Provider>
        </ThemeContext.Provider>
      </StateContext.Provider>
    )
  }

  ctx.effect(() => ctx.slots.register({
    name: 'root',
    children: {
      'learning.page': { kind: 'keyed', scope: 'root' },
      'learning.side-chat': { kind: 'single', scope: 'root' },
      'learning.panel': { kind: 'keyed', scope: 'root' },
      'learning.new-tab': { kind: 'list', scope: 'root' },
      'learning.status': { kind: 'list', scope: 'root' },
      'learning.figure': { kind: 'single', scope: 'root' },
    },
  }, Root), 'learning-shell: root')
}

/** A source's figure, drawn by whichever unit fills `learning.figure` (library). */
function FigureSlot({ chunkId }: { readonly chunkId: string }): ReactNode {
  const renderSlot = useContext(RenderSlot)
  return renderSlot?.('learning.figure', { chunkId }, { fallback: null }) ?? null
}

const drawFigure = (chunkId: string) => <FigureSlot chunkId={chunkId} />

function useShellState(): ShellState {
  const state = useContext(StateContext)
  if (!state) throw new Error('learning-shell: state context missing')
  return state
}

/** Re-render on any shell state change (the state object is mutable). */
function useShellVersion(state: ShellState): number {
  const [version, setVersion] = useState(0)
  useEffect(() => state.subscribe(() => setVersion(v => v + 1)), [state])
  return version
}

const DOCK_THEME: DockviewTheme = { name: 'learning', className: 'la-dock', gap: 0, dndOverlayMounting: 'relative', dndPanelOverlay: 'group' }

function Frame(): ReactNode {
  const state = useShellState()
  useShellVersion(state)
  const panel = state.panelShown ? state.panelItem() : undefined
  const floats = state.panelFloats
  return (
    <div className="la-app" data-panel={panel ? (floats ? 'float' : 'docked') : 'closed'} data-side={state.side ? 'open' : 'closed'}
      data-side-mode={state.drawer ? 'drawer' : 'column'}
      style={{ ['--la-side-w' as string]: `${state.sideWidth}px`, ['--la-panel-w' as string]: `${state.panelWidth}px` }}
      onMouseDown={event => {
        // A floating sidebar folds on a click anywhere outside it and the rail.
        if (state.peek && !(event.target as Element).closest('.la-panel, .la-rail')) state.update({ peek: false })
      }}>
      <Rail />
      {panel?.panel && <Panel item={panel} panel={panel.panel} />}
      <main className="la-main">
        <DockviewReact
          theme={DOCK_THEME}
          defaultRenderer="always"
          components={{ page: TabPanel }}
          defaultTabComponent={TabHeader}
          leftHeaderActionsComponent={NewTabButton}
          rightHeaderActionsComponent={GroupActions}
          onReady={event => state.attachDock(event.api)}
        />
      </main>
      {state.side && <RightSide />}
      <StatusBar />
      {state.palette && <Palette />}
      {state.menu && <ContextMenu entries={state.menu.entries} at={state.menu.at} width={232} onClose={() => state.update({ menu: undefined })} />}
    </div>
  )
}

/** The rail: the course switcher on top, the activities, then 外观 and the foot activities. */
function Rail(): ReactNode {
  const state = useShellState()
  const theme = useContext(ThemeContext)!
  const scope = state.scope
  const course = state.course()
  const activePage = state.active?.page
  const current = activePage ? state.activityFor(activePage) : undefined
  const open = state.panelShown ? state.panelItem() : undefined
  const switcher: MenuEntry[] = [
    { key: 'home', label: '主界面', icon: House, hint: '全部课程与资料库', checked: scope.kind === 'main', onSelect: () => { if (scope.kind !== 'main') state.switchScope({ kind: 'main' }) } },
    ...(state.courses.length ? [{ heading: '课程' } as const] : []),
    ...state.courses.map(item => ({
      key: item.id, label: item.title, icon: GraduationCap, checked: scope.kind === 'course' && scope.courseId === item.id,
      onSelect: () => { if (!(scope.kind === 'course' && scope.courseId === item.id)) state.switchScope({ kind: 'course', courseId: item.id }) },
    })),
    'divider',
    { key: 'new', label: '新建课程', icon: Plus, onSelect: () => { if (scope.kind !== 'main') state.switchScope({ kind: 'main' }); state.open('planner.home', {}, { title: '首页' }) } },
  ]
  const themeIcon = state.themePreference === 'dark' ? Moon : state.themePreference === 'light' ? Sun : SunMoon
  const themes: MenuEntry[] = [
    { heading: '外观' },
    { key: 'system', label: '跟随系统', icon: Monitor, checked: (state.themePreference ?? 'system') === 'system', onSelect: () => theme.set('system') },
    { key: 'light', label: '浅色', icon: Sun, checked: state.themePreference === 'light', onSelect: () => theme.set('light') },
    { key: 'dark', label: '深色', icon: Moon, checked: state.themePreference === 'dark', onSelect: () => theme.set('dark') },
  ]
  const button = (item: ActivityItem) => {
    const badge = state.badges.get(item.id)
    const pressed = item.panel ? open?.id === item.id : undefined
    return (
      <button key={item.id} type="button" className={`la-rail-btn${open?.id === item.id ? ' is-open' : ''}${current?.id === item.id ? ' is-current' : ''}`}
        title={item.title} aria-label={item.title} aria-pressed={pressed} aria-current={current?.id === item.id ? 'page' : undefined}
        data-activity={item.id} data-la-opens={item.panel ? undefined : ''} onClick={() => state.pressActivity(item)}>
        <item.icon size={19} strokeWidth={1.75} />
        {badge ? <span className="la-rail-badge" aria-label={`${badge} 项待处理`}>{badge}</span> : null}
      </button>
    )
  }
  return (
    <nav className="la-rail" aria-label="导航">
      <Menu entries={switcher} width={260} trigger={props => (
        <button type="button" className={`la-switcher${course ? '' : ' home'}`} title={course ? `${course.title} · 切换课程` : '主界面 · 切换课程'} aria-label="切换课程或回到主界面" {...props}>
          {course ? Array.from(course.title)[0] : <House size={17} strokeWidth={1.75} />}
        </button>
      )} />
      <div className="la-rail-items">{state.visibleActivities().map(button)}</div>
      <span className="la-spacer" />
      <div className="la-rail-items">
        <Menu entries={themes} width={180} trigger={props => (
          <button type="button" className="la-rail-btn" title="外观" aria-label="外观" {...props}>
            {(() => { const Icon = themeIcon; return <Icon size={19} strokeWidth={1.75} /> })()}
          </button>
        )} />
        {state.footActivities().map(button)}
      </div>
    </nav>
  )
}

/** The sidebar: an activity's panel under its name; drag the right edge to resize it. */
function Panel({ item, panel }: { item: ActivityItem; panel: string }): ReactNode {
  const state = useShellState()
  const renderSlot = useContext(RenderSlot)
  return (
    <aside className="la-panel" aria-label={item.title}>
      <div className="la-panel-head">
        <span className="la-panel-title">{item.title}</span>
        <button type="button" className="la-icon-btn" aria-label="收起侧栏" title="收起侧栏" onClick={() => state.update(state.panelFloats ? { peek: false } : { panel: null })}>
          <PanelLeftClose {...ICON} />
        </button>
      </div>
      <div className="la-panel-scroll">
        {renderSlot?.('learning.panel', { scope: state.scope }, { entryKey: panel, fallback: <div className="la-side-empty">这一栏还没有内容</div> })}
      </div>
      {!state.panelFloats && <Resize edge="right" label="调整侧栏宽度" min={PANEL_MIN} max={PANEL_MAX} width={() => state.panelWidth} variable="--la-panel-w"
        onDone={width => state.update({ panelWidth: width })} onReset={() => state.update({ panelWidth: PANEL_W })} />}
    </aside>
  )
}

/** Drag a sidebar's inner edge to resize it; double-click puts the default width back. */
function Resize({ edge, label, min, max, width, variable, onDone, onReset }: {
  edge: 'left' | 'right'
  label: string
  min: number
  max: number
  width(): number
  variable: string
  onDone(width: number): void
  onReset(): void
}): ReactNode {
  return (
    <div className={`la-resize ${edge}`} role="separator" aria-orientation="vertical" aria-label={label}
      onPointerDown={event => {
        event.preventDefault()
        const app = (event.currentTarget as HTMLElement).closest('.la-app') as HTMLElement | null
        const startX = event.clientX
        const start = width()
        let next = start
        app?.setAttribute('data-resizing', '')
        const move = (moveEvent: PointerEvent) => {
          const delta = edge === 'left' ? startX - moveEvent.clientX : moveEvent.clientX - startX
          next = Math.round(Math.min(max, Math.max(min, start + delta), window.innerWidth * 0.5))
          app?.style.setProperty(variable, `${next}px`)
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          app?.removeAttribute('data-resizing')
          onDone(next)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
      onDoubleClick={onReset} />
  )
}

/** The right sidebar: the side chat, or the page opened with `side` (a citation's source). */
function RightSide(): ReactNode {
  const state = useShellState()
  const renderSlot = useContext(RenderSlot)
  const scope = state.scope
  const page = state.sidePage
  const view: SideView = state.sideView === 'page' && page ? 'page' : 'chat'
  const frame = useMemo<PageFrame>(() => ({ visible: true, where: 'side', setTitle: () => {} }), [])
  return (
    <aside className="la-side" aria-label={view === 'chat' ? '侧边提问' : page?.title}>
      {!state.drawer && <Resize edge="left" label="调整右侧栏宽度" min={SIDE_MIN} max={SIDE_MAX} width={() => state.sideWidth} variable="--la-side-w"
        onDone={width => state.update({ sideWidths: { ...state.sideWidths, [view]: width } })}
        onReset={() => state.update({ sideWidths: { ...state.sideWidths, [view]: SIDE_WIDTH[view] } })} />}
      <div className="la-panel-head">
        <div className="la-side-views" role="tablist" aria-label="右侧栏">
          <button type="button" role="tab" aria-selected={view === 'chat'} className="la-side-view" onClick={() => state.update({ sideView: 'chat' })}>
            <MessageCircleQuestion {...ICON} />提问
          </button>
          {page && (
            <button type="button" role="tab" aria-selected={view === 'page'} className="la-side-view" title={page.title} onClick={() => state.update({ sideView: 'page' })}>
              <BookOpenText {...ICON} /><span className="la-ellipsis">{page.title}</span>
            </button>
          )}
        </div>
        {view === 'page' && page && (
          <>
            <button type="button" className="la-icon-btn" aria-label="在标签页打开" title="在标签页打开"
              onClick={() => { state.update({ sideView: 'chat', sidePage: undefined }); state.open(page.page, page.params, { title: page.title, newTab: true }) }}>
              <ExternalLink {...ICON} />
            </button>
            <button type="button" className="la-icon-btn" aria-label={`关掉${page.title}`} title={`关掉${page.title}`} onClick={() => state.update({ sideView: 'chat', sidePage: undefined })}>
              <X {...ICON} />
            </button>
          </>
        )}
        <span className="la-spacer" />
        <button type="button" className="la-icon-btn" aria-label="收起右侧栏" title="收起右侧栏" onClick={() => state.update({ side: false })}><PanelRightClose {...ICON} /></button>
      </div>
      <div className="la-panel-body" hidden={view !== 'chat'}>
        {renderSlot?.('learning.side-chat', { scope }, { fallback: <div className="la-empty">侧边提问未加载</div> })}
      </div>
      {page && (
        <div className="la-page la-side-page" hidden={view !== 'page'}>
          <FrameContext.Provider value={frame}>
            {renderSlot?.('learning.page', { scope, params: page.params }, { entryKey: page.page, fallback: <div className="la-empty">页面 {page.page} 尚未注册</div> })}
          </FrameContext.Provider>
        </div>
      )}
    </aside>
  )
}

function StatusBar(): ReactNode {
  const state = useShellState()
  const renderSlot = useContext(RenderSlot)
  return (
    <footer className="la-status">
      {renderSlot?.('learning.status', { scope: state.scope }, {})}
      <span className="la-spacer" />
      {state.feed !== 'open' && <span className="la-status-item" title="页面靠推送连接得知后台变化">{state.feed === 'error' ? '推送断开，正在重连…' : '正在连接推送…'}</span>}
      <span className="la-status-item" title={state.feed === 'open' ? '推送已连接：后台的变化会自动刷新页面' : undefined}>
        <span className={`la-dot ${state.feed === 'open' ? 'ok' : state.feed === 'error' ? 'bad' : ''}`} />
        {state.feed === 'open' ? '已连接' : ''}
      </span>
    </footer>
  )
}

function iconOf(state: ShellState, page: string): IconComponent {
  return page === NEW_TAB_PAGE ? Plus : state.activityFor(page)?.icon ?? File
}

/**
 * A tab: the page's icon and title, and close (a pin when pinned). Middle click closes an unpinned tab; right click
 * opens its menu; a click on the tab that is already active scrolls its page to the top.
 */
function TabHeader({ api, params }: IDockviewPanelHeaderProps<Tab>): ReactNode {
  const state = useShellState()
  const [title, setTitle] = useState(api.title ?? '')
  const element = useRef<HTMLDivElement>(null)
  const wasActive = useRef(false)
  useEffect(() => {
    setTitle(api.title ?? '')
    const off = api.onDidTitleChange(event => setTitle(event.title))
    return () => off.dispose()
  }, [api])
  // Read before dockview's own pointerdown (on the same tab element, bubbling) makes the tab active.
  useEffect(() => {
    const tab = element.current?.closest('.dv-tab')
    if (!tab) return
    const down = () => { wasActive.current = api.isActive }
    tab.addEventListener('pointerdown', down, true)
    return () => tab.removeEventListener('pointerdown', down, true)
  }, [api])
  const tab = readTab(params)
  const pinned = Boolean(tab?.pinned)
  const Icon = iconOf(state, tab ? current(tab).page : '')
  const menu = (x: number, y: number): void => state.update({
    menu: {
      at: { x, y },
      entries: [
        { key: 'pin', label: pinned ? '取消固定' : '固定标签', icon: pinned ? PinOff : Pin, hint: pinned ? undefined : '在里面点开的页面另开标签', onSelect: () => state.pin(api.id, !pinned) },
        { key: 'split', label: '在右侧分屏打开', icon: Columns2, onSelect: () => state.splitRight(api.id) },
        'divider',
        { key: 'close', label: '关闭', icon: X, onSelect: () => api.close() },
        { key: 'others', label: '关闭其他标签', hint: '固定的标签留下', disabled: api.group.panels.length < 2, onSelect: () => state.closeOthers(api.id) },
      ],
    },
  })
  return (
    <div ref={element} className={`la-tab${pinned ? ' is-pinned' : ''}`} title={title}
      onMouseDown={event => { if (event.button === 1) { event.preventDefault(); if (!pinned) api.close() } }}
      onClick={() => { if (wasActive.current) state.scrollToTop(api.id) }}
      onContextMenu={event => { event.preventDefault(); menu(event.clientX, event.clientY) }}>
      <Icon size={14} strokeWidth={1.75} className="la-tab-icon" />
      <span className="la-tab-title">{title}</span>
      {pinned
        ? <span className="la-tab-pin" aria-label="已固定"><Pin size={12} strokeWidth={2} /></span>
        : (
          <button type="button" className="la-tab-close" aria-label={`关闭 ${title}`} title="关闭"
            onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); api.close() }}>
            <X size={13} strokeWidth={2} />
          </button>
        )}
    </div>
  )
}

/** "+" right after a column's tabs. */
function NewTabButton({ group }: IDockviewHeaderActionsProps): ReactNode {
  const state = useShellState()
  return (
    <button type="button" className="la-icon-btn la-new-tab" aria-label="新标签页" title="新标签页" onClick={() => state.newTab(group)}>
      <Plus size={16} strokeWidth={1.75} />
    </button>
  )
}

/** The top right of the tab area: search and the side chat, in whichever column is there. */
function GroupActions({ group, containerApi }: IDockviewHeaderActionsProps): ReactNode {
  const state = useShellState()
  useShellVersion(state)
  const [, setVersion] = useState(0)
  useEffect(() => {
    const off = containerApi.onDidLayoutChange(() => setVersion(v => v + 1))
    return () => off.dispose()
  }, [containerApi])
  if (!isTopRight(group, containerApi)) return null
  const chat = state.side && state.sideView === 'chat'
  return (
    <div className="la-tab-actions">
      <button type="button" className="la-command" title="搜索与跳转（Ctrl K）" aria-label="搜索与跳转" onClick={() => state.update({ palette: true })}>
        <Search size={15} strokeWidth={1.75} /><span>搜索</span><Kbd>Ctrl K</Kbd>
      </button>
      {/* On the main interface the side chat asks which course the question is about. */}
      <button type="button" className={`la-toggle${chat ? ' is-on' : ''}`} aria-pressed={chat} title="侧边提问：针对选中的内容提问，不打断主老师"
        onClick={() => state.update(chat ? { side: false } : { side: true, sideView: 'chat' })}>
        <MessageCircleQuestion {...ICON} /><span>提问</span>
      </button>
    </div>
  )
}

/** The column in the top row furthest right (hidden columns, e.g. beside a maximized one, have no size). */
function isTopRight(group: DockviewGroupPanel, api: DockviewApi): boolean {
  const boxes = api.groups.map(item => ({ item, box: item.element.getBoundingClientRect() })).filter(({ box }) => box.width > 0)
  if (boxes.length === 0) return api.groups[0] === group
  const top = Math.min(...boxes.map(({ box }) => box.top))
  const row = boxes.filter(({ box }) => box.top - top < 2)
  return row.reduce((best, next) => (next.box.right > best.box.right ? next : best)).item === group
}

/** One tab: back, forward and where it is, then its pages (the current one shown, its neighbours kept mounted). */
function TabPanel({ api, containerApi, params }: IDockviewPanelProps<Tab>): ReactNode {
  const state = useShellState()
  const [visible, setVisible] = useState(api.isVisible)
  useEffect(() => {
    setVisible(api.isVisible)
    const off = api.onDidVisibilityChange(event => setVisible(event.isVisible))
    return () => off.dispose()
  }, [api])
  // A tab not shown since the page loaded, or long out of sight, mounts nothing (its pages restore their scroll).
  const live = useSyncExternalStore(state.subscribe, () => state.isLive(api.id))
  const tab = readTab(params)
  if (!tab) return null
  const entry = current(tab)
  return (
    <div className="la-tab-view">
      <ViewHeader id={api.id} tab={tab} group={api.group} containerApi={containerApi} />
      <div className="la-tab-body">
        {(visible || live) && mounted(tab).map(item => (
          <EntryView key={`${item.key}:${item.reloads ?? 0}`} tabId={api.id} entry={item} shown={item.key === entry.key} visible={visible && item.key === entry.key} />
        ))}
      </div>
    </div>
  )
}

function ViewHeader({ id, tab, group, containerApi }: { id: string; tab: Tab; group: DockviewGroupPanel; containerApi: DockviewApi }): ReactNode {
  const state = useShellState()
  useShellVersion(state)
  const [, setVersion] = useState(0)
  useEffect(() => {
    const off = containerApi.onDidLayoutChange(() => setVersion(v => v + 1))
    return () => off.dispose()
  }, [containerApi])
  const entry = current(tab)
  const activity = entry.page === NEW_TAB_PAGE ? undefined : state.activityFor(entry.page)
  const course = state.course()
  const maximized = group.api.isMaximized()
  const several = containerApi.groups.length > 1
  return (
    <div className="la-view-head">
      <button type="button" className="la-icon-btn" aria-label="后退" title="后退（Alt+←）" disabled={tab.at === 0} onClick={() => state.go(-1, id)}><ArrowLeft {...ICON} /></button>
      <button type="button" className="la-icon-btn" aria-label="前进" title="前进（Alt+→）" disabled={tab.at === tab.entries.length - 1} onClick={() => state.go(1, id)}><ArrowRight {...ICON} /></button>
      <nav className="la-crumbs" aria-label="位置">
        <span className="la-crumb">{state.scope.kind === 'course' ? course?.title ?? '课程' : '主界面'}</span>
        {activity && <><ChevronRight size={13} strokeWidth={1.75} className="la-crumb-sep" /><span className="la-crumb">{activity.title}</span></>}
        {entry.title !== activity?.title && <><ChevronRight size={13} strokeWidth={1.75} className="la-crumb-sep" /><span className="la-crumb la-crumb-current">{entry.title}</span></>}
      </nav>
      <div className="la-view-actions">
        <button type="button" className="la-icon-btn" aria-label="刷新这个页面" title="刷新这个页面" onClick={() => state.reload(id)}><RotateCw size={14} strokeWidth={1.75} /></button>
        <button type="button" className="la-icon-btn" aria-label="在右侧分屏打开" title="在右侧分屏打开" onClick={() => state.splitRight(id)}><Columns2 size={15} strokeWidth={1.75} /></button>
        {(several || maximized) && (
          <button type="button" className="la-icon-btn" aria-label={maximized ? '恢复分屏' : '只看这一栏'} title={maximized ? '恢复分屏' : '只看这一栏'}
            onClick={() => (maximized ? group.api.exitMaximized() : group.api.maximize())}>
            {maximized ? <Minimize2 size={15} strokeWidth={1.75} /> : <Maximize2 size={15} strokeWidth={1.75} />}
          </button>
        )}
      </div>
    </div>
  )
}

/** One page of a tab's history, in its own scroller; hidden (not unmounted) while another entry is current. */
function EntryView({ tabId, entry, shown, visible }: { tabId: string; entry: Entry; shown: boolean; visible: boolean }): ReactNode {
  const state = useShellState()
  const renderSlot = useContext(RenderSlot)
  const scope = useSyncExternalStore(state.subscribe, () => state.scope)
  const scroller = useRef<HTMLDivElement>(null)
  const frame = useMemo<PageFrame>(() => ({ visible, where: 'tab', setTitle: title => state.retitle(tabId, entry.key, title) }), [visible, tabId, entry.key, state])
  useRestoreScroll(scroller, state.scrolls.get(entry.key))
  return (
    <div ref={scroller} className="la-page" data-tab={tabId} data-current={shown || undefined} hidden={!shown} onScroll={event => state.noteScroll(entry.key, event.currentTarget.scrollTop)}>
      <FrameContext.Provider value={frame}>
        {entry.page === NEW_TAB_PAGE
          ? <NewTabPage />
          : renderSlot?.('learning.page', { scope, params: entry.params }, { entryKey: entry.page, fallback: <div className="la-empty">页面 {entry.page} 尚未注册</div> })}
      </FrameContext.Provider>
    </div>
  )
}

/**
 * A page mounting again (after a reload, or far back in a tab's history) scrolls to where the learner left it once
 * its content is tall enough; it gives up after a while, or as soon as the learner scrolls or types.
 */
function useRestoreScroll(ref: RefObject<HTMLDivElement | null>, top: number | undefined): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !top) return
    let timer: ReturnType<typeof setTimeout> | undefined
    // The page's content arrives after its data loads (new nodes), and the scroller gets a size when shown.
    const grown = new MutationObserver(() => attempt())
    const shown = new ResizeObserver(() => attempt())
    const stop = () => {
      grown.disconnect()
      shown.disconnect()
      clearTimeout(timer)
      for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) element.removeEventListener(type, stop)
    }
    function attempt(): void {
      // Hidden (another entry is current): wait until it shows.
      if (element!.clientHeight === 0) return
      timer ??= setTimeout(() => { element!.scrollTop = top!; stop() }, RESTORE_WAIT_MS)
      if (element!.scrollHeight - element!.clientHeight >= top!) {
        element!.scrollTop = top!
        stop()
      }
    }
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) element.addEventListener(type, stop, { passive: true })
    grown.observe(element, { childList: true, subtree: true })
    shown.observe(element)
    attempt()
    return stop
    // Only when the page mounts: later scrolling is the learner's.
  }, [])
}

/** "+": continue learning (planner), the recently opened pages, and this interface's pages. */
function NewTabPage(): ReactNode {
  const state = useShellState()
  useShellVersion(state)
  const renderSlot = useContext(RenderSlot)
  const scope = state.scope
  return (
    <Page width="reading" className="la-new-tab-page">
      <div className="la-stack" style={{ gap: 28 }}>
        {renderSlot?.('learning.new-tab', { scope }, {})}
        <Section title="最近打开" icon={Clock}>
          {state.recent.length === 0
            ? <EmptyState compact icon={Clock} title="还没有打开过页面" />
            : (
              <div className="la-rows">
                {state.recent.map(item => {
                  const Icon = iconOf(state, item.page)
                  const activity = state.activityFor(item.page)
                  return (
                    <button key={`${item.page}:${JSON.stringify(item.params)}`} type="button" className="la-row-item interactive" data-la-opens=""
                      onClick={() => state.open(item.page, item.params, { title: item.title })}>
                      <span className="la-row-icon"><Icon {...ICON} /></span>
                      <span className="la-row-main"><span className="la-row-title">{item.title}</span>{activity && activity.title !== item.title && <span className="la-row-sub">{activity.title}</span>}</span>
                    </button>
                  )
                })}
              </div>
            )}
        </Section>
        <Section title="页面">
          <div className="la-row">
            {state.scopedActivities().map(item => (
              <button key={item.id} type="button" className="la-btn la-btn-sm" data-la-opens="" onClick={() => state.open(item.page, {}, { title: item.title })}>
                <item.icon size={14} strokeWidth={1.75} />{item.title}
              </button>
            ))}
          </div>
        </Section>
      </div>
    </Page>
  )
}

interface PaletteItem {
  readonly key: string
  readonly group: string
  readonly label: string
  readonly icon: IconComponent
  readonly hint?: string
  readonly keywords?: string
  run(newTab: boolean): void
}

/** Ctrl K: jump to a page or course, or run a shell action; Ctrl+Enter opens a page in a new tab. */
function Palette(): ReactNode {
  const state = useShellState()
  const theme = useContext(ThemeContext)!
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const close = () => state.update({ palette: false })
  const items = useMemo<PaletteItem[]>(() => {
    const scope = state.scope
    const course = state.course()
    const result: PaletteItem[] = state.recent.slice(0, 5).map(item => ({
      key: `recent:${item.page}:${JSON.stringify(item.params)}`, group: '最近打开', label: item.title, icon: iconOf(state, item.page), hint: '打开',
      run: newTab => state.open(item.page, item.params, { title: item.title, newTab }),
    }))
    for (const item of state.scopedActivities()) {
      result.push({ key: `page:${item.id}`, group: course ? `${course.title} 的页面` : '页面', label: item.title, icon: item.icon, hint: '打开', run: newTab => state.open(item.page, {}, { title: item.title, newTab }) })
    }
    for (const item of state.courses) {
      if (scope.kind === 'course' && scope.courseId === item.id) continue
      result.push({ key: `course:${item.id}`, group: '课程', label: item.title, icon: GraduationCap, hint: '进入课程', run: () => state.switchScope({ kind: 'course', courseId: item.id }) })
    }
    result.push({ key: 'new-tab', group: '操作', label: '新标签页', icon: Plus, keywords: '标签', run: () => state.newTab() })
    if (scope.kind === 'course') result.push({ key: 'leave', group: '操作', label: '回到主界面', icon: ArrowLeft, keywords: '首页 返回', run: () => state.switchScope({ kind: 'main' }) })
    result.push({ key: 'side', group: '操作', label: state.side ? '收起右侧栏' : '打开侧边提问', icon: MessageCircleQuestion, keywords: '提问 侧边会话', run: () => state.update(state.side ? { side: false } : { side: true, sideView: 'chat' }) })
    result.push({ key: 'theme-light', group: '外观', label: '浅色', icon: Sun, keywords: '主题 外观', run: () => theme.set('light') })
    result.push({ key: 'theme-dark', group: '外观', label: '深色', icon: Moon, keywords: '主题 外观 夜间', run: () => theme.set('dark') })
    result.push({ key: 'theme-system', group: '外观', label: '跟随系统', icon: Monitor, keywords: '主题 外观', run: () => theme.set('system') })
    return result
  }, [state, theme])
  const needle = query.trim().toLowerCase()
  const shown = needle ? items.filter(item => `${item.label} ${item.group} ${item.keywords ?? ''}`.toLowerCase().includes(needle)) : items
  useEffect(() => setActive(0), [needle])
  useLayoutEffect(() => revealInList(list.current), [active])
  useEffect(() => { input.current?.focus() }, [])
  const run = (item: PaletteItem | undefined, newTab = false) => {
    if (!item) return
    close()
    item.run(newTab)
  }
  let lastGroup = ''
  return (
    <div className="la-palette-scrim" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
      <div className="la-palette" role="dialog" aria-modal aria-label="搜索与跳转">
        <div className="la-palette-input">
          <Search size={18} strokeWidth={1.75} />
          <input ref={input} value={query} placeholder="搜索页面、课程或操作…" aria-label="搜索页面、课程或操作" role="combobox" aria-expanded aria-controls="la-palette-list"
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Escape') { event.preventDefault(); close() }
              else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(shown.length - 1, index + 1)) }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)) }
              else if (event.key === 'Enter') { event.preventDefault(); run(shown[active], event.ctrlKey || event.metaKey) }
            }} />
          <Kbd>Esc</Kbd>
        </div>
        <div className="la-palette-list" id="la-palette-list" role="listbox" ref={list}>
          {shown.length === 0 && <div className="la-palette-empty">没有匹配的页面、课程或操作</div>}
          {shown.map((item, index) => {
            const heading = item.group !== lastGroup ? item.group : undefined
            lastGroup = item.group
            return (
              <div key={item.key}>
                {heading && <div className="la-palette-heading">{heading}</div>}
                <button type="button" role="option" aria-selected={index === active} data-active={index === active} data-key={item.key} className="la-palette-item"
                  onMouseMove={() => setActive(index)} onClick={event => run(item, event.ctrlKey || event.metaKey)}>
                  <item.icon {...ICON} />
                  <span className="la-palette-label">{item.label}</span>
                  {item.hint && <span className="la-palette-hint">{item.hint}</span>}
                </button>
              </div>
            )
          })}
        </div>
        <div className="la-palette-foot">
          <span><Kbd>↑</Kbd><Kbd>↓</Kbd>选择</span>
          <span><Kbd><CornerDownLeft size={11} strokeWidth={2} /></Kbd>打开</span>
          <span><Kbd>Ctrl</Kbd><Kbd><CornerDownLeft size={11} strokeWidth={2} /></Kbd>新标签打开</span>
          <span><Kbd>Esc</Kbd>关闭</span>
        </div>
      </div>
    </div>
  )
}
