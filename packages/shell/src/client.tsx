// Shell, browser half. Takes over DSH's `root` slot (stage-0 V2) and owns the page frame:
// top bar, activity bar, dockview tabs, right sidebar, status bar. It declares the `learning.page`
// and `learning.side-chat` slots and provides `ctx.learnShell` (contracts §6.3): pages, scope,
// selection, the shared change-feed connection, endpoint calls and the shared Markdown renderer.
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { DockviewReact, themeLight, type DockviewApi, type IDockviewPanelProps } from 'dockview'
import dockviewCss from 'dockview/dist/styles/dockview.css'
import katexCss from 'katex/dist/katex.min.css'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { API_CHANNEL, FEED_PATH, endpointName, type Course, type FeedMessage, type Id, type Selection } from '@learning-agent/contracts'
import type { ActivityItem, ClientContext, LearnShell, ShellScope } from '@learning-agent/contracts/client'
import { Markdown } from './client/markdown.tsx'
import shellCss from './shell.css'

export const name = 'learning-shell'
export const inject = ['slots', 'connection']

type Listener = () => void

/** Observable shell state shared by the React tree and the `learnShell` service. */
class ShellState {
  activities: readonly ActivityItem[] = []
  scope: ShellScope = { kind: 'main' }
  selection: Selection | undefined
  courses: readonly Course[] = []
  feed: 'connecting' | 'open' | 'error' = 'connecting'
  sidebar = true
  dock: DockviewApi | undefined
  private pending: (() => void)[] = []
  private readonly listeners = new Set<Listener>()

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(): void {
    for (const listener of this.listeners) listener()
  }

  update(patch: Partial<Pick<ShellState, 'scope' | 'selection' | 'courses' | 'feed' | 'sidebar'>>): void {
    Object.assign(this, patch)
    this.emit()
  }

  addActivity(item: ActivityItem): () => void {
    this.activities = [...this.activities, item].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    this.emit()
    this.withDock(dock => { if (dock.panels.length === 0) this.openStart() })
    return () => {
      this.activities = this.activities.filter(existing => existing !== item)
      this.emit()
    }
  }

  visibleActivities(): ActivityItem[] {
    return this.activities.filter(item => item.scope === 'both' || item.scope === this.scope.kind)
  }

  attachDock(dock: DockviewApi): void {
    this.dock = dock
    const pending = this.pending
    this.pending = []
    for (const run of pending) run()
    if (dock.panels.length === 0) this.openStart()
  }

  /** Run once dockview is ready (pages may be opened before the first render). */
  withDock(run: (dock: DockviewApi) => void): void {
    if (this.dock) run(this.dock)
    else this.pending.push(() => run(this.dock!))
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

  /** Switching scope swaps the tab set: tabs belong to the interface they were opened in. */
  switchScope(scope: ShellScope): void {
    this.update({ scope, selection: undefined })
    this.withDock(dock => {
      for (const panel of [...dock.panels]) panel.api.close()
      this.openStart()
    })
  }
}

type RootProps = PropsRenderSlots<'learning.page' | 'learning.side-chat'>
const RenderSlot = createContext<RootProps['renderSlot'] | undefined>(undefined)
const StateContext = createContext<ShellState | undefined>(undefined)

export function apply(ctx: ClientContext): void {
  const state = new ShellState()
  const feedListeners = new Set<(message: FeedMessage) => void>()

  async function call<T>(unit: string, method: string, payload: unknown = {}): Promise<T> {
    const result = await ctx.connection.rpc.call(API_CHANNEL, endpointName(unit, method), payload) as
      { ok: true; value: T } | { ok: false; error: unknown }
    if (!result.ok) throw result.error
    return result.value
  }

  async function refreshCourses(): Promise<void> {
    try {
      state.update({ courses: await call<Course[]>('core', 'courses') })
    } catch {
      // The breadcrumb falls back to the course id.
    }
  }

  const shell: LearnShell = {
    registerActivity: item => state.addActivity(item),
    openPage: (page, params = {}, options = {}) => state.open(page, params, options),
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
    // Citation badges open the source in the library beside the current page, unless the page handles them.
    Markdown: props => <Markdown {...props} onCite={props.onCite ?? (chunkId => state.open('library.sources', { id: chunkId, chunkId }, { title: '出处', split: true }))} />,
  }

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.owner = name
    style.textContent = `${dockviewCss}\n${katexCss}\n${shellCss}`
    document.head.append(style)
    return () => style.remove()
  }, 'learning-shell: styles')

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
        <RenderSlot.Provider value={renderSlot}>
          <Frame />
        </RenderSlot.Provider>
      </StateContext.Provider>
    )
  }

  ctx.effect(() => ctx.slots.register({
    name: 'root',
    children: {
      'learning.page': { kind: 'keyed', scope: 'root' },
      'learning.side-chat': { kind: 'single', scope: 'root' },
    },
  }, Root), 'learning-shell: root')
}

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

function Frame(): ReactNode {
  const state = useShellState()
  useShellVersion(state)
  const renderSlot = useContext(RenderSlot)
  const scope = state.scope
  const course = scope.kind === 'course' ? state.courses.find(c => c.id === scope.courseId) : undefined
  return (
    <div className={`la-app${state.sidebar ? ' with-sidebar' : ''}`}>
      <header className="la-top">
        <span className="la-brand">学习工作台</span>
        <nav className="la-crumb">
          <button className="la-link" onClick={() => { if (scope.kind !== 'main') state.switchScope({ kind: 'main' }) }}>主界面</button>
          {scope.kind === 'course' && <><span className="la-sep">›</span><span>{course?.title ?? scope.courseId}</span></>}
        </nav>
        <span className="la-spacer" />
        <button className="la-btn la-btn-quiet" onClick={() => state.update({ sidebar: !state.sidebar })}>
          {state.sidebar ? '收起侧边会话' : '侧边会话'}
        </button>
      </header>
      <nav className="la-activity">
        {state.visibleActivities().map(item => (
          <button
            key={item.id}
            className="la-activity-item"
            title={item.title}
            onClick={() => state.open(item.page, {}, { title: item.title })}
          >
            {item.glyph}
          </button>
        ))}
      </nav>
      <main className="la-main">
        <DockviewReact
          className="dockview-theme-light"
          theme={themeLight}
          components={{ page: PagePanel }}
          onReady={event => state.attachDock(event.api)}
        />
      </main>
      {state.sidebar && (
        <aside className="la-side">
          {renderSlot?.('learning.side-chat', { scope }, { fallback: <div className="la-empty">侧边会话未加载</div> })}
        </aside>
      )}
      <footer className="la-status">
        <span>{scope.kind === 'main' ? '主界面' : course?.title ?? '课程'}</span>
        <span className="la-spacer" />
        <span>{{ connecting: '推送连接中…', open: '推送已连接', error: '推送断开，重连中' }[state.feed]}</span>
      </footer>
    </div>
  )
}

function PagePanel({ params }: IDockviewPanelProps<{ page: string; params: Record<string, unknown> }>): ReactNode {
  const renderSlot = useContext(RenderSlot)
  const state = useShellState()
  const scope = useSyncExternalStore(state.subscribe, () => state.scope)
  if (!renderSlot) return null
  return (
    <div className="la-page">
      {renderSlot('learning.page', { scope, params: params.params }, {
        entryKey: params.page,
        fallback: <div className="la-empty">页面 {params.page} 尚未注册</div>,
      })}
    </div>
  )
}
