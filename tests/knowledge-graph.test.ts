// Knowledge graph (batch B): the drawing rules as pure functions, and the read endpoints behind the
// graph — every course's graph, the source overlay and the evidence list. Synthetic data, no model.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { EvidenceRecord, KnowledgeGlobal, KnowledgeSourceLayer, NodeState } from '@learning-agent/contracts'
import type { GraphColors } from '../packages/knowledge/src/graph/colors.ts'
import { DEFAULT_SETTINGS, physicsOf, withDefaults } from '../packages/knowledge/src/graph/settings.ts'
import { arrowEnds, buildModel, neighborhood, nodeRadius, stateText, type GraphEdgeInput, type GraphNodeInput, type GraphOptions } from '../packages/knowledge/src/graph/model.ts'
import { FIXTURES, createHarness, type Harness } from './harness.ts'

const colors: GraphColors = {
  text: 'text', muted: 'muted', faint: 'faint', surface: 'surface', line: 'line', lineStrong: 'line-strong', accent: 'accent', accentLine: 'accent-line', neutral: 'neutral',
  state: { untested: 'untested', 'not-yet': 'not-yet', assisted: 'assisted', independent: 'independent', retained: 'retained', conflict: 'conflict' },
  courses: ['course-1', 'course-2'], font: 'font',
}
const node = (id: string, extra: Partial<GraphNodeInput> = {}): GraphNodeInput => ({ id, title: `节点${id}`, aliases: [], kind: 'knowledge', domain: '', courseIds: ['c1'], inScope: true, ...extra })
const edge = (id: string, from: string, to: string, extra: Partial<GraphEdgeInput> = {}): GraphEdgeInput => ({ id, from, to, type: 'related', status: 'valid', usable: true, ...extra })
const state = (nodeId: string, value: NodeState['state']): NodeState => ({ nodeId: nodeId as never, state: value, needsReview: false, doubtful: false, explanation: '', evidence: [], rulesVersion: 'x', computedAt: new Date().toISOString(), courses: [] })
const options = (extra: Partial<GraphOptions> = {}): GraphOptions => ({
  colorBy: 'state', relation: 'all', showOutside: false, depth: 1, query: '', states: new Map(), courseId: 'c1', courses: [{ id: 'c1', title: '甲课' }, { id: 'c2', title: '乙课' }], ...extra,
})

describe('graph model', () => {
  it('points every ordering arrow from what comes first to what builds on it', () => {
    expect(arrowEnds({ from: 'needs', to: 'needed', type: 'requires' })).toEqual(['needed', 'needs'])
    expect(arrowEnds({ from: 'first', to: 'later', type: 'recommended-before' })).toEqual(['first', 'later'])
    expect(arrowEnds({ from: 'part', to: 'whole', type: 'part-of' })).toEqual(['part', 'whole'])
    const model = buildModel([node('a'), node('b')], [edge('e', 'a', 'b', { type: 'requires' }), edge('r', 'a', 'b')], options(), colors)
    expect(model.edges.find(e => e.id === 'e')).toMatchObject({ source: 'b', target: 'a', arrow: true, color: 'accent' })
    expect(model.edges.find(e => e.id === 'r')).toMatchObject({ arrow: false })
  })

  it('colours by state, greys shared and unavailable states, and never lets one colour mean two things', () => {
    const states = new Map([['a', state('a', 'independent')], ['b', state('b', 'not-yet')]])
    const nodes = [node('a'), node('b', { courseIds: ['c1', 'c2'] }), node('c')]
    const course = buildModel(nodes, [], options({ states }), colors)
    expect(course.nodes.map(n => n.color)).toEqual(['independent', 'neutral', 'untested'])
    expect(course.nodes.map(n => n.subtitle)).toEqual(['已独立完成', '本课条件待验证', '未探测'])
    expect(buildModel(nodes, [], options({ states: undefined }), colors).nodes.every(n => n.color === 'neutral' && n.subtitle === '状态暂不可用')).toBe(true)
    const byCourse = buildModel([node('a'), node('x', { courseIds: ['c2'] }), node('b', { courseIds: ['c1', 'c2'] })], [], options({ states, colorBy: 'course', courseId: undefined }), colors)
    expect(byCourse.nodes.map(n => n.color)).toEqual(['course-1', 'course-2', 'neutral'])
    expect(byCourse.nodes[2]!.subtitle).toBe('还没答对 · 2 门课程共享')
  })

  it('counts outside neighbours, draws them faded only on request, and hides filtered relations with a count', () => {
    const nodes = [node('a'), node('b'), node('o', { inScope: false, courseIds: ['c2'] }), node('far', { inScope: false, courseIds: ['c2'] })]
    const edges = [edge('ab', 'a', 'b', { type: 'requires' }), edge('ao', 'a', 'o'), edge('ofar', 'o', 'far')]
    const hidden = buildModel(nodes, edges, options(), colors)
    expect(hidden.outside).toBe(1)
    expect(hidden.nodes.map(n => n.id)).toEqual(['a', 'b'])
    const shown = buildModel(nodes, edges, options({ showOutside: true }), colors)
    expect(shown.nodes.find(n => n.id === 'o')).toMatchObject({ faded: true, subtitle: '课外相关', labelColor: 'muted' })
    expect(shown.nodes.some(n => n.id === 'far')).toBe(false)
    const order = buildModel(nodes, edges, options({ relation: 'order' }), colors)
    expect(order.edges.map(e => e.id)).toEqual(['ab'])
    expect(order.hiddenEdges).toBe(0)
    expect(buildModel(nodes, edges, options({ relation: 'related' }), colors).hiddenEdges).toBe(1)
  })

  it('fades outside the selected neighbourhood by depth, and outside the search when nothing is selected', () => {
    const nodes = ['a', 'b', 'c', 'd'].map(id => node(id))
    const edges = [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('cd', 'c', 'd')]
    const faded = (extra: Partial<GraphOptions>) => buildModel(nodes, edges, options(extra), colors).nodes.filter(n => n.faded).map(n => n.id)
    expect(faded({ selected: 'a', depth: 1 })).toEqual(['c', 'd'])
    expect(faded({ selected: 'a', depth: 2 })).toEqual(['d'])
    expect(faded({ selected: 'a', depth: 'all' })).toEqual([])
    expect(faded({ query: '节点c' })).toEqual(['a', 'b', 'd'])
    expect(neighborhood([{ source: 'x', target: 'y' }], 'y', 1)).toEqual(new Set(['x', 'y']))
    expect(buildModel(nodes, edges, options({ selected: 'b' }), colors).nodes.find(n => n.id === 'b')).toMatchObject({ size: nodeRadius(2) + 3, forceLabel: true })
  })

  it('adds one ring per material and one per course textbook, linked only to drawn nodes', () => {
    const sources: KnowledgeSourceLayer = {
      sources: [{ id: 'so1', title: '合成资料', links: [{ nodeId: 'a', chunks: [{ id: 'ck1', citation: '《合成资料》p.1' }] }, { nodeId: 'hidden', chunks: [] }] }, { id: 'so2', title: '无关资料', links: [{ nodeId: 'hidden', chunks: [] }] }],
      textbooks: [{ courseId: 'c1', nodeIds: ['a', 'b'] }],
    }
    const model = buildModel([node('a'), node('b')], [], options({ sources }), colors)
    expect(model.nodes.filter(n => n.type === 'source').map(n => [n.id, n.label])).toEqual([['src:so1', '合成资料'], ['tb:c1', '甲课 · 课程教材']])
    expect(model.edges.map(e => e.id).sort()).toEqual(['src:so1>a', 'tb:c1>a', 'tb:c1>b'])
  })

  it('sizes nodes by their drawn relations whatever the filter shows, and colours by stage on request', () => {
    const nodes = ['hub', 'a', 'b', 'c', 'lone'].map(id => node(id))
    const edges = [edge('1', 'hub', 'a', { type: 'requires' }), edge('2', 'hub', 'b'), edge('3', 'hub', 'c')]
    const size = (extra: Partial<GraphOptions>) => Object.fromEntries(buildModel(nodes, edges, options(extra), colors).nodes.map(n => [n.id, n.size]))
    expect(size({})).toMatchObject({ hub: nodeRadius(3), a: nodeRadius(1), lone: nodeRadius(0) })
    expect(size({ relation: 'order' })).toEqual(size({}))
    expect(nodeRadius(400)).toBe(nodeRadius(10_000))
    const stages = [{ id: 's1', title: '第 1 阶段 静力学', nodeIds: ['a', 'hub'] }, { id: 's2', title: '第 2 阶段 流动', nodeIds: ['b', 'a'] }]
    const staged = buildModel(nodes, edges, options({ colorBy: 'stage', stages }), colors).nodes
    expect(staged.map(n => n.color)).toEqual(['course-1', 'course-1', 'course-2', 'neutral', 'neutral'])
    expect(staged.find(n => n.id === 'c')!.subtitle).toBe('未探测 · 不在任何阶段')
    // The sidebar's focus: larger and always named; faded nodes keep the colour hovering shows.
    const local = buildModel(nodes, edges, options({ emphasis: new Set(['a']) }), colors).nodes.find(n => n.id === 'a')!
    expect(local).toMatchObject({ size: nodeRadius(1) + 2, forceLabel: true })
    const faded = buildModel(nodes, edges, options({ selected: 'lone' }), colors).nodes.find(n => n.id === 'hub')!
    expect(faded).toMatchObject({ faded: true, color: 'faint', baseColor: 'untested' })
  })

  it('reads the graph settings back with defaults for anything missing or out of range', () => {
    expect(withDefaults(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(withDefaults({ repel: 2, link: 'x', center: 0.9 })).toEqual({ ...DEFAULT_SETTINGS, repel: 1, center: 0.9 })
    const physics = physicsOf(DEFAULT_SETTINGS)
    expect(physics.repel).toBeLessThan(0)
    expect(physicsOf({ ...DEFAULT_SETTINGS, distance: 1 }).distance).toBeGreaterThan(physics.distance)
  })

  it('writes outside nodes and shared ones in words', () => {
    expect(stateText(node('a', { inScope: false }), { states: new Map(), courseId: 'c1' })).toBe('课外相关')
    expect(stateText(node('a'), { states: new Map([['a', { ...state('a', 'assisted'), doubtful: true }]]), courseId: 'c1' })).toBe('有帮助完成 · 有疑点')
  })
})

describe('graph endpoints', () => {
  let h: Harness | undefined
  afterEach(async () => { await h?.settle(); h?.dispose(); h = undefined })
  const teacher = { actor: 'teacher' as const, reason: '合成图谱验收' }

  it('returns every course with shared nodes once, and another course\'s scoped relations only on the main page', async () => {
    h = createHarness(() => { throw new Error('no model') })
    const k = h.ctx.learnKnowledge
    const a = await h.ctx.learnCore.courses.create({ title: '甲课' }), b = await h.ctx.learnCore.courses.create({ title: '乙课' })
    const first = await k.add(a.id, { nodes: [{ title: '共用', kind: 'knowledge' }, { title: '甲独有', kind: 'skill' }], edges: [{ from: '共用', to: '甲独有', type: 'related' }] }, teacher)
    const shared = first.nodes.find(n => n.title === '共用')!
    await k.add(b.id, { nodes: [{ title: '共用', kind: 'knowledge', reuseId: shared.id }, { title: '乙独有', kind: 'task' }] }, { actor: 'user', reason: '学习者复用' })
    await k.add(b.id, { nodes: [], edges: [{ from: shared.id, to: '乙独有', type: 'part-of' }] }, teacher)
    const removed = await k.add(a.id, { nodes: [{ title: '移出', kind: 'knowledge' }] }, teacher)
    const gone = removed.nodes.find(n => n.title === '移出')!
    k.setMembership(a.id, gone.id, gone.membership.version, { status: 'inactive' }, { actor: 'user', reason: '移出' })
    const global = await h.endpoint<KnowledgeGlobal>('knowledge', 'global', {})
    expect(global.nodes.map(n => n.title).sort()).toEqual(['乙独有', '共用', '甲独有'])
    expect(global.nodes.find(n => n.id === shared.id)?.courseIds).toEqual([a.id, b.id])
    expect(global.edges.map(e => e.type).sort()).toEqual(['part-of', 'related'])
    expect(global.courses.map(c => c.title)).toEqual(['甲课', '乙课'])
  })

  it('groups source links by material, keeps problems out, and lists textbook paragraphs per course', async () => {
    h = createHarness(() => { throw new Error('no model') })
    const course = await h.ctx.learnCore.courses.create({ title: '出处课' })
    const fixture = join(FIXTURES, 'synthetic-chapter')
    const source = await h.ctx.learnLibrary.importParsed({ title: '合成资料', kind: 'textbook', authority: '1', file: join(fixture, 'source.md'), parsed: [join(fixture, 'middle.json')], courseId: course.id })
    const chunk = h.ctx.learnLibrary.section(source.id, '1.1').find(c => c.kind === 'text')!
    const graph = await h.ctx.learnKnowledge.add(course.id, { nodes: [{ title: '有出处', kind: 'knowledge', sources: [chunk.id] }, { title: '无出处', kind: 'knowledge' }] }, teacher)
    const target = graph.nodes.find(n => n.title === '有出处')!
    const [problem] = h.ctx.learnAssess.addProblems([{ stem: '预留题干', answer: { kind: 'open', rubric: '预留答案' }, answerSource: 'book', tier: 1, origin: { kind: 'chunk', chunkId: chunk.id, label: chunk.citation }, nodeIds: [target.id], pool: 'test-reserved' }])
    h.ctx.learnKnowledge.link([{ nodeId: target.id, target: { kind: 'problem', id: problem!.id }, relation: 'assesses' }], teacher, course.id)
    // The paragraph cites the node's source chunk: that is what links it (docs/textbook/design.md, 知识关联).
    ;(h.ctx.learnTextbook as unknown as { reindex(courseId: string, file: string, text: string): void }).reindex(course.id, 'stages/s1/textbook/01.md', `这一段讲有出处。[合成资料](cite:${chunk.id}) ^aaa001`)
    const layer = await h.endpoint<KnowledgeSourceLayer>('knowledge', 'sources', { courseId: course.id })
    expect(layer.sources).toEqual([{ id: source.id, title: '合成资料', links: [{ nodeId: target.id, chunks: [{ id: chunk.id, citation: chunk.citation }] }] }])
    expect(layer.textbooks).toEqual([{ courseId: course.id, nodeIds: [target.id] }])
    expect(JSON.stringify(layer)).not.toContain('预留')
    expect((await h.endpoint<KnowledgeSourceLayer>('knowledge', 'sources', {})).sources).toHaveLength(1)
  })

  it('lists a node\'s evidence newest first in words, marks what the state cites, and never writes the log', async () => {
    h = createHarness(() => { throw new Error('no model') })
    const course = await h.ctx.learnCore.courses.create({ title: '证据课' })
    const node = (await h.ctx.learnKnowledge.add(course.id, { nodes: [{ title: '证据节点', kind: 'skill' }] }, teacher)).nodes[0]!
    h.ctx.learnCore.log.append({ type: 'help.given', courseId: course.id, nodeIds: [node.id], context: {}, level: 'hint', via: 'side-chat' })
    h.ctx.learnCore.log.append({
      type: 'attempt.graded', courseId: course.id, nodeIds: [node.id], context: { testId: 'ts_01M4B3XH1KGWBX9DNECY7H59X2' as never },
      attemptId: 'at_01M4B3XH1KGWBX9DNECY7H59X2' as never, problemId: 'pb_01M4B3XH1KGWBX9DNECY7H59X2' as never, testKind: 'quiz',
      conditions: { book: 'closed', calculator: true, formulaSheet: false, timeLimit: 20 }, grading: { verdict: 'correct', method: 'rule', rationale: '' },
    })
    await h.settle()
    const before = h.ctx.learnCore.db.sqlite.prepare('SELECT count(*) AS n FROM core_log').get() as { n: number }
    const records = await h.endpoint<EvidenceRecord[]>('learner', 'evidence', { nodeId: node.id })
    expect(records.map(r => [r.what, r.result, r.tone])).toEqual([['小测作答', '答对', 'ok'], ['侧边提问给了提示', undefined, 'neutral']])
    expect(records[0]).toMatchObject({ conditions: '闭卷 · 可用计算器 · 限时 20 分钟', testId: 'ts_01M4B3XH1KGWBX9DNECY7H59X2' })
    const cited = new Set(h.ctx.learnLearner.states([node.id])[0]?.evidence ?? [])
    expect(records.map(r => r.counted)).toEqual(records.map(r => cited.has(r.id as never)))
    expect(h.ctx.learnCore.db.sqlite.prepare('SELECT count(*) AS n FROM core_log').get()).toEqual(before)
  })
})
