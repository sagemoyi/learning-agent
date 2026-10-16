// The knowledge page: a graph (default) or the grouped list, for one course or for every course on
// the main screen. The side panel lists nodes (keyboard) or describes the selected one; the graph
// and the list share one selection, and hovering a list item lights the node up on the graph.
// The gear on the canvas holds the graph's display and force settings (settings.ts).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowRight, Blocks, BookOpen, Brain, Clock, ExternalLink, FileSearch, GitMerge, List, Maximize2, MessageCircle, Network, Plus, Search, Settings2, Shuffle, Target, Wrench, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { CourseGraph, EdgeType, KnowledgeDetail, KnowledgeGlobal, KnowledgeSourceLayer, MasteryState, MergeSuggestion, NodeKind, NodeState, RelationStatus, Stage } from '@learning-agent/contracts'
import type { IconComponent, LearnShell, LearningPageProps } from '@learning-agent/contracts/client'
import { Button, Callout, Checkbox, ContextMenu, Dot, EmptyState, ErrorText, Page, PageHeader, Section, Segmented, Select, Skeleton, Slider, Tag, TextField, useLoad, useLocalState, type MenuEntry, type Tone } from '@learning-agent/kit/client'
import { KIND_LABEL, STATUS_LABEL } from '../labels.ts'
import { GraphCanvas, type GraphCanvasHandle } from './canvas.tsx'
import { onThemeChange, readColors, type GraphColors } from './colors.ts'
import { buildModel, matches, shownState, stateText, STATE_TEXT, type Depth, type DrawKind, type GraphEdgeInput, type GraphNodeInput, type ExamFilter, type RelationFilter, type ShownState, type StageGroup } from './model.ts'
import { DEFAULT_SETTINGS, SETTING_LABELS, withDefaults, type GraphSettings } from './settings.ts'

export const STATE_TONE: Record<MasteryState, Tone> = { untested: 'neutral', 'not-yet': 'warn', assisted: 'accent', independent: 'ok', retained: 'ok', conflict: 'bad' }
const STATE_ORDER: MasteryState[] = ['untested', 'not-yet', 'assisted', 'independent', 'retained', 'conflict']
const KINDS: { kind: NodeKind; icon: IconComponent }[] = [
  { kind: 'knowledge', icon: Brain }, { kind: 'skill', icon: Wrench }, { kind: 'integrated', icon: Blocks }, { kind: 'task', icon: Target },
]
const RELATIONS: { value: RelationFilter; label: string }[] = [
  { value: 'all', label: '全部关系' }, { value: 'order', label: '先修和建议先学' }, { value: 'part', label: '组成' }, { value: 'related', label: '相关' },
]
const EXAM_FILTERS: { value: ExamFilter; label: string }[] = [
  { value: 'all', label: '考试范围：全部' }, { value: 'in-scope', label: '只看考试范围内' }, { value: 'outside', label: '只看范围外' },
]

/** A relation as a sentence in learning order, matching the arrow on the graph. */
export function relationSentence(edge: { from: string; to: string; type: EdgeType }, title: (id: string) => string): string {
  if (edge.type === 'requires') return `${title(edge.to)} 是 ${title(edge.from)} 的先修`
  if (edge.type === 'recommended-before') return `建议先学 ${title(edge.from)}，再学 ${title(edge.to)}`
  if (edge.type === 'part-of') return `${title(edge.from)} 是 ${title(edge.to)} 的组成部分`
  return `${title(edge.from)} 与 ${title(edge.to)} 相关`
}

/** Shape marks for the legend and the list, matching the graph. */
export function ShapeMark({ kind, color = 'currentColor' }: { kind: DrawKind; color?: string }): ReactNode {
  const shape = kind === 'skill' ? <rect x="2.5" y="2.5" width="9" height="9" fill={color} />
    : kind === 'integrated' ? <path d="M7 1.2 12.8 7 7 12.8 1.2 7Z" fill={color} />
    : kind === 'task' ? <path d="M7 1.5 12.8 11.8H1.2Z" fill={color} />
    : kind === 'source' || kind === 'textbook' ? <circle cx="7" cy="7" r="4.4" fill="none" stroke={color} strokeWidth="2" />
    : <circle cx="7" cy="7" r="5.2" fill={color} />
  return <svg className="la-shape-mark" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">{shape}</svg>
}

interface PageNode extends GraphNodeInput {
  readonly description: string
  readonly role?: 'core' | 'related'
}

export interface PageData {
  readonly nodes: readonly PageNode[]
  readonly edges: readonly (GraphEdgeInput & { readonly rationale: string })[]
  readonly courses: KnowledgeGlobal['courses']
  readonly course?: CourseGraph
  /** The course's stages with their core nodes ("colour by stage", the sidebar's current stage). */
  readonly stages: readonly (StageGroup & { readonly status: Stage['status'] })[]
  readonly states?: ReadonlyMap<string, NodeState>
  readonly stateError?: string
}

export async function loadPage(shell: LearnShell, courseId: string | undefined, courseFilter: string): Promise<PageData> {
  const [global, course, overview] = await Promise.all([
    shell.call<KnowledgeGlobal>('knowledge', 'global', {}),
    courseId ? shell.call<CourseGraph>('knowledge', 'graph', { courseId }) : Promise.resolve(undefined),
    // Stages only colour the graph and pick the sidebar's default: without them the graph still works.
    courseId ? shell.call<{ stages: Stage[] }>('curriculum', 'overview', { courseId }).catch(() => ({ stages: [] })) : Promise.resolve({ stages: [] }),
  ])
  const stages = overview.stages.map(stage => ({ id: stage.id as string, title: `第 ${stage.index} 阶段 ${stage.title}`, nodeIds: stage.nodeIds as readonly string[], status: stage.status }))
  // A remembered course filter may name a course that is gone: then show every course.
  const scope = courseId ?? (global.courses.some(course => course.id === courseFilter) ? courseFilter : undefined)
  const members = course ? new Map(course.nodes.map(node => [node.id as string, node])) : undefined
  const nodes: PageNode[] = global.nodes.map(node => ({
    id: node.id, title: node.title, aliases: node.aliases, kind: node.kind, domain: node.domain, description: node.description,
    courseIds: node.courseIds, inScope: members ? members.has(node.id) : !scope || node.courseIds.includes(scope as never),
    ...(node.formerTitles ? { formerTitles: node.formerTitles } : {}),
    ...(members?.get(node.id) ? { role: members.get(node.id)!.role } : {}),
    ...(members?.get(node.id)?.membership.exam ? { exam: members.get(node.id)!.membership.exam } : {}),
  }))
  // The course page keeps its own relations and global ones; another course's scoped relations stay out.
  const edges = global.edges
    .filter(edge => edge.scope.kind === 'global' || !scope || edge.scope.courseId === scope)
    .map(edge => ({ id: edge.id, from: edge.from, to: edge.to, type: edge.type, status: edge.status, usable: edge.usable, rationale: edge.rationale }))
  const linked = new Set<string>(edges.flatMap(edge => [edge.from, edge.to]))
  const ids = nodes.filter(node => node.inScope || linked.has(node.id)).map(node => node.id)
  try {
    const states = await shell.call<NodeState[]>('learner', 'states', { nodeIds: ids })
    return { nodes, edges, courses: global.courses, course, stages, states: new Map(states.map(state => [state.nodeId as string, state])) }
  } catch {
    return { nodes, edges, courses: global.courses, course, stages, stateError: '掌握状态暂不可用，请稍后刷新；知识节点仍可查看' }
  }
}

export function KnowledgePage({ shell, scope, openNode }: LearningPageProps & { shell: LearnShell; openNode: OpenNode }): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const [view, setView] = useLocalState<'graph' | 'list'>('knowledge.view', 'graph')
  const [noWebgl, setNoWebgl] = useState(false)
  const [courseFilter, setCourseFilter] = useLocalState('knowledge.course-filter', '')
  const data = useLoad(shell, () => loadPage(shell, courseId, courseFilter), [courseId, courseFilter])
  const merges = useLoad(shell, () => shell.call<MergeSuggestion[]>('knowledge', 'mergeSuggestions', courseId ? { courseId } : {}), [courseId])
  const description = courseId
    ? '本课的知识、关系与出处。掌握状态只由作答证据决定'
    : '所有课程的知识网。同一项知识可以被几门课共用'
  const graphView = view === 'graph' && !noWebgl
  return (
    <Page width="full">
      <PageHeader eyebrow={<><Network size={14} strokeWidth={1.75} />{courseId ? '本课' : '全部课程'}</>} title="知识模型" description={description}
        actions={<>
          <Segmented<'graph' | 'list'> value={graphView ? 'graph' : 'list'} onChange={setView} aria-label="显示方式"
            options={[{ value: 'graph', label: '图谱' }, { value: 'list', label: '列表' }]} disabled={noWebgl} />
          {courseId && <Button icon={Clock} opens onClick={() => shell.openPage('knowledge.history', {}, { title: '知识变更' })}>变更记录</Button>}
          {courseId && <Button icon={FileSearch} opens onClick={() => shell.openPage('knowledge.extract', {}, { title: '按小节抽取' })}>按小节抽取</Button>}
          {courseId && <Button icon={Plus} opens onClick={() => shell.openPage('knowledge.add', {}, { title: '添加知识' })}>添加节点</Button>}
        </>} />
      {(merges.data?.length ?? 0) > 0 && <Callout icon={GitMerge} actions={<Button size="sm" opens onClick={() => shell.openPage('knowledge.merge', {}, { title: '合并建议' })}>去比较</Button>}>
        有 {merges.data!.length} 组节点可能是同一项知识{merges.data!.some(item => item.by === 'teacher') ? '（含主老师的建议）' : ''}。比较后再决定是否合并
      </Callout>}
      {noWebgl && <Callout tone="warn">这个浏览器画不了图谱（没有 WebGL），已改用列表</Callout>}
      {data.error && !data.data && <ErrorText error={data.error} />}
      {!data.data ? <Skeleton lines={8} title /> : data.data.nodes.length === 0 ? (
        <div className="la-card"><EmptyState icon={Network} title="还没有知识节点" description={courseId ? '确认目标后，主老师会根据骨架教材搭出初版知识图。' : '课程里建立的知识节点会汇总到这里。'} /></div>
      ) : graphView ? (
        <GraphView shell={shell} courseId={courseId} data={data.data} error={data.error} courseFilter={courseFilter} setCourseFilter={setCourseFilter} openNode={openNode} onUnavailable={() => setNoWebgl(true)} />
      ) : (
        <NodeCards shell={shell} courseId={courseId} data={data.data} error={data.error} openNode={openNode} />
      )}
    </Page>
  )
}

/** Open a node's detail page: in this tab, or a new one (Ctrl/⌘-click, "在新标签打开"). */
export type OpenNode = (nodeId: string, title: string, courseId: string, newTab?: boolean) => void

function courseOf(node: PageNode, courseId: string | undefined): string {
  return courseId ?? node.courseIds[0]!
}

/** The graph's settings as remembered in this browser, with defaults for anything missing. */
export function useGraphSettings(): [GraphSettings, (settings: GraphSettings) => void] {
  const [stored, setStored] = useLocalState<GraphSettings>('knowledge.graph-settings', DEFAULT_SETTINGS)
  return [useMemo(() => withDefaults(stored), [stored]), setStored]
}

function GraphView({ shell, courseId, data, error, courseFilter, setCourseFilter, openNode, onUnavailable }: {
  shell: LearnShell
  courseId?: string
  data: PageData
  error?: string
  courseFilter: string
  setCourseFilter(value: string): void
  openNode: OpenNode
  onUnavailable(): void
}): ReactNode {
  const canvas = useRef<GraphCanvasHandle>(null)
  const frame = shell.usePage()
  const [colors, setColors] = useState<GraphColors>(readColors)
  useEffect(() => onThemeChange(() => setColors(readColors())), [])
  const [selected, setSelected] = useState<string>()
  const [query, setQuery] = useState('')
  const [relation, setRelation] = useLocalState<RelationFilter>('knowledge.relation', 'all')
  const [examFilter, setExamFilter] = useLocalState<ExamFilter>('knowledge.exam', 'all')
  const [depth, setDepth] = useLocalState<'1' | '2' | 'all'>('knowledge.depth', '1')
  const [showOutside, setShowOutside] = useState(false)
  const [showSources, setShowSources] = useLocalState('knowledge.sources', false)
  const [colorBy, setColorBy] = useLocalState<'state' | 'course'>('knowledge.color-by', 'state')
  const [courseColor, setCourseColor] = useLocalState<'state' | 'stage'>('knowledge.course-color-by', 'state')
  const [settings, setSettings] = useGraphSettings()
  const [tuning, setTuning] = useState(false)
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number } }>()
  const sources = useLoad(shell, async () => showSources ? shell.call<KnowledgeSourceLayer>('knowledge', 'sources', courseId ? { courseId } : {}) : undefined, [courseId, showSources])

  const nodes = data.nodes
  const tagged = courseId !== undefined && nodes.some(node => node.exam)
  const exam = tagged ? examFilter : 'all'
  const byId = useMemo(() => new Map(nodes.map(node => [node.id, node])), [nodes])
  const staged = data.stages.some(stage => stage.nodeIds.length > 0)
  const effectiveColor = courseId ? (staged ? courseColor : 'state') : colorBy
  const model = useMemo(() => buildModel(nodes, data.edges, {
    colorBy: effectiveColor, relation, exam, showOutside, selected, depth: depth === 'all' ? 'all' : Number(depth) as Depth, query,
    states: data.states, courseId, courses: data.courses, stages: data.stages, ...(sources.data ? { sources: sources.data } : {}),
  }, colors), [nodes, data.edges, data.states, data.courses, data.stages, effectiveColor, relation, exam, showOutside, selected, depth, query, sources.data, colors, courseId])
  const drawn = new Set(model.nodes.map(node => node.id))
  const listed = nodes.filter(node => drawn.has(node.id) && matches(node, query))

  const select = (id: string | undefined, move = false) => {
    setSelected(id)
    const node = id ? byId.get(id) : undefined
    if (node) shell.select({ page: 'knowledge.graph', courseId: courseOf(node, courseId) as never, selected: { kind: 'node', id: node.id, label: `知识节点：${node.title}` } })
    if (id && move) canvas.current?.focus(id)
  }
  const open = (id: string, newTab = false) => {
    const node = byId.get(id)
    if (node) openNode(node.id, node.title, courseOf(node, courseId), newTab)
    else if (id.startsWith('src:') || id.startsWith('tb:')) select(id)
  }
  const ask = (node: PageNode) => {
    shell.select({ page: 'knowledge.graph', courseId: courseOf(node, courseId) as never, selected: { kind: 'node', id: node.id, label: `知识节点：${node.title}` } })
    shell.showSideChat()
  }
  const menuEntries = (id: string): MenuEntry[] => {
    const node = byId.get(id)
    if (!node) return []
    return [
      { heading: node.title },
      { key: 'open', label: '打开详情', icon: ArrowRight, onSelect: () => open(id) },
      { key: 'tab', label: '在新标签打开', icon: ExternalLink, onSelect: () => open(id, true) },
      { key: 'ask', label: '就此提问', icon: MessageCircle, onSelect: () => ask(node) },
    ]
  }
  // A node that left the graph (removed, filtered out) is no longer selected.
  useEffect(() => { if (selected && !drawn.has(selected)) setSelected(undefined) }, [model])

  const selectedNode = selected ? byId.get(selected) : undefined
  // On the main page a course filter leaves other courses' nodes out; say how many.
  const filteredOut = courseId ? 0 : nodes.length - nodes.filter(node => drawn.has(node.id)).length
  return (
    <div className="la-graph-wrap">
      <div className="la-graph-tools">
        <div className="la-graph-search">
          <TextField value={query} onChange={setQuery} icon={Search} placeholder="搜索名称或别名" aria-label="搜索知识节点"
            onEnter={() => { const first = listed[0]; if (first) select(first.id, true) }} />
        </div>
        <div className="la-toolbar-group">
          <Select<RelationFilter> value={relation} options={RELATIONS} onChange={setRelation} aria-label="显示哪些关系" />
          {tagged && <Select<ExamFilter> value={examFilter} options={EXAM_FILTERS} onChange={setExamFilter} aria-label="考试范围" />}
          {!courseId && data.courses.length > 1 && <Select<string> value={data.courses.some(course => course.id === courseFilter) ? courseFilter : ''} onChange={setCourseFilter} aria-label="课程筛选"
            options={[{ value: '', label: '全部课程' }, ...data.courses.map(course => ({ value: course.id, label: course.title }))]} />}
          {!courseId && <Segmented<'state' | 'course'> value={colorBy} onChange={setColorBy} aria-label="颜色表示"
            options={[{ value: 'state', label: '按掌握' }, { value: 'course', label: '按课程' }]} />}
          {courseId && staged && <Segmented<'state' | 'stage'> value={courseColor} onChange={setCourseColor} aria-label="颜色表示"
            options={[{ value: 'state', label: '按掌握' }, { value: 'stage', label: '按阶段' }]} />}
        </div>
        <div className="la-toolbar-group">
          <Checkbox checked={showSources} onChange={setShowSources}>叠加出处</Checkbox>
          {model.outside > 0 && <Checkbox checked={showOutside} onChange={setShowOutside}>{courseId ? '课外相关' : '其他课程'} {model.outside} 个</Checkbox>}
        </div>
      </div>
      <ErrorText error={error ?? data.stateError ?? sources.error} />
      <div className="la-graph">
        <div className="la-graph-stage">
          <GraphCanvas ref={canvas} model={model} colors={colors} settings={settings} active={frame.visible} layoutKey={courseId ?? 'main'}
            onSelect={id => select(id)} onOpen={open} onMenu={(id, at) => { if (byId.has(id)) setMenu({ id, at }) }} onUnavailable={onUnavailable}
            label={`知识图谱：${model.nodes.length} 个节点、${model.edges.length} 条连线；单击选中，双击打开详情，可用右侧列表选择节点`} />
          <div className="la-graph-zoom">
            <Button icon={ZoomIn} size="sm" aria-label="放大" title="放大" onClick={() => canvas.current?.zoomIn()} />
            <Button icon={ZoomOut} size="sm" aria-label="缩小" title="缩小" onClick={() => canvas.current?.zoomOut()} />
            <Button icon={Maximize2} size="sm" aria-label="复位视角" title="复位视角" onClick={() => canvas.current?.reset()} />
            <Button icon={Shuffle} size="sm" aria-label="重新排布" title="重新排布" onClick={() => canvas.current?.relayout()} />
            <Button icon={Settings2} size="sm" variant={tuning ? 'primary' : 'default'} aria-label="图谱设置" title="图谱设置" aria-expanded={tuning} data-graph-gear="" onClick={() => setTuning(!tuning)} />
          </div>
          {tuning && <GraphSettingsPanel settings={settings} onChange={setSettings} onClose={() => setTuning(false)} />}
          {(model.hiddenEdges > 0 || filteredOut > 0) && <div className="la-graph-note">{[filteredOut > 0 && `其余 ${filteredOut} 个节点按课程筛选未显示`, model.hiddenEdges > 0 && `已按筛选隐藏 ${model.hiddenEdges} 条关系`].filter(Boolean).join('；')}</div>}
        </div>
        <aside className="la-graph-side" aria-label="节点">
          {selected?.startsWith('src:') || selected?.startsWith('tb:') ? (
            <SourcePanel shell={shell} id={selected} layer={sources.data} byId={byId} courseId={courseId} onSelect={id => select(id, true)} onClose={() => select(undefined)} />
          ) : selectedNode ? (
            <NodePanel shell={shell} node={selectedNode} courseId={courseOf(selectedNode, courseId)} pageCourse={courseId} shown={data.states ? shownState(selectedNode, data.states, courseId) : undefined} stateText={stateText(selectedNode, { states: data.states, courseId })}
              byId={byId} depth={depth} setDepth={setDepth} courses={data.courses} openNode={openNode} onSelect={id => select(id, true)} onClose={() => select(undefined)} />
          ) : (
            <NodeList nodes={listed} total={drawn.size} states={data.states} courseId={courseId} courses={data.courses} onSelect={id => select(id, true)} onHover={id => canvas.current?.highlight(id)} />
          )}
        </aside>
      </div>
      <GraphLegend colors={colors} showSources={showSources} colorBy={effectiveColor} courses={data.courses} stages={data.stages} stateError={!!data.stateError} />
      {menu && <ContextMenu entries={menuEntries(menu.id)} at={menu.at} width={200} onClose={() => setMenu(undefined)} />}
    </div>
  )
}

/** Shapes, what the colours mean now, and the arrow's direction. */
export function GraphLegend({ colors, showSources, colorBy, courses, stages, stateError, compact }: {
  colors: GraphColors
  showSources?: boolean
  colorBy: 'state' | 'course' | 'stage'
  courses: KnowledgeGlobal['courses']
  stages: readonly StageGroup[]
  stateError: boolean
  /** The sidebar: states only, no shapes or arrow. */
  compact?: boolean
}): ReactNode {
  const swatch = (index: number) => <span className="la-dot" style={{ background: `var(--la-cat-${index % 6 + 1})` }} />
  return (
    <div className={`la-graph-legend${compact ? ' compact' : ''}`}>
      {!compact && <>
        {KINDS.map(({ kind }) => <span key={kind}><ShapeMark kind={kind} color={colors.muted} />{KIND_LABEL[kind]}</span>)}
        {showSources && <span><ShapeMark kind="source" color={colors.muted} />资料</span>}
        <span className="la-graph-legend-sep" />
      </>}
      {colorBy === 'course'
        ? <>{courses.map((course, index) => <span key={course.id}>{swatch(index)}{course.title}</span>)}<span><Dot tone="neutral" />多门课共享</span></>
        : colorBy === 'stage'
          ? <>{stages.map((stage, index) => <span key={stage.id}>{swatch(index)}{stage.title}</span>)}<span><Dot tone="neutral" />不在任何阶段</span></>
          : stateError ? <span>状态暂不可用</span>
            : STATE_ORDER.filter(state => state !== 'retained').map(state => <span key={state}><Dot tone={STATE_TONE[state]} hollow={state === 'untested'} />{STATE_TEXT[state]}</span>)}
      {!compact && <>
        <span className="la-graph-legend-sep" />
        <span><ArrowRight size={13} strokeWidth={1.75} />从先学指向后学</span>
      </>}
    </div>
  )
}

/** The gear's panel on the canvas: how the graph looks and the forces of its layout. Esc, the cross or a click elsewhere closes it. */
function GraphSettingsPanel({ settings, onChange, onClose }: { settings: GraphSettings; onChange(settings: GraphSettings): void; onClose(): void }): ReactNode {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close.current() } }
    // The gear toggles the panel itself; a press anywhere else closes it.
    const press = (event: PointerEvent) => { if (!(event.target as Element).closest?.('.la-graph-settings, [data-graph-gear]')) close.current() }
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', press)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', press) }
  }, [])
  const slider = (key: keyof GraphSettings) => <Slider key={key} value={settings[key]} label={SETTING_LABELS[key].label} low={SETTING_LABELS[key].low} high={SETTING_LABELS[key].high}
    onChange={value => onChange({ ...settings, [key]: value })} />
  const changed = (Object.keys(DEFAULT_SETTINGS) as (keyof GraphSettings)[]).some(key => Math.abs(settings[key] - DEFAULT_SETTINGS[key]) > 0.001)
  return (
    <div className="la-graph-settings" role="dialog" aria-label="图谱设置">
      <div className="la-graph-settings-head">
        <b>图谱设置</b>
        <button type="button" className="la-icon-btn" aria-label="关闭图谱设置" title="关闭" onClick={onClose}><X size={15} strokeWidth={1.75} /></button>
      </div>
      <div className="la-graph-settings-group"><span className="la-graph-label">显示</span>{slider('nodeSize')}{slider('edgeSize')}{slider('labels')}</div>
      <div className="la-graph-settings-group"><span className="la-graph-label">力度</span>{slider('center')}{slider('repel')}{slider('link')}{slider('distance')}</div>
      <Button size="sm" variant="quiet" disabled={!changed} onClick={() => onChange(DEFAULT_SETTINGS)}>恢复默认</Button>
    </div>
  )
}

function NodeList({ nodes, total, states, courseId, courses, onSelect, onHover }: {
  nodes: readonly PageNode[]
  total: number
  states?: ReadonlyMap<string, NodeState>
  courseId?: string
  courses: KnowledgeGlobal['courses']
  onSelect(id: string): void
  /** The pointer or the focus is on an item (undefined: it left): the graph lights it up. */
  onHover(id: string | undefined): void
}): ReactNode {
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
    if (next) { event.preventDefault(); next.focus() }
  }
  const courseTitle = (id: string) => courses.find(course => course.id === id)?.title ?? ''
  useEffect(() => () => onHover(undefined), [])
  return <>
    <div className="la-graph-side-head"><b>节点</b><span className="la-faint la-small">{nodes.length === total ? `${total} 个` : `${nodes.length} / ${total} 个`}</span></div>
    {nodes.length === 0 ? <p className="la-faint la-small">没有匹配的节点</p> : (
      <div className="la-graph-list" onKeyDown={keys} onMouseLeave={() => onHover(undefined)} onBlur={() => onHover(undefined)}>
        {nodes.slice(0, 300).map(node => {
          const text = stateText(node, { states, courseId })
          const state = states ? shownState(node, states, courseId).state : 'untested'
          const tone: Tone = !node.inScope || !states || text === '本课条件待验证' ? 'neutral' : STATE_TONE[state]
          const where = courseId ? node.domain : node.courseIds.map(courseTitle).join('、')
          return (
            <button key={node.id} type="button" className="la-graph-item" onClick={() => onSelect(node.id)} onMouseEnter={() => onHover(node.id)} onFocus={() => onHover(node.id)}>
              <ShapeMark kind={node.kind} />
              <span className="la-graph-item-main"><span className="la-graph-item-title">{node.title}</span>{where && <span className="la-faint la-small">{where}</span>}</span>
              <span className="la-graph-item-state"><Dot tone={tone} hollow={state === 'untested' || tone === 'neutral'} />{text}</span>
            </button>
          )
        })}
        {nodes.length > 300 && <p className="la-faint la-small">还有 {nodes.length - 300} 个，请用搜索缩小范围</p>}
      </div>
    )}
  </>
}

function NodePanel({ shell, node, courseId, pageCourse, shown, stateText: text, byId, depth, setDepth, courses, openNode, onSelect, onClose }: {
  shell: LearnShell
  node: PageNode
  courseId: string
  pageCourse?: string
  shown?: ShownState
  stateText: string
  byId: ReadonlyMap<string, PageNode>
  depth: '1' | '2' | 'all'
  setDepth(value: '1' | '2' | 'all'): void
  courses: KnowledgeGlobal['courses']
  openNode: OpenNode
  onSelect(id: string): void
  onClose(): void
}): ReactNode {
  const detail = useLoad(shell, () => shell.call<KnowledgeDetail>('knowledge', 'detail', { courseId, nodeId: node.id }), [courseId, node.id])
  const title = (id: string) => byId.get(id)?.title ?? detail.data?.titles[id] ?? '知识节点'
  const tone: Tone = text === '本课条件待验证' || text === '状态暂不可用' || text === '课外相关' ? 'neutral' : STATE_TONE[shown?.state ?? 'untested']
  const edges = detail.data?.edges.filter(edge => edge.status !== 'inactive') ?? []
  return <>
    <div className="la-graph-side-head">
      <span className="la-graph-kind"><ShapeMark kind={node.kind} />{KIND_LABEL[node.kind]}</span>
      <Button size="sm" variant="quiet" onClick={onClose}>返回列表</Button>
    </div>
    <h3 className="la-graph-title">{node.title}</h3>
    <div className="la-graph-meta">
      {!pageCourse && node.courseIds.map(id => <Tag key={id}>{courses.find(course => course.id === id)?.title}</Tag>)}
      {pageCourse && node.role === 'related' && <Tag>本课相关</Tag>}
      {node.domain && <span className="la-faint la-small">{node.domain}</span>}
    </div>
    <div className="la-node-state"><Dot tone={tone} hollow={tone === 'neutral'} />{text}</div>
    {shown?.explanation && <div className="la-small la-graph-explain"><shell.Markdown text={shown.explanation} inline /></div>}
    {shown?.overall && <div className="la-faint la-small">全部课程的记录：{STATE_TEXT[shown.overall]}</div>}
    <Segmented<'1' | '2' | 'all'> value={depth} onChange={setDepth} aria-label="突出显示范围" options={[{ value: '1', label: '一跳' }, { value: '2', label: '两跳' }, { value: 'all', label: '全部' }]} />
    {node.description && <div className="la-graph-block"><shell.Markdown text={node.description} /></div>}
    {detail.data?.node.conditions && <p className="la-small"><span className="la-faint">表现条件：</span>{detail.data.node.conditions}</p>}
    <ErrorText error={detail.error} />
    {edges.length > 0 && <div className="la-graph-block">
      <div className="la-graph-label">关系</div>
      {edges.map(edge => {
        const other = edge.from === node.id ? edge.to : edge.from
        return <button key={edge.id} type="button" className="la-graph-relation" onClick={() => onSelect(other)} title={`选中「${title(other)}」`}>
          <span>{relationSentence(edge, title)}</span>
          {!(edge.status === 'valid' && edge.usable) && <Tag>{edge.issue ? '需复核' : STATUS_LABEL[edge.status as RelationStatus]}</Tag>}
        </button>
      })}
    </div>}
    {(detail.data?.links.length ?? 0) > 0 && <div className="la-graph-block">
      <div className="la-graph-label">出处</div>
      {detail.data!.links.slice(0, 6).map((link, index) => <div key={index} className="la-small">{link.citation ? <shell.Markdown text={link.citation} inline /> : link.label}</div>)}
    </div>}
    <div className="la-toolbar la-graph-actions">
      <Button size="sm" icon={ArrowRight} opens onClick={() => openNode(node.id, node.title, courseId)}>打开详情</Button>
      <Button size="sm" icon={MessageCircle} onClick={() => { shell.select({ page: 'knowledge.graph', courseId: courseId as never, selected: { kind: 'node', id: node.id, label: `知识节点：${node.title}` } }); shell.showSideChat() }}>就此提问</Button>
    </div>
  </>
}

function SourcePanel({ shell, id, layer, byId, courseId, onSelect, onClose }: {
  shell: LearnShell
  id: string
  layer?: KnowledgeSourceLayer
  byId: ReadonlyMap<string, PageNode>
  courseId?: string
  onSelect(id: string): void
  onClose(): void
}): ReactNode {
  const head = (label: string) => <div className="la-graph-side-head"><span className="la-graph-kind"><ShapeMark kind="source" />{label}</span><Button size="sm" variant="quiet" onClick={onClose}>返回列表</Button></div>
  if (id.startsWith('tb:')) {
    const nodeIds = layer?.textbooks.find(item => `tb:${item.courseId}` === id)?.nodeIds ?? []
    return <>
      {head('课程教材')}
      <p className="la-small">教材段落讲到了这些节点：</p>
      <div className="la-graph-block">{nodeIds.map(nodeId => <button key={nodeId} type="button" className="la-graph-relation" onClick={() => onSelect(nodeId)}>{byId.get(nodeId)?.title ?? '知识节点'}</button>)}</div>
      {courseId && <Button size="sm" icon={BookOpen} opens onClick={() => shell.openPage('textbook.reader', {}, { title: '课程教材' })}>打开课程教材</Button>}
    </>
  }
  const source = layer?.sources.find(item => `src:${item.id}` === id)
  if (!source) return head('资料')
  return <>
    {head('资料')}
    <h3 className="la-graph-title">{source.title}</h3>
    <p className="la-faint la-small">点出处在旁边打开原文</p>
    {source.links.map(link => <div key={link.nodeId} className="la-graph-block">
      <button type="button" className="la-graph-relation" onClick={() => onSelect(link.nodeId)}><b>{byId.get(link.nodeId)?.title ?? '知识节点'}</b></button>
      {link.chunks.map(chunk => <div key={chunk.id} className="la-small"><shell.Markdown text={`[${chunk.citation}](cite:${chunk.id})`} inline /></div>)}
    </div>)}
  </>
}

/** The grouped list: every node as a card with its state, grouped by kind. */
function NodeCards({ shell, courseId, data, error, openNode }: { shell: LearnShell; courseId?: string; data: PageData; error?: string; openNode: OpenNode }): ReactNode {
  const [query, setQuery] = useState('')
  const nodes = data.nodes.filter(node => node.inScope)
  const visible = nodes.filter(node => matches(node, query))
  const counts = data.states ? STATE_ORDER.map(state => ({ state, count: nodes.filter(node => { const shown = shownState(node, data.states!, courseId); return !shown.unverified && shown.state === state }).length })).filter(entry => entry.count > 0) : []
  const inScope = new Set(nodes.map(node => node.id))
  const edges = data.edges.filter(edge => inScope.has(edge.from) && inScope.has(edge.to))
  const titles = new Map(data.nodes.map(node => [node.id, node.title]))
  const title = (id: string) => titles.get(id) ?? '未显示的节点'
  return <>
    <div className="la-legend">
      <span><b>{nodes.length}</b> 个节点</span>
      <span><b>{edges.length}</b> 条关系</span>
      {counts.map(({ state, count }) => <span key={state}><Dot tone={STATE_TONE[state]} hollow={state === 'untested'} />{STATE_TEXT[state]} <b>{count}</b></span>)}
    </div>
    <ErrorText error={error ?? data.stateError} />
    <div className="la-toolbar"><TextField value={query} onChange={setQuery} icon={Search} placeholder="搜索名称或别名" aria-label="搜索知识节点" /><span className="la-faint la-small">{visible.length} 个结果</span></div>
    {KINDS.map(({ kind, icon }) => {
      const group = visible.filter(node => node.kind === kind)
      if (group.length === 0) return null
      return (
        <Section key={kind} title={KIND_LABEL[kind]} icon={icon} count={group.length}>
          <div className="la-node-grid">
            {group.map(node => {
              const state = data.states ? shownState(node, data.states, courseId) : undefined, text = stateText(node, { states: data.states, courseId })
              const tone: Tone = !state || state.unverified ? 'neutral' : STATE_TONE[state.state]
              return (
                <button key={node.id} type="button" className="la-card interactive la-node" onClick={() => openNode(node.id, node.title, courseOf(node, courseId))}>
                  <div className="la-node-head">
                    <span className="la-node-title">{node.title}</span>
                    {node.role === 'related' && <Tag>相关</Tag>}
                    {node.courseIds.length > 1 && <Tag>跨课共享</Tag>}
                  </div>
                  {node.description && <div className="la-node-desc"><shell.Markdown text={node.description} inline /></div>}
                  <div className="la-node-state">
                    <Dot tone={tone} hollow={tone === 'neutral' || !state || state.state === 'untested'} />{text}
                    {state?.doubtful && <Tag tone="warn">有疑点</Tag>}
                    {state?.needsReview && <Tag>待复查</Tag>}
                  </div>
                  {node.domain && <div className="la-faint la-small">{node.domain}</div>}
                </button>
              )
            })}
          </div>
        </Section>
      )
    })}
    {edges.length > 0 && (
      <Section title="关系" icon={List} count={edges.length}>
        <div className="la-rows">
          {edges.map(edge => (
            <div key={edge.id} className="la-row-item" style={{ alignItems: 'flex-start' }}>
              <div className="la-row-main" style={{ gap: 4 }}>
                <span className="la-edge">
                  <span>{relationSentence(edge, title)}</span>
                  <Tag tone={edge.status === 'valid' && edge.usable ? 'ok' : 'warn'}>{STATUS_LABEL[edge.status]}</Tag>
                </span>
                {edge.rationale && <span className="la-faint la-small"><shell.Markdown text={edge.rationale} inline /></span>}
              </div>
            </div>
          ))}
        </div>
      </Section>
    )}
  </>
}

