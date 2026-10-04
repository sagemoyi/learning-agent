// textbook unit, agent tools.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { parseFrontmatter } from '@learning-agent/contracts'
import { linkOf, textTool } from '@learning-agent/kit'

export const name = 'learning-textbook-tools'
export const inject = ['tools', 'learnTextbook', 'learnCurriculum', 'learnCore']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(textTool({
    name: 'read_lesson_textbook',
    title: '读本节教材',
    description: '读取一个课时已经生成的教材全文（带段落块 ID 和出处）。出小测题、写小结前先读一遍。',
    parameters: { lessonId: { type: 'string', required: true } },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const lesson = ctx.learnCurriculum.lesson(args.lessonId)
      if (!lesson?.textbookFile) throw new Error(`课时 ${args.lessonId} 不存在`)
      const file = await ctx.learnCore.files.read(courseId, lesson.textbookFile)
      if (!file) return ctx.learnTextbook.running().includes(lesson.id) ? '这一节的教材正在生成，稍后再读。' : '这一节的教材还没有生成。'
      return parseFrontmatter(file.text).body
    },
  })), 'textbook tools: read_lesson_textbook')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'regenerate_textbook',
    title: '重新生成教材',
    description: '按当前的阶段设计书重新生成一个课时的教材（旧版本保留在变更日志里，可以回退）。只在学习者要求或设计书改过之后使用。',
    parameters: { lessonId: { type: 'string', required: true } },
    async execute(args, exec) {
      linkOf(ctx, exec)
      if (!ctx.learnCurriculum.lesson(args.lessonId)) throw new Error(`课时 ${args.lessonId} 不存在`)
      void ctx.learnTextbook.generateLesson(args.lessonId).catch(() => { /* reported on the feed */ })
      return '已开始重新生成，完成后教材页会自动刷新。'
    },
  })), 'textbook tools: regenerate_textbook')
}
