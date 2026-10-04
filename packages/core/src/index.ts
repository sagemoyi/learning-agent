// core unit, host half. Provides `ctx.learnCore` (contracts §5.1):
// - db: the shared SQLite database and per-unit migrations;
// - courses, files, changes: course folders (= DSH workspaces), course files written through the change log;
// - sessions: which course/stage/role each DSH session belongs to;
// - log: the append-only learning evidence log; proposals;
// - api.endpoint: exact routes `/api/learning/<unit>.<method>` on DSH's authenticated channel
//   (stage-0 V3: never intercept `/api`, DSH's gateway owns it);
// - feed: one server-sent event stream pushing FEED_EVENTS to every open page (S1).
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  DATA_LAYOUT,
  FEED_EVENTS,
  FEED_PATH,
  LearningApiError,
  endpointName,
  type Change,
  type EndpointSpec,
  type FeedMessage,
  type LearnCore,
  type LearningError,
} from '@learning-agent/contracts'
import { z } from 'zod'
import { Database } from './db.ts'
import { coreMigrations } from './migrations.ts'
import { CoreStore } from './store.ts'

export const name = 'learning-core'
export const inject = ['connection', 'workspaceRegistry']

const HEARTBEAT_MS = 25_000
const encoder = new TextEncoder()

/** Data root: LEARNING_HOME, else `Documents/学习库` (contracts §3.1). */
function resolveDataRoot(): string {
  return process.env.LEARNING_HOME || join(homedir(), 'Documents', '学习库')
}

function toLearningError(error: unknown): LearningError {
  // Each unit bundles its own copy of the contracts, so match LearningApiError by shape, not instanceof.
  if (LearningApiError.is(error)) return { code: error.code, message: error.message, details: error.details }
  // zod failures carry their issues; everything else keeps its own message.
  const issues = (error as { issues?: unknown })?.issues
  if (Array.isArray(issues)) return { code: 'learning/invalid-input', message: String((error as Error).message), details: { issues } }
  return { code: 'learning/failed', message: String((error as Error)?.message ?? error), details: {} }
}

class LearnCoreService extends Service implements LearnCore {
  readonly dataRoot: string
  readonly database: Database
  readonly db: LearnCore['db']
  readonly courses: LearnCore['courses']
  readonly files: LearnCore['files']
  readonly changes: LearnCore['changes']
  readonly sessions: LearnCore['sessions']
  readonly log: LearnCore['log']
  readonly proposals: LearnCore['proposals']
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>()

  constructor(ctx: Context) {
    super(ctx, 'learnCore')
    this.dataRoot = resolveDataRoot()
    this.database = new Database(join(this.dataRoot, DATA_LAYOUT.database))
    this.database.migrate('core', coreMigrations)
    const database = this.database
    this.db = {
      sqlite: database.sqlite,
      migrate: (unit, steps) => database.migrate(unit, steps),
      transaction: fn => database.transaction(fn),
    }
    const store = new CoreStore(
      database,
      this.dataRoot,
      (event, payload) => (ctx.emit as (name: string, ...args: unknown[]) => void)(event, payload),
      () => ctx.workspaceRegistry,
    )
    this.courses = store.courses
    this.files = store.files
    this.changes = store.changes
    this.sessions = store.sessions
    this.log = store.log
    this.proposals = store.proposals
  }

  readonly api: LearnCore['api'] = {
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

  readonly feed: LearnCore['feed'] = {
    publish: (type: string, data: unknown): void => {
      const message: FeedMessage = { type, at: new Date().toISOString(), data }
      this.broadcast(`event: message\ndata: ${JSON.stringify(message)}\n\n`)
    },
  }

  /** Serve the feed stream; each open page holds one connection. */
  serveFeed(request: Request): Response {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start: c => {
        controller = c
        this.subscribers.add(c)
        c.enqueue(encoder.encode('retry: 3000\nevent: ready\ndata: {}\n\n'))
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

  dispose(): void {
    for (const controller of this.subscribers) {
      try { controller.close() } catch { /* already closed */ }
    }
    this.subscribers.clear()
    this.database.close()
  }
}

export function apply(ctx: Context): void {
  const core = new LearnCoreService(ctx)
  ctx.effect(() => () => core.dispose(), 'learning-core: close database and feed')

  // Relay the facts pages care about onto the change feed. Change records drop their full
  // before/after text (a textbook file can be large); pages re-read what they show.
  for (const event of FEED_EVENTS) {
    ;(ctx.on as (name: string, listener: (payload: unknown) => void) => () => void)(event, payload => {
      if (event === 'learning/change-applied') {
        const { before: _before, after: _after, ...summary } = payload as Change
        core.feed.publish(event, summary)
      } else {
        core.feed.publish(event, payload)
      }
    })
  }

  // Course list and creation for the shell and the home page.
  ctx.effect(() => core.api.endpoint({ unit: 'core', method: 'courses', handle: () => core.courses.list() }), 'learning-core: core.courses')
  ctx.effect(() => core.api.endpoint({
    unit: 'core',
    method: 'createCourse',
    input: z.object({ title: z.string().trim().min(1).max(60) }),
    handle: ({ title }) => core.courses.create({ title }),
  }), 'learning-core: core.createCourse')
  ctx.effect(() => core.api.endpoint({
    unit: 'core',
    method: 'changes',
    input: z.object({ courseId: z.string(), limit: z.number().int().positive().max(200).optional() }),
    handle: ({ courseId, limit }) => core.changes.list({ courseId, limit: limit ?? 50 })
      .map(({ before: _before, after: _after, ...summary }) => summary),
  }), 'learning-core: core.changes')

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
      void dispose()
    }
  }, 'learning-core: feed route')
}
