// Host services of the feature units (contracts §5.1). `learnCore` lives in core.ts.
// Units reach each other only through these interfaces (`ctx.learnGoal`, …), never by importing code.
// Skeleton versions: each service carries just what the stage-0 minimal flow needs; units grow them
// when they are built out. Ids are plain strings here; the zod schemas brand them where data is stored.
import type {} from '@deepseek-ai/cordis'
import type { Appeal, Attempt, Grading, Problem, ProblemReport, ProblemSize, ProbeNode, Recognition, ReportReason, SingleAnswer, Test, TestKind, Verdict } from './schema/assess.ts'
import type { ExamProfileInput, FactBasis, FactSource, GoalFact, GoalFrontmatter, Lesson, ReviewChoice, ReviewResult, RoadmapRevision, SourceNeed, Stage, StageReview, Task, TestConditions } from './schema/course.ts'
import type { MasteryState, NodeState } from './schema/evidence.ts'
import type { CourseNode, EdgeType, ExamScope, KnowledgeEdge, KnowledgeExtraction, KnowledgeNode, MergeReview, NodeKind, NodeLink, RelationScope, RelationStatus, KnowledgeNodePatch, KnowledgeEdgePatch, KnowledgeMembershipPatch } from './schema/knowledge.ts'
import type { Chunk, ChunkKind, CourseSource, Source, LibraryImport, WebCandidate } from './schema/library.ts'
import type { Selection } from './schema/selection.ts'
import type { SideChatSummary } from './schema/session.ts'
import type { Annotation, AnnotationAnchor, AnnotationType, Block } from './schema/textbook.ts'
import type { ChangeMeta } from './core.ts'
import type { Change, Proposal } from './schema/session.ts'

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
  /** Every chunk of a source, in reading order (a past paper is read whole). */
  chunks(sourceId: string): CitedChunk[]
  /** Section headings of a source, in reading order. */
  outline(sourceId: string): { readonly section: readonly string[]; readonly chunkId: string }[]
  /**
   * Sources sharing a group are not independent (docs/textbook/design.md, 两个独立来源): pages of one
   * registrable domain; an upload with its reparses and the other editions of the same title.
   */
  sourceGroup(sourceId: string): string
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
  /** Every course the operation touched, when more than `courseId` (a merge across courses). */
  readonly courseIds?: readonly string[]
  /** A merge: the kept node and the merged one. */
  readonly merge?: { readonly keepId: string; readonly mergeId: string }
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
  /** `formerTitles`: titles of identities merged into the node, so search still finds it by an old name. */
  readonly nodes: readonly (KnowledgeNode & { readonly courseIds: readonly string[]; readonly formerTitles?: readonly string[] })[]
  readonly edges: readonly (KnowledgeEdge & { readonly usable?: boolean; readonly issue?: string })[]
  readonly courses: readonly { readonly id: string; readonly title: string }[]
}

/** One node of a merge comparison, with what hangs on it. */
export type MergeSide = KnowledgeNode & { readonly courseIds: readonly string[]; readonly courseTitles: readonly string[]; readonly edgeCount: number; readonly linkCount: number }

/** Two nodes that may be one identity, for the learner to compare and decide (knowledge C). */
export interface MergeSuggestion {
  readonly nodes: readonly [MergeSide, MergeSide]
  /** Why they were paired, e.g. "名称相同", or the teacher's reason. */
  readonly why: string
  readonly by: 'system' | 'teacher'
  /** The node to keep unless the learner picks the other. */
  readonly keepId: string
}

/** What merging `merge` into `keep` would do, worked out without writing anything. Relations are shown re-pointed. */
export interface MergePlan {
  readonly keep: MergeSide
  readonly merge: MergeSide
  /** Courses the kept node joins. */
  readonly joins: readonly { readonly id: string; readonly title: string }[]
  /** Relations that move to the kept node. */
  readonly moved: readonly KnowledgeEdge[]
  /** Relations folded into the kept node's same relation; their sources join it. */
  readonly folded: readonly KnowledgeEdge[]
  /** Relations between the two nodes, which would join a node to itself and stop. */
  readonly stopped: readonly KnowledgeEdge[]
  /** Source links that move to the kept node. */
  readonly links: number
  /** Why the merge cannot go ahead, e.g. a prerequisite cycle; nothing is written then. */
  readonly blocked?: string
  readonly titles: Readonly<Record<string, string>>
}

/** A section of a course source as the extraction page lists it, with its latest job. */
export interface ExtractionSection {
  readonly section: string
  readonly heading: string
  readonly depth: number
  readonly job?: KnowledgeExtraction
  /** The source was parsed again since the job ran and the section's text changed. */
  readonly stale?: boolean
}

export interface ExtractionOverview {
  readonly sources: readonly { readonly id: string; readonly title: string; readonly role: CourseSource['role'] }[]
  readonly sourceId?: string
  readonly sections: readonly ExtractionSection[]
}

/** What happened to one requested section. */
export interface ExtractionStart {
  readonly section: string
  readonly outcome: 'started' | 'running' | 'done' | 'not-found' | 'too-long' | 'empty'
  readonly message: string
  readonly job?: KnowledgeExtraction
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
  /**
   * Tag the course's nodes against the exam: by skeleton-textbook sections (nodes with a source inside
   * are in scope, nodes whose skeleton sources all lie outside are out of scope, `beyond` tags are kept)
   * and then node by node. One undoable operation; untagged nodes without skeleton sources come back.
   */
  markExamScope(courseId: string, input: { readonly sections?: readonly string[]; readonly nodes?: readonly { readonly node: string; readonly exam: ExamScope | null }[] }, meta: ChangeMeta): ExamScopeResult
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
  /** The node a merged identity now points to, and every identity merged into this one (transitively). */
  identity(nodeId: string): { readonly current: string; readonly merged: readonly string[] }
  /** Pairs worth comparing; with `courseId`, only pairs touching that course. */
  mergeSuggestions(courseId?: string): MergeSuggestion[]
  mergePlan(keepId: string, mergeId: string): MergePlan
  /** The learner confirmed the two are one identity; versions are the ones compared. */
  merge(input: { readonly keepId: string; readonly keepVersion: number; readonly mergeId: string; readonly mergeVersion: number }, meta: ChangeMeta): KnowledgeOperation
  /** The learner said the two are not the same; the pair is not suggested again until one of them changes. */
  keepSeparate(input: { readonly aId: string; readonly aVersion: number; readonly bId: string; readonly bVersion: number }): void
  /** A teacher's merge proposal, waiting for the learner. */
  proposeMerge(keepId: string, mergeId: string, reason: string): MergeReview
  /** Draft knowledge from sections of a course source in the background (the skeleton textbook when omitted). */
  extract(courseId: string, sections: readonly string[], by: 'teacher' | 'learner', sourceId?: string): ExtractionStart[]
  extractions(courseId: string, sourceId?: string): ExtractionOverview
  cancelExtraction(id: string): KnowledgeExtraction
}

// ── goal ─────────────────────────────────────────────────────────────────────

export interface GoalDoc {
  readonly courseId: string
  readonly goal: GoalFrontmatter
  /** Prose part of `goal.md`. */
  readonly body: string
}

/** A goal as the teacher writes it: "can do" items may be plain text without keys; facts without a basis are the teacher's guess. */
export interface GoalDraft {
  readonly purpose: string
  readonly scenario: string
  readonly canDo: readonly (string | { readonly key?: string; readonly text: string; readonly evidence?: string })[]
  readonly level: string
  readonly verification: string
  readonly boundaries: {
    readonly exclude?: readonly string[]
    readonly defaultConditions: TestConditions
    readonly timeBudget?: string
    readonly hoursPerWeek?: { readonly min: number; readonly max: number }
  }
  readonly deadline?: string
  readonly exam?: ExamProfileInput
  readonly facts?: Partial<Record<GoalFact, FactSource>>
  readonly sources?: readonly GoalSourceInput[]
}

/** A source checklist item as the teacher writes it; a re-sent item with the same `what` keeps its source and "missing" mark. */
export interface GoalSourceInput {
  readonly what: string
  readonly why?: string
  readonly role: SourceNeed['role']
  readonly by: SourceNeed['by']
  readonly sourceId?: string
}

/**
 * A revision of some fields. "Can do" items merge by key (an item without a key is new, a key left
 * out is removed); the exam profile merges field by field, `null` removes it; an empty deadline removes it.
 */
export interface GoalPatch {
  readonly purpose?: string
  readonly scenario?: string
  readonly canDo?: GoalDraft['canDo']
  readonly level?: string
  readonly verification?: string
  readonly boundaries?: Partial<GoalDraft['boundaries']>
  readonly deadline?: string
  readonly exam?: Partial<ExamProfileInput> | null
  readonly facts?: Partial<Record<GoalFact, FactSource>>
  /** The whole checklist. */
  readonly sources?: readonly GoalSourceInput[]
  readonly body?: string
}

/** Facts the learner sets on the page; they become the learner's. */
export interface GoalFactEdit {
  readonly conditions?: TestConditions
  readonly hours?: { readonly min: number; readonly max: number } | null
  readonly deadline?: string | null
  readonly examDate?: string | null
  readonly examConditions?: TestConditions
  /** Facts the learner confirms as they stand. */
  readonly confirm?: readonly GoalFact[]
}

export interface GoalSaved {
  readonly doc: GoalDoc
  /** Problems worth fixing that did not stop the save, in words for the teacher. */
  readonly warnings: readonly string[]
}

/** One field that differs from what the learner last confirmed or edited, in words. */
export interface GoalChange {
  readonly label: string
  readonly before?: string
  readonly after?: string
}

export interface GoalVersion {
  readonly version: number
  readonly at: string
  readonly actor: 'teacher' | 'user' | 'system'
  readonly status: 'draft' | 'confirmed'
  readonly reason: string
}

/** The goal as the progress page shows it. */
export interface GoalView {
  readonly doc: GoalDoc
  /** Facts present in the goal, in reading order. */
  readonly facts: readonly { readonly fact: GoalFact; readonly label: string; readonly basis: FactBasis; readonly citation?: string; readonly chunkId?: string; readonly editable: boolean }[]
  /** Since the learner last confirmed or edited the goal; empty when nothing changed or the learner never has. */
  readonly changes: readonly GoalChange[]
  /** What those changes affect, in words. */
  readonly impacts: readonly string[]
  /** Newest first. */
  readonly history: readonly GoalVersion[]
  readonly pastPapers: readonly { readonly id: string; readonly title: string }[]
  /** The checklist with each item's state. */
  readonly sources: readonly (SourceNeed & { readonly state: 'have' | 'wanted' | 'teacher' | 'missing'; readonly title?: string })[]
  /** The course's sources (for "this is it" and the "already here" list). */
  readonly courseSources: readonly { readonly id: string; readonly title: string; readonly role: SourceNeed['role'] }[]
}

export interface LearnGoal {
  get(courseId: string): Promise<GoalDoc | undefined>
  view(courseId: string): Promise<GoalView | undefined>
  /**
   * Write a whole goal. The teacher's writes are checked first (`learning/goal/check`). A confirmed
   * goal goes back to draft when a choice changes (purpose, can-do, level…); fact changes keep it confirmed.
   */
  saveDraft(courseId: string, goal: GoalDraft, body: string, meta: ChangeMeta): Promise<GoalSaved>
  /** Change some fields of version `version`; same checks and status rule as `saveDraft`. */
  revise(courseId: string, version: number, patch: GoalPatch, meta: ChangeMeta): Promise<GoalSaved>
  /** The learner's own edit of facts; keeps the status and hands back to the teacher. */
  setFacts(courseId: string, version: number, edit: GoalFactEdit): Promise<GoalDoc>
  /** The learner has seen the teacher's changes to a confirmed goal. */
  acknowledge(courseId: string, version: number): Promise<GoalDoc>
  /** The learner says which course source fulfils a checklist item (`null` undoes it), or that there is none. */
  setSource(courseId: string, version: number, key: string, answer: { readonly sourceId?: string | null; readonly missing?: boolean }): Promise<GoalDoc>
  /** Draft → confirmed; emits `learning/goal-confirmed`. */
  confirm(courseId: string): Promise<GoalDoc>
  /** Conditions for a test of this kind: the exam's for stage tests, mock exams and final checks (time limit only for mocks), else the goal's default. */
  conditions(courseId: string, kind: TestKind): Promise<TestConditions | undefined>
}

// ── assess ───────────────────────────────────────────────────────────────────

export type NewProblem = Omit<Problem, 'id' | 'createdAt' | 'status' | 'media' | 'figures' | 'size' | 'review'> & {
  readonly media?: readonly string[]
  readonly figures?: readonly string[]
  readonly size?: ProblemSize
}

/** One textbook exercise to import by its number; stem, figures and printed answer come from the source. */
export interface ExerciseImport {
  readonly ref: string
  /** Which course source; the first one that has this exercise when omitted. */
  readonly sourceId?: string
  readonly nodeIds: readonly string[]
  /** Chosen by the bank's per-node split when omitted. */
  readonly pool?: Problem['pool']
  readonly size?: ProblemSize
  /** The question type (题型); past-paper questions take their section's. */
  readonly type?: string
  /** Replaces the parsed printed answer (the teacher's correction of the parse). */
  readonly answer?: Problem['answer']
  /** The answer as printed text, read like a printed answer (a choice key names options); preferred to `answer`. */
  readonly answerText?: string
}

export interface ExerciseImportResult {
  readonly ref: string
  /** `updated`: already in the bank, and its answer replaced by the given one. */
  readonly status: 'added' | 'existing' | 'updated' | 'failed'
  readonly problem?: Problem
  readonly reason?: string
}

/** The calculator's output: every line as printed, and the requested variables. */
export interface CalculationResult {
  readonly lines: readonly string[]
  readonly values: Readonly<Record<string, { readonly value: number; readonly unit: string; readonly text: string }>>
}

/** A calculator check of a problem's answer, part by part. */
export interface AnswerCheck {
  readonly problem: Problem
  readonly agrees: boolean
  /** One line per part: the answer, the calculated value and the difference. */
  readonly lines: readonly string[]
}

/** An exercise the learner did as homework (by its number), so it no longer counts as new. */
export interface HomeworkMark {
  readonly ref: string
  readonly at: string
}

export interface HomeworkUpdate {
  readonly marks: readonly HomeworkMark[]
  /** The numbers this call named, expanded. */
  readonly refs: readonly string[]
  /** Those of them already reserved for tests (no longer new). */
  readonly reserved: readonly string[]
}

export interface BankOverview {
  readonly practice: number
  readonly reserved: number
  /** Per node: counts only, so reserved stems never reach the page. */
  readonly nodes: readonly { readonly nodeId: string; readonly practice: number; readonly reserved: number; readonly seen: number; readonly doubtful: number }[]
  readonly doubtful: readonly { readonly problemId: string; readonly ref?: string; readonly pool: Problem['pool']; readonly reason: string }[]
  readonly homework: readonly HomeworkMark[]
}

export interface StartTestInput {
  readonly courseId: string
  readonly kind: Test['kind']
  readonly stageId?: string
  readonly lessonId?: string
  /** Explicit problems; otherwise picked from `nodeIds` (unseen first), the probe scope or the stage blueprint. */
  readonly problemIds?: readonly string[]
  readonly nodeIds?: readonly string[]
  /** Most problems: the adaptive test's limit, the stage test's size, or how many to pick by node. */
  readonly count?: number
  readonly conditions?: TestConditions
  /** Diagnostics and pretests: the nodes to probe. Without `problemIds` the test is adaptive. */
  readonly scope?: readonly ProbeNode[]
  /** Stage tests: assembled from new reserved problems when `problemIds` is absent. */
  readonly blueprint?: { readonly core: readonly ProbeNode[]; readonly earlier: readonly ProbeNode[]; readonly goals: readonly { readonly key: string; readonly text: string }[] }
  /** Mock exams: the exam's question types and the in-scope nodes; assembled from new reserved problems by type. */
  readonly mock?: { readonly nodes: readonly ProbeNode[]; readonly sections: readonly MockSection[] }
  /** Final checks: the goal's items with their stages' core nodes, and the carried nodes; assembled from new reserved problems. */
  readonly final?: { readonly items: readonly { readonly key: string; readonly text: string; readonly nodes: readonly ProbeNode[] }[]; readonly risks: readonly ProbeNode[]; readonly stageIds: readonly string[] }
}

/** One question type of a mock exam: how many problems, and the section's total points. */
export interface MockSection {
  readonly type: string
  readonly count: number
  readonly points?: number
}

/** New reserved problems per question type of the exam, before a mock exam is assembled. */
export interface MockCoverage {
  readonly sections: readonly { readonly type: string; readonly wanted: number; readonly fresh: number }[]
}

/** A mock exam's result by section, scored like the real exam (docs/assess/design.md, C). */
export interface MockReport {
  readonly sections: readonly {
    readonly type: string
    readonly points: number
    readonly earned: number
    /** 1-based numbers of the section's problems in the test. */
    readonly problems: readonly number[]
    /** Problems still pending review: their points are not counted yet. */
    readonly pending: number
    /** Problems the exam asks of this type that the bank could not supply. */
    readonly short: number
  }[]
  readonly total: { readonly points: number; readonly earned: number }
  /** In-scope nodes answered wrong or partly right, with the problem numbers. */
  readonly weak: readonly { readonly nodeId: string; readonly title: string; readonly problems: readonly number[] }[]
  /** Minutes from "开始" to handing in. */
  readonly minutes?: number
}

/** Where the two readings of a photo answer differ: the working (`box` absent) or one answer box. */
export interface ReadingDifference {
  readonly box?: number
  readonly first: string
  readonly second: string
  /** A few characters around it in the first reading, to find it. */
  readonly before: string
  readonly after: string
}

/** A problem's answer while the test is open, saved as the learner writes (docs/assess/design.md, C). */
export interface AnswerDraft {
  readonly problemId: string
  readonly text: string
  readonly finals: readonly string[]
  readonly gaveUp?: boolean
  /** Handwriting photos, relative to the course folder. */
  readonly images: readonly string[]
  /** The two readings of the photos; cleared when the photos change. */
  readonly recognition?: { readonly runs: readonly Recognition[]; readonly differences: readonly ReadingDifference[]; readonly at: string }
  /** The learner's checked transcription of the photos; changing it clears `confirmedAt`. */
  readonly transcription?: { readonly text: string; readonly confirmedAt?: string }
}

/** What the page saves of a draft; photos and recognition are kept by their own calls. */
export interface DraftInput {
  readonly problemId: string
  readonly text: string
  readonly finals: readonly string[]
  readonly gaveUp?: boolean
  readonly transcription?: { readonly text: string; readonly confirmed: boolean }
}

/** Where a diagnostic left each probed node (docs/assess/design.md, B). Only direct answers are evidence. */
export type ProbeState = 'known' | 'boundary' | 'not-yet' | 'inferred' | 'unprobed'

export interface Diagnosis {
  readonly nodes: readonly { readonly nodeId: string; readonly title: string; readonly state: ProbeState }[]
}

/** pass: its new problems all right; fail: wrong or partly right; mixed: right and wrong; insufficient: no new problem answered. */
export type NodeOutcome = 'pass' | 'fail' | 'mixed' | 'pending' | 'insufficient'

/** A stage test's result per core node, instead of a pass mark on the total. */
export interface StageReport {
  readonly nodes: readonly { readonly nodeId: string; readonly title: string; readonly outcome: NodeOutcome; readonly problems: readonly number[] }[]
  /** The complete task (1-based number in the test) and its verdict. */
  readonly task?: { readonly number: number; readonly verdict?: Verdict }
  readonly earlier: readonly { readonly nodeId: string; readonly title: string; readonly number: number; readonly verdict?: Verdict }[]
  readonly goals: readonly { readonly key: string; readonly text: string }[]
}

/** A final check's result per goal item, and on the carried nodes it asked about. */
export interface FinalReport {
  readonly items: readonly { readonly key: string; readonly text: string; readonly outcome: NodeOutcome; readonly problems: readonly number[] }[]
  readonly risks: readonly { readonly nodeId: string; readonly title: string; readonly number: number; readonly verdict?: Verdict }[]
  readonly uncovered: readonly { readonly key: string; readonly text: string }[]
}

/** New reserved problems per core node (complete tasks not counted), before a stage test is assembled. */
export interface StageCoverage {
  readonly nodes: readonly { readonly nodeId: string; readonly fresh: number }[]
  readonly task: boolean
}

/** One answer box of a problem: a part's label and kind, with the options of a choice. */
export interface AnswerInput {
  readonly label: string
  readonly kind: SingleAnswer['kind']
  readonly options?: readonly string[]
}

export interface GradedAttempt extends Attempt {
  readonly grading?: Grading
}

export interface TestView {
  readonly test: Test
  /** Answers and calculations are stripped while the test is open; `inputs` says which answer boxes to show. */
  readonly problems: (Omit<Problem, 'answer' | 'calculation'> & { readonly answer?: Problem['answer']; readonly calculation?: Problem['calculation']; readonly inputs: readonly AnswerInput[] })[]
  /** Gradings are withheld while the test is open (an adaptive test grades as it goes). */
  readonly attempts: GradedAttempt[]
  /** Problems flagged in this test, with the problem's number and stem and the teacher's outcome. */
  readonly reports: readonly (ProblemReport & { readonly ref?: string; readonly stem: string })[]
  readonly appeals: readonly Appeal[]
  readonly diagnosis?: Diagnosis
  readonly stageReport?: StageReport
  readonly mockReport?: MockReport
  readonly finalReport?: FinalReport
  /** Saved answers of an open test. */
  readonly drafts?: readonly AnswerDraft[]
  /** A started timed test: when time is up. */
  readonly deadline?: string
}

/** Work waiting for the teacher: flagged problems, appeals and gradings pending review. */
export interface AssessQueue {
  readonly reports: readonly (ProblemReport & { readonly ref?: string })[]
  readonly appeals: readonly (Appeal & { readonly number: number; readonly ref?: string })[]
  readonly pending: readonly { readonly testId: string; readonly attemptId: string; readonly problemId: string; readonly number: number; readonly ref?: string }[]
}

export interface LearnAssess {
  addProblems(problems: readonly NewProblem[]): Problem[]
  problem(problemId: string): Problem | undefined
  /** Active problems; `includeReview` adds those under review. */
  problems(filter: { readonly nodeIds?: readonly string[]; readonly pool?: Problem['pool']; readonly includeReview?: boolean }): Problem[]
  startTest(input: StartTestInput): Test
  view(testId: string): TestView | undefined
  tests(courseId: string, filter?: { readonly lessonId?: string; readonly kind?: Test['kind'] }): Test[]
  /** Store the answers, grade them, append evidence; emits `learning/test-finished`. */
  submit(testId: string, answers: readonly SubmittedAnswer[], signal?: AbortSignal): Promise<TestView>
  /** Import textbook exercises by number; an exercise already in the bank is returned, not added again. */
  importExercises(courseId: string, items: readonly ExerciseImport[]): ExerciseImportResult[]
  /** Run a calculation (assignments with units, one per line); refused when it uses anything but arithmetic. */
  calculate(script: string, results?: readonly string[]): CalculationResult
  /**
   * Check a problem's answer with a calculation. A disagreement puts the problem under review;
   * `apply` instead replaces the answer with the calculated one (answer source `calculated`).
   */
  checkAnswer(problemId: string, script: string, results: readonly string[], apply?: boolean): AnswerCheck
  homework(courseId: string): HomeworkMark[]
  /**
   * Mark exercises done as homework (or undo); refs like `1-1~1-10`, `2-3`. The learner's own marks
   * are handed back to the teacher; the teacher's (recording what the learner said) are not.
   */
  markHomework(courseId: string, refs: string, done: boolean, by?: 'learner' | 'teacher'): HomeworkUpdate
  /** Counts per node of the course's problems; `nodeIds` are the course's nodes. */
  bank(courseId: string, nodeIds: readonly string[]): BankOverview
  /** Answer the current problem of an adaptive test: graded at once, then the next problem or the end. */
  answer(testId: string, answer: SubmittedAnswer, signal?: AbortSignal): Promise<TestView>
  /** End an adaptive test early; the unanswered current problem is dropped. */
  finish(testId: string): TestView
  /** Flag a problem of an open test: not scored, swapped while the limit allows; most reasons put it under review. */
  report(testId: string, problemId: string, reason: ReportReason, note?: string): TestView
  /** The teacher's check of a flagged or doubtful problem; closes its open reports with the note. */
  reviewProblem(problemId: string, action: 'keep' | 'fixed' | 'retired', note: string, changes?: { readonly stem?: string; readonly answer?: Problem['answer'] }): Problem
  /** The learner disputes a grading, once per answer; handed back to the teacher. */
  appeal(attemptId: string, text: string): Appeal
  /** The teacher's regrade, appended to the evidence log (`attempt.regraded`); the same verdict only answers the appeals. */
  regrade(attemptId: string, verdict: Exclude<Verdict, 'pending-review'>, reason: string): { readonly grading: Grading; readonly changed: boolean }
  /** Flagged problems, appeals and pending gradings the teacher has not handled. */
  queue(courseId: string): AssessQueue
  /** New reserved problems for the given core nodes, and whether a complete task is among them. */
  coverage(courseId: string, nodes: readonly ProbeNode[]): StageCoverage
  /** New reserved problems for each question type of a mock exam. */
  mockCoverage(courseId: string, sections: readonly MockSection[]): MockCoverage
  /** Save the answer of one problem while the test is open. */
  saveDraft(testId: string, draft: DraftInput): AnswerDraft
  /** Add a handwriting photo to a problem's answer (stored in the course folder); the recognition starts over. */
  addPhoto(testId: string, problemId: string, image: { readonly data: Uint8Array; readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp' }): Promise<AnswerDraft>
  removePhoto(testId: string, problemId: string, path: string): AnswerDraft
  /** Read a problem's photos twice with the handwriting model; the differences are for the learner to check. */
  transcribe(testId: string, problemId: string, signal?: AbortSignal): Promise<AnswerDraft>
  /** Start a timed test: the problems are shown and the clock runs. */
  begin(testId: string): TestView
  /** Take back an open test nobody has answered (the teacher changed plans): it ends as abandoned. */
  withdraw(testId: string): TestView
}

export interface SubmittedAnswer {
  readonly problemId: string
  /** Working and steps. */
  readonly text: string
  /** The final answer per answer box. */
  readonly finals?: readonly string[]
  /** The learner pressed "不会". */
  readonly gaveUp?: boolean
}

// ── curriculum ───────────────────────────────────────────────────────────────

/** One stage of a roadmap draft; `supports` names the goal's "can do" keys it builds towards. */
export interface StageDraft {
  readonly title: string
  readonly objective: string
  readonly supports?: readonly string[]
}

/** What `saveRoadmap` did: applied, or kept for the learner to confirm once the route has started. */
export interface RoadmapResult {
  readonly stages: Stage[]
  readonly revision?: RoadmapRevision
}

/** One core node in the facts of a stage review (docs/curriculum/design.md, A). */
export interface ReviewNodeFacts {
  readonly nodeId: string
  readonly title: string
  readonly result: ReviewResult
  readonly outcome: NodeOutcome
  /** Its problems' numbers in the stage test. */
  readonly problems: readonly number[]
  readonly state: MasteryState
  readonly explanation: string
  readonly doubtful: boolean
  /** Help on it and side-chat questions about it since the stage design was confirmed. */
  readonly help: number
  readonly questions: number
  readonly misconceptions: readonly string[]
  /** Course nodes that require it. */
  readonly dependents: number
  /** What it requires, with their states: a node failing again may lack one of them. */
  readonly prerequisites: readonly { readonly title: string; readonly state: MasteryState }[]
  /** Failed in the review this remedial stage follows. */
  readonly again: boolean
}

/** Nodes an earlier review carried on: failed but passed over (`risk`), or not verified. */
export interface CarriedNode {
  readonly nodeId: string
  readonly title: string
  readonly kind: 'risk' | 'unverified'
  /** The stage whose review carried it. */
  readonly stageId: string
}

/** What the program reads for a stage review, and its default recommendation. */
export interface StageReviewFacts {
  readonly stageId: string
  readonly testId: string
  readonly nodes: readonly ReviewNodeFacts[]
  readonly task?: { readonly number: number; readonly result: ReviewResult; readonly nodeIds: readonly string[] }
  readonly earlier: StageReport['earlier']
  readonly goals: StageReport['goals']
  /** Carried nodes this test asked about, with the verdict. */
  readonly carried: readonly (CarriedNode & { readonly verdict?: Verdict })[]
  /** To handle before the review is saved: pending gradings, open appeals and flagged problems. */
  readonly blockers: readonly string[]
  /** Absent when a node failed again after its remedial stage: the teacher decides with the learner. */
  readonly recommendation?: ReviewChoice
}

/** One goal "can do" item in a course report (docs/curriculum/design.md, 结课). */
export interface ReportItem {
  readonly key: string
  readonly text: string
  /** done: right in the final check and each node done on the learner's own; gaps: right, some node not yet on its own; not-done: wrong or partly right; unchecked: no final problem. */
  readonly status: 'done' | 'gaps' | 'not-done' | 'unchecked'
  readonly stages: readonly string[]
  readonly nodes: readonly { readonly title: string; readonly state: MasteryState }[]
  /** Nodes still without an independent answer. */
  readonly missing: readonly string[]
  /** Its problems' numbers in the final check. */
  readonly problems?: readonly number[]
}

/** What the program reads for a course report. */
export interface CourseReportFacts {
  readonly items: readonly ReportItem[]
  readonly risks: readonly { readonly title: string; readonly kind: CarriedNode['kind']; readonly state: MasteryState }[]
  readonly stages: number
  readonly remedial: number
}

export interface ReviewInput {
  readonly markdown: string
  readonly testId: string
  readonly nodes: StageReview['nodes']
  readonly task?: ReviewResult
  readonly recommendation: ReviewChoice
  readonly reason?: string
  readonly remedial?: StageReview['remedial']
}

export interface LearnCurriculum {
  stages(courseId: string): Stage[]
  stage(stageId: string): Stage | undefined
  /** The stage in progress: the first one that is not done. */
  currentStage(courseId: string): Stage | undefined
  /**
   * The stages after the started ones (a started stage is past `planned`; those are kept as they are).
   * Applied at once until the first stage design is confirmed; after that kept as a revision for the
   * learner to confirm, with `reason`. A goal item covered before must stay covered.
   */
  saveRoadmap(courseId: string, stages: readonly StageDraft[], meta: ChangeMeta): Promise<RoadmapResult>
  /** The roadmap revision awaiting the learner. */
  revision(courseId: string): RoadmapRevision | undefined
  /** The learner's answer to the revision: apply it, or keep the route. */
  decideRevision(courseId: string, apply: boolean): Promise<Stage[]>
  /** Write the stage's `design.md` and its lessons; the stage becomes `designing`. `nodeIds`: the stage's core knowledge nodes. */
  saveDesign(stageId: string, input: { readonly markdown: string; readonly lessons: readonly { readonly number: string; readonly title: string }[]; readonly supports?: readonly string[]; readonly nodeIds?: readonly string[] }, meta: ChangeMeta): Promise<{ readonly stage: Stage; readonly lessons: Lesson[] }>
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
  /** Save the teacher's review of a stage in review (`review.md` and the stage's `review`); the learner decides next. */
  saveReview(stageId: string, input: ReviewInput, meta: ChangeMeta): Promise<Stage>
  /** The learner's choice: the stage is done; `remedial` inserts a remedial stage after it. */
  decideReview(stageId: string, choice: ReviewChoice): Promise<Stage>
  /** Nodes the decided reviews carried on (failed but passed over, or unverified), oldest first. */
  carried(courseId: string): CarriedNode[]
  /** Write `report.md` (the facts' table, then the teacher's text) and mark the course finished. */
  saveReport(courseId: string, input: { readonly markdown: string; readonly facts: CourseReportFacts; readonly finalTestId?: string }, meta: ChangeMeta): Promise<void>
  /** The report's items as saved, while the course has one. */
  report(courseId: string): Promise<{ readonly items: readonly ReportItem[]; readonly writtenAt: string } | undefined>
}

// ── textbook ─────────────────────────────────────────────────────────────────

export type BlockWithText = Block & { readonly text: string }

/** Where one lesson's textbook stands. Kept in the database: a restart resumes queued and interrupted lessons. */
export interface LessonTextbookStatus {
  /** `running` covers queued lessons too; `failed` is the last attempt's outcome. */
  readonly state: 'missing' | 'running' | 'ready' | 'failed'
  /** Progress while running, the reason when failed. */
  readonly message?: string
  readonly blocks?: number
  readonly unverified?: number
  /** Failed attempts in a row since the last success. */
  readonly failures?: number
  /** Titles of the knowledge points sourced in the lesson's material that no paragraph explains. */
  readonly uncovered?: readonly string[]
  /** The sentence-by-sentence check of the published text (docs/textbook/design.md, 逐句核对), once it has one. */
  readonly check?: {
    /** `unchecked`: the check model failed for some paragraphs, which count as not checked. */
    readonly state: 'checked' | 'unchecked'
    /** Paragraphs with a key fact that has one source only. */
    readonly single: number
    /** Paragraphs edited since they were checked: their check no longer counts. */
    readonly stale: number
    /** What the web supplement did, or why the check did not finish. */
    readonly notes: readonly string[]
  }
}

/** Where a paragraph went when the lesson was revised or written again (docs/textbook/design.md, 局部修订). */
export interface BlockRevision {
  readonly blockId: string
  /** The paragraphs it became: itself first when kept, none when removed. */
  readonly into: readonly string[]
  readonly at: string
  /** The course-file change that made it; the old text is its `before`. */
  readonly changeId: string
  readonly reason: string
}

export interface RevisionResult {
  /** Paragraphs rewritten, added and removed. */
  readonly revised: number
  readonly added: number
  readonly removed: number
  /** Why paragraphs of the revision are still 待核实, one entry each. */
  readonly unverified: readonly string[]
  readonly notes: readonly string[]
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
  /**
   * Rewrite some paragraphs of a lesson by `instruction` (at most 8): the others keep their text and
   * ids, a rewritten paragraph keeps its id, and what changed is checked again.
   */
  reviseBlocks(lessonId: string, input: { readonly blockIds: readonly string[]; readonly instruction: string }, meta: ChangeMeta): Promise<RevisionResult>
  /** The revisions a paragraph went through, oldest first. */
  revisions(courseId: string, blockId: string): BlockRevision[]
}

// ── learner ──────────────────────────────────────────────────────────────────

export interface ExamScopeResult {
  readonly operationId?: string
  readonly counts: Readonly<Record<ExamScope | 'untagged', number>>
  /** Nodes left untagged, for the teacher to judge one by one. */
  readonly untagged: readonly { readonly id: string; readonly title: string }[]
}

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
  /** Title of the identity the entry was logged on, when it was merged into this node. */
  readonly node?: string
}

export interface LearnLearner {
  states(nodeIds?: readonly string[]): NodeState[]
  /** Newest first. */
  evidence(nodeId: string, limit?: number): EvidenceRecord[]
  /** Recompute from the evidence log (all nodes when omitted). */
  recompute(nodeIds?: readonly string[]): NodeState[]
  readonly rulesVersion: string
}

// ── annotation ───────────────────────────────────────────────────────────────

export interface NewAnnotation {
  readonly courseId: string
  readonly anchor: AnnotationAnchor
  readonly type: AnnotationType
  readonly text?: string
  /** The page's id for this one action: sending it again (double click, retry) returns the same annotation. */
  readonly requestId?: string
}

export interface AnnotationFilter {
  readonly courseId: string
  readonly type?: AnnotationType
  /** `true`: handled ones only; `false`: open ones only. */
  readonly resolved?: boolean
  /** Annotations shown on this paragraph now. */
  readonly blockId?: string
  /** Only those whose place is not certain (`needs-confirmation`, `original-only`). */
  readonly locationIssues?: boolean
  readonly includeHidden?: boolean
}

export interface LearnAnnotation {
  /**
   * Save an annotation. The quote must be in the paragraph (or chunk) now; a question about a node adds one
   * question signal; an error report on a certain place becomes a proposal at once.
   */
  create(input: NewAnnotation): Promise<Annotation>
  get(annotationId: string): Annotation | undefined
  /** Newest first; each annotation's place is checked against the current text first. */
  list(filter: AnnotationFilter): Promise<Annotation[]>
  /** Change the note; already logged signals are not touched or repeated. */
  edit(annotationId: string, patch: { readonly text: string }): Annotation
  setResolved(annotationId: string, resolved: boolean): Annotation
  setHidden(annotationId: string, hidden: boolean): Annotation
  /** The learner says this is the place (after several matches or an edit); `blockId` picks a paragraph after a split. */
  confirmLocation(annotationId: string, blockId?: string): Promise<Annotation>
  /** The selection to open a side chat with: the annotation's own quote and note, and the version it was made on. */
  sideChatSelection(annotationId: string): Selection
  /** Remember which side chat the question went to; asking again while that one is open returns it. */
  linkSideChat(annotationId: string, sessionId: string): Annotation
  /** An error report becomes a proposal for the paragraph's file, once; refused while the place is uncertain. */
  submitError(annotationId: string): Promise<Proposal>
}

// ── sidechat ─────────────────────────────────────────────────────────────────

export interface LearnSidechat {
  /** Open a side chat bound to the page and selection; returns the DSH session id. */
  open(selection: Selection): Promise<{ readonly sessionId: string }>
  /**
   * End it: read the record, write the summary, log signals and help. Safe to call again (two clicks, a retry
   * after a failure): one summary, one note, one set of log entries, and the session is closed whatever stage
   * the earlier call stopped at.
   */
  close(sessionId: string, signal?: AbortSignal): Promise<SideChatSummary>
  /**
   * May this session use a tool now? Always for a session that is not a side chat. A side chat reads the course's
   * library (`search_library`, `read_section`) and nothing else, and not even that while a test of the course is open
   * (docs/assess/design.md, 测试类型与独立性). Tools call it when they run, so an old session is held to today's rule.
   */
  checkTool(sessionId: string, tool: string): { readonly allowed: boolean; readonly reason?: string }
}

// ── tutor ────────────────────────────────────────────────────────────────────

export interface LearnTutor {
  /** The teacher session for the course's current stage (created on first use). */
  session(courseId: string): Promise<string>
  /** The per-turn course brief, assembled from every unit's `learning/course-brief` section. */
  brief(courseId: string, sessionId: string): Promise<string>
  /**
   * Write the lesson record (`lessons/<n>.md`: quiz results, help in the lesson, states, the learner's report,
   * the summary) and mark the lesson done. Refused until the lesson's quiz is in and settled; with `sessionId`,
   * the report must be the learner's own words from that session (docs/tutor/design.md, B).
   */
  writeLessonSummary(lessonId: string, record: { readonly summary: string; readonly learnerReport: string; readonly sessionId?: string }, meta: ChangeMeta): Promise<void>
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
  /** Time left to the exam or the deadline (the earlier one), with the roadmap's progress. */
  readonly countdown?: Countdown
}

export interface Countdown {
  readonly label: '考试' | '期限'
  readonly date: string
  /** Negative once the date has passed. */
  readonly days: number
  readonly stagesDone: number
  readonly stagesTotal: number
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
    learnAnnotation: LearnAnnotation
    learnSidechat: LearnSidechat
    learnTutor: LearnTutor
    learnPlanner: LearnPlanner
  }
}
