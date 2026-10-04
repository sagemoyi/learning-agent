// Shared harness for cross-unit tests: every host unit's real service, endpoint, table, course file
// and event, on a fresh data root; DSH's transport, sessions, agents and the model are fakes.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as core from '../packages/core/src/index.ts'
import * as library from '../packages/library/src/index.ts'
import * as knowledge from '../packages/knowledge/src/index.ts'
import * as goal from '../packages/goal/src/index.ts'
import * as assess from '../packages/assess/src/index.ts'
import * as curriculum from '../packages/curriculum/src/index.ts'
import * as textbook from '../packages/textbook/src/index.ts'
import * as learner from '../packages/learner/src/index.ts'
import * as sidechat from '../packages/sidechat/src/index.ts'
import * as tutor from '../packages/tutor/src/index.ts'
import * as planner from '../packages/planner/src/index.ts'

export const FIXTURES = resolve(import.meta.dirname, 'fixtures')

/** One model call as the fake model sees it. */
export interface ModelCall {
  readonly purpose: string
  readonly system: string
  readonly prompt: string
}

/** A message delivered straight to an agent (the teacher's progress notices). */
export interface Delivered {
  readonly sessionId: string
  /** `followup` wakes the agent; `inject` waits for its next turn. */
  readonly mode: 'followup' | 'inject'
  readonly source: string
  readonly text: string
}

export interface Harness {
  readonly ctx: Context
  readonly calls: ModelCall[]
  readonly delivered: Delivered[]
  readonly sessions: Map<string, { events: { type: string; data: unknown }[] }>
  /** Call an endpoint the way the page does, through its exact route and the RPC envelope. */
  endpoint<T = any>(unit: string, method: string, payload: unknown): Promise<T>
  /** Let queued handoffs and other timers run. */
  settle(ms?: number): Promise<void>
  dispose(): void
}

/** `reply` answers each model call; throw from it to simulate a failure. */
export function createHarness(reply: (call: ModelCall) => string | { readonly finish: 'max-tokens' }): Harness {
  const root = mkdtempSync(join(tmpdir(), 'learning-test-'))
  process.env.LEARNING_HOME = root
  const ctx = new Context()
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>()
  const sessions = new Map<string, { events: { type: string; data: unknown }[] }>()
  const calls: ModelCall[] = []
  const delivered: Delivered[] = []

  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; fetch(request: Request): Promise<Response> }) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  })
  ctx.provide('workspaceRegistry', { create: async () => ({ id: globalThis.crypto.randomUUID() }) })
  ctx.provide('sessionController', {
    modelCatalog: async () => ({ default: { provider: 'fixture', model: 'fixture' } }),
    create: async (input: { sessionId: string }) => {
      sessions.set(input.sessionId, { events: [] })
      return { sessionId: input.sessionId }
    },
    inspect: async (id: string) => sessions.get(id),
    prompt: async (input: { sessionId: string; content: unknown }) => {
      const session = sessions.get(input.sessionId)!
      session.events.push({ type: 'user/message', data: { content: input.content, source: { kind: 'user' } } })
      session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '水深加倍，静水压强也加倍。' }] } } })
      return { ok: true }
    },
    resolveAgent: async (sessionId: string) => {
      if (!sessions.has(sessionId)) return { error: new Error(`no session ${sessionId}`) }
      const deliver = (mode: Delivered['mode']) => (message: { content: { text: string }[]; source: { kind: string } }) => {
        delivered.push({ sessionId, mode, source: message.source.kind, text: message.content.map(part => part.text).join('') })
      }
      return { agent: { session: { id: sessionId }, followup: deliver('followup'), inject: deliver('inject') } }
    },
  })
  ctx.provide('agents', { withoutInitiator: <T>(operation: () => T) => operation() })
  ctx.provide('sessions', { flush: async () => true })
  ctx.provide('llm', {
    async *stream(options: { purpose: string; system: string; messages: { content: { text: string }[] }[] }) {
      const call = { purpose: options.purpose, system: options.system, prompt: options.messages[0]!.content[0]!.text }
      calls.push(call)
      const answer = reply(call)
      if (typeof answer !== 'string') {
        yield { type: 'text-delta', index: 0, text: '截断的' }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  for (const plugin of [core, library, knowledge, goal, assess, curriculum, textbook, learner, sidechat, planner]) plugin.apply(ctx as never)
  tutor.apply(ctx as never, { handoffDelayMs: 0 })

  return {
    ctx,
    calls,
    delivered,
    sessions,
    async endpoint<T>(unit: string, method: string, payload: unknown): Promise<T> {
      const route = routes.get(`/api/learning/${unit}.${method}`)
      expect(route, `${unit}.${method} registered`).toBeTruthy()
      const response = await route!.fetch(new Request(`http://localhost/api/learning/${unit}.${method}`, {
        method: 'POST',
        body: JSON.stringify({ type: 'client-request', rpcId: 'test', payload }),
      }))
      const message = await response.json() as { result: { ok: boolean; value: T; error?: unknown } }
      expect(message.result.ok, JSON.stringify(message.result.error)).toBe(true)
      return message.result.value
    },
    settle: (ms = 30) => new Promise(done => setTimeout(done, ms)),
    dispose() {
      ctx.learnCore.db.sqlite.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Wait until a lesson's textbook generation settles (ready or failed). */
export function textbookSettled(ctx: Context, lessonId: string): Promise<'ready' | 'failed'> {
  return new Promise(done => {
    const offReady = ctx.on('learning/textbook-ready', event => { if (event.lessonId === lessonId) { offReady(); offFailed(); done('ready') } })
    const offFailed = ctx.on('learning/textbook-failed', event => { if (event.lessonId === lessonId) { offReady(); offFailed(); done('failed') } })
  })
}
