// sidechat unit, host half. Provides `ctx.learnSidechat` (contracts §5.1, docs/sidechat/design.md): a side chat
// bound to the page and selection, isolated from the teacher's session; when it ends, the record
// is summarized into `notes/side-chats.md` and turned into learning signals and help records.
// Skeleton: course scope only; proposals from side chats come with the tutor's proposal flow.
import { Service, type Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-settings'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import {
  COURSE_LAYOUT,
  HelpLevel,
  LearningApiError,
  Selection,
  SideChatSummary,
  newId,
  type LearnSidechat,
  type Migration,
} from '@learning-agent/contracts'
import { complete, must, now, parseJsonReply, routeOf, selectSessionModel } from '@learning-agent/kit'
import { roleModel, Schema } from '@learning-agent/kit/settings'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'learning-side-chat-context': { kind: 'learning-side-chat-context' } & ContextFormed
  }
}

export const name = 'learning-sidechat'
export const inject = ['learnCore', 'learnKnowledge', 'sessionController', 'llm']

const CONTEXT_SOURCE = 'learning-side-chat-context'

export const Config = Schema.object({
  model: roleModel('侧边提问'),
  summaryModel: roleModel('侧边会话总结'),
})
export type Config = ReturnType<typeof Config>

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE sidechat_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        course_id TEXT,
        data TEXT NOT NULL
      );
    `,
  },
]

const SUMMARIZER_SYSTEM = `你负责把一次"侧边答疑会话"整理成结构化总结，供老师和学习分析使用。只根据会话内容整理，不要补充。
只输出一个 JSON 对象：
{"questions":["学习者问了什么（每条一句）"],"conclusions":["得出的结论（每条一句）"],"nodeIds":["涉及的知识节点 ID，只能从给出的列表里选"],"misconceptions":["从提问里看出的可能误解，没有就空数组"],"help":[{"nodeIds":["…"],"level":"hint|explanation|worked-solution|answer-revealed"}]}
help 记录助手给了什么程度的帮助：只给提示是 hint，讲解概念是 explanation，完整解出一道题是 worked-solution，直接给出答案是 answer-revealed；只是闲聊就空数组。`

const SummaryReply = z.object({
  questions: z.array(z.string()).default([]),
  conclusions: z.array(z.string()).default([]),
  nodeIds: z.array(z.string()).default([]),
  misconceptions: z.array(z.string()).default([]),
  help: z.array(z.object({ nodeIds: z.array(z.string()).default([]), level: HelpLevel })).default([]),
})

/** Concatenate the text parts of a message-like value. */
function textOf(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(part => ((part as { type?: string })?.type === 'text' ? String((part as { text?: unknown }).text ?? '') : '')).join('')
  const record = value as Record<string, unknown>
  if (record.content) return textOf(record.content)
  if (record.message) return textOf(record.message)
  return ''
}

class LearnSidechatService extends Service implements LearnSidechat {
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'learnSidechat')
    ctx.learnCore.db.migrate('sidechat', migrations)
  }

  /** Context lines for a selection, assembled by the units that own what was selected. */
  async contextFor(selection: Selection): Promise<string> {
    const lines = await this.ctx.waterfall('learning/describe-selection', selection, async () => [] as string[])
    const where = selection.selected?.label ?? selection.page
    return [`【侧边会话上下文】学习者在「${where}」页面打开了这次提问。`, ...lines].join('\n\n')
  }

  async open(selection: Selection): Promise<{ sessionId: string }> {
    const parsed = Selection.parse(selection)
    if (!parsed.courseId) throw new LearningApiError('learning/sidechat/needs-course', '骨架阶段的侧边会话只能在课程里打开')
    const course = must(this.ctx.learnCore.courses.get(parsed.courseId), 'sidechat', '课程', parsed.courseId)
    const sessionId = globalThis.crypto.randomUUID()
    this.ctx.learnCore.sessions.link({ sessionId, courseId: course.id, role: 'side-chat', openedFrom: parsed, createdAt: now() })
    await this.ctx.sessionController.create({ workspaceId: course.workspaceId as never, sessionId: sessionId as never, agentPreset: 'side-chat' })
    // A new session starts on the default model; a 侧边提问 setting moves it before its first request.
    const role = routeOf(this.config.model.get())
    if (role) await selectSessionModel(this.ctx, sessionId, role)
    return { sessionId }
  }

  async close(sessionId: string, signal?: AbortSignal): Promise<SideChatSummary> {
    const existing = this.ctx.learnCore.db.sqlite.prepare('SELECT data FROM sidechat_summaries WHERE session_id = ?').get(sessionId) as { data: string } | undefined
    if (existing) return SideChatSummary.parse(JSON.parse(existing.data))
    const link = must(this.ctx.learnCore.sessions.get(sessionId), 'sidechat', '会话', sessionId)
    if (link.role !== 'side-chat') throw new LearningApiError('learning/sidechat/not-side-chat', '这不是侧边会话', { sessionId })
    const courseId = link.courseId!
    const inspection = await this.ctx.sessionController.inspect(sessionId as never, signal) as unknown as { events?: { type: string; data: unknown }[] }
    const transcript = (inspection.events ?? [])
      .filter(event => event.type === 'user/message' || event.type === 'assistant/message')
      .map(event => {
        const source = (event.data as { source?: { kind?: string } })?.source?.kind
        const who = event.type === 'assistant/message' ? '助手' : source === CONTEXT_SOURCE ? '上下文' : '学习者'
        return `【${who}】${textOf(event.data)}`
      })
    const asked = transcript.some(line => line.startsWith('【学习者】'))
    const nodes = this.ctx.learnKnowledge.graph(courseId).nodes
    let reply: z.infer<typeof SummaryReply> = { questions: [], conclusions: [], nodeIds: [], misconceptions: [], help: [] }
    if (asked) {
      const text = await complete(this.ctx, {
        system: SUMMARIZER_SYSTEM,
        prompt: `可选的知识节点：\n${nodes.map(node => `${node.id} ${node.title}`).join('\n') || '（无）'}\n\n会话记录：\n${transcript.join('\n\n')}`,
        purpose: 'learning-sidechat-summary',
        model: this.config.summaryModel.get(),
        // DeepSeek's output cap includes thinking as well as the visible JSON.
        maxTokens: 4000,
        ...(signal ? { signal } : {}),
      })
      reply = SummaryReply.parse(parseJsonReply(text))
    }
    const known = new Set<string>(nodes.map(node => node.id))
    const nodeIds = reply.nodeIds.filter(id => known.has(id))
    const help = reply.help.map(item => ({ nodeIds: item.nodeIds.filter(id => known.has(id)), level: item.level })).filter(item => item.nodeIds.length)
    const summary = SideChatSummary.parse({
      id: newId('summary'),
      sessionId,
      courseId,
      at: now(),
      ...(link.openedFrom ? { openedFrom: link.openedFrom } : {}),
      questions: reply.questions,
      conclusions: reply.conclusions,
      nodeIds,
      misconceptions: reply.misconceptions,
      helpGiven: help,
      proposalIds: [],
    })

    if (asked) {
      const title = (id: string) => nodes.find(node => node.id === id)?.title ?? id
      const levels = { hint: '提示', explanation: '讲解', 'worked-solution': '完整解答', 'answer-revealed': '看答案' }
      const stamp = new Date(summary.at)
      const pad = (n: number) => String(n).padStart(2, '0')
      const block = [
        `## ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())} · ${link.openedFrom?.selected?.label ?? link.openedFrom?.page ?? '课程'}`,
        '',
        `- 问了什么：${summary.questions.join('；') || '—'}`,
        `- 结论：${summary.conclusions.join('；') || '—'}`,
        `- 涉及节点：${summary.nodeIds.map(title).join('、') || '—'}`,
        `- 可能的误解：${summary.misconceptions.join('；') || '无'}`,
        `- 给了什么帮助：${summary.helpGiven.map(item => `${levels[item.level]}（${item.nodeIds.map(title).join('、')}）`).join('；') || '无'}`,
        `- 会话：${sessionId}`,
        '',
      ].join('\n')
      const current = await this.ctx.learnCore.files.read(courseId, COURSE_LAYOUT.sideChats)
      await this.ctx.learnCore.files.append(courseId, COURSE_LAYOUT.sideChats, `${current ? '\n' : '# 侧边会话总结\n\n'}${block}`, { actor: 'system', reason: '侧边会话总结' })
    }

    const core = this.ctx.learnCore
    core.db.transaction(() => {
      const context = { sessionId: sessionId as SideChatSummary['sessionId'] }
      if (summary.nodeIds.length && summary.questions.length) {
        core.log.append({ type: 'signal.question', courseId, nodeIds: summary.nodeIds, context, text: summary.questions.join('；') })
      }
      for (const misconception of summary.misconceptions) {
        core.log.append({ type: 'signal.misconception', courseId, nodeIds: summary.nodeIds, context, text: misconception })
      }
      for (const item of summary.helpGiven) {
        core.log.append({ type: 'help.given', courseId, nodeIds: item.nodeIds, context, level: item.level, via: 'side-chat' })
      }
      core.db.sqlite.prepare('INSERT INTO sidechat_summaries (id, session_id, course_id, data) VALUES (?, ?, ?, ?)').run(summary.id, sessionId, courseId, JSON.stringify(summary))
    })
    core.sessions.close(sessionId)
    this.ctx.emit('learning/sidechat-summarized', summary)
    return summary
  }
}

export function apply(ctx: Context, config: Config): void {
  const sidechat = new LearnSidechatService(ctx, config)
  const contexted = new Set<string>()

  // The selection's context goes in before the first step of the side chat's first turn.
  ctx.on('agent/pre-step', async ({ agent, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || step !== 1) return decision
    const sessionId = agent.session.id
    if (contexted.has(sessionId)) return decision
    const link = ctx.learnCore.sessions.get(sessionId)
    if (link?.role !== 'side-chat' || !link.openedFrom) return decision
    contexted.add(sessionId)
    const text = await sidechat.contextFor(link.openedFrom)
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({ content: [{ type: 'text', text }], source: { kind: CONTEXT_SOURCE, form: 'snapshot', sections: [{ name: CONTEXT_SOURCE, text }] } }),
      ],
    }
  }, { prepend: true })

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'sidechat',
    method: 'open',
    input: z.object({ selection: Selection }),
    handle: ({ selection }) => sidechat.open(selection),
  }), 'sidechat: open')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'sidechat',
    method: 'close',
    input: z.object({ sessionId: z.string() }),
    handle: ({ sessionId }, signal) => sidechat.close(sessionId, signal),
  }), 'sidechat: close')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'sidechat',
    method: 'active',
    input: z.object({ courseId: z.string() }),
    handle: ({ courseId }) => {
      const open = ctx.learnCore.sessions.list({ courseId, role: 'side-chat' }).filter(link => !link.closedAt).at(-1)
      return open ? { sessionId: open.sessionId, label: open.openedFrom?.selected?.label ?? open.openedFrom?.page ?? '' } : null
    },
  }), 'sidechat: active')

  // Open side chats keep the model they were created with until the 侧边提问 model, or the default
  // it follows, changes; then they move to it from the next request on.
  ctx.on('settings/document-updated', ns => {
    if (ns !== name && ns !== 'agent-default-model') return
    for (const link of ctx.learnCore.sessions.list({ role: 'side-chat' })) {
      if (!link.closedAt) selectSessionModel(ctx, link.sessionId, config.model.get()).catch(error => ctx.logger('learning-sidechat').warn('model switch failed: %s', (error as Error).stack ?? error))
    }
  })
}
