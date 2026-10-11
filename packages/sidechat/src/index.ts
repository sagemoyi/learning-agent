// sidechat unit, host half. Provides `ctx.learnSidechat` (contracts §5.1, docs/sidechat/design.md): a side chat
// bound to the page and selection, isolated from the teacher's session.
// A: the tools are held to read-only at the moment they run, an open test limits the chat to how the test works, and
// creating and closing a chat can be repeated after any failure.
// B: after each reply the record (ledger.ts) logs the help, questions and possible misconceptions at once, dated by
// their messages; closing builds the summary in `notes/side-chats.md` from the record, cut at the last message.
import { Service, type Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-settings'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import {
  COURSE_LAYOUT,
  LearningApiError,
  Selection,
  SideChatDraft,
  SideChatSummary,
  newId,
  type ChangeTarget,
  type LearnSidechat,
  type Migration,
  type Proposal,
  type SessionLink,
} from '@learning-agent/contracts'
import { must, now, routeOf, selectSessionModel, sessionLines } from '@learning-agent/kit'
import { roleModel, Schema } from '@learning-agent/kit/settings'
import { z } from 'zod'
import { CONTEXT_SOURCE, installLedger, ledgerMigration, type Ledger, type Stretch } from './ledger.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'learning-side-chat-context': { kind: 'learning-side-chat-context' } & ContextFormed
    'learning-side-chat-policy': { kind: 'learning-side-chat-policy' } & ContextFormed
  }
}

export const name = 'learning-sidechat'
export const inject = ['learnCore', 'learnKnowledge', 'sessionController', 'llm']

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

/** Drafts of changes (C); after the record's table (ledger.ts, version 2). */
const draftsMigration: Migration = {
  version: 3,
  sql: `
    CREATE TABLE sidechat_drafts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      course_id TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX sidechat_drafts_by_session ON sidechat_drafts (session_id);
  `,
}
const MAX_DRAFT = 1000

/** What the learner may ask while a test is open (see `checkTool`). */
const READ_TOOLS = new Set(['search_library', 'read_section'])
/** A side chat may also draft a change for the learner to submit; it changes nothing itself. */
const DRAFT_TOOL = 'draft_proposal'
const LEVEL_WORDS = { hint: '提示', explanation: '讲解', 'worked-solution': '完整解答', 'answer-revealed': '看答案' } as const
/** Marks a chat's note in `notes/side-chats.md`, so it is written once; hidden in Obsidian's reading view. */
const noteMarker = (sessionId: string) => `<!-- side-chat:${sessionId} -->`
/** The marker notes had before (an internal id in the learner's file); still recognized so they are not written again. */
const oldMarker = (sessionId: string) => `- 会话：${sessionId}`

class LearnSidechatService extends Service implements LearnSidechat {
  /** Closings in progress, by session: a second call joins the first. */
  private readonly closing = new Map<string, Promise<SideChatSummary>>()
  /** Side chats whose agent is writing a reply now (DSH's `agent/status`); none after a restart. */
  readonly answering = new Set<string>()
  readonly ledger: Ledger

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'learnSidechat')
    ctx.learnCore.db.migrate('sidechat', [...migrations, ledgerMigration, draftsMigration])
    this.ledger = installLedger(ctx, { model: () => config.summaryModel.get() })
  }

  /** A test of the course is open (assess owns what that means; we only ask). */
  testOpen(courseId: string | undefined): boolean {
    if (!courseId || !this.config.restrictDuringTests.get()) return false
    return this.ctx.get('learnAssess')?.tests(courseId).some(test => test.status === 'open') ?? false
  }

  checkTool(sessionId: string, tool: string): { readonly allowed: boolean; readonly reason?: string } {
    const link = this.ctx.learnCore.sessions.get(sessionId)
    if (link?.role !== 'side-chat') return { allowed: true }
    if (!READ_TOOLS.has(tool) && tool !== DRAFT_TOOL) {
      return { allowed: false, reason: '侧边会话只能查本课资料库（search_library、read_section），不能联网找资料，也不能加入资料。需要补资料，请学习者回到主老师那里提。' }
    }
    if (this.testOpen(link.courseId)) {
      return { allowed: false, reason: '现在有一场测试正在进行：侧边会话只能说明怎么操作（怎么交卷、计时、拍照作答），不查资料、不讨论题目。想讨论题目，请学习者先交卷（不会的题点「不会」），交卷后再讨论；交卷后讲的不影响这次作答。' }
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
    if (!parsed.courseId) throw new LearningApiError('learning/sidechat/needs-course', '侧边提问要先选一门课：在主界面先选课程，再提问')
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

  /** What a draft would change: a definite target the teacher can check and change, or a refusal saying why not. */
  private async targetOf(link: SessionLink & { readonly courseId: string }, target: 'selection' | 'roadmap' | 'goal'): Promise<{ targets: ChangeTarget[]; label: string }> {
    const { courseId } = link
    if (target === 'roadmap') return { targets: [{ kind: 'file', courseId, path: COURSE_LAYOUT.roadmap }], label: '课程路线' }
    if (target === 'goal') return { targets: [{ kind: 'file', courseId, path: COURSE_LAYOUT.goal }], label: '目标说明' }
    const selected = link.openedFrom?.selected
    const curriculum = this.ctx.get('learnCurriculum')
    const lessonFile = (file: string) => {
      for (const stage of curriculum?.stages(courseId) ?? []) {
        const lesson = curriculum!.lessons(stage.id).find(item => item.textbookFile === file)
        if (lesson) return { targets: [{ kind: 'file' as const, courseId, path: file }], label: `教材 ${lesson.number} ${lesson.title}` }
      }
      return { targets: [{ kind: 'file' as const, courseId, path: file }], label: selected?.label || '教材' }
    }
    const block = async (blockId: string) => {
      const found = await this.ctx.get('learnTextbook')?.block(courseId, blockId)
      return found ? lessonFile(found.file) : undefined
    }
    let resolved: { targets: ChangeTarget[]; label: string } | undefined
    if (selected?.id) {
      if (selected.kind === 'problem' || selected.kind === 'attempt') {
        throw new LearningApiError('learning/sidechat/problem-target', '题目本身有问题时，请学习者在测试页点「这题有问题」报告，老师会核对这道题；不要起草修改建议。')
      }
      if (selected.kind === 'chunk' || selected.kind === 'source') {
        throw new LearningApiError('learning/sidechat/source-target', '资料原文不能改：资料里的错误请学习者在资料库页处理；想改的是教材的讲法，请学习者在教材里选中那一段再来提问。')
      }
      if (selected.kind === 'block') resolved = await block(selected.id)
      else if (selected.kind === 'lesson') {
        const file = curriculum?.lesson(selected.id)?.textbookFile
        if (file) resolved = lessonFile(file)
      } else if (selected.kind === 'stage') {
        const stage = curriculum?.stage(selected.id)
        if (stage) resolved = { targets: [{ kind: 'file', courseId, path: `${stage.folder}/design.md` }], label: `阶段 ${stage.index} ${stage.title} 的设计书` }
      } else if (selected.kind === 'node') {
        const node = this.ctx.learnKnowledge.graph(courseId).nodes.find(item => item.id === selected.id)
        if (node) resolved = { targets: [{ kind: 'node', id: node.id }], label: `知识点「${node.title}」` }
      } else if (selected.kind === 'text' && link.openedFrom?.page === 'annotation') {
        const anchor = this.ctx.get('learnAnnotation')?.get(selected.id)?.anchor
        if (anchor?.kind === 'block') resolved = await block(anchor.blockId)
      }
    }
    if (!resolved) {
      throw new LearningApiError('learning/sidechat/no-target', '这次提问没有选中可以修改的内容：问清学习者要改哪里。教材的某一段请学习者在教材里选中它再来提问；课程路线（阶段的顺序、增删）用 target="roadmap"；目标说明用 target="goal"。')
    }
    return resolved
  }

  private readDraft(draftId: string): SideChatDraft | undefined {
    const row = this.ctx.learnCore.db.sqlite.prepare('SELECT data FROM sidechat_drafts WHERE id = ?').get(draftId) as { data: string } | undefined
    return row ? SideChatDraft.parse(JSON.parse(row.data)) : undefined
  }

  private saveDraft(draft: SideChatDraft): void {
    this.ctx.learnCore.db.sqlite.prepare('INSERT INTO sidechat_drafts (id, session_id, course_id, data) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data')
      .run(draft.id, draft.sessionId, draft.courseId, JSON.stringify(draft))
  }

  async draft(sessionId: string, input: { readonly target: 'selection' | 'roadmap' | 'goal'; readonly change: string; readonly reason: string }): Promise<SideChatDraft> {
    const link = must(this.ctx.learnCore.sessions.get(sessionId), 'sidechat', '会话', sessionId)
    if (link.role !== 'side-chat' || !link.courseId) throw new LearningApiError('learning/sidechat/not-side-chat', '只有侧边会话能起草修改建议', { sessionId })
    const change = input.change.trim(), reason = input.reason.trim()
    if (!change || !reason) throw new LearningApiError('learning/sidechat/draft-empty', '要写清改什么（change）和为什么（reason）')
    if (change.length > MAX_DRAFT || reason.length > MAX_DRAFT) throw new LearningApiError('learning/sidechat/draft-too-long', `修改建议太长了，改什么和为什么各写在 ${MAX_DRAFT} 字以内`)
    const { targets, label } = await this.targetOf(link as SessionLink & { courseId: string }, input.target)
    // The same draft again (a retried tool call) is the one already there.
    const same = this.drafts(sessionId).find(item => item.status === 'draft' && item.change === change && item.label === label)
    if (same) return same
    const draft = SideChatDraft.parse({ id: newId('draft'), sessionId, courseId: link.courseId, targets, label, change, reason, createdAt: now(), status: 'draft' })
    this.saveDraft(draft)
    this.ctx.emit('learning/sidechat-changed', { courseId: draft.courseId, sessionId })
    return draft
  }

  drafts(sessionId: string): SideChatDraft[] {
    const rows = this.ctx.learnCore.db.sqlite.prepare('SELECT data FROM sidechat_drafts WHERE session_id = ? ORDER BY id').all(sessionId) as { data: string }[]
    return rows.map(row => SideChatDraft.parse(JSON.parse(row.data)))
  }

  submitDraft(draftId: string): Proposal {
    const core = this.ctx.learnCore
    const draft = must(this.readDraft(draftId), 'sidechat', '修改建议', draftId)
    if (draft.proposalId) return must(core.proposals.get(draft.proposalId), 'sidechat', '提案', draft.proposalId)
    if (draft.status !== 'draft') throw new LearningApiError('learning/sidechat/draft-dropped', '这条修改建议已经不要了')
    const proposal = core.db.transaction(() => {
      const created = core.proposals.create({
        courseId: draft.courseId,
        source: 'side-chat',
        targets: draft.targets,
        summary: `${draft.label}：${draft.change}`,
        rationale: `学习者在侧边提问里提出，确认后交给你。\n为什么：${draft.reason}`,
      })
      this.saveDraft({ ...draft, status: 'submitted', proposalId: created.id })
      return created
    })
    this.ctx.emit('learning/sidechat-changed', { courseId: draft.courseId, sessionId: draft.sessionId })
    this.ctx.emit('learning/handoff', { courseId: draft.courseId, unit: 'sidechat', text: `学习者从侧边提问交来一条修改建议（${draft.label}）：${draft.change}` })
    return proposal
  }

  dropDraft(draftId: string): SideChatDraft {
    const draft = must(this.readDraft(draftId), 'sidechat', '修改建议', draftId)
    if (draft.status === 'submitted') throw new LearningApiError('learning/sidechat/draft-submitted', '这条修改建议已经交给主老师了')
    const dropped = { ...draft, status: 'dropped' as const }
    this.saveDraft(dropped)
    this.ctx.emit('learning/sidechat-changed', { courseId: draft.courseId, sessionId: draft.sessionId })
    return dropped
  }

  summary(sessionId: string): SideChatSummary | undefined {
    return this.stored(sessionId)
  }

  private stored(sessionId: string): SideChatSummary | undefined {
    const row = this.ctx.learnCore.db.sqlite.prepare('SELECT data FROM sidechat_summaries WHERE session_id = ?').get(sessionId) as { data: string } | undefined
    return row ? SideChatSummary.parse(JSON.parse(row.data)) : undefined
  }

  /**
   * Close in steps that each tolerate being done already, so a call after any failure picks up where the last stopped:
   * the record caught up to the last message (help and signals are logged as each stretch is sorted) → summary built
   * from the stretches → note in the course folder (once per session) → summary row → session closed and announced.
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
    // The cut is the last message the chat has: a reply still being written is not cut in half.
    if (this.answering.has(sessionId)) {
      throw new LearningApiError('learning/sidechat/still-answering', '回答还没写完：等它写完，或者先停下这次回答，再结束并总结', { sessionId })
    }
    const courseId = link.courseId!
    await this.ledger.record(sessionId, { final: true, ...(signal ? { signal } : {}) })
    const stretches = this.ledger.stretches(sessionId)
    const nodes = this.ctx.learnKnowledge.graph(courseId).nodes
    const known = new Set<string>(nodes.map(node => node.id))
    const only = (ids: readonly string[]) => [...new Set(ids)].filter(id => known.has(id)) as SideChatSummary['nodeIds']
    const unique = (texts: readonly string[]) => [...new Set(texts)]
    const questions = stretches.flatMap(item => item.questions)
    const misconceptions = stretches.flatMap(item => item.misconceptions)
    const help = stretches.flatMap(item => item.help).map(item => ({ nodeIds: only(item.nodeIds), level: item.level })).filter(item => item.nodeIds.length)
    const drafts = this.drafts(sessionId).filter(item => item.status !== 'dropped')
    const summary = SideChatSummary.parse({
      id: newId('summary'),
      sessionId,
      courseId,
      at: now(),
      ...(link.openedFrom ? { openedFrom: link.openedFrom } : {}),
      questions: unique(questions.map(item => item.text)),
      conclusions: unique(stretches.flatMap(item => item.conclusions.map(conclusion => conclusion.text))),
      nodeIds: only([...questions, ...misconceptions, ...help].flatMap(item => item.nodeIds)),
      misconceptions: unique(misconceptions.map(item => item.text)),
      helpGiven: help,
      proposalIds: drafts.flatMap(item => (item.proposalId ? [item.proposalId] : [])),
      ...(stretches.length ? { upTo: Math.max(...stretches.map(item => item.upTo)) } : {}),
    })

    const asked = (await sessionLines(this.ctx, sessionId, signal)).some(line => line.who === 'learner' && (summary.upTo === undefined || line.seq <= summary.upTo))
    if (asked) {
      const current = await core.files.read(courseId, COURSE_LAYOUT.sideChats)
      // The note of this session may already be in the file (an earlier call wrote it and then failed): once only.
      if (!current?.text.includes(noteMarker(sessionId)) && !current?.text.includes(oldMarker(sessionId))) {
        const title = (id: string) => nodes.find(node => node.id === id)?.title ?? ''
        const once = misconceptions.filter((item, index) => misconceptions.findIndex(other => other.text === item.text) === index)
        const block = noteText(summary, link.openedFrom, once, drafts, stretches.some(item => item.skipped), title)
        await core.files.append(courseId, COURSE_LAYOUT.sideChats, `${current ? '\n' : '# 侧边会话总结\n\n'}${block}`, { actor: 'system', reason: '侧边会话总结' })
      }
    }
    core.db.sqlite.prepare('INSERT INTO sidechat_summaries (id, session_id, course_id, data) VALUES (?, ?, ?, ?)').run(summary.id, sessionId, courseId, JSON.stringify(summary))
    core.sessions.close(sessionId)
    this.ctx.emit('learning/sidechat-summarized', summary)
    return summary
  }
}

/** One chat's note for `notes/side-chats.md`: what the learner reads in Obsidian, so no internal ids. */
function noteText(summary: SideChatSummary, from: Selection | undefined, misconceptions: readonly Stretch['misconceptions'][number][], drafts: readonly SideChatDraft[], skipped: boolean, title: (id: string) => string): string {
  const at = new Date(summary.at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const list = (items: readonly string[]) => items.map(item => `  - ${item}`)
  const names = (ids: readonly string[]) => ids.map(title).filter(Boolean).join('、')
  const levels = new Map<string, Set<string>>()
  for (const item of summary.helpGiven) for (const id of item.nodeIds) levels.set(LEVEL_WORDS[item.level], (levels.get(LEVEL_WORDS[item.level]) ?? new Set()).add(id))
  const lines = [
    `## ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())} · ${from?.selected?.label || '整门课'}`,
    '',
    ...(summary.questions.length ? ['- 问了什么：', ...list(summary.questions)] : ['- 问了什么：—']),
    ...(summary.conclusions.length ? ['- 结论：', ...list(summary.conclusions)] : ['- 结论：—']),
    ...(misconceptions.length
      ? ['- 可能的误解：', ...list(misconceptions.map(item => (item.seq !== undefined && item.quote ? `${item.text}（原话："${item.quote}"）` : `${item.text}（没有找到原话，只作参考）`)))]
      : ['- 可能的误解：无']),
    `- 得到的帮助：${[...levels].map(([level, ids]) => `${level}（${names([...ids])}）`).join('；') || '无'}`,
    `- 涉及的知识点：${names(summary.nodeIds) || '—'}`,
    ...(drafts.length ? ['- 修改建议：', ...list(drafts.map(item => `${item.label}：${item.change}（${item.proposalId ? '已交给主老师' : '结束时还没有交给主老师'}）`))] : []),
    ...(skipped ? ['- 有一段对话多次整理失败，没有写进这份总结。'] : []),
    '',
    noteMarker(summary.sessionId),
    '',
  ]
  return lines.join('\n')
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
      messages.push(message('【测试进行中】学习者的这场测试还没结束：只回答怎么操作（交卷、计时、拍照作答、题目怎么显示），不讨论题目，不讲解知识，不查资料。想讨论题目的话，告诉学习者先交卷（不会的题点「不会」），交卷后再讨论。', POLICY_SOURCE))
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

  // A reply is being written while the agent runs; once it goes idle the turn is over and its talk is recorded, so
  // the help is in the log before the learner answers anything, whether or not the chat is ever closed.
  // (DSH's `session/event` is scoped and does not reach the units; agent events do.)
  ctx.on('agent/status', ({ agent, status }) => {
    const sessionId = agent.session.id as string
    if (ctx.learnCore.sessions.get(sessionId)?.role !== 'side-chat') return
    if (status === 'running') {
      sidechat.answering.add(sessionId)
      return
    }
    sidechat.answering.delete(sessionId)
    void sidechat.ledger.record(sessionId)
  })

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

  // The drafts of a chat, with what the teacher decided on the submitted ones.
  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'sidechat',
    method: 'drafts',
    input: z.object({ sessionId: z.string() }),
    handle: ({ sessionId }) => sidechat.drafts(sessionId).filter(draft => draft.status !== 'dropped').map(draft => {
      const proposal = draft.proposalId ? ctx.learnCore.proposals.get(draft.proposalId) : undefined
      return { ...draft, ...(proposal ? { proposal: { status: proposal.status, ...(proposal.decisionNote ? { note: proposal.decisionNote } : {}) } } : {}) }
    }),
  }), 'sidechat: drafts')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'sidechat',
    method: 'submitDraft',
    input: z.object({ draftId: z.string() }),
    handle: ({ draftId }) => sidechat.submitDraft(draftId),
  }), 'sidechat: submitDraft')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'sidechat',
    method: 'dropDraft',
    input: z.object({ draftId: z.string() }),
    handle: ({ draftId }) => sidechat.dropDraft(draftId),
  }), 'sidechat: dropDraft')

  // Open side chats keep the model they were created with until the 侧边提问 model, or the default
  // it follows, changes; then they move to it from the next request on.
  ctx.on('settings/document-updated', ns => {
    if (ns !== name && ns !== 'agent-default-model') return
    for (const link of ctx.learnCore.sessions.list({ role: 'side-chat' })) {
      if (!link.closedAt) selectSessionModel(ctx, link.sessionId, config.model.get()).catch(error => ctx.logger('learning-sidechat').warn('model switch failed: %s', (error as Error).stack ?? error))
    }
  })
}
