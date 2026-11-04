// knowledge (docs/knowledge/design.md: 按小节抽取, 合并): sections extracted at once make one node of one concept, and a
// node named like another kind waits to be told apart; a decision saved before a merge reads the identity as it is now,
// through further merges and undos, while tests and logs keep the ids they had. Synthetic data; fake model and fake DSH.
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { type CourseGraph, type KnowledgeExtraction, type KnowledgeOperation, type MergePlan, type MergeSuggestion, type NewProblem, type SameNamePending, type TestView } from '@learning-agent/contracts'
import * as assessTools from '../../packages/assess/src/tools.ts'
import * as curriculumTools from '../../packages/curriculum/src/tools.ts'
import * as knowledgeTools from '../../packages/knowledge/src/tools.ts'
import { sameName } from '../../packages/knowledge/src/store.ts'
import { FIXTURES, adapted, createHarness, type Harness, type ModelCall } from '../harness.ts'
import { lessonCourse, lessonText, type LessonCourse } from '../lesson-setup.ts'

let h: Harness | undefined
afterEach(async () => { await h?.settle(); h?.dispose(); h = undefined })

const teacher = { actor: 'teacher' as const, reason: '合成身份验收' }

const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
function registerTools(): void {
  tools.clear()
  ;(h!.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  assessTools.apply(h!.ctx as never)
  curriculumTools.apply(h!.ctx as never)
  knowledgeTools.apply(h!.ctx as never)
}

function settled(id: string): Promise<KnowledgeExtraction> {
  const now = (h!.ctx.learnKnowledge as unknown as { sections: { get(id: string): KnowledgeExtraction | undefined } }).sections.get(id)
  if (now && ['done', 'failed', 'canceled'].includes(now.status)) return Promise.resolve(now)
  return new Promise(done => {
    const off = h!.ctx.on('learning/extraction-changed', job => {
      if (job.id === id && ['done', 'failed', 'canceled'].includes(job.status)) { off(); done(job) }
    })
  })
}

const firstChunk = (call: ModelCall) => /\[(ck_[0-9A-Z]{26})\]/.exec(call.prompt)![1]!

async function extractionCourse(reply: (call: ModelCall) => string) {
  h = createHarness(reply)
  const course = await h.ctx.learnCore.courses.create({ title: '抽取身份课' })
  const fixture = join(FIXTURES, 'retrieval-chapter')
  const source = await h.ctx.learnLibrary.importParsed({ title: '检索合成资料', kind: 'textbook', authority: '1', file: join(fixture, 'source.md'), parsed: [join(fixture, 'middle.json')], courseId: course.id })
  return { course, source }
}

it('tells names apart: a note in brackets counts when both have a different one, and a shared alias alone is not the same name', () => {
  const node = (title: string, ...aliases: string[]) => ({ title, aliases })
  expect(sameName(node('雷诺数（Re）'), node('雷诺数'))).toBe(true)
  expect(sameName(node('压力（表压）'), node('压力（绝对）'))).toBe(false)
  expect(sameName(node('ρ'), node('密度', 'ρ'))).toBe(true)
  expect(sameName(node('Viscosity'), node('viscosity '))).toBe(true)
  expect(sameName(node('摩擦系数', 'μ'), node('黏度', 'μ'))).toBe(false)
})

it('makes one node of a concept two sections extract at once, with both sections as its sources', async () => {
  const { course } = await extractionCourse(call => JSON.stringify({ nodes: [{ title: '黏度', kind: 'knowledge', description: '合成', sources: [firstChunk(call)] }] }))
  const k = h!.ctx.learnKnowledge
  // Both are running before either is answered, so each asked the model when the course had no such node.
  const starts = k.extract(course.id, ['1.1', '1.2'], 'learner')
  const jobs = await Promise.all(starts.map(start => settled(start.job!.id)))
  expect(jobs.map(job => job.status)).toEqual(['done', 'done'])
  const nodes = k.graph(course.id).nodes.filter(node => node.title === '黏度')
  expect(nodes).toHaveLength(1)
  expect(jobs.map(job => [job.result!.nodes, job.result!.reused]).sort()).toEqual([[0, 1], [1, 0]])
  expect(k.links(nodes[0]!.id).filter(link => link.target.kind === 'chunk')).toHaveLength(2)
})

it('keeps a node named like another kind out of the course until the learner or the teacher says which it is', async () => {
  const items = [{ title: '压差', kind: 'skill' }, { title: '密度', kind: 'skill' }, { title: '黏度', kind: 'skill' }]
  const { course } = await extractionCourse(call => JSON.stringify({ nodes: items.map(item => ({ ...item, description: '合成说明', sources: [firstChunk(call)] })) }))
  const k = h!.ctx.learnKnowledge
  const graph = await k.add(course.id, { nodes: [{ title: '压差', kind: 'knowledge' }, { title: '密度', kind: 'knowledge' }, { title: '黏度', kind: 'knowledge' }] }, teacher)
  const id = (title: string) => graph.nodes.find(node => node.title === title)!.id as string
  const handoffs: string[] = []
  h!.ctx.on('learning/handoff', handoff => { if (handoff.unit === 'knowledge') handoffs.push(handoff.text) })
  const [start] = k.extract(course.id, ['1.1'], 'learner')
  const job = await settled(start!.job!.id)
  // Nothing was added, yet the job did not fail: it waits to be settled.
  expect(job).toMatchObject({ status: 'done', result: { nodes: 0, reused: 0 } })
  expect(k.graph(course.id).nodes).toHaveLength(3)
  expect(handoffs.at(-1)).toContain('待区分')
  let waiting = await h!.endpoint<SameNamePending[]>('knowledge', 'sameName', { courseId: course.id })
  expect(waiting.map(entry => entry.item.title)).toEqual(['压差', '密度', '黏度'])
  expect(waiting[0]!.item.against).toEqual([{ id: id('压差'), title: '压差', kind: 'knowledge' }])

  // The teacher reads it in the brief, and may not repeat the name.
  registerTools()
  const session = await h!.ctx.learnTutor.session(course.id)
  expect(await h!.ctx.learnTutor.brief(course.id, 'brief')).toContain('settle_same_name')
  const exec = { agent: { session: { id: session } } }
  await expect(tools.get('settle_same_name')!.execute({ title: '压差', as: 'new', newTitle: '压差' }, exec)).rejects.toMatchObject({ code: 'learning/knowledge/same-name' })
  await tools.get('settle_same_name')!.execute({ title: '压差', as: 'new', newTitle: '压差测量' }, exec)
  const made = k.graph(course.id).nodes.find(node => node.title === '压差测量')!
  expect(made).toMatchObject({ kind: 'skill', description: '合成说明' })
  expect(k.links(made.id)).toHaveLength(1)

  // The learner says the second is the node the course has: it only gains the source.
  await h!.endpoint('knowledge', 'settleSameName', { courseId: course.id, jobId: job.id, title: '密度', decision: { as: 'same', nodeId: id('密度') } })
  expect(k.links(id('密度'))).toHaveLength(1)
  await h!.endpoint('knowledge', 'settleSameName', { courseId: course.id, jobId: job.id, title: '黏度', decision: { as: 'drop' } })
  expect(k.links(id('黏度'))).toEqual([])
  waiting = await h!.endpoint<SameNamePending[]>('knowledge', 'sameName', { courseId: course.id })
  expect(waiting).toEqual([])
  const again = await h!.call('knowledge', 'settleSameName', { courseId: course.id, jobId: job.id, title: '密度', decision: { as: 'drop' } })
  expect(again.error?.code).toBe('learning/knowledge/no-same-name')
  expect(k.graph(course.id).nodes.map(node => node.title)).toEqual(['压差', '密度', '黏度', '压差测量'])
})

it('lists a repeated name within one course for the learner to decide, and merges it like any other pair', async () => {
  h = createHarness(() => { throw new Error('no model here') })
  const course = await h.ctx.learnCore.courses.create({ title: '重复节点课' })
  const first = (await h.endpoint<CourseGraph>('knowledge', 'add', { courseId: course.id, input: { nodes: [{ title: '压强', kind: 'knowledge' }] } })).nodes[0]!
  const second = (await h.endpoint<CourseGraph>('knowledge', 'add', { courseId: course.id, input: { nodes: [{ title: '压强', kind: 'knowledge' }] } })).nodes.find(node => node.id !== first.id)!
  const [pair] = await h.endpoint<MergeSuggestion[]>('knowledge', 'mergeSuggestions', { courseId: course.id })
  expect(pair).toMatchObject({ why: '名称相同', keepId: first.id })
  const plan = await h.endpoint<MergePlan>('knowledge', 'mergePlan', { keepId: first.id, mergeId: second.id })
  const op = await h.endpoint<KnowledgeOperation>('knowledge', 'merge', { keepId: first.id, keepVersion: plan.keep.version, mergeId: second.id, mergeVersion: plan.merge.version })
  expect(h.ctx.learnKnowledge.graph(course.id).nodes.map(node => node.id)).toEqual([first.id])
  await h.endpoint('knowledge', 'revert', { courseId: course.id, operationId: op.id })
  expect(h.ctx.learnKnowledge.graph(course.id).nodes.map(node => node.id).sort()).toEqual([first.id, second.id].sort())
})

async function merge(keepId: string, mergeId: string): Promise<KnowledgeOperation> {
  const plan = await h!.endpoint<MergePlan>('knowledge', 'mergePlan', { keepId, mergeId })
  return h!.endpoint<KnowledgeOperation>('knowledge', 'merge', { keepId, keepVersion: plan.keep.version, mergeId, mergeVersion: plan.merge.version })
}

function reserved(node: string, value: number, size?: NewProblem['size']) {
  return h!.ctx.learnAssess.addProblems([{
    stem: `（合成）压强 ${value} kPa 换算成多少 kPa？`, answer: { kind: 'numeric', value, unit: 'kPa', tolerance: { relative: 0.02 } },
    ...adapted(h!.ctx, value), origin: { kind: 'agent' }, nodeIds: [node as never], pool: 'test-reserved', ...(size ? { size } : {}),
  } as NewProblem])[0]!
}

interface MergedCourse extends LessonCourse { readonly a: string; readonly b: string; readonly c: string; readonly exec: unknown }

/** A stage whose design names A as its core node, with B and C in the course to merge it into. */
async function mergedCourse(): Promise<MergedCourse> {
  h = createHarness(call => {
    const text = lessonText(call)
    if (text) return text
    throw new Error(`unexpected model call: ${call.purpose}`)
  })
  const base = await lessonCourse(h, '合并后的阶段（合成资料）')
  const graph = await h.ctx.learnKnowledge.add(base.courseId, { nodes: [{ title: '压强换算甲', kind: 'skill' }, { title: '压强换算乙', kind: 'skill' }, { title: '压强换算丙', kind: 'skill' }] }, teacher)
  const id = (title: string) => graph.nodes.find(node => node.title === title)!.id as string
  const [a, b, c] = [id('压强换算甲'), id('压强换算乙'), id('压强换算丙')]
  await h.ctx.learnCurriculum.saveDesign(base.stage.id, { markdown: '# 设计\n\n## 验收\n\n能换算。\n\n## 测试蓝图\n\n换算题。\n', lessons: [{ number: '1.1', title: '静水压强' }], nodeIds: [a], supports: ['c1'], reason: '合成：核心知识点定下来' }, teacher)
  await h.ctx.learnCurriculum.decideDesignRevision(base.stage.id, true)
  for (const lesson of h.ctx.learnCurriculum.lessons(base.stage.id)) h.ctx.learnCurriculum.setLessonStatus(lesson.id, 'done')
  registerTools()
  return { ...base, a, b, c, exec: { agent: { session: { id: await h.ctx.learnTutor.session(base.courseId) } } } }
}

it('assembles a stage test for a design that names a node since merged, and reads its report as the identity is now', async () => {
  const course = await mergedCourse(), { a, b, c, courseId, stage } = course
  const curriculum = h!.ctx.learnCurriculum
  const toA = await merge(b, a)
  // The design file and row keep what they said; a read gives the identity it is now.
  expect(curriculum.stage(stage.id)!.nodeIds).toEqual([b])
  expect((h!.ctx.learnCore.db.sqlite.prepare('SELECT data FROM curriculum_stages WHERE id = ?').get(stage.id) as { data: string }).data).toContain(a)

  // A problem written for the kept node after the merge: the test is assembled from it.
  const problem = reserved(b, 50)
  expect(await tools.get('start_test')!.execute({ kind: 'stage', instructions: '独立完成' }, course.exec)).toContain('核心知识点 1/1')
  const test = h!.ctx.learnAssess.tests(courseId, { kind: 'stage' }).at(-1)!
  expect(test.plan!.core).toEqual([expect.objectContaining({ id: b, also: [a] })])
  expect(test.problemIds).toEqual([problem.id])
  const graded = await h!.endpoint<TestView>('assess', 'submit', { testId: test.id, answers: [{ problemId: problem.id, text: '', finals: ['40 kPa'] }] })
  expect(graded.stageReport!.nodes).toEqual([expect.objectContaining({ nodeId: b, title: '压强换算乙', outcome: 'fail' })])
  await tools.get('save_stage_review')!.execute({ markdown: '换算还没做对。', recommend: 'next', reason: '合成：学习者想先往前走' }, course.exec)

  // Another merge after the review: the report and the risks read the last identity; the facts did not change.
  const toC = await merge(c, b)
  expect(curriculum.reviewChanges(stage.id)).toEqual([])
  expect(curriculum.reviewNotes(stage.id)).toEqual(['「压强换算乙」已经合并到「压强换算丙」'])
  const report = h!.ctx.learnAssess.view(test.id)!.stageReport!
  expect(report.nodes).toEqual([expect.objectContaining({ nodeId: c, title: '压强换算丙', outcome: 'fail' })])
  expect(h!.ctx.learnAssess.view(test.id)!.test.plan!.core[0]!.id).toBe(b)

  await h!.endpoint('curriculum', 'decideReview', { stageId: stage.id, choice: 'next' })
  expect(curriculum.carried(courseId)).toEqual([expect.objectContaining({ nodeId: c, title: '压强换算丙', kind: 'risk' })])

  // Undoing the second merge gives the earlier identity back everywhere; undoing the first parts them too.
  await h!.endpoint('knowledge', 'revert', { courseId, operationId: toC.id })
  expect(curriculum.carried(courseId)).toEqual([expect.objectContaining({ nodeId: b, title: '压强换算乙', kind: 'risk' })])
  expect(curriculum.reviewNotes(stage.id)).toEqual([])
  expect(curriculum.stage(stage.id)!.nodeIds).toEqual([b])
  await h!.endpoint('knowledge', 'revert', { courseId, operationId: toA.id })
  expect(curriculum.stage(stage.id)!.nodeIds).toEqual([a])
  const apart = h!.ctx.learnAssess.view(test.id)!.stageReport!.nodes.map(node => [node.nodeId, node.title])
  expect(apart).toEqual([[b, '压强换算乙'], [a, '压强换算甲']])
  expect(curriculum.reviewNotes(stage.id)).toEqual(['「压强换算甲」撤销合并后现在单独算，这份复盘没有单独写它'])
  // The evidence never moved: each state reads its own entries.
  expect(h!.ctx.learnLearner.states([b]).map(state => state.state)).toEqual(['not-yet'])
})

it('builds the pretest and the course report from the identity a design\'s node is now, without an internal id in sight', async () => {
  const course = await mergedCourse(), { a, b, courseId, stage } = course
  const practice = h!.ctx.learnAssess.addProblems([{
    stem: '（合成）压强 3 kPa 换算成多少 kPa？', answer: { kind: 'numeric', value: 3, unit: 'kPa', tolerance: { relative: 0.02 } },
    ...adapted(h!.ctx, 3), origin: { kind: 'agent' }, nodeIds: [b as never], pool: 'practice',
  } as NewProblem])[0]!
  await merge(b, a)
  await tools.get('start_test')!.execute({ kind: 'pretest', instructions: '探一探' }, course.exec)
  const pretest = h!.ctx.learnAssess.tests(courseId, { kind: 'pretest' }).at(-1)!
  expect(pretest.scope!.nodes).toEqual([expect.objectContaining({ id: b, title: '压强换算乙', also: [a] })])
  expect(pretest.problemIds).toEqual([practice.id])
  const seen = await h!.endpoint<TestView>('assess', 'answer', { testId: pretest.id, answer: { problemId: practice.id, text: '', finals: ['3 kPa'] } })
  expect(seen.diagnosis?.nodes ?? h!.ctx.learnAssess.view(pretest.id)!.diagnosis!.nodes).toEqual([expect.objectContaining({ nodeId: b, state: 'known' })])

  const problem = reserved(b, 60)
  await tools.get('start_test')!.execute({ kind: 'stage', instructions: '独立完成' }, course.exec)
  const test = h!.ctx.learnAssess.tests(courseId, { kind: 'stage' }).at(-1)!
  await h!.endpoint('assess', 'submit', { testId: test.id, answers: [{ problemId: problem.id, text: '', finals: ['60 kPa'] }] })
  await tools.get('save_stage_review')!.execute({ markdown: '换算做对了。', recommend: 'next' }, course.exec)
  await h!.endpoint('curriculum', 'decideReview', { stageId: stage.id, choice: 'next' })
  const final = reserved(b, 70)
  await tools.get('start_test')!.execute({ kind: 'final', instructions: '结课检验' }, course.exec)
  const check = h!.ctx.learnAssess.tests(courseId, { kind: 'final' }).at(-1)!
  await h!.endpoint('assess', 'submit', { testId: check.id, answers: [{ problemId: final.id, text: '', finals: ['70 kPa'] }] })
  const brief = await h!.ctx.learnTutor.brief(courseId, 'brief')
  const facts = brief.slice(brief.indexOf('课程报告的事实'))
  expect(facts).toContain('压强换算乙')
  expect(facts).not.toContain(a)
  expect(facts).toMatch(/做到了/)
})
