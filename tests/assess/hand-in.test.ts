// assess, handing in (docs/assess/design.md, 作答): a test is frozen when it is handed in and graded after. Handing it in
// twice, a restart while it is being graded and slow grading change nothing; a problem corrected later still shows as
// it was answered; a withdrawn test shows no answers; the reading of a photo answer goes as the page has it.
// Synthetic problems; the grader is a fake model that answers when a test lets it.
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { NewProblem, Problem, TestView } from '@learning-agent/contracts'
import { createHarness, type Harness } from '../harness.ts'

let h: Harness
let courseId = ''
const ids: Record<string, string> = {}
/** Open answers are graded once this resolves; `hold` makes a new one that `release` resolves. */
let held: Promise<void> = Promise.resolve()
let release: () => void = () => {}
const hold = () => { held = new Promise(done => { release = done }) }

const OPEN = { kind: 'open', rubric: '说明静压随深度变化的原因' } as const
const kPa = (value: number) => ({ kind: 'numeric', value, unit: 'kPa', tolerance: { relative: 0.02 } }) as const
/** A tiny file with a JPEG signature: the fake model never looks inside. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1])

const start = (root?: string) => createHarness(async call => {
  if (call.purpose !== 'learning-grade') throw new Error(`unexpected model call: ${call.purpose}`)
  await held
  return JSON.stringify({ verdict: 'correct', score: 1, confidence: 'high', rationale: '原因说清楚了' })
}, {}, root ? { root } : {})
const view = (testId: string) => h.endpoint<TestView>('assess', 'view', { testId })
/** The evidence of one test: its gradings in the log. */
const graded = (testId: string) => h.ctx.learnCore.log.query({ courseId, types: ['attempt.graded'] }).filter(entry => entry.context.testId === testId)

function add(node: string, stem: string, answer: NewProblem['answer'] = kPa(12)): Problem {
  return h.ctx.learnAssess.addProblems([{
    stem: `（合成）${stem}`, answer, answerSource: 'unverified', tier: 4, origin: { kind: 'agent' },
    nodeIds: [ids[node]!] as NewProblem['nodeIds'], pool: 'practice',
  }])[0]!
}

const quiz = (problems: readonly Problem[], conditions?: { timeLimit: number }) => h.ctx.learnAssess.startTest({
  courseId, kind: 'quiz', problemIds: problems.map(problem => problem.id),
  ...(conditions ? { conditions: { book: 'closed', calculator: true, formulaSheet: false, ...conditions } } : {}),
})

beforeAll(async () => {
  h = start()
  courseId = (await h.endpoint('core', 'createCourse', { title: '交卷（合成资料）' })).id
  const graph = await h.ctx.learnKnowledge.add(courseId, { nodes: ['静压', '浮力', '流量'].map(title => ({ title, kind: 'skill' as const })) }, { actor: 'teacher', reason: '交卷测试（合成）' })
  for (const node of graph.nodes) ids[node.title] = node.id
})

afterAll(() => h.dispose())

it('freezes a test at the first hand-in, and grades each answer once however often it is handed in', async () => {
  const numeric = add('静压', '水深 1.2 m 处的静压')
  const open = add('静压', '静压为什么随深度增大', OPEN)
  const test = quiz([numeric, open])
  hold()
  const first = h.endpoint<TestView>('assess', 'submit', { testId: test.id, submissionId: 'tab-1', answers: [
    { problemId: numeric.id, text: '', finals: ['12 kPa'] },
    { problemId: open.id, text: '', finals: ['上面的水更多'] },
  ] })
  await h.settle()
  // Frozen before grading: the answers as handed in, shown with the problems' answers; nothing more can be changed.
  const frozen = await view(test.id)
  expect(frozen.test).toMatchObject({ status: 'submitted', submissionId: 'tab-1' })
  expect(frozen.attempts.map(attempt => [attempt.finals, attempt.version, attempt.submissionId])).toEqual([[['12 kPa'], 1, 'tab-1'], [['上面的水更多'], 1, 'tab-1']])
  expect(frozen.problems[0]!.answer).toEqual(kPa(12))
  expect((await h.call('assess', 'draft', { testId: test.id, draft: { problemId: numeric.id, text: '', finals: ['13 kPa'] } })).error?.message).toBe('这份测试已经交卷了')

  // Another tab hands it in while the first is still being graded: it waits for the same grading.
  const second = h.endpoint<TestView>('assess', 'submit', { testId: test.id, submissionId: 'tab-2', answers: [{ problemId: numeric.id, text: '', finals: ['99 kPa'] }] })
  release()
  const [one, two] = await Promise.all([first, second])
  for (const done of [one, two]) {
    expect(done.test.status).toBe('graded')
    expect(done.attempts.map(attempt => [attempt.finals, attempt.grading?.verdict])).toEqual([[['12 kPa'], 'correct'], [['上面的水更多'], 'correct']])
  }
  await h.endpoint('assess', 'submit', { testId: test.id, answers: [] })
  expect(graded(test.id)).toHaveLength(2)
})

it('grades on the next start what a stop cut off, and only that', async () => {
  const numeric = add('静压', '水深 2 m 处的静压', kPa(19.6))
  const open = add('静压', '为什么液面下同一深度静压相等', OPEN)
  const test = quiz([numeric, open])
  hold()
  void h.call('assess', 'submit', { testId: test.id, answers: [
    { problemId: numeric.id, text: '', finals: ['19.6 kPa'] },
    { problemId: open.id, text: '', finals: ['连通的同种静止液体'] },
  ] })
  await h.settle()
  // Stopped with the numeric answer graded by rule and the open one waiting for the model.
  expect(graded(test.id)).toHaveLength(1)
  const root = h.root
  h.dispose(true)
  held = Promise.resolve()
  h = start(root)
  await h.settle()
  const done = await view(test.id)
  expect(done.test.status).toBe('graded')
  expect(done.attempts.map(attempt => attempt.grading?.verdict)).toEqual(['correct', 'correct'])
  expect(graded(test.id)).toHaveLength(2)
})

it('counts time and overtime to the hand-in, however long grading takes', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const opened = Date.parse('2026-11-03T09:00:00Z')
    vi.setSystemTime(opened)
    const test = quiz([add('浮力', '说明浮力的来源', OPEN)], { timeLimit: 10 })
    await h.endpoint('assess', 'begin', { testId: test.id })
    hold()
    vi.setSystemTime(opened + 9 * 60_000)
    const handing = h.endpoint<TestView>('assess', 'submit', { testId: test.id, answers: [{ problemId: test.problemIds[0], text: '', finals: ['上下表面的压力差'] }] })
    await h.settle()
    // Handed in with a minute to spare; grading takes five minutes, past the limit.
    vi.setSystemTime(opened + 14 * 60_000)
    release()
    const done = await handing
    const handedIn = new Date(opened + 9 * 60_000).toISOString()
    expect(done.test).toMatchObject({ status: 'graded', endedAt: handedIn, gradedAt: new Date(opened + 14 * 60_000).toISOString() })
    expect(done.test.overtime).toBeUndefined()
    expect(graded(test.id).map(entry => entry.at)).toEqual([handedIn])
  } finally {
    vi.useRealTimers()
  }
})

it('shows a problem corrected after the hand-in as it was answered, and says it was corrected', async () => {
  const problem = add('浮力', '排开 2 L 水的浮力', kPa(2))
  const test = quiz([problem])
  await h.endpoint('assess', 'submit', { testId: test.id, answers: [{ problemId: problem.id, text: '', finals: ['2 kPa'] }] })
  h.ctx.learnAssess.reviewProblem(problem.id, 'fixed', '书后答案印错了', { answer: kPa(99) })
  expect(h.ctx.learnAssess.problem(problem.id)).toMatchObject({ version: 2, answer: kPa(99) })
  const before = await view(test.id)
  expect(before.problems[0]).toMatchObject({ version: 1, answer: kPa(2), revised: true })
  expect(before.attempts[0]).toMatchObject({ version: 1, finals: ['2 kPa'], grading: { verdict: 'correct' } })
  // A new test asks the corrected version and grades against it.
  const again = quiz([problem])
  const done = await h.endpoint<TestView>('assess', 'submit', { testId: again.id, answers: [{ problemId: problem.id, text: '', finals: ['99 kPa'] }] })
  expect(done.problems[0]).toMatchObject({ version: 2, answer: kPa(99) })
  expect(done.problems[0]!.revised).toBeUndefined()
  expect(done.attempts[0]).toMatchObject({ version: 2, grading: { verdict: 'correct' } })
})

it('shows no answers for a withdrawn test, and counts its problems as seen once it was opened', async () => {
  const first = add('流量', '求体积流量（甲）', kPa(1))
  add('流量', '求体积流量（乙）', kPa(2))
  const seen = () => h.ctx.learnCore.log.query({ courseId, types: ['problem.seen'] }).filter(entry => 'problemId' in entry && entry.problemId === first.id)
  const auto = () => h.ctx.learnAssess.startTest({ courseId, kind: 'quiz', nodeIds: [ids['流量']!], count: 1 })

  // Never opened: no answers, and the problem is still new.
  h.ctx.learnAssess.withdraw(quiz([first]).id)
  const unopened = auto()
  expect(unopened.problemIds).toEqual([first.id])
  const shown = h.ctx.learnAssess.withdraw(unopened.id)
  expect(shown.problems[0]!.answer).toBeUndefined()
  expect(seen()).toEqual([])

  // Opened, then withdrawn: still no answers, and the next test takes another problem.
  const opened = quiz([first])
  await h.endpoint('assess', 'begin', { testId: opened.id })
  expect((await h.endpoint<TestView>('assess', 'view', { testId: opened.id })).problems[0]!.answer).toBeUndefined()
  expect(h.ctx.learnAssess.withdraw(opened.id).problems[0]!.answer).toBeUndefined()
  expect(seen()).toHaveLength(1)
  expect(auto().problemIds).not.toContain(first.id)
})

it('hands in the reading of a photo answer as the page has it, confirmed or not', async () => {
  const problem = add('流量', '拍照作答：求体积流量', { kind: 'numeric', value: 14.1, unit: 'm³/h', tolerance: { relative: 0.02 } })
  const test = quiz([problem])
  await h.fetch(`/api/learning/assess.upload?testId=${test.id}&problemId=${problem.id}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG })
  await h.endpoint('assess', 'draft', { testId: test.id, draft: { problemId: problem.id, text: '', finals: ['14.1 m³/h'], transcription: { text: '$q_V = uA$', confirmed: true } } })
  // Saved as confirmed, but the page has it unconfirmed again: not handed in.
  const answer = (text: string, confirmed: boolean) => ({ problemId: problem.id, text: '', finals: ['14.1 m³/h'], transcription: { text, confirmed } })
  const refused = await h.call('assess', 'submit', { testId: test.id, answers: [answer('$q_V = uA$，改了一处', false)] })
  expect(refused.error?.message).toBe('第 1 题的照片识别结果还没确认：核对后点"确认识别结果"再交卷')
  expect((await view(test.id)).test.status).toBe('open')
  // Confirmed on the page as it was changed there: that reading is the one handed in.
  const done = await h.endpoint<TestView>('assess', 'submit', { testId: test.id, answers: [answer('$q_V = uA = 14.1$', true)] })
  expect(done.attempts[0]).toMatchObject({ text: '$q_V = uA = 14.1$', transcription: { text: '$q_V = uA = 14.1$' }, grading: { verdict: 'correct' } })
  expect(done.attempts[0]!.transcription!.confirmedAt).toBeTruthy()
})
