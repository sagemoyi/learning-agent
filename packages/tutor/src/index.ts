// tutor unit, host half. Provides `ctx.learnTutor` (contracts §5.1): the teacher's sessions (one per
// stage, plus an opening session for goal, diagnostic and roadmap), the per-turn course brief
// (contracts §7.2, brief.ts), the lesson record, and the hand-back (notices.ts): when the learner
// finishes something on a page or a background job ends (`learning/handoff`), the teacher hears about
// it and, when the next step is the teacher's, carries on without waiting to be asked. After each
// teacher turn the classroom record (ledger.ts) logs the help given and what the learner said.
// Open proposals (an error reported on the textbook) are in the brief for the teacher to check and decide (proposals.ts).
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-workspace'
import { LearningApiError, TEST_KIND_LABEL, withFrontmatter, type BriefSection, type ChangeMeta, type HelpLevel, type LearnTutor, type LogEntry, type MasteryState, type Migration, type Proposal, type Stage, type Test } from '@learning-agent/contracts'
import { must, now, routeOf, selectSessionModel, sessionLines } from '@learning-agent/kit'
import { roleModel, Schema } from '@learning-agent/kit/settings'
import { z } from 'zod'
import { installBrief } from './brief.ts'
import { bare, installLedger, ledgerMigration } from './ledger.ts'
import { installNotices, noticeMigration } from './notices.ts'
import { decideProposal, proposalLines } from './proposals.ts'

export const name = 'learning-tutor'
export const inject = ['learnCore', 'learnCurriculum', 'learnAssess', 'learnPlanner', 'learnKnowledge', 'learnTextbook', 'learnLearner', 'llm', 'sessionController', 'agents', 'sessions', 'sessionProjections']

/** Handoffs arriving together (a test finishing completes its task too) become one notice. */
const HANDOFF_DELAY_MS = 1500
const migrations: Migration[] = [noticeMigration, ledgerMigration]
/** Brief sections in reading order: what to do next first, then the classroom rules. */
const UNIT_ORDER = ['planner', 'tutor', 'goal', 'library', 'curriculum', 'textbook', 'assess', 'knowledge', 'learner']
const STAGED: readonly Stage['status'][] = ['ready', 'learning', 'testing', 'reviewing']
const VERDICT = { correct: '对', partial: '部分对', incorrect: '错', 'pending-review': '待复核' } as const
const HELP: Record<HelpLevel, string> = { hint: '提示', explanation: '讲解', 'worked-solution': '完整解答', 'answer-revealed': '看答案' }
const VIA = { teacher: '主老师', 'side-chat': '侧边会话', 'test-page': '测试页' } as const
const STATE: Record<MasteryState, string> = { untested: '还没测过', 'not-yet': '还没答对', assisted: '有帮助完成', independent: '独立完成', retained: '已巩固', conflict: '证据冲突' }

class LearnTutorService extends Service implements LearnTutor {
  private readonly creating = new Map<string, Promise<string>>()

  /** `model` reads the 主老师 model setting; absent follows the default model. */
  constructor(ctx: Context, private readonly model: () => string | undefined) {
    super(ctx, 'learnTutor')
    ctx.learnCore.db.migrate('tutor', migrations)
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
    try {
      await this.ctx.sessionController.create({ workspaceId: course.workspaceId as never, sessionId: sessionId as never, agentPreset: 'teacher' })
    } catch (error) {
      // Without this the course would keep pointing at a session DSH never made.
      this.ctx.learnCore.sessions.close(sessionId)
      throw error
    }
    // A new session starts on the default model; a 主老师 setting moves it before its first request.
    // If that fails the session still works, on the default model, until the setting next changes.
    const role = routeOf(this.model())
    if (role) await selectSessionModel(this.ctx, sessionId, role).catch(error => this.ctx.logger('learning-tutor').warn('model selection failed: %s', (error as Error).stack ?? error))
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
    return this.current(courseId) ?? this.create(courseId, undefined)
  }

  /** The course's teacher session now, without creating one: the current stage's, else the opening session. */
  current(courseId: string): string | undefined {
    const stage = this.ctx.learnCurriculum.currentStage(courseId)
    if (stage && STAGED.includes(stage.status)) return stage.sessionId
    return this.ctx.learnCore.sessions.list({ courseId, role: 'teacher' }).find(link => !link.stageId && !link.closedAt)?.sessionId
  }

  /**
   * Checked where it happens (docs/tutor/design.md, B): the lesson is this course's, its quiz is in and
   * graded, and the learner's report is their own words from the session. The record's facts come from
   * the program: the quiz problem by problem, the help logged in this lesson, the states as they are now.
   */
  async writeLessonSummary(lessonId: string, record: { readonly summary: string; readonly learnerReport: string; readonly sessionId?: string }, meta: ChangeMeta): Promise<void> {
    const curriculum = this.ctx.learnCurriculum
    const lesson = must(curriculum.lesson(lessonId), 'tutor', '课时', lessonId)
    const stage = must(curriculum.stage(lesson.stageId), 'tutor', '阶段', lesson.stageId)
    const courseId = stage.courseId
    if (record.sessionId && this.ctx.learnCore.sessions.get(record.sessionId)?.courseId !== courseId) {
      throw new LearningApiError('learning/tutor/other-course', `课时 ${lesson.number} 不是这门课的课时。`, { lessonId })
    }
    const quiz = this.ctx.learnAssess.tests(courseId, { lessonId, kind: 'quiz' }).filter(test => test.status !== 'abandoned').at(-1)
    if (!quiz) throw new LearningApiError('learning/tutor/no-quiz', `${lesson.number} 还没有小测：先读本节教材，出 2–3 道小测题（start_test，kind="quiz"），学习者交卷后再写小结。`, { lessonId })
    if (quiz.status === 'open') throw new LearningApiError('learning/tutor/quiz-open', `${lesson.number} 的小测还没交卷：等学习者交卷后再写小结。`, { lessonId })
    const view = must(this.ctx.learnAssess.view(quiz.id), 'tutor', '测试', quiz.id)
    const number = (problemId: string | undefined) => quiz.problemIds.indexOf(problemId as never) + 1
    const pending = view.attempts.filter(attempt => (attempt.grading?.verdict ?? 'pending-review') === 'pending-review').map(attempt => number(attempt.problemId))
    const appealed = view.appeals.filter(appeal => !appeal.outcome).map(appeal => number(view.attempts.find(attempt => attempt.id === appeal.attemptId)?.problemId))
    if (pending.length || appealed.length) {
      throw new LearningApiError('learning/tutor/quiz-unsettled', `小测${[...new Set([...pending, ...appealed])].map(n => `第 ${n} 题`).join('、')}的判分还没定（待复核或有申诉）：先用 regrade 处理，再写小结。`, { lessonId })
    }
    const report = record.learnerReport.trim()
    if (!report) throw new LearningApiError('learning/tutor/no-report', '还没有学习者的汇报：请学习者用一两句话说说这节学到了什么、哪里还不清楚，再照录。', { lessonId })
    if (record.sessionId) {
      const said = (await sessionLines(this.ctx, record.sessionId)).filter(line => line.who === 'learner').map(line => bare(line.text))
      const missing = report.split('\n').map(line => line.trim()).filter(line => bare(line) && !said.some(text => text.includes(bare(line))))
      if (missing.length) throw new LearningApiError('learning/tutor/report-not-learner', `汇报要照录学习者在对话里说过的原话（可以分几行录几句），这些不是学习者说的：${missing.join(' / ').slice(0, 120)}`, { lessonId })
    }

    const results = quiz.problemIds.map((problemId, index) => {
      const problem = this.ctx.learnAssess.problem(problemId)
      const attempt = view.attempts.find(item => item.problemId === problemId)
      const verdict = attempt?.gaveUp ? '选了"不会"' : attempt ? VERDICT[attempt.grading?.verdict ?? 'pending-review'] : '没作答'
      return `- 第 ${index + 1} 题${problem?.ref ? `（习题 ${problem.ref}）` : ''}：${verdict}`
    })
    const title = (id: string) => this.ctx.learnKnowledge.node(id)?.title ?? '已删除的知识点'
    const helps = this.ctx.learnCore.log.query({ courseId, types: ['help.given'] })
      .filter((entry): entry is LogEntry & { type: 'help.given' } => entry.type === 'help.given' && entry.context.lessonId === lesson.id)
      .map(entry => `- ${VIA[entry.via]}：${HELP[entry.level]}（${entry.nodeIds.map(title).join('、')}）`)
    const nodeIds = [...new Set(view.problems.flatMap(problem => problem.nodeIds as readonly string[]))]
    const states = this.ctx.learnLearner.states(nodeIds)
    const stateLines = nodeIds.map(id => {
      const state = states.find(item => item.nodeId === id)
      const own = state?.courses.find(item => item.courseId === courseId) ?? state
      return `- ${title(id)}：${STATE[own?.state ?? 'untested']}`
    })
    const body = [
      `# ${lesson.number} ${lesson.title} · 课时记录`,
      `## 小测\n\n对 ${view.attempts.filter(attempt => attempt.grading?.verdict === 'correct').length}/${quiz.problemIds.length}\n\n${results.join('\n')}`,
      `## 本课时记下的帮助\n\n${helps.join('\n') || '没有。'}`,
      `## 写小结时的掌握状态\n\n${stateLines.join('\n') || '—'}`,
      `## 学习者的汇报\n\n${report}`,
      `## 老师小结\n\n${record.summary.trim()}`,
    ].join('\n\n')
    await this.ctx.learnCore.files.write(courseId, lesson.recordFile!, withFrontmatter({ lesson: lesson.id, tests: [quiz.id], writtenAt: now() }, `${body}\n`), meta)
    curriculum.setLessonStatus(lesson.id, 'done')
    for (const task of curriculum.tasks(courseId, { status: 'open', lessonId })) {
      if (task.kind === 'report' || task.kind === 'read') curriculum.completeTask(task.id)
    }
  }

  /** The classroom section of the brief: rules while a test is open, claims of "I know this" not yet checked. */
  classroom(courseId: string): string[] {
    const lines: string[] = []
    const open = this.ctx.learnAssess.tests(courseId).filter(test => test.status === 'open' && test.kind !== 'practice')
    if (open.length) {
      lines.push(`没交卷的测试：${open.map(test => this.testName(test)).join('、')}。学习者问到这些测试里的题，只说明怎么作答、怎么交卷，题目有问题可以在测试页点"这题有问题"；不讲思路、公式或答案。学习者想先学会再做，请学习者先交卷，交卷后再讲。讲了的话，这道题会记为有帮助。`)
    }
    const latest = new Map<string, LogEntry & { type: 'signal.self-report' }>()
    for (const entry of this.ctx.learnCore.log.query({ courseId, types: ['signal.self-report'] })) {
      if (entry.type === 'signal.self-report') for (const nodeId of entry.nodeIds) latest.set(nodeId, entry)
    }
    const unchecked = [...latest].filter(([nodeId, entry]) => entry.claim === 'known' && this.ctx.learnCore.log.query({ nodeId, types: ['attempt.graded'], since: entry.at, limit: 1 }).length === 0)
      .slice(-5)
      .map(([nodeId, entry]) => `${this.ctx.learnKnowledge.node(nodeId)?.title ?? '已删除的知识点'}${entry.text ? `（"${entry.text.slice(0, 40)}"）` : ''}`)
    if (unchecked.length) {
      lines.push(`学习者说已经会了、还没用题验证：${unchecked.join('；')}。合适的时候（不打断阅读和测试）用 start_test(kind="practice", nodes=…) 出一两道练习题验证；验证之前不要当作已会。`)
    }
    return lines
  }

  decideProposal(courseId: string, proposalId: string, decision: 'applied' | 'rejected', note?: string): Proposal {
    return decideProposal(this.ctx, courseId, proposalId, decision, note)
  }

  private testName(test: Test): string {
    const lesson = test.lessonId ? this.ctx.learnCurriculum.lesson(test.lessonId) : undefined
    return `${TEST_KIND_LABEL[test.kind]}${lesson ? ` · ${lesson.number}` : ''}（${test.problemIds.length} 题）`
  }

  /** Assemble the course brief from every unit's section. */
  async brief(courseId: string, sessionId: string): Promise<string> {
    const course = this.ctx.learnCore.courses.get(courseId)
    const sections = await this.ctx.waterfall('learning/course-brief', { courseId, sessionId }, async () => [] as BriefSection[])
    const ordered = [...sections].sort((a, b) => UNIT_ORDER.indexOf(a.unit) - UNIT_ORDER.indexOf(b.unit))
    return [
      `【课程现状简报】课程：${course?.title ?? courseId}。这份简报由系统在对话前更新（没有变化时不重发），进度以它为准。`,
      ...ordered.map(section => `## ${section.title}\n${section.text}`),
    ].join('\n\n')
  }
}

export const Config = Schema.object({
  /** How long to wait for related handoffs before telling the teacher. */
  handoffDelayMs: Schema.number().min(0).default(HANDOFF_DELAY_MS),
  model: roleModel('主老师'),
  /** Sorts each teacher turn into help given and what the learner said (docs/tutor/design.md, B). */
  ledgerModel: roleModel('课堂记录'),
})
export type Config = ReturnType<typeof Config>

export function apply(ctx: Context, config: Config): void {
  const tutor = new LearnTutorService(ctx, () => config.model.get())

  installBrief(ctx, {
    courseOf: sessionId => {
      const link = ctx.learnCore.sessions.get(sessionId)
      return link?.role === 'teacher' ? link.courseId : undefined
    },
    brief: (courseId, sessionId) => tutor.brief(courseId, sessionId),
    next: courseId => ctx.learnPlanner.next(courseId),
  })
  installNotices(ctx, { delayMs: config.handoffDelayMs, session: courseId => tutor.session(courseId) })
  installLedger(ctx, { model: () => config.ledgerModel.get() })

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const lines = tutor.classroom(request.courseId)
    const proposals = proposalLines(ctx, request.courseId)
    return [
      ...sections,
      ...(lines.length ? [{ unit: 'tutor', title: '课堂', text: lines.join('\n') }] : []),
      ...(proposals.length ? [{ unit: 'tutor', title: '待处理的修改提案', text: proposals.join('\n') }] : []),
    ]
  })

  // Sessions keep the model they were created with: a changed 主老师 model, or a changed default the
  // role follows, moves each course's current teacher session to it from the next request on.
  ctx.on('settings/document-updated', ns => {
    if (ns !== name && ns !== 'agent-default-model') return
    for (const course of ctx.learnCore.courses.list()) {
      const sessionId = tutor.current(course.id)
      if (sessionId) selectSessionModel(ctx, sessionId, config.model.get()).catch(error => ctx.logger('learning-tutor').warn('model switch failed: %s', (error as Error).stack ?? error))
    }
  })

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
