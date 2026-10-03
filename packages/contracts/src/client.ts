// Browser-side contracts: the shell's slots and the `learnShell` client service (contracts §6.3–6.4).
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/**
 * The browser-side context our client plugins receive. `ctx.slots` comes from DSH's renderer types;
 * DSH's browser connection service is not declared on cordis's `Context`, so we name the part we use.
 */
export type ClientContext = Context & {
  readonly connection: { readonly rpc: ClientConnectionRpc }
}

/** Where the user is: the main interface or one course. */
export type ShellScope = { readonly kind: 'main' } | { readonly kind: 'course'; readonly courseId: string }

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
  readonly order?: number
}

export interface LearnShell {
  /** Add an activity-bar button. @returns disposer. */
  registerActivity(item: ActivityItem): () => void
  /** Open (or focus) a page tab. `split` opens it beside the active tab. */
  openPage(page: string, params?: Record<string, unknown>, options?: { readonly title?: string; readonly split?: boolean }): void
  /** Current scope. */
  scope(): ShellScope
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Pages, keyed by page id (e.g. `knowledge.graph`), rendered inside the shell's tabs. */
    'learning.page': { kind: 'keyed'; scope: 'root'; owner: LearningPageProps }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    learnShell: LearnShell
  }
}
