// assess B (docs/assess/design.md): diagnostics one problem at a time along the prerequisites, stage tests
// assembled by rule and reported per node, flagged problems swapped and checked, appeals and regrades,
// open answers graded point by point. Synthetic course; the grader is a fake model.
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Handoff, LogEntry, NewProblem, Problem, TestView } from '@learning-agent/contracts'
import * as assessTools from '../packages/assess/src/tools.ts'
import { createHarness, type Harness } from './harness.ts'

let h: Harness
let courseId = ''
let exec: unknown
const ids: Record<string, string> = {}
const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
const handoffs: Handoff[] = []
const teacher = { actor: 'teacher' as const, reason: '题库 B 测试（合成）' }
/** Each problem's right answer, by problem id. */
const answers = new Map<string, string>()

const run = (name: string, args: unknown) => tools.get(name)!.execute(args, exec)
const view = (testId: string) => h.endpoint<TestView>('assess', 'view', { testId })
const testIdOf = (text: string) => /测试 (ts_\w+)/.exec(text)![1]!
const nodeTitle = (problem: Pick<Problem, 'nodeIds'>) => Object.entries(ids).find(([, id]) => id === problem.nodeIds[0])![0]

async function brief(): Promise<string> {
  const sections = await (h.ctx as unknown as { waterfall(name: string, request: unknown, last: () => Promise<{ unit: string; title: string; text: string }[]>): Promise<{ unit: string; title: string; text: string }[]> })
    .waterfall('learning/course-brief', { courseId, sessionId: 'brief' }, async () => [])
  return sections.filter(section => section.unit === 'assess' || section.unit === 'curriculum').map(section => `${section.title}\n${section.text}`).join('\n')
}

function add(node: string, value: number, extra: Partial<NewProblem> = {}): Problem {
  const [problem] = h.ctx.learnAssess.addProblems([{
    stem: `（合成）${node} 第 ${answers.size + 1} 题`,
    answer: { kind: 'numeric', value, unit: 'kPa', tolerance: { relative: 0.02 } },
    answerSource: 'unverified', tier: 4, origin: { kind: 'agent' }, size: 'check',
    nodeIds: [ids[node]!] as NewProblem['nodeIds'], pool: 'practice', ...extra,
  } as NewProblem])
  answers.set(problem!.id, `${value} kPa`)
  return problem!
}

/** Answer an adaptive test as a learner who knows `known`: the right value, or "不会". Returns the nodes asked. */
async function probe(testId: string, known: readonly string[]): Promise<string[]> {
  const asked: string[] = []
  for (let guard = 0; guard < 12; guard++) {
    const current = await view(testId)
    if (current.test.status !== 'open') return asked
    expect(current.attempts.every(attempt => attempt.grading === undefined)).toBe(true)
    const problem = current.problems.find(item => !current.attempts.some(attempt => attempt.problemId === item.id))!
    const node = nodeTitle(problem)
    asked.push(node)
    const answer = known.includes(node) ? { problemId: problem.id, text: '', finals: [answers.get(problem.id)!] } : { problemId: problem.id, text: '', finals: [], gaveUp: true }
    await h.endpoint('assess', 'answer', { testId, answer })
  }
  throw new Error('the diagnostic did not end')
}

beforeAll(async () => {
  h = createHarness(call => {
    if (call.purpose !== 'learning-grade') throw new Error(`unexpected model call: ${call.purpose}`)
    if (call.prompt.includes('看不清')) return JSON.stringify({ points: [{ met: true }, { met: true }, { met: true }], confidence: 'low' })
    return JSON.stringify({ points: [{ met: true }, { met: false, note: '没写基准面' }, { met: true }], confidence: 'high' })
  })
  courseId = (await h.endpoint('core', 'createCourse', { title: '题库 B（合成资料）' })).id
  // 密度 ← 静力学 ← { 压差计, 伯努利 ← 管路 }: three layers of prerequisites.
  const graph = await h.ctx.learnKnowledge.add(courseId, {
    nodes: ['密度', '静力学', '压差计', '伯努利', '管路'].map(title => ({ title, kind: 'skill' as const })),
    edges: [
      { from: '静力学', to: '密度', type: 'requires' },
      { from: '压差计', to: '静力学', type: 'requires' },
      { from: '伯努利', to: '静力学', type: 'requires' },
      { from: '管路', to: '伯努利', type: 'requires' },
    ],
  }, teacher)
  for (const node of graph.nodes) ids[node.title] = node.id
  for (const [index, node] of ['密度', '静力学', '压差计', '伯努利', '管路'].entries()) {
    add(node, 10 + index)
    add(node, 20 + index)
  }
  ;(h.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  assessTools.apply(h.ctx as never)
  h.ctx.on('learning/handoff', handoff => { handoffs.push(handoff) })
  exec = { agent: { session: { id: await h.ctx.learnTutor.session(courseId) } } }
})

afterAll(() => h.dispose())

it('probes one problem at a time, goes up after a right answer, and infers only for planning', async () => {
  const text = await run('start_test', { kind: 'diagnostic', nodes: ['密度', '静力学', '压差计', '伯努利', '管路'], instructions: '摸底，不算成绩' })
  expect(text).toMatch(/逐题出，最多 10 题，要探的知识点 5 个/)
  const testId = testIdOf(text)
  expect((await view(testId)).problems).toHaveLength(1)
  // Knows up to 压差计: right there, so 密度 and 静力学 are inferred; 伯努利 is the boundary.
  expect(await probe(testId, ['密度', '静力学', '压差计'])).toEqual(['压差计', '伯努利'])
  const done = await view(testId)
  expect(done.test.status).toBe('graded')
  expect(Object.fromEntries(done.diagnosis!.nodes.map(node => [node.title, node.state]))).toEqual({ 密度: 'inferred', 静力学: 'inferred', 压差计: 'known', 伯努利: 'boundary', 管路: 'unprobed' })
  // Inferred is not evidence: those nodes have no state from answers.
  const states = h.ctx.learnLearner.states([ids['密度']!, ids['静力学']!, ids['压差计']!])
  expect(states.map(state => [state.nodeId, state.state])).toEqual([[ids['压差计'], 'independent']])
  await h.settle()
  expect(handoffs.at(-1)?.text).toMatch(/做完了摸底（2 题），结果：已会：压差计；边界：伯努利；推测已会：密度、静力学；未探测：管路/)
  expect(await brief()).toMatch(/摸底：已判分（已会：压差计；边界：伯努利/)
})

it('goes down after "不会", and ends early on request', async () => {
  const testId = testIdOf(await run('start_test', { kind: 'pretest', nodes: ['密度', '静力学', '压差计', '伯努利', '管路'], instructions: '前测' }))
  expect((await view(testId)).test.scope?.max).toBe(5)
  // Knows only 密度: 压差计 不会 → its prerequisites; 密度 right → between 密度 and 压差计.
  expect(await probe(testId, ['密度'])).toEqual(['压差计', '密度', '静力学'])
  expect(Object.fromEntries((await view(testId)).diagnosis!.nodes.map(node => [node.title, node.state]))).toMatchObject({ 密度: 'known', 静力学: 'boundary', 压差计: 'not-yet', 管路: 'unprobed' })
  const attempts = (await view(testId)).attempts
  expect(attempts[0]).toMatchObject({ gaveUp: true, grading: { verdict: 'incorrect', method: 'learner' } })

  const early = testIdOf(await run('start_test', { kind: 'diagnostic', nodes: ['伯努利', '管路'], instructions: '摸底' }))
  // A flagged problem in a diagnostic is not swapped: the next problem is asked instead.
  const flagged = (await view(early)).problems[0]!
  const next = await h.endpoint<TestView>('assess', 'report', { testId: early, problemId: flagged.id, reason: 'done-before' })
  expect(next.test.status).toBe('open')
  expect(next.problems.map(problem => problem.id)).not.toContain(flagged.id)
  const first = next.problems[0]!
  await h.endpoint('assess', 'answer', { testId: early, answer: { problemId: first.id, text: '', finals: [answers.get(first.id)!] } })
  const ended = await h.endpoint<TestView>('assess', 'finish', { testId: early })
  expect(ended.test.status).toBe('graded')
  expect(ended.problems).toHaveLength(1)
})

it('assembles the stage test by rule, warns of missing problems, and reports per node', async () => {
  const { stages: [one, two] } = await h.ctx.learnCurriculum.saveRoadmap(courseId, [{ title: '流体静力学', objective: '算压强' }, { title: '流体流动', objective: '算管路' }], teacher)
  await h.ctx.learnCurriculum.saveDesign(one!.id, { markdown: '# 阶段 1', lessons: [{ number: '1.1', title: '密度' }], nodeIds: [ids['密度']!] }, teacher)
  h.ctx.learnCurriculum.setStatus(one!.id, 'done')
  await h.ctx.learnCurriculum.saveDesign(two!.id, { markdown: '# 阶段 2', lessons: [{ number: '1.2', title: '静力学' }], nodeIds: [ids['静力学']!, ids['压差计']!, ids['伯努利']!] }, teacher)
  // The stage's lessons are done (their flow is tested elsewhere): it is learning.
  h.ctx.learnCurriculum.setStatus(two!.id, 'learning')
  expect(await brief()).toMatch(/阶段 2 的阶段测试备题不够：静力学、压差计、伯努利 除完整任务题外还没有没见过的测试预留题；还没有完整任务题.*在学习者确认设计书前/)

  const reserved = (node: string, value: number, extra: Partial<NewProblem> = {}) => add(node, value, { answerSource: 'authority', tier: 2, pool: 'test-reserved', size: 'standard', ...extra })
  const manometer = reserved('压差计', 31)
  reserved('压差计', 32, { ref: '9-1' })
  const task = reserved('伯努利', 33, { size: 'task', nodeIds: [ids['伯努利']!, ids['静力学']!] as NewProblem['nodeIds'] })
  const density = reserved('密度', 34)
  h.ctx.learnAssess.markHomework(courseId, '9-1', true, 'teacher')
  // The task alone does not do: each core node needs a problem of its own.
  expect(await brief()).toMatch(/备题不够：静力学、伯努利 除完整任务题外/)
  const statics = reserved('静力学', 35)
  const bernoulli = reserved('伯努利', 36)
  expect(await brief()).not.toMatch(/备题不够/)

  const text = await run('start_test', { kind: 'stage', instructions: '阶段测试，独立完成' })
  expect(text).toMatch(/共 5 题：完整任务题 1 道，核心知识点 3\/3 个有新题，前面阶段的题 1 道/)
  const testId = testIdOf(text)
  const open = await view(testId)
  // Core first, then the earlier stage, the task last; the exercise done as homework is not new.
  expect(open.problems.map(problem => problem.id)).toEqual([manometer.id, statics.id, bernoulli.id, density.id, task.id])
  expect(h.ctx.learnCurriculum.stage(two!.id)?.status).toBe('testing')

  const graded = await h.endpoint<TestView>('assess', 'submit', { testId, answers: [
    { problemId: manometer.id, text: '', finals: [answers.get(manometer.id)!] },
    { problemId: statics.id, text: '', finals: [answers.get(statics.id)!] },
    { problemId: bernoulli.id, text: '', finals: ['1 kPa'] },
    { problemId: density.id, text: '', finals: ['1 kPa'] },
    { problemId: task.id, text: '', finals: ['1 kPa'] },
  ] })
  // 静力学: its own problem right, the task wrong.
  expect(graded.stageReport!.nodes.map(node => [node.title, node.outcome])).toEqual([['静力学', 'mixed'], ['压差计', 'pass'], ['伯努利', 'fail']])
  expect(graded.stageReport!.task).toEqual({ number: 5, verdict: 'incorrect' })
  expect(graded.stageReport!.earlier).toEqual([{ nodeId: ids['密度'], title: '密度', number: 4, verdict: 'incorrect' }])
  expect(h.ctx.learnCurriculum.stage(two!.id)?.status).toBe('reviewing')
  await h.settle()
  expect(handoffs.at(-1)?.text).toMatch(/按知识点：通过：压差计；没过：伯努利；对错不一：静力学；完整任务题错/)
})

let quizId = ''

it('swaps a flagged problem while the limit allows, then skips; the teacher checks it', async () => {
  const flagged = add('静力学', 40)
  const pipe = add('管路', 42)
  quizId = testIdOf(await run('start_test', { kind: 'quiz', problemIds: [flagged.id, pipe.id], instructions: '小测' }))
  let current = await h.endpoint<TestView>('assess', 'report', { testId: quizId, problemId: flagged.id, reason: 'answer-doubtful', note: '我算出来是 39' })
  // In its place: another problem on the same node the learner has not met.
  const spare = current.problems[0]!
  expect(spare.id).not.toBe(flagged.id)
  expect(spare.nodeIds[0]).toBe(ids['静力学'])
  expect(current.problems[1]!.id).toBe(pipe.id)
  expect(h.ctx.learnAssess.problem(flagged.id)).toMatchObject({ status: 'under-review', review: { reason: '学习者报告"答案存疑"：我算出来是 39' } })
  // The quiz may swap once: the next flag skips the problem.
  current = await h.endpoint<TestView>('assess', 'report', { testId: quizId, problemId: spare.id, reason: 'done-before' })
  expect(current.problems.map(problem => problem.id)).toEqual([pipe.id])
  expect(current.reports.map(report => [report.reason, Boolean(report.replacedBy)])).toEqual([['answer-doubtful', true], ['done-before', false]])
  expect(h.ctx.learnAssess.problem(spare.id)?.status).toBe('active')
  const logged = h.ctx.learnCore.log.query({ courseId, types: ['problem.reported', 'problem.seen'], limit: 100 }) as LogEntry[]
  expect(logged.filter(entry => entry.type === 'problem.seen' && entry.problemId === spare.id).map(entry => (entry as { way: string }).way)).toEqual(['homework'])
  expect(await brief()).toMatch(/学习者报告[^\n]*"答案存疑"：我算出来是 39。核对原书或用 calculate 验算后，用 review_problem 处理/)

  expect(await run('review_problem', { problem: flagged.id, action: 'keep', note: '按原书核对，答案 40 kPa 没错：换算时多乘了一次 g' })).toMatch(/已恢复使用/)
  expect(h.ctx.learnAssess.problem(flagged.id)?.status).toBe('active')
  expect((await view(quizId)).reports[0]!.outcome).toMatchObject({ action: 'keep', note: '按原书核对，答案 40 kPa 没错：换算时多乘了一次 g' })
  expect(await brief()).not.toMatch(/review_problem 处理/)
})

it('appeals go to the teacher; a regrade is appended and mastery follows it', async () => {
  const graded = await h.endpoint<TestView>('assess', 'submit', { testId: quizId, answers: [{ problemId: (await view(quizId)).problems[0]!.id, text: '', finals: ['4.2 MPa'] }] })
  const attempt = graded.attempts[0]!
  expect(attempt.grading?.verdict).toBe('incorrect')
  expect(h.ctx.learnLearner.states([ids['管路']!])[0]?.state).toBe('not-yet')

  await h.endpoint('assess', 'appeal', { attemptId: attempt.id, text: '题目里的数我抄错了一位，方法是对的' })
  await h.settle()
  expect(handoffs.at(-1)?.text).toMatch(/学习者对小测第 1 题的判分提出申诉："题目里的数我抄错了一位，方法是对的"。原判：错/)
  expect(await brief()).toMatch(/申诉："题目里的数我抄错了一位，方法是对的"。用 regrade 改判或维持/)

  expect(await run('regrade', { testId: quizId, number: 1, verdict: 'correct', reason: '步骤和单位都对，只是代入时抄错一位，按会了这个方法算' })).toMatch(/改判为对/)
  const after = await view(quizId)
  expect(after.attempts[0]!.grading).toMatchObject({ verdict: 'correct', method: 'teacher' })
  expect(after.appeals[0]!.outcome).toMatchObject({ verdict: 'correct', changed: true })
  const entries = h.ctx.learnCore.log.query({ courseId, types: ['attempt.graded', 'attempt.regraded'], limit: 200 }).filter(entry => 'attemptId' in entry && entry.attemptId === attempt.id)
  expect(entries.map(entry => entry.type).sort()).toEqual(['attempt.graded', 'attempt.regraded'])
  expect(h.ctx.learnLearner.states([ids['管路']!])[0]?.state).toBe('independent')
  // The same verdict again keeps it: no new entry.
  expect(await run('regrade', { testId: quizId, number: 1, verdict: 'correct', reason: '维持' })).toMatch(/维持对/)
  expect(h.ctx.learnCore.log.query({ courseId, types: ['attempt.regraded'], limit: 200 })).toHaveLength(1)
  await expect(h.endpoint('assess', 'appeal', { attemptId: attempt.id, text: '再申诉一次' })).rejects.toThrow(/已经申诉过了/)
})

it('grades an open answer point by point, and lists low-confidence gradings for review', async () => {
  const [open, unclear] = h.ctx.learnAssess.addProblems(['看得清', '看不清'].map(stem => ({
    stem: `（合成）${stem}：用伯努利方程求出口流速。`,
    answer: { kind: 'open', rubric: '1. 列出两截面的伯努利方程\n2. 选对基准面\n3. 代入数值求出流速' },
    answerSource: 'unverified', tier: 4, origin: { kind: 'agent' }, nodeIds: [ids['伯努利']!], pool: 'practice',
  }) as NewProblem))
  const testId = testIdOf(await run('start_test', { kind: 'practice', problemIds: [open!.id, unclear!.id], instructions: '练习' }))
  const graded = await h.endpoint<TestView>('assess', 'submit', { testId, answers: [open!, unclear!].map(problem => ({ problemId: problem.id, text: '', finals: ['列了方程，代入得 u = 3 m/s'] })) })
  expect(graded.attempts[0]!.grading).toMatchObject({ verdict: 'partial', method: 'llm' })
  expect(graded.attempts[0]!.grading!.score).toBeCloseTo(2 / 3)
  expect(graded.attempts[0]!.grading!.rationale).toMatch(/要点做到 2\/3。\n做到：列出两截面的伯努利方程；代入数值求出流速\n没做到：选对基准面（没写基准面）/)
  expect(h.calls.at(-1)!.prompt).toMatch(/评分要点：\n1\. 列出两截面的伯努利方程\n2\. 选对基准面/)
  expect(graded.attempts[1]!.grading?.verdict).toBe('pending-review')
  expect(await brief()).toMatch(new RegExp(`测试 ${testId} 第 2 题（${unclear!.id}）判分待复核，用 regrade 改判`))
})

it('computes every part of a complete task from one calculation', async () => {
  const text = await run('add_problems', { problems: [{
    stem: '（合成）油品 0.8 m³ 重 640 kg。（1）求密度；（2）油深 2.5 m，求底部表压强。取 g = 10 m/s²。',
    answerKind: 'numeric', tier: 4, size: 'task', nodes: ['密度', '静力学'], pool: 'practice',
    calculation: 'rho = 640 kg / (0.8 m^3)\np = rho * 10 m/s^2 * 2.5 m',
    parts: [{ label: '（1）', result: 'rho', unit: 'kg/m^3' }, { label: '（2）', result: 'p', unit: 'kPa' }],
  }] })
  expect(text).toMatch(/答案：（1） 800 kg\/m³；（2） 20 kPa/)
  const task = h.ctx.learnAssess.problems({ nodeIds: [ids['密度']!] }).find(problem => problem.size === 'task')!
  expect(task).toMatchObject({ answerSource: 'calculated', calculation: { results: ['rho', 'p'] } })
  await expect(run('add_problems', { problems: [{ stem: '一问', answerKind: 'numeric', tier: 4, nodes: ['密度'], pool: 'practice', calculation: 'x = 1 m', parts: [{ label: '（1）', result: 'x', unit: 'm' }] }] }))
    .rejects.toThrow(/parts 用于分两问以上的数值题/)
})
