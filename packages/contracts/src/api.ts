// Front end ↔ back end: exact routes under DSH's authenticated /api channel (contracts §6).
import type { z } from 'zod'

/** DSH's shared RPC channel; our endpoints are exact routes below it, never an interceptor. */
export const API_CHANNEL = '/api'

/** Channel-relative endpoint name: `learning/<unit>.<method>`. */
export function endpointName(unit: string, method: string): string {
  return `learning/${unit}.${method}`
}

/** Server-sent change feed (contracts §6.2). Authenticated by DSH's browser cookie. */
export const FEED_PATH = '/api/learning/feed'

/** Every failure carries its real cause back to the page (contracts rule 7). */
export interface LearningError {
  readonly code: `learning/${string}`
  readonly message: string
  readonly details: Record<string, unknown>
}

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LearningError }

/** Thrown by endpoint handlers to choose the error code the page sees. */
export class LearningApiError extends Error {
  constructor(
    readonly code: `learning/${string}`,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'LearningApiError'
  }

  /** Shape check that works across bundles (every unit bundles its own copy of this class). */
  static is(error: unknown): error is LearningApiError {
    const candidate = error as { name?: unknown; code?: unknown } | null
    return candidate?.name === 'LearningApiError' && typeof candidate.code === 'string' && candidate.code.startsWith('learning/')
  }
}

/** One endpoint a unit serves. `input` validates the payload before `handle` runs. */
export interface EndpointSpec<I, O> {
  readonly unit: string
  readonly method: string
  readonly input?: z.ZodType<I>
  handle(input: I, signal: AbortSignal): O | Promise<O>
}

/** One message on the change feed. */
export interface FeedMessage<T = unknown> {
  readonly type: string
  readonly at: string
  readonly data: T
}
