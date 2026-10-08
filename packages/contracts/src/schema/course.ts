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

/** Test conditions in words, e.g. 闭卷 · 可用计算器 · 不带公式表. */
export function conditionWords(c: TestConditions): string[] {
  return [c.book === 'closed' ? '闭卷' : '开卷', c.calculator ? '可用计算器' : '不用计算器', c.formulaSheet ? '可带公式表' : '不带公式表', ...(c.timeLimit ? [`限时 ${c.timeLimit} 分钟`] : [])]
}

/** One question type of an exam, e.g. 计算题 60 分. */
export const ExamItem = z.object({
  type: z.string().min(1),
  points: z.number().nonnegative().optional(),
  note: z.string().optional(),
})
export type ExamItem = z.infer<typeof ExamItem>

/** Exam profile: optional goal attribute (docs/goal/design.md). */
export const ExamProfile = z.object({
  scope: z.string(),
  /** Skeleton-textbook sections in scope, e.g. "1.2". */
  sections: z.array(z.string()).default([]),
  format: z.array(ExamItem).default([]),
  /** How the course grade is made up, e.g. 平时 30%、期末 70%. */
  grading: z.string().optional(),
  conditions: TestConditions,
  date: z.iso.date().optional(),
  pastPaperSourceIds: z.array(idOf('source')).default([]),
  /** What the learner wants from the exam course. */
  focus: z.enum(['pass', 'balanced', 'understanding']),
})
export type ExamProfile = z.infer<typeof ExamProfile>
export type ExamProfileInput = z.input<typeof ExamProfile>

/**
 * Goal fields that are facts rather than the learner's choices. Each carries where it came from;
 * the learner may confirm or edit them on the page without confirming the goal again.
 */
export const GoalFact = z.enum(['conditions', 'hours', 'deadline', 'exam.date', 'exam.scope', 'exam.format', 'exam.grading', 'exam.conditions'])
export type GoalFact = z.infer<typeof GoalFact>

/** `assumed` is the teacher's guess awaiting the learner; `official` was read from a passage of the course's sources. */
export const FactBasis = z.enum(['official', 'learner', 'assumed'])
export type FactBasis = z.infer<typeof FactBasis>

export const FactSource = z.object({
  basis: FactBasis,
  /** The passage an official fact was read from. */
  chunkId: idOf('chunk').optional(),
})
export type FactSource = z.infer<typeof FactSource>

/** One "can do after learning" item. Stage designs and the final check cite it by key; the key survives rewording and is never shown to the learner. */
export const CanDo = z.object({
  key: z.string().regex(/^c\d+$/),
  text: z.string().min(1),
  /** How this item is verified, when the goal's verification does not cover it. */
  evidence: z.string().optional(),
})
export type CanDo = z.infer<typeof CanDo>

/** A material the course still needs (the goal's source checklist). The sources already in the course are not listed. */
export const SourceNeed = z.object({
  key: z.string().regex(/^s\d+$/),
  /** What it is, e.g. 学校的教学大纲. */
  what: z.string().min(1),
  /** Why the course needs it. */
  why: z.string().default(''),
  role: z.enum(['skeleton', 'reference', 'exam-archive']),
  /** Who gets it: the learner provides it, or the teacher looks for it online. */
  by: z.enum(['learner', 'teacher']),
  /** The course source that fulfils it. */
  sourceId: idOf('source').optional(),
  /** The learner said there is no such material. */
  missing: z.boolean().optional(),
})
export type SourceNeed = z.infer<typeof SourceNeed>

/** Items without a key take the next free one with `prefix`, in order; skeleton goal files store "can do" items as plain strings. */
function keyed(prefix: string) {
  return (items: unknown): unknown => {
    if (!Array.isArray(items)) return items
    const objects = items.map(item => (typeof item === 'string' ? { text: item } : item) as { key?: unknown } | null)
    const pattern = new RegExp(`^${prefix}(\\d+)$`)
    let next = Math.max(0, ...objects.map(item => Number(pattern.exec(String(item?.key ?? ''))?.[1] ?? 0))) + 1
    return objects.map(item => (item && typeof item === 'object' && !item.key ? { ...item, key: `${prefix}${next++}` } : item))
  }
}

/**
 * Goal statement: the structured fields live in `goal.md`'s frontmatter, prose in its body.
 * Owner: goal. Versions are kept by core's change log.
 */
export const GoalFrontmatter = z.object({
  status: z.enum(['draft', 'confirmed']),
  /** Raised on every write; the teacher revises against it. */
  version: z.number().int().positive().default(1),
  purpose: z.string(),
  scenario: z.string(),
  canDo: z.preprocess(keyed('c'), z.array(CanDo)),
  level: z.string(),
  verification: z.string(),
  boundaries: z.object({
    exclude: z.array(z.string()).default([]),
    defaultConditions: TestConditions,
    timeBudget: z.string().optional(),
    /** Hours per week as a range, for judging the deadline. */
    hoursPerWeek: z.object({ min: z.number().positive(), max: z.number().positive() }).optional(),
  }),
  deadline: z.iso.date().optional(),
  exam: ExamProfile.optional(),
  /** Where each fact came from; a fact without an entry is the teacher's guess. */
  facts: z.partialRecord(GoalFact, FactSource).default({}),
  sources: z.preprocess(keyed('s'), z.array(SourceNeed)).default([]),
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
  /** Keys of the goal's "can do" items this stage builds towards. */
  supports: z.array(z.string()).default([]),
  /** The stage's core knowledge nodes: its stage test covers each (docs/assess/design.md, B). */
  nodeIds: z.array(idOf('node')).default([]),
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
