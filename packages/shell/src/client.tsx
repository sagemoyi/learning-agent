// Shell, browser half. Takes over DSH's `root` slot (stage-0 V2) and owns the page frame: the left
// sidebar (course switcher, page list, `learning.sidebar` sections), the top bar, dockview tabs, the
// side-chat panel, the status bar (`learning.status`) and the command palette. It declares the
// `learning.*` slots and provides `ctx.learnShell` (contracts §6.3): pages, scope, the active page,
// selection, the shared change-feed connection, endpoint calls and the shared Markdown renderer.
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { DockviewReact, type DockviewApi, type DockviewTheme, type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type IDockviewPanelProps, type IWatermarkPanelProps } from 'dockview'
import {
  ArrowLeft, ChevronRight, ChevronsUpDown, Columns2, CornerDownLeft, File, GraduationCap, House, Maximize2, MessageCircleQuestion, Minimize2,
  Monitor, Moon, PanelLeftClose, PanelLeftOpen, Plus, RotateCw, Search, Sun, SunMoon, X,
} from 'lucide-react'
import dockviewCss from 'dockview/dist/styles/dockview.css'
import katexCss from 'katex/dist/katex.min.css'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { API_CHANNEL, FEED_PATH, endpointName, type CitedChunk, type Course, type FeedMessage, type Id, type Selection } from '@learning-agent/contracts'
import type { ActivePage, ActivityItem, ClientContext, IconComponent, LearnShell, ShellScope } from '@learning-agent/contracts/client'
import { EmptyState, Kbd, Menu, readLocal, revealInList, writeLocal, type MenuEntry } from '@learning-agent/kit/client'
import { Markdown } from './client/markdown.tsx'
import shellCss from './shell.css'

export const name = 'learning-shell'
export const inject = ['slots', 'connection']

type Listener = () => void
type ThemePreference = 'light' | 'dark' | 'system'
/** The part of DSH's theme service (`ctx.theme`, dsh-client-ui-theme) the shell uses. */
interface ThemeService {
  getTheme(): { preference: string; active: { colorScheme: 'light' | 'dark' } }
  setTheme(id: string): void
}

const ICON = { size: 16, strokeWidth: 1.75 } as const
const APP_TITLE = '学习工作台'
/** Below these window widths the sidebar folds to a rail and the side chat floats over the page. */
const RAIL_BELOW = 1180
const DRAWER_BELOW = 1000
/** Narrowest a split-view column may get before the sidebar folds, then the side chat floats. */
const MIN_COLUMN = 360
/** `--la-sidebar-w` and `--la-rail-w` in shell.css. */
const SIDEBAR_W = 248
const RAIL_W = 64
const SIDE_MIN = 300
const SIDE_MAX = 600

function scopeKey(scope: ShellScope): string {
  return scope.kind === 'course' ? `course:${scope.courseId}` : 'main'
}

/** The unit part of a page key: `assess.test` → `assess`. */
function unitOf(page: string): string {
  return page.split('.')[0] ?? page
}

/** Observable shell state shared by the React tree and the `learnShell` service. */
class ShellState {
  activities: readonly ActivityItem[] = []
  scope: ShellScope = { kind: 'main' }
  selection: Selection | undefined
  courses: readonly Course[] = []
  coursesLoaded = false
  feed: 'connecting' | 'open' | 'error' = 'connecting'
  /** Side chat panel open (course scope only). */
  side = readLocal<boolean>('shell:side', false)
  sideWidth = readLocal<number>('shell:side-width', 380)
  /** The learner folded the sidebar to a rail. */
  collapsed = readLocal<boolean>('shell:collapsed', false)
  viewport = typeof window === 'undefined' ? 1440 : window.innerWidth
  /** Split-view columns side by side in the tab area. */
  columns = 1
  palette = false
  theme: 'light' | 'dark' = 'light'
  themePreference: ThemePreference | undefined
  /** Counts shown on activity-bar buttons, by activity id. */
  badges: ReadonlyMap<string, number> = new Map()
  /** The page in the active tab, and that tab's title. */
  active: (ActivePage & { readonly title: string }) | undefined
  dock: DockviewApi | undefined
  private pending: (() => void)[] = []
  private readonly listeners = new Set<Listener>()
  private restoring = false
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private startTimer: ReturnType<typeof setTimeout> | undefined

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(): void {
    for (const listener of this.listeners) listener()
  }

  update(patch: Partial<Pick<ShellState, 'scope' | 'selection' | 'courses' | 'coursesLoaded' | 'feed' | 'side' | 'sideWidth' | 'collapsed' | 'viewport' | 'columns' | 'palette' | 'theme' | 'themePreference' | 'badges' | 'active'>>): void {
    Object.assign(this, patch)
    if ('side' in patch) writeLocal('shell:side', this.side)
    if ('sideWidth' in patch) writeLocal('shell:side-width', this.sideWidth)
    if ('collapsed' in patch) writeLocal('shell:collapsed', this.collapsed)
    this.emit()
  }

  /**
   * The sidebar folds when the learner folded it, the window is narrow, or the split-view columns would
   * get narrower than `MIN_COLUMN` beside it. A side chat that floats anyway leaves the sidebar's room alone.
   */
  get rail(): boolean {
    if (this.collapsed || this.viewport < RAIL_BELOW) return true
    const side = this.sideOpen && !this.floatsWith(RAIL_W) ? this.sideWidth : 0
    return this.viewport - SIDEBAR_W - side < this.columns * MIN_COLUMN
  }

  /** The side chat floats over the page in a narrow window, or when docking it would squeeze the columns. */
  get drawer(): boolean {
    return this.floatsWith(this.rail ? RAIL_W : SIDEBAR_W)
  }

  private floatsWith(sidebar: number): boolean {
    return this.viewport < DRAWER_BELOW || this.viewport - sidebar - this.sideWidth < this.columns * MIN_COLUMN
  }

  get sideOpen(): boolean {
    return this.side
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

  /** Every button of the current scope, page list and footer alike. */
  scopedActivities(): ActivityItem[] {
    return this.activities.filter(item => item.scope === 'both' || item.scope === this.scope.kind)
  }

  /** The page list of the current scope; its first item is the start page. */
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

  setBadge(activityId: string, count: number): void {
    if ((this.badges.get(activityId) ?? 0) === count) return
    const badges = new Map(this.badges)
    if (count > 0) badges.set(activityId, count)
    else badges.delete(activityId)
    this.update({ badges })
  }

  attachDock(dock: DockviewApi): void {
    this.dock = dock
    dock.onDidActivePanelChange(() => this.syncActive())
    dock.onDidLayoutChange(() => {
      this.syncActive()
      this.scheduleSave()
      // One column per distinct left edge: groups stacked in a column share theirs.
      const columns = Math.max(1, new Set(dock.groups.map(group => Math.round(group.element.getBoundingClientRect().left))).size)
      if (columns !== this.columns) this.update({ columns })
    })
    const pending = this.pending
    this.pending = []
    for (const run of pending) run()
    if (dock.panels.length === 0) this.restore()
  }

  private syncActive(): void {
    const panel = this.dock?.activePanel
    const params = panel?.params as PanelParams | undefined
    const active = params ? { page: params.page, params: params.params, title: panel?.title ?? params.page } : undefined
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

  /** Open the scope's start page: its lowest-order activity. */
  openStart(): void {
    const start = this.visibleActivities()[0]
    if (start) this.open(start.page, {}, { title: start.title })
  }

  open(page: string, params: Record<string, unknown>, options: { readonly title?: string; readonly split?: boolean }): void {
    this.withDock(dock => {
      const id = params.id === undefined ? page : `${page}:${String(params.id)}`
      const existing = dock.getPanel(id)
      if (existing) {
        existing.api.setActive()
        return
      }
      const active = dock.activePanel
      dock.addPanel({
        id,
        component: 'page',
        title: options.title ?? this.activities.find(item => item.page === page)?.title ?? page,
        params: { page, params },
        ...(active ? { position: { referencePanel: active.id, direction: options.split ? 'right' : 'within' } } : {}),
      })
    })
  }

  /** Remember each interface's tabs, so leaving a course and coming back finds them as they were. */
  private scheduleSave(): void {
    if (this.restoring || !this.dock) return
    clearTimeout(this.saveTimer)
    const key = scopeKey(this.scope)
    const dock = this.dock
    this.saveTimer = setTimeout(() => writeLocal(`shell:layout:${key}`, dock.panels.length ? dock.toJSON() : null), 300)
  }

  private restore(): void {
    const dock = this.dock
    if (!dock) return
    const saved = readLocal<unknown>(`shell:layout:${scopeKey(this.scope)}`, null)
    this.restoring = true
    try {
      if (saved) dock.fromJSON(saved as Parameters<DockviewApi['fromJSON']>[0])
    } catch {
      dock.clear()
    } finally {
      this.restoring = false
    }
    if (dock.panels.length === 0) this.scheduleStart()
    this.syncActive()
  }

  /** Switching scope swaps the tab set: tabs belong to the interface they were opened in. */
  switchScope(scope: ShellScope): void {
    if (this.dock) {
      clearTimeout(this.saveTimer)
      writeLocal(`shell:layout:${scopeKey(this.scope)}`, this.dock.panels.length ? this.dock.toJSON() : null)
    }
    this.update({ scope, selection: undefined, badges: new Map(), active: undefined })
    writeLocal('shell:scope', scope)
    this.withDock(dock => {
      this.restoring = true
      dock.clear()
      this.restoring = false
      this.restore()
    })
  }
}

type PanelParams = { page: string; params: Record<string, unknown>; reloads?: number }
type RootProps = PropsRenderSlots<'learning.page' | 'learning.side-chat' | 'learning.sidebar' | 'learning.status' | 'learning.figure'>
const RenderSlot = createContext<RootProps['renderSlot'] | undefined>(undefined)
const StateContext = createContext<ShellState | undefined>(undefined)
const ThemeContext = createContext<{ set(preference: ThemePreference): void } | undefined>(undefined)

export function apply(ctx: ClientContext): void {
  const state = new ShellState()
  const feedListeners = new Set<(message: FeedMessage) => void>()
  let themeService: ThemeService | undefined

  // Come back to the interface the learner was in before the page reloaded.
  const lastScope = readLocal<ShellScope | null>('shell:scope', null)
  if (lastScope?.kind === 'course' && typeof lastScope.courseId === 'string') state.scope = lastScope

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
      // The breadcrumb falls back to the course id.
    }
  }

  const preview = (chunkId: string) => call<CitedChunk | null>('library', 'chunk', { chunkId }).then(chunk => (chunk ? { citation: chunk.citation, text: chunk.text, kind: chunk.kind } : undefined))

  const shell: LearnShell = {
    registerActivity: item => state.addActivity(item),
    setBadge: (activityId, count) => state.setBadge(activityId, count),
    openPage: (page, params = {}, options = {}) => state.open(page, params, options),
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
      if (!state.side) state.update({ side: true })
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
    // Citation badges open the source beside the current page, unless the page handles them; hovering one shows its text.
    Markdown: props => <Markdown {...props} onCite={props.onCite ?? (chunkId => state.open('library.sources', { id: chunkId, chunkId }, { title: '出处', split: true }))} preview={preview} figure={props.figure ?? drawFigure} />,
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

  // Window width decides the rail and drawer layouts.
  ctx.effect(() => {
    const resize = () => { if (window.innerWidth !== state.viewport) state.update({ viewport: window.innerWidth }) }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, 'learning-shell: viewport')

  // Ctrl/⌘+K opens the command palette from anywhere.
  ctx.effect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        state.update({ palette: !state.palette })
      }
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, 'learning-shell: shortcuts')

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
      'learning.sidebar': { kind: 'list', scope: 'root' },
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
  const renderSlot = useContext(RenderSlot)
  const scope = state.scope
  return (
    <div className="la-app" data-sidebar={state.rail ? 'rail' : 'expanded'} data-side={state.sideOpen ? 'open' : 'closed'}
      data-side-mode={state.drawer ? 'drawer' : 'column'} style={{ ['--la-side-w' as string]: `${state.sideWidth}px` }}>
      <Sidebar />
      <div className="la-center">
        <TopBar />
        <main className="la-main">
          <DockviewReact
            theme={DOCK_THEME}
            components={{ page: PagePanel }}
            defaultTabComponent={Tab}
            rightHeaderActionsComponent={TabActions}
            watermarkComponent={Watermark}
            onReady={event => state.attachDock(event.api)}
          />
        </main>
      </div>
      {state.sideOpen && (
        <aside className="la-side" aria-label="侧边提问">
          {!state.drawer && <SideResize />}
          <div className="la-panel-head">
            <span className="la-panel-title"><MessageCircleQuestion {...ICON} />侧边提问</span>
            <span className="la-panel-sub">不打断主老师的课</span>
            <button type="button" className="la-icon-btn" aria-label="关闭侧边提问" title="关闭侧边提问" onClick={() => state.update({ side: false })}><X {...ICON} /></button>
          </div>
          <div className="la-panel-body">
            {renderSlot?.('learning.side-chat', { scope }, { fallback: <div className="la-empty">侧边提问未加载</div> })}
          </div>
        </aside>
      )}
      <StatusBar />
      {state.palette && <Palette />}
    </div>
  )
}

function Sidebar(): ReactNode {
  const state = useShellState()
  const renderSlot = useContext(RenderSlot)
  const theme = useContext(ThemeContext)!
  const scope = state.scope
  const course = state.course()
  const activePage = state.active?.page
  const current = activePage ? state.activityFor(activePage) : undefined
  const switcher: MenuEntry[] = [
    { key: 'home', label: '主界面', icon: House, hint: '全部课程与资料库', checked: scope.kind === 'main', onSelect: () => state.switchScope({ kind: 'main' }) },
    ...(state.courses.length ? [{ heading: '课程' } as const] : []),
    ...state.courses.map(item => ({
      key: item.id, label: item.title, icon: GraduationCap, checked: scope.kind === 'course' && scope.courseId === item.id,
      onSelect: () => { if (!(scope.kind === 'course' && scope.courseId === item.id)) state.switchScope({ kind: 'course', courseId: item.id }) },
    })),
    'divider',
    { key: 'new', label: '新建课程', icon: Plus, onSelect: () => { state.switchScope({ kind: 'main' }); state.open('planner.home', {}, { title: '首页' }) } },
  ]
  const themeIcon = state.themePreference === 'dark' ? Moon : state.themePreference === 'light' ? Sun : SunMoon
  const themes: MenuEntry[] = [
    { heading: '外观' },
    { key: 'system', label: '跟随系统', icon: Monitor, checked: (state.themePreference ?? 'system') === 'system', onSelect: () => theme.set('system') },
    { key: 'light', label: '浅色', icon: Sun, checked: state.themePreference === 'light', onSelect: () => theme.set('light') },
    { key: 'dark', label: '深色', icon: Moon, checked: state.themePreference === 'dark', onSelect: () => theme.set('dark') },
  ]
  return (
    <nav className="la-sidebar" aria-label="导航">
      <div className="la-sidebar-head">
        <span className="la-brand"><span className="la-brand-mark"><GraduationCap size={15} strokeWidth={2} /></span><span className="la-brand-name">{APP_TITLE}</span></span>
      </div>
      <div className="la-sidebar-top">
        <Menu entries={switcher} width={260} trigger={props => (
          <button type="button" className="la-switcher" title={course?.title ?? '主界面'} {...props}>
            <span className={`la-switcher-avatar${course ? '' : ' home'}`}>{course ? Array.from(course.title)[0] : <House size={15} strokeWidth={1.75} />}</span>
            <span className="la-switcher-text">
              <span className="la-switcher-kicker">{course ? '当前课程' : '工作台'}</span>
              <span className="la-switcher-title">{course?.title ?? (scope.kind === 'course' ? '课程' : '主界面')}</span>
            </span>
            <ChevronsUpDown size={15} strokeWidth={1.75} className="la-switcher-chevron" />
          </button>
        )} />
        {state.rail && (
          <button type="button" className="la-search-trigger" aria-label="搜索与跳转" title="搜索与跳转（Ctrl K）" onClick={() => state.update({ palette: true })}>
            <Search size={16} strokeWidth={1.75} />
          </button>
        )}
      </div>
      <div className="la-sidebar-scroll">
        <div className="la-nav">
          {state.visibleActivities().map(item => {
            const badge = state.badges.get(item.id)
            return (
              <button key={item.id} type="button" className={`la-nav-item${current?.id === item.id ? ' is-active' : ''}`} title={item.title}
                aria-current={current?.id === item.id ? 'page' : undefined} onClick={() => state.open(item.page, {}, { title: item.title })}>
                <item.icon size={state.rail ? 19 : 17} strokeWidth={1.75} />
                <span className="la-nav-label">{item.title}</span>
                {badge ? <span className="la-nav-badge" aria-label={`${badge} 项待处理`}>{badge}</span> : null}
              </button>
            )
          })}
        </div>
        {!state.rail && renderSlot?.('learning.sidebar', { scope }, {})}
      </div>
      <div className="la-sidebar-foot">
        <Menu entries={themes} width={180} trigger={props => (
          <button type="button" className="la-icon-btn" title="外观" aria-label="外观" {...props}>
            {(() => { const Icon = themeIcon; return <Icon {...ICON} /> })()}<span className="la-foot-label">外观</span>
          </button>
        )} />
        {state.footActivities().map(item => (
          <button key={item.id} type="button" className={`la-icon-btn${current?.id === item.id ? ' is-active' : ''}`} title={item.title} aria-label={item.title}
            aria-current={current?.id === item.id ? 'page' : undefined} onClick={() => state.open(item.page, {}, { title: item.title })}>
            <item.icon {...ICON} /><span className="la-foot-label">{item.title}</span>
          </button>
        ))}
        <span className="la-spacer" />
        <button type="button" className="la-icon-btn" aria-label={state.rail ? '展开侧栏' : '收起侧栏'} title={state.rail ? '展开侧栏' : '收起侧栏'}
          disabled={!state.collapsed && state.viewport < RAIL_BELOW} onClick={() => state.update({ collapsed: !state.collapsed })}>
          {state.rail ? <PanelLeftOpen {...ICON} /> : <PanelLeftClose {...ICON} />}
        </button>
      </div>
    </nav>
  )
}

function TopBar(): ReactNode {
  const state = useShellState()
  const course = state.course()
  const active = state.active
  return (
    <header className="la-topbar">
      <nav className="la-crumbs" aria-label="位置">
        {state.scope.kind === 'course' ? (
          <button type="button" className="la-crumb la-crumb-link" onClick={() => state.openStart()} title="回到课程进度">{course?.title ?? '课程'}</button>
        ) : <span className="la-crumb">主界面</span>}
        {active && <><ChevronRight size={14} strokeWidth={1.75} className="la-crumb-sep" /><span className="la-crumb la-crumb-current">{active.title}</span></>}
      </nav>
      <button type="button" className="la-command" title="搜索与跳转（Ctrl K）" onClick={() => state.update({ palette: true })}>
        <Search size={15} strokeWidth={1.75} /><span>搜索页面、课程与操作</span><Kbd>Ctrl K</Kbd>
      </button>
      <div className="la-topbar-actions">
        {/* On the main interface the side chat asks which course the question is about. */}
        <button type="button" className={`la-toggle${state.sideOpen ? ' is-on' : ''}`} aria-pressed={state.sideOpen} title="侧边提问：针对选中的内容提问，不打断主老师"
          onClick={() => state.update({ side: !state.side })}>
          <MessageCircleQuestion {...ICON} />提问
        </button>
      </div>
    </header>
  )
}

/** Drag the side panel's left edge to resize it. */
function SideResize(): ReactNode {
  const state = useShellState()
  return (
    <div className="la-side-resize" role="separator" aria-orientation="vertical" aria-label="调整侧边提问宽度"
      onPointerDown={event => {
        event.preventDefault()
        const app = (event.currentTarget as HTMLElement).closest('.la-app') as HTMLElement | null
        const startX = event.clientX
        const startWidth = state.sideWidth
        app?.setAttribute('data-resizing', '')
        const move = (moveEvent: PointerEvent) => {
          const width = Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, startWidth + startX - moveEvent.clientX, 0), window.innerWidth * 0.5))
          app?.style.setProperty('--la-side-w', `${width}px`)
          state.sideWidth = width
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          app?.removeAttribute('data-resizing')
          state.update({ sideWidth: state.sideWidth })
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
      onDoubleClick={() => state.update({ sideWidth: 380 })} />
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

/** Tab: the page's icon and title, close on hover or when active; middle click closes. */
function Tab({ api, params }: IDockviewPanelHeaderProps<PanelParams>): ReactNode {
  const state = useShellState()
  const [title, setTitle] = useState(api.title ?? '')
  useEffect(() => {
    setTitle(api.title ?? '')
    const off = api.onDidTitleChange(event => setTitle(event.title))
    return () => off.dispose()
  }, [api])
  const Icon: IconComponent = state.activityFor(params.page)?.icon ?? File
  return (
    <div className="la-tab" title={title} onMouseDown={event => { if (event.button === 1) { event.preventDefault(); api.close() } }}>
      <Icon size={14} strokeWidth={1.75} className="la-tab-icon" />
      <span className="la-tab-title">{title}</span>
      <button type="button" className="la-tab-close" aria-label={`关闭 ${title}`} title="关闭"
        onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); api.close() }}>
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  )
}

/** Tab-bar actions: split the active tab to the right, focus one group, reload the page. */
function TabActions({ activePanel, group, containerApi }: IDockviewHeaderActionsProps): ReactNode {
  const [, setVersion] = useState(0)
  useEffect(() => {
    const off = containerApi.onDidLayoutChange(() => setVersion(v => v + 1))
    return () => off.dispose()
  }, [containerApi])
  if (!activePanel) return null
  const maximized = group.api.isMaximized()
  const several = containerApi.groups.length > 1
  return (
    <div className="la-tab-actions">
      {group.panels.length > 1 && (
        <button type="button" className="la-icon-btn" aria-label="移到右侧分屏" title="移到右侧分屏" onClick={() => activePanel.api.moveTo({ group, position: 'right' })}>
          <Columns2 size={15} strokeWidth={1.75} />
        </button>
      )}
      {(several || maximized) && (
        <button type="button" className="la-icon-btn" aria-label={maximized ? '恢复分屏' : '只看这一栏'} title={maximized ? '恢复分屏' : '只看这一栏'}
          onClick={() => (maximized ? group.api.exitMaximized() : group.api.maximize())}>
          {maximized ? <Minimize2 size={15} strokeWidth={1.75} /> : <Maximize2 size={15} strokeWidth={1.75} />}
        </button>
      )}
      <button type="button" className="la-icon-btn" aria-label="刷新这个页面" title="刷新这个页面" onClick={() => {
        const params = activePanel.params as PanelParams
        activePanel.api.updateParameters({ ...params, reloads: (params.reloads ?? 0) + 1 })
      }}>
        <RotateCw size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}

function Watermark(_: IWatermarkPanelProps): ReactNode {
  const state = useShellState()
  useShellVersion(state)
  const start = state.visibleActivities().slice(0, 4)
  return (
    <div className="la-watermark">
      <EmptyState icon={GraduationCap} title="没有打开的页面" description={<>从左侧选择页面，或按 <Kbd>Ctrl K</Kbd> 搜索与跳转。</>}
        action={<div className="la-row" style={{ justifyContent: 'center' }}>{start.map(item => (
          <button key={item.id} type="button" className="la-btn la-btn-sm" onClick={() => state.open(item.page, {}, { title: item.title })}><item.icon size={14} strokeWidth={1.75} />{item.title}</button>
        ))}</div>} />
    </div>
  )
}

function PagePanel({ params }: IDockviewPanelProps<PanelParams>): ReactNode {
  const renderSlot = useContext(RenderSlot)
  const state = useShellState()
  const scope = useSyncExternalStore(state.subscribe, () => state.scope)
  if (!renderSlot) return null
  // A new key remounts the page, so it reloads its data from scratch.
  return (
    <div className="la-page" key={params.reloads ?? 0}>
      {renderSlot('learning.page', { scope, params: params.params }, {
        entryKey: params.page,
        fallback: <div className="la-empty">页面 {params.page} 尚未注册</div>,
      })}
    </div>
  )
}

interface PaletteItem {
  readonly key: string
  readonly group: string
  readonly label: string
  readonly icon: IconComponent
  readonly hint?: string
  readonly keywords?: string
  run(): void
}

/** Ctrl K: jump to a page or course, or run a shell action. */
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
    const result: PaletteItem[] = state.scopedActivities().map(item => ({
      key: `page:${item.id}`, group: course ? `${course.title} 的页面` : '页面', label: item.title, icon: item.icon, hint: '打开', run: () => state.open(item.page, {}, { title: item.title }),
    }))
    for (const item of state.courses) {
      if (scope.kind === 'course' && scope.courseId === item.id) continue
      result.push({ key: `course:${item.id}`, group: '课程', label: item.title, icon: GraduationCap, hint: '进入课程', run: () => state.switchScope({ kind: 'course', courseId: item.id }) })
    }
    if (scope.kind === 'course') {
      result.push({ key: 'leave', group: '操作', label: '回到主界面', icon: ArrowLeft, keywords: '首页 返回', run: () => state.switchScope({ kind: 'main' }) })
      result.push({ key: 'side', group: '操作', label: state.side ? '关闭侧边提问' : '打开侧边提问', icon: MessageCircleQuestion, keywords: '提问 侧边会话', run: () => state.update({ side: !state.side }) })
    }
    result.push({ key: 'rail', group: '操作', label: state.collapsed ? '展开侧栏' : '收起侧栏', icon: state.collapsed ? PanelLeftOpen : PanelLeftClose, run: () => state.update({ collapsed: !state.collapsed }) })
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
  const run = (item: PaletteItem | undefined) => {
    if (!item) return
    close()
    item.run()
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
              else if (event.key === 'Enter') { event.preventDefault(); run(shown[active]) }
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
                <button type="button" role="option" aria-selected={index === active} data-active={index === active} className="la-palette-item"
                  onMouseMove={() => setActive(index)} onClick={() => run(item)}>
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
          <span><Kbd>Esc</Kbd>关闭</span>
        </div>
      </div>
    </div>
  )
}
