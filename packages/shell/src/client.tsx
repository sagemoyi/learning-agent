// Shell, browser half. Takes over DSH's `root` slot (stage-0 V2) and owns the page frame:
// top bar, activity bar, dockview tabs, status bar. It declares the `learning.page` slot and
// provides `ctx.learnShell`, so feature units add pages without importing the shell.
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { DockviewReact, type DockviewApi, type IDockviewPanelProps } from 'dockview'
import dockviewCss from 'dockview/dist/styles/dockview.css'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ActivityItem, ClientContext, LearnShell, ShellScope } from '@learning-agent/contracts/client'
import shellCss from './shell.css'

export const name = 'learning-shell'
export const inject = ['slots']

/** Observable shell state shared by the React tree and the `learnShell` service. */
class ShellState {
  activities: readonly ActivityItem[] = []
  scope: ShellScope = { kind: 'main' }
  dock: DockviewApi | undefined
  private pending: (() => void)[] = []
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  addActivity(item: ActivityItem): () => void {
    this.activities = [...this.activities, item].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
    this.emit()
    return () => {
      this.activities = this.activities.filter(existing => existing !== item)
      this.emit()
    }
  }

  attachDock(dock: DockviewApi): void {
    this.dock = dock
    const pending = this.pending
    this.pending = []
    for (const run of pending) run()
  }

  /** Run once dockview is ready (pages may be opened before the first render). */
  withDock(run: (dock: DockviewApi) => void): void {
    if (this.dock) run(this.dock)
    else this.pending.push(() => run(this.dock!))
  }
}

type RootProps = PropsRenderSlots<'learning.page'>
const RenderSlot = createContext<RootProps['renderSlot'] | undefined>(undefined)
const StateContext = createContext<ShellState | undefined>(undefined)

export function apply(ctx: ClientContext): void {
  const state = new ShellState()

  const shell: LearnShell = {
    registerActivity: item => state.addActivity(item),
    openPage(page, params = {}, options = {}) {
      state.withDock(dock => {
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
          title: options.title ?? page,
          params: { page, params },
          ...(active ? { position: { referencePanel: active.id, direction: options.split ? 'right' : 'within' } } : {}),
        })
      })
    },
    scope: () => state.scope,
  }

  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.owner = name
    style.textContent = `${dockviewCss}\n${shellCss}`
    document.head.append(style)
    return () => style.remove()
  }, 'learning-shell: styles')

  ctx.effect(() => {
    const dispose = ctx.reflect.provide('learnShell', shell)
    return () => { void dispose() }
  }, 'learning-shell: learnShell service')

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
    children: { 'learning.page': { kind: 'keyed', scope: 'root' } },
  }, Root), 'learning-shell: root')
}

function useShellState(): ShellState {
  const state = useContext(StateContext)
  if (!state) throw new Error('learning-shell: state context missing')
  return state
}

function Frame(): ReactNode {
  const state = useShellState()
  const activities = useSyncExternalStore(state.subscribe, () => state.activities)
  const scope = useSyncExternalStore(state.subscribe, () => state.scope)
  const visible = activities.filter(item => item.scope === 'both' || item.scope === scope.kind)
  return (
    <div className="la-app">
      <header className="la-top">
        <span className="la-brand">学习工作台</span>
        <span className="la-crumb">{scope.kind === 'main' ? '主界面' : `课程 ${scope.courseId}`}</span>
      </header>
      <nav className="la-activity">
        {visible.map(item => (
          <button
            key={item.id}
            className="la-activity-item"
            title={item.title}
            onClick={() => state.withDock(() => openFromActivity(state, item))}
          >
            {item.glyph}
          </button>
        ))}
      </nav>
      <main className="la-main">
        <DockviewReact
          className="dockview-theme-light"
          components={{ page: PagePanel }}
          onReady={event => state.attachDock(event.api)}
        />
      </main>
      <footer className="la-status">阶段 0 · 骨架</footer>
    </div>
  )
}

function openFromActivity(state: ShellState, item: ActivityItem): void {
  const dock = state.dock!
  const existing = dock.getPanel(item.page)
  if (existing) existing.api.setActive()
  else dock.addPanel({ id: item.page, component: 'page', title: item.title, params: { page: item.page, params: {} } })
}

function PagePanel({ params }: IDockviewPanelProps<{ page: string; params: Record<string, unknown> }>): ReactNode {
  const renderSlot = useContext(RenderSlot)
  const state = useShellState()
  if (!renderSlot) return null
  return (
    <div className="la-page">
      {renderSlot('learning.page', { scope: state.scope, params: params.params }, {
        entryKey: params.page,
        fallback: <div className="la-empty">页面 {params.page} 尚未注册</div>,
      })}
    </div>
  )
}
