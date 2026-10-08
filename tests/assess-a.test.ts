// assess A (docs/assess/design.md): textbook exercises imported by number from the parsed source, one
// problem per exercise in one pool, the restricted calculator checking answers, homework marks, and
// grading from the answer boxes with units. Synthetic textbook; no model calls.
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { BankOverview, Problem, TestView } from '@learning-agent/contracts'
import * as assessTools from '../packages/assess/src/tools.ts'
import { FIXTURES, createHarness, type Harness } from './harness.ts'

let h: Harness
let courseId = ''
let exec: unknown
let pressure = ''
let manometer = ''
const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
const teacher = { actor: 'teacher' as const, reason: '题库 A 测试（合成）' }

const run = (name: string, args: unknown) => tools.get(name)!.execute(args, exec)
const byRef = (ref: string): Problem => h.ctx.learnAssess.problems({ includeReview: true }).find(problem => problem.ref === ref)!

async function brief(): Promise<string> {
  const sections = await (h.ctx as unknown as { waterfall(name: string, request: unknown, last: () => Promise<{ unit: string; title: string; text: string }[]>): Promise<{ unit: string; title: string; text: string }[]> })
    .waterfall('learning/course-brief', { courseId, sessionId: 'brief' }, async () => [])
  return sections.filter(section => section.unit === 'assess').map(section => section.text).join('\n')
}

beforeAll(async () => {
  h = createHarness(call => { throw new Error(`unexpected model call: ${call.purpose}`) })
  courseId = (await h.endpoint('core', 'createCourse', { title: '题库 A（合成资料）' })).id
  const fixture = join(FIXTURES, 'synthetic-exercises')
  await h.endpoint('library', 'import', { title: '合成习题', kind: 'textbook', authority: '1', file: join(fixture, 'source.md'), parsed: [join(fixture, 'middle.json')], courseId, role: 'skeleton' })
  const graph = await h.ctx.learnKnowledge.add(courseId, { nodes: [{ title: '静水压强计算', kind: 'skill' }, { title: 'U 形压差计', kind: 'skill' }] }, teacher)
  pressure = graph.nodes.find(node => node.title === '静水压强计算')!.id
  manometer = graph.nodes.find(node => node.title === 'U 形压差计')!.id
  ;(h.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  assessTools.apply(h.ctx as never)
  exec = { agent: { session: { id: await h.ctx.learnTutor.session(courseId) } } }
})

afterAll(() => h.dispose())

it('imports exercises by number with the printed stem, figures and answer, once', async () => {
  const text = await run('import_exercises', { exercises: [
    { ref: '1-1', nodes: ['静水压强计算'] },
    { ref: '1-2', nodes: ['U 形压差计'], pool: 'practice' },
    { ref: '1-3', nodes: ['U 形压差计'] },
    { ref: '1-4', nodes: ['静水压强计算'] },
    { ref: '1-5', nodes: ['静水压强计算'] },
    { ref: '1-8', nodes: ['静水压强计算'], answer: '不一定：只有静止、连通的同一种流体中，等压面才是水平面' },
    { ref: '9-9', nodes: ['静水压强计算'] },
  ] })
  expect(text).toMatch(/^1-1：已加入测试预留题池（pb_\w+）。答案：10 kPa$/m)
  expect(text).toMatch(/^1-2：已加入练习题池（pb_\w+，附图 1 张）。答案：（1） 19\.6 kPa；（2） 2 m$/m)
  expect(text).toMatch(/^1-4：没有导入。1-4 书后没有答案/m)
  expect(text).toMatch(/^9-9：没有导入。本课资料的习题里没有 9-9$/m)

  const one = byRef('1-1')
  expect(one).toMatchObject({ stem: '（合成）敞口水槽中水深 1 m，取 g = 10 m/s²，求槽底的表压强。', answerSource: 'book', tier: 1, size: 'standard', answer: { kind: 'numeric', value: 10, unit: 'kPa' } })
  expect(one.origin).toMatchObject({ kind: 'chunk' })
  expect(byRef('1-2').answer).toMatchObject({ kind: 'parts', parts: [{ label: '（1）', answer: { kind: 'numeric', value: 19.6, unit: 'kPa' } }, { label: '（2）', answer: { kind: 'numeric', value: 2, unit: 'm' } }] })
  expect(byRef('1-2').figures).toHaveLength(1)
  expect(byRef('1-3').answer).toEqual({ kind: 'open', rubric: '参考答案：左侧液面高 0.20 m' })
  expect(byRef('1-5').stem).toBe('（合成）喷嘴出口水流速 15 m/s，直径 20 mm，向上喷射，\n\n忽略阻力，求高出出口 5 m 处的水流直径。')
  // A review question with the teacher's own answer: unverified, so it only practises; short by default.
  expect(byRef('1-8')).toMatchObject({ answerSource: 'unverified', pool: 'practice', size: 'check' })

  const before = h.ctx.learnAssess.problems({ includeReview: true }).length
  expect(await run('import_exercises', { exercises: [{ ref: '1-1', nodes: ['静水压强计算'] }] })).toMatch(/^1-1：已在测试预留题池/)
  expect(h.ctx.learnAssess.problems({ includeReview: true })).toHaveLength(before)
  // The same exercise cannot come in again by its chunk either.
  await expect(run('add_problems', { problems: [{ stem: '抄一遍', answerKind: 'numeric', value: 10, unit: 'kPa', tier: 2, answerSource: 'authority', chunkId: byRef('1-1').origin.kind === 'chunk' ? (byRef('1-1').origin as { chunkId: string }).chunkId : '', nodes: ['静水压强计算'], pool: 'practice' }] }))
    .rejects.toThrow(/已经在题库里/)
})

it('splits each node between the pools and keeps unverified answers out of tests', async () => {
  await run('import_exercises', { exercises: [{ ref: '1-6', nodes: ['静水压强计算'] }, { ref: '1-7', nodes: ['静水压强计算'] }] })
  const mine = h.ctx.learnAssess.problems({ nodeIds: [pressure] }).filter(problem => problem.size !== 'check')
  // 1-1 reserved, 1-5 and 1-6 practise, 1-7 reserved: about a third, at least one.
  expect(mine.map(problem => [problem.ref, problem.pool])).toEqual([['1-1', 'test-reserved'], ['1-5', 'practice'], ['1-6', 'practice'], ['1-7', 'test-reserved']])
  expect(h.ctx.learnAssess.problems({ nodeIds: [manometer], pool: 'test-reserved' }).map(problem => problem.ref)).toEqual(['1-3'])
  expect(() => h.ctx.learnAssess.addProblems([{ stem: '自己解的', answer: { kind: 'numeric', value: 1, unit: '', tolerance: { relative: 0.02 } }, answerSource: 'unverified', tier: 2, origin: { kind: 'agent' }, nodeIds: [pressure as never], pool: 'test-reserved' }]))
    .toThrow(/答案没有依据/)
})

it('adapts problems only with a calculation, and checks answers with the calculator', async () => {
  const adapted = (extra: Record<string, unknown>) => ({ stem: '（改编）水深 3 m，求表压强。', answerKind: 'numeric', unit: 'kPa', tier: 3, adaptedFrom: '1-1', nodes: ['静水压强计算'], pool: 'test-reserved', ...extra })
  await expect(run('add_problems', { problems: [adapted({ value: 30 })] })).rejects.toThrow(/要写 calculation/)
  await expect(run('add_problems', { problems: [adapted({ value: 35, calculation: 'rho = 1000 kg/m^3\ng = 10 m/s^2\nh = 3 m\np = rho*g*h' })] })).rejects.toThrow(/算出 30 kPa，差 16\.7%/)
  expect(await run('add_problems', { problems: [adapted({ calculation: 'rho = 1000 kg/m^3\ng = 10 m/s^2\nh = 3 m\np = rho*g*h' })] })).toMatch(/测试预留题池/)
  const made = h.ctx.learnAssess.problems({}).find(problem => problem.tier === 3)!
  expect(made).toMatchObject({ answerSource: 'calculated', answer: { value: 30 }, adaptedFrom: byRef('1-1').id })
  expect(made.origin).toMatchObject({ kind: 'chunk', label: expect.stringMatching(/^改编自习题 1-1，/) })

  expect(await run('calculate', { script: 'x = 2 m * 3 m' })).toBe('x = 2 m * 3 m → 6 m^2')
  expect(await run('calculate', { script: 'p = 1000 kg/m^3 * 10 m/s^2 * 1 m', results: ['p'], check: '1-1' })).toMatch(/^习题 1-1：验算一致/)
  expect(await run('calculate', { script: 'p = 1000 kg/m^3 * 10 m/s^2 * 1.2 m', results: ['p'], check: '1-6' })).toMatch(/答案存疑/)
  expect(byRef('1-6')).toMatchObject({ status: 'under-review', review: { reason: expect.stringMatching(/算出 12/) } })
  expect(() => h.ctx.learnAssess.startTest({ courseId, kind: 'quiz', problemIds: [byRef('1-6').id] })).toThrow(/答案存疑，暂停使用/)
  expect(await brief()).toMatch(/暂停使用、待核对：1-6/)
  const bank = await h.endpoint<BankOverview>('assess', 'bank', { courseId, nodeIds: [pressure, manometer] })
  expect(bank.doubtful).toEqual([{ problemId: byRef('1-6').id, ref: '1-6', pool: 'practice', reason: expect.any(String) }])
  expect(bank.nodes.find(node => node.nodeId === pressure)).toMatchObject({ doubtful: 1 })
  // The book was right after all: a corrected calculation restores it.
  expect(await run('calculate', { script: 'p = 1000 kg/m^3 * 10 m/s^2 * 6 m', results: ['p'], check: '1-6' })).toMatch(/验算一致/)
  expect(byRef('1-6').status).toBe('active')
})

it('takes homework marks as seen, and tells the teacher about reserved ones', async () => {
  await expect(h.endpoint('assess', 'markHomework', { courseId, refs: '1-1~1-3, 第五题', done: true })).rejects.toThrow(/看不懂这些题号：第五题/)
  await h.endpoint('assess', 'markHomework', { courseId, refs: '1-5～1-7', done: true })
  await h.settle()
  expect(h.delivered.at(-1)?.text).toMatch(/学习者标了作业做过的习题：1-5～1-7（共 3 道）.*其中 1-7 在测试预留题池里，阶段测试要另备新题/)
  const quiz = h.ctx.learnAssess.startTest({ courseId, kind: 'quiz', nodeIds: [pressure], count: 1 })
  expect(quiz.problemIds).not.toContain(byRef('1-5').id)
  expect(await brief()).toMatch(/作业做过（不算新题）：1-5、1-6、1-7/)
  await h.endpoint('assess', 'markHomework', { courseId, refs: '1-6', done: false })
  expect((await h.endpoint<BankOverview>('assess', 'bank', { courseId, nodeIds: [pressure] })).homework.map(mark => mark.ref)).toEqual(['1-5', '1-7'])
  // What the learner says in the chat, the teacher records; its own action is not handed back to it.
  const notices = h.delivered.length
  expect(await run('mark_homework', { refs: '1-1' })).toBe('已记下作业做过：1-1。其中 1-1 在测试预留题池里，已不算新题，阶段测试要另备新题。')
  await h.settle()
  expect(h.delivered).toHaveLength(notices)
  expect(await run('mark_homework', { refs: '1-1', undo: true })).toBe('已取消：1-1。')
})

it('grades from the answer boxes, converting units part by part', async () => {
  const test = h.ctx.learnAssess.startTest({ courseId, kind: 'quiz', problemIds: [byRef('1-2').id, byRef('1-5').id] })
  const open = await h.endpoint<TestView>('assess', 'view', { testId: test.id })
  expect(open.problems[0]).toMatchObject({ inputs: [{ label: '（1）', kind: 'numeric' }, { label: '（2）', kind: 'numeric' }] })
  expect(open.problems[0]!.answer).toBeUndefined()
  const graded = await h.endpoint<TestView>('assess', 'submit', { testId: test.id, answers: [
    { problemId: byRef('1-2').id, text: 'p = ρgh = 1000 × 9.8 × 2', finals: ['19600 Pa', '2.0'] },
    { problemId: byRef('1-5').id, text: '先算 u2 = 11.3 m/s，再由连续性方程 d2 = 20 mm × (15/11.3)^0.5', finals: ['23.1 mm'] },
  ] })
  const [first, second] = graded.attempts
  expect(first!.finals).toEqual(['19600 Pa', '2.0'])
  expect(first!.grading).toMatchObject({ verdict: 'partial', score: 0.75, parts: [{ label: '（1）', verdict: 'correct' }, { label: '（2）', verdict: 'partial' }] })
  expect(first!.grading!.rationale).toMatch(/没写单位/)
  expect(second!.grading).toMatchObject({ verdict: 'correct', method: 'rule' })
  expect(second!.grading!.rationale).toMatch(/换算为 0\.0231 m/)
})
