// Host services of the feature units (contracts §5.1). `learnCore` lives in core.ts.
// Units reach each other only through these interfaces (`ctx.learnGoal`, …), never by importing code.
// Skeleton versions: each service carries just what the stage-0 minimal flow needs; units grow them
// when they are built out. Ids are plain strings here; the zod schemas brand them where data is stored.
import type {} from '@deepseek-ai/cordis'
import type { Attempt, Grading, Problem, Test } from './schema/assess.ts'
import type { GoalFrontmatter, Lesson, Stage, Task, TestConditions } from './schema/course.ts'
import type { NodeState } from './schema/evidence.ts'
import type { CourseNode, EdgeType, KnowledgeEdge, KnowledgeNode, NodeKind, NodeLink, RelationScope, RelationStatus, KnowledgeNodePatch, KnowledgeEdgePatch, KnowledgeMembershipPatch } from './schema/knowledge.ts'
import type { Chunk, ChunkKind, CourseSource, Source, LibraryImport, WebCandidate } from './schema/library.ts'
import type { Selection } from './schema/selection.ts'
import type { SideChatSummary } from './schema/session.ts'
import type { Block } from './schema/textbook.ts'
import type { ChangeMeta } from './core.ts'
import type { Change } from './schema/session.ts'

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
  readonly domain?: string
  readonly conditions?: string
  readonly reuseId?: string
  readonly sources?: readonly string[]
}

export interface NewEdge {
  /** Node id or title. */
  readonly from: string
  readonly to: string
  readonly type: EdgeType
  readonly rationale?: string
  readonly sources?: readonly string[]
  readonly scope?: RelationScope
  readonly conditions?: string
  readonly status?: Extract<RelationStatus, 'draft' | 'valid' | 'disputed'>
}

export interface CourseGraph {
  readonly nodes: (KnowledgeNode & { readonly role: 'core' | 'related'; readonly membership: CourseNode; readonly courseCount: number })[]
  readonly edges: (KnowledgeEdge & { readonly usable?: boolean; readonly issue?: string })[]
  readonly operationId?: string
  readonly replayed?: boolean
}

export interface KnowledgeOperation {
  readonly id: string
  readonly courseId: string
  readonly at: string
  readonly actor: Change['actor']
  readonly reason: string
  readonly changeIds: readonly string[]
  readonly revertOf?: string
  readonly revertedBy?: string
}

export interface KnowledgeDetail {
  readonly node: KnowledgeNode
  readonly memberships: readonly CourseNode[]
  readonly edges: readonly (KnowledgeEdge & { readonly usable?: boolean; readonly issue?: string })[]
  readonly links: readonly (NodeLink & { readonly label: string; readonly citation?: string; readonly available: boolean })[]
  readonly changes: readonly Change[]
  readonly titles: Readonly<Record<string, string>>
  readonly citations: Readonly<Record<string, string>>
}

/** Every course's active nodes and relations, for the knowledge graph on the main screen. */
export interface KnowledgeGlobal {
  readonly nodes: readonly (KnowledgeNode & { readonly courseIds: readonly string[] })[]
  readonly edges: readonly (KnowledgeEdge & { readonly usable?: boolean; readonly issue?: string })[]
  readonly courses: readonly { readonly id: string; readonly title: string }[]
}

/** Where nodes are explained, grouped by material, for the graph's source overlay. Problems stay out. */
export interface KnowledgeSourceLayer {
  readonly sources: readonly {
    readonly id: string
    readonly title: string
    readonly links: readonly { readonly nodeId: string; readonly chunks: readonly { readonly id: string; readonly citation: string }[] }[]
  }[]
  /** Nodes that a course's textbook paragraphs explain, one entry per course. */
  readonly textbooks: readonly { readonly courseId: string; readonly nodeIds: readonly string[] }[]
}

export interface LearnKnowledge {
  /** New identities by default; reuse requires an explicit id. requestId makes retries idempotent. */
  add(courseId: string, input: { readonly requestId?: string; readonly nodes: readonly NewNode[]; readonly edges?: readonly NewEdge[] }, meta: ChangeMeta): Promise<CourseGraph>
  graph(courseId: string): CourseGraph
  node(nodeId: string): KnowledgeNode | undefined
  /** Find a node of the course by id, title or alias. */
  resolve(courseId: string, ref: string): KnowledgeNode | undefined
  candidates(ref: string, courseId?: string): KnowledgeNode[]
  editNode(courseId: string, nodeId: string, version: number, patch: KnowledgeNodePatch, meta: ChangeMeta): KnowledgeOperation
  editEdge(courseId: string, edgeId: string, version: number, patch: KnowledgeEdgePatch, meta: ChangeMeta): KnowledgeOperation
  setMembership(courseId: string, nodeId: string, version: number, patch: KnowledgeMembershipPatch, meta: ChangeMeta): KnowledgeOperation
  /** A source owner may register links after its target is committed or inside the same transaction. */
  link(links: readonly (Pick<NodeLink, 'nodeId' | 'target' | 'relation'> & Partial<Pick<NodeLink, 'version' | 'status'>>)[], meta?: ChangeMeta, courseId?: string): KnowledgeOperation | undefined
  links(nodeId: string): NodeLink[]
  unlink(courseId: string, link: NodeLink, meta: ChangeMeta): KnowledgeOperation
  history(courseId: string): KnowledgeOperation[]
  operationDetails(courseId: string, operationId: string): { readonly operation: KnowledgeOperation; readonly changes: readonly Change[]; readonly titles: Readonly<Record<string, string>>; readonly citations: Readonly<Record<string, string>> }
  revert(operationId: string, meta: ChangeMeta): KnowledgeOperation
  prerequisites(courseId: string, taskId?: string): KnowledgeEdge[]
  detail(courseId: string, nodeId: string): KnowledgeDetail
  global(): KnowledgeGlobal
  /** Source links of the course's nodes (every course when omitted). */
  sourceLayer(courseId?: string): KnowledgeSourceLayer
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

/** One evidence log entry about a node, in words for the node details. Read-only. */
export interface EvidenceRecord {
  readonly id: string
  readonly at: string
  readonly courseId?: string
  /** What happened, e.g. "小测作答" or "主老师给了提示". */
  readonly what: string
  /** Outcome in words, when there is one. */
  readonly result?: string
  readonly tone: 'ok' | 'warn' | 'bad' | 'neutral'
  /** Test conditions in words, e.g. "闭卷 · 可用计算器 · 限时 30 分钟". */
  readonly conditions?: string
  readonly testId?: string
  /** The current state cites this entry. */
  readonly counted: boolean
}

export interface LearnLearner {
  states(nodeIds?: readonly string[]): NodeState[]
  /** Newest first. */
  evidence(nodeId: string, limit?: number): EvidenceRecord[]
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
