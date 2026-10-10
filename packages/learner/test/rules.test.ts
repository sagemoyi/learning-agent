import { describe, expect, it } from 'vitest'
import { newId, type LogEntry, type Verdict } from '@learning-agent/contracts'
import { deriveState } from '../src/rules.ts'

const node = newId('node')
const lesson = newId('lesson')
const DAY = 24 * 60 * 60 * 1000
const t0 = Date.parse('2026-10-01T08:00:00Z')

function graded(verdict: Verdict, at: number, context: LogEntry['context'] = {}): LogEntry {
  return {
    id: newId('log'),
    at: new Date(at).toISOString(),
    type: 'attempt.graded',
    nodeIds: [node],
    context,
    attemptId: newId('attempt'),
    problemId: newId('problem'),
    grading: { verdict, method: 'rule', rationale: '' },
  }
}

function help(at: number, context: LogEntry['context'], via: 'teacher' | 'side-chat' = 'teacher'): LogEntry {
  return { id: newId('log'), at: new Date(at).toISOString(), type: 'help.given', nodeIds: [node], context, level: 'explanation', via }
}

function question(at: number): LogEntry {
  return { id: newId('log'), at: new Date(at).toISOString(), type: 'signal.question', nodeIds: [node], context: {}, text: '为什么？' }
}

type Attempt = LogEntry & { type: 'attempt.graded' }

/** A correction of `attempt`'s grading `corrects`, written `offset` ms after it. */
function regrade(attempt: Attempt, corrects: string, verdict: Verdict, offset: number): LogEntry & { type: 'attempt.regraded' } {
  return { id: newId('log'), at: new Date(Date.parse(attempt.at) + offset).toISOString(), type: 'attempt.regraded', nodeIds: [node], context: {}, attemptId: attempt.attemptId, corrects: corrects as never, grading: { verdict, method: 'teacher', rationale: '复核' }, reason: '复核' }
}

function voided(attempt: Attempt, voids: string): LogEntry {
  return { id: newId('log'), at: new Date(Date.parse(attempt.at) + 5).toISOString(), type: 'attempt.voided', nodeIds: [node], context: {}, attemptId: attempt.attemptId, voids: voids as never, reason: 'problem-fixed', note: '' }
}

const state = (entries: LogEntry[], now = t0 + 10 * DAY) => deriveState(node, entries, now)

describe('mastery rules', () => {
  it('starts untested and never treats wrong answers as untested', () => {
    expect(state([]).state).toBe('untested')
    expect(state([graded('incorrect', t0)]).state).toBe('not-yet')
  })

  it('separates independent from assisted success', () => {
    expect(state([graded('correct', t0, { lessonId: lesson })]).state).toBe('independent')
    expect(state([help(t0 - 1000, { lessonId: lesson }), graded('correct', t0, { lessonId: lesson })]).state).toBe('assisted')
    // Help after the attempt does not count against it.
    expect(state([graded('correct', t0, { lessonId: lesson }), help(t0 + 1000, { lessonId: lesson })]).state).toBe('independent')
  })

  it('counts a side-chat explanation against the answers of the next day only', () => {
    const sideHelp = help(t0, { sessionId: globalThis.crypto.randomUUID() }, 'side-chat')
    expect(state([sideHelp, graded('correct', t0 + 2 * 60 * 60 * 1000)]).state).toBe('assisted')
    expect(state([sideHelp, graded('correct', t0 + 2 * DAY)]).state).toBe('independent')
  })

  it('needs a second independent success at least three days later for retained', () => {
    expect(state([graded('correct', t0), graded('correct', t0 + DAY)]).state).toBe('independent')
    expect(state([graded('correct', t0), graded('correct', t0 + 4 * DAY)]).state).toBe('retained')
  })

  it('judges wrong-then-right by the latest answer, and flags right-then-wrong as a conflict', () => {
    expect(state([graded('incorrect', t0), graded('correct', t0 + DAY)]).state).toBe('independent')
    expect(state([graded('incorrect', t0), graded('incorrect', t0 + DAY), graded('correct', t0 + 2 * DAY)]).state).toBe('independent')
    expect(state([graded('correct', t0), graded('incorrect', t0 + DAY)]).state).toBe('conflict')
    // However long ago the success, failing since then is a conflict, not still "已独立完成".
    expect(state([graded('correct', t0), ...[1, 2, 3].map(n => graded('incorrect', t0 + n * DAY))]).state).toBe('conflict')
    // Recovering after the conflict counts again.
    expect(state([graded('correct', t0), graded('incorrect', t0 + DAY), graded('correct', t0 + 5 * DAY)]).state).toBe('retained')
    // An answered-wrong node with help-only success stays assisted.
    expect(state([graded('incorrect', t0), help(t0 + DAY, { lessonId: lesson }), graded('correct', t0 + DAY + 1, { lessonId: lesson })]).state).toBe('assisted')
  })

  it('flags repeated questions and long gaps', () => {
    expect(state([question(t0), question(t0 + 1)]).doubtful).toBe(true)
    expect(state([graded('correct', t0)], t0 + 20 * DAY).needsReview).toBe(true)
  })

  it('ignores answers waiting for review and honours regrading', () => {
    expect(state([graded('pending-review', t0)]).state).toBe('untested')
    const wrong = graded('incorrect', t0) as LogEntry & { type: 'attempt.graded' }
    const regrade: LogEntry = { id: newId('log'), at: new Date(t0 + 1).toISOString(), type: 'attempt.regraded', nodeIds: [node], context: {}, attemptId: wrong.attemptId, corrects: wrong.id, grading: { verdict: 'correct', method: 'learner', rationale: '申诉' }, reason: '申诉' }
    expect(state([wrong, regrade]).state).toBe('independent')
  })

  it('judges an answer by the end of its correction chain and shows what each correction replaced', () => {
    const wrong = graded('incorrect', t0) as Attempt
    const first = regrade(wrong, wrong.id, 'correct', 1)
    const second = regrade(wrong, first.id, 'incorrect', 2)
    // Written in this order, read in any order: the chain decides, not the order the caller hands entries over.
    const result = deriveState(node, [second, wrong, first], t0 + DAY)
    expect(result.state).toBe('not-yet')
    expect(result.evidence).toEqual([second.id])
    expect(result.excluded).toEqual(expect.arrayContaining([{ id: wrong.id, reason: '原判已被改判替代' }, { id: first.id, reason: '原判已被改判替代' }]))
    expect(deriveState(node, [wrong, first], t0 + DAY).state).toBe('independent')
  })

  it('ignores a correction that does not point at a grading of its own attempt', () => {
    const other = graded('correct', t0) as Attempt
    const wrong = graded('incorrect', t0 + 1) as Attempt
    const stray = regrade(wrong, other.id, 'correct', 2)
    const orphan = regrade(graded('correct', t0 + 9) as Attempt, wrong.id, 'correct', 3)
    const result = state([wrong, other, stray, orphan])
    expect(result.state).toBe('conflict')
    expect(result.excluded).toEqual(expect.arrayContaining([{ id: stray.id, reason: '更正找不到它要更正的判分' }, { id: orphan.id, reason: '更正找不到它要更正的判分' }]))
  })

  it('counts one answer once however many times its grading was logged', () => {
    const once = graded('correct', t0) as Attempt
    const replay = { ...once, id: newId('log'), at: new Date(t0 + 5 * DAY).toISOString() } as Attempt
    const result = state([once, replay])
    expect(result.state).toBe('independent')
    expect(result.excluded).toEqual([{ id: replay.id, reason: '同一次作答重复记录' }])
  })

  it('does not count a voided answer, but counts a later one on the repaired problem', () => {
    const answer = graded('correct', t0) as Attempt
    const void1 = voided(answer, answer.id)
    expect(state([answer, void1]).state).toBe('untested')
    const result = state([answer, void1, graded('incorrect', t0 + DAY)])
    expect(result.state).toBe('not-yet')
    expect(result.evidence).toContain(void1.id)
    expect(result.excluded).toEqual([{ id: answer.id, reason: '题目核对后作废' }])
    // A void must name a grading of that answer.
    const stray = voided(answer, graded('correct', t0 + 2).id)
    expect(state([answer, stray]).state).toBe('independent')
  })

  it('voids the whole chain, a regrade included', () => {
    const wrong = graded('incorrect', t0) as Attempt
    const fixed = regrade(wrong, wrong.id, 'correct', 1)
    expect(state([wrong, fixed, voided(wrong, fixed.id)]).state).toBe('untested')
  })

  it('reads the same whatever order the entries come in', () => {
    // Two answers in the same millisecond: the log's own order (ids count up) says which came last.
    const entries = [graded('correct', t0), graded('incorrect', t0)]
    const forward = state(entries)
    expect(forward.state).toBe('conflict')
    expect(state([...entries].reverse())).toEqual(forward)
  })

  it('cites only the help that coloured an answer, and none given after it was locked', () => {
    const own = help(t0 - 1000, { lessonId: lesson })
    const elsewhere = help(t0 - 1000, { lessonId: newId('lesson') })
    const late = help(t0 + 1, { lessonId: lesson })
    const result = state([own, elsewhere, late, graded('correct', t0, { lessonId: lesson })])
    expect(result.state).toBe('assisted')
    expect(result.evidence).toContain(own.id)
    expect(result.evidence).not.toContain(elsewhere.id)
    expect(result.evidence).not.toContain(late.id)
  })

  it('lists an answer waiting for review as not counted, not as unanswered', () => {
    const waiting = graded('pending-review', t0) as Attempt
    expect(state([waiting]).excluded).toEqual([{ id: waiting.id, reason: '判分待复核' }])
  })

  it('counts a question once however often it was delivered', () => {
    const asked = (ref: string) => ({ ...question(t0), ref }) as LogEntry
    expect(state([asked('annotation:a'), asked('annotation:a')]).doubtful).toBe(false)
    expect(state([asked('annotation:a'), asked('annotation:b')]).doubtful).toBe(true)
  })

  it("keeps a course's corrections and voids to that course", () => {
    const course1 = newId('course'), course2 = newId('course')
    const a = { ...graded('correct', t0), courseId: course1 } as Attempt
    const b = { ...graded('incorrect', t0 + 1), courseId: course2 } as Attempt
    const fix = { ...regrade(b, b.id, 'correct', 2), courseId: course2 } as LogEntry
    const result = state([a, b, fix])
    expect(result.courses.find(course => course.courseId === course1)).toMatchObject({ state: 'independent', excluded: [] })
    expect(result.courses.find(course => course.courseId === course2)?.state).toBe('independent')
  })
})
