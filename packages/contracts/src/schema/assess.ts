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
  /** The exam's question type (题型), e.g. 计算题; past-paper problems take their section's. Mock exams are assembled by it. */
  type: z.string().optional(),
  /** Points the source paper gives the problem. */
  points: z.number().nonnegative().optional(),
  /** Past-paper problems: the paper's title (docs/assess/design.md, C). */
  paper: z.string().optional(),
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

/** `pretest`: the few questions at the start of a stage (from stage 2; stage 1 has the course's diagnostic). */
/** `final`: the check at the end of a course, one or more problems per goal "can do" item (docs/curriculum/design.md). */
export const TestKind = z.enum(['diagnostic', 'pretest', 'quiz', 'practice', 'stage', 'review', 'mock', 'final'])
export type TestKind = z.infer<typeof TestKind>

export const TEST_KIND_LABEL: Record<TestKind, string> = { diagnostic: '摸底', pretest: '前测', quiz: '小测', practice: '练习', stage: '阶段测试', review: '复查', mock: '模拟考', final: '结课检验' }

/** A knowledge node as a test saw it when it started: title, hard prerequisites within the test's scope, merged identities. */
export const ProbeNode = z.object({
  id: idOf('node'),
  title: z.string(),
  requires: z.array(idOf('node')).default([]),
  /** Identities merged into this node: their problems count for it. */
  also: z.array(idOf('node')).default([]),
})
export type ProbeNode = z.infer<typeof ProbeNode>

/** What a stage test was assembled from (docs/assess/design.md, B); results are given per core node. */
export const StagePlan = z.object({
  core: z.array(ProbeNode),
  earlier: z.array(ProbeNode).default([]),
  /** Problems new to the learner when they were put in the test. */
  fresh: z.array(idOf('problem')),
  task: idOf('problem').optional(),
  /** Core nodes without a new reserved problem. */
  uncovered: z.array(idOf('node')).default([]),
  /** The goal's "can do" items the stage supports, as worded then. */
  goals: z.array(z.object({ key: z.string(), text: z.string() })).default([]),
})
export type StagePlan = z.infer<typeof StagePlan>

/** What a mock exam was assembled from: the exam's question types, each with its problems (docs/assess/design.md, C). */
export const MockPaper = z.object({
  /** The exam's in-scope nodes when the test started; wrong answers are reported by them. */
  nodes: z.array(ProbeNode).default([]),
  sections: z.array(z.object({
    type: z.string(),
    /** The section's total points; absent counts each problem as one point. */
    points: z.number().nonnegative().optional(),
    /** Problems the exam asks of this type. */
    count: z.number().int().positive(),
    problemIds: z.array(idOf('problem')),
  })),
})
export type MockPaper = z.infer<typeof MockPaper>

/** What a final check was assembled from: the goal's items with their nodes and problems, and the nodes earlier reviews carried on. */
export const FinalPlan = z.object({
  items: z.array(z.object({
    key: z.string(),
    text: z.string(),
    /** Core nodes of the stages that build towards the item. */
    nodes: z.array(ProbeNode),
    problemIds: z.array(idOf('problem')),
  })),
  risks: z.array(ProbeNode).default([]),
  /** Items without a new reserved problem: not checked. */
  uncovered: z.array(z.string()).default([]),
  /** The course's stages when it was published: a stage added later needs a new final check. */
  stageIds: z.array(idOf('stage')).default([]),
})
export type FinalPlan = z.infer<typeof FinalPlan>

export const Test = z.object({
  id: idOf('test'),
  courseId: idOf('course'),
  stageId: idOf('stage').optional(),
  lessonId: idOf('lesson').optional(),
  kind: TestKind,
  conditions: TestConditions,
  problemIds: z.array(idOf('problem')),
  swapLimit: z.number().int().nonnegative(),
  /**
   * Diagnostics and pretests: the nodes probed. `adaptive` tests show one problem at a time and pick the
   * next along the prerequisites, up to `max` problems.
   */
  scope: z.object({ nodes: z.array(ProbeNode), adaptive: z.boolean(), max: z.number().int().positive() }).optional(),
  plan: StagePlan.optional(),
  mock: MockPaper.optional(),
  final: FinalPlan.optional(),
  status: z.enum(['open', 'submitted', 'graded', 'abandoned']),
  startedAt: instant,
  /** A timed test starts when the learner presses "开始": problems are shown and the clock runs from here. */
  openedAt: instant.optional(),
  endedAt: instant.optional(),
  /** Minutes past the time limit when it was handed in. */
  overtime: z.number().int().positive().optional(),
})
export type Test = z.infer<typeof Test>

/** The final check of the course as it is now: the latest one not withdrawn that covers every stage. */
export function currentFinal<T extends Pick<Test, 'kind' | 'status' | 'final'>>(tests: readonly T[], stageIds: readonly string[]): T | undefined {
  return tests.filter(test => test.kind === 'final' && test.status !== 'abandoned' && stageIds.every(id => (test.final?.stageIds as readonly string[] | undefined)?.includes(id))).at(-1)
}

export const Transcription = z.object({
  text: z.string(),
  /** The learner checked and possibly corrected the transcription before grading (docs/assess/design.md). */
  confirmedAt: instant.optional(),
  /** Differs from the first recognition (working or final answers). */
  edited: z.boolean().default(false),
})
export type Transcription = z.infer<typeof Transcription>

/** One reading of a problem's handwriting photos: the working, the final answer per answer box, and unsure spots. */
export const Recognition = z.object({
  working: z.string(),
  finals: z.array(z.string()).default([]),
  doubts: z.array(z.string()).default([]),
})
export type Recognition = z.infer<typeof Recognition>

/** One answer as submitted. Never changes; grading is appended separately. */
export const Attempt = z.object({
  id: idOf('attempt'),
  problemId: idOf('problem'),
  testId: idOf('test').optional(),
  courseId: idOf('course'),
  /** Working and steps; graded only for open answers. */
  text: z.string().default(''),
  /** The learner pressed "不会" (diagnostics). */
  gaveUp: z.boolean().default(false),
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
  /** `learner`: the learner's own "不会"; `teacher`: the teacher's regrade. */
  method: z.enum(['rule', 'llm', 'learner', 'teacher']),
  /** Model's own confidence for llm grading; low confidence → pending-review. */
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  rationale: z.string().default(''),
  /** Per-part verdicts of a several-part problem. */
  parts: z.array(z.object({ label: z.string(), verdict: Verdict, score: z.number().min(0).max(1).optional(), rationale: z.string() })).optional(),
})
export type Grading = z.infer<typeof Grading>

/** Why the learner flagged a problem during a test (docs/assess/design.md, B). */
export const ReportReason = z.enum(['wrong', 'incomplete', 'out-of-scope', 'answer-doubtful', 'done-before'])
export type ReportReason = z.infer<typeof ReportReason>

export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  wrong: '题目有错', incomplete: '条件不全', 'out-of-scope': '超出范围', 'answer-doubtful': '答案存疑', 'done-before': '这题我做过',
}

/** A flagged problem: not scored in that test, swapped while the limit allows; the teacher's check is the outcome. */
export const ProblemReport = z.object({
  id: idOf('report'),
  courseId: idOf('course'),
  testId: idOf('test'),
  problemId: idOf('problem'),
  reason: ReportReason,
  note: z.string().default(''),
  /** The problem put in its place; absent when it was skipped. */
  replacedBy: idOf('problem').optional(),
  at: instant,
  /** keep: the problem is fine; fixed: corrected; retired: no longer used. */
  outcome: z.object({ action: z.enum(['keep', 'fixed', 'retired']), note: z.string(), at: instant }).optional(),
})
export type ProblemReport = z.infer<typeof ProblemReport>

/** The learner disputes a grading; the teacher regrades it or keeps it, with a reason. */
export const Appeal = z.object({
  id: idOf('appeal'),
  courseId: idOf('course'),
  testId: idOf('test').optional(),
  attemptId: idOf('attempt'),
  problemId: idOf('problem'),
  text: z.string(),
  at: instant,
  outcome: z.object({ verdict: Verdict, changed: z.boolean(), note: z.string(), at: instant }).optional(),
})
export type Appeal = z.infer<typeof Appeal>
