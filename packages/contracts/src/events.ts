// Host events between units (contracts §5.2). All start with `learning/`.
// Facts use `emit` and are sent only after the data is durable. The two assembly events use `waterfall`:
// each listener awaits `next()` and appends its own part.
import type {} from '@deepseek-ai/cordis'
import type { Course, Stage, StageStatus, Task } from './schema/course.ts'
import type { LogEntry, MasteryState, NodeState } from './schema/evidence.ts'
import type { Selection } from './schema/selection.ts'
import type { Change, Proposal, SideChatSummary } from './schema/session.ts'

/** One named part of the teacher's per-turn course brief. */
export interface BriefSection {
  /** Unit that wrote it, e.g. `curriculum`. */
  readonly unit: string
  readonly title: string
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
    /** A course file changed through core (or was found edited outside the app). */
    'learning/doc-changed'(change: { readonly courseId: string | undefined; readonly path: string; readonly changeId: string }): void
    'learning/goal-confirmed'(goal: { readonly courseId: string }): void
    'learning/source-imported'(source: { readonly sourceId: string }): void
    'learning/stage-changed'(change: { readonly stage: Stage; readonly from: StageStatus | undefined }): void
    'learning/task-published'(task: Task): void
    'learning/task-done'(task: Task): void
    'learning/textbook-ready'(ready: { readonly courseId: string; readonly stageId: string; readonly lessonIds: readonly string[] }): void
    'learning/sidechat-summarized'(summary: SideChatSummary): void
    'learning/proposal-created'(proposal: Proposal): void
    'learning/change-applied'(change: Change): void

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
  'learning/doc-changed',
  'learning/goal-confirmed',
  'learning/source-imported',
  'learning/stage-changed',
  'learning/task-published',
  'learning/task-done',
  'learning/textbook-ready',
  'learning/sidechat-summarized',
  'learning/proposal-created',
  'learning/change-applied',
] as const
export type FeedEvent = (typeof FEED_EVENTS)[number]
