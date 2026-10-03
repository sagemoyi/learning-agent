// core unit, host half. Provides `ctx.learnCore`:
// - api.endpoint: exact routes `/api/learning/<unit>.<method>` on DSH's authenticated channel,
//   speaking DSH's RPC envelope (stage-0 V3: never intercept `/api`, DSH's gateway owns it).
// - feed: one server-sent event stream that pushes changes to every open page.
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  FEED_PATH,
  LearningApiError,
  endpointName,
  type EndpointSpec,
  type FeedMessage,
  type LearnCore,
  type LearningError,
} from '@learning-agent/contracts'

export const name = 'learning-core'
export const inject = ['connection']

const HEARTBEAT_MS = 25_000
const encoder = new TextEncoder()

function toLearningError(error: unknown): LearningError {
  // Each unit bundles its own copy of the contracts, so match LearningApiError by shape, not instanceof.
  if (LearningApiError.is(error)) return { code: error.code, message: error.message, details: error.details }
  // zod failures carry their issues; everything else keeps its own message.
  const issues = (error as { issues?: unknown })?.issues
  if (Array.isArray(issues)) return { code: 'learning/invalid-input', message: String((error as Error).message), details: { issues } }
  return { code: 'learning/failed', message: String((error as Error)?.message ?? error), details: {} }
}

class LearnCoreService extends Service implements LearnCore {
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>()

  constructor(ctx: Context) {
    super(ctx, 'learnCore')
  }

  readonly api = {
    endpoint: <I, O>(spec: EndpointSpec<I, O>): (() => void) => {
      const path = `/api/${endpointName(spec.unit, spec.method)}`
      const dispose = this.ctx.connection.fetch.register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          const message = await request.json() as { rpcId: unknown; payload: unknown }
          const reply = (result: unknown) => Response.json({ type: 'server-response', rpcId: message.rpcId, result })
          try {
            const input = spec.input ? spec.input.parse(message.payload) : message.payload as I
            const value = await spec.handle(input, request.signal)
            return reply({ ok: true, value })
          } catch (error) {
            this.ctx.logger('learning-core').warn(`${path} failed: %s`, (error as Error)?.stack ?? error)
            return reply({ ok: false, error: toLearningError(error) })
          }
        },
      })
      return () => { void dispose() }
    },
  }

  readonly feed = {
    publish: (type: string, data: unknown): void => {
      const message: FeedMessage = { type, at: new Date().toISOString(), data }
      this.broadcast(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
    },
  }

  /** Serve the feed stream; each page holds one connection. */
  serveFeed(request: Request): Response {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start: c => {
        controller = c
        this.subscribers.add(c)
        c.enqueue(encoder.encode(`retry: 3000\nevent: ready\ndata: {}\n\n`))
      },
      cancel: () => { this.subscribers.delete(controller) },
    })
    request.signal.addEventListener('abort', () => {
      this.subscribers.delete(controller)
      try { controller.close() } catch { /* already closed */ }
    })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    })
  }

  broadcast(text: string): void {
    const bytes = encoder.encode(text)
    for (const controller of this.subscribers) {
      try { controller.enqueue(bytes) } catch { this.subscribers.delete(controller) }
    }
  }

  closeAll(): void {
    for (const controller of this.subscribers) {
      try { controller.close() } catch { /* already closed */ }
    }
    this.subscribers.clear()
  }
}

export function apply(ctx: Context): void {
  const core = new LearnCoreService(ctx)
  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: FEED_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request) => core.serveFeed(request),
    })
    const timer = setInterval(() => core.broadcast(': ping\n\n'), HEARTBEAT_MS)
    return () => {
      clearInterval(timer)
      core.closeAll()
      void dispose()
    }
  }, 'learning-core: feed route')
}
