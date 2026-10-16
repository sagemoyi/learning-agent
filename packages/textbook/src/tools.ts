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
    description: '读取一个课时已经生成的教材全文（带段落编号和出处；"> [!quote]"框里是原样引用的资料原文），末尾列出核对时标为待核实的段落。出小测题、写小结前先读一遍。',
    parameters: { lessonId: { type: 'string', required: true } },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const lesson = ctx.learnCurriculum.lesson(args.lessonId)
      if (!lesson?.textbookFile) throw new Error(`课时 ${args.lessonId} 不存在`)
      const file = await ctx.learnCore.files.read(courseId, lesson.textbookFile)
      if (!file) return ctx.learnTextbook.running().includes(lesson.id) ? '这一节的教材正在生成，稍后再读。' : '这一节的教材还没有生成。'
      const flagged = ctx.learnTextbook.blocks(courseId, lesson.textbookFile).filter(block => block.unverified).map(block => `^${block.id}`)
      const body = parseFrontmatter(file.text).body
      return flagged.length ? `${body.trimEnd()}\n\n（待核实的段落：${flagged.join('、')}。它们和资料不一致或在资料里找不到依据，可以用 revise_textbook 按原文改。）` : body
    },
  })), 'textbook tools: read_lesson_textbook')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'regenerate_textbook',
    title: '重新生成教材',
    description: '按当前的阶段设计书生成或重新生成一个课时的教材（旧版本保留在变更日志里，可以回退）。用于：教材生成失败后重试、学习者要求重写、设计书改过之后。',
    parameters: { lessonId: { type: 'string', required: true } },
    async execute(args, exec) {
      linkOf(ctx, exec)
      if (!ctx.learnCurriculum.lesson(args.lessonId)) throw new Error(`课时 ${args.lessonId} 不存在`)
      void ctx.learnTextbook.generateLesson(args.lessonId).catch(() => { /* reported on the feed */ })
      return '已开始生成。生成完或失败时，系统会发来进度通知；在那之前先和学习者做别的，或者告诉学习者稍等。'
    },
  })), 'textbook tools: regenerate_textbook')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'revise_textbook',
    title: '修改教材段落',
    description: '只改一节教材里的几段，其余段落原样不动；改写只依据资料，改完的段落会重新核对出处；"> [!quote]"框是资料原文，不能改。用于：学习者说某段讲得不清楚或有错，或者某段标了待核实、要按原文改正。要重写整节用 regenerate_textbook。',
    parameters: {
      lessonId: { type: 'string', required: true },
      blocks: { type: 'array', required: true, items: { type: 'string' }, description: '要改的段落编号，1 到 8 个：read_lesson_textbook 里每段末尾 ^ 后面的 6 位编号' },
      instruction: { type: 'string', required: true, description: '怎么改，一两句，例如"把推导拆成三步，每步说明用到的条件"' },
    },
    async execute(args, exec) {
      linkOf(ctx, exec)
      const lesson = ctx.learnCurriculum.lesson(args.lessonId)
      if (!lesson) throw new Error(`课时 ${args.lessonId} 不存在`)
      const result = await ctx.learnTextbook.reviseBlocks(args.lessonId, { blockIds: args.blocks, instruction: args.instruction }, { actor: 'teacher', reason: `修改教材：${args.instruction}` })
      return [
        `已修改 ${lesson.number} 的 ${result.revised} 段${result.added ? `，多出 ${result.added} 段` : ''}${result.removed ? `，删去 ${result.removed} 段` : ''}。`,
        result.unverified.length ? `改完仍待核实：${result.unverified.join('；')}` : '改过的段落核对通过。',
        ...result.notes,
      ].join('\n')
    },
  })), 'textbook tools: revise_textbook')
}
