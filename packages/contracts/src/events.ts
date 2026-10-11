// Host events between units (contracts §5.2). All start with `learning/`.
// Facts use `emit` and are sent only after the data is durable. The two assembly events use `waterfall`:
// each listener awaits `next()` and appends its own part.
import type {} from '@deepseek-ai/cordis'
import type { Test } from './schema/assess.ts'
import type { Course, Stage, StageStatus, Task } from './schema/course.ts'
import type { LogEntry, MasteryState, NodeState } from './schema/evidence.ts'
import type { Selection } from './schema/selection.ts'
import type { Change, Proposal, SideChatSummary } from './schema/session.ts'
import type { LibraryImport } from './schema/library.ts'
import type { KnowledgeExtraction } from './schema/knowledge.ts'

/** One named part of the teacher's per-turn course brief. */
export interface BriefSection {
  /** Unit that wrote it, e.g. `curriculum`. */
  readonly unit: string
  readonly title: string
  readonly text: string
}

/** A finished learner action or background job, reported to the teacher (`learning/handoff`). */
export interface Handoff {
  readonly courseId: string
  /** Unit that reports it, e.g. `assess`. */
  readonly unit: string
  /** One sentence for the teacher and the chat, e.g. "学习者交了 1.1 的小测：对 2/3。" No internal ids needed. */
  readonly text: string
}

export interface CourseBriefRequest {
  readonly courseId: string
  readonly sessionId: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A log entry was appended (core, after commit). */
    'learning/logged'(entry: LogEntry): void
    /** A node's derived state changed (learner). */
    'learning/node-state-changed'(change: { readonly nodeId: string; readonly from: MasteryState | undefined; readonly to: NodeState }): void
    'learning/course-created'(course: Course): void
    /** A course's status changed (finished, active again). */
    'learning/course-updated'(course: Course): void
    /** A course file changed through core (or was found edited outside the app). */
    'learning/doc-changed'(change: { readonly courseId: string | undefined; readonly path: string; readonly changeId: string }): void
    'learning/goal-confirmed'(goal: { readonly courseId: string }): void
    'learning/source-imported'(source: { readonly sourceId: string }): void
    'learning/source-updated'(source: { readonly sourceId: string }): void
    'learning/import-changed'(task: LibraryImport): void
    /** A merge, or its undo, changed which identity some nodes resolve to (knowledge, after commit). */
    'learning/identity-changed'(change: { readonly nodeIds: readonly string[] }): void
    /** A section extraction job was queued, started, finished, failed or canceled (knowledge). */
    'learning/extraction-changed'(job: KnowledgeExtraction): void
    /** Web material proposed to, confirmed or dismissed by the learner (library). */
    'learning/web-changed'(change: { readonly courseId: string }): void
    'learning/stage-changed'(change: { readonly stage: Stage; readonly from: StageStatus | undefined }): void
    /** A roadmap revision was proposed, applied or discarded (curriculum); the page shows or drops it. */
    'learning/roadmap-revised'(change: { readonly courseId: string; readonly pending: boolean }): void
    'learning/task-published'(task: Task): void
    'learning/task-done'(task: Task): void
    /** A test was submitted and graded (assess). */
    'learning/test-finished'(finished: { readonly test: Test }): void
    /** One lesson's textbook was written (textbook). The stage can start once its first lesson is ready. */
    'learning/textbook-ready'(ready: { readonly courseId: string; readonly stageId: string; readonly lessonId: string }): void
    /** One lesson's textbook could not be written (textbook); `message` says why. */
    'learning/textbook-failed'(failed: { readonly courseId: string; readonly stageId: string; readonly lessonId: string; readonly message: string }): void
    /**
     * Something the learner did on a page, or a background job, finished; the teacher should hear
     * about it and carry on (tutor wakes the teacher when the next step is the teacher's). Emitted by
     * the unit that owns the action. Not for the teacher's own tool calls: the teacher already knows.
     */
    'learning/handoff'(handoff: Handoff): void
    'learning/sidechat-summarized'(summary: SideChatSummary): void
    /** An annotation was made, edited, resolved, hidden or moved (annotation). */
    'learning/annotation-changed'(change: { readonly courseId: string; readonly annotationId: string }): void
    'learning/proposal-created'(proposal: Proposal): void
    /** The teacher applied, rejected or withdrew a proposal (tutor). */
    'learning/proposal-decided'(proposal: Proposal): void
    'learning/change-applied'(change: Change): void
    /** The learner put off the course's suggested check until tomorrow (planner). */
    'learning/planner-changed'(change: { readonly courseId: string }): void

    /** Assemble the teacher's course brief; each unit appends its sections. @mode waterfall */
    'learning/course-brief'(request: CourseBriefRequest, next: () => Promise<BriefSection[]>): Promise<BriefSection[]>
    /** Turn a page selection into side-chat context lines; the owning unit appends its description. @mode waterfall */
    'learning/describe-selection'(selection: Selection, next: () => Promise<string[]>): Promise<string[]>
  }
}

/** Events core relays to every open page over the change feed (contracts §6.2). */
export const FEED_EVENTS = [
  'learning/logged',
  'learning/node-state-changed',
  'learning/course-created',
  'learning/course-updated',
  'learning/doc-changed',
  'learning/goal-confirmed',
  'learning/source-imported',
  'learning/source-updated',
  'learning/import-changed',
  'learning/identity-changed',
  'learning/extraction-changed',
  'learning/web-changed',
  'learning/stage-changed',
  'learning/roadmap-revised',
  'learning/task-published',
  'learning/task-done',
  'learning/test-finished',
  'learning/textbook-ready',
  'learning/textbook-failed',
  'learning/handoff',
  'learning/sidechat-summarized',
  'learning/annotation-changed',
  'learning/proposal-created',
  'learning/proposal-decided',
  'learning/change-applied',
  'learning/planner-changed',
] as const
export type FeedEvent = (typeof FEED_EVENTS)[number]
