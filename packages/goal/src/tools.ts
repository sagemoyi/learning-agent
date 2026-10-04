// goal unit, agent tools.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { linkOf, textTool } from '@learning-agent/kit'

export const name = 'learning-goal-tools'
export const inject = ['tools', 'learnGoal', 'learnCore']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(textTool({
    name: 'save_goal_draft',
    title: '保存目标说明草稿',
    description: '把和学习者商量好的目标写成目标说明草稿（goal.md）。学习者会在"课程进度"页确认；确认前不要进入下一步。已确认的目标再改会退回草稿，需要重新确认。各字段是写给学习者看的：用名称，不写内部编号（kn_、ck_ 等）；公式写成 $…$。',
    parameters: {
      purpose: { type: 'string', required: true, description: '目的：为什么学' },
      scenario: { type: 'string', required: true, description: '使用场景' },
      canDo: { type: 'array', required: true, items: { type: 'string' }, description: '学成后能做的事，每条一个可检验的行为' },
      level: { type: 'string', required: true, description: '要做到什么程度' },
      verification: { type: 'string', required: true, description: '怎么验证学会了' },
      exclude: { type: 'array', items: { type: 'string' }, description: '边界：不学什么' },
      book: { type: 'string', required: true, enum: ['closed', 'open'], description: '默认测试条件：闭卷或开卷' },
      calculator: { type: 'boolean', required: true, description: '默认测试条件：能否用计算器' },
      formulaSheet: { type: 'boolean', required: true, description: '默认测试条件：能否带公式表' },
      timeBudget: { type: 'string', description: '打算投入多少时间，例如 "每周 4–6 小时"' },
      deadline: { type: 'string', description: '可选的最后期限，YYYY-MM-DD' },
      notes: { type: 'string', required: true, description: '正文：用几段话说明这个目标，包括你给过的候选终点和学习者的选择' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      await ctx.learnGoal.saveDraft(courseId, {
        purpose: args.purpose,
        scenario: args.scenario,
        canDo: args.canDo,
        level: args.level,
        verification: args.verification,
        boundaries: {
          exclude: args.exclude ?? [],
          defaultConditions: { book: args.book, calculator: args.calculator, formulaSheet: args.formulaSheet },
          ...(args.timeBudget ? { timeBudget: args.timeBudget } : {}),
        },
        ...(args.deadline ? { deadline: args.deadline } : {}),
      }, `# 目标说明\n\n${args.notes}\n`, { actor: 'teacher', reason: '主老师起草目标说明' })
      return '目标说明草稿已保存。请学习者到"课程进度"页查看并确认。'
    },
  })), 'goal tools: save_goal_draft')
}
