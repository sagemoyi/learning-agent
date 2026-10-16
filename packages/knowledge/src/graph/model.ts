// What the knowledge graph draws, worked out from the page data: which nodes and relations show,
// their shapes and colours, which ones fade, and the words beside them. Pure, so the rules are
// tested without a browser; the canvas only copies the result into sigma.
import type { EdgeType, ExamScope, KnowledgeSourceLayer, MasteryState, NodeKind, NodeState, RelationStatus } from '@learning-agent/contracts'
import type { GraphColors } from './colors.ts'

export const KIND_PROGRAM = { knowledge: 'circle', skill: 'square', integrated: 'diamond', task: 'triangle' } as const
export const STATE_TEXT: Record<MasteryState, string> = {
  untested: '未探测', 'not-yet': '还没答对', assisted: '有帮助完成', independent: '已独立完成', retained: '已延迟验证', conflict: '证据冲突',
}

export interface GraphNodeInput {
  readonly id: string
  readonly title: string
  readonly aliases: readonly string[]
  readonly kind: NodeKind
  readonly domain: string
  /** Courses using the node, in course order. */
  readonly courseIds: readonly string[]
  /** In the course being viewed (course page) or in the chosen course (main page). */
  readonly inScope: boolean
  /** Titles of identities merged into this one; search still finds them. */
  readonly formerTitles?: readonly string[]
  /** The node's exam scope in the course being viewed. */
  readonly exam?: ExamScope
}

export interface GraphEdgeInput {
  readonly id: string
  readonly from: string
  readonly to: string
  readonly type: EdgeType
  readonly status: RelationStatus
  readonly usable?: boolean
}

export type RelationFilter = 'all' | 'order' | 'part' | 'related'
/** Which nodes the exam filter keeps bright; the rest fade without moving. */
export type ExamFilter = 'all' | 'in-scope' | 'outside'

const EXAM_WORD: Record<ExamScope, string> = { 'in-scope': '考试范围内', beyond: '范围外但有助理解', 'out-of-scope': '考试范围外' }
export type Depth = 1 | 2 | 'all'

/** A stage of the course and its core nodes, for "colour by stage". */
export interface StageGroup {
  readonly id: string
  readonly title: string
  readonly nodeIds: readonly string[]
}

export interface GraphOptions {
  readonly colorBy: 'state' | 'course' | 'stage'
  readonly relation: RelationFilter
  readonly exam?: ExamFilter
  /** Draw nodes outside the scope (faded): the course page's "课外相关". */
  readonly showOutside: boolean
  readonly selected?: string
  readonly depth: Depth
  readonly query: string
  /** Undefined when the learner states could not be read. */
  readonly states: ReadonlyMap<string, NodeState> | undefined
  /** The course page's course: a node other courses share shows this course's answers only. */
  readonly courseId?: string
  /** Course order for course colours and titles for the textbook nodes. */
  readonly courses: readonly { readonly id: string; readonly title: string }[]
  readonly sources?: KnowledgeSourceLayer
  /** The course's stages in order: "colour by stage" gives a node its first stage's colour. */
  readonly stages?: readonly StageGroup[]
  /** Nodes the sidebar's local graph is about: drawn larger, always named. */
  readonly emphasis?: ReadonlySet<string>
}

export type DrawKind = NodeKind | 'source' | 'textbook'

export interface DrawNode {
  readonly id: string
  readonly label: string
  readonly kind: DrawKind
  readonly type: 'circle' | 'square' | 'diamond' | 'triangle' | 'source'
  readonly color: string
  /** The colour before fading: hovering a faded neighbour shows it. */
  readonly baseColor: string
  readonly labelColor: string
  /** Radius in graph units (nodes grow as the camera zooms in). */
  readonly size: number
  readonly subtitle: string
  readonly faded: boolean
  readonly forceLabel: boolean
  readonly zIndex: number
}

export interface DrawEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly arrow: boolean
  readonly color: string
  readonly size: number
  readonly faded: boolean
}

export interface GraphModel {
  readonly nodes: readonly DrawNode[]
  readonly edges: readonly DrawEdge[]
  /** Outside nodes linked by a relation, drawn or not. */
  readonly outside: number
  /** Relations the relation filter hides. */
  readonly hiddenEdges: number
}

/** Arrows go from what comes first to what builds on it: a prerequisite points at the ability that needs it. */
export function arrowEnds(edge: Pick<GraphEdgeInput, 'from' | 'to' | 'type'>): [string, string] {
  return edge.type === 'requires' ? [edge.to, edge.from] : [edge.from, edge.to]
}

export function relationShown(type: EdgeType, filter: RelationFilter): boolean {
  if (filter === 'order') return type === 'requires' || type === 'recommended-before'
  if (filter === 'part') return type === 'part-of'
  if (filter === 'related') return type === 'related'
  return true
}

export function matches(node: Pick<GraphNodeInput, 'title' | 'aliases' | 'domain' | 'formerTitles'>, query: string): boolean {
  const wanted = query.trim().toLocaleLowerCase()
  return !wanted || [node.title, node.domain, ...node.aliases, ...node.formerTitles ?? []].some(label => label.toLocaleLowerCase().includes(wanted))
}

/** Nodes within `depth` relation steps of `start`, ignoring direction. */
export function neighborhood(edges: readonly Pick<DrawEdge, 'source' | 'target'>[], start: string, depth: number): Set<string> {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    adjacency.set(edge.source, [...adjacency.get(edge.source) ?? [], edge.target])
    adjacency.set(edge.target, [...adjacency.get(edge.target) ?? [], edge.source])
  }
  const seen = new Set([start])
  let frontier = [start]
  for (let step = 0; step < depth; step++) {
    const next: string[] = []
    for (const id of frontier) for (const other of adjacency.get(id) ?? []) if (!seen.has(other)) { seen.add(other); next.push(other) }
    frontier = next
  }
  return seen
}

/** Radius in graph units: more relations, a larger node, up to a limit (Logseq grows nodes with √degree too). */
export function nodeRadius(degree: number): number {
  return 3 + Math.min(7, 1.8 * Math.sqrt(degree))
}

/** The stage a node belongs to: the first whose core nodes include it. */
export function stageOf(stages: readonly StageGroup[] | undefined, nodeId: string): number | undefined {
  const index = stages?.findIndex(stage => stage.nodeIds.includes(nodeId)) ?? -1
  return index < 0 ? undefined : index
}

/** The state a node shows. On a course page a node other courses share shows this course's answers only. */
export interface ShownState {
  readonly state: MasteryState
  readonly doubtful: boolean
  readonly needsReview: boolean
  readonly explanation?: string
  /** What evidence is still missing. */
  readonly next?: string
  /** No answers in this course yet, but answers in others: "本课条件待验证". */
  readonly unverified: boolean
  /** Every course's state, when it differs from the one shown. */
  readonly overall?: MasteryState
}

export function shownState(node: Pick<GraphNodeInput, 'id' | 'courseIds'>, states: ReadonlyMap<string, NodeState>, courseId: string | undefined): ShownState {
  const all = states.get(node.id)
  if (!courseId || node.courseIds.length <= 1) {
    return { state: all?.state ?? 'untested', doubtful: !!all?.doubtful, needsReview: !!all?.needsReview, unverified: false, ...(all?.explanation ? { explanation: all.explanation } : {}), ...(all?.next ? { next: all.next } : {}) }
  }
  const local = all?.courses?.find(course => course.courseId === courseId)
  const overall = all && all.state !== (local?.state ?? 'untested') ? { overall: all.state } : {}
  if (local) return { state: local.state, doubtful: local.doubtful, needsReview: local.needsReview, explanation: local.explanation, ...(local.next ? { next: local.next } : {}), unverified: false, ...overall }
  return { state: 'untested', doubtful: false, needsReview: false, unverified: !!all && all.state !== 'untested', ...overall }
}

export function stateText(node: GraphNodeInput, options: Pick<GraphOptions, 'states' | 'courseId'>): string {
  if (!node.inScope) return '课外相关'
  if (!options.states) return '状态暂不可用'
  const shown = shownState(node, options.states, options.courseId)
  if (shown.unverified) return '本课条件待验证'
  const words = [STATE_TEXT[shown.state]]
  if (shown.doubtful) words.push('有疑点')
  if (shown.needsReview) words.push('待复查')
  return words.join(' · ')
}

export function buildModel(nodes: readonly GraphNodeInput[], edges: readonly GraphEdgeInput[], options: GraphOptions, colors: GraphColors): GraphModel {
  const linked = new Set(edges.flatMap(edge => [edge.from, edge.to]))
  const scoped = new Set(nodes.filter(node => node.inScope).map(node => node.id))
  // Outside nodes only matter through a relation to a node in scope.
  const outsideIds = new Set(edges.flatMap(edge => scoped.has(edge.from) && !scoped.has(edge.to) ? [edge.to] : scoped.has(edge.to) && !scoped.has(edge.from) ? [edge.from] : []))
  const drawn = nodes.filter(node => node.inScope || (options.showOutside && outsideIds.has(node.id) && linked.has(node.id)))
  const drawnIds = new Set(drawn.map(node => node.id))

  const between = edges.filter(edge => drawnIds.has(edge.from) && drawnIds.has(edge.to))
  // Sizes count every drawn relation, whatever the relation filter shows, so filtering never resizes a node.
  const degree = new Map<string, number>()
  for (const edge of between) for (const end of [edge.from, edge.to]) degree.set(end, (degree.get(end) ?? 0) + 1)
  const shownEdges = between.filter(edge => relationShown(edge.type, options.relation))
  const raw: DrawEdge[] = shownEdges.map(edge => {
    const [source, target] = arrowEnds(edge)
    const valid = edge.status === 'valid' && edge.usable !== false
    const color = !valid ? colors.lineStrong : edge.type === 'requires' ? colors.accent : edge.type === 'recommended-before' ? colors.accentLine : colors.neutral
    return { id: edge.id, source, target, arrow: edge.type !== 'related', color, size: valid ? (edge.type === 'requires' ? 1.8 : 1.2) : 0.8, faded: false }
  })

  const sourceNodes: DrawNode[] = []
  const sourceEdges: DrawEdge[] = []
  if (options.sources) {
    for (const source of options.sources.sources) {
      const targets = source.links.filter(link => drawnIds.has(link.nodeId))
      if (!targets.length) continue
      sourceNodes.push(sourceNode(`src:${source.id}`, source.title, 'source', colors))
      for (const link of targets) sourceEdges.push({ id: `src:${source.id}>${link.nodeId}`, source: `src:${source.id}`, target: link.nodeId, arrow: false, color: colors.line, size: 0.8, faded: false })
    }
    for (const textbook of options.sources.textbooks) {
      const targets = textbook.nodeIds.filter(id => drawnIds.has(id))
      if (!targets.length) continue
      const course = options.courses.find(item => item.id === textbook.courseId)
      const title = options.courses.length > 1 && course ? `${course.title} · 课程教材` : '课程教材'
      sourceNodes.push(sourceNode(`tb:${textbook.courseId}`, title, 'textbook', colors))
      for (const id of targets) sourceEdges.push({ id: `tb:${textbook.courseId}>${id}`, source: `tb:${textbook.courseId}`, target: id, arrow: false, color: colors.line, size: 0.8, faded: false })
    }
  }

  // Focus: the selected node's neighbourhood, or the search matches when nothing is selected.
  const all = [...raw, ...sourceEdges]
  let focus: Set<string> | undefined
  if (options.selected && options.depth !== 'all' && (drawnIds.has(options.selected) || sourceNodes.some(node => node.id === options.selected))) {
    focus = neighborhood(all, options.selected, options.depth)
  } else if (!options.selected && options.query.trim()) {
    focus = new Set(drawn.filter(node => matches(node, options.query)).map(node => node.id))
  }
  const courseIndex = new Map(options.courses.map((course, index) => [course.id, index]))
  const drawNodes: DrawNode[] = drawn.map(node => {
    const outside = !node.inScope
    const examFaded = options.exam === 'in-scope' ? node.exam !== 'in-scope' : options.exam === 'outside' ? node.exam === undefined || node.exam === 'in-scope' : false
    const faded = outside || examFaded || (focus ? !focus.has(node.id) : false)
    const stage = options.colorBy === 'stage' ? stageOf(options.stages, node.id) : undefined
    const stageWord = options.colorBy === 'stage' && node.inScope ? ` · ${stage === undefined ? '不在任何阶段' : options.stages![stage]!.title}` : ''
    const subtitle = `${stateText(node, options)}${node.exam && node.inScope ? ` · ${EXAM_WORD[node.exam]}` : ''}${options.colorBy === 'course' && node.courseIds.length > 1 ? ` · ${node.courseIds.length} 门课程共享` : ''}${stageWord}`
    let color: string
    if (outside || !options.states && options.colorBy === 'state') color = colors.neutral
    else if (options.colorBy === 'course') color = node.courseIds.length === 1 ? colors.courses[(courseIndex.get(node.courseIds[0]!) ?? 0) % colors.courses.length]! : colors.neutral
    else if (options.colorBy === 'stage') color = stage === undefined ? colors.neutral : colors.courses[stage % colors.courses.length]!
    else {
      const shown = shownState(node, options.states!, options.courseId)
      color = shown.unverified ? colors.neutral : colors.state[shown.state]
    }
    const selected = node.id === options.selected, emphasized = options.emphasis?.has(node.id) ?? false
    const size = nodeRadius(degree.get(node.id) ?? 0) + (selected ? 3 : emphasized ? 2 : 0)
    return {
      id: node.id, label: node.title, kind: node.kind, type: KIND_PROGRAM[node.kind],
      color: faded ? colors.faint : color, baseColor: color, labelColor: faded ? colors.muted : colors.text,
      size, subtitle, faded,
      forceLabel: selected || emphasized || (focus?.has(node.id) ?? false) && focus!.size <= 40,
      zIndex: selected ? 3 : faded ? 0 : emphasized ? 2 : 1,
    }
  })
  const fadedSources = sourceNodes.map(node => {
    const faded = focus ? !focus.has(node.id) : false
    return { ...node, faded, color: faded ? colors.faint : node.color, labelColor: faded ? colors.muted : colors.text, forceLabel: node.id === options.selected, size: node.id === options.selected ? node.size + 2 : node.size }
  })
  const visible = new Set([...drawNodes, ...fadedSources].filter(node => !node.faded).map(node => node.id))
  const fadedIds = new Set(drawNodes.filter(node => node.faded).map(node => node.id))
  const drawEdges = all.map(edge => {
    const faded = focus ? !(visible.has(edge.source) && visible.has(edge.target)) : fadedIds.has(edge.source) || fadedIds.has(edge.target)
    return faded ? { ...edge, faded, color: colors.line, size: 0.7 } : edge
  })
  return { nodes: [...drawNodes, ...fadedSources], edges: drawEdges, outside: outsideIds.size, hiddenEdges: between.length - shownEdges.length }
}

function sourceNode(id: string, title: string, kind: 'source' | 'textbook', colors: GraphColors): DrawNode {
  return { id, label: title, kind, type: 'source', color: colors.muted, baseColor: colors.muted, labelColor: colors.text, size: 4, subtitle: kind === 'textbook' ? '课程教材' : '资料', faded: false, forceLabel: false, zIndex: 1 }
}
