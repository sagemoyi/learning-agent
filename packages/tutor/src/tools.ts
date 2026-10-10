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
    description: '小测交卷、判分定了、学习者汇报之后调用：记下汇报，写老师小结（这节在什么题上做到了什么、用了哪些帮助、还缺哪些证据、下一节为什么这样安排），并把这一课时记为完成。小测每题的结果、本课时记下的帮助和相关知识点的状态由系统写进记录；小结不要把有帮助做对的说成已经掌握。',
    parameters: {
      lessonId: { type: 'string', required: true },
      learnerReport: { type: 'string', required: true, description: '学习者在对话里说的原话，照录，可以分几行录几句；学习者不想汇报时，照录他说的那句话' },
      summary: { type: 'string', required: true, description: '老师小结（Markdown），用知识点和题号，不写内部编号' },
    },
    async execute(args, exec) {
      const link = linkOf(ctx, exec)
      await ctx.learnTutor.writeLessonSummary(args.lessonId, { summary: args.summary, learnerReport: args.learnerReport, sessionId: link.sessionId }, { actor: 'teacher', reason: '主老师写课时小结' })
      return '课时记录已写好，这一课时已记为完成。'
    },
  })), 'tutor tools: write_lesson_summary')
}
