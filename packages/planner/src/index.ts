// planner unit, host half. Provides `ctx.learnPlanner` (contracts §5.1): what happens next in a course.
// The main line walks the learning journey from the other units' state (flow.ts); beside it come the tests left
// open, a short check worth doing now (reviews.ts) and the time left to the exam (docs/planner/design.md). The
// teacher gets it at the top of every brief; the home page and progress page show it to the learner. Reading a
// step changes nothing; only the learner's "今天先不做" is stored here.
import { Service, type Context } from '@deepseek-ai/cordis'
import { LearningApiError, TEST_KIND_LABEL, type Countdown, type GoalDoc, type LearnPlanner, type Migration, type NextStep, type Test, type UnfinishedTest } from '@learning-agent/contracts'
import { Schema } from '@learning-agent/kit/settings'
import { lastActivity } from './activity.ts'
import { countdownText } from './countdown.ts'
import { mainStep, running } from './flow.ts'
import { paceOf } from './pace.ts'
import { dayStart, dayText, plan, type Plan } from './reviews.ts'
import { z } from 'zod'

export const name = 'learning-planner'
export const inject = ['learnCore', 'learnGoal', 'learnLibrary', 'learnKnowledge', 'learnAssess', 'learnCurriculum', 'learnTextbook', 'learnLearner']

/** `dailyChecks` is edited on the settings page (资料服务 · 复查提醒); both are read each time a step is worked out. */
export const Config = Schema.object({
  dailyChecks: Schema.natural().max(10).default(3).description('每天建议的复查题数（全部课程合计，0 为不建议）').volatile(),
  returnAfter: Schema.natural().min(1).default(7).description('隔多少天没学算"回来"（天）').volatile(),
})
export type Config = ReturnType<typeof Config>

const migrations: Migration[] = [{
  version: 1,
  sql: `
    CREATE TABLE planner_deferred (
      course_id TEXT PRIMARY KEY,
      until TEXT NOT NULL
    );
  `,
}]

const DAY = 86_400_000

class LearnPlannerService extends Service implements LearnPlanner {
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'learnPlanner')
    ctx.learnCore.db.migrate('planner', migrations)
  }

  async next(courseId: string, reviews?: Plan): Promise<NextStep> {
    if (this.ctx.learnCore.courses.get(courseId)?.status === 'archived') return { courseId, key: 'course.archived', actor: 'none', title: '课程已归档', detail: '归档的课程不再安排学习。' }
    let goal: GoalDoc | undefined
    try {
      goal = await this.ctx.learnGoal.get(courseId)
    } catch (error) {
      // Not "no goal yet": that would send the teacher to write a new one over the learner's file.
      const reason = (error as Error).message.split('\n')[0]!.slice(0, 120)
      return { courseId, key: 'goal.unreadable', actor: 'none', title: '读不了目标说明', detail: `目标说明文件（goal.md）读不出来：${reason}。在 Obsidian 里改正它，或者请主老师照原来的内容重写一份。` }
    }
    const step = mainStep(this.ctx, courseId, goal)
    const countdown = this.countdown(courseId, goal)
    const unfinished = this.unfinished(courseId, step)
    const review = (reviews ?? this.reviews()).picks.get(courseId)
    const back = this.back(courseId)
    return { ...step, ...(countdown ? { countdown } : {}), ...(unfinished.length ? { unfinished } : {}), ...(review ? { review } : {}), ...(back ? { back } : {}) }
  }

  /** Away long enough to count as coming back: when the learner last studied the course, and what. Not after the course ended. */
  private back(courseId: string, at = Date.now()): NextStep['back'] {
    if (this.ctx.learnCore.courses.get(courseId)?.status !== 'active') return undefined
    const last = lastActivity(this.ctx, courseId)
    if (!last) return undefined
    const days = Math.round((dayStart(at) - dayStart(last.at)) / DAY)
    return days >= (this.config.returnAfter.get() ?? 7) ? { days, at: new Date(last.at).toISOString(), last: last.what } : undefined
  }

  /** The checks to suggest now, across all courses. */
  reviews(at = Date.now()): Plan {
    return plan(this.ctx, this.config.dailyChecks.get() ?? 3, courseId => this.deferredUntil(courseId), at)
  }

  /** The time left to the exam (the earlier of the exam date and the deadline), with the roadmap's progress. Counts days, never hours or chances. */
  countdown(courseId: string, goal: GoalDoc | undefined, today = new Date()): Countdown | undefined {
    const dates = [
      ...(goal?.goal.exam?.date ? [{ label: '考试' as const, date: goal.goal.exam.date }] : []),
      ...(goal?.goal.deadline ? [{ label: '期限' as const, date: goal.goal.deadline }] : []),
    ].sort((a, b) => a.date.localeCompare(b.date))
    const first = dates[0]
    if (!first) return undefined
    const midnight = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
    const [year, month, day] = first.date.split('-').map(Number) as [number, number, number]
    const days = Math.round((Date.UTC(year, month - 1, day) - midnight(today)) / DAY)
    const curriculum = this.ctx.learnCurriculum
    const stages = curriculum.stages(courseId)
    const pace = days >= 0 ? paceOf(stages.map(stage => ({ ...stage, lessons: curriculum.lessons(stage.id) })), days) : undefined
    return { ...first, days, stagesDone: stages.filter(stage => stage.status === 'done').length, stagesTotal: stages.length, ...(pace ? { pace } : {}) }
  }

  /**
   * Requests at once cannot start more than the day allows: each sees at most the checks still allowed, one per
   * course, and assess starts one per node.
   */
  async check(courseId: string, nodeId: string): Promise<Test> {
    const { learnAssess, learnKnowledge } = this.ctx
    const ids = new Set([nodeId, ...learnKnowledge.identity(nodeId).merged])
    const open = learnAssess.tests(courseId, { kind: 'review' }).find(test => test.status === 'open' && test.check && ids.has(test.check.nodeId))
    if (open) return open
    if (this.reviews().picks.get(courseId)?.nodeId !== nodeId) {
      throw new LearningApiError('learning/planner/not-suggested', '这道复查现在不在建议里了：今天的复查已经做够了，或者这个知识点的情况变了。刷新看看。', { courseId, nodeId })
    }
    return learnAssess.check(courseId, nodeId, 'user')
  }

  defer(courseId: string): void {
    // Until the next local midnight: the learner's "today".
    const until = new Date(dayStart(Date.now()))
    until.setDate(until.getDate() + 1)
    this.ctx.learnCore.db.sqlite.prepare('INSERT INTO planner_deferred (course_id, until) VALUES (?, ?) ON CONFLICT (course_id) DO UPDATE SET until = excluded.until')
      .run(courseId, until.toISOString())
  }

  private deferredUntil(courseId: string): number | undefined {
    const row = this.ctx.learnCore.db.sqlite.prepare('SELECT until FROM planner_deferred WHERE course_id = ?').get(courseId) as { until: string } | undefined
    return row ? Date.parse(row.until) : undefined
  }

  /** Open tests besides the step's own: one whose clock runs first, then oldest first. */
  private unfinished(courseId: string, step: Pick<NextStep, 'params'>): UnfinishedTest[] {
    const open = this.ctx.learnAssess.tests(courseId).filter(test => test.status === 'open' && test.id !== step.params?.id)
    if (open.length === 0) return []
    const tasks = this.ctx.learnCurriculum.tasks(courseId)
    return open
      .sort((a, b) => Number(running(b)) - Number(running(a)) || a.startedAt.localeCompare(b.startedAt))
      .map(test => ({
        testId: test.id,
        kind: test.kind,
        title: tasks.find(task => task.result?.kind === 'test' && task.result.id === test.id)?.title ?? TEST_KIND_LABEL[test.kind],
        startedAt: test.startedAt,
        ...(running(test) ? { running: true } : {}),
      }))
  }
}

/** The step in the brief: who acts, then what. */
function stepText(step: NextStep): string {
  if (step.actor === 'teacher') return `该你做：${step.title}。${step.detail}`
  if (step.actor === 'learner') return `等学习者：${step.title}。${step.detail}（这一步由学习者在页面上完成，你可以提醒学习者，不要替学习者做。）`
  return `现在不用你做：${step.title}。${step.detail}`
}

export function apply(ctx: Context, config: Config): void {
  const planner = new LearnPlannerService(ctx, config)

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const reviews = planner.reviews()
    const step = await planner.next(request.courseId, reviews)
    const lines = [stepText(step), ...(step.countdown ? [`${countdownText(step.countdown)}。${step.countdown.pace?.text ?? ''}`] : [])]
    if (step.countdown?.pace?.verdict === 'late') {
      lines.push('照目前的节奏可能赶不上：合适的时候和学习者商量增加每周投入、缩小目标范围或调整后面的路线（改目标、改路线都要学习者确认）；不要自己删内容或跳过验证。')
    }
    if (step.back) {
      lines.push(`学习者隔了 ${step.back.days} 天回来（上次学习是${dayText(Date.parse(step.back.at))}，${step.back.last}）。先欢迎回来，用一两句话帮学习者回顾上次学到哪里，再接着做下一步；不要列出落下的内容，也不要因此重新摸底。`)
    }
    if (step.review) {
      lines.push(`可以复查（不急）：「${step.review.title}」，${step.review.reason}今天的复查已做 ${step.review.used} 道，每天建议 ${step.review.limit} 道。课时之间（学习者没在读教材、做测试时）可以问一句要不要先做一道；学习者同意就用 start_check 出题，不想做就接着学，不要再提。`)
    }
    const missing = reviews.missing.get(request.courseId)
    if (missing?.length) {
      lines.push(`到了检查时间、但没有学习者没做过的练习题：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ` 等 ${missing.length} 个` : ''}。合适的时候给它们补一两道练习题（import_exercises 或 add_problems，pool 填 practice）。`)
    }
    return [...sections, { unit: 'planner', title: '下一步', text: lines.join('\n') }]
  })

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'planner',
    method: 'next',
    input: z.object({ courseId: z.string() }),
    handle: ({ courseId }) => planner.next(courseId),
  }), 'planner: next')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'planner',
    method: 'home',
    handle: async () => {
      const reviews = planner.reviews()
      return Promise.all(ctx.learnCore.courses.list().map(async course => {
        // When the learner last studied it: "继续学习" picks the course the learner was last in.
        const at = lastActivity(ctx, course.id)?.at
        const activeAt = at !== undefined ? { activeAt: new Date(at).toISOString() } : {}
        try {
          return { course, next: await planner.next(course.id, reviews), ...activeAt }
        } catch (error) {
          return { course, next: null, error: (error as Error).message, ...activeAt }
        }
      }))
    },
  }), 'planner: home')

  // The learner starts the check suggested beside the step.
  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'planner',
    method: 'check',
    input: z.object({ courseId: z.string(), nodeId: z.string() }),
    handle: ({ courseId, nodeId }) => planner.check(courseId, nodeId),
  }), 'planner: check')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'planner',
    method: 'defer',
    input: z.object({ courseId: z.string() }),
    handle: ({ courseId }) => {
      planner.defer(courseId)
      // Other open pages show the course without the suggestion.
      ctx.emit('learning/planner-changed', { courseId })
      return { ok: true }
    },
  }), 'planner: defer')
}
