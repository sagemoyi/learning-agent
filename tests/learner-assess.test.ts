// learner A with assess as the producer: an answer is dated when it was handed in (not when grading ended), corrections
// chain the way assess writes them, and a problem that is stopped or changed voids the answers given to it.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { EvidenceRecord, Id, LogEntry, Problem } from '@learning-agent/contracts'
import { createHarness, type Harness } from './harness.ts'

let h: Harness
let courseId = ''
let node = ''
const teacher = { actor: 'teacher' as const, reason: '掌握分析 A 测试（合成）' }

beforeEach(async () => {
  h = createHarness(() => { throw new Error('learner tests must not call a model') })
  courseId = (await h.ctx.learnCore.courses.create({ title: '掌握分析 A（合成）' })).id
  node = (await h.ctx.learnKnowledge.add(courseId, { nodes: [{ title: '静压强', kind: 'knowledge' }] }, teacher)).nodes[0]!.id
})
afterEach(async () => { vi.useRealTimers(); await h.settle(); h.dispose() })

function problem(value = 20): Problem {
  return h.ctx.learnAssess.addProblems([{
    stem: `（合成）水深 ${value / 10} m，求槽底表压强。`, answer: { kind: 'numeric', value, unit: 'kPa', tolerance: { absolute: 0.1 } }, answerSource: 'unverified', tier: 4,
    origin: { kind: 'agent' }, nodeIds: [node as Id<'node'>], pool: 'practice',
  } as never])[0]!
}

async function answer(item: Problem, text: string) {
  const test = h.ctx.learnAssess.startTest({ courseId, kind: 'quiz', problemIds: [item.id] })
  await h.endpoint('assess', 'submit', { testId: test.id, answers: [{ problemId: item.id, text: '', finals: [text] }] })
  return h.ctx.learnCore.log.query({ courseId, types: ['attempt.graded'] }).at(-1)! as LogEntry & { type: 'attempt.graded' }
}

const state = () => h.ctx.learnLearner.states([node])[0]!
const log = (type: LogEntry['type']) => h.ctx.learnCore.log.query({ courseId, types: [type] })
const evidence = () => h.endpoint<EvidenceRecord[]>('learner', 'evidence', { nodeId: node })

it('dates an answer when it was handed in, so an explanation given while it was being graded is not help it had', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T08:00:00Z'))
  const item = problem()
  const slow = vi.spyOn(h.ctx.learnAssess as unknown as { grade(): Promise<unknown> }, 'grade').mockImplementation(async () => {
    // Five seconds of grading, in which the side chat explains the topic.
    vi.setSystemTime(new Date('2026-10-10T08:00:05Z'))
    h.ctx.learnCore.log.append({ type: 'help.given', courseId: courseId as never, nodeIds: [node] as never, context: {}, level: 'explanation', via: 'side-chat', at: '2026-10-10T08:00:03Z' })
    return { verdict: 'correct', method: 'rule', rationale: '' }
  })
  const entry = await answer(item, '20 kPa')
  slow.mockRestore()
  expect(entry.at).toBe('2026-10-10T08:00:00.000Z')
  expect(state().state).toBe('independent')
  const [during] = log('help.given')
  expect(state().evidence).not.toContain(during!.id)
  // The next answer comes after that explanation, so it had it.
  const second = problem(30)
  vi.setSystemTime(new Date('2026-10-10T08:01:00Z'))
  await answer(second, '30 kPa')
  expect(state().evidence).toContain(during!.id)
})

it('follows the corrections the way assess writes them, each one correcting the last', async () => {
  const item = problem()
  const first = await answer(item, '99 kPa')
  expect(state().state).toBe('not-yet')
  const attempt = h.ctx.learnCore.log.query({ courseId, types: ['attempt.graded'] })[0] as LogEntry & { type: 'attempt.graded' }
  h.ctx.learnAssess.regrade(attempt.attemptId, 'correct', '申诉成立')
  expect(state()).toMatchObject({ state: 'independent' })
  h.ctx.learnAssess.regrade(attempt.attemptId, 'incorrect', '再核对，原判是对的')
  const [original, again, last] = [first.id, ...log('attempt.regraded').map(entry => entry.id)]
  expect(state()).toMatchObject({ state: 'not-yet', evidence: [last] })
  expect(state().excluded.map(item => item.id).sort()).toEqual([original, again].sort())
  const shown = await evidence()
  expect(shown.find(record => record.id === original)).toMatchObject({ counted: false, note: '原判已被改判替代' })
  expect(shown.find(record => record.id === last)).toMatchObject({ counted: true })
})

it('voids the answers to a problem that is stopped or changed, not those to one kept, and not twice', async () => {
  const item = problem()
  await answer(item, '20 kPa')
  expect(state().state).toBe('independent')
  h.ctx.learnAssess.reviewProblem(item.id, 'keep', '核对过，没问题')
  expect(log('attempt.voided')).toHaveLength(0)
  expect(state().state).toBe('independent')

  h.ctx.learnAssess.reviewProblem(item.id, 'fixed', '答案改正', { stem: '（合成）水深 2 m，取 g=10，求槽底表压强。', answer: { kind: 'numeric', value: 20, unit: 'kPa', tolerance: { absolute: 0.1 } } })
  expect(log('attempt.voided')).toHaveLength(1)
  expect(log('attempt.voided')[0]).toMatchObject({ reason: 'problem-fixed' })
  expect(state()).toMatchObject({ state: 'untested', excluded: [{ reason: '题目核对后作废' }] })
  expect((await evidence()).find(record => record.what.startsWith('作答作废'))).toMatchObject({ counted: true })

  // An answer to the repaired problem counts again; retiring it later voids that one too, and the first only once.
  await answer(item, '20 kPa')
  expect(state().state).toBe('independent')
  h.ctx.learnAssess.reviewProblem(item.id, 'retired', '题目有误')
  h.ctx.learnAssess.reviewProblem(item.id, 'retired', '题目有误')
  expect(log('attempt.voided')).toHaveLength(2)
  expect(state().state).toBe('untested')
})
