// Teacher tools use the same validated revision services as pages; cross-course reuse is a learner action.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { RelationScope, type KnowledgeEdgePatch, type NewEdge } from '@learning-agent/contracts'
import { linkOf, textTool } from '@learning-agent/kit'

export const name = 'learning-knowledge-tools'
export const inject = ['tools', 'learnKnowledge', 'learnCore']

function bounded(text: string, more: string): string {
  return text.length > 5000 ? `${text.slice(0, 4700)}\n内容较多已截断；${more}` : text
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(textTool({
    name: 'find_knowledge_nodes', title: '查找知识节点',
    description: '按名称或别名找知识身份，返回 ID、类型、版本、领域和条件。同名可能异义，跨课复用请学习者在知识模型页选择。',
    parameters: { query: { type: 'string', required: true }, otherCourses: { type: 'boolean', description: '默认只查本课；true 同时找其他课程候选' } },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const matches = ctx.learnKnowledge.candidates(args.query, args.otherCourses ? undefined : courseId)
      return matches.length ? bounded(matches.slice(0, 20).map(node => `${node.id} ${node.title}（${node.kind}，版本 ${node.version}）\n领域：${node.domain || '未注明'}；条件：${node.conditions.slice(0, 240) || '未注明'}\n${node.description.slice(0, 160)}`).join('\n\n') + (matches.length > 20 ? '\n还有其他候选，请缩小查询。' : ''), '缩小 find_knowledge_nodes 的名称或别名查询，再用 get_knowledge_node 读取具体定义。') : '没有匹配节点。'
    },
  })), 'knowledge tools: find_knowledge_nodes')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'add_knowledge_nodes', title: '添加知识节点',
    description: '分批建立课程粗图或当前阶段细图。节点应能影响诊断、反馈或教学决策；综合能力和完整任务分别建。新节点产生新身份，本课复用填写已有 ID。关系须附理由和资料依据，依据不足先存草案；不能仅凭章节顺序声明硬先修。',
    parameters: {
      requestId: { type: 'string', required: true, description: '本批操作标识；重试相同内容沿用，新的修改换一个' },
      nodes: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        title: { type: 'string', required: true, description: '概念名或可观察的能力动作' },
        kind: { type: 'string', required: true, enum: ['knowledge', 'skill', 'integrated', 'task'] },
        description: { type: 'string', description: '含义与边界；不要在这里粘贴内部编号' },
        aliases: { type: 'array', items: { type: 'string' } },
        domain: { type: 'string', description: '适用领域' },
        conditions: { type: 'string', description: '在什么条件下做到什么' },
        reuseId: { type: 'string', description: '本课已有知识身份；不填则新建' },
        sources: { type: 'array', items: { type: 'string' }, description: '支持节点定义的资料片段 ID，取自 read_section 或 search_library' },
      } } },
      edges: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        from: { type: 'string', required: true, description: '本批唯一标题或本课已有 ID' },
        to: { type: 'string', required: true },
        type: { type: 'string', required: true, enum: ['part-of', 'requires', 'recommended-before', 'related'], description: 'from 是 to 的组成项 / from 需要 to / 建议 from 先于 to / 双向相关' },
        rationale: { type: 'string', description: '为什么成立；资料直接陈述还是教学推断' },
        sources: { type: 'array', items: { type: 'string' }, description: '支持关系的资料片段 ID；有效关系必须有' },
        status: { type: 'string', enum: ['draft', 'valid', 'disputed'], description: '默认 draft 草案；原文支持且核对过才写 valid；冲突用 disputed' },
        scope: { type: 'string', enum: ['course', 'global', 'task'], description: '默认 course 仅本课；global 所有课程；task 本课指定任务' },
        taskId: { type: 'string', description: 'scope 为 task 时必须填写本课任务 ID' },
        conditions: { type: 'string', description: '关系适用的工具或表现条件' },
      } } },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const edges: NewEdge[] | undefined = args.edges?.map(edge => ({ ...edge, scope: RelationScope.parse(edge.scope === 'global' ? { kind: 'global' } : edge.scope === 'task' ? { kind: 'task', courseId, taskId: edge.taskId } : { kind: 'course', courseId }) }))
      const graph = await ctx.learnKnowledge.add(courseId, { requestId: args.requestId, nodes: args.nodes, edges }, { actor: 'teacher', reason: '主老师分批建立知识结构' })
      return bounded(`本课 ${graph.nodes.length} 个节点、${graph.edges.length} 条关系；其中待复核 ${graph.edges.filter(edge => !edge.usable).length} 条。\n本批操作 ${graph.operationId}\n${graph.nodes.slice(-30).map(node => `${node.id} ${node.title}（版本 ${node.version}）`).join('\n')}${graph.nodes.length > 30 ? '\n其余节点用 find_knowledge_nodes 查。' : ''}`, '用 find_knowledge_nodes 查询本批节点的具体 ID 与定义。')
    },
  })), 'knowledge tools: add_knowledge_nodes')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'get_knowledge_node', title: '查看知识节点',
    description: '查看本课节点的含义、条件、关系依据和版本；用 read_section 按出处继续核对原文。',
    parameters: { node: { type: 'string', required: true, description: '节点 ID 或本课唯一标题' } },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec), node = ctx.learnKnowledge.resolve(courseId, args.node)
      if (!node) return '本课没有这个活动节点，请用 find_knowledge_nodes 查找。'
      const detail = ctx.learnKnowledge.detail(courseId, node.id)
      const text = `${node.id} ${node.title}（${node.kind}，版本 ${node.version}）\n${node.description}\n领域：${node.domain}；条件：${node.conditions}\n关系：\n${detail.edges.slice(0, 20).map(edge => `${edge.id}（版本 ${edge.version}，${edge.status}）${detail.titles[edge.from]} ${edge.type} ${detail.titles[edge.to]}；${edge.rationale}；条件 ${edge.conditions}；依据 ${edge.sources.join(',')}`).join('\n')}\n来源：${detail.links.slice(0, 20).map(link => link.citation ?? link.label).join('；')}`
      return bounded(text, '用 read_section 按出处读取原文，或请学习者打开知识模型查看完整详情。')
    },
  })), 'knowledge tools: get_knowledge_node')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'revise_knowledge_node', title: '修订知识节点',
    description: '修订节点说明、领域或条件并留变更记录。版本取自 get_knowledge_node；改变所指能力或类型须新建身份，跨课合并等待学习者确认。',
    parameters: {
      nodeId: { type: 'string', required: true }, version: { type: 'integer', required: true },
      description: { type: 'string' }, domain: { type: 'string' }, conditions: { type: 'string' },
      reason: { type: 'string', required: true },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const { nodeId, version, reason, ...patch } = args
      const op = ctx.learnKnowledge.editNode(courseId, nodeId, version, patch, { actor: 'teacher', reason })
      return `节点已修订，版本 ${ctx.learnKnowledge.node(nodeId)?.version}；操作 ${op.id}。原证据保留。`
    },
  })), 'knowledge tools: revise_knowledge_node')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'revise_knowledge_edge', title: '修订知识关系',
    description: '补充或修订关系依据与适用条件，或把冲突关系标为有争议、停用；用 get_knowledge_node 读取关系 ID 与版本。',
    parameters: {
      edgeId: { type: 'string', required: true }, version: { type: 'integer', required: true },
      rationale: { type: 'string' }, conditions: { type: 'string' },
      sources: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', enum: ['draft', 'valid', 'disputed', 'inactive'] },
      reason: { type: 'string', required: true },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec), { edgeId, version, reason, ...patch } = args
      const op = ctx.learnKnowledge.editEdge(courseId, edgeId, version, patch as KnowledgeEdgePatch, { actor: 'teacher', reason })
      return `关系已修订；操作 ${op.id}。草案或争议关系不进入硬先修查询。`
    },
  })), 'knowledge tools: revise_knowledge_edge')
}
