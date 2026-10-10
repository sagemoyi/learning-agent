// sidechat unit, host half. Provides `ctx.learnSidechat` (contracts §5.1, docs/sidechat/design.md): a side chat
// bound to the page and selection, isolated from the teacher's session; when it ends, the record
// is summarized into `notes/side-chats.md` and turned into learning signals and help records.
// Batch A (docs/sidechat/design.md): the tools are held to read-only at the moment they run, an open test limits the chat to
// how the test works, creating and closing a chat can be repeated after any failure, and help is logged at the time it was given.
// Course scope only; proposals from side chats come with the tutor's proposal flow.
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
import { complete, must, now, parseJsonReply, routeOf, selectSessionModel, sessionLines, type SessionLine } from '@learning-agent/kit'
import { roleModel, Schema } from '@learning-agent/kit/settings'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'learning-side-chat-context': { kind: 'learning-side-chat-context' } & ContextFormed
    'learning-side-chat-policy': { kind: 'learning-side-chat-policy' } & ContextFormed
  }
}

export const name = 'learning-sidechat'
export const inject = ['learnCore', 'learnKnowledge', 'sessionController', 'llm']

const CONTEXT_SOURCE = 'learning-side-chat-context'
const POLICY_SOURCE = 'learning-side-chat-policy'

export const Config = Schema.object({
  model: roleModel('侧边提问'),
  summaryModel: roleModel('侧边会话总结'),
  restrictDuringTests: Schema.boolean().default(true).description('测试进行中，侧边提问只说明怎么操作').volatile(),
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
会话记录里每条消息前有编号，如 【#3 学习者】。只输出一个 JSON 对象：
{"questions":["学习者问了什么（每条一句）"],"conclusions":["得出的结论（每条一句）"],"nodeIds":["涉及的知识节点 ID，只能从给出的列表里选"],"misconceptions":[{"text":"可能的误解（一句）","quote":"学习者说的原话，必须逐字取自某条【学习者】消息","nodeIds":["这条误解涉及的节点 ID，只能从列表里选"]}],"help":[{"nodeIds":["…"],"level":"hint|explanation|worked-solution|answer-revealed","message":3}]}
help 记录助手给了什么程度的帮助：只给提示是 hint，讲解概念是 explanation，完整解出一道题是 worked-solution，直接给出答案是 answer-revealed；message 是给出这个帮助的【助手】消息的编号；只是闲聊就空数组。
误解只记学习者自己的话里看出来的：学习者在引用别人的说法、提问、假设、或已经自己纠正了的，不算误解；没有就空数组。`

const SummaryReply = z.object({
  questions: z.array(z.string()).default([]),
  conclusions: z.array(z.string()).default([]),
  nodeIds: z.array(z.string()).default([]),
  misconceptions: z.array(z.union([
    z.string().transform(text => ({ text, quote: '', nodeIds: [] as string[] })),
    z.object({ text: z.string(), quote: z.string().default(''), nodeIds: z.array(z.string()).default([]) }),
  ])).default([]),
  help: z.array(z.object({ nodeIds: z.array(z.string()).default([]), level: HelpLevel, message: z.number().int().optional() })).default([]),
})

const WHO = { learner: '学习者', assistant: '助手', context: '上下文' } as const
/** What the learner may ask while a test is open (see `checkTool`). */
const READ_TOOLS = new Set(['search_library', 'read_section'])
const squash = (text: string) => text.replace(/\s+/g, '')

class LearnSidechatService extends Service implements LearnSidechat {
  /** Closings in progress, by session: a second call joins the first. */
  private readonly closing = new Map<string, Promise<SideChatSummary>>()

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'learnSidechat')
    ctx.learnCore.db.migrate('sidechat', migrations)
  }

  /** A test of the course is open (assess owns what that means; we only ask). */
  testOpen(courseId: string | undefined): boolean {
    if (!courseId || !this.config.restrictDuringTests.get()) return false
    return this.ctx.get('learnAssess')?.tests(courseId).some(test => test.status === 'open') ?? false
  }

  checkTool(sessionId: string, tool: string): { readonly allowed: boolean; readonly reason?: string } {
    const link = this.ctx.learnCore.sessions.get(sessionId)
    if (link?.role !== 'side-chat') return { allowed: true }
    if (!READ_TOOLS.has(tool)) {
      return { allowed: false, reason: '侧边会话只能查本课资料库（search_library、read_section），不能联网找资料，也不能加入资料。需要补资料，请学习者回到主老师那里提。' }
    }
    if (this.testOpen(link.courseId)) {
      return { allowed: false, reason: '现在有一场测试正在进行：侧边会话只能说明怎么操作（怎么交卷、计时、拍照作答），不查资料、不讨论题目。想讨论题目，请学习者先离开测试；这次作答会记为有帮助。' }
    }
    return { allowed: true }
  }

  /** Context lines for a selection, assembled by the units that own what was selected. */
  async contextFor(selection: Selection): Promise<string> {
    const where = selection.selected?.label ?? selection.page
    // An open test: nothing about the problems goes into the chat's context.
    if (this.testOpen(selection.courseId)) return `【侧边会话上下文】学习者在「${where}」页面打开了这次提问。现在有一场测试正在进行，不提供题目和资料内容。`
    const lines = await this.ctx.waterfall('learning/describe-selection', selection, async () => [] as string[])
    return [`【侧边会话上下文】学习者在「${where}」页面打开了这次提问。`, ...lines].join('\n\n')
  }

  async open(selection: Selection): Promise<{ sessionId: string }> {
    const parsed = Selection.parse(selection)
    if (!parsed.courseId) throw new LearningApiError('learning/sidechat/needs-course', '骨架阶段的侧边会话只能在课程里打开')
    const course = must(this.ctx.learnCore.courses.get(parsed.courseId), 'sidechat', '课程', parsed.courseId)
    const sessionId = globalThis.crypto.randomUUID()
    this.ctx.learnCore.sessions.link({ sessionId, courseId: course.id, role: 'side-chat', openedFrom: parsed, createdAt: now() })
    try {
      await this.ctx.sessionController.create({ workspaceId: course.workspaceId as never, sessionId: sessionId as never, agentPreset: 'side-chat' })
      // A new session starts on the default model; a 侧边提问 setting moves it before its first request.
      const role = routeOf(this.config.model.get())
      if (role) await selectSessionModel(this.ctx, sessionId, role)
    } catch (error) {
      // The attribution is recorded before the session exists; if the session cannot be made, it must not stay listed as a chat to go back to.
      this.ctx.learnCore.sessions.close(sessionId)
      throw error
    }
    return { sessionId }
  }

  close(sessionId: string, signal?: AbortSignal): Promise<SideChatSummary> {
    const running = this.closing.get(sessionId)
    if (running) return running
    const job = this.finish(sessionId, signal).finally(() => this.closing.delete(sessionId))
    this.closing.set(sessionId, job)
    return job
  }

  /** The conversation and the selection's context, in order; context other plugins add is left out. */
  private async turns(sessionId: string, signal?: AbortSignal): Promise<SessionLine[]> {
    return (await sessionLines(this.ctx, sessionId, signal)).filter(line => line.who !== 'context' || line.source === CONTEXT_SOURCE)
  }

  private stored(sessionId: string): SideChatSummary | undefined {
    const row = this.ctx.learnCore.db.sqlite.prepare('SELECT data FROM sidechat_summaries WHERE session_id = ?').get(sessionId) as { data: string } | undefined
    return row ? SideChatSummary.parse(JSON.parse(row.data)) : undefined
  }

  /**
   * Close in steps that each tolerate being done already, so a call after any failure picks up where the last stopped:
   * summary (stored once) → note in the course folder (once per session) → log and summary row (one transaction) →
   * session closed and announced.
   */
  private async finish(sessionId: string, signal?: AbortSignal): Promise<SideChatSummary> {
    const core = this.ctx.learnCore
    const link = must(core.sessions.get(sessionId), 'sidechat', '会话', sessionId)
    if (link.role !== 'side-chat') throw new LearningApiError('learning/sidechat/not-side-chat', '这不是侧边会话', { sessionId })
    const existing = this.stored(sessionId)
    if (existing) {
      // An earlier call stored the summary and stopped before the session was closed or announced.
      if (!link.closedAt) {
        core.sessions.close(sessionId)
        this.ctx.emit('learning/sidechat-summarized', existing)
      }
      return existing
    }
    const courseId = link.courseId!
    const turns = await this.turns(sessionId, signal)
    const asked = turns.some(turn => turn.who === 'learner')
    const nodes = this.ctx.learnKnowledge.graph(courseId).nodes
    let reply: z.infer<typeof SummaryReply> = { questions: [], conclusions: [], nodeIds: [], misconceptions: [], help: [] }
    if (asked) {
      const text = await complete(this.ctx, {
        system: SUMMARIZER_SYSTEM,
        prompt: `可选的知识节点：\n${nodes.map(node => `${node.id} ${node.title}`).join('\n') || '（无）'}\n\n会话记录：\n${turns.map(turn => `【#${turn.seq} ${WHO[turn.who]}】${turn.text}`).join('\n\n')}`,
        purpose: 'learning-sidechat-summary',
        model: this.config.summaryModel.get(),
        // DeepSeek's output cap includes thinking as well as the visible JSON.
        maxTokens: 4000,
        ...(signal ? { signal } : {}),
      })
      reply = SummaryReply.parse(parseJsonReply(text))
    }
    const known = new Set<string>(nodes.map(node => node.id))
    const only = (ids: readonly string[]) => ids.filter(id => known.has(id)) as SideChatSummary['nodeIds']
    const iso = (time: number | undefined, fallback: string) => (time === undefined ? fallback : new Date(time).toISOString())

    const stamp = now()
    const firstLearner = turns.find(turn => turn.who === 'learner')
    const firstAssistant = turns.find(turn => turn.who === 'assistant')
    // Help is dated when the assistant gave it (its message), so an answer written after the explanation does not look
    // as if the explanation came later.
    const help = reply.help.map(item => {
      const message = turns.find(turn => turn.who === 'assistant' && turn.seq === item.message) ?? firstAssistant
      return { nodeIds: only(item.nodeIds), level: item.level, at: iso(message?.at, stamp) }
    }).filter(item => item.nodeIds.length)
    // A misconception counts only as the learner's own words: the quote must be found in a learner message, and the nodes
    // are the ones the misconception itself is about.
    const misconceptions = reply.misconceptions.map(item => {
      const source = item.quote.trim() ? turns.find(turn => turn.who === 'learner' && squash(turn.text).includes(squash(item.quote))) : undefined
      return { text: item.text, nodeIds: only(item.nodeIds), at: source ? iso(source.at, stamp) : undefined }
    })
    const summary = SideChatSummary.parse({
      id: newId('summary'),
      sessionId,
      courseId,
      at: stamp,
      ...(link.openedFrom ? { openedFrom: link.openedFrom } : {}),
      questions: reply.questions,
      conclusions: reply.conclusions,
      nodeIds: only(reply.nodeIds),
      misconceptions: misconceptions.map(item => item.text),
      helpGiven: help.map(({ nodeIds, level }) => ({ nodeIds, level })),
      proposalIds: [],
    })

    if (asked) {
      const title = (id: string) => nodes.find(node => node.id === id)?.title ?? id
      const levels = { hint: '提示', explanation: '讲解', 'worked-solution': '完整解答', 'answer-revealed': '看答案' }
      const at = new Date(summary.at)
      const pad = (n: number) => String(n).padStart(2, '0')
      const marker = `- 会话：${sessionId}`
      const block = [
        `## ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())} · ${link.openedFrom?.selected?.label ?? link.openedFrom?.page ?? '课程'}`,
        '',
        `- 问了什么：${summary.questions.join('；') || '—'}`,
        `- 结论：${summary.conclusions.join('；') || '—'}`,
        `- 涉及节点：${summary.nodeIds.map(title).join('、') || '—'}`,
        `- 可能的误解：${summary.misconceptions.join('；') || '无'}`,
        `- 给了什么帮助：${summary.helpGiven.map(item => `${levels[item.level]}（${item.nodeIds.map(title).join('、')}）`).join('；') || '无'}`,
        marker,
        '',
      ].join('\n')
      const current = await core.files.read(courseId, COURSE_LAYOUT.sideChats)
      // The note of this session may already be in the file (an earlier call wrote it and then failed): once only.
      if (!current?.text.includes(marker)) {
        await core.files.append(courseId, COURSE_LAYOUT.sideChats, `${current ? '\n' : '# 侧边会话总结\n\n'}${block}`, { actor: 'system', reason: '侧边会话总结' })
      }
    }

    core.db.transaction(() => {
      const context = { sessionId: sessionId as SideChatSummary['sessionId'] }
      if (summary.nodeIds.length && summary.questions.length) {
        core.log.append({ type: 'signal.question', courseId, nodeIds: summary.nodeIds, context, text: summary.questions.join('；'), at: iso(firstLearner?.at, stamp) })
      }
      for (const item of misconceptions) {
        const nodeIds = item.nodeIds
        if (!item.at || nodeIds.length === 0) continue
        core.log.append({ type: 'signal.misconception', courseId, nodeIds, context, text: item.text, at: item.at })
      }
      for (const item of help) {
        core.log.append({ type: 'help.given', courseId, nodeIds: item.nodeIds, context, level: item.level, via: 'side-chat', at: item.at })
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
  /** Sessions whose first-turn context is already in their history (a cache: the history is the truth). */
  const contexted = new Set<string>()

  /** The persisted record shows whether the context went in before a restart. */
  const hasContext = async (sessionId: string): Promise<boolean> => {
    try {
      return (await sessionLines(ctx, sessionId)).some(line => line.source === CONTEXT_SOURCE)
    } catch {
      return false
    }
  }

  // The selection's context goes in before the first step of the side chat's first turn; while a test is open every
  // turn starts with the reminder that the chat is limited to how the test works.
  ctx.on('agent/pre-step', async ({ agent, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || step !== 1) return decision
    const sessionId = agent.session.id
    const link = ctx.learnCore.sessions.get(sessionId)
    if (link?.role !== 'side-chat') return decision
    const messages = [...decision.messages]
    const message = (text: string, kind: typeof CONTEXT_SOURCE | typeof POLICY_SOURCE) => createUserMessage({ content: [{ type: 'text', text }], source: { kind, form: 'snapshot', sections: [{ name: kind, text }] } })
    if (sidechat.testOpen(link.courseId)) {
      messages.push(message('【测试进行中】学习者的这场测试还没结束：只回答怎么操作（交卷、计时、拍照作答、题目怎么显示），不讨论题目，不讲解知识，不查资料。想讨论题目的话，告诉学习者要先离开测试，这次作答会记为有帮助。', POLICY_SOURCE))
    }
    if (link.openedFrom && !contexted.has(sessionId) && !(await hasContext(sessionId))) {
      // Marked as given only after the text exists: a failure here leaves the next turn to try again, and the
      // learner's question goes on without the context rather than failing with it.
      try {
        const text = await sidechat.contextFor(link.openedFrom)
        messages.push(message(text, CONTEXT_SOURCE))
        contexted.add(sessionId)
      } catch (error) {
        ctx.logger('learning-sidechat').warn('side chat context failed, retrying next turn: %s', (error as Error).stack ?? error)
      }
    } else {
      contexted.add(sessionId)
    }
    return { ...decision, messages }
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
      return open ? { sessionId: open.sessionId, label: open.openedFrom?.selected?.label ?? '' } : null
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
