// tutor unit, host half. Provides `ctx.learnTutor` (contracts §5.1): the teacher's sessions (one per
// stage, plus an opening session for goal, diagnostic and roadmap), the per-turn course brief
// (contracts §7.2), the lesson record, and the hand-back: when the learner finishes something on a
// page or a background job ends (`learning/handoff`), the teacher hears about it and, when the next
// step is the teacher's, carries on without waiting to be asked. Skeleton: proposals are not processed yet (PLAN §7).
import { Service, type Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-workspace'
import { withFrontmatter, type BriefSection, type ChangeMeta, type Handoff, type LearnTutor, type Stage } from '@learning-agent/contracts'
import { must, now } from '@learning-agent/kit'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'learning-course-brief': { kind: 'learning-course-brief' } & ContextFormed
    /** Progress notices from `learning/handoff`; the chat shows them as notices, not as the learner's words. */
    'learning-handoff': { kind: 'learning-handoff' }
  }
}

export const name = 'learning-tutor'
export const inject = ['learnCore', 'learnCurriculum', 'learnAssess', 'learnPlanner', 'sessionController', 'agents', 'sessions']

const BRIEF_SOURCE = 'learning-course-brief'
const HANDOFF_SOURCE = 'learning-handoff'
/** Handoffs arriving together (a test finishing completes its task too) become one notice. */
const HANDOFF_DELAY_MS = 1500
/** Brief sections in reading order: what to do next first. */
const UNIT_ORDER = ['planner', 'goal', 'library', 'curriculum', 'textbook', 'assess', 'knowledge', 'learner']
const STAGED: readonly Stage['status'][] = ['ready', 'learning', 'testing', 'reviewing']
const TEST_KIND = { diagnostic: '摸底', quiz: '小测', practice: '练习', stage: '阶段测试', review: '复查', mock: '模拟考' } as const

class LearnTutorService extends Service implements LearnTutor {
  private readonly creating = new Map<string, Promise<string>>()
  /** Stage sessions created since their first notice: that notice opens the stage. */
  readonly fresh = new Set<string>()

  constructor(ctx: Context) {
    super(ctx, 'learnTutor')
  }

  /** Register the session with core first, then create it in the course's workspace (contracts §4.2). */
  private async create(courseId: string, stageId: string | undefined): Promise<string> {
    const course = must(this.ctx.learnCore.courses.get(courseId), 'tutor', '课程', courseId)
    const sessionId = globalThis.crypto.randomUUID()
    this.ctx.learnCore.sessions.link({
      sessionId,
      courseId: course.id,
      role: 'teacher',
      ...(stageId ? { stageId: stageId as Stage['id'] } : {}),
      createdAt: now(),
    })
    await this.ctx.sessionController.create({ workspaceId: course.workspaceId as never, sessionId: sessionId as never, agentPreset: 'teacher' })
    if (stageId) this.fresh.add(sessionId)
    return sessionId
  }

  session(courseId: string): Promise<string> {
    const pending = this.creating.get(courseId)
    if (pending) return pending
    const run = this.resolveSession(courseId).finally(() => this.creating.delete(courseId))
    this.creating.set(courseId, run)
    return run
  }

  private async resolveSession(courseId: string): Promise<string> {
    const stage = this.ctx.learnCurriculum.currentStage(courseId)
    if (stage && STAGED.includes(stage.status)) {
      if (stage.sessionId) return stage.sessionId
      const sessionId = await this.create(courseId, stage.id)
      this.ctx.learnCurriculum.setStageSession(stage.id, sessionId)
      return sessionId
    }
    const opening = this.ctx.learnCore.sessions.list({ courseId, role: 'teacher' }).find(link => !link.stageId && !link.closedAt)
    return opening?.sessionId ?? this.create(courseId, undefined)
  }

  async writeLessonSummary(lessonId: string, record: { readonly summary: string; readonly learnerReport?: string }, meta: ChangeMeta): Promise<void> {
    const curriculum = this.ctx.learnCurriculum
    const lesson = must(curriculum.lesson(lessonId), 'tutor', '课时', lessonId)
    const stage = must(curriculum.stage(lesson.stageId), 'tutor', '阶段', lesson.stageId)
    const tests = this.ctx.learnAssess.tests(stage.courseId, { lessonId })
    const testLines = tests.map(test => {
      const view = this.ctx.learnAssess.view(test.id)
      const correct = view?.attempts.filter(attempt => attempt.grading?.verdict === 'correct').length ?? 0
      return `- ${TEST_KIND[test.kind]}（${test.id}）：${test.status === 'graded' ? `对 ${correct}/${test.problemIds.length}` : '未交卷'}`
    })
    const body = [
      `# ${lesson.number} ${lesson.title} · 课时记录`,
      `## 小测\n\n${testLines.join('\n') || '（没有小测）'}`,
      `## 学习者的汇报\n\n${record.learnerReport?.trim() || '（没有汇报）'}`,
      `## 老师小结\n\n${record.summary.trim()}`,
    ].join('\n\n')
    await this.ctx.learnCore.files.write(stage.courseId, lesson.recordFile!, withFrontmatter({ lesson: lesson.id, tests: tests.map(test => test.id), writtenAt: now() }, `${body}\n`), meta)
    curriculum.setLessonStatus(lesson.id, 'done')
    for (const task of curriculum.tasks(stage.courseId, { status: 'open', lessonId })) {
      if (task.kind === 'report' || task.kind === 'read') curriculum.completeTask(task.id)
    }
  }

  /** Assemble the course brief from every unit's section. */
  async brief(courseId: string, sessionId: string): Promise<string> {
    const course = this.ctx.learnCore.courses.get(courseId)
    const sections = await this.ctx.waterfall('learning/course-brief', { courseId, sessionId }, async () => [] as BriefSection[])
    const ordered = [...sections].sort((a, b) => UNIT_ORDER.indexOf(a.unit) - UNIT_ORDER.indexOf(b.unit))
    return [
      `【课程现状简报】课程：${course?.title ?? courseId}。这份简报由系统在每轮对话前更新，进度以它为准。`,
      ...ordered.map(section => `## ${section.title}\n${section.text}`),
    ].join('\n\n')
  }
}

export interface Config {
  /** How long to wait for related handoffs before telling the teacher (default 1500 ms). */
  readonly handoffDelayMs?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  const tutor = new LearnTutorService(ctx)
  const lastBrief = new Map<string, string>()

  // Course brief before the first step of a teacher turn, only when it changed since the last one
  // this session saw (it stays in the session log after the user's prompt; compatibility S4).
  ctx.on('agent/pre-step', async ({ agent, step }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || step !== 1) return decision
    const link = ctx.learnCore.sessions.get(agent.session.id)
    if (link?.role !== 'teacher' || !link.courseId) return decision
    const text = await tutor.brief(link.courseId, link.sessionId)
    if (lastBrief.get(link.sessionId) === text) return decision
    lastBrief.set(link.sessionId, text)
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: BRIEF_SOURCE, form: 'snapshot', sections: [{ name: BRIEF_SOURCE, text }] },
        }),
      ],
    }
  }, { prepend: true })

  // Hand-back (PLAN §10 trial, 10-04): finished learner actions and background jobs reach the
  // teacher's current session as one notice. When the next step is the teacher's, the notice starts
  // a turn; otherwise it waits as context for the teacher's next turn.
  const pending = new Map<string, { texts: string[]; timer?: ReturnType<typeof setTimeout> }>()
  async function deliver(courseId: string, texts: readonly string[]): Promise<void> {
    const step = await ctx.learnPlanner.next(courseId)
    const wake = step.actor === 'teacher'
    const sessionId = await tutor.session(courseId)
    const opening = wake && tutor.fresh.delete(sessionId)
    const text = [
      '【进度通知】',
      ...texts.map(line => `- ${line}`),
      '',
      wake
        ? (opening ? '这是这个阶段的第一次课：先向学习者简单介绍这个阶段要做成什么，再按课程现状简报的"下一步"继续。' : '先用一句话回应学习者，再按课程现状简报的"下一步"继续。')
        : '现在轮到学习者，不需要回复。',
    ].join('\n')
    await ctx.agents.withoutInitiator(async () => {
      const resolved = await ctx.sessionController.resolveAgent(sessionId as never)
      if ('error' in resolved) throw resolved.error
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: HANDOFF_SOURCE } })
      if (wake) resolved.agent.followup(message)
      else resolved.agent.inject(message)
      await ctx.sessions.flush(resolved.agent.session)
    })
  }
  ctx.on('learning/handoff', ({ courseId, text }: Handoff) => {
    const entry = pending.get(courseId) ?? { texts: [] }
    entry.texts.push(text)
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      pending.delete(courseId)
      deliver(courseId, entry.texts).catch(error => ctx.logger('learning-tutor').warn('handoff failed: %s', (error as Error).stack ?? error))
    }, config.handoffDelayMs ?? HANDOFF_DELAY_MS)
    pending.set(courseId, entry)
  })
  ctx.effect(() => () => {
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
  }, 'tutor: pending handoffs')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'tutor',
    method: 'session',
    input: z.object({ courseId: z.string() }),
    handle: async ({ courseId }) => {
      const sessionId = await tutor.session(courseId)
      return { sessionId, stageId: ctx.learnCore.sessions.get(sessionId)?.stageId ?? null }
    },
  }), 'tutor: session')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'tutor',
    method: 'brief',
    input: z.object({ courseId: z.string() }),
    handle: async ({ courseId }) => ({ text: await tutor.brief(courseId, '') }),
  }), 'tutor: brief')
}
