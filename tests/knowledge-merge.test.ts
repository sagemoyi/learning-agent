// Knowledge C, merges: suggestions and "not the same", the plan, the merge as one group across courses,
// evidence read through merged identities with per-course states, and the undo. Synthetic data, no model.
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { newId, type CourseGraph, type EvidenceRecord, type Handoff, type KnowledgeOperation, type MergePlan, type MergeSuggestion } from '@learning-agent/contracts'
import { FIXTURES, createHarness, type Harness } from './harness.ts'

let h: Harness
const teacher = { actor: 'teacher' as const, reason: '合成合并验收' }
beforeEach(() => { h = createHarness(() => { throw new Error('merge tests must not call a model') }) })
afterEach(async () => { await h.settle(); h.dispose() })

async function twoCourses() {
  const a = await h.ctx.learnCore.courses.create({ title: '流体课' }), b = await h.ctx.learnCore.courses.create({ title: '传热课' })
  const fixture = join(FIXTURES, 'synthetic-chapter')
  const source = await h.ctx.learnLibrary.importParsed({ title: '合成资料', kind: 'textbook', authority: '1', file: join(fixture, 'source.md'), parsed: [join(fixture, 'middle.json')], courseId: a.id })
  h.ctx.learnLibrary.attach(b.id, source.id, 'reference')
  const [chunk, chunk2] = h.ctx.learnLibrary.section(source.id, '1.1').filter(chunk => chunk.kind === 'text')
  const k = h.ctx.learnKnowledge
  const ga = await k.add(a.id, { nodes: [{ title: '雷诺数', kind: 'knowledge', description: '惯性力与黏性力之比' }, { title: '流型', kind: 'knowledge' }] }, teacher)
  const gb = await k.add(b.id, { nodes: [{ title: '雷诺数（Re）', kind: 'knowledge', description: '判断流型的无量纲数' }, { title: '对流传热', kind: 'knowledge' }] }, teacher)
  const id = (graph: CourseGraph, title: string) => graph.nodes.find(node => node.title === title)!.id as string
  return { a, b, chunk: chunk!, chunk2: chunk2!, keep: id(ga, '雷诺数'), flow: id(ga, '流型'), merge: id(gb, '雷诺数（Re）'), heat: id(gb, '对流传热') }
}

function graded(courseId: string, nodeIds: string[], verdict: 'correct' | 'incorrect') {
  return h.ctx.learnCore.log.append({
    type: 'attempt.graded', courseId: courseId as never, nodeIds: nodeIds as never, context: {},
    attemptId: newId('attempt'), problemId: newId('problem'), grading: { verdict, method: 'rule', rationale: '' },
  })
}

const pairs = (list: MergeSuggestion[]) => list.map(item => item.nodes.map(node => node.id as string).sort().join('|'))
const pairOf = (x: string, y: string) => [x, y].sort().join('|')

async function mergeNow(keepId: string, mergeId: string): Promise<KnowledgeOperation> {
  const plan = await h.endpoint<MergePlan>('knowledge', 'mergePlan', { keepId, mergeId })
  return h.endpoint<KnowledgeOperation>('knowledge', 'merge', { keepId, keepVersion: plan.keep.version, mergeId, mergeVersion: plan.merge.version })
}

it('suggests same-kind nodes named alike in different courses, never across kinds or within one course, and remembers "not the same"', async () => {
  const { a, b, keep, flow, merge, heat } = await twoCourses(), k = h.ctx.learnKnowledge
  await k.add(b.id, { nodes: [{ title: '流型', kind: 'skill' }] }, teacher)
  // The learner may keep a second "雷诺数" in course A on purpose; it is never paired with the first.
  const dup = (await h.endpoint<CourseGraph>('knowledge', 'add', { courseId: a.id, input: { nodes: [{ title: '雷诺数', kind: 'knowledge' }] } })).nodes.filter(node => node.title === '雷诺数').map(node => node.id as string).find(id => id !== keep)!
  let list = await h.endpoint<MergeSuggestion[]>('knowledge', 'mergeSuggestions', {})
  expect(pairs(list).sort()).toEqual([pairOf(keep, merge), pairOf(dup, merge)].sort())
  expect(list.find(item => pairs([item])[0] === pairOf(keep, merge))).toMatchObject({ by: 'system', why: '名称相同（不计括号里的说明）', keepId: keep })
  expect(pairs(await h.endpoint<MergeSuggestion[]>('knowledge', 'mergeSuggestions', { courseId: b.id }))).toHaveLength(2)

  const version = (id: string) => k.node(id)!.version
  await h.endpoint('knowledge', 'keepSeparate', { aId: keep, aVersion: version(keep), bId: merge, bVersion: version(merge) })
  expect(pairs(await h.endpoint<MergeSuggestion[]>('knowledge', 'mergeSuggestions', {}))).not.toContain(pairOf(keep, merge))
  expect(() => k.proposeMerge(keep, merge, '同一个无量纲数')).toThrow(/不是同一项/)
  // A revision on either side asks again.
  k.editNode(b.id, merge, version(merge), { description: '判断流型用的无量纲数' }, teacher)
  expect(pairs(await h.endpoint<MergeSuggestion[]>('knowledge', 'mergeSuggestions', {}))).toContain(pairOf(keep, merge))
  const stale = await h.call('knowledge', 'keepSeparate', { aId: keep, aVersion: version(keep), bId: merge, bVersion: version(merge) - 1 })
  expect(stale.error?.code).toBe('learning/knowledge/version-conflict')

  k.proposeMerge(flow, heat, '合成：主老师认为两者讨论的是同一现象')
  list = await h.endpoint<MergeSuggestion[]>('knowledge', 'mergeSuggestions', {})
  expect(list[0]).toMatchObject({ by: 'teacher', why: '合成：主老师认为两者讨论的是同一现象', keepId: flow })
  expect(() => k.proposeMerge(flow, k.resolve(b.id, '流型')!.id, '类型不同')).toThrow(/类型不同/)
  expect(() => k.proposeMerge(keep, heat, `依据同一片段 ${newId('chunk')}`)).toThrow(/不写内部编号/)
})

it('merges as one group across courses: memberships, moved and folded relations and links, with evidence left as it was', async () => {
  const { a, b, chunk, chunk2, keep, merge, heat } = await twoCourses(), k = h.ctx.learnKnowledge
  const shared = (await k.add(a.id, { nodes: [{ title: '黏度', kind: 'knowledge' }] }, teacher)).nodes.find(node => node.title === '黏度')!.id as string
  await h.endpoint('knowledge', 'add', { courseId: b.id, input: { nodes: [{ title: '黏度', kind: 'knowledge', reuseId: shared }] } })
  await k.add(a.id, { nodes: [], edges: [{ from: keep, to: shared, type: 'related', scope: { kind: 'global' }, rationale: '合成依据一', sources: [chunk.id], status: 'valid' }] }, teacher)
  await k.add(b.id, { nodes: [], edges: [
    { from: merge, to: shared, type: 'related', scope: { kind: 'global' }, rationale: '合成依据二', sources: [chunk2.id], status: 'valid' },
    { from: heat, to: merge, type: 'requires', rationale: '合成依据三', sources: [chunk.id], status: 'valid' },
  ] }, teacher)
  k.link([{ nodeId: merge as never, target: { kind: 'chunk', id: chunk.id }, relation: 'explains' }], teacher, b.id)
  graded(b.id, [merge], 'correct')
  await h.settle()
  const log = h.ctx.learnCore.db.sqlite.prepare('SELECT * FROM core_log ORDER BY id').all()
  const handoffs: Handoff[] = []
  h.ctx.on('learning/handoff', handoff => { handoffs.push(handoff) })

  const plan = await h.endpoint<MergePlan>('knowledge', 'mergePlan', { keepId: keep, mergeId: merge })
  expect(plan.joins.map(course => course.id)).toEqual([b.id])
  expect(plan.moved.map(edge => [edge.from, edge.to, edge.type])).toEqual([[heat, keep, 'requires']])
  expect(plan.folded.map(edge => edge.type)).toEqual(['related'])
  expect(plan).toMatchObject({ stopped: [], links: 1 })
  expect(plan.blocked).toBeUndefined()
  const op = await mergeNow(keep, merge)
  expect([...op.courseIds!].sort()).toEqual([a.id, b.id].sort())
  expect(k.history(a.id)[0]!.id).toBe(op.id)
  expect(k.history(b.id)[0]!.id).toBe(op.id)
  expect(handoffs.map(handoff => handoff.courseId).sort()).toEqual([a.id, b.id].sort())

  // The merged identity stays, points at the kept one, and its old id and name still find it.
  expect(k.node(merge)).toMatchObject({ status: 'inactive', replacedBy: keep })
  expect(k.detail(b.id, merge).titles[keep]).toBe('雷诺数')
  expect(k.resolve(b.id, merge)?.id).toBe(keep)
  expect(k.resolve(b.id, '雷诺数（Re）')?.id).toBe(keep)
  expect(k.identity(merge)).toEqual({ current: keep, merged: [] })
  expect(k.identity(keep)).toEqual({ current: keep, merged: [merge] })
  const graph = k.graph(b.id)
  expect(graph.nodes.map(node => node.id)).toContain(keep)
  expect(graph.nodes.map(node => node.id)).not.toContain(merge)
  expect(graph.edges.find(edge => edge.type === 'requires')).toMatchObject({ from: heat, to: keep, status: 'valid', usable: true })
  const related = k.global().edges.filter(edge => edge.type === 'related')
  expect(related).toHaveLength(1)
  expect([...related[0]!.sources].sort()).toEqual([chunk.id, chunk2.id].sort())
  expect(k.links(keep).map(link => link.target)).toContainEqual({ kind: 'chunk', id: chunk.id })
  expect(k.global().nodes.find(node => node.id === keep)?.formerTitles).toEqual(['雷诺数（Re）'])

  // The log is untouched; the kept node's state reads the merged entries, per course.
  expect(h.ctx.learnCore.db.sqlite.prepare('SELECT * FROM core_log ORDER BY id').all()).toEqual(log)
  const state = h.ctx.learnLearner.states([keep])[0]!
  expect(state.state).toBe('independent')
  expect(state.courses.map(course => [course.courseId, course.state])).toEqual([[b.id, 'independent']])
  const records = await h.endpoint<EvidenceRecord[]>('learner', 'evidence', { nodeId: keep })
  expect(records[0]).toMatchObject({ result: '答对', node: '雷诺数（Re）' })
  expect(pairs(await h.endpoint<MergeSuggestion[]>('knowledge', 'mergeSuggestions', {}))).not.toContain(pairOf(keep, merge))
  // Deleting the derived states and recomputing gives the same result.
  h.ctx.learnCore.db.sqlite.prepare('DELETE FROM learner_states').run()
  expect(h.ctx.learnLearner.recompute([keep])[0]).toMatchObject({ state: 'independent', courses: [expect.objectContaining({ courseId: b.id, state: 'independent' })] })
})

it('refuses a merge that would close a prerequisite cycle, and stops relations between the two nodes', async () => {
  const course = await h.ctx.learnCore.courses.create({ title: '环路课' })
  const fixture = join(FIXTURES, 'synthetic-chapter')
  const source = await h.ctx.learnLibrary.importParsed({ title: '合成资料', kind: 'textbook', authority: '1', file: join(fixture, 'source.md'), parsed: [join(fixture, 'middle.json')], courseId: course.id })
  const chunk = h.ctx.learnLibrary.section(source.id, '1.1').find(item => item.kind === 'text')!
  const added = await h.endpoint<CourseGraph>('knowledge', 'add', { courseId: course.id, input: { nodes: [{ title: '甲', kind: 'skill' }, { title: '甲', kind: 'skill' }, { title: '乙', kind: 'skill' }] } })
  const [x1, x2] = added.nodes.filter(node => node.title === '甲').map(node => node.id as string)
  const p = added.nodes.find(node => node.title === '乙')!.id as string
  const k = h.ctx.learnKnowledge, basis = { rationale: '合成依据', sources: [chunk.id], status: 'valid' as const }
  await k.add(course.id, { nodes: [], edges: [{ from: x1!, to: p, type: 'requires', ...basis }, { from: p, to: x2!, type: 'requires', ...basis }, { from: x1!, to: x2!, type: 'related' }] }, teacher)
  const plan = await h.endpoint<MergePlan>('knowledge', 'mergePlan', { keepId: x1, mergeId: x2 })
  expect(plan.blocked).toMatch(/先修关系出现循环：甲 → 乙 → 甲/)
  expect(plan.stopped.map(edge => edge.type)).toEqual(['related'])
  const history = k.history(course.id).length
  const refused = await h.call('knowledge', 'merge', { keepId: x1, keepVersion: plan.keep.version, mergeId: x2, mergeVersion: plan.merge.version })
  expect(refused.error?.code).toBe('learning/knowledge/cycle')
  expect(k.history(course.id)).toHaveLength(history)
  expect(k.node(x2!)?.replacedBy).toBeUndefined()

  const back = k.graph(course.id).edges.find(edge => edge.from === p && edge.to === x2)!
  k.editEdge(course.id, back.id, back.version, { status: 'draft' }, teacher)
  await mergeNow(x1!, x2!)
  expect(k.graph(course.id).edges.map(edge => [edge.type, edge.from, edge.to]).sort()).toEqual([['requires', p, x1], ['requires', x1, p]].sort())
  expect(k.global().edges.some(edge => edge.type === 'related')).toBe(false)
})

it('counts each course\'s answers for a shared node, lets help from any course count, and counts one entry once', async () => {
  const { a, b, keep, merge } = await twoCourses()
  h.ctx.learnCore.log.append({ type: 'help.given', courseId: a.id as never, nodeIds: [merge] as never, context: {}, level: 'explanation', via: 'side-chat' })
  graded(b.id, [merge], 'correct')
  const both = graded(a.id, [keep, merge], 'incorrect')
  await h.settle()
  await mergeNow(keep, merge)
  const state = h.ctx.learnLearner.states([keep])[0]!
  // The answer tagged with both identities is cited once by the state it supports.
  expect(state.courses.find(course => course.courseId === a.id)!.evidence.filter(id => id === both.id)).toHaveLength(1)
  expect(Object.fromEntries(state.courses.map(course => [course.courseId, course.state]))).toEqual({ [a.id]: 'not-yet', [b.id]: 'assisted' })
  const brief = await new Promise<string>(done => {
    void h.ctx.waterfall('learning/course-brief', { courseId: a.id, sessionId: 'brief' }, async () => []).then(sections => done(sections.find(section => section.unit === 'learner')!.text))
  })
  expect(brief).toContain('还没答对：雷诺数')
})

it('undoes a merge as one group, keeps entries logged meanwhile on their node, and refuses once a moved relation changed', async () => {
  const { a, b, chunk, keep, merge, heat } = await twoCourses(), k = h.ctx.learnKnowledge
  await k.add(b.id, { nodes: [], edges: [{ from: heat, to: merge, type: 'requires', rationale: '合成依据', sources: [chunk.id], status: 'valid' }] }, teacher)
  graded(b.id, [merge], 'incorrect')
  await h.settle()
  const op = await mergeNow(keep, merge)
  graded(b.id, [keep], 'correct')
  await h.settle()
  const undo = await h.endpoint<KnowledgeOperation>('knowledge', 'revert', { courseId: a.id, operationId: op.id })
  expect(undo.merge).toEqual({ keepId: keep, mergeId: merge })
  expect(k.node(merge)).toMatchObject({ status: 'active' })
  expect(k.node(merge)?.replacedBy).toBeUndefined()
  expect(k.graph(b.id).nodes.map(node => node.id)).toEqual([merge, heat])
  expect(k.graph(b.id).edges[0]).toMatchObject({ from: heat, to: merge })
  // The answer given during the merge stays with the node it was logged on.
  expect(h.ctx.learnLearner.states([keep])[0]).toMatchObject({ state: 'independent', courses: [expect.objectContaining({ courseId: b.id })] })
  expect(h.ctx.learnLearner.states([merge])[0]?.state).toBe('not-yet')
  expect(pairs(await h.endpoint<MergeSuggestion[]>('knowledge', 'mergeSuggestions', {}))).not.toContain(pairOf(keep, merge))

  const again = await mergeNow(keep, merge)
  const moved = k.graph(b.id).edges.find(edge => edge.type === 'requires')!
  k.editEdge(b.id, moved.id, moved.version, { rationale: '合成依据（修订）' }, teacher)
  const refused = await h.call('knowledge', 'revert', { courseId: b.id, operationId: again.id })
  expect(refused.error?.code).toBe('learning/knowledge/revert-conflict')
  expect(k.node(merge)?.replacedBy).toBe(keep)
})
