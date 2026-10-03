// The `core` unit's host service (contracts §5.1). Units reach it as `ctx.learnCore`.
import type {} from '@deepseek-ai/cordis'
import type { EndpointSpec } from './api.ts'

export interface LearnCore {
  readonly api: {
    /**
     * Serve one endpoint at `/api/learning/<unit>.<method>`.
     * @returns disposer; callers register inside `ctx.effect` so the route follows their lifetime.
     */
    endpoint<I, O>(spec: EndpointSpec<I, O>): () => void
  }
  readonly feed: {
    /** Push one message to every open page. */
    publish(type: string, data: unknown): void
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    learnCore: LearnCore
  }
}
