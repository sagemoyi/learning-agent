// The `core` unit's host service (contracts §5.1). Units reach it as `ctx.learnCore`.
// Registration-style methods return disposers; callers wrap them in `ctx.effect` so they follow
// the caller's lifetime.
import type {} from '@deepseek-ai/cordis'
import type { DatabaseSync } from 'node:sqlite'
import type { EndpointSpec } from './api.ts'
import type { Course } from './schema/course.ts'
import type { LogEntry, LogEntryType, NewLogEntry } from './schema/evidence.ts'
import type { Change, ChangeTarget, Proposal, SessionLink } from './schema/session.ts'

/** One schema step of a unit's own tables. Steps run once, in order, inside a transaction. */
export interface Migration {
  /** 1, 2, 3 … per unit. */
  readonly version: number
  readonly sql: string
}

/** Who made a change and why (every course-file write goes through the change log). */
export interface ChangeMeta {
  readonly actor: Change['actor']
  readonly reason: string
  readonly size?: Change['size']
  readonly proposalId?: string
}

export interface WriteOptions {
  /**
   * Write only while the file still has this hash (`null`: only while it does not exist), so a result
   * prepared from an older file does not overwrite a newer one; otherwise throws `learning/core/conflict`.
   */
  readonly ifHash?: string | null
}

export interface CourseFile {
  readonly text: string
  /** sha256 of the text. */
  readonly hash: string
}

export interface LogQuery {
  readonly courseId?: string
  readonly nodeId?: string
  readonly types?: readonly LogEntryType[]
  /** ISO instant, inclusive. */
  readonly since?: string
  /** Entries after this log id (exclusive), to read the log a page at a time; pages are in id order. */
  readonly after?: string
  /** At most 100 000 per call (default 10 000). */
  readonly limit?: number
}

export interface LearnCore {
  /** Absolute data root (default `Documents/学习库`, or LEARNING_HOME). */
  readonly dataRoot: string

  readonly api: {
    /** Serve one endpoint at `/api/learning/<unit>.<method>`. @returns disposer. */
    endpoint<I, O>(spec: EndpointSpec<I, O>): () => void
  }

  readonly feed: {
    /** Push one message to every open page. FEED_EVENTS are relayed automatically. */
    publish(type: string, data: unknown): void
  }

  readonly db: {
    /** The shared database. Each unit only touches tables prefixed with its own name. */
    readonly sqlite: DatabaseSync
    /** Bring one unit's tables up to date. Safe to call on every start. */
    migrate(unit: string, steps: readonly Migration[]): void
    /** Run `fn` in one transaction (nested calls join the outer one). */
    transaction<T>(fn: () => T): T
  }

  readonly courses: {
    /** Create the folder, register it as a DSH workspace, write `course.md`. */
    create(input: { readonly title: string; readonly slug?: string }): Promise<Course>
    list(): Course[]
    get(courseId: string): Course | undefined
    /** Mark a course finished or active again; emits `learning/course-updated`. */
    setStatus(courseId: string, status: Course['status']): Course
    /** Absolute folder of a course. */
    folder(courseId: string): string
  }

  readonly files: {
    /** Read a course file; `undefined` when it does not exist. Detects edits made outside the app. */
    read(courseId: string, path: string): Promise<CourseFile | undefined>
    /** Write a course file through the change log; emits `learning/doc-changed`. */
    write(courseId: string, path: string, text: string, meta: ChangeMeta, options?: WriteOptions): Promise<Change>
    /** Append to a course file (side-chat summaries); still one change-log entry per call. */
    append(courseId: string, path: string, text: string, meta: ChangeMeta): Promise<Change>
  }

  readonly changes: {
    list(filter: { readonly target?: ChangeTarget; readonly courseId?: string; readonly operationId?: string; readonly limit?: number }): Change[]
    get(changeId: string): Change | undefined
    /** Record a change to a database record (the owner already applied it). */
    record(change: Omit<Change, 'id' | 'at'>): Change
    /** Restore the `before` of a file change as a new change. */
    revert(changeId: string, meta: ChangeMeta): Promise<Change>
  }

  readonly sessions: {
    /** Record which course/stage/role a DSH session belongs to, before creating it. */
    link(link: SessionLink): void
    get(sessionId: string): SessionLink | undefined
    list(filter: { readonly courseId?: string; readonly role?: SessionLink['role'] }): SessionLink[]
    close(sessionId: string): void
  }

  readonly log: {
    /** Append one evidence entry; emits `learning/logged` after commit. */
    append(entry: NewLogEntry): LogEntry
    /** Oldest first (id order). */
    query(query: LogQuery): LogEntry[]
    /** How many entries the log holds; the log only grows, so a reader can tell it missed some. */
    count(): number
  }

  readonly proposals: {
    create(input: Omit<Proposal, 'id' | 'status' | 'createdAt' | 'changeIds'>): Proposal
    get(proposalId: string): Proposal | undefined
    list(filter: { readonly courseId?: string; readonly status?: Proposal['status'] }): Proposal[]
    /** Record the decision (`note`: why, shown to the learner); emits `learning/proposal-decided` after commit. */
    decide(proposalId: string, status: 'accepted' | 'rejected' | 'applied' | 'withdrawn', changeIds?: readonly string[], note?: string): Proposal
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    learnCore: LearnCore
  }
}
