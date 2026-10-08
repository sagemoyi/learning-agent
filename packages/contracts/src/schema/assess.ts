// Problems, tests and attempts (contracts §4.6). Owner: assess.
import { z } from 'zod'
import { TestConditions } from './course.ts'
import { idOf, instant, relativePath } from './common.ts'
import { Locator } from './library.ts'

const NumericAnswer = z.object({
  kind: z.literal('numeric'),
  value: z.number(),
  unit: z.string().default(''),
  /** Accepted error: relative (0.02 = 2 %) or absolute in `unit`. */
  tolerance: z.object({ relative: z.number().nonnegative().optional(), absolute: z.number().nonnegative().optional() }),
})
const ChoiceAnswer = z.object({ kind: z.literal('choice'), options: z.array(z.string()).min(2), correct: z.array(z.number().int().nonnegative()).min(1) })
const ExpressionAnswer = z.object({ kind: z.literal('expression'), value: z.string() })
const OpenAnswer = z.object({ kind: z.literal('open'), rubric: z.string() })

/** One answer: a part of a problem, or a whole problem asking one thing. */
export const SingleAnswer = z.discriminatedUnion('kind', [NumericAnswer, ChoiceAnswer, ExpressionAnswer, OpenAnswer])
export type SingleAnswer = z.infer<typeof SingleAnswer>

/** A problem asking several things, e.g. a textbook exercise with (1)(2)(3); each part is graded on its own. */
export const AnswerPart = z.object({ label: z.string(), answer: SingleAnswer })
export type AnswerPart = z.infer<typeof AnswerPart>

export const Answer = z.discriminatedUnion('kind', [
  NumericAnswer,
  ChoiceAnswer,
  ExpressionAnswer,
  OpenAnswer,
  z.object({ kind: z.literal('parts'), parts: z.array(AnswerPart).min(2) }),
])
export type Answer = z.infer<typeof Answer>

/** Problem tiers (docs/assess/design.md): 1 your material, 2 authoritative, 3 adapted (labelled), 4 agent-written (practice only). */
export const ProblemTier = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])

export const ProblemOrigin = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chunk'), chunkId: idOf('chunk'), locator: Locator.optional(), label: z.string() }),
  z.object({ kind: z.literal('web'), url: z.url(), label: z.string() }),
  z.object({ kind: z.literal('agent') }),
])

/** check: one step, for diagnostics and quick checks; standard: an ordinary exercise; task: a complete task for a stage test. */
export const ProblemSize = z.enum(['check', 'standard', 'task'])
export type ProblemSize = z.infer<typeof ProblemSize>

/** The calculator run that produced or checked the answer (docs/assess/design.md, A). */
export const Calculation = z.object({
  script: z.string(),
  /** Variables holding the answer, one per part. */
  results: z.array(z.string()).min(1),
  /** Each line's value as the calculator printed it. */
  lines: z.array(z.string()),
  at: instant,
})
export type Calculation = z.infer<typeof Calculation>

export const Problem = z.object({
  id: idOf('problem'),
  stem: z.string(),
  /** Images, relative to the data root. */
  media: z.array(relativePath).default([]),
  /** Figure chunks of the source, shown cropped (never the whole page, which prints the answer). */
  figures: z.array(idOf('chunk')).default([]),
  answer: Answer,
  /** book: printed answer; authority: authoritative source; calculated: computed by the calculator tool; unverified: agent's own solution. */
  answerSource: z.enum(['book', 'authority', 'calculated', 'unverified']),
  tier: ProblemTier,
  origin: ProblemOrigin,
  /** The exercise number in its source, e.g. `1-25`. */
  ref: z.string().optional(),
  /** One problem per source exercise: `<sourceId>#<ref>` for imported exercises. */
  sourceKey: z.string().optional(),
  adaptedFrom: idOf('problem').optional(),
  size: ProblemSize.default('standard'),
  calculation: Calculation.optional(),
  nodeIds: z.array(idOf('node')).min(1),
  pool: z.enum(['practice', 'test-reserved']),
  status: z.enum(['active', 'under-review', 'retired']),
  /** Why the problem is under review (e.g. the calculator disagrees with the printed answer). */
  review: z.object({ reason: z.string(), at: instant }).optional(),
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
  /** The learner checked and possibly corrected the transcription before grading (docs/assess/design.md). */
  confirmedAt: instant.optional(),
  edited: z.boolean().default(false),
})

/** One answer as submitted. Never changes; grading is appended separately. */
export const Attempt = z.object({
  id: idOf('attempt'),
  problemId: idOf('problem'),
  testId: idOf('test').optional(),
  courseId: idOf('course'),
  /** Working and steps; graded only for open answers. */
  text: z.string().default(''),
  /** The final answer typed into each answer box, one per part; numeric and choice answers are graded from these. */
  finals: z.array(z.string()).default([]),
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
  /** Per-part verdicts of a several-part problem. */
  parts: z.array(z.object({ label: z.string(), verdict: Verdict, score: z.number().min(0).max(1).optional(), rationale: z.string() })).optional(),
})
export type Grading = z.infer<typeof Grading>
