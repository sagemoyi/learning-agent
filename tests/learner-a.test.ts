// learner A (docs/learner/design.md, 验收标准 A): states that match the whole log after a restart, an empty
// table or an entry whose event was never handled; full and incremental derivation agree; answers are dated
// when handed in; a problem found wrong takes its answers with it; 待复查 follows the clock. Synthetic data;
// the grader is a fake model.
import { afterEach, expect, it, vi } from 'vitest'
import { newId, ulid, type Id, type LogEntry, type NewLogEntry, type NodeState, type Problem } from '@learning-agent/contracts'
import { createHarness, type Harness, type ModelCall } from './harness.ts'

let h: Harness | undefined
afterEach(() => {
  vi.useRealTimers()
  h?.dispose()
})

const meta = { actor: 'teacher' as const, reason: 'learner A 测试（合成）' }
/** What the fake grader does while it grades; the test sets it. */
let whileGrading: (() => void) | undefined

function reply(call: ModelCall): string {
  if (call.purpose !== 'learning-grade') throw new Error(`unexpected model call: ${call.purpose}`)
  whileGrading?.()
  return JSON.stringify({ verdict: 'correct', score: 1, rationale: '列出了关系式并算对', confidence: 'high' })
}

async function course(harness: Harness, titles: readonly string[] = ['静水压强']) {
  const created = await harness.endpoint('core', 'createCourse', { title: 'learner A（合成资料）' })
  const graph = await harness.ctx.learnKnowledge.add(created.id, { nodes: titles.map(title => ({ title, kind: 'skill' as const })) }, meta)
  return { courseId: created.id as string, nodeIds: titles.map(title => graph.nodes.find(node => node.title === title)!.id as string) }
}

function problem(harness: Harness, nodeIds: readonly string[], answer: Problem['answer'] = { kind: 'numeric', value: 20, unit: 'kPa', tolerance: { relative: 0.02 } }): Problem {
  return harness.ctx.learnAssess.addProblems([{
    stem: '（合成）水深 2 m，求底部表压强。取 g = 10 m/s²。', answer, answerSource: 'unverified', tier: 4,
    origin: { kind: 'agent' }, nodeIds: nodeIds as Id<'node'>[], pool: 'practice',
  }])[0]!
}

/** The learner hands in one problem as a practice test. */
async function answer(harness: Harness, courseId: string, item: Problem, text = '20 kPa') {
  const test = harness.ctx.learnAssess.startTest({ courseId, kind: 'practice', problemIds: [item.id] })
  await harness.endpoint('assess', 'submit', { testId: test.id, answers: [{ problemId: item.id, text: '', finals: [text] }] })
  return test
}

/** An entry written straight into the log, as if its event were lost. */
function unheard(harness: Harness, entry: NewLogEntry, at = Date.now()): LogEntry {
  const full = { at: new Date(at).toISOString(), ...entry, id: `lg_${ulid(at)}` } as LogEntry
  harness.ctx.learnCore.db.sqlite.prepare('INSERT INTO core_log (id, at, type, course_id, node_ids, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(full.id, full.at, full.type, full.courseId ?? null, JSON.stringify(full.nodeIds), JSON.stringify(full))
  return full
}

const stable = (states: NodeState[]) => states.map(({ computedAt: _, ...rest }) => rest).sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1))

it('derives the states again on start when the table is empty or an entry was never handled', async () => {
  h = createHarness(reply)
  const { courseId, nodeIds: [nodeId] } = await course(h)
  await answer(h, courseId, problem(h, [nodeId!]))
  expect(h.ctx.learnLearner.states([nodeId!])[0]!.state).toBe('independent')

  // The table emptied, then a wrong answer whose event never ran: a restart catches up with both.
  h.ctx.learnCore.db.sqlite.prepare('DELETE FROM learner_states').run()
  unheard(h, { type: 'attempt.graded', courseId: courseId as never, nodeIds: [nodeId] as never, context: {}, attemptId: newId('attempt'), problemId: newId('problem'), grading: { verdict: 'incorrect', method: 'rule', rationale: '' } })
  const root = h.root
  h.dispose(true)
  h = createHarness(reply, {}, { root })
  expect(h.ctx.learnLearner.states([nodeId!])[0]).toMatchObject({ state: 'conflict', rulesVersion: 'rules-1' })
})

it('reads a node\'s whole log, however long, and gives the same states in full as one entry at a time', async () => {
  h = createHarness(reply)
  const { courseId, nodeIds } = await course(h, ['静水压强', '表压', '密度'])
  const [statics, gauge, density] = nodeIds as [string, string, string]
  // Eleven thousand old questions, then the newest entry: a correct answer.
  const start = Date.now() - 30 * 86_400_000
  h.ctx.learnCore.db.transaction(() => {
    for (let i = 0; i < 11_000; i += 1) unheard(h!, { type: 'signal.question', courseId: courseId as never, nodeIds: [statics] as never, context: {}, text: `第 ${i} 个问题` }, start + i)
  })
  await answer(h, courseId, problem(h, [statics]))
  expect(h.ctx.learnLearner.states([statics])[0]!.state).toBe('independent')

  // Help, a regrade and a two-node answer, each handled as it is logged.
  h.ctx.learnCore.log.append({ type: 'help.given', courseId: courseId as never, nodeIds: [gauge] as never, context: {}, level: 'hint', via: 'side-chat' })
  await answer(h, courseId, problem(h, [gauge, density]), '19 kPa')
  const wrong = await answer(h, courseId, problem(h, [density]), '1 kPa')
  const attempt = h.ctx.learnAssess.view(wrong.id)!.attempts[0]!
  h.ctx.learnAssess.regrade(attempt.id, 'correct', '单位写错但数值按 kPa 算对（合成）')
  const incremental = stable(h.ctx.learnLearner.states(nodeIds))
  // 表压: a hint just before a wrong answer; 密度: a wrong two-node answer, then a regraded success.
  expect(Object.fromEntries(incremental.map(state => [state.nodeId, state.state]))).toEqual({ [statics]: 'independent', [gauge]: 'not-yet', [density]: 'independent' })
  expect(stable(h.ctx.learnLearner.recompute())).toEqual(expect.arrayContaining(incremental))
  expect(stable(h.ctx.learnLearner.states(nodeIds))).toEqual(incremental)
})

it('dates an answer when it was handed in: teaching while it is graded does not count against it', async () => {
  h = createHarness(reply)
  const { courseId, nodeIds: [nodeId] } = await course(h)
  const open = problem(h, [nodeId!], { kind: 'open', rubric: '列出 p = ρgh 并算对' })
  let explainedAt = ''
  whileGrading = () => {
    // Grading takes a while; an explanation at the very millisecond of handing in would count as before it.
    for (const until = Date.now() + 3; Date.now() < until;) { /* wait */ }
    explainedAt = h!.ctx.learnCore.log.append({ type: 'help.given', courseId: courseId as never, nodeIds: [nodeId] as never, context: {}, level: 'explanation', via: 'teacher' }).at
  }
  try {
    await answer(h, courseId, open)
  } finally {
    whileGrading = undefined
  }
  const graded = h.ctx.learnCore.log.query({ nodeId: nodeId!, types: ['attempt.graded'] })[0]!
  expect(Date.parse(graded.at)).toBeLessThan(Date.parse(explainedAt))
  expect(h.ctx.learnLearner.states([nodeId!])[0]!.state).toBe('independent')
  // The next answer is handed in after the explanation: helped.
  await answer(h, courseId, problem(h, [nodeId!]))
  expect(h.ctx.learnLearner.states([nodeId!])[0]!.explanation).toContain('有帮助答对 1 次')
})

it('drops the answers to a problem the teacher found wrong; keeping it changes nothing', async () => {
  h = createHarness(reply)
  const { courseId, nodeIds: [nodeId] } = await course(h)
  const kept = problem(h, [nodeId!]), wrong = problem(h, [nodeId!])
  await answer(h, courseId, kept, '3 kPa')
  await answer(h, courseId, wrong, '3 kPa')
  expect(h.ctx.learnLearner.states([nodeId!])[0]!.explanation).toContain('答错 2 次')
  h.ctx.learnAssess.reviewProblem(kept.id, 'keep', '题目没问题（合成）')
  h.ctx.learnAssess.reviewProblem(wrong.id, 'retired', '答案按 g = 9.81 算错了（合成）')
  const state = h.ctx.learnLearner.states([nodeId!])[0]!
  expect(state.explanation).toContain('答错 1 次')
  expect(state.explanation).toContain('有 1 次作答的题目后来核对出有错，不计')
  const records = await h.endpoint('learner', 'evidence', { nodeId })
  expect(records.find((record: { what: string }) => record.what.startsWith('老师核对了一道题：核对出有错，停用了'))).toBeTruthy()
  expect(records.filter((record: { note?: string }) => record.note?.includes('核对出有错，这次作答不计'))).toHaveLength(1)
})

it('shows 待复查 once the latest independent success is two weeks old, with nothing new in the log', async () => {
  h = createHarness(reply)
  const { courseId, nodeIds: [nodeId] } = await course(h)
  await answer(h, courseId, problem(h, [nodeId!]))
  expect(h.ctx.learnLearner.states([nodeId!])[0]!.needsReview).toBe(false)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 15 * 86_400_000)
  const later = h.ctx.learnLearner.states([nodeId!])[0]!
  expect(later.needsReview).toBe(true)
  expect(later.courses[0]!.needsReview).toBe(true)
})
