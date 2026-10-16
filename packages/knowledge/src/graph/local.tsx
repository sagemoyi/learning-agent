// The course sidebar's local graph, as Obsidian's local graph follows the active note: what the active tab is
// about and its neighbours one or two relations away. A textbook lesson shows the knowledge points it explains,
// a node's detail page (or the node selected on the graph page) that node, any other page the current stage's
// core nodes. Clicking a node or a list item opens its detail in the main tab, and the sidebar follows it.
// The canvas starts afresh for each focus, so nodes of an earlier lesson never linger unseen in the layout.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { BookOpen, Network, Target } from 'lucide-react'
import type { ActivePage, LearnShell } from '@learning-agent/contracts/client'
import type { Selection } from '@learning-agent/contracts'
import { Dot, Segmented, Skeleton, useLoad, useLocalState, type Tone } from '@learning-agent/kit/client'
import { GraphCanvas, type GraphCanvasHandle } from './canvas.tsx'
import { onThemeChange, readColors, type GraphColors } from './colors.ts'
import { buildModel, neighborhood, shownState, stateText } from './model.ts'
import { GraphLegend, ShapeMark, STATE_TONE, loadPage, useGraphSettings, type OpenNode } from './page.tsx'

/** What the sidebar follows. */
export type LocalFocus =
  | { readonly kind: 'lesson'; readonly lessonId?: string }
  | { readonly kind: 'node'; readonly nodeId: string }
  | { readonly kind: 'stage' }

export function focusOf(active: ActivePage | undefined, selection: Selection | undefined): LocalFocus {
  if (active?.page === 'textbook.reader') return { kind: 'lesson', ...(typeof active.params.id === 'string' ? { lessonId: active.params.id } : {}) }
  if (active?.page === 'knowledge.detail' && typeof active.params.nodeId === 'string') return { kind: 'node', nodeId: active.params.nodeId }
  if (active?.page === 'knowledge.graph' && selection?.page === 'knowledge.graph' && selection.selected?.kind === 'node' && selection.selected.id) return { kind: 'node', nodeId: selection.selected.id }
  return { kind: 'stage' }
}

interface LessonNodes {
  readonly lesson: { readonly id: string; readonly number: string; readonly title: string }
  readonly nodeIds: readonly string[]
  readonly from: 'textbook' | 'material'
}

export function LocalGraphPanel({ shell, courseId, openNode }: { shell: LearnShell; courseId: string; openNode: OpenNode }): ReactNode {
  const active = useSyncExternalStore(listener => shell.onActivePage(listener), () => shell.activePage())
  const selection = useSyncExternalStore(listener => shell.onSelection(listener), () => shell.selection())
  const focus = focusOf(active, selection)
  const focusKey = focus.kind === 'lesson' ? `lesson:${focus.lessonId ?? ''}` : focus.kind === 'node' ? `node:${focus.nodeId}` : 'stage'
  const data = useLoad(shell, () => loadPage(shell, courseId, ''), [courseId])
  const lesson = useLoad(shell, async () => focus.kind === 'lesson' ? shell.call<LessonNodes | null>('textbook', 'lessonNodes', { courseId, ...(focus.lessonId ? { lessonId: focus.lessonId } : {}) }) : null, [courseId, focusKey])
  const [depth, setDepth] = useLocalState<'1' | '2'>('knowledge.local-depth', '1')
  const [settings] = useGraphSettings()
  // Little room for names: the focused nodes and the hovered one are named, others when zoomed in.
  const compact = useMemo(() => ({ ...settings, labels: 0 }), [settings])
  const [colors, setColors] = useState<GraphColors>(readColors)
  useEffect(() => onThemeChange(() => setColors(readColors())), [])
  const [noWebgl, setNoWebgl] = useState(false)
  const canvas = useRef<GraphCanvasHandle>(null)

  const page = data.data
  const byId = useMemo(() => new Map((page?.nodes ?? []).map(node => [node.id, node])), [page])
  const stage = page?.stages.find(item => item.status !== 'done' && item.nodeIds.length > 0)
  // What the sidebar is about now, in the course's own nodes only.
  const about = useMemo(() => {
    if (!page) return undefined
    const own = (ids: readonly string[]) => ids.filter(id => byId.get(id)?.inScope)
    if (focus.kind === 'node') {
      const node = byId.get(focus.nodeId)
      return node ? { icon: Network, title: node.title, ids: own([node.id]), empty: '' } : undefined
    }
    if (focus.kind === 'lesson') {
      if (lesson.loading && lesson.data === undefined) return undefined
      const found = lesson.data
      if (found) return { icon: BookOpen, title: `${found.lesson.number} ${found.lesson.title}`, ids: own(found.nodeIds), empty: found.from === 'textbook' ? '这节教材还没关联知识点' : '这节还没写好，原文里也还没找到对应的知识点' }
    }
    return stage ? { icon: Target, title: stage.title, ids: own(stage.nodeIds), empty: '' } : { icon: Target, title: '本课', ids: [], empty: '还没有排进阶段的知识点' }
  }, [page, byId, focusKey, lesson.data, lesson.loading, stage])

  const model = useMemo(() => {
    if (!page || !about?.ids.length) return undefined
    const own = page.nodes.filter(node => node.inScope)
    const ownIds = new Set(own.map(node => node.id))
    const edges = page.edges.filter(edge => ownIds.has(edge.from) && ownIds.has(edge.to))
    const links = edges.map(edge => ({ source: edge.from, target: edge.to }))
    const near = new Set<string>()
    for (const id of about.ids) for (const other of neighborhood(links, id, Number(depth))) near.add(other)
    return buildModel(own.filter(node => near.has(node.id)), edges.filter(edge => near.has(edge.from) && near.has(edge.to)), {
      colorBy: 'state', relation: 'all', showOutside: false, depth: 'all', query: '', states: page.states, courseId, courses: page.courses, emphasis: new Set(about.ids),
    }, colors)
  }, [page, about, depth, colors, courseId])

  const open = (id: string, newTab = false) => {
    const node = byId.get(id)
    if (node) openNode(node.id, node.title, courseId, newTab)
  }
  if (data.error && !page) return <div className="la-side-empty">{data.error}</div>
  if (!page || !about) return <div className="la-local"><Skeleton lines={4} /></div>
  if (!page.nodes.some(node => node.inScope)) return <div className="la-side-empty">本课还没有知识节点。确认目标后，主老师会根据骨架教材搭出初版知识图</div>
  const Icon = about.icon
  const others = model ? model.nodes.length - about.ids.length : 0
  return (
    <div className="la-local">
      <div className="la-local-head">
        <Icon size={15} strokeWidth={1.75} />
        <span className="la-local-title" title={about.title}>{about.title}</span>
        {about.ids.length > 0 && <span className="la-local-count">{about.ids.length} 个知识点</span>}
      </div>
      {model && !noWebgl && <>
        <div className="la-local-stage">
          <GraphCanvas key={`${focusKey}|${depth}`} ref={canvas} model={model} colors={colors} settings={compact} active clickOpens boost={2.2}
            onSelect={() => {}} onOpen={open} onUnavailable={() => setNoWebgl(true)}
            label={`局部图：${about.title}，${model.nodes.length} 个节点；点节点打开详情`} />
        </div>
        <div className="la-local-tools">
          <Segmented<'1' | '2'> value={depth} onChange={setDepth} aria-label="显示几跳以内的相邻节点" options={[{ value: '1', label: '一跳' }, { value: '2', label: '两跳' }]} />
          <span className="la-local-count">{others > 0 ? `另有 ${others} 个相邻` : '没有相邻节点'}</span>
        </div>
        <GraphLegend compact colors={colors} colorBy="state" courses={page.courses} stages={page.stages} stateError={!!page.stateError} />
      </>}
      {about.ids.length === 0 ? <div className="la-side-empty">{about.empty}</div> : (
        <div className="la-tree la-local-list" onMouseLeave={() => canvas.current?.highlight(undefined)}>
          {about.ids.map(id => {
            const node = byId.get(id)!
            const text = stateText(node, { states: page.states, courseId })
            const state = page.states ? shownState(node, page.states, courseId).state : 'untested'
            const tone: Tone = !page.states || text === '本课条件待验证' ? 'neutral' : STATE_TONE[state]
            return (
              <button key={id} type="button" className="la-tree-item two-line" data-la-opens="" title={`${node.title}\n${text}`}
                onClick={event => open(id, event.ctrlKey || event.metaKey)} onMouseEnter={() => canvas.current?.highlight(id)} onFocus={() => canvas.current?.highlight(id)} onBlur={() => canvas.current?.highlight(undefined)}>
                <ShapeMark kind={node.kind} />
                <span className="la-tree-lines">
                  <span className="la-tree-title">{node.title}</span>
                  <span className="la-tree-sub"><Dot tone={tone} hollow={state === 'untested' || tone === 'neutral'} />{text}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
      <div className="la-side-foot">
        <button type="button" className="la-link" data-la-opens="" onClick={event => shell.openPage('knowledge.graph', {}, { title: '知识模型', newTab: event.ctrlKey || event.metaKey })}>本课知识图谱全页</button>
      </div>
    </div>
  )
}
