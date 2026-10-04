// Browser-side contracts: the shell's slots and the `learnShell` client service (contracts §6.3–6.4).
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { FeedMessage } from './api.ts'
import type { Id } from './ids.ts'
import type { Selection } from './schema/selection.ts'

/**
 * The browser-side context our client plugins receive. `ctx.slots` comes from DSH's renderer types;
 * DSH's browser connection service is not declared on cordis's `Context`, so we name the part we use.
 */
export type ClientContext = Context & {
  readonly connection: { readonly rpc: ClientConnectionRpc }
}

/** Where the user is: the main interface or one course. */
export type ShellScope = { readonly kind: 'main' } | { readonly kind: 'course'; readonly courseId: Id<'course'> }

/** Owner props every page receives from the shell. */
export interface LearningPageProps {
  /** Shell scope at the time the page was opened. */
  readonly scope: ShellScope
  /** Page-specific parameters passed to `openPage`. */
  readonly params: Readonly<Record<string, unknown>>
}

/** One activity-bar button. */
export interface ActivityItem {
  readonly id: string
  readonly title: string
  /** Short glyph shown in the bar until icons land. */
  readonly glyph: string
  readonly scope: 'main' | 'course' | 'both'
  /** `learning.page` key opened by the button. */
  readonly page: string
  /** Lowest order in a scope is that scope's start page. */
  readonly order?: number
}

export interface MarkdownProps {
  readonly text: string
  /** Render as inline text (no paragraphs), for short fields such as a goal item. */
  readonly inline?: boolean
  /**
   * Textbook mode (contracts §3.2): paragraphs ending in `^id` become selectable blocks,
   * `[label](cite:ck_…)` links become source badges, `cite:unverified` is flagged.
   */
  readonly blocks?: boolean
  readonly selectedBlock?: string
  readonly onBlock?: (blockId: string, text: string) => void
  readonly onCite?: (chunkId: string) => void
}

export interface LearnShell {
  /** Add an activity-bar button. @returns disposer. */
  registerActivity(item: ActivityItem): () => void
  /** Open (or focus) a page tab. `split` opens it beside the active tab. */
  openPage(page: string, params?: Record<string, unknown>, options?: { readonly title?: string; readonly split?: boolean }): void
  /** Current scope. */
  scope(): ShellScope
  /** Switch to a course's interface (its tabs and activity bar). */
  enterCourse(courseId: string): void
  /** Back to the main interface. */
  leaveCourse(): void
  onScope(listener: (scope: ShellScope) => void): () => void
  /** What the learner has selected on the active page (side chat and annotations read it). */
  selection(): Selection | undefined
  select(selection: Selection | undefined): void
  onSelection(listener: (selection: Selection | undefined) => void): () => void
  /** Messages from the change feed (one shared connection). @returns disposer. */
  onFeed(listener: (message: FeedMessage) => void): () => void
  /** Call `/api/learning/<unit>.<method>`; rejects with the endpoint's LearningError. */
  call<T = unknown>(unit: string, method: string, payload?: unknown): Promise<T>
  /** Shared Markdown renderer (math included), so units do not each bundle one. */
  readonly Markdown: (props: MarkdownProps) => ReactNode
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Pages, keyed by page id (e.g. `knowledge.graph`), rendered inside the shell's tabs. */
    'learning.page': { kind: 'keyed'; scope: 'root'; owner: LearningPageProps }
    /** The right sidebar (one occupant: the side chat). */
    'learning.side-chat': { kind: 'single'; scope: 'root'; owner: { readonly scope: ShellScope } }
    /** Sections of the course progress page (goal, stages, tasks, tests…), declared by curriculum. */
    'learning.course-section': { kind: 'list'; scope: 'root'; owner: { readonly courseId: string } }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    learnShell: LearnShell
  }
}
