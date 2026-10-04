// tutor unit, agent tools.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { linkOf, textTool } from '@learning-agent/kit'

export const name = 'learning-tutor-tools'
export const inject = ['tools', 'learnTutor', 'learnCore']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(textTool({
    name: 'write_lesson_summary',
    title: '写课时小结',
    description: '课时结束时调用：记下学习者的汇报，写老师小结（这节学会了什么、还缺哪些证据、下一节为什么这样安排），并把这一课时记为完成。小测结果会自动附上。',
    parameters: {
      lessonId: { type: 'string', required: true },
      learnerReport: { type: 'string', required: true, description: '学习者用自己的话说的汇报（照录）' },
      summary: { type: 'string', required: true, description: '老师小结（Markdown）' },
    },
    async execute(args, exec) {
      linkOf(ctx, exec)
      await ctx.learnTutor.writeLessonSummary(args.lessonId, { summary: args.summary, learnerReport: args.learnerReport }, { actor: 'teacher', reason: '主老师写课时小结' })
      return '课时记录已写好，这一课时已记为完成。'
    },
  })), 'tutor tools: write_lesson_summary')
}
