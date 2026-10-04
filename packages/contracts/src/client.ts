// Browser-side contracts: the shell's slots and the `learnShell` client service (contracts §6.3–6.4).
import type { ComponentType, ReactNode } from 'react'
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

/** An icon component, e.g. one from lucide-react (line icons; no emoji). */
export type IconComponent = ComponentType<{ readonly size?: number | string; readonly strokeWidth?: number | string; readonly className?: string }>

/** One activity-bar button. */
export interface ActivityItem {
  readonly id: string
  /** Shown under the icon, so keep it to two–four characters. */
  readonly title: string
  readonly icon: IconComponent
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

/** The page in the active tab (contracts §6.3 "当前位置"). */
export interface ActivePage {
  readonly page: string
  readonly params: Readonly<Record<string, unknown>>
}

export interface LearnShell {
  /** Add an activity-bar button. @returns disposer. */
  registerActivity(item: ActivityItem): () => void
  /** Show a count on an activity-bar button (e.g. open tests); 0 hides it. */
  setBadge(activityId: string, count: number): void
  /** Open (or focus) a page tab. `split` opens it beside the active tab. */
  openPage(page: string, params?: Record<string, unknown>, options?: { readonly title?: string; readonly split?: boolean }): void
  /** The page in the active tab, if any. */
  activePage(): ActivePage | undefined
  onActivePage(listener: (page: ActivePage | undefined) => void): () => void
  /** Show the side-chat sidebar (e.g. after the learner picks something to ask about). */
  showSideChat(): void
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
    /** Sections of the left sidebar under the page list (course outline, course list), by `order`. */
    'learning.sidebar': { kind: 'list'; scope: 'root'; owner: { readonly scope: ShellScope } }
    /** Status-bar items (stage progress, open tests…), by `order`; keep each to a few words. */
    'learning.status': { kind: 'list'; scope: 'root'; owner: { readonly scope: ShellScope } }
    /** Sections of the course progress page (goal, stages, tasks, tests…), declared by curriculum. */
    'learning.course-section': { kind: 'list'; scope: 'root'; owner: { readonly courseId: string } }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    learnShell: LearnShell
  }
}
