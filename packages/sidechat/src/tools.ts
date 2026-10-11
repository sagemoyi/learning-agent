// sidechat unit, agent tools (mounted on the side-chat preset; contracts §7.2).
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { allowTool, linkOf, textTool } from '@learning-agent/kit'

export const name = 'learning-sidechat-tools'
export const inject = ['tools', 'learnSidechat', 'learnCore']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(textTool({
    name: 'draft_proposal',
    title: '起草修改建议',
    description: '学习者明确想改课程的某处（教材的讲法、某个阶段的设计、课程路线、目标说明、知识点）时，起草一条修改建议。你自己不能改：草稿显示在学习者的侧边栏，学习者点"交给主老师"后，主老师核对资料再决定改不改。只是疑问、没有修改意图时不要用；题目有错请学习者在测试页点"这题有问题"。',
    parameters: {
      target: { type: 'string', required: true, enum: ['selection', 'roadmap', 'goal'], description: 'selection：学习者打开这次提问时选中的内容（教材段落、阶段、知识点）；roadmap：课程路线（阶段的顺序、增删）；goal：目标说明' },
      change: { type: 'string', required: true, description: '改什么，一两句话，写给主老师和学习者看，不写内部编号' },
      reason: { type: 'string', required: true, description: '为什么：学习者的想法和理由；有资料依据时写出处（书名和页码）' },
    },
    async execute(args, exec) {
      allowTool(ctx, exec, 'draft_proposal')
      const link = linkOf(ctx, exec)
      const draft = await ctx.learnSidechat.draft(link.sessionId, { target: args.target as 'selection' | 'roadmap' | 'goal', change: args.change, reason: args.reason })
      return `已起草（${draft.label}），显示在学习者的侧边栏。告诉学习者：觉得可以就点"交给主老师"，主老师会核对后决定；不要说已经改了。`
    },
  })), 'sidechat tools: draft_proposal')
}
