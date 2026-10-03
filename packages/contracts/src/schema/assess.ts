// Problems, tests and attempts (contracts §4.6). Owner: assess.
import { z } from 'zod'
import { TestConditions } from './course.ts'
import { idOf, instant, relativePath } from './common.ts'
import { Locator } from './library.ts'

export const Answer = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('numeric'),
    value: z.number(),
    unit: z.string().default(''),
    /** Accepted error: relative (0.02 = 2 %) or absolute in `unit`. */
    tolerance: z.object({ relative: z.number().nonnegative().optional(), absolute: z.number().nonnegative().optional() }),
  }),
  z.object({ kind: z.literal('choice'), options: z.array(z.string()).min(2), correct: z.array(z.number().int().nonnegative()).min(1) }),
  z.object({ kind: z.literal('expression'), value: z.string() }),
  z.object({ kind: z.literal('open'), rubric: z.string() }),
])
export type Answer = z.infer<typeof Answer>

/** Problem tiers (PLAN §5.1): 1 your material, 2 authoritative, 3 adapted (labelled), 4 agent-written (practice only). */
export const ProblemTier = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])

export const ProblemOrigin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chunk'), chunkId: idOf('chunk'), locator: Locator.optional(), label: z.string() }),
  z.object({ kind: z.literal('web'), url: z.url(), label: z.string() }),
  z.object({ kind: z.literal('agent') }),
])

export const Problem = z.object({
  id: idOf('problem'),
  stem: z.string(),
  /** Images, relative to the data root. */
  media: z.array(relativePath).default([]),
  answer: Answer,
  /** book: printed answer; authority: authoritative source; calculated: independently checked by the calculator tool; unverified: agent's own solution. */
  answerSource: z.enum(['book', 'authority', 'calculated', 'unverified']),
  tier: ProblemTier,
  origin: ProblemOrigin,
  adaptedFrom: idOf('problem').optional(),
  nodeIds: z.array(idOf('node')).min(1),
  pool: z.enum(['practice', 'test-reserved']),
  status: z.enum(['active', 'under-review', 'retired']),
  createdAt: instant,
})
export type Problem = z.infer<typeof Problem>

/** How the learner has seen a problem; seen problems no longer count as new. */
export const SeenWay = z.enum(['homework', 'practice', 'test', 'textbook'])

export const TestKind = z.enum(['diagnostic', 'quiz', 'practice', 'stage', 'review', 'mock'])
export type TestKind = z.infer<typeof TestKind>

export const Test = z.object({
  id: idOf('test'),
  courseId: idOf('course'),
  stageId: idOf('stage').optional(),
  lessonId: idOf('lesson').optional(),
  kind: TestKind,
  conditions: TestConditions,
  problemIds: z.array(idOf('problem')),
  swapLimit: z.number().int().nonnegative(),
  status: z.enum(['open', 'submitted', 'graded', 'abandoned']),
  startedAt: instant,
  endedAt: instant.optional(),
})
export type Test = z.infer<typeof Test>

export const Transcription = z.object({
  text: z.string(),
  /** The learner checked and possibly corrected the transcription before grading (PLAN §5.5). */
  confirmedAt: instant.optional(),
  edited: z.boolean().default(false),
})

/** One answer as submitted. Never changes; grading is appended separately. */
export const Attempt = z.object({
  id: idOf('attempt'),
  problemId: idOf('problem'),
  testId: idOf('test').optional(),
  courseId: idOf('course'),
  text: z.string().default(''),
  /** Handwriting photos, relative to the course folder (`attachments/…`). */
  images: z.array(relativePath).default([]),
  transcription: Transcription.optional(),
  submittedAt: instant,
})
export type Attempt = z.infer<typeof Attempt>

export const Verdict = z.enum(['correct', 'partial', 'incorrect', 'pending-review'])
export type Verdict = z.infer<typeof Verdict>

export const Grading = z.object({
  verdict: Verdict,
  /** 0..1 when the problem is scored. */
  score: z.number().min(0).max(1).optional(),
  method: z.enum(['rule', 'llm', 'learner']),
  /** Model's own confidence for llm grading; low confidence → pending-review. */
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  rationale: z.string().default(''),
})
export type Grading = z.infer<typeof Grading>
