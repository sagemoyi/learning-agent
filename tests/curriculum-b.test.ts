// curriculum B (docs/curriculum/design.md, 补课单元): a remedial stage after a failed complete task —
// its design brief, a corrective lesson instead of the whole section again, a retest with a complete
// task, and a node failing again with its prerequisites shown. Synthetic course; fake model.
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { NewProblem, Problem, Stage, TestView } from '@learning-agent/contracts'
import * as assessTools from '../packages/assess/src/tools.ts'
import * as curriculumTools from '../packages/curriculum/src/tools.ts'
import { FIXTURES, createHarness, textbookSettled, type Harness } from './harness.ts'

let h: Harness
let courseId = ''
let exec: unknown
const ids: Record<string, string> = {}
const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
const teacher = { actor: 'teacher' as const, reason: '课程设计 B 测试（合成）' }
const answers = new Map<string, string>()
let next = 0

const run = (name: string, args: unknown) => tools.get(name)!.execute(args, exec)
const testIdOf = (text: string) => /测试 (ts_\w+)/.exec(text)![1]!
const stageNamed = (title: string) => h.ctx.learnCurriculum.stages(courseId).find(stage => stage.title === title)!

async function brief(): Promise<string> {
  const sections = await (h.ctx as unknown as { waterfall(name: string, request: unknown, last: () => Promise<{ unit: string; title: string; text: string }[]>): Promise<{ unit: string; title: string; text: string }[]> })
    .waterfall('learning/course-brief', { courseId, sessionId: 'brief' }, async () => [])
  return sections.map(section => `## ${section.title}\n${section.text}`).join('\n')
}

function add(node: string, extra: Partial<NewProblem> = {}): Problem {
  const value = 10 + next++
  const [problem] = h.ctx.learnAssess.addProblems([{
    stem: `（合成）${node} 第 ${next} 题`,
    answer: { kind: 'numeric', value, unit: 'kPa', tolerance: { relative: 0.02 } },
    answerSource: 'authority', tier: 2, origin: { kind: 'agent' }, size: 'standard',
    nodeIds: [ids[node]!] as NewProblem['nodeIds'], pool: 'test-reserved', ...extra,
  } as NewProblem])
  answers.set(problem!.id, `${value} kPa`)
  return problem!
}

const task = (extra: Partial<NewProblem> = {}) => add('压差计', { size: 'task', nodeIds: [ids['静力学']!, ids['压差计']!] as NewProblem['nodeIds'], ...extra })

async function takeStageTest(right: readonly Problem[]): Promise<TestView> {
  const testId = testIdOf(await run('start_test', { kind: 'stage', instructions: '阶段测试，独立完成' }))
  const open = await h.endpoint<TestView>('assess', 'view', { testId })
  return h.endpoint<TestView>('assess', 'submit', { testId, answers: open.problems.map(problem => ({ problemId: problem.id, text: '', finals: [right.some(item => item.id === problem.id) ? answers.get(problem.id)! : '1 kPa'] })) })
}

function finishLessons(stage: Stage): void {
  for (const lesson of h.ctx.learnCurriculum.lessons(stage.id)) h.ctx.learnCurriculum.setLessonStatus(lesson.id, 'done')
  h.ctx.learnCurriculum.setStatus(stage.id, 'learning')
}

beforeAll(async () => {
  h = createHarness(call => {
    if (call.purpose === 'learning-textbook') return '## 1.1 静水压强（补课）\n\n多步题先列已知量。\n\n### 读完就答\n\n1. 先算哪一步？'
    throw new Error(`unexpected model call: ${call.purpose}`)
  })
  courseId = (await h.endpoint('core', 'createCourse', { title: '课程设计 B（合成资料）' })).id
  await h.ctx.learnGoal.saveDraft(courseId, {
    purpose: '验证补课', scenario: '合成资料', canDo: ['能读压差计'], level: '会做题', verification: '阶段测试',
    boundaries: { defaultConditions: { book: 'closed', calculator: true, formulaSheet: false } },
  }, '# 目标说明\n', teacher)
  await h.endpoint('goal', 'confirm', { courseId })
  await h.endpoint('library', 'import', {
    title: '合成验收资料', kind: 'textbook', authority: '1', courseId, role: 'skeleton',
    file: join(FIXTURES, 'synthetic-chapter', 'source.md'), parsed: [join(FIXTURES, 'synthetic-chapter', 'middle.json')],
  })
  const graph = await h.ctx.learnKnowledge.add(courseId, {
    nodes: ['密度', '静力学', '压差计'].map(title => ({ title, kind: 'skill' as const })),
    edges: [{ from: '静力学', to: '密度', type: 'requires' }, { from: '压差计', to: '静力学', type: 'requires' }],
  }, teacher)
  for (const node of graph.nodes) ids[node.title] = node.id
  ;(h.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  assessTools.apply(h.ctx as never)
  curriculumTools.apply(h.ctx as never)
  exec = { agent: { session: { id: await h.ctx.learnTutor.session(courseId) } } }
})

afterAll(() => h.dispose())

it('designs a remedial stage from the review, writes a corrective lesson, and retests with a complete task', async () => {
  await run('save_roadmap', { stages: [{ title: '静力学', objective: '读压差计算压差', supports: ['c1'] }, { title: '流动', objective: '列伯努利方程' }] })
  const first = stageNamed('静力学')
  await run('save_stage_design', { stageId: first.id, markdown: '# 阶段 1 设计', lessons: [{ number: '1.1', title: '静水压强' }], nodes: ['静力学', '压差计'] })
  finishLessons(first)
  const statics = add('静力学')
  const manometer = add('压差计')
  task()
  // Each node right on its own problem, the complete task wrong: remedy the task's nodes.
  await takeStageTest([statics, manometer])
  expect(await brief()).toContain('默认建议：先补课（完整任务涉及的知识点）')
  await run('save_stage_review', {
    markdown: '## 复盘\n\n单步都会，几步串起来就乱：先列已知量，再定顺序。',
    recommend: 'remedial',
    remedial: { title: '补课：多步串联', objective: '能把静力学和压差计两步串起来算' },
  })
  expect(h.ctx.learnCurriculum.stage(first.id)?.review?.remedial).toMatchObject({ title: '多步串联', nodeIds: [ids['静力学'], ids['压差计']] })
  await h.endpoint('curriculum', 'decideReview', { stageId: first.id, choice: 'remedial' })

  // Designing it: the review it follows, how to design it, and a complete task to prepare.
  const remedial = stageNamed('多步串联')
  let text = await brief()
  expect(text).toContain('## 补课阶段 2 的设计\n要补的知识点：静力学、压差计；上一阶段的完整任务题也没过。')
  expect(text).toContain('阶段 1 复盘里写的（学习者看过）：\n## 复盘\n\n单步都会，几步串起来就乱：先列已知量，再定顺序。\n设计补课：')
  expect(text).not.toMatch(/\| 静力学 \||## 你的决定/)
  expect(text).toMatch(/阶段 2 的阶段测试备题不够：静力学、压差计 除完整任务题外还没有没见过的测试预留题；还没有完整任务题/)
  const staticsAgain = add('静力学')
  const manometerAgain = add('压差计')
  const taskAgain = task()
  expect(await brief()).not.toMatch(/阶段 2 的阶段测试备题不够/)

  // A corrective lesson: one reply, told to mend what the review found rather than retell the section.
  await run('save_stage_design', { stageId: remedial.id, markdown: '# 补课设计\n\n换一种讲法：先列已知量再排顺序。', lessons: [{ number: '1.1', title: '多步串联' }] })
  const lesson = h.ctx.learnCurriculum.lessons(remedial.id)[0]!
  const before = h.calls.length
  const settled = textbookSettled(h.ctx, lesson.id)
  await h.endpoint('curriculum', 'confirmDesign', { stageId: remedial.id })
  expect(await settled).toBe('ready')
  const writes = h.calls.slice(before).filter(call => call.purpose === 'learning-textbook')
  expect(writes).toHaveLength(1)
  expect(writes[0]!.prompt).toContain('这是补课课时：学习者已经学过这一节')
  expect(writes[0]!.prompt).toContain('## 上一阶段的复盘')
  expect(writes[0]!.prompt).toContain('单步都会，几步串起来就乱')
  expect(writes[0]!.prompt).toContain('补课课时，按上面"补课"的要求写，不写整节。')

  // The retest: its own nodes and a complete task; 静力学 fails again, with its prerequisite shown.
  finishLessons(h.ctx.learnCurriculum.stage(remedial.id)!)
  const graded = await takeStageTest([manometerAgain])
  expect(graded.problems.map(problem => problem.id).sort()).toEqual([staticsAgain.id, manometerAgain.id, taskAgain.id].sort())
  text = await brief()
  expect(text).toMatch(/- 静力学：没过（新题没做对，[^\n]*它的先修：密度（未探测）；补课后又没过/)
  expect(text).toMatch(/- 压差计：待验证（有对有错/)
  expect(text).toContain('没有默认建议：静力学补课后又没过。')
})
