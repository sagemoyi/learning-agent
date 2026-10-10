// learner C (docs/learner/design.md, 验收标准 C): each answer says how it counts, "计入当前状态" follows the
// course on screen, the state says what is still missing, and "考我一下" publishes one problem the learner has
// not met. Synthetic data; no model is called.
import { afterEach, expect, it } from 'vitest'
import type { EvidenceRecord, Id, Problem, Task, Test } from '@learning-agent/contracts'
import { createHarness, type Harness } from './harness.ts'

let h: Harness | undefined
afterEach(() => h?.dispose())

const meta = { actor: 'teacher' as const, reason: 'learner C 测试（合成）' }
const reply = () => { throw new Error('no model call expected') }

async function setup(harness: Harness, title: string) {
  const course = await harness.endpoint('core', 'createCourse', { title })
  const graph = await harness.ctx.learnKnowledge.add(course.id, { nodes: [{ title: '静水压强', kind: 'skill' }, { title: '表压', kind: 'skill' }] }, meta)
  const [statics, gauge] = ['静水压强', '表压'].map(name => graph.nodes.find(node => node.title === name)!.id as string)
  const problems = (nodeIds: string[], count: number): Problem[] => harness.ctx.learnAssess.addProblems(Array.from({ length: count }, (_, i) => ({
    stem: `（合成）${nodeIds.length > 1 ? '综合' : ''}第 ${i + 1} 题：水深 ${i + 2} m，求底部表压强。取 g = 10 m/s²。`,
    answer: { kind: 'numeric' as const, value: (i + 2) * 10, unit: 'kPa', tolerance: { relative: 0.02 } },
    answerSource: 'unverified' as const, tier: 4 as const, origin: { kind: 'agent' as const }, nodeIds: nodeIds as Id<'node'>[], pool: 'practice' as const,
  })))
  return { courseId: course.id as string, statics: statics!, gauge: gauge!, problems }
}

/** The right answer to a problem made by `setup`. */
function right(harness: Harness, problemId: string): string {
  const answer = harness.ctx.learnAssess.problem(problemId)!.answer
  return answer.kind === 'numeric' ? `${answer.value} kPa` : ''
}

async function hand(harness: Harness, test: Test, finals: readonly string[]) {
  return harness.endpoint('assess', 'submit', { testId: test.id, answers: test.problemIds.map((problemId, i) => ({ problemId, text: '', finals: [finals[i]!] })) })
}

it('says how each answer counts, and what the state still needs', async () => {
  h = createHarness(reply)
  const { courseId, statics, problems } = await setup(h, 'learner C 说明（合成资料）')
  const [first, second] = problems([statics], 2)
  await hand(h, h.ctx.learnAssess.startTest({ courseId, kind: 'practice', problemIds: [first!.id] }), ['1 kPa'])
  const wrong = h.ctx.learnAssess.view(h.ctx.learnAssess.tests(courseId).at(-1)!.id)!.attempts[0]!
  h.ctx.learnAssess.regrade(wrong.id, 'correct', '数值按题意其实对（合成）')
  h.ctx.learnCore.log.append({ type: 'help.given', courseId: courseId as never, nodeIds: [statics] as never, context: {}, level: 'hint', via: 'teacher' })
  await hand(h, h.ctx.learnAssess.startTest({ courseId, kind: 'practice', problemIds: [second!.id] }), ['30 kPa'])

  const records = await h.endpoint<EvidenceRecord[]>('learner', 'evidence', { nodeId: statics, courseId })
  const answers = records.filter(record => record.what.endsWith('作答'))
  expect(answers).toHaveLength(2)
  // Newest first: the helped one, then the regraded one shown with the grading that stands.
  expect(answers[0]).toMatchObject({ result: '答对', counted: false })
  expect(answers[0]!.note).toMatch(/^答题前 1 小时内得到过主老师关于这个知识点的提示，算有帮助/)
  expect(answers[1]).toMatchObject({ result: '答对', counted: true })
  expect(answers[1]!.note).toBe('原判答错，复核后改判：数值按题意其实对（合成）')
  expect(records.some(record => record.what === '更正判分')).toBe(false)

  const state = h.ctx.learnLearner.states([statics])[0]!
  expect(state.state).toBe('independent')
  expect(state.explanation).toMatch(/^独立答对过（独立答对 1 次，有帮助答对 1 次，最近一次 \d+月\d+日）。$/)
  expect(state.next).toMatch(/以后独立做对一道没做过的题，就算延迟验证。$/)
  expect(state.checkFrom).toBeTruthy()
})

it('marks what counts for the course on screen', async () => {
  h = createHarness(reply)
  const a = await setup(h, '甲课（合成资料）')
  const b = await h.endpoint('core', 'createCourse', { title: '乙课（合成资料）' })
  await h.ctx.learnKnowledge.add(b.id, { nodes: [{ title: '静水压强', kind: 'skill', reuseId: a.statics }] }, { actor: 'user', reason: '学习者复用（合成）' })
  const [inA, inB] = a.problems([a.statics], 2)
  await hand(h, h.ctx.learnAssess.startTest({ courseId: a.courseId, kind: 'practice', problemIds: [inA!.id] }), ['20 kPa'])
  await hand(h, h.ctx.learnAssess.startTest({ courseId: b.id, kind: 'practice', problemIds: [inB!.id] }), ['1 kPa'])
  const counted = async (courseId: string) => (await h!.endpoint<EvidenceRecord[]>('learner', 'evidence', { nodeId: a.statics, courseId })).filter(record => record.counted).map(record => record.courseId)
  expect(await counted(a.courseId)).toEqual([a.courseId])
  expect(await counted(b.id)).toEqual([b.id])
})

it('考我一下 publishes one problem the learner has not met, once, and says when there is none', async () => {
  h = createHarness(reply)
  const { courseId, statics, gauge, problems } = await setup(h, 'learner C 考我一下（合成资料）')
  const [mixed] = problems([statics, gauge], 1)
  const [single, other] = problems([statics], 2)
  const check = await h.endpoint<Test>('assess', 'check', { courseId, nodeId: statics })
  // A problem on this point alone comes before one that also asks about another.
  expect(check).toMatchObject({ kind: 'review', status: 'open', problemIds: [expect.stringMatching(new RegExp(`^(${single!.id}|${other!.id})$`))] })
  const first = check.problemIds[0]!
  expect((await h.endpoint<Test>('assess', 'check', { courseId, nodeId: statics })).id).toBe(check.id)
  const task = h.ctx.learnCurriculum.tasks(courseId, { status: 'open' }).find(item => item.result?.id === check.id) as Task
  expect(task).toMatchObject({ kind: 'review', createdBy: 'user', title: '考我一下 · 静水压强（1 题）' })

  await hand(h, check, [right(h, first)])
  expect(h.ctx.learnLearner.states([statics])[0]!.state).toBe('independent')
  const next = await h.endpoint<Test>('assess', 'check', { courseId, nodeId: statics })
  expect(next.problemIds).toEqual([first === single!.id ? other!.id : single!.id])
  await hand(h, next, [right(h, next.problemIds[0]!)])
  const last = await h.endpoint<Test>('assess', 'check', { courseId, nodeId: statics })
  expect(last).toMatchObject({ problemIds: [mixed!.id], check: { nodeId: statics } })
  // Not now: the check ends without an answer, its task closes, and its problem is no longer new.
  const dropped = await h.endpoint('assess', 'dropCheck', { testId: last.id })
  expect(dropped.test.status).toBe('abandoned')
  expect(h.ctx.learnCurriculum.tasks(courseId, { status: 'open' }).some(item => item.result?.id === last.id)).toBe(false)
  expect(h.ctx.learnCore.log.query({ courseId, types: ['problem.seen'] }).map(entry => (entry as { problemId: string }).problemId)).toContain(mixed!.id)
  expect(h.ctx.learnLearner.states([gauge])[0]?.state ?? 'untested').toBe('untested')
  // A test the teacher published is not the learner's to drop.
  const quiz = h.ctx.learnAssess.startTest({ courseId, kind: 'quiz', nodeIds: [gauge] })
  expect((await h.call('assess', 'dropCheck', { testId: quiz.id })).error?.code).toBe('learning/assess/not-a-check')
  const none = await h.call('assess', 'check', { courseId, nodeId: statics })
  expect(none.error).toMatchObject({ code: 'learning/assess/no-fresh-problem', message: expect.stringContaining('「静水压强」没有你还没做过的练习题') })
  expect((await h.call('assess', 'check', { courseId, nodeId: 'kn_nonexistent' })).error?.code).toBe('learning/assess/not-in-course')
})
