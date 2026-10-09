// assess C (docs/assess/design.md): answers saved as they are written, photo answers read twice and graded
// once the learner confirms the reading, past papers imported by number, mock exams assembled by the
// exam's question types, timed and scored by section. Synthetic papers and photos; the models are fakes.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { AnswerDraft, Handoff, NewProblem, Problem, TestView } from '@learning-agent/contracts'
import * as assessTools from '../packages/assess/src/tools.ts'
import { createHarness, type Harness, type ModelCall } from './harness.ts'

let h: Harness
let courseId = ''
let exec: unknown
const ids: Record<string, string> = {}
const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
const handoffs: Handoff[] = []
const readings: ModelCall[] = []
const teacher = { actor: 'teacher' as const, reason: '题库 C 测试（合成）' }
const fixture = (name: string) => join(import.meta.dirname, 'fixtures', name)

const run = (name: string, args: unknown) => tools.get(name)!.execute(args, exec)
const view = (testId: string) => h.endpoint<TestView>('assess', 'view', { testId })
const testIdOf = (text: string) => /测试 (ts_\w+)/.exec(text)![1]!
/** A tiny file with a JPEG signature: the fake model never looks inside. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1])

async function brief(): Promise<string> {
  const sections = await (h.ctx as unknown as { waterfall(name: string, request: unknown, last: () => Promise<{ unit: string; title: string; text: string }[]>): Promise<{ unit: string; title: string; text: string }[]> })
    .waterfall('learning/course-brief', { courseId, sessionId: 'brief' }, async () => [])
  return sections.filter(section => section.unit === 'assess').map(section => `${section.title}\n${section.text}`).join('\n')
}

function practice(value: number, unit = 'm³/h'): Problem {
  const [problem] = h.ctx.learnAssess.addProblems([{
    stem: `（合成）求体积流量，第 ${value} 题`, answer: { kind: 'numeric', value, unit, tolerance: { relative: 0.02 } },
    answerSource: 'unverified', tier: 4, origin: { kind: 'agent' }, nodeIds: [ids['流量']!] as NewProblem['nodeIds'], pool: 'practice',
  } as NewProblem])
  return problem!
}

async function photo(testId: string, problemId: string): Promise<Response> {
  return h.fetch(`/api/learning/assess.upload?testId=${testId}&problemId=${problemId}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG })
}

beforeAll(async () => {
  h = createHarness(call => {
    if (call.purpose === 'learning-handwriting') {
      readings.push(call)
      // Two readings that differ in one digit (stage 0's V9 error), the second one also in the answer box.
      return readings.length % 2 === 1
        ? JSON.stringify({ working: '$q_V = \\frac{\\pi}{4} d^2 u$，管路上有 14 只弯头', finals: ['14.1 m³/h'], doubts: ['第 1 行的 14 也可能是 1'] })
        : JSON.stringify({ working: '$q_V = \\frac{\\pi}{4} d^2 u$，管路上有 1 只弯头', finals: ['19.1 m³/h'], doubts: [] })
    }
    if (call.purpose === 'learning-grade') return JSON.stringify({ verdict: 'correct', score: 1, confidence: 'high', rationale: '和参考答案一致' })
    throw new Error(`unexpected model call: ${call.purpose}`)
  })
  courseId = (await h.endpoint('core', 'createCourse', { title: '题库 C（合成资料）' })).id
  const graph = await h.ctx.learnKnowledge.add(courseId, { nodes: ['流动类型', '流量', '静力学', '离心泵'].map(title => ({ title, kind: 'skill' as const })) }, teacher)
  for (const node of graph.nodes) ids[node.title] = node.id
  for (const [title, name] of [['合成期末试卷', 'synthetic-paper'], ['合成期中试卷', 'synthetic-paper-b']] as const) {
    await h.endpoint('library', 'import', { title, kind: 'exam', authority: '1', file: join(fixture(name), 'source.md'), parsed: [join(fixture(name), 'middle.json')], courseId, role: 'exam-archive' })
  }
  ;(h.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  assessTools.apply(h.ctx as never)
  h.ctx.on('learning/handoff', handoff => { handoffs.push(handoff) })
  exec = { agent: { session: { id: await h.ctx.learnTutor.session(courseId) } } }
})

afterAll(() => h.dispose())

it('imports past-paper questions by section number, with type, points, options and the key', async () => {
  expect(await brief()).toMatch(/往年题还没入库：《合成期末试卷》、《合成期中试卷》。用 import_exercises 按"三-2"这样的题号导入/)
  const text = await run('import_exercises', { exercises: [
    { ref: '一-1', nodes: ['流动类型'], source: '合成期末试卷' },
    { ref: '一-2', nodes: ['离心泵'], source: '合成期末试卷' },
    { ref: '一-3', nodes: ['静力学'], source: '合成期末试卷' },
    { ref: '二-1', nodes: ['流动类型'], source: '合成期末试卷' },
    { ref: '二-2', nodes: ['流动类型'], source: '合成期末试卷' },
    { ref: '三-1', nodes: ['流量'] },
    { ref: '三-2', nodes: ['静力学'], source: '合成期末试卷' },
    { ref: '四-1', nodes: ['流量'], source: '合成期末试卷' },
  ] })
  const lines = text.split('\n')
  expect(lines[0]).toMatch(/^一-1：已加入测试预留题池（pb_\w+，填空题）。答案：2$/)
  expect(lines[3]).toMatch(/^二-1：已加入测试预留题池（pb_\w+，选择题 3 分）/)
  // The same number in two papers needs the paper; a number the paper lacks lists the ones it has.
  expect(lines[5]).toBe('三-1：没有导入。三-1 在几份试卷里都有，在 source 里写是哪一份：合成期末试卷、合成期中试卷')
  expect(lines[6]).toMatch(/^三-2：已加入测试预留题池（pb_\w+，计算题 15 分）。答案：（1） 12\.36 kPa；（2） 1\.26 m$/)
  expect(lines[7]).toBe('四-1：没有导入。《合成期末试卷》里没有 四-1。这份试卷的题号：一-1~一-3、二-1~二-2、三-1~三-2')
  // The midterm prints no key: the teacher's own answer is unverified and only practises.
  const second = await run('import_exercises', { exercises: [{ ref: '三-1', nodes: ['流量'], source: '合成期末试卷' }, { ref: '三-1', nodes: ['静力学'], source: '合成期中试卷' }, { ref: '三-1', nodes: ['静力学'], source: '合成期中试卷', answer: '29.4 kPa' }] })
  expect(second.split('\n')).toEqual([
    expect.stringMatching(/^三-1：已加入测试预留题池（pb_\w+，计算题 15 分）。答案：14\.1 m³\/h$/),
    '三-1：没有导入。三-1 试卷没有附答案：在 answer 里写参考答案（标为未核对，只进练习题池），或用 calculate 算出后再加',
    expect.stringMatching(/^三-1：已加入练习题池（pb_\w+，计算题 10 分）。答案：（未核对）29\.4 kPa$/),
  ])

  const bank = h.ctx.learnAssess.problems({ pool: 'test-reserved' })
  expect(bank).toHaveLength(7)
  const choice = bank.find(problem => problem.ref === '二-1')!
  expect(choice).toMatchObject({ tier: 2, paper: '合成期末试卷', type: '选择题', points: 3, answerSource: 'book', stem: '流体在直管中流动，雷诺数 Re < 2000 时，流动类型为（ ）。', answer: { kind: 'choice', options: ['层流', '湍流', '过渡流', '无法确定'], correct: [0] } })
  expect(bank.find(problem => problem.ref === '二-2')!.answer).toMatchObject({ kind: 'choice', options: ['密度', '黏度', '压强', '体积流量'], correct: [1] })
  expect(bank.find(problem => problem.paper === '合成期末试卷' && problem.ref === '三-1')!.answer).toMatchObject({ kind: 'numeric', value: 14.1, unit: 'm^3/h' })
  // Imported once: a second import returns the bank's copy.
  expect(await run('import_exercises', { exercises: [{ ref: '二-1', nodes: ['流动类型'], source: '合成期末试卷' }] })).toMatch(/^二-1：已在测试预留题池/)
  expect(await brief()).not.toMatch(/往年题还没入库/)
  // Several problems share a number now: by number alone is ambiguous.
  await expect(run('calculate', { script: 'q = 1', check: '三-1' })).rejects.toThrow(/有 2 道题的题号都是 三-1/)
})

it('assembles a mock exam from the exam profile, timed from "开始", scored by section', async () => {
  await h.ctx.learnGoal.saveDraft(courseId, {
    purpose: '通过期末考试', scenario: '复习', canDo: ['能算出体积流量'], level: '会做题', verification: '模拟卷',
    boundaries: { defaultConditions: { book: 'closed', calculator: true, formulaSheet: false } },
    exam: {
      scope: '第一章', focus: 'balanced', conditions: { book: 'closed', calculator: true, formulaSheet: false, timeLimit: 90 },
      format: [{ type: '填空题', count: 2, points: 4 }, { type: '选择题', count: 2, points: 6 }, { type: '计算题', count: 4, points: 60 }],
    },
  }, '# 目标说明\n', teacher)
  const text = await run('start_test', { kind: 'mock', instructions: '按考试的时间做' })
  expect(text).toMatch(/共 6 题（往年题 6 道，其他 0 道）：填空题 2\/2 道（4 分），选择题 2\/2 道（6 分），计算题 2\/4 道（60 分），限时 90 分钟/)
  expect(text).toMatch(/少出了：计算题 2 道；总分按实际出的题算/)
  const testId = testIdOf(text)
  // Before "开始" the problems stay hidden and the test cannot be handed in.
  let current = await view(testId)
  expect(current.problems).toEqual([])
  expect(current.test.mock!.sections.map(section => section.problemIds.length)).toEqual([2, 2, 2])
  expect((await h.call('assess', 'submit', { testId, answers: [] })).error?.message).toMatch(/先点"开始"/)
  current = await h.endpoint<TestView>('assess', 'begin', { testId })
  expect(current.problems).toHaveLength(6)
  expect(Date.parse(current.deadline!) - Date.parse(current.test.openedAt!)).toBe(90 * 60_000)
  // Answers saved as they are written: the saved copy is what is handed in for problems the page did not send.
  const byRef = new Map(current.problems.map(problem => [`${problem.paper}${problem.ref}`, problem]))
  const choice = byRef.get('合成期末试卷二-1')!
  const flow = byRef.get('合成期末试卷三-1')!
  await h.endpoint('assess', 'draft', { testId, draft: { problemId: choice.id, text: '', finals: ['A'] } })
  await h.endpoint('assess', 'draft', { testId, draft: { problemId: flow.id, text: 'q = πd²u/4', finals: ['14.1 m³/h'] } })
  expect((await view(testId)).drafts!.map(draft => draft.finals[0])).toEqual(expect.arrayContaining(['A', '14.1 m³/h']))
  const done = await h.endpoint<TestView>('assess', 'submit', { testId, answers: [{ problemId: flow.id, text: '', finals: [] }] })
  expect(done.test.status).toBe('graded')
  const report = done.mockReport!
  expect(report.sections.map(section => [section.type, section.earned, section.points, section.short])).toEqual([['填空题', 0, 4, 0], ['选择题', 3, 6, 0], ['计算题', 15, 30, 2]])
  expect(report.total).toEqual({ points: 40, earned: 18 })
  expect(report.weak.map(node => node.title)).toEqual(expect.arrayContaining(['静力学', '离心泵']))
  expect(done.drafts).toBeUndefined()
  const rows = await h.endpoint<{ test: { id: string }; score?: { earned: number; points: number } }[]>('assess', 'tests', { courseId })
  expect(rows.find(row => row.test.id === testId)!.score).toEqual({ points: 40, earned: 18 })
  await h.settle()
  expect(handoffs.at(-1)?.text).toMatch(/交了模拟考（6 题），总分 18\/40（填空题 0\/4，选择题 3\/6，计算题 15\/30（缺 2 道））/)
  expect(await run('get_test_result', { testId })).toMatch(/^模拟考：总分 18\/40/)
})

it('reads photo answers twice, needs the reading confirmed, and grades the confirmed version', async () => {
  const problem = practice(14.1)
  const testId = testIdOf(await run('start_test', { kind: 'quiz', problemIds: [problem.id], instructions: '拍照作答' }))
  expect(await photo(testId, 'pb_not_here').then(response => response.json())).toEqual({ error: '这道题不在这份测试里' })
  expect(await h.fetch(`/api/learning/assess.upload?testId=${testId}&problemId=${problem.id}`, { method: 'POST', body: new TextEncoder().encode('%PDF-1.7') }).then(response => response.json())).toEqual({ error: '照片要是 JPG、PNG 或 WebP 图片' })
  const added = await photo(testId, problem.id).then(response => response.json()) as AnswerDraft
  expect(added.images).toHaveLength(1)
  expect(added.images[0]).toMatch(new RegExp(`^attachments/tests/${testId}/${problem.id}-\\w+\\.jpg$`))
  const served = await h.fetch(`/api/learning/assess.photo?testId=${testId}&path=${encodeURIComponent(added.images[0]!)}`)
  expect(served.headers.get('Content-Type')).toBe('image/jpeg')
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(JPEG)
  expect((await h.fetch(`/api/learning/assess.photo?testId=${testId}&path=${encodeURIComponent('attachments/../course.md')}`)).status).toBe(400)

  const read = await h.endpoint<AnswerDraft>('assess', 'transcribe', { testId, problemId: problem.id })
  // Two readings, each given the photo and the stem (never read from the photo).
  expect(readings.slice(-2).map(call => [call.images, call.prompt.includes(problem.stem)])).toEqual([[1, true], [1, true]])
  expect(read.recognition!.differences).toEqual([
    { first: '14', second: '1', before: 'd^2 u,管路上有 ', after: ' 只弯头' },
    { box: 0, first: '14.1 m³/h', second: '19.1 m³/h', before: '', after: '' },
  ])
  // The answer box takes the first reading; the reading waits for the learner.
  expect(read.finals).toEqual(['14.1 m³/h'])
  expect(read.transcription).toEqual({ text: '$q_V = \\frac{\\pi}{4} d^2 u$，管路上有 14 只弯头' })
  expect((await h.call('assess', 'submit', { testId, answers: [] })).error?.message).toBe('第 1 题的照片识别结果还没确认：核对后点"确认识别结果"再交卷')

  // The learner corrects the reading and confirms it; the confirmed version is what counts.
  const corrected = '$q_V = \\frac{\\pi}{4} d^2 u$，管路上有 14 只标准弯头'
  await h.endpoint('assess', 'draft', { testId, draft: { problemId: problem.id, text: '', finals: ['14.1 m³/h'], transcription: { text: corrected, confirmed: true } } })
  const done = await h.endpoint<TestView>('assess', 'submit', { testId, answers: [{ problemId: problem.id, text: '', finals: ['14.1 m³/h'] }] })
  const attempt = done.attempts[0]!
  expect(attempt).toMatchObject({ text: corrected, finals: ['14.1 m³/h'], images: added.images, transcription: { text: corrected, edited: true }, grading: { verdict: 'correct', method: 'rule' } })
  expect(attempt.transcription!.confirmedAt).toBeTruthy()
  // Handed in: the photo stays with the answer and can still be shown.
  expect((await h.fetch(`/api/learning/assess.photo?testId=${testId}&path=${encodeURIComponent(added.images[0]!)}`)).status).toBe(200)
  expect(await run('get_test_result', { testId })).toContain('过程（拍照作答 1 张，下面是学习者核对并改过的识别结果）：$q_V')
  await h.settle()
  expect(handoffs.at(-1)?.text).toMatch(/其中 1 道拍照作答（1 道学习者改过识别结果）/)
})

it('removes photos, refuses a model that cannot see, and hands in an unconfirmed reading for review when time is up', async () => {
  const problem = practice(28.2)
  const testId = testIdOf(await run('start_test', { kind: 'quiz', problemIds: [problem.id], minutes: 30, instructions: '限时' }))
  await h.endpoint('assess', 'begin', { testId })
  const first = await photo(testId, problem.id).then(response => response.json()) as AnswerDraft
  const folder = h.ctx.learnCore.courses.folder(courseId)
  expect(existsSync(join(folder, first.images[0]!))).toBe(true)
  const removed = await h.endpoint<AnswerDraft>('assess', 'removePhoto', { testId, problemId: problem.id, path: first.images[0] })
  expect(removed.images).toEqual([])
  expect(existsSync(join(folder, first.images[0]!))).toBe(false)
  await photo(testId, problem.id)

  // A model that says it takes no images is refused before anything is sent.
  const llm = h.ctx.llm as unknown as { resolveModelInfo?: unknown }
  llm.resolveModelInfo = async () => ({ inputModalities: ['text'] })
  const refused = await h.call('assess', 'transcribe', { testId, problemId: problem.id })
  expect(refused.error?.message).toMatch(/^模型 \S+ 不能看图（可以在 设置 › 模型 里换一个能看图的模型）$/)
  delete llm.resolveModelInfo
  await h.endpoint('assess', 'transcribe', { testId, problemId: problem.id })

  // Time ran out 3 minutes ago without the reading confirmed: handed in, that answer waits for the teacher.
  const test = h.ctx.learnAssess.view(testId)!.test
  ;(h.ctx.learnAssess as unknown as { store: { saveTest(test: unknown): void } }).store.saveTest({ ...test, openedAt: new Date(Date.now() - 33 * 60_000).toISOString() })
  const done = await h.endpoint<TestView>('assess', 'submit', { testId, answers: [] })
  expect(done.test.overtime).toBe(3)
  expect(done.attempts[0]).toMatchObject({ finals: ['14.1 m³/h'], grading: { verdict: 'pending-review', rationale: '到时间时照片的识别结果还没确认，等老师对照照片判分' } })
  expect(done.attempts[0]!.transcription!.confirmedAt).toBeUndefined()
  expect(h.ctx.learnAssess.queue(courseId).pending.map(item => item.testId)).toContain(testId)
})

it('withdraws a test nobody has answered, and closes its task', async () => {
  const problem = practice(42.3)
  const testId = testIdOf(await run('start_test', { kind: 'quiz', problemIds: [problem.id], instructions: '发错了' }))
  await h.endpoint('assess', 'draft', { testId, draft: { problemId: problem.id, text: '', finals: ['42 m³/h'] } })
  expect(await run('withdraw_test', { testId })).toBe(`已撤回小测 ${testId}，任务已关闭。把原因告诉学习者。`)
  const done = await view(testId)
  expect(done.test.status).toBe('abandoned')
  expect(h.ctx.learnCurriculum.tasks(courseId, { status: 'open' }).some(task => task.result?.id === testId)).toBe(false)
  await expect(run('withdraw_test', { testId })).rejects.toThrow('这份测试已经结束了')
  // Once the learner has answered, only the learner ends it: one answer in, a diagnostic is still open.
  const adaptive = testIdOf(await run('start_test', { kind: 'diagnostic', nodes: ['流量', '静力学'], instructions: '摸底' }))
  const first = (await view(adaptive)).problems[0]!
  const next = await h.endpoint<TestView>('assess', 'answer', { testId: adaptive, answer: { problemId: first.id, text: '', finals: [], gaveUp: true } })
  expect(next.test.status).toBe('open')
  await expect(run('withdraw_test', { testId: adaptive })).rejects.toThrow('学习者已经答了题，不能撤回')
})
