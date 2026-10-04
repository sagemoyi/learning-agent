// Course and progress objects (contracts §4.3).
import { z } from 'zod'
import { idOf, instant, relativePath, sessionId } from './common.ts'

export const CourseStatus = z.enum(['active', 'finished', 'archived'])

/** One course = one folder = one DSH workspace. Owner: core. */
export const Course = z.object({
  id: idOf('course'),
  title: z.string().min(1),
  /** Folder name under `courses/`. */
  slug: z.string().min(1),
  workspaceId: z.string(),
  status: CourseStatus,
  createdAt: instant,
})
export type Course = z.infer<typeof Course>

/** Test conditions: the default lives in the goal; each test may choose its own. */
export const TestConditions = z.object({
  book: z.enum(['closed', 'open']),
  calculator: z.boolean(),
  formulaSheet: z.boolean(),
  /** Minutes, when timed. */
  timeLimit: z.number().int().positive().optional(),
})
export type TestConditions = z.infer<typeof TestConditions>

/** Exam profile: optional goal attribute (PLAN §4.12). */
export const ExamProfile = z.object({
  scope: z.string(),
  format: z.string(),
  conditions: TestConditions,
  date: z.iso.date().optional(),
  pastPaperSourceIds: z.array(idOf('source')).default([]),
  /** What the learner wants from the exam course. */
  focus: z.enum(['pass', 'balanced', 'understanding']),
})
export type ExamProfile = z.infer<typeof ExamProfile>

/**
 * Goal statement: the structured fields live in `goal.md`'s frontmatter, prose in its body.
 * Owner: goal. Versions are kept by core's change log.
 */
export const GoalFrontmatter = z.object({
  status: z.enum(['draft', 'confirmed']),
  purpose: z.string(),
  scenario: z.string(),
  canDo: z.array(z.string()),
  level: z.string(),
  verification: z.string(),
  boundaries: z.object({
    exclude: z.array(z.string()).default([]),
    defaultConditions: TestConditions,
    timeBudget: z.string().optional(),
  }),
  deadline: z.iso.date().optional(),
  exam: ExamProfile.optional(),
})
export type GoalFrontmatter = z.infer<typeof GoalFrontmatter>

/** Stage lifecycle (contracts §4.3). */
export const StageStatus = z.enum(['planned', 'designing', 'ready', 'learning', 'testing', 'reviewing', 'done'])
export type StageStatus = z.infer<typeof StageStatus>

/** Owner: curriculum. */
export const Stage = z.object({
  id: idOf('stage'),
  courseId: idOf('course'),
  index: z.number().int().positive(),
  title: z.string(),
  objective: z.string(),
  kind: z.enum(['normal', 'remedial']),
  status: StageStatus,
  /** This stage's teacher session (one per stage). */
  sessionId: sessionId.optional(),
  /** When the learner confirmed the stage design; textbook generation starts then. */
  designConfirmedAt: instant.optional(),
  /** Folder under the course, e.g. `stages/01-流体流动`. */
  folder: relativePath,
})
export type Stage = z.infer<typeof Stage>

export const LessonStatus = z.enum(['not-started', 'in-progress', 'done'])

/** A lesson is one textbook subsection. Owner: curriculum. */
export const Lesson = z.object({
  id: idOf('lesson'),
  stageId: idOf('stage'),
  index: z.number().int().positive(),
  /** Subsection number as the textbook shows it, e.g. `1.3`. */
  number: z.string(),
  title: z.string(),
  status: LessonStatus,
  /** Textbook file, relative to the course folder. */
  textbookFile: relativePath.optional(),
  /** Lesson record (quiz result, report, teacher summary), relative to the course folder. */
  recordFile: relativePath.optional(),
})
export type Lesson = z.infer<typeof Lesson>

export const TaskKind = z.enum(['predict', 'read', 'quiz', 'practice', 'report', 'stage-test', 'review', 'other'])
export const TaskStatus = z.enum(['open', 'done', 'skipped'])

/** Owner: curriculum. Published by the teacher; shown in chat and on the progress page. */
export const Task = z.object({
  id: idOf('task'),
  courseId: idOf('course'),
  stageId: idOf('stage').optional(),
  lessonId: idOf('lesson').optional(),
  kind: TaskKind,
  title: z.string(),
  instructions: z.string(),
  status: TaskStatus,
  createdBy: z.enum(['teacher', 'user', 'system']),
  createdAt: instant,
  doneAt: instant.optional(),
  /** What finishing produced, e.g. a test id. */
  result: z.object({ kind: z.string(), id: z.string() }).optional(),
})
export type Task = z.infer<typeof Task>
