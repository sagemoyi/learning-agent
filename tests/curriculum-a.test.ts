// curriculum A (docs/curriculum/design.md): stage reviews summarised per core node by the program and
// decided by the learner, remedial stages inserted after a review, nodes carried on into the next
// stage, and roadmap changes the learner confirms once the route has started. Synthetic course;
// grading is by rule and the textbook writer is a fake model.
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Handoff, NewProblem, Problem, Stage, TestView } from '@learning-agent/contracts'
import * as assessTools from '../packages/assess/src/tools.ts'
import * as curriculumTools from '../packages/curriculum/src/tools.ts'
import { FIXTURES, createHarness, type Harness } from './harness.ts'

let h: Harness
let courseId = ''
let exec: unknown
const ids: Record<string, string> = {}
const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
const handoffs: Handoff[] = []
const teacher = { actor: 'teacher' as const, reason: '课程设计 A 测试（合成）' }
const answers = new Map<string, string>()
let next = 0

const run = (name: string, args: unknown) => tools.get(name)!.execute(args, exec)
const testIdOf = (text: string) => /测试 (ts_\w+)/.exec(text)![1]!
const stages = () => h.ctx.learnCurriculum.stages(courseId)
const stageNamed = (title: string) => stages().find(stage => stage.title === title)!
const lastHandoff = async () => { await h.settle(); return handoffs.at(-1)?.text ?? '' }
const read = async (path: string) => (await h.ctx.learnCore.files.read(courseId, path))?.text ?? ''

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

/** Publish the current stage's stage test and answer it: `right` problems with their answer, the rest wrong. */
async function takeStageTest(right: readonly Problem[]): Promise<TestView> {
  const testId = testIdOf(await run('start_test', { kind: 'stage', instructions: '阶段测试，独立完成' }))
  const open = await h.endpoint<TestView>('assess', 'view', { testId })
  return h.endpoint<TestView>('assess', 'submit', { testId, answers: open.problems.map(problem => ({ problemId: problem.id, text: '', finals: [right.some(item => item.id === problem.id) ? answers.get(problem.id)! : '1 kPa'] })) })
}

/** Lessons are tested elsewhere: mark the stage's lessons done and the stage learning. */
function finishLessons(stage: Stage): void {
  for (const lesson of h.ctx.learnCurriculum.lessons(stage.id)) h.ctx.learnCurriculum.setLessonStatus(lesson.id, 'done')
  h.ctx.learnCurriculum.setStatus(stage.id, 'learning')
}

beforeAll(async () => {
  h = createHarness(call => {
    if (call.purpose === 'learning-textbook') return '## 1.1 静水压强\n\n静水压强随深度增加。\n\n### 读完就答\n\n1. 水深加倍时压强怎样变化？'
    throw new Error(`unexpected model call: ${call.purpose}`)
  })
  courseId = (await h.endpoint('core', 'createCourse', { title: '课程设计 A（合成资料）' })).id
  await h.ctx.learnGoal.saveDraft(courseId, {
    purpose: '验证复盘流程', scenario: '合成资料', canDo: ['能算出静水压强', '能读压差计', '能列机械能衡算式'], level: '会做题', verification: '阶段测试',
    boundaries: { defaultConditions: { book: 'closed', calculator: true, formulaSheet: false } },
  }, '# 目标说明\n', teacher)
  await h.endpoint('goal', 'confirm', { courseId })
  await h.endpoint('library', 'import', {
    title: '合成验收资料', kind: 'textbook', authority: '1', courseId, role: 'skeleton',
    file: join(FIXTURES, 'synthetic-chapter', 'source.md'), parsed: [join(FIXTURES, 'synthetic-chapter', 'middle.json')],
  })
  // 密度 ← 静力学 ← { 压差计, 伯努利 }.
  const graph = await h.ctx.learnKnowledge.add(courseId, {
    nodes: ['密度', '静力学', '压差计', '伯努利'].map(title => ({ title, kind: 'skill' as const })),
    edges: [
      { from: '静力学', to: '密度', type: 'requires' },
      { from: '压差计', to: '静力学', type: 'requires' },
      { from: '伯努利', to: '静力学', type: 'requires' },
    ],
  }, teacher)
  for (const node of graph.nodes) ids[node.title] = node.id
  // A diagnostic done, so the planner reaches the roadmap.
  const probe = add('密度', { pool: 'practice' })
  const diagnostic = h.ctx.learnAssess.startTest({ courseId, kind: 'diagnostic', problemIds: [probe.id] })
  await h.endpoint('assess', 'submit', { testId: diagnostic.id, answers: [{ problemId: probe.id, text: '', finals: [answers.get(probe.id)!] }] })
  ;(h.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  assessTools.apply(h.ctx as never)
  curriculumTools.apply(h.ctx as never)
  h.ctx.on('learning/handoff', handoff => { handoffs.push(handoff) })
  exec = { agent: { session: { id: await h.ctx.learnTutor.session(courseId) } } }
})

afterAll(() => h.dispose())

it('refuses pass marks, keeps started stages, and asks the learner to confirm route changes', async () => {
  await expect(run('save_roadmap', { stages: [{ title: '静力学', objective: '习题能做对 80% 以上' }] })).rejects.toThrow(/总分过关线（"做对 80%"）/)
  expect(await run('save_roadmap', { stages: [
    { title: '静力学', objective: '算出容器中任一点的压强', supports: ['c1'] },
    { title: '流动', objective: '读压差计、列衡算式', supports: ['c2', 'c3'] },
  ] })).toMatch(/路线已保存/)
  const first = stageNamed('静力学')
  await expect(h.ctx.learnCurriculum.saveDesign(first.id, { markdown: '# 设计\n\n## 测试蓝图\n\n- 过关线：正确率 ≥ 80%', lessons: [{ number: '1.1', title: '静水压强' }] }, teacher)).rejects.toThrow(/设计书里写了总分过关线/)
  await run('save_stage_design', { stageId: first.id, markdown: '# 阶段 1 设计\n\n## 测试蓝图\n\n- 每个核心知识点都有没见过的新题', lessons: [{ number: '1.1', title: '静水压强' }], nodes: ['密度', '静力学', '压差计'] })
  // Before the first design is confirmed the route is still being formed: saved at once.
  expect(await run('save_roadmap', { stages: [{ title: '流动', objective: '读压差计、列衡算式', supports: ['c2', 'c3'] }] })).toMatch(/路线已保存/)
  await h.endpoint('curriculum', 'confirmDesign', { stageId: first.id })

  await expect(run('save_roadmap', { stages: [{ title: '流动', objective: '读压差计' }] })).rejects.toThrow(/调整要写 reason/)
  await expect(run('save_roadmap', { reason: '重排', stages: [{ title: '静力学', objective: '算压强' }, { title: '流动', objective: '读压差计' }] })).rejects.toThrow(/只写还没开始的阶段：阶段 1「静力学」已经开始或排定/)
  await expect(run('save_roadmap', { reason: '缩小范围', stages: [{ title: '流动', objective: '读压差计', supports: ['c2'] }] })).rejects.toThrow(/没有阶段对应了：c3 能列机械能衡算式。.*先和学习者修订目标/)

  const proposal = { reason: '压差计和机械能分开学，每段两三个课时', stages: [{ title: '压差计', objective: '读压差计算压差', supports: ['c2'] }, { title: '机械能', objective: '列机械能衡算式', supports: ['c3'] }] }
  expect(await run('save_roadmap', proposal)).toMatch(/等学习者在"课程进度"页确认后生效（之前保持原路线）/)
  expect(stages().map(stage => stage.title)).toEqual(['静力学', '流动'])
  expect((await h.endpoint<{ revision: { before: { title: string }[] } }>('curriculum', 'overview', { courseId })).revision.before.map(stage => stage.title)).toEqual(['流动'])
  expect(await h.ctx.learnPlanner.next(courseId)).toMatchObject({ actor: 'learner', title: '看看路线调整' })
  expect(await brief()).toContain('有一份路线调整等学习者确认（压差计和机械能分开学，每段两三个课时）。')
  await h.endpoint('curriculum', 'decideRevision', { courseId, apply: false })
  expect(stages().map(stage => stage.title)).toEqual(['静力学', '流动'])
  expect(await lastHandoff()).toMatch(/保持原来的路线/)

  await run('save_roadmap', proposal)
  await h.endpoint('curriculum', 'decideRevision', { courseId, apply: true })
  expect(stages().map(stage => [stage.index, stage.title, stage.folder])).toEqual([[1, '静力学', 'stages/01-静力学'], [2, '压差计', 'stages/02-压差计'], [3, '机械能', 'stages/03-机械能']])
  expect(await read('roadmap.md')).toContain('## 阶段 3：机械能')
  expect(await lastHandoff()).toMatch(/确认了路线调整（压差计和机械能分开学/)
  expect((await h.ctx.learnPlanner.next(courseId)).title).not.toBe('看看路线调整')
})

let staticsSpare: Problem

it('reviews a stage test per node, waits on appeals, and lets the learner choose a remedial stage', async () => {
  const density = add('密度')
  const statics = add('静力学')
  staticsSpare = add('静力学')
  const manometer = add('压差计')
  const task = add('压差计', { size: 'task', nodeIds: [ids['静力学']!, ids['压差计']!] as NewProblem['nodeIds'] })
  const first = stageNamed('静力学')
  finishLessons(first)
  const graded = await takeStageTest([density, statics])
  expect(graded.problems.map(problem => problem.id)).toEqual([density.id, statics.id, manometer.id, task.id])
  expect(h.ctx.learnCurriculum.stage(first.id)?.status).toBe('reviewing')
  expect(await h.ctx.learnPlanner.next(courseId)).toMatchObject({ actor: 'teacher', title: '阶段 1 的复盘' })

  // An appeal waits for the teacher before the review.
  const appealed = graded.attempts.find(attempt => attempt.problemId === manometer.id)!
  h.ctx.learnAssess.appeal(appealed.id, '我觉得是对的')
  let text = await brief()
  expect(text).toMatch(/- 密度：过了（新题都对，第 1 题）/)
  expect(text).toMatch(/- 静力学：待验证（有对有错，第 2、4 题）。[^\n]*后面 2 个知识点以它为先修/)
  expect(text).toMatch(/- 压差计：没过（新题没做对，第 3、4 题）/)
  expect(text).toContain('完整任务题（第 4 题）：没过')
  expect(text).toContain('先处理这些再写复盘：第 3 题有学习者的申诉：用 regrade 复核。')
  expect(text).toContain('默认建议：先补课（压差计）；待验证的 静力学 带进下一阶段。')
  await expect(run('save_stage_review', { markdown: '复盘', recommend: 'remedial', remedial: { title: '补课：压差计读数', objective: '读对压差计' } })).rejects.toThrow(/先处理这些再写复盘：第 3 题有学习者的申诉/)
  h.ctx.learnAssess.regrade(appealed.id, 'incorrect', '读数取反了，判错不变')
  expect(await brief()).not.toMatch(/先处理这些/)

  await expect(run('save_stage_review', { markdown: '复盘', recommend: 'next' })).rejects.toThrow(/默认建议是先补课；建议不同时要写 reason/)
  expect(await run('save_stage_review', {
    markdown: '## 复盘\n\n密度掌握得好。压差计的读数关系弄反了：等压面要找在同一种连续流体里。',
    recommend: 'remedial',
    remedial: { title: '补课：压差计读数', objective: '能从读数 R 正确算出两侧压差' },
  })).toMatch(/复盘已保存/)
  const review = await read(`${first.folder}/review.md`)
  expect(review).toContain('| 压差计 | 没过 |')
  expect(review).toContain('| 完整任务题 | 没过 |')
  expect(review).toContain('等压面要找在同一种连续流体里')
  expect(h.ctx.learnCurriculum.stage(first.id)?.review?.remedial?.nodeIds).toEqual([ids['压差计']])
  expect(await h.ctx.learnPlanner.next(courseId)).toMatchObject({ actor: 'learner', title: '决定阶段 1 之后怎么走' })
  expect(await brief()).toContain('复盘已保存，等学习者在"课程进度"页决定。')

  // The learner chooses on the progress page: the remedial stage goes in after it, the rest move down.
  await h.endpoint('curriculum', 'decideReview', { stageId: first.id, choice: 'remedial' })
  expect(stages().map(stage => [stage.index, stage.title, stage.kind, stage.status, stage.folder])).toEqual([
    [1, '静力学', 'normal', 'done', 'stages/01-静力学'],
    [2, '压差计读数', 'remedial', 'planned', 'stages/02-压差计读数'],
    [3, '压差计', 'normal', 'planned', 'stages/03-压差计'],
    [4, '机械能', 'normal', 'planned', 'stages/04-机械能'],
  ])
  const remedial = stageNamed('压差计读数')
  expect(remedial).toMatchObject({ remedialOf: first.id, nodeIds: [ids['压差计']] })
  expect(await read('roadmap.md')).toContain('## 阶段 2（补课）：压差计读数')
  expect(await read(`${first.folder}/review.md`)).toMatch(/## 你的决定\n\n先补课（补课阶段「压差计读数」）。/)
  expect(await lastHandoff()).toBe('学习者看了阶段 1「静力学」的复盘，决定先补课（补课阶段「压差计读数」）。')
  expect(await h.ctx.learnPlanner.next(courseId)).toMatchObject({ actor: 'teacher', title: '设计阶段 2' })
  expect(h.ctx.learnCurriculum.carried(courseId).map(item => [item.title, item.kind])).toEqual([['静力学', 'unverified']])
})

it('retests a remedial stage on its own nodes, with no default when a node fails again', async () => {
  const remedial = stageNamed('压差计读数')
  await run('save_stage_design', { stageId: remedial.id, markdown: '# 补课设计\n\n换一种讲法讲等压面。', lessons: [{ number: '1.1', title: '压差计读数' }] })
  await h.endpoint('curriculum', 'confirmDesign', { stageId: remedial.id })
  expect((await h.ctx.learnPlanner.next(courseId)).title).not.toMatch(/前测/)
  finishLessons(remedial)
  const retry = add('压差计')
  const graded = await takeStageTest([])
  // Only the remedial node, nothing from earlier stages.
  expect(graded.problems.map(problem => problem.id)).toEqual([retry.id])
  const text = await brief()
  expect(text).toMatch(/- 压差计：没过（新题没做对，第 1 题）。[^\n]*补课后又没过/)
  expect(text).toContain('没有默认建议：压差计补课后又没过。')
  await expect(run('save_stage_review', { markdown: '复盘', recommend: 'next' })).rejects.toThrow(/这次没有默认建议（补课后又没过）：写 reason/)
  await run('save_stage_review', { markdown: '先修都会，读数方法换过一次仍错，先往前走，机械能里会反复用到。', recommend: 'next', reason: '再补一次多半没用；后面的阶段会反复练读数' })
  expect(h.ctx.learnCurriculum.stage(remedial.id)?.review?.reason).toBe('再补一次多半没用；后面的阶段会反复练读数')
  await h.endpoint('curriculum', 'decideReview', { stageId: remedial.id, choice: 'next' })
  expect(await lastHandoff()).toBe('学习者看了阶段 2「压差计读数」的复盘，决定进入下一阶段（压差计没过，记为风险）。')
  expect(h.ctx.learnCurriculum.carried(courseId).map(item => [item.title, item.kind])).toEqual([['静力学', 'unverified'], ['压差计', 'risk']])
})

it('carries risks and unverified nodes into the next stage: its brief and its stage test first', async () => {
  expect(await brief()).toContain('## 以前复盘带过来的知识点\n风险（没过，学习者没补课就往前走）：压差计。待验证（有对有错或没测到）：静力学。')
  const third = stageNamed('压差计')
  await run('save_stage_design', { stageId: third.id, markdown: '# 阶段 3 设计\n\n第一课时复习压差计读数。', lessons: [{ number: '1.1', title: '压差计应用' }], nodes: ['伯努利'] })
  finishLessons(third)
  const bernoulli = add('伯努利')
  const densityAgain = add('密度')
  const manometerAgain = add('压差计')
  const graded = await takeStageTest([staticsSpare])
  // Two earlier slots: the carried nodes (静力学, 压差计) come before 密度.
  expect(graded.problems.map(problem => problem.id)).toEqual([bernoulli.id, staticsSpare.id, manometerAgain.id])
  expect(graded.problems.map(problem => problem.id)).not.toContain(densityAgain.id)
  expect(await brief()).toContain('以前复盘带过来的：静力学（待验证）这次对；压差计（风险）这次错')
  await run('save_stage_review', { markdown: '伯努利还要练。', recommend: 'next', reason: '机械能阶段会接着练伯努利' })
  await h.endpoint('curriculum', 'decideReview', { stageId: third.id, choice: 'next' })
  // 静力学 was answered right on its own after its review: verified, no longer listed.
  expect(await brief()).toContain('## 以前复盘带过来的知识点\n风险（没过，学习者没补课就往前走）：压差计、伯努利。设计阶段时')
})
