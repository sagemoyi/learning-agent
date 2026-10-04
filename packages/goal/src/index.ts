// goal unit, host half. Provides `ctx.learnGoal` (contracts §5.1): the goal statement in `goal.md`
// (six elements + optional exam profile in the frontmatter, prose below). Versions come from
// core's change log. Skeleton: the teacher drafts it with a tool, the learner confirms on the
// progress page; negotiation with candidate endpoints and parallel research come later (PLAN §4.2).
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  COURSE_LAYOUT,
  GoalFrontmatter,
  LearningApiError,
  parseFrontmatter,
  withFrontmatter,
  type ChangeMeta,
  type GoalDoc,
  type LearnGoal,
} from '@learning-agent/contracts'
import { z } from 'zod'

export const name = 'learning-goal'
export const inject = ['learnCore']

class LearnGoalService extends Service implements LearnGoal {
  constructor(ctx: Context) {
    super(ctx, 'learnGoal')
  }

  async get(courseId: string): Promise<GoalDoc | undefined> {
    const file = await this.ctx.learnCore.files.read(courseId, COURSE_LAYOUT.goal)
    if (!file) return undefined
    const { data, body } = parseFrontmatter(file.text)
    const goal = GoalFrontmatter.safeParse(data)
    if (!goal.success) {
      throw new LearningApiError('learning/goal/invalid-file', `goal.md 的头部字段不完整：${goal.error.issues.map(issue => issue.path.join('.')).join('、')}`, { issues: goal.error.issues })
    }
    return { courseId, goal: goal.data, body }
  }

  private async write(courseId: string, goal: GoalFrontmatter, body: string, meta: ChangeMeta): Promise<GoalDoc> {
    const parsed = GoalFrontmatter.parse(goal)
    await this.ctx.learnCore.files.write(courseId, COURSE_LAYOUT.goal, withFrontmatter(parsed as Record<string, unknown>, body), meta)
    return { courseId, goal: parsed, body }
  }

  async saveDraft(courseId: string, goal: Omit<GoalFrontmatter, 'status'>, body: string, meta: ChangeMeta): Promise<GoalDoc> {
    const current = await this.get(courseId).catch(() => undefined)
    // Changing a confirmed goal is a major change (PLAN §7): it goes back to draft for the learner to confirm again.
    return this.write(courseId, { ...goal, status: 'draft' }, body, { ...meta, size: current?.goal.status === 'confirmed' ? 'major' : meta.size ?? 'minor' })
  }

  async confirm(courseId: string): Promise<GoalDoc> {
    const current = await this.get(courseId)
    if (!current) throw new LearningApiError('learning/goal/missing', '还没有目标说明，先和主老师商量出一份草稿')
    if (current.goal.status === 'confirmed') return current
    const doc = await this.write(courseId, { ...current.goal, status: 'confirmed' }, current.body, { actor: 'user', reason: '学习者确认目标说明', size: 'major' })
    this.ctx.emit('learning/goal-confirmed', { courseId })
    this.ctx.emit('learning/handoff', { courseId, unit: 'goal', text: '学习者确认了目标说明。' })
    return doc
  }
}

const CONDITION_TEXT = (goal: GoalFrontmatter) => {
  const c = goal.boundaries.defaultConditions
  return `${c.book === 'closed' ? '闭卷' : '开卷'}，${c.calculator ? '可用' : '不可用'}计算器，${c.formulaSheet ? '可带' : '不带'}公式表${c.timeLimit ? `，限时 ${c.timeLimit} 分钟` : ''}`
}

export function apply(ctx: Context): void {
  const goals = new LearnGoalService(ctx)

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'goal',
    method: 'get',
    input: z.object({ courseId: z.string() }),
    handle: async ({ courseId }) => (await goals.get(courseId)) ?? null,
  }), 'goal: get')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'goal',
    method: 'confirm',
    input: z.object({ courseId: z.string() }),
    handle: ({ courseId }) => goals.confirm(courseId),
  }), 'goal: confirm')

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const doc = await goals.get(request.courseId).catch(() => undefined)
    const text = !doc
      ? '还没有目标说明。'
      : [
          `状态：${doc.goal.status === 'confirmed' ? '已确认' : '草稿，等学习者确认'}`,
          `目的：${doc.goal.purpose}`,
          `学成后能做：${doc.goal.canDo.join('；')}`,
          `程度：${doc.goal.level}`,
          `验证方式：${doc.goal.verification}`,
          `不学：${doc.goal.boundaries.exclude.join('、') || '（未写）'}`,
          `默认测试条件：${CONDITION_TEXT(doc.goal)}`,
          doc.goal.deadline ? `最后期限：${doc.goal.deadline}` : '',
        ].filter(Boolean).join('\n')
    return [...sections, { unit: 'goal', title: '目标说明', text }]
  })
}
