// curriculum C (docs/curriculum/design.md, 结课): the final check per goal "can do" item, the course report
// with each item's evidence and what is missing, the course finished and in progress again when a stage
// is added. Synthetic course; grading by rule, no model calls.
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { NewProblem, Problem, TestView } from '@learning-agent/contracts'
import * as assessTools from '../packages/assess/src/tools.ts'
import * as curriculumTools from '../packages/curriculum/src/tools.ts'
import { FIXTURES, createHarness, type Harness } from './harness.ts'

let h: Harness
let courseId = ''
let exec: unknown
const ids: Record<string, string> = {}
const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
const teacher = { actor: 'teacher' as const, reason: '课程设计 C 测试（合成）' }
const answers = new Map<string, string>()
let next = 0

const run = (name: string, args: unknown) => tools.get(name)!.execute(args, exec)
const testIdOf = (text: string) => /测试 (ts_\w+)/.exec(text)![1]!

async function brief(): Promise<string> {
  const sections = await (h.ctx as unknown as { waterfall(name: string, request: unknown, last: () => Promise<{ unit: string; title: string; text: string }[]>): Promise<{ unit: string; title: string; text: string }[]> })
    .waterfall('learning/course-brief', { courseId, sessionId: 'brief' }, async () => [])
  return sections.map(section => `## ${section.title}\n${section.text}`).join('\n')
}

function add(nodes: readonly string[], extra: Partial<NewProblem> = {}): Problem {
  const value = 10 + next++
  const [problem] = h.ctx.learnAssess.addProblems([{
    stem: `（合成）${nodes.join('、')} 第 ${next} 题`,
    answer: { kind: 'numeric', value, unit: 'kPa', tolerance: { relative: 0.02 } },
    answerSource: 'authority', tier: 2, origin: { kind: 'agent' }, size: 'standard',
    nodeIds: nodes.map(node => ids[node]!) as NewProblem['nodeIds'], pool: 'test-reserved', ...extra,
  } as NewProblem])
  answers.set(problem!.id, `${value} kPa`)
  return problem!
}

beforeAll(async () => {
  h = createHarness(call => { throw new Error(`unexpected model call: ${call.purpose}`) })
  courseId = (await h.endpoint('core', 'createCourse', { title: '课程设计 C（合成资料）' })).id
  await h.ctx.learnGoal.saveDraft(courseId, {
    purpose: '验证结课', scenario: '合成资料', canDo: ['能算静水压强', '能读压差计', '能解释等压面'], level: '会做题', verification: '结课检验',
    boundaries: { defaultConditions: { book: 'closed', calculator: true, formulaSheet: false } },
  }, '# 目标说明\n', teacher)
  await h.endpoint('goal', 'confirm', { courseId })
  await h.endpoint('library', 'import', {
    title: '合成验收资料', kind: 'textbook', authority: '1', courseId, role: 'skeleton',
    file: join(FIXTURES, 'synthetic-chapter', 'source.md'), parsed: [join(FIXTURES, 'synthetic-chapter', 'middle.json')],
  })
  const graph = await h.ctx.learnKnowledge.add(courseId, { nodes: ['静力学', '压差计', '读数'].map(title => ({ title, kind: 'skill' as const })) }, teacher)
  for (const node of graph.nodes) ids[node.title] = node.id
  // A diagnostic done, so the planner reaches the stages.
  const probe = add(['静力学'], { pool: 'practice' })
  const diagnostic = h.ctx.learnAssess.startTest({ courseId, kind: 'diagnostic', problemIds: [probe.id] })
  await h.endpoint('assess', 'submit', { testId: diagnostic.id, answers: [{ problemId: probe.id, text: '', finals: [answers.get(probe.id)!] }] })
  ;(h.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  assessTools.apply(h.ctx as never)
  curriculumTools.apply(h.ctx as never)
  exec = { agent: { session: { id: await h.ctx.learnTutor.session(courseId) } } }
})

afterAll(() => h.dispose())

it('checks every goal item at the end, writes the report with its evidence, and finishes the course', async () => {
  await run('save_roadmap', { stages: [{ title: '静力学', objective: '算压强', supports: ['c1'] }, { title: '压差计', objective: '读压差计', supports: ['c2'] }] })
  const [first, second] = h.ctx.learnCurriculum.stages(courseId)
  await h.ctx.learnCurriculum.saveDesign(first!.id, { markdown: '# 阶段 1', lessons: [{ number: '1.1', title: '静水压强' }], nodeIds: [ids['静力学']!] }, teacher)
  await h.ctx.learnCurriculum.saveDesign(second!.id, { markdown: '# 阶段 2', lessons: [{ number: '1.1', title: '压差计' }], nodeIds: [ids['压差计']!, ids['读数']!] }, teacher)
  // The stages themselves are tested elsewhere: both done.
  for (const stage of [first!, second!]) h.ctx.learnCurriculum.setStatus(stage.id, 'done')
  expect(await h.ctx.learnPlanner.next(courseId)).toMatchObject({ actor: 'teacher', title: '发布结课检验' })
  await expect(run('save_course_report', { markdown: '报告' })).rejects.toThrow(/还没有判完分的结课检验/)
  expect(await brief()).toContain('结课检验备题不够：这些目标条目对应的知识点没有没见过的测试预留题：c1 能算静水压强；c2 能读压差计。')

  add(['静力学'])
  const task = add(['静力学', '压差计'], { size: 'task' })
  expect(await brief()).not.toMatch(/结课检验备题不够/)
  const text = await run('start_test', { kind: 'final', instructions: '结课检验，独立完成' })
  // c1 takes the complete task, which covers c2 as well; c3 has no stage, so nothing checks it.
  expect(text).toMatch(/共 1 题：目标条目 2\/3 条有题。这些条目没有没见过的测试预留题，测不到：c3 能解释等压面。/)
  const testId = testIdOf(text)
  expect(await h.ctx.learnPlanner.next(courseId)).toMatchObject({ actor: 'learner', title: '做结课检验' })
  const graded = await h.endpoint<TestView>('assess', 'submit', { testId, answers: [{ problemId: task.id, text: '', finals: [answers.get(task.id)!] }] })
  expect(graded.finalReport).toMatchObject({ items: [{ key: 'c1', outcome: 'pass', problems: [1] }, { key: 'c2', outcome: 'pass', problems: [1] }], uncovered: [{ key: 'c3' }] })
  expect(await h.ctx.learnPlanner.next(courseId)).toMatchObject({ actor: 'teacher', title: '写课程报告' })

  // 读数 never answered on its own: c2 is right in the final check but still short of evidence.
  const facts = await brief()
  expect(facts).toContain('- c1 能算静水压强：做到了（结课检验第 1 题）。相关知识点：静力学（已独立完成）')
  expect(facts).toContain('- c2 能读压差计：做到了，还缺证据（结课检验第 1 题）。相关知识点：压差计（已独立完成）、读数（未探测）')
  expect(facts).toContain('- c3 能解释等压面：没测到。相关知识点：没有对应阶段')

  expect(await run('save_course_report', { markdown: '## 总结\n\n静水压强和压差计都能独立算出来；读数还要单独练一次。' })).toMatch(/课程标为"已结课"/)
  expect(h.ctx.learnCore.courses.get(courseId)?.status).toBe('finished')
  const report = (await h.ctx.learnCore.files.read(courseId, 'report.md'))!.text
  expect(report).toContain('| 能读压差计 | 做到了，还缺证据 | 结课检验第 1 题；压差计已独立完成，读数未探测 | 读数还要独立做对 |')
  expect(report).toContain('| 能解释等压面 | 没测到 | 没有对应阶段 | — |')
  expect(report).toContain('读数还要单独练一次')
  const summary = await h.endpoint<{ items: { key: string; status: string }[] }>('curriculum', 'report', { courseId })
  expect(summary.items.map(item => [item.key, item.status])).toEqual([['c1', 'done'], ['c2', 'gaps'], ['c3', 'unchecked']])
  expect(await h.ctx.learnPlanner.next(courseId)).toMatchObject({ actor: 'none', title: '已结课' })

  // A new stage after the end: the course is in progress again, the report is the last one, and the
  // stage done needs a new final check.
  await run('save_roadmap', { stages: [{ title: '等压面', objective: '解释等压面', supports: ['c3'] }] })
  expect(h.ctx.learnCore.courses.get(courseId)?.status).toBe('active')
  expect(await h.ctx.learnPlanner.next(courseId)).toMatchObject({ actor: 'teacher', title: '设计阶段 3' })
  expect(await h.endpoint('curriculum', 'report', { courseId })).toMatchObject({ finished: false })
  h.ctx.learnCurriculum.setStatus(h.ctx.learnCurriculum.stages(courseId)[2]!.id, 'done')
  expect(await h.ctx.learnPlanner.next(courseId)).toMatchObject({ actor: 'teacher', title: '发布结课检验' })
  await expect(run('save_course_report', { markdown: '报告' })).rejects.toThrow(/还没有判完分的结课检验/)
})
