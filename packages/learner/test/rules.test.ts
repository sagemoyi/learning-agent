// The mastery rules (docs/learner/design.md, 验收标准 A and B) on hand-written synthetic logs.
import { describe, expect, it } from 'vitest'
import { newId, type Grading, type LogEntry, type TestConditions, type Verdict } from '@learning-agent/contracts'
import { deriveState, judge } from '../src/rules.ts'

const node = newId('node')
const other = newId('node')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const t0 = Date.parse('2026-10-01T08:00:00Z')
const iso = (at: number) => new Date(at).toISOString()

type Attempt = LogEntry & { type: 'attempt.graded' }

function graded(verdict: Verdict, at: number, options: { problemId?: string; context?: LogEntry['context']; nodeIds?: string[]; conditions?: TestConditions } = {}): Attempt {
  return {
    id: newId('log'),
    at: iso(at),
    type: 'attempt.graded',
    nodeIds: (options.nodeIds ?? [node]) as never,
    context: options.context ?? {},
    attemptId: newId('attempt'),
    problemId: (options.problemId ?? newId('problem')) as never,
    ...(options.conditions ? { conditions: options.conditions } : {}),
    grading: { verdict, method: 'rule', rationale: '' },
  }
}

function help(at: number, options: { context?: LogEntry['context']; problemId?: string; via?: 'teacher' | 'side-chat'; level?: 'hint' | 'explanation' | 'worked-solution' } = {}): LogEntry {
  return { id: newId('log'), at: iso(at), type: 'help.given', nodeIds: [node], context: options.context ?? {}, level: options.level ?? 'explanation', via: options.via ?? 'teacher', ...(options.problemId ? { problemId: options.problemId as never } : {}) }
}

function regrade(of: LogEntry & { type: 'attempt.graded' | 'attempt.regraded' }, verdict: Exclude<Verdict, 'pending-review'>, at: number, attemptId = of.attemptId): LogEntry {
  const grading: Grading = { verdict, method: 'teacher', rationale: '复核' }
  return { id: newId('log'), at: iso(at), type: 'attempt.regraded', nodeIds: [node], context: {}, attemptId: attemptId as never, corrects: of.id as never, grading, reason: '复核' }
}

const signal = (type: 'signal.question' | 'signal.misconception', at: number): LogEntry => ({ id: newId('log'), at: iso(at), type, nodeIds: [node], context: {}, text: '为什么压强和形状无关' })

const state = (entries: LogEntry[], now = t0 + 10 * DAY) => deriveState(node, entries, now)

describe('evidence that counts (A)', () => {
  it('starts untested and never treats wrong answers as untested', () => {
    expect(state([]).state).toBe('untested')
    expect(state([graded('incorrect', t0)]).state).toBe('not-yet')
  })

  it('follows the regrade chain to its last valid link', () => {
    const wrong = graded('incorrect', t0)
    const first = regrade(wrong, 'correct', t0 + HOUR)
    const second = regrade(first as never, 'partial', t0 + 2 * HOUR)
    expect(state([wrong, first]).state).toBe('independent')
    expect(state([wrong, first, second]).state).toBe('not-yet')
    // A correction naming another answer is not taken.
    expect(state([wrong, regrade(wrong, 'correct', t0 + HOUR, newId('attempt'))]).state).toBe('not-yet')
  })

  it('counts one answer once, however often its grading was written', () => {
    const answer = graded('correct', t0)
    const copy = { ...answer, id: newId('log'), at: iso(t0 + 1) }
    expect(state([answer, copy]).explanation).toContain('独立答对 1 次')
    // A problem tagged with two identities that were merged asks about one node.
    const both = graded('incorrect', t0, { nodeIds: [node, other] })
    expect(judge([both], id => (id === other ? node : id))[0]!.direct).toBe(true)
    expect(judge([both])[0]!.direct).toBe(false)
  })

  it('waits for answers under review, and counts them once regraded', () => {
    const waiting = graded('pending-review', t0)
    expect(state([waiting]).state).toBe('untested')
    expect(state([waiting]).explanation).toContain('有 1 道题的判分等复核')
    expect(state([waiting, regrade(waiting, 'correct', t0 + HOUR)]).state).toBe('independent')
  })

  it('drops the answers to a problem later found wrong, not those to one kept as it was', () => {
    const problemId = newId('problem')
    const answer = graded('incorrect', t0, { problemId })
    const reviewed = (outcome: 'keep' | 'fixed' | 'retired', at: number): LogEntry => ({ id: newId('log'), at: iso(at), type: 'problem.reviewed', nodeIds: [node], context: {}, problemId: problemId as never, outcome, note: '' })
    expect(state([answer, reviewed('retired', t0 + DAY)]).state).toBe('untested')
    expect(state([answer, reviewed('fixed', t0 + DAY)]).explanation).toContain('核对出有错，不计')
    expect(state([answer, reviewed('keep', t0 + DAY)]).state).toBe('not-yet')
    // Answered again after the fix: that answer counts.
    expect(state([answer, reviewed('fixed', t0 + DAY), graded('correct', t0 + 2 * DAY, { problemId })]).state).toBe('independent')
  })

  it('works 待复查 out from the latest independent success and the time it is read', () => {
    expect(state([graded('correct', t0)], t0 + 20 * DAY).needsReview).toBe(true)
    expect(state([graded('correct', t0)], t0 + 10 * DAY).needsReview).toBe(false)
    // Helped practice does not move the date on.
    expect(state([graded('correct', t0), help(t0 + 15 * DAY), graded('correct', t0 + 15 * DAY + HOUR)], t0 + 20 * DAY).needsReview).toBe(true)
  })
})

describe('independent, delayed, new (B)', () => {
  it('counts help on the problem, during the test, or on the node within a day', () => {
    const test = newId('test'), lesson = newId('lesson'), problemId = newId('problem')
    expect(state([help(t0 - HOUR), graded('correct', t0)]).state).toBe('assisted')
    // Ten days after the lesson's explanation, another problem with no help of its own is independent.
    expect(state([help(t0 - 10 * DAY, { context: { lessonId: lesson } }), graded('correct', t0, { context: { lessonId: lesson } })]).state).toBe('independent')
    // A worked solution of this problem keeps counting, however long ago.
    expect(state([help(t0 - 7 * DAY, { problemId, level: 'worked-solution' }), graded('correct', t0, { problemId })]).state).toBe('assisted')
    // Asking during the test counts against its answers; after handing in it does not.
    // However long the test stayed open.
    expect(state([help(t0 - 3 * DAY, { context: { testId: test } }), graded('correct', t0, { context: { testId: test } })]).state).toBe('assisted')
    expect(state([help(t0 - 3 * DAY, { context: { testId: newId('test') } }), graded('correct', t0, { context: { testId: test } })]).state).toBe('independent')
    expect(state([graded('correct', t0, { context: { testId: test } }), help(t0 + 60 * 1000, { context: { testId: test } })]).state).toBe('independent')
    // Side-chat help counts the same way.
    expect(state([help(t0 - 2 * HOUR, { via: 'side-chat' }), graded('correct', t0)]).state).toBe('assisted')
    expect(state([help(t0 - 2 * DAY, { via: 'side-chat' }), graded('correct', t0)]).state).toBe('independent')
  })

  it('needs a later success on a new problem, three days after the node was last practised', () => {
    expect(state([graded('correct', t0), graded('correct', t0 + DAY)]).state).toBe('independent')
    expect(state([graded('correct', t0), graded('correct', t0 + 4 * DAY)]).state).toBe('retained')
    // Practice on day 3 moves the start: day 5 is two days on, day 9 counts.
    const practice = [graded('correct', t0), graded('incorrect', t0 + 2 * DAY, { nodeIds: [node, other] }), graded('correct', t0 + 4 * DAY)]
    expect(state(practice).state).toBe('independent')
    expect(state([...practice, graded('correct', t0 + 8 * DAY)]).state).toBe('retained')
    // So does an explanation in between.
    expect(state([graded('correct', t0), help(t0 + 2 * DAY), graded('correct', t0 + 4 * DAY)]).state).toBe('independent')
    // The same problem again, four days later, is not a delayed check.
    const problemId = newId('problem')
    expect(state([graded('correct', t0, { problemId }), graded('correct', t0 + 4 * DAY, { problemId })]).state).toBe('independent')
    // Two successes handed in together are one sitting.
    const together = t0 + 5 * DAY
    expect(state([graded('correct', together), graded('correct', together)]).state).toBe('independent')
    // When to check next.
    expect(state([graded('correct', t0)], t0 + DAY).checkFrom).toBe(iso(t0 + 3 * DAY))
    expect(state([graded('correct', t0)], t0 + DAY).next).toContain('以后独立做对一道没做过的题')
  })

  it('says when an answer alone counts: not within a day of help (rules-2)', () => {
    // Helped success: from a day after the latest help.
    const helped = state([help(t0), graded('correct', t0 + HOUR)], t0 + 2 * HOUR)
    expect(helped).toMatchObject({ state: 'assisted', checkFrom: iso(t0 + DAY) })
    expect(helped.next).toMatch(/^\d+月\d+日 \d\d:\d\d以后，不看提示、不问老师，独立做对一道。$/)
    expect(state([help(t0), graded('correct', t0 + HOUR)], t0 + 2 * DAY).next).toBe('不看提示、不问老师，独立做对一道。')
    // Retained: two weeks after the latest success, pushed back by help the day before it falls due.
    const retained = [graded('correct', t0), graded('correct', t0 + 4 * DAY)]
    expect(state(retained).checkFrom).toBe(iso(t0 + 18 * DAY))
    expect(state([...retained, help(t0 + 18 * DAY - HOUR)], t0 + 18 * DAY).checkFrom).toBe(iso(t0 + 19 * DAY - HOUR))
    expect(state([...retained, help(t0 + 18 * DAY - HOUR)], t0 + 18 * DAY).state).toBe('retained')
    // Not-yet and conflicts need teaching or a look first: no time to check from.
    expect(state([graded('incorrect', t0)]).checkFrom).toBeUndefined()
    expect(state([graded('correct', t0), graded('incorrect', t0 + DAY)]).checkFrom).toBeUndefined()
  })

  it('flags right-then-wrong on this node alone as a conflict, and recovering proves recovery first', () => {
    expect(state([graded('incorrect', t0), graded('correct', t0 + DAY)]).state).toBe('independent')
    expect(state([graded('incorrect', t0), graded('incorrect', t0 + DAY), graded('correct', t0 + 2 * DAY)]).state).toBe('independent')
    expect(state([graded('correct', t0), graded('incorrect', t0 + DAY)]).state).toBe('conflict')
    expect(state([graded('correct', t0), graded('partial', t0 + DAY)]).state).toBe('conflict')
    expect(state([graded('correct', t0), ...[1, 2, 3].map(n => graded('incorrect', t0 + n * DAY))]).state).toBe('conflict')
    // Right again right after the conflict: independent, not back to retained.
    expect(state([graded('correct', t0), graded('correct', t0 + 4 * DAY), graded('incorrect', t0 + 5 * DAY), graded('correct', t0 + 5 * DAY + HOUR)]).state).toBe('independent')
    // Then a delayed check of its own.
    expect(state([graded('correct', t0), graded('incorrect', t0 + DAY), graded('correct', t0 + DAY + HOUR), graded('correct', t0 + 5 * DAY)]).state).toBe('retained')
    // One right and one wrong handed in together: a conflict, whatever order the log has them in.
    const together = [graded('correct', t0), graded('incorrect', t0)]
    expect(state(together).state).toBe('conflict')
    expect(state([...together].reverse()).state).toBe('conflict')
    expect(state(together).explanation).toMatch(/同一次作答里，一道题独立答对，一道只考这个点的题做错了/)
    // A helped success after wrong answers stays assisted.
    expect(state([graded('incorrect', t0), help(t0 + DAY), graded('correct', t0 + DAY + 1)]).state).toBe('assisted')
  })

  it('a wrong answer to a problem on several nodes is no conflict, but no success either', () => {
    const mixed = (at: number) => graded('incorrect', at, { nodeIds: [node, other, newId('node')] })
    const after = state([graded('correct', t0), mixed(t0 + DAY)])
    expect(after.state).toBe('independent')
    expect(after.explanation).toContain('涉及几个知识点的题没做对')
    expect(state([mixed(t0)]).state).toBe('not-yet')
    expect(state([mixed(t0)]).explanation).toContain('不确定问题出在哪一项')
  })

  it('is doubtful about what was asked since the latest independent success, until the next one', () => {
    const asked = [graded('correct', t0), signal('signal.question', t0 + DAY), signal('signal.question', t0 + 2 * DAY)]
    expect(state(asked).doubtful).toBe(true)
    expect(state([...asked, graded('correct', t0 + 3 * DAY)]).doubtful).toBe(false)
    // Questions before the success do not count; one misconception does.
    expect(state([signal('signal.question', t0 - 2 * DAY), signal('signal.question', t0 - DAY), graded('correct', t0)]).doubtful).toBe(false)
    expect(state([graded('correct', t0), signal('signal.misconception', t0 + DAY)]).doubtful).toBe(true)
    expect(state([signal('signal.question', t0)]).doubtful).toBe(false)
  })

  it('says under which conditions the successes were, and keeps courses apart', () => {
    const open = { book: 'open', calculator: true, formulaSheet: false } as const
    expect(state([graded('correct', t0, { conditions: open })]).explanation).toContain('这些都是开卷作答')
    const course = newId('course'), elsewhere = newId('course')
    const here = { ...graded('incorrect', t0), courseId: course }
    const there = { ...graded('correct', t0 + DAY), courseId: elsewhere }
    const derived = state([here, there, help(t0 + 2 * DAY), { ...graded('correct', t0 + 2 * DAY + HOUR), courseId: course }])
    expect(derived.courses.find(item => item.courseId === elsewhere)?.state).toBe('independent')
    // Help in another course still counts against this course's answer.
    expect(derived.courses.find(item => item.courseId === course)?.state).toBe('assisted')
  })
})
