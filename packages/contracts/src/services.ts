// Host services of the feature units (contracts §5.1). `learnCore` lives in core.ts.
// Units reach each other only through these interfaces (`ctx.learnGoal`, …), never by importing code.
// Skeleton versions: each service carries just what the stage-0 minimal flow needs; units grow them
// when they are built out. Ids are plain strings here; the zod schemas brand them where data is stored.
import type {} from '@deepseek-ai/cordis'
import type { Attempt, Grading, Problem, Test } from './schema/assess.ts'
import type { GoalFrontmatter, Lesson, Stage, Task, TestConditions } from './schema/course.ts'
import type { NodeState } from './schema/evidence.ts'
import type { EdgeType, KnowledgeEdge, KnowledgeNode, NodeKind, NodeLink } from './schema/knowledge.ts'
import type { Chunk, ChunkKind, CourseSource, Source, LibraryImport, WebCandidate } from './schema/library.ts'
import type { Selection } from './schema/selection.ts'
import type { SideChatSummary } from './schema/session.ts'
import type { Block } from './schema/textbook.ts'
import type { ChangeMeta } from './core.ts'

// ── library ──────────────────────────────────────────────────────────────────

/** A chunk with the citation label pages and the model see, e.g. `《化工原理》第3版 p.14`. */
export type CitedChunk = Chunk & { readonly citation: string }

export interface SearchHit {
  readonly chunk: CitedChunk
  /** Lower is better (FTS5 bm25; fused rank for hybrid retrieval). */
  readonly rank: number
  /** Reranker relevance 0–1, when a reranker scored the hit. */
  readonly relevance?: number
}

/** Result of `retrieve`: hybrid when an embedding service is configured, otherwise full text. */
export interface Retrieval {
  readonly hits: SearchHit[]
  readonly mode: 'hybrid' | 'fulltext'
  /** Nothing in the material answers the query well; callers say so instead of filling the gap. */
  readonly gap: boolean
  /** Why retrieval fell back or is partial (index still building, service unavailable). */
  readonly note?: string
}

/** Semantic index of one source (embedding vectors of its chunks). */
export interface IndexState {
  readonly state: 'off' | 'waiting' | 'indexing' | 'ready' | 'failed'
  readonly done: number
  readonly total: number
  readonly model?: string
  readonly message?: string
}

/** Result of `searchWeb`: candidates that may become sources, and clues that may only point somewhere. */
export interface WebSearch {
  /** Authority 1–3, best first; at most two per organization. */
  readonly candidates: WebCandidate[]
  readonly clues: WebCandidate[]
  /** Fallbacks and failures, e.g. which search service stood in for which. */
  readonly notes: string[]
}

/** What became of one address handed to `addWeb`. */
export interface WebAdded {
  readonly url: string
  /** added: citable now; importing: a PDF parsing in the background; pending: waits for the learner; rejected: never a source; failed: could not be fetched or read. */
  readonly status: 'added' | 'importing' | 'pending' | 'rejected' | 'failed'
  readonly message: string
  readonly sourceId?: string
}

export interface ImportParsedInput {
  readonly title: string
  readonly kind: Source['kind']
  readonly authority: Source['authority']
  /** Original file (copied into the source folder). */
  readonly file: string
  /** MinerU `docvortex.middle` JSON files (page ranges of the same file), merged by page. */
  readonly parsed: readonly string[]
  /** Printed page = PDF page − offset. */
  readonly pageOffset?: number
  /** Attach to a course right away. */
  readonly courseId?: string
  readonly role?: CourseSource['role']
}

export interface LearnLibrary {
  imports(): LibraryImport[]
  retryImport(id: string): void
  cancelImport(id: string): void
  reparse(sourceId: string, courseId?: string): LibraryImport
  setPageOffset(sourceId: string, offset: number): Source
  sources(): Source[]
  source(sourceId: string): Source | undefined
  /** Import pages a parser already produced (skeleton: MinerU output on disk). */
  importParsed(input: ImportParsedInput): Promise<Source>
  attach(courseId: string, sourceId: string, role: CourseSource['role']): void
  courseSources(courseId: string): (CourseSource & { readonly source: Source })[]
  /** Hybrid retrieval: full text and embeddings fused, then reranked; falls back to full text. */
  retrieve(query: string, options?: { readonly courseId?: string; readonly kinds?: readonly ChunkKind[]; readonly limit?: number }): Promise<Retrieval>
  indexState(sourceId: string): IndexState
  /** Full-text search; `courseId` limits it to that course's sources. */
  search(query: string, options?: { readonly courseId?: string; readonly kinds?: readonly ChunkKind[]; readonly limit?: number }): SearchHit[]
  chunk(chunkId: string): CitedChunk | undefined
  /** Chunks whose section path contains `section` (e.g. `1.1`), in reading order. */
  section(sourceId: string, section: string): CitedChunk[]
  /** Section headings of a source, in reading order. */
  outline(sourceId: string): { readonly section: readonly string[]; readonly chunkId: string }[]
  /** Search the web for each question, rated by site rules; results are not sources until added. */
  searchWeb(questions: readonly string[], options?: { readonly signal?: AbortSignal }): Promise<WebSearch>
  /**
   * Add pages or PDFs found online to a course. Authority 1–2 is citable at once; 3 waits for the
   * learner when the teacher adds it, while `by: 'learner'` is the learner's own pick. Clues and
   * blocked sites are rejected.
   */
  addWeb(courseId: string, items: readonly { readonly url: string; readonly title?: string; readonly reason?: string }[], by: 'teacher' | 'learner', signal?: AbortSignal): Promise<WebAdded[]>
}

// ── knowledge ────────────────────────────────────────────────────────────────

export interface NewNode {
  readonly title: string
  readonly kind: NodeKind
  readonly description?: string
  readonly aliases?: readonly string[]
}

export interface NewEdge {
  /** Node id or title. */
  readonly from: string
  readonly to: string
  readonly type: EdgeType
  readonly rationale?: string
}

export interface CourseGraph {
  readonly nodes: (KnowledgeNode & { readonly role: 'core' | 'related' })[]
  readonly edges: KnowledgeEdge[]
}

export interface LearnKnowledge {
  /** Add nodes to a course (existing titles are reused) and edges between them. */
  add(courseId: string, input: { readonly nodes: readonly NewNode[]; readonly edges?: readonly NewEdge[] }, meta: ChangeMeta): Promise<CourseGraph>
  graph(courseId: string): CourseGraph
  node(nodeId: string): KnowledgeNode | undefined
  /** Find a node of the course by id, title or alias. */
  resolve(courseId: string, ref: string): KnowledgeNode | undefined
  link(links: readonly NodeLink[]): void
  links(nodeId: string): NodeLink[]
}

// ── goal ─────────────────────────────────────────────────────────────────────

export interface GoalDoc {
  readonly courseId: string
  readonly goal: GoalFrontmatter
  /** Prose part of `goal.md`. */
  readonly body: string
}

export interface LearnGoal {
  get(courseId: string): Promise<GoalDoc | undefined>
  saveDraft(courseId: string, goal: Omit<GoalFrontmatter, 'status'>, body: string, meta: ChangeMeta): Promise<GoalDoc>
  /** Draft → confirmed; emits `learning/goal-confirmed`. */
  confirm(courseId: string): Promise<GoalDoc>
}

// ── assess ───────────────────────────────────────────────────────────────────

export type NewProblem = Omit<Problem, 'id' | 'createdAt' | 'status' | 'media'> & { readonly media?: readonly string[] }

export interface StartTestInput {
  readonly courseId: string
  readonly kind: Test['kind']
  readonly stageId?: string
  readonly lessonId?: string
  /** Explicit problems; otherwise picked from `nodeIds` (unseen first). */
  readonly problemIds?: readonly string[]
  readonly nodeIds?: readonly string[]
  readonly count?: number
  readonly conditions?: TestConditions
}

export interface GradedAttempt extends Attempt {
  readonly grading?: Grading
}

export interface TestView {
  readonly test: Test
  /** Answers are stripped while the test is open; choice problems keep their options. */
  readonly problems: (Omit<Problem, 'answer'> & { readonly answer?: Problem['answer']; readonly options?: readonly string[] })[]
  readonly attempts: GradedAttempt[]
}

export interface LearnAssess {
  addProblems(problems: readonly NewProblem[]): Problem[]
  problem(problemId: string): Problem | undefined
  problems(filter: { readonly nodeIds?: readonly string[]; readonly pool?: Problem['pool'] }): Problem[]
  startTest(input: StartTestInput): Test
  view(testId: string): TestView | undefined
  tests(courseId: string, filter?: { readonly lessonId?: string; readonly kind?: Test['kind'] }): Test[]
  /** Store the answers, grade them, append evidence; emits `learning/test-finished`. */
  submit(testId: string, answers: readonly { readonly problemId: string; readonly text: string }[], signal?: AbortSignal): Promise<TestView>
}

// ── curriculum ───────────────────────────────────────────────────────────────

export interface LearnCurriculum {
  stages(courseId: string): Stage[]
  stage(stageId: string): Stage | undefined
  /** The stage in progress: the first one that is not done. */
  currentStage(courseId: string): Stage | undefined
  /** Write `roadmap.md` and create/rename the planned stages. */
  saveRoadmap(courseId: string, stages: readonly { readonly title: string; readonly objective: string }[], meta: ChangeMeta): Promise<Stage[]>
  /** Write the stage's `design.md` and its lessons; the stage becomes `designing`. */
  saveDesign(stageId: string, input: { readonly markdown: string; readonly lessons: readonly { readonly number: string; readonly title: string }[] }, meta: ChangeMeta): Promise<{ readonly stage: Stage; readonly lessons: Lesson[] }>
  /** The learner confirmed the design; textbook generation follows. */
  confirmDesign(stageId: string): Promise<Stage>
  setStatus(stageId: string, status: Stage['status']): Stage
  setStageSession(stageId: string, sessionId: string): Stage
  lessons(stageId: string): Lesson[]
  lesson(lessonId: string): Lesson | undefined
  setLessonStatus(lessonId: string, status: Lesson['status']): Lesson
  publishTask(input: Omit<Task, 'id' | 'status' | 'createdAt' | 'doneAt'>): Task
  completeTask(taskId: string, result?: Task['result']): Task
  tasks(courseId: string, filter?: { readonly status?: Task['status']; readonly lessonId?: string }): Task[]
}

// ── textbook ─────────────────────────────────────────────────────────────────

export type BlockWithText = Block & { readonly text: string }

/** Where one lesson's textbook stands. `failed` is the last attempt's outcome (kept in memory). */
export interface LessonTextbookStatus {
  readonly state: 'missing' | 'running' | 'ready' | 'failed'
  /** Progress while running, the reason when failed. */
  readonly message?: string
  readonly blocks?: number
  readonly unverified?: number
  /** Failed attempts in a row since the last success. */
  readonly failures?: number
}

export interface LearnTextbook {
  /** Generate (or regenerate) one lesson's textbook file in the background; emits `learning/textbook-ready` or `-failed`. */
  generateLesson(lessonId: string): Promise<void>
  /** Generate every lesson of a stage, in lesson order, so the first lesson is ready first. */
  generateStage(stageId: string): Promise<void>
  /** In-flight generation, by lesson id. */
  running(): readonly string[]
  status(lessonId: string): LessonTextbookStatus
  blocks(courseId: string, file?: string): Block[]
  block(courseId: string, blockId: string): Promise<BlockWithText | undefined>
}

// ── learner ──────────────────────────────────────────────────────────────────

export interface LearnLearner {
  states(nodeIds?: readonly string[]): NodeState[]
  /** Recompute from the evidence log (all nodes when omitted). */
  recompute(nodeIds?: readonly string[]): NodeState[]
  readonly rulesVersion: string
}

// ── sidechat ─────────────────────────────────────────────────────────────────

export interface LearnSidechat {
  /** Open a side chat bound to the page and selection; returns the DSH session id. */
  open(selection: Selection): Promise<{ readonly sessionId: string }>
  /** End it: read the record, write the summary, log signals and help. */
  close(sessionId: string, signal?: AbortSignal): Promise<SideChatSummary>
}

// ── tutor ────────────────────────────────────────────────────────────────────

export interface LearnTutor {
  /** The teacher session for the course's current stage (created on first use). */
  session(courseId: string): Promise<string>
  /** The per-turn course brief, assembled from every unit's `learning/course-brief` section. */
  brief(courseId: string, sessionId: string): Promise<string>
  /** Write the lesson record (`lessons/<n>.md`: quiz results, the learner's report, the summary) and mark the lesson done. */
  writeLessonSummary(lessonId: string, record: { readonly summary: string; readonly learnerReport?: string }, meta: ChangeMeta): Promise<void>
}

// ── planner ──────────────────────────────────────────────────────────────────

export interface NextStep {
  readonly courseId: string
  /** Who acts next. */
  readonly actor: 'learner' | 'teacher'
  readonly title: string
  readonly detail: string
  /** Page that helps, e.g. `assess.test`. */
  readonly page?: string
  readonly params?: Readonly<Record<string, unknown>>
}

export interface LearnPlanner {
  next(courseId: string): Promise<NextStep>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    learnLibrary: LearnLibrary
    learnKnowledge: LearnKnowledge
    learnGoal: LearnGoal
    learnAssess: LearnAssess
    learnCurriculum: LearnCurriculum
    learnTextbook: LearnTextbook
    learnLearner: LearnLearner
    learnSidechat: LearnSidechat
    learnTutor: LearnTutor
    learnPlanner: LearnPlanner
  }
}
