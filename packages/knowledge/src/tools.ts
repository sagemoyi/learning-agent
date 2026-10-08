// Teacher tools use the same validated revision services as pages; cross-course reuse is a learner action.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { RelationScope, type KnowledgeEdgePatch, type NewEdge } from '@learning-agent/contracts'
import { linkOf, textTool } from '@learning-agent/kit'
import { EDGE_LABEL, EXAM_LABEL, KIND_LABEL, STATUS_LABEL } from './labels.ts'

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
      return matches.length ? bounded(matches.slice(0, 20).map(node => `${node.id} ${node.title}（${KIND_LABEL[node.kind]}，版本 ${node.version}）\n领域：${node.domain || '未注明'}；条件：${node.conditions.slice(0, 240) || '未注明'}\n${node.description.slice(0, 160)}`).join('\n\n') + (matches.length > 20 ? '\n还有其他候选，请缩小查询。' : ''), '缩小 find_knowledge_nodes 的名称或别名查询，再用 get_knowledge_node 读取具体定义。') : '没有匹配节点。'
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
      return bounded(`本课 ${graph.nodes.length} 个节点、${graph.edges.length} 条关系；其中待复核 ${graph.edges.filter(edge => !edge.usable).length} 条。\n${graph.operationId ? `本批操作 ${graph.operationId}` : '本批内容已在本课，没有新的改动'}\n${graph.nodes.slice(-30).map(node => `${node.id} ${node.title}（版本 ${node.version}）`).join('\n')}${graph.nodes.length > 30 ? '\n其余节点用 find_knowledge_nodes 查。' : ''}`, '用 find_knowledge_nodes 查询本批节点的具体 ID 与定义。')
    },
  })), 'knowledge tools: add_knowledge_nodes')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'extract_knowledge_sections', title: '按小节抽取知识',
    description: '在后台读资料某几个小节的原文，起草知识节点和关系并加入本课：节点带出处，关系一律是草案，整组可撤销。用于细化当前阶段的小节；结束时会收到进度通知。',
    parameters: {
      sections: { type: 'array', required: true, items: { type: 'string' }, description: '小节号，例如 "1.2"，一次最多 5 个；太长的小节改用它的下一级小节' },
      sourceId: { type: 'string', description: '本课资料的 ID；不填用骨架教材' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const results = ctx.learnKnowledge.extract(courseId, args.sections.slice(0, 5), 'teacher', args.sourceId)
      return `${results.map(result => result.message).join('\n')}${args.sections.length > 5 ? '\n一次最多 5 个小节，其余等这几节完成后再提交。' : ''}`
    },
  })), 'knowledge tools: extract_knowledge_sections')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'suggest_knowledge_merge', title: '建议合并知识节点',
    description: '两门课里的节点像是同一项能力时，提给学习者比较；学习者在知识模型页确认后才合并，原作答记录保留。先用 find_knowledge_nodes（otherCourses）核对两边的含义和条件。',
    parameters: {
      keepId: { type: 'string', required: true, description: '保留的节点 ID' },
      mergeId: { type: 'string', required: true, description: '并入的节点 ID' },
      reason: { type: 'string', required: true, description: '给学习者看的理由：含义、表现条件和出处哪里一致；用名称和页码，不写内部编号' },
    },
    async execute(args) {
      ctx.learnKnowledge.proposeMerge(args.keepId, args.mergeId, args.reason)
      return '已提给学习者比较，等学习者在知识模型页决定。'
    },
  })), 'knowledge tools: suggest_knowledge_merge')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'mark_exam_scope', title: '标记考试范围',
    description: '按考试档案标出本课节点是否在考试范围内，整批可撤销。先按小节标，再对返回的未标节点逐个判断；"有助理解"留给学习者决定学不学。',
    parameters: {
      sections: { type: 'array', items: { type: 'string' }, description: '考试范围内的骨架教材小节号或章名（如 "1.2"、"第1章"，含其下各节和习题）；出处在其中的节点标为范围内，出处都在其外的标为范围外，没有骨架教材出处的不动' },
      nodes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        node: { type: 'string', required: true, description: '节点 ID 或本课唯一标题' },
        exam: { type: 'string', required: true, enum: ['in-scope', 'beyond', 'out-of-scope', 'none'], description: '范围内 / 范围外但有助理解 / 范围外 / 不标' },
      } }, description: '逐个指定，在按小节标之后生效' },
      reason: { type: 'string', required: true, description: '依据，例如"教学大纲的考试范围"' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const result = ctx.learnKnowledge.markExamScope(courseId, {
        ...(args.sections ? { sections: args.sections } : {}),
        ...(args.nodes ? { nodes: args.nodes.map(item => ({ node: item.node, exam: item.exam === 'none' ? null : item.exam })) } : {}),
      }, { actor: 'teacher', reason: args.reason })
      const { counts } = result
      return bounded(`${result.operationId ? `已标记（操作 ${result.operationId}）` : '没有需要改的标记'}。范围内 ${counts['in-scope']} 个，${EXAM_LABEL.beyond} ${counts.beyond} 个，范围外 ${counts['out-of-scope']} 个，未标 ${counts.untagged} 个。${result.untagged.length ? `\n未标的节点（没有骨架教材出处，请逐个判断）：\n${result.untagged.slice(0, 40).map(node => `${node.id} ${node.title}`).join('\n')}` : ''}`, '用 find_knowledge_nodes 查其余未标节点。')
    },
  })), 'knowledge tools: mark_exam_scope')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'get_knowledge_node', title: '查看知识节点',
    description: '查看本课节点的含义、条件、关系依据和版本；用 read_section 按出处继续核对原文。',
    parameters: { node: { type: 'string', required: true, description: '节点 ID 或本课唯一标题' } },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec), node = ctx.learnKnowledge.resolve(courseId, args.node)
      if (!node) return '本课没有这个活动节点，请用 find_knowledge_nodes 查找。'
      const detail = ctx.learnKnowledge.detail(courseId, node.id)
      const text = `${node.id} ${node.title}（${KIND_LABEL[node.kind]}，版本 ${node.version}）\n${node.description}\n领域：${node.domain}；条件：${node.conditions}\n关系：\n${detail.edges.slice(0, 20).map(edge => `${edge.id}（版本 ${edge.version}，${STATUS_LABEL[edge.status]}）${detail.titles[edge.from]} ${EDGE_LABEL[edge.type]} ${detail.titles[edge.to]}；${edge.rationale}；条件 ${edge.conditions}；依据 ${edge.sources.join(',')}`).join('\n')}\n来源：${detail.links.slice(0, 20).map(link => link.citation ?? link.label).join('；')}`
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
      return op.changeIds.length ? `节点已修订，版本 ${ctx.learnKnowledge.node(nodeId)?.version}；操作 ${op.id}。原证据保留。` : '内容与当前版本相同，没有修改。'
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
      return op.changeIds.length ? `关系已修订；操作 ${op.id}。草案或争议关系不进入硬先修查询。` : '内容与当前版本相同，没有修改。'
    },
  })), 'knowledge tools: revise_knowledge_edge')
}
