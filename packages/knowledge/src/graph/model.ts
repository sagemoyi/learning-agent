// What the knowledge graph draws, worked out from the page data: which nodes and relations show,
// their shapes and colours, which ones fade, and the words beside them. Pure, so the rules are
// tested without a browser; the canvas only copies the result into sigma.
import type { EdgeType, KnowledgeSourceLayer, MasteryState, NodeKind, NodeState, RelationStatus } from '@learning-agent/contracts'
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
export type Depth = 1 | 2 | 'all'

export interface GraphOptions {
  readonly colorBy: 'state' | 'course'
  readonly relation: RelationFilter
  /** Draw nodes outside the scope (faded): the course page's "课外相关". */
  readonly showOutside: boolean
  readonly selected?: string
  readonly depth: Depth
  readonly query: string
  /** Undefined when the learner states could not be read. */
  readonly states: ReadonlyMap<string, NodeState> | undefined
  /** Course page: a node shared with other courses shows "本课条件待验证" instead of its state. */
  readonly sharedIsUnverified: boolean
  /** Course order for course colours and titles for the textbook nodes. */
  readonly courses: readonly { readonly id: string; readonly title: string }[]
  readonly sources?: KnowledgeSourceLayer
}

export type DrawKind = NodeKind | 'source' | 'textbook'

export interface DrawNode {
  readonly id: string
  readonly label: string
  readonly kind: DrawKind
  readonly type: 'circle' | 'square' | 'diamond' | 'triangle' | 'source'
  readonly color: string
  readonly labelColor: string
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

export function matches(node: Pick<GraphNodeInput, 'title' | 'aliases' | 'domain'>, query: string): boolean {
  const wanted = query.trim().toLocaleLowerCase()
  return !wanted || [node.title, node.domain, ...node.aliases].some(label => label.toLocaleLowerCase().includes(wanted))
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

/** Smaller shapes as the graph grows, so a large graph stays readable when zoomed out. */
export function nodeSize(count: number): number {
  return count <= 60 ? 9 : count <= 200 ? 7 : count <= 800 ? 5 : 4
}

export function stateText(node: GraphNodeInput, options: Pick<GraphOptions, 'states' | 'sharedIsUnverified'>): string {
  if (!node.inScope) return '课外相关'
  if (!options.states) return '状态暂不可用'
  if (options.sharedIsUnverified && node.courseIds.length > 1) return '本课条件待验证'
  const state = options.states.get(node.id)
  const words = [STATE_TEXT[state?.state ?? 'untested']]
  if (state?.doubtful) words.push('有疑点')
  if (state?.needsReview) words.push('待复查')
  return words.join(' · ')
}

export function buildModel(nodes: readonly GraphNodeInput[], edges: readonly GraphEdgeInput[], options: GraphOptions, colors: GraphColors): GraphModel {
  const linked = new Set(edges.flatMap(edge => [edge.from, edge.to]))
  const scoped = new Set(nodes.filter(node => node.inScope).map(node => node.id))
  // Outside nodes only matter through a relation to a node in scope.
  const outsideIds = new Set(edges.flatMap(edge => scoped.has(edge.from) && !scoped.has(edge.to) ? [edge.to] : scoped.has(edge.to) && !scoped.has(edge.from) ? [edge.from] : []))
  const drawn = nodes.filter(node => node.inScope || (options.showOutside && outsideIds.has(node.id) && linked.has(node.id)))
  const drawnIds = new Set(drawn.map(node => node.id))
  const size = nodeSize(drawn.length)

  const between = edges.filter(edge => drawnIds.has(edge.from) && drawnIds.has(edge.to))
  const shownEdges = between.filter(edge => relationShown(edge.type, options.relation))
  const raw: DrawEdge[] = shownEdges.map(edge => {
    const [source, target] = arrowEnds(edge)
    const valid = edge.status === 'valid' && edge.usable !== false
    const color = !valid ? colors.line : edge.type === 'requires' ? colors.accent : edge.type === 'recommended-before' ? colors.accentLine : colors.lineStrong
    return { id: edge.id, source, target, arrow: edge.type !== 'related', color, size: valid ? (edge.type === 'requires' ? 2 : 1.5) : 1, faded: false }
  })

  const sourceNodes: DrawNode[] = []
  const sourceEdges: DrawEdge[] = []
  if (options.sources) {
    for (const source of options.sources.sources) {
      const targets = source.links.filter(link => drawnIds.has(link.nodeId))
      if (!targets.length) continue
      sourceNodes.push(sourceNode(`src:${source.id}`, source.title, 'source', size, colors))
      for (const link of targets) sourceEdges.push({ id: `src:${source.id}>${link.nodeId}`, source: `src:${source.id}`, target: link.nodeId, arrow: false, color: colors.line, size: 1, faded: false })
    }
    for (const textbook of options.sources.textbooks) {
      const targets = textbook.nodeIds.filter(id => drawnIds.has(id))
      if (!targets.length) continue
      const course = options.courses.find(item => item.id === textbook.courseId)
      const title = options.courses.length > 1 && course ? `${course.title} · 课程教材` : '课程教材'
      sourceNodes.push(sourceNode(`tb:${textbook.courseId}`, title, 'textbook', size, colors))
      for (const id of targets) sourceEdges.push({ id: `tb:${textbook.courseId}>${id}`, source: `tb:${textbook.courseId}`, target: id, arrow: false, color: colors.line, size: 1, faded: false })
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
    const faded = outside || (focus ? !focus.has(node.id) : false)
    const subtitle = `${stateText(node, options)}${options.colorBy === 'course' && node.courseIds.length > 1 ? ` · ${node.courseIds.length} 门课程共享` : ''}`
    let color: string
    if (outside || !options.states && options.colorBy === 'state') color = colors.neutral
    else if (options.colorBy === 'course') color = node.courseIds.length === 1 ? colors.courses[(courseIndex.get(node.courseIds[0]!) ?? 0) % colors.courses.length]! : colors.neutral
    else if (options.sharedIsUnverified && node.courseIds.length > 1) color = colors.neutral
    else color = colors.state[options.states!.get(node.id)?.state ?? 'untested']
    const selected = node.id === options.selected
    return {
      id: node.id, label: node.title, kind: node.kind, type: KIND_PROGRAM[node.kind],
      color: faded ? colors.faint : color, labelColor: faded ? colors.muted : colors.text,
      size: selected ? size + 3 : size, subtitle, faded,
      forceLabel: selected || (focus?.has(node.id) ?? false) && focus!.size <= 40,
      zIndex: selected ? 3 : faded ? 0 : 1,
    }
  })
  const fadedSources = sourceNodes.map(node => {
    const faded = focus ? !focus.has(node.id) : false
    return { ...node, faded, labelColor: faded ? colors.muted : colors.text, forceLabel: node.id === options.selected, size: node.id === options.selected ? node.size + 2 : node.size }
  })
  const visible = new Set([...drawNodes, ...fadedSources].filter(node => !node.faded).map(node => node.id))
  const fadedIds = new Set(drawNodes.filter(node => node.faded).map(node => node.id))
  const drawEdges = all.map(edge => {
    const faded = focus ? !(visible.has(edge.source) && visible.has(edge.target)) : fadedIds.has(edge.source) || fadedIds.has(edge.target)
    return faded ? { ...edge, faded, color: colors.line, size: 1 } : edge
  })
  return { nodes: [...drawNodes, ...fadedSources], edges: drawEdges, outside: outsideIds.size, hiddenEdges: between.length - shownEdges.length }
}

function sourceNode(id: string, title: string, kind: 'source' | 'textbook', size: number, colors: GraphColors): DrawNode {
  return { id, label: title, kind, type: 'source', color: colors.muted, labelColor: colors.text, size: Math.max(4, size - 2), subtitle: kind === 'textbook' ? '课程教材' : '资料', faded: false, forceLabel: false, zIndex: 1 }
}
