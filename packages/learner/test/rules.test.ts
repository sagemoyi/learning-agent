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

const state = (entries: LogEntry[], now = t0 + 10 * DAY) => deriveState(node, entries, now)

describe('skeleton mastery rules', () => {
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

  it('flags conflicting recent evidence, repeated questions and long gaps', () => {
    expect(state([graded('correct', t0), graded('incorrect', t0 + DAY)]).state).toBe('conflict')
    expect(state([question(t0), question(t0 + 1)]).doubtful).toBe(true)
    expect(state([graded('correct', t0)], t0 + 20 * DAY).needsReview).toBe(true)
  })

  it('ignores answers waiting for review and honours regrading', () => {
    expect(state([graded('pending-review', t0)]).state).toBe('untested')
    const wrong = graded('incorrect', t0) as LogEntry & { type: 'attempt.graded' }
    const regrade: LogEntry = { id: newId('log'), at: new Date(t0 + 1).toISOString(), type: 'attempt.regraded', nodeIds: [node], context: {}, attemptId: wrong.attemptId, corrects: wrong.id, grading: { verdict: 'correct', method: 'learner', rationale: '申诉' }, reason: '申诉' }
    expect(state([wrong, regrade]).state).toBe('independent')
  })
})
