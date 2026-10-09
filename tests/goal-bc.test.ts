// goal B and C (docs/goal/design.md): candidate endpoints shown only when the call passes its
// checks, the source checklist the learner answers on the page, exam scope on the knowledge graph,
// stages naming the goal items they build towards, and the countdown. Synthetic data; no model calls.
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { CourseGraph, GoalView, Id } from '@learning-agent/contracts'
import * as goalTools from '../packages/goal/src/tools.ts'
import * as knowledgeTools from '../packages/knowledge/src/tools.ts'
import { countdownText } from '../packages/planner/src/countdown.ts'
import { FIXTURES, createHarness, type Harness } from './harness.ts'

let h: Harness
let courseId = ''
let skeletonId = ''
let syllabusId = ''
let inside = '' as Id<'chunk'>
let outside = '' as Id<'chunk'>
let exec: unknown
const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
const teacher = { actor: 'teacher' as const, reason: '目标 B、C 测试（合成）' }

function day(offset: number): string {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

async function brief(unit: string): Promise<string> {
  const sections = await (h.ctx as unknown as { waterfall(name: string, request: unknown, last: () => Promise<{ unit: string; text: string }[]>): Promise<{ unit: string; text: string }[]> })
    .waterfall('learning/course-brief', { courseId, sessionId: 'brief' }, async () => [])
  return sections.filter(section => section.unit === unit).map(section => section.text).join('\n')
}

async function view(): Promise<GoalView> {
  return h.endpoint<GoalView>('goal', 'view', { courseId })
}

beforeAll(async () => {
  h = createHarness(call => { throw new Error(`unexpected model call: ${call.purpose}`) })
  courseId = (await h.endpoint('core', 'createCourse', { title: '目标 B、C（合成资料）' })).id
  const long = join(FIXTURES, 'synthetic-long-section'), chapter = join(FIXTURES, 'synthetic-chapter')
  skeletonId = (await h.endpoint('library', 'import', { title: '合成长小节', kind: 'textbook', authority: '1', file: join(long, 'source.md'), parsed: [join(long, 'middle.json')], courseId, role: 'skeleton' })).id
  syllabusId = (await h.endpoint('library', 'import', { title: '合成教学大纲', kind: 'other', authority: '1', file: join(chapter, 'source.md'), parsed: [join(chapter, 'middle.json')], courseId, role: 'reference' })).id
  inside = h.ctx.learnLibrary.section(skeletonId, '1.2.3').find(chunk => chunk.kind === 'text')!.id
  outside = h.ctx.learnLibrary.section(skeletonId, '1.2.5').find(chunk => chunk.kind === 'text')!.id
  ;(h.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  goalTools.apply(h.ctx as never)
  knowledgeTools.apply(h.ctx as never)
  exec = { agent: { session: { id: await h.ctx.learnTutor.session(courseId) } } }
})

afterAll(() => h.dispose())

it('shows candidate endpoints only when the call passes its checks', async () => {
  const offer = tools.get('offer_goal_options')!
  const option = (title: string, extra: Record<string, unknown> = {}) => ({ title, canDo: ['能算出静水压强'], ...extra })
  await expect(offer.execute({ options: [option('能读懂原理'), option('能做课后习题', { sample: { chunkId: inside, stem: '求水下 2 m 处的压强', reach: '独立算对' } })], recommended: '能做课后习题' }, exec))
    .resolves.toMatch(/^候选终点已显示为卡片：能读懂原理、能做课后习题。/)
  await expect(offer.execute({ options: [option('只有一个')] }, exec)).rejects.toThrow(/要 2–4 个/)
  await expect(offer.execute({ options: [option('甲', { sample: { chunkId: 'ck_01J0000000000000000000000A', stem: '题', reach: '会' } }), option('乙')] }, exec)).rejects.toThrow(/样题片段不在本课资料里/)
  await expect(offer.execute({ options: [option('甲', { canDo: ['能讲清 kn_01J0000000000000000000000A'] }), option('乙')] }, exec)).rejects.toThrow(/不写内部编号/)
})

it('keeps a source checklist that the learner answers on the page', async () => {
  await h.ctx.learnGoal.saveDraft(courseId, {
    purpose: '通过期末考试', scenario: '复习', canDo: ['能算出静水压强', '能解释等压面'], level: '会做题', verification: '模拟卷',
    boundaries: { defaultConditions: { book: 'closed', calculator: true, formulaSheet: false } },
    exam: { scope: '第一章', conditions: { book: 'closed', calculator: true, formulaSheet: false }, focus: 'balanced' },
    sources: [
      { what: '学校的教学大纲', why: '考试范围以它为准', role: 'reference', by: 'learner' },
      { what: '往年题', role: 'exam-archive', by: 'learner' },
      { what: '公开课讲义', role: 'reference', by: 'teacher' },
    ],
  }, '# 目标说明\n', teacher)
  await h.endpoint('goal', 'confirm', { courseId })
  // A date the teacher does not know yet is refused in words, or left out when it comes empty.
  await expect(h.ctx.learnGoal.revise(courseId, 2, { exam: { date: '未公布' } }, teacher)).rejects.toThrow(/exam\.date：日期要写成 2027-01-15 这样；还不知道就不写这一项/)
  await expect(tools.get('revise_goal')!.execute({ version: 2, reason: '考试日期未定', exam: { date: '' } }, exec)).resolves.toMatch(/^没有修改/)
  let page = await view()
  expect(page.sources.map(need => `${need.key} ${need.state}`)).toEqual(['s1 wanted', 's2 wanted', 's3 teacher'])
  expect(await brief('goal')).toContain('- s1 学校的教学大纲（等学习者提供）')

  await h.endpoint('goal', 'setSource', { courseId, version: page.doc.goal.version, key: 's1', sourceId: syllabusId })
  page = await view()
  expect(page.sources[0]).toMatchObject({ state: 'have', title: '合成教学大纲' })
  expect(page.doc.goal.status).toBe('confirmed')
  await h.settle()
  expect(h.delivered.at(-1)!.text).toContain('学习者在资料清单里说：《合成教学大纲》就是「学校的教学大纲」。')

  // A past paper found for the checklist is the exam's past paper; taking it back takes it out again.
  await h.endpoint('goal', 'setSource', { courseId, version: page.doc.goal.version, key: 's2', sourceId: skeletonId })
  page = await view()
  expect(page.doc.goal.exam?.pastPaperSourceIds).toEqual([skeletonId])
  await h.endpoint('goal', 'setSource', { courseId, version: page.doc.goal.version, key: 's2', missing: true })
  page = await view()
  expect(page.doc.goal.exam?.pastPaperSourceIds).toEqual([])
  expect(page.sources[1]!.state).toBe('missing')
  expect((await h.call('goal', 'setSource', { courseId, version: page.doc.goal.version, key: 's1', sourceId: 'src_01J0000000000000000000000A' })).error?.code).toBe('learning/goal/source-not-in-course')

  // The teacher re-sends the list: same names keep their answers, a new item takes a fresh key, and the goal stays confirmed.
  const { doc } = await h.ctx.learnGoal.revise(courseId, page.doc.goal.version, { sources: [
    { what: '学校的教学大纲', role: 'reference', by: 'learner' },
    { what: '往年题', role: 'exam-archive', by: 'learner' },
    { what: '老师公布的考试范围', role: 'reference', by: 'learner' },
  ] }, teacher)
  expect(doc.goal.status).toBe('confirmed')
  expect(doc.goal.sources.map(need => `${need.key} ${need.sourceId ? 'have' : need.missing ? 'missing' : 'wanted'}`)).toEqual(['s1 have', 's2 missing', 's4 wanted'])
  expect(doc.goal.sources[0]!.why).toBe('考试范围以它为准')
})

it('marks exam scope by sections, keeps "beyond", and can be undone', async () => {
  const graph: CourseGraph = await h.ctx.learnKnowledge.add(courseId, { requestId: 'exam-scope', nodes: [
    { title: '静力学基本方程', kind: 'knowledge', sources: [inside] },
    { title: '常见误区', kind: 'knowledge', sources: [outside] },
    { title: '压强计的选择', kind: 'skill' },
  ] }, teacher)
  const id = (title: string) => graph.nodes.find(node => node.title === title)!.id
  const scope = () => Object.fromEntries(h.ctx.learnKnowledge.graph(courseId).nodes.map(node => [node.title, node.membership.exam ?? 'none']))
  const first = h.ctx.learnKnowledge.markExamScope(courseId, { sections: ['1.2.3'] }, teacher)
  expect(scope()).toEqual({ 静力学基本方程: 'in-scope', 常见误区: 'out-of-scope', 压强计的选择: 'none' })
  expect(first.untagged.map(node => node.title)).toEqual(['压强计的选择'])

  // The learner's "beyond" survives a section pass; a node-by-node tag fills the rest.
  const member = h.ctx.learnKnowledge.graph(courseId).nodes.find(node => node.id === id('常见误区'))!.membership
  await h.endpoint('knowledge', 'setMembership', { courseId, nodeId: id('常见误区'), version: member.version, patch: { exam: 'beyond' } })
  const second = h.ctx.learnKnowledge.markExamScope(courseId, { sections: ['1.2.3'], nodes: [{ node: '压强计的选择', exam: 'in-scope' }] }, teacher)
  expect(scope()).toEqual({ 静力学基本方程: 'in-scope', 常见误区: 'beyond', 压强计的选择: 'in-scope' })
  expect(second.counts).toEqual({ 'in-scope': 2, beyond: 1, 'out-of-scope': 0, untagged: 0 })
  expect(await brief('knowledge')).toContain('考试范围：范围内 2 个，范围外但有助理解 1 个，范围外 0 个，未标 0 个。')

  h.ctx.learnKnowledge.revert(second.operationId!, teacher)
  expect(scope()['压强计的选择']).toBe('none')
  const text = await tools.get('mark_exam_scope')!.execute({ sections: ['1.2.3'], reason: '合成大纲的考试范围' }, exec)
  expect(text).toMatch(/没有需要改的标记。范围内 1 个，范围外但有助理解 1 个，范围外 0 个，未标 1 个。\n未标的节点（没有骨架教材出处，请逐个判断）：\n.* 压强计的选择/)
})

it('lets each stage name the goal items it builds towards', async () => {
  await expect(h.ctx.learnCurriculum.saveRoadmap(courseId, [{ title: '静止流体', objective: '算压强', supports: ['c9'] }], teacher))
    .rejects.toThrow(/没有这些"能做"条目：c9。现有的是：c1 能算出静水压强；c2 能解释等压面/)
  const { stages } = await h.ctx.learnCurriculum.saveRoadmap(courseId, [{ title: '静止流体', objective: '算压强', supports: ['c1'] }, { title: '应用', objective: '读压强计' }], teacher)
  expect(stages.map(stage => stage.supports)).toEqual([['c1'], []])
  expect(await brief('curriculum')).toContain('目标里还没有阶段对应的条目：c2 能解释等压面。')
  const { stage } = await h.ctx.learnCurriculum.saveDesign(stages[0]!.id, { markdown: '# 设计\n', lessons: [{ number: '1.2.3', title: '静力学基本方程' }], supports: ['c1', 'c2'] }, teacher)
  expect(stage.supports).toEqual(['c1', 'c2'])
  expect(await brief('curriculum')).not.toContain('还没有阶段对应')
})

it('counts down to the earlier of the exam and the deadline', async () => {
  let goal = (await h.ctx.learnGoal.get(courseId))!
  goal = (await h.ctx.learnGoal.revise(courseId, goal.goal.version, { exam: { date: day(100) } }, teacher)).doc
  let next = await h.ctx.learnPlanner.next(courseId)
  expect(next.countdown).toEqual({ label: '考试', date: day(100), days: 100, stagesDone: 0, stagesTotal: 2 })
  expect(countdownText(next.countdown!)).toBe(`距考试（${day(100)}）还有 14 周，路线 2 个阶段已完成 0 个`)
  await h.ctx.learnGoal.revise(courseId, goal.goal.version, { deadline: day(10) }, teacher)
  next = await h.ctx.learnPlanner.next(courseId)
  expect(countdownText(next.countdown!)).toBe(`距期限（${day(10)}）还有 10 天，路线 2 个阶段已完成 0 个`)
  expect(await brief('planner')).toContain(`距期限（${day(10)}）还有 10 天`)
  expect(countdownText({ label: '考试', date: '2020-01-01', days: -3, stagesDone: 0, stagesTotal: 0 })).toBe('距考试（2020-01-01）已过，还没有课程路线')
})
