// curriculum unit, agent tools: roadmap, stage design, publishing tasks.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { Task } from '@learning-agent/contracts'
import { linkOf, textTool } from '@learning-agent/kit'

export const name = 'learning-curriculum-tools'
export const inject = ['tools', 'learnCurriculum', 'learnCore', 'learnKnowledge']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(textTool({
    name: 'save_roadmap',
    title: '保存课程路线',
    description: '保存粗略的课程路线：只写到"阶段标题 + 阶段目标"。每个阶段围绕一个完整任务组织。只有当前阶段会做详细设计，后面的阶段以后可以调整。路线是写给学习者看的：用名称，不写内部编号（kn_、ck_ 等）；公式写成 $…$。',
    parameters: {
      stages: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: '例如 "流体流动"' },
            objective: { type: 'string', required: true, description: '学完这个阶段能完成的完整任务' },
            supports: { type: 'array', items: { type: 'string' }, description: '这个阶段支撑目标里的哪几条"能做"（条目键，见简报）' },
          },
        },
      },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const stages = await ctx.learnCurriculum.saveRoadmap(courseId, args.stages, { actor: 'teacher', reason: '主老师制定课程路线' })
      return `路线已保存：\n${stages.map(stage => `${stage.id} 阶段 ${stage.index}：${stage.title}`).join('\n')}`
    },
  })), 'curriculum tools: save_roadmap')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'save_stage_design',
    title: '保存阶段设计书',
    description: '保存一个阶段的设计书（一页纸，逆向设计：先写阶段验收和测试蓝图，再写节点清单、课时安排和要用的资料），以及课时列表（一个课时 = 骨架教材的一个小节）和本阶段的核心知识点（阶段测试按它们组卷）。学习者确认设计书后，系统会自动生成这些课时的教材。设计书学习者会读：测试蓝图只写考哪些知识点、题型、条件和新题比例，不写具体题目、题号或答案；用名称而不是内部编号（kn_、ck_、ts_ 等）；资料出处写成 [《书名》p.页码](cite:片段ID)；公式写成 $…$。',
    parameters: {
      stageId: { type: 'string', required: true },
      markdown: { type: 'string', required: true, description: '设计书正文（Markdown）' },
      supports: { type: 'array', items: { type: 'string' }, description: '本阶段的验收支撑目标里的哪几条"能做"（条目键）；不写则沿用路线里的' },
      nodes: { type: 'array', items: { type: 'string' }, description: '本阶段的核心知识点（标题或 ID）：阶段测试每个都要考到，阶段前测也探这些' },
      lessons: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            number: { type: 'string', required: true, description: '小节号，例如 "1.2"' },
            title: { type: 'string', required: true, description: '例如 "流体静力学"' },
          },
        },
      },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const nodeIds = args.nodes?.map(ref => {
        const node = ctx.learnKnowledge.resolve(courseId, ref)
        if (!node) throw new Error(`知识节点 "${ref}" 不在本课知识图里，先用 add_knowledge_nodes 添加`)
        return node.id as string
      })
      const { stage, lessons } = await ctx.learnCurriculum.saveDesign(args.stageId, { markdown: args.markdown, lessons: args.lessons, ...(args.supports ? { supports: args.supports } : {}), ...(nodeIds ? { nodeIds } : {}) }, { actor: 'teacher', reason: '主老师编写阶段设计' })
      return `阶段 ${stage.index} 的设计书已保存，共 ${lessons.length} 个课时：\n${lessons.map(lesson => `${lesson.id} ${lesson.number} ${lesson.title}`).join('\n')}\n请学习者到"课程进度"页阅读并确认。`
    },
  })), 'curriculum tools: save_stage_design')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'publish_task',
    title: '发布任务',
    description: '给学习者发布一个任务，会显示在"课程进度"页。阅读任务写清楚读到哪里停下。测试类任务请用 start_test。',
    parameters: {
      kind: { type: 'string', required: true, enum: ['predict', 'read', 'practice', 'report', 'review', 'other'] },
      title: { type: 'string', required: true },
      instructions: { type: 'string', required: true },
      lessonId: { type: 'string', description: '所属课时 ID' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const lesson = args.lessonId ? ctx.learnCurriculum.lesson(args.lessonId) : undefined
      if (args.lessonId && !lesson) throw new Error(`课时 ${args.lessonId} 不存在`)
      const stage = lesson ? ctx.learnCurriculum.stage(lesson.stageId) : ctx.learnCurriculum.currentStage(courseId)
      const task = ctx.learnCurriculum.publishTask({
        courseId: courseId as Task['courseId'],
        ...(stage ? { stageId: stage.id } : {}),
        ...(lesson ? { lessonId: lesson.id } : {}),
        kind: args.kind,
        title: args.title,
        instructions: args.instructions,
        createdBy: 'teacher',
      })
      return `任务 ${task.id} 已发布。`
    },
  })), 'curriculum tools: publish_task')
}
