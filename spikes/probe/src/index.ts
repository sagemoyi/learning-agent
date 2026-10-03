// Stage-0 step-3 probe, host half. Each endpoint checks one assumption from contracts §9:
//   probe.feed     (1) the change feed reaches the page
//   probe.course   (3) a host plugin registers a workspace and creates a session in it under our own id
//   probe.brief    (4) a per-turn "course brief" injected through agent/pre-step reaches the model
//   probe.inspect  (5) a finished session's full record is readable from the host
//   probe.llm      (6) a one-shot model call without a session works through the relay
// (2) and (7) are checked by the client half and by the build itself.
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@learning-agent/contracts'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'learning-course-brief': { kind: 'learning-course-brief' } & ContextFormed
  }
}

export const name = 'learning-probe'
export const inject = ['learnCore', 'workspaceRegistry', 'sessionController', 'llm', 'agents']

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const BRIEF_SOURCE = 'learning-course-brief'
const BRIEF = '【课程现状简报（探针）】课程：化工原理；当前阶段：第 1 章 流体流动；当前小节：1.3。本次暗号：青蛙跳水。'

/** Concatenate the text parts of a message-like value. */
function textOf(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(part => (part?.type === 'text' ? String(part.text) : '')).join('')
  const record = value as Record<string, unknown>
  if (record.content) return textOf(record.content)
  if (record.message) return textOf(record.message)
  return ''
}

export function apply(ctx: Context): void {
  const briefSessions = new Set<string>()

  // (4) Course brief: appended to the first step of every turn in sessions we opted in.
  ctx.on('agent/pre-step', async ({ agent, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || step !== 1 || !briefSessions.has(agent.session.id)) return decision
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: BRIEF }],
          source: { kind: BRIEF_SOURCE, form: 'snapshot', sections: [{ name: BRIEF_SOURCE, text: BRIEF }] },
        }),
      ],
    }
  }, { prepend: true })

  /** Resolve with the assistant text of the next completed turn in one session. */
  function nextReply(sessionId: string, timeoutMs: number): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      let text = ''
      const timer = setTimeout(() => { dispose(); reject(new Error(`no reply within ${timeoutMs} ms`)) }, timeoutMs)
      const dispose = ctx.on('session/event', (session, event) => {
        if (session.id !== sessionId) return
        if (event.type === 'assistant/message') text += textOf(event.data)
        if (event.type === 'turn/end') {
          clearTimeout(timer)
          dispose()
          resolvePromise(text)
        }
      })
    })
  }

  const endpoint = ctx.learnCore.api.endpoint

  ctx.effect(() => endpoint({
    unit: 'probe',
    method: 'feed',
    handle: () => {
      ctx.learnCore.feed.publish('probe/ping', { note: '来自后端的推送' })
      return { sent: true }
    },
  }), 'probe: feed')

  ctx.effect(() => endpoint({
    unit: 'probe',
    method: 'course',
    handle: async () => {
      const dir = join(repoRoot, '.data', 'courses', `probe-${Date.now()}`)
      mkdirSync(dir, { recursive: true })
      const workspace = await ctx.workspaceRegistry.create(dir, '探针课程')
      const requested = globalThis.crypto.randomUUID()
      const created = await ctx.sessionController.create({
        workspaceId: workspace.id,
        sessionId: requested as never,
        agentPreset: 'teacher',
      })
      const attachedByCreate = workspace.sessionIds.includes(created.sessionId)
      if (!attachedByCreate) await workspace.attachSession(created.sessionId)
      return {
        workspaceId: workspace.id,
        path: workspace.path,
        requestedSessionId: requested,
        sessionId: created.sessionId,
        sameId: created.sessionId === requested,
        agentPreset: created.agentPreset,
        attachedByCreate,
        attachedNow: workspace.sessionIds.includes(created.sessionId),
      }
    },
  }), 'probe: course')

  ctx.effect(() => endpoint({
    unit: 'probe',
    method: 'brief',
    input: z.object({ sessionId: z.string() }),
    handle: async ({ sessionId }, signal) => {
      briefSessions.add(sessionId)
      const reply = nextReply(sessionId, 120_000)
      await ctx.sessionController.prompt({
        requestId: globalThis.crypto.randomUUID() as never,
        sessionId: sessionId as never,
        mode: 'queue',
        content: [{ type: 'text', text: '请只回答：简报里的暗号是什么？' }],
      }, signal)
      const text = await reply
      return { reply: text, containsSecret: text.includes('青蛙跳水') }
    },
  }), 'probe: brief')

  ctx.effect(() => endpoint({
    unit: 'probe',
    method: 'inspect',
    input: z.object({ sessionId: z.string() }),
    handle: async ({ sessionId }, signal) => {
      const inspection = await ctx.sessionController.inspect(sessionId as never, signal) as unknown as Record<string, unknown>
      const events = (inspection.events ?? (inspection.prefix as Record<string, unknown> | undefined)?.events ?? []) as { type: string; data: unknown }[]
      const counts: Record<string, number> = {}
      for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
      const messages = events
        .filter(event => event.type === 'user/message' || event.type === 'assistant/message')
        .map(event => ({
          type: event.type,
          source: (event.data as { source?: { kind?: string } })?.source?.kind,
          text: textOf(event.data).slice(0, 200),
        }))
      return { keys: Object.keys(inspection), state: inspection.state ?? inspection.kind, eventCount: events.length, counts, messages }
    },
  }), 'probe: inspect')

  ctx.effect(() => endpoint({
    unit: 'probe',
    method: 'llm',
    handle: async (_input, signal) => {
      const catalog = await ctx.sessionController.modelCatalog() as unknown as Record<string, unknown>
      const route = (catalog.default ?? catalog.deploymentDefault) as { provider: string; model: string } | undefined
      if (!route) throw new Error(`model catalog has no default: ${JSON.stringify(Object.keys(catalog))}`)
      const started = Date.now()
      let text = ''
      const chunkTypes = new Set<string>()
      for await (const chunk of ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system: '你是化工原理助教。只用一句中文回答。',
        messages: [createUserMessage({ content: [{ type: 'text', text: '雷诺数小于多少时，圆管内流动一般为层流？' }], source: { kind: 'user' } })],
        maxTokens: 400,
        purpose: 'learning-probe',
        signal,
      } as never)) {
        const record = chunk as Record<string, unknown>
        chunkTypes.add(String(record.type))
        if (record.type === 'text-delta' && typeof record.text === 'string') text += record.text
      }
      return { route, ms: Date.now() - started, chunkTypes: [...chunkTypes], text }
    },
  }), 'probe: llm')
}
