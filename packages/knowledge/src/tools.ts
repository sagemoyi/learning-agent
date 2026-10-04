// knowledge unit, agent tools.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { linkOf, textTool } from '@learning-agent/kit'

export const name = 'learning-knowledge-tools'
export const inject = ['tools', 'learnKnowledge', 'learnCore']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(textTool({
    name: 'add_knowledge_nodes',
    title: '添加知识节点',
    description: '往本课知识图里添加节点和关系。节点要细到"能单独出一道题考它"的程度。已有同名节点会复用。关系类型：part-of（组成）、requires（先修：不会 to 就学不了 from，唯一影响排课的关系）、recommended-before（建议先学）、related（相关）。关系的 from/to 写节点标题或 ID。',
    parameters: {
      nodes: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: '节点名，例如 "流体静力学基本方程"' },
            kind: { type: 'string', required: true, enum: ['knowledge', 'skill', 'integrated', 'task'], description: 'knowledge 知识 / skill 技能 / integrated 综合能力 / task 完整任务' },
            description: { type: 'string', description: '一两句话说明，最好注明依据的资料片段 ID' },
          },
        },
      },
      edges: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string', required: true },
            to: { type: 'string', required: true },
            type: { type: 'string', required: true, enum: ['part-of', 'requires', 'recommended-before', 'related'] },
            rationale: { type: 'string' },
          },
        },
      },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const graph = await ctx.learnKnowledge.add(courseId, args, { actor: 'teacher', reason: '主老师搭建知识图' })
      return `本课知识图现在有 ${graph.nodes.length} 个节点、${graph.edges.length} 条关系：\n${graph.nodes.map(node => `${node.id} ${node.title}`).join('\n')}`
    },
  })), 'knowledge tools: add_knowledge_nodes')
}
