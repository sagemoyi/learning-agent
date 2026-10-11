// The learning evidence log and the node states derived from it (contracts §4.6).
// The log is append-only and is the only input to mastery: corrections are new entries, never edits.
// Shape follows xAPI: verb (`type`) + object + result + context; the actor is always the learner.
import { z } from 'zod'
import { Grading, SeenWay, TestKind } from './assess.ts'
import { TestConditions } from './course.ts'
import { idOf, instant, sessionId } from './common.ts'

/** Where it happened. Every field is optional; producers fill what they know. */
export const LogContext = z.object({
  stageId: idOf('stage').optional(),
  lessonId: idOf('lesson').optional(),
  testId: idOf('test').optional(),
  sessionId: sessionId.optional(),
})

const base = {
  id: idOf('log'),
  at: instant,
  courseId: idOf('course').optional(),
  nodeIds: z.array(idOf('node')),
  context: LogContext.default({}),
}

/** How much help was given, least to most (minimal effective help, PLAN design principle 6). */
export const HelpLevel = z.enum(['hint', 'explanation', 'worked-solution', 'answer-revealed'])
export type HelpLevel = z.infer<typeof HelpLevel>

export const LogEntry = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('attempt.graded'),
    attemptId: idOf('attempt'),
    problemId: idOf('problem'),
    testKind: TestKind.optional(),
    conditions: TestConditions.optional(),
    grading: Grading,
  }),
  z.object({
    ...base,
    type: z.literal('attempt.regraded'),
    attemptId: idOf('attempt'),
    /** The entry this one corrects. */
    corrects: idOf('log'),
    grading: Grading,
    reason: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('help.given'),
    level: HelpLevel,
    problemId: idOf('problem').optional(),
    via: z.enum(['teacher', 'side-chat', 'test-page']),
  }),
  z.object({ ...base, type: z.literal('signal.question'), text: z.string(), ref: z.string().optional() }),
  z.object({ ...base, type: z.literal('signal.misconception'), text: z.string(), ref: z.string().optional() }),
  /** `text`: the learner's own words, when the producer has them. */
  z.object({ ...base, type: z.literal('signal.self-report'), claim: z.enum(['known', 'unknown']), text: z.string().optional() }),
  z.object({ ...base, type: z.literal('problem.seen'), problemId: idOf('problem'), way: SeenWay }),
  z.object({
    ...base,
    type: z.literal('problem.reported'),
    problemId: idOf('problem'),
    reason: z.enum(['wrong', 'incomplete', 'out-of-scope', 'answer-doubtful', 'done-before']),
    note: z.string().default(''),
  }),
  /**
   * The teacher checked a reported problem: `fixed` or `retired` means it was wrong, so the answers given to it
   * before do not count as evidence; `keep` changes nothing. Retiring a duplicate copy writes no such entry.
   */
  z.object({
    ...base,
    type: z.literal('problem.reviewed'),
    problemId: idOf('problem'),
    outcome: z.enum(['keep', 'fixed', 'retired']),
    note: z.string().default(''),
  }),
])
export type LogEntry = z.infer<typeof LogEntry>
export type LogEntryType = LogEntry['type']

/** What a producer hands to `learnCore.log.append`; core fills `id` and `at`. */
export type NewLogEntry = LogEntry extends infer E ? E extends LogEntry ? Omit<E, 'id' | 'at'> & { at?: string } : never : never

/**
 * Mastery states, shown as words, never percentages (docs/learner/design.md). `not-yet` (还没答对): answered, never
 * correctly, so it is not `untested`, which must not mean "cannot".
 */
export const MasteryState = z.enum(['untested', 'not-yet', 'assisted', 'independent', 'retained', 'conflict'])
export type MasteryState = z.infer<typeof MasteryState>

/** The state from one course's attempts only (help from anywhere still counts), for nodes shared by several courses. */
export const CourseState = z.object({
  courseId: idOf('course'),
  state: MasteryState,
  /** Worked out when read, from `lastIndependentAt`: time passing writes nothing to the log. */
  needsReview: z.boolean(),
  doubtful: z.boolean(),
  /**
   * The latest possible misconception since the latest independent success, when the point was answered alone before
   * (independent, retained): `checkFrom` is then when a new problem answered alone checks it (rules-3).
   */
  doubt: z.object({ text: z.string(), at: instant }).optional(),
  lastEvidenceAt: instant.optional(),
  /** The latest answer that counts as independent and correct. */
  lastIndependentAt: instant.optional(),
  /** Plain-language reason for the state: what was done, under which conditions, what does not count and why. */
  explanation: z.string(),
  /** What evidence is still missing, in words for the learner; absent when nothing is. */
  next: z.string().optional(),
  /** The earliest time a new problem answered alone adds evidence: a delayed check (independent), a review (retained), an answer without help (assisted), a check of a possible misconception (`doubt`); never within a day of help on the node. */
  checkFrom: instant.optional(),
  /** The log entries the conclusion rests on. */
  evidence: z.array(idOf('log')),
})
export type CourseState = z.infer<typeof CourseState>

/**
 * Derived; deleting every row and recomputing from the log must give the same result. Owner: learner.
 * A merged identity's log entries count for the node it was merged into (docs/knowledge/design.md, C).
 */
export const NodeState = z.object({
  nodeId: idOf('node'),
  state: MasteryState,
  /** No independent success for a long time; worked out when read. */
  needsReview: z.boolean(),
  /** Asked about repeatedly, or a possible misconception, since the latest independent success. */
  doubtful: z.boolean(),
  doubt: z.object({ text: z.string(), at: instant }).optional(),
  lastEvidenceAt: instant.optional(),
  lastIndependentAt: instant.optional(),
  /** Plain-language reason for the state. */
  explanation: z.string(),
  next: z.string().optional(),
  checkFrom: instant.optional(),
  evidence: z.array(idOf('log')),
  rulesVersion: z.string(),
  computedAt: instant,
  /** One entry per course that has attempts on the node. */
  courses: z.array(CourseState).default([]),
})
export type NodeState = z.infer<typeof NodeState>
