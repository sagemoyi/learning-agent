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
import * as settingsUnit from '../packages/settings/src/index.ts'

export const FIXTURES = resolve(import.meta.dirname, 'fixtures')

/** One model call as the fake model sees it. */
export interface ModelCall {
  readonly purpose: string
  /** `provider/model` the call was routed to. */
  readonly model: string
  readonly system: string
  readonly prompt: string
  /** Pictures sent with the prompt. */
  readonly images: number
}

/** A message delivered straight to an agent (the teacher's progress notices). */
export interface Delivered {
  readonly sessionId: string
  /** `followup` wakes the agent; `inject` waits for its next turn. */
  readonly mode: 'followup' | 'inject'
  readonly source: string
  readonly text: string
}

/** Role-model settings per unit (`provider/model`), as the settings page saves them; absent roles follow the default model. */
export interface HarnessSettings {
  readonly tutor?: { readonly model?: string }
  readonly sidechat?: { readonly model?: string; readonly summaryModel?: string; readonly restrictDuringTests?: boolean }
  readonly textbook?: { readonly model?: string; readonly checkModel?: string; readonly webCheck?: boolean }
  readonly assess?: { readonly model?: string }
  readonly knowledge?: { readonly model?: string }
}

/** An endpoint's result envelope. */
export interface EndpointResult<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { readonly code: string; readonly message: string }
}

export interface Harness {
  readonly ctx: Context
  readonly calls: ModelCall[]
  /** Models the units pointed sessions at (`sessionController.selectModel`). */
  readonly selections: { readonly sessionId: string; readonly provider: string; readonly model: string }[]
  readonly delivered: Delivered[]
  readonly sessions: Map<string, { events: { type: string; data: unknown }[] }>
  /** Call an endpoint the way the page does, through its exact route and the RPC envelope. */
  endpoint<T = any>(unit: string, method: string, payload: unknown): Promise<T>
  /** Call an exact fetch route (binary uploads and downloads), e.g. `/api/learning/assess.photo?…`. */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** Like `endpoint`, but returns the result envelope, so a test can look at a failure. */
  call<T = any>(unit: string, method: string, payload: unknown): Promise<EndpointResult<T>>
  /** Let queued handoffs and other timers run. */
  settle(ms?: number): Promise<void>
  /** The data folder (`LEARNING_HOME`); `createHarness(…, { root })` starts again on the same data, like a restart. */
  readonly root: string
  /** Close the database; `keep` leaves the data folder for a restart. */
  dispose(keep?: boolean): void
}

/** `reply` answers each model call; throw from it to simulate a failure. */
export function createHarness(reply: (call: ModelCall) => string | { readonly finish: 'max-tokens' }, settings: HarnessSettings = {}, options: { readonly root?: string } = {}): Harness {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'learning-test-'))
  process.env.LEARNING_HOME = root
  const ctx = new Context()
  const routes = new Map<string, { fetch(request: Request): Promise<Response> }>()
  const sessions = new Map<string, { events: { type: string; data: unknown }[] }>()
  const calls: ModelCall[] = []
  const selections: Harness['selections'][number][] = []
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
    selectModel: async (request: { sessionId: string; provider: string; model: string }) => {
      selections.push({ sessionId: request.sessionId, provider: request.provider, model: request.model })
      return { selected: request }
    },
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
  // Images handed to the model are only counted; the fake model never looks at them.
  ctx.provide('attachments', {
    saveImages: async (inputs: { data: Uint8Array; mediaType: string }[]) => inputs.map((input, index) => ({ attachmentId: `att-${index}`, mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 })),
  })
  ctx.provide('sessions', { flush: async () => true })
  ctx.provide('llm', {
    async *stream(options: { purpose: string; provider: string; model: string; system: string; messages: { content: { type: string; text?: string }[] }[] }) {
      const content = options.messages[0]!.content
      const call = { purpose: options.purpose, model: `${options.provider}/${options.model}`, system: options.system, prompt: content.filter(part => part.type === 'text').map(part => part.text).join(''), images: content.filter(part => part.type === 'image').length }
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
  // Settings as DSH passes them to the units. Local parsing and no semantic search: tests never reach paid services.
  core.apply(ctx as never)
  library.apply(ctx as never, library.Config({ parser: 'local', semanticSearch: false }))
  knowledge.apply(ctx as never, knowledge.Config(settings.knowledge))
  goal.apply(ctx as never)
  assess.apply(ctx as never, assess.Config(settings.assess))
  curriculum.apply(ctx as never)
  // No web supplement unless a test asks for it (and fakes the search): `searchWeb` would use real keys.
  textbook.apply(ctx as never, textbook.Config({ webCheck: false, ...settings.textbook }))
  learner.apply(ctx as never)
  sidechat.apply(ctx as never, sidechat.Config(settings.sidechat))
  planner.apply(ctx as never)
  tutor.apply(ctx as never, tutor.Config({ ...settings.tutor, handoffDelayMs: 0 }))
  settingsUnit.apply(ctx as never)

  async function call<T>(unit: string, method: string, payload: unknown): Promise<EndpointResult<T>> {
    const route = routes.get(`/api/learning/${unit}.${method}`)
    expect(route, `${unit}.${method} registered`).toBeTruthy()
    const response = await route!.fetch(new Request(`http://localhost/api/learning/${unit}.${method}`, {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', payload }),
    }))
    return (await response.json() as { result: EndpointResult<T> }).result
  }
  return {
    ctx,
    calls,
    selections,
    delivered,
    sessions,
    call,
    async endpoint<T>(unit: string, method: string, payload: unknown): Promise<T> {
      const result = await call<T>(unit, method, payload)
      expect(result.ok, JSON.stringify(result.error)).toBe(true)
      return result.value as T
    },
    fetch(path: string, init?: RequestInit) {
      const route = routes.get(path.split('?')[0]!)
      expect(route, `${path} registered`).toBeTruthy()
      return route!.fetch(new Request(`http://localhost${path}`, init))
    },
    settle: (ms = 30) => new Promise(done => setTimeout(done, ms)),
    root,
    dispose(keep = false) {
      ctx.learnCore.db.sqlite.close()
      if (!keep) rmSync(root, { recursive: true, force: true })
    },
  }
}

/** The subsection headings of the material a writer call was given, as `###` lines: a fake writer that covers them all. */
export function headingsOf(call: ModelCall): string {
  const material = call.prompt.split('# 资料片段').at(-1) ?? ''
  return [...material.matchAll(/^(\d+(?:\.\d+)+ \S.*)$/gm)].map(match => `### ${match[1]}`).join('\n\n')
}

/** Wait until a lesson's textbook generation settles (ready or failed). */
export function textbookSettled(ctx: Context, lessonId: string): Promise<'ready' | 'failed'> {
  return new Promise(done => {
    const offReady = ctx.on('learning/textbook-ready', event => { if (event.lessonId === lessonId) { offReady(); offFailed(); done('ready') } })
    const offFailed = ctx.on('learning/textbook-failed', event => { if (event.lessonId === lessonId) { offReady(); offFailed(); done('failed') } })
  })
}
