// Browser-side contracts: the shell's slots and the `learnShell` client service (contracts §6.3–6.4).
import type { ComponentType, ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { FeedMessage } from './api.ts'
import type { Id } from './ids.ts'
import type { Selection } from './schema/selection.ts'
import type { TextQuote } from './schema/textbook.ts'

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
  /** `foot` puts the button in the sidebar footer beside 外观 rather than in the page list; it is never a start page and still shows in Ctrl K. */
  readonly placement?: 'nav' | 'foot'
}

/** What a unit's card in the teacher chat gets: the tool call's arguments and the learner's reply after it. */
export interface ChatCardProps {
  readonly args: Readonly<Record<string, unknown>>
  /** The learner's next message after the card, once there is one. */
  readonly reply?: string
  /** Send a message as the learner. */
  send(text: string): void
  /** Put text into the message box for the learner to finish. */
  fill(text: string): void
}

/** Text the learner selected in a textbook block, and the selection's box on the screen (viewport pixels). */
export interface TextPick {
  readonly blockId: string
  /** The block's Markdown source. */
  readonly text: string
  readonly quote: TextQuote
  readonly rect: { readonly top: number; readonly left: number; readonly right: number; readonly bottom: number }
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
  /**
   * A paragraph was clicked. `quote` is the text the learner has selected inside it, as the Markdown source
   * (formulas whole, `$…$`; citation badges left out), with a little text before and after; absent when
   * nothing is selected.
   */
  readonly onBlock?: (blockId: string, text: string, quote?: TextQuote) => void
  readonly onCite?: (chunkId: string) => void
  /**
   * Plain mode: the learner selected text inside it (as `onBlock`'s quote: Markdown source, formulas whole) or let go
   * without selecting (`undefined`). For notes on a source's recognized text.
   */
  readonly onQuote?: (quote: TextQuote | undefined) => void
  /**
   * Textbook mode: the learner selected text inside a block (as `onBlock`'s quote), with where the selection is
   * on the screen; `undefined` when the selection went away. Clicking a block without selecting calls nothing.
   */
  readonly onSelect?: (pick: TextPick | undefined) => void
  /** Draws a figure embedded as `![caption](cite:ck_…)`; without it the figure is a link to its source. */
  readonly figure?: (chunkId: string) => ReactNode
  /** Textbook mode: an extra class for a block (`is-marked` outlines it). */
  readonly blockClass?: (blockId: string) => string | undefined
  /** Textbook mode: shown right after a block, e.g. its source check while it is selected. */
  readonly afterBlock?: (blockId: string) => ReactNode
}

/**
 * What the annotation unit shows inside the textbook reader (contracts §6.3, docs/annotation/design.md). The
 * reader hosts it without knowing anything about annotations: it passes where it is and the unit draws.
 * - `actions`: the "批注" menu next to "就这段提问", for the paragraph selected now;
 * - `notes`: the notes under one paragraph, and the box to write one.
 */
export type ReaderNotesProps =
  | { readonly part: 'actions'; readonly courseId: string; readonly blockId: string }
  | { readonly part: 'notes'; readonly courseId: string; readonly blockId: string }

/**
 * What the annotation unit shows next to a source's recognized text in the reader (docs/annotation/design.md, B): the
 * 批注 menu for the chunk (`actions`) and the notes on it with the box to write one (`notes`). The library hosts it.
 */
export interface SourceNotesProps {
  readonly part: 'actions' | 'notes'
  readonly courseId: string
  readonly chunkId: string
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
  /** A figure of a source cut out of its page (the `learning.figure` slot); a note when it cannot be drawn. */
  readonly Figure: (props: { readonly chunkId: string }) => ReactNode
}

/** Whether a named secret is set, where it comes from, and whether the settings page may change it; never the value. */
export interface SecretState {
  readonly configured: boolean
  /** `env` (the launch environment, read-only), `file` (saved on the settings page), … */
  readonly source?: string
  readonly writable: boolean
}

/**
 * What the settings page gives each section: the units' settings (DSH Config fields, by profile entry
 * id such as `learning-library`) and named secrets. Writes apply to the next request; nothing restarts.
 */
export interface SettingsAccess {
  /** Current values of one unit's settings; undefined while loading or when DSH does not serve them. */
  values(ns: string): Readonly<Record<string, unknown>> | undefined
  /** Save one setting; `undefined` clears it back to the default. */
  set(ns: string, key: string, value: unknown): Promise<void>
  describeSecrets(names: readonly string[]): Promise<Readonly<Record<string, SecretState>>>
  saveSecret(name: string, value: string): Promise<void>
  clearSecret(name: string): Promise<void>
  /** Counts saves made through the page, so sections reload what they derive from settings or secrets. */
  readonly revision: number
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Blocks of the settings page's 资料服务 section (parsing, semantic search…), by `order`. */
    'learning.settings.services': { kind: 'list'; scope: 'root'; owner: { readonly access: SettingsAccess } }
    /** Pages, keyed by page id (e.g. `knowledge.graph`), rendered inside the shell's tabs. */
    'learning.page': { kind: 'keyed'; scope: 'root'; owner: LearningPageProps }
    /** The right sidebar (one occupant: the side chat). */
    'learning.side-chat': { kind: 'single'; scope: 'root'; owner: { readonly scope: ShellScope } }
    /** Sections of the left sidebar under the page list (course outline, course list), by `order`. */
    'learning.sidebar': { kind: 'list'; scope: 'root'; owner: { readonly scope: ShellScope } }
    /** Status-bar items (stage progress, open tests…), by `order`; keep each to a few words. */
    'learning.status': { kind: 'list'; scope: 'root'; owner: { readonly scope: ShellScope } }
    /** Cards in the teacher chat, keyed by the tool whose successful call shows them (e.g. `offer_goal_options`). */
    'learning.chat-card': { kind: 'keyed'; scope: 'root'; owner: ChatCardProps }
    /** Annotations inside the textbook reader (annotation fills it); empty when the unit is not loaded. */
    'learning.reader-notes': { kind: 'single'; scope: 'root'; owner: ReaderNotesProps }
    /** Annotations on a source's recognized text in the reader (annotation fills it); empty when the unit is not loaded. */
    'learning.source-notes': { kind: 'single'; scope: 'root'; owner: SourceNotesProps }
    /** A figure of a source, cut out of its page: declared by the shell, drawn by library; pages show it with `learnShell.Figure`. */
    'learning.figure': { kind: 'single'; scope: 'root'; owner: { readonly chunkId: string } }
    /** Sections of the course progress page (goal, stages, tasks, tests…), declared by curriculum. */
    'learning.course-section': { kind: 'list'; scope: 'root'; owner: { readonly courseId: string } }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    learnShell: LearnShell
  }
}
