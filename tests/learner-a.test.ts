// learner A, evidence that is complete, valid and replayable: the whole log is read, the cache is made good from
// the log after a restart, a lost event or a failure, and a failed recompute is reported. Synthetic data, no model.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { newId, ulid, type LearnerStatus, type LogEntry, type NodeState } from '@learning-agent/contracts'
import { createHarness, type Harness } from './harness.ts'

let h: Harness
beforeEach(() => { h = createHarness(() => { throw new Error('learner tests must not call a model') }) })
afterEach(async () => { await h.settle(); h.dispose() })

const teacher = { actor: 'teacher' as const, reason: '掌握分析 A 测试（合成）' }

async function course() {
  const created = await h.ctx.learnCore.courses.create({ title: '掌握分析 A（合成）' })
  const graph = await h.ctx.learnKnowledge.add(created.id, { nodes: [{ title: '静压强', kind: 'knowledge' }, { title: '表压', kind: 'knowledge' }] }, teacher)
  const id = (title: string) => graph.nodes.find(node => node.title === title)!.id as string
  return { courseId: created.id, a: id('静压强'), b: id('表压') }
}

function graded(courseId: string, nodeIds: string[], verdict: 'correct' | 'incorrect', at?: string) {
  return h.ctx.learnCore.log.append({
    type: 'attempt.graded', courseId: courseId as never, nodeIds: nodeIds as never, context: {}, attemptId: newId('attempt'), problemId: newId('problem'),
    grading: { verdict, method: 'rule', rationale: '' }, ...(at ? { at } : {}),
  })
}

/** Write a log row the way core does but without the event, as an event that never arrived leaves it. */
function writeQuietly(entry: LogEntry): void {
  h.ctx.learnCore.db.sqlite.prepare('INSERT INTO core_log (id, at, type, course_id, node_ids, data) VALUES (?, ?, ?, ?, ?, ?)')
    .run(entry.id, entry.at, entry.type, entry.courseId ?? null, JSON.stringify(entry.nodeIds), JSON.stringify(entry))
}

const stateOf = (nodeId: string): NodeState | undefined => h.ctx.learnLearner.states([nodeId])[0]
const status = () => h.ctx.learnLearner.status()

it('reads a log longer than one query can hold, so the newest answer still counts', async () => {
  const { courseId, a } = await course()
  const sqlite = h.ctx.learnCore.db.sqlite
  const row = (type: string, data: object) => {
    const id = `lg_${ulid()}`
    const entry = { id, at: new Date().toISOString(), type, courseId, nodeIds: [a], context: {}, ...data }
    sqlite.prepare('INSERT INTO core_log (id, at, type, course_id, node_ids, data) VALUES (?, ?, ?, ?, ?, ?)').run(id, entry.at, type, courseId, JSON.stringify([a]), JSON.stringify(entry))
    return id
  }
  sqlite.exec('BEGIN')
  row('attempt.graded', { attemptId: newId('attempt'), problemId: newId('problem'), grading: { verdict: 'correct', method: 'rule', rationale: '' } })
  // More signals than the old 10 000-entry read could pass over.
  for (let index = 0; index < 10_050; index += 1) row('problem.seen', { problemId: newId('problem'), way: 'practice' })
  const last = row('attempt.graded', { attemptId: newId('attempt'), problemId: newId('problem'), grading: { verdict: 'incorrect', method: 'rule', rationale: '' } })
  sqlite.exec('COMMIT')

  h.ctx.learnLearner.recompute()
  expect(stateOf(a)).toMatchObject({ state: 'conflict' })
  expect(stateOf(a)?.evidence).toContain(last)
  expect(status()).toMatchObject({ computedThrough: last, behind: false })
})

it('fills an emptied cache from the log when it starts again with the same rules', async () => {
  const { courseId, a, b } = await course()
  graded(courseId, [a], 'correct')
  graded(courseId, [b], 'incorrect')
  expect([stateOf(a)?.state, stateOf(b)?.state]).toEqual(['independent', 'not-yet'])
  const root = h.root
  h.dispose(true)
  h = createHarness(() => { throw new Error('no model') }, {}, { root })
  // Same rules version, state rows gone: only the log can say what they were.
  h.ctx.learnCore.db.sqlite.exec('DELETE FROM learner_states')
  h.dispose(true)
  h = createHarness(() => { throw new Error('no model') }, {}, { root })
  expect([stateOf(a)?.state, stateOf(b)?.state]).toEqual(['independent', 'not-yet'])
})

it('makes good an entry whose event never arrived when the next entry comes', async () => {
  const { courseId, a, b } = await course()
  graded(courseId, [a], 'correct')
  const quiet: LogEntry = { id: `lg_${ulid()}` as never, at: new Date().toISOString(), type: 'attempt.graded', courseId: courseId as never, nodeIds: [a] as never, context: {}, attemptId: newId('attempt'), problemId: newId('problem'), grading: { verdict: 'incorrect', method: 'rule', rationale: '' } }
  writeQuietly(quiet)
  expect(stateOf(a)?.state).toBe('independent')
  expect(status().behind).toBe(true)
  // A different node's entry: the catch-up reads everything after the watermark, not just this entry.
  graded(courseId, [b], 'correct')
  expect(stateOf(a)).toMatchObject({ state: 'conflict' })
  expect(status().behind).toBe(false)
})

it('catches up at start what the log gained while the unit was not listening', async () => {
  const { courseId, a } = await course()
  graded(courseId, [a], 'correct')
  const root = h.root
  h.dispose(true)
  const away = createHarness(() => { throw new Error('no model') }, {}, { root })
  try {
    const entry: LogEntry = { id: `lg_${ulid()}` as never, at: new Date().toISOString(), type: 'attempt.graded', courseId: courseId as never, nodeIds: [a] as never, context: {}, attemptId: newId('attempt'), problemId: newId('problem'), grading: { verdict: 'incorrect', method: 'rule', rationale: '' } }
    away.ctx.learnCore.db.sqlite.prepare('INSERT INTO core_log (id, at, type, course_id, node_ids, data) VALUES (?, ?, ?, ?, ?, ?)').run(entry.id, entry.at, entry.type, courseId, JSON.stringify(entry.nodeIds), JSON.stringify(entry))
  } finally { away.dispose(true) }
  h = createHarness(() => { throw new Error('no model') }, {}, { root })
  expect(stateOf(a)?.state).toBe('conflict')
  expect(status().behind).toBe(false)
})

it('reports a failed recompute, keeps the earlier states, and recovers on the next entry without the caller seeing an error', async () => {
  const { courseId, a, b } = await course()
  graded(courseId, [a], 'correct')
  const before = stateOf(a)
  const failing = vi.spyOn(h.ctx.learnKnowledge, 'identity').mockImplementation(() => { throw new Error('身份读取失败（合成）') })
  // The unit that logs is not broken by learner's failure.
  expect(() => graded(courseId, [a], 'incorrect')).not.toThrow()
  expect(stateOf(a)).toEqual(before)
  expect(status()).toMatchObject({ behind: true, failed: { error: expect.stringContaining('身份读取失败') } })
  failing.mockRestore()

  graded(courseId, [b], 'correct')
  expect(stateOf(a)?.state).toBe('conflict')
  expect(status().failed).toBeUndefined()
  expect(status().behind).toBe(false)
})

it('tells the teacher when the states are not the latest', async () => {
  const { courseId, a } = await course()
  graded(courseId, [a], 'correct')
  const read = async () => ((await (h.ctx as unknown as { waterfall(name: string, request: unknown, last: () => Promise<{ unit: string; text: string }[]>): Promise<{ unit: string; text: string }[]> })
    .waterfall('learning/course-brief', { courseId, sessionId: 'brief' }, async () => [])).filter(section => section.unit === 'learner').map(section => section.text).join('\n'))
  expect(await read()).not.toMatch(/注意/)
  vi.spyOn(h.ctx.learnKnowledge, 'identity').mockImplementation(() => { throw new Error('合成故障') })
  graded(courseId, [a], 'incorrect')
  expect(await read()).toMatch(/注意：掌握状态上次重算失败（合成故障）/)
})

it('counts an answer on two merged nodes once', async () => {
  const { courseId, a, b } = await course()
  graded(courseId, [a, b], 'correct')
  expect(stateOf(a)?.evidence).toHaveLength(1)
  const plan = await h.endpoint<{ keep: { version: number }; merge: { version: number } }>('knowledge', 'mergePlan', { keepId: a, mergeId: b })
  await h.endpoint('knowledge', 'merge', { keepId: a, keepVersion: plan.keep.version, mergeId: b, mergeVersion: plan.merge.version })
  const merged = stateOf(a)!
  expect(merged).toMatchObject({ state: 'independent', excluded: [] })
  expect(merged.evidence).toHaveLength(1)
  expect(await h.endpoint<{ id: string }[]>('learner', 'evidence', { nodeId: a })).toHaveLength(1)
})

it('serves the status to the page', async () => {
  const { courseId, a } = await course()
  const last = graded(courseId, [a], 'correct')
  const served = await h.endpoint<LearnerStatus>('learner', 'status', {})
  expect(served).toMatchObject({ rulesVersion: h.ctx.learnLearner.rulesVersion, computedThrough: last.id, behind: false })
})
