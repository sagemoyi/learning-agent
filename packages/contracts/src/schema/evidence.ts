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

/** How much help was given, least to most (minimal effective help, PLAN §1.6). */
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
  z.object({ ...base, type: z.literal('signal.self-report'), claim: z.enum(['known', 'unknown']) }),
  z.object({ ...base, type: z.literal('problem.seen'), problemId: idOf('problem'), way: SeenWay }),
  z.object({
    ...base,
    type: z.literal('problem.reported'),
    problemId: idOf('problem'),
    reason: z.enum(['wrong', 'incomplete', 'out-of-scope', 'answer-doubtful', 'done-before']),
    note: z.string().default(''),
  }),
])
export type LogEntry = z.infer<typeof LogEntry>
export type LogEntryType = LogEntry['type']

/** What a producer hands to `learnCore.log.append`; core fills `id` and `at`. */
export type NewLogEntry = LogEntry extends infer E ? E extends LogEntry ? Omit<E, 'id' | 'at'> & { at?: string } : never : never

/** Mastery states, shown as words, never percentages (PLAN §3.2). */
export const MasteryState = z.enum(['untested', 'assisted', 'independent', 'retained', 'conflict'])
export type MasteryState = z.infer<typeof MasteryState>

/** Derived; deleting every row and recomputing from the log must give the same result. Owner: learner. */
export const NodeState = z.object({
  nodeId: idOf('node'),
  state: MasteryState,
  /** Long time without practice. */
  needsReview: z.boolean(),
  /** Asked about repeatedly in side chats or annotations. */
  doubtful: z.boolean(),
  lastEvidenceAt: instant.optional(),
  /** Plain-language reason for the state, citing log entries. */
  explanation: z.string(),
  evidence: z.array(idOf('log')),
  rulesVersion: z.string(),
  computedAt: instant,
})
export type NodeState = z.infer<typeof NodeState>
