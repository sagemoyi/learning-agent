// Knowledge identities, scoped claims and atomic revisions; source targets are checked by their owners.
// Merges keep the merged identity and its evidence (knowledge C); section extraction drafts knowledge in the background.
import { Service, type Context } from '@deepseek-ai/cordis'
import { KnowledgeAdd, KnowledgeNodePatch, KnowledgeEdgePatch, KnowledgeMembershipPatch, NodeLink, idOf,
  type ChangeMeta, type LearnKnowledge, type NewEdge, type NewNode } from '@learning-agent/contracts'
import type { LearnTextbook } from '@learning-agent/contracts'
import { roleModel, Schema } from '@learning-agent/kit/settings'
import { z } from 'zod'
import { KnowledgeExtractions } from './extract.ts'
import { KnowledgeStore, knowledgeMigrations } from './store.ts'
import { EDGE_LABEL } from './labels.ts'

export const name = 'learning-knowledge'
export const inject = ['learnCore', 'learnLibrary', 'learnAssess', 'learnCurriculum', 'llm', 'sessionController', 'jobs']

export const Config = Schema.object({
  model: roleModel('知识抽取'),
})
export type Config = ReturnType<typeof Config>

class LearnKnowledgeService extends Service implements LearnKnowledge {
  readonly store: KnowledgeStore
  readonly sections: KnowledgeExtractions

  constructor(ctx: Context, config: Config) {
    super(ctx, 'learnKnowledge')
    ctx.learnCore.db.migrate('knowledge', knowledgeMigrations)
    this.store = new KnowledgeStore(ctx.learnCore, {
      chunk: id => ctx.learnLibrary?.chunk(id),
      source: id => ctx.learnLibrary?.source(id),
      courseSources: courseId => ctx.learnLibrary?.courseSources(courseId) ?? [],
      problem: id => ctx.learnAssess?.problem(id),
      // Textbook consumes knowledge, so target validation uses the supported optional lookup.
      blockIds: courseId => (ctx.get('learnTextbook') as LearnTextbook | undefined)?.blocks(courseId).map(block => block.id) ?? [],
      task: (courseId, id) => ctx.learnCurriculum?.tasks(courseId).some(task => task.id === id) ?? false,
    })
    this.sections = new KnowledgeExtractions(ctx, this.store, () => config.model.get())
  }

  async add(courseId: string, input: { readonly requestId?: string; readonly nodes: readonly NewNode[]; readonly edges?: readonly NewEdge[] }, meta: ChangeMeta) {
    return this.store.add(courseId, input, meta)
  }
  graph = (courseId: string) => this.store.graph(courseId)
  node = (nodeId: string) => this.store.node(nodeId)
  resolve = (courseId: string, ref: string) => this.store.resolve(courseId, ref)
  link: LearnKnowledge['link'] = (links, meta, courseId) => this.store.link(links, meta, courseId)
  links = (nodeId: string) => this.store.links(nodeId)
  candidates: LearnKnowledge['candidates'] = (ref, courseId) => this.store.candidates(ref, courseId)
  editNode: LearnKnowledge['editNode'] = (...args) => this.store.editNode(...args)
  editEdge: LearnKnowledge['editEdge'] = (...args) => this.store.editEdge(...args)
  setMembership: LearnKnowledge['setMembership'] = (...args) => this.store.setMembership(...args)
  unlink: LearnKnowledge['unlink'] = (...args) => this.store.unlink(...args)
  history: LearnKnowledge['history'] = courseId => this.store.history(courseId)
  operationDetails: LearnKnowledge['operationDetails'] = (...args) => this.store.operationDetails(...args)
  revert: LearnKnowledge['revert'] = (operationId, meta) => {
    const result = this.store.revert(operationId, meta)
    if (result.merge) this.ctx.emit('learning/identity-changed', { nodeIds: [result.merge.keepId, result.merge.mergeId] })
    return result
  }
  prerequisites: LearnKnowledge['prerequisites'] = (...args) => this.store.prerequisites(...args)
  detail: LearnKnowledge['detail'] = (...args) => this.store.detail(...args)
  global: LearnKnowledge['global'] = () => this.store.global()
  sourceLayer: LearnKnowledge['sourceLayer'] = courseId => this.store.sourceLayer(courseId)
  identity: LearnKnowledge['identity'] = nodeId => this.store.identity(nodeId)
  mergeSuggestions: LearnKnowledge['mergeSuggestions'] = courseId => this.store.mergeSuggestions(courseId)
  mergePlan: LearnKnowledge['mergePlan'] = (keepId, mergeId) => this.store.mergePlan(keepId, mergeId)
  merge: LearnKnowledge['merge'] = (input, meta) => {
    const result = this.store.merge(input, meta)
    this.ctx.emit('learning/identity-changed', { nodeIds: [input.keepId, input.mergeId] })
    return result
  }
  keepSeparate: LearnKnowledge['keepSeparate'] = input => this.store.keepSeparate(input)
  proposeMerge: LearnKnowledge['proposeMerge'] = (keepId, mergeId, reason) => this.store.proposeMerge(keepId, mergeId, reason)
  extract: LearnKnowledge['extract'] = (courseId, sections, by, sourceId) => this.sections.start(courseId, sections, by, sourceId)
  extractions: LearnKnowledge['extractions'] = (courseId, sourceId) => this.sections.overview(courseId, sourceId)
  cancelExtraction: LearnKnowledge['cancelExtraction'] = id => this.sections.cancel(id)
}

export function apply(ctx: Context, config: Config): void {
  const knowledge = new LearnKnowledgeService(ctx, config)
  ctx.jobs?.attachController('learning-knowledge')
  ctx.effect(() => { knowledge.sections.resume(); return () => knowledge.sections.dispose() }, 'knowledge: section extractions')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'knowledge',
    method: 'graph',
    input: z.object({ courseId: z.string() }),
    handle: ({ courseId }) => knowledge.graph(courseId),
  }), 'knowledge: graph')

  const course = z.object({ courseId: idOf('course') })
  const version = z.number().int().positive()
  const user = (reason: string): ChangeMeta => ({ actor: 'user', reason })
  const handoff = (courseId: string, text: string) => ctx.emit('learning/handoff', { courseId, unit: 'knowledge', text })
  function endpoint<T extends z.ZodType>(method: string, input: T, handle: (payload: z.infer<T>) => unknown | Promise<unknown>): void {
    ctx.effect(() => ctx.learnCore.api.endpoint({ unit: 'knowledge', method, input, handle }), `knowledge: ${method}`)
  }
  endpoint('candidates', z.object({ query: z.string().trim().min(1).max(200), courseId: idOf('course').optional() }), ({ query, courseId }) => knowledge.candidates(query, courseId))
  endpoint('detail', course.extend({ nodeId: idOf('node') }), ({ courseId, nodeId }) => knowledge.detail(courseId, nodeId))
  endpoint('history', course, ({ courseId }) => knowledge.history(courseId))
  endpoint('global', z.object({}), () => knowledge.global())
  endpoint('sources', z.object({ courseId: idOf('course').optional() }), ({ courseId }) => knowledge.sourceLayer(courseId))
  endpoint('operation', course.extend({ operationId: idOf('operation') }), ({ courseId, operationId }) => knowledge.operationDetails(courseId, operationId))
  endpoint('add', course.extend({ input: KnowledgeAdd }), async ({ courseId, input }) => {
    const graph = await knowledge.add(courseId, input, user('学习者添加或复用知识节点与关系'))
    if (!graph.replayed && graph.operationId) handoff(courseId, '学习者更新了本课的知识节点与关系。')
    return graph
  })
  endpoint('editNode', course.extend({ nodeId: idOf('node'), version, patch: KnowledgeNodePatch.strict() }), ({ courseId, nodeId, version, patch }) => {
    const result = knowledge.editNode(courseId, nodeId, version, patch, user('学习者修订知识节点'))
    if (result.changeIds.length) handoff(courseId, `学习者修订了知识节点「${knowledge.node(nodeId)?.title}」。`)
    return result
  })
  endpoint('editEdge', course.extend({ edgeId: idOf('edge'), version, patch: KnowledgeEdgePatch.strict() }), ({ courseId, edgeId, version, patch }) => {
    const result = knowledge.editEdge(courseId, edgeId, version, patch, user('学习者修订知识关系'))
    if (result.changeIds.length) handoff(courseId, '学习者修订了知识关系的依据或适用范围。')
    return result
  })
  endpoint('setMembership', course.extend({ nodeId: idOf('node'), version, patch: KnowledgeMembershipPatch.strict() }), ({ courseId, nodeId, version, patch }) => {
    const result = knowledge.setMembership(courseId, nodeId, version, patch, user('学习者调整本课知识范围'))
    if (result.changeIds.length) handoff(courseId, '学习者调整了本课知识节点的范围。')
    return result
  })
  endpoint('unlink', course.extend({ link: NodeLink }), ({ courseId, link }) => {
    const result = knowledge.unlink(courseId, link, user('学习者停用知识来源连线'))
    if (result.changeIds.length) handoff(courseId, '学习者停用了一条知识来源连线。')
    return result
  })
  endpoint('link', course.extend({ nodeId: idOf('node'), chunks: z.array(idOf('chunk')).min(1).max(30) }), ({ courseId, nodeId, chunks }) => {
    const result = knowledge.link(chunks.map(id => ({ nodeId, target: { kind: 'chunk', id }, relation: 'explains' })), user('学习者添加知识依据'), courseId)
    if (result?.changeIds.length) handoff(courseId, '学习者给知识节点添加了资料依据。')
    return result
  })
  endpoint('revert', course.extend({ operationId: idOf('operation') }), ({ courseId, operationId }) => {
    knowledge.operationDetails(courseId, operationId)
    const result = knowledge.revert(operationId, user('学习者撤销知识结构操作'))
    for (const id of result.courseIds ?? [courseId]) handoff(id, result.merge ? `学习者撤销了一次知识节点合并，两个节点恢复为各自的身份，原作答证据保留。` : '学习者撤销了一组知识结构修改，原作答证据保留。')
    return result
  })

  endpoint('mergeSuggestions', z.object({ courseId: idOf('course').optional() }), ({ courseId }) => knowledge.mergeSuggestions(courseId))
  const pair = z.object({ keepId: idOf('node'), mergeId: idOf('node') })
  endpoint('mergePlan', pair, ({ keepId, mergeId }) => knowledge.mergePlan(keepId, mergeId))
  endpoint('merge', pair.extend({ keepVersion: version, mergeVersion: version }), input => {
    // Two nodes of one name are told apart by their course.
    const plan = knowledge.mergePlan(input.keepId, input.mergeId), same = plan.keep.title === plan.merge.title
    const keep = same ? `${plan.keep.title}（${plan.keep.courseTitles[0] ?? '未归课程'}）` : plan.keep.title
    const merged = same ? `${plan.merge.title}（${plan.merge.courseTitles[0] ?? '未归课程'}）` : plan.merge.title
    const result = knowledge.merge(input, user(`学习者确认「${merged}」和「${keep}」是同一项，合并为「${keep}」`))
    for (const id of result.courseIds ?? [result.courseId]) handoff(id, `学习者确认「${merged}」和「${keep}」是同一项知识，已合并为「${keep}」；原作答记录保留，按课程分别计算掌握状态。`)
    return result
  })
  endpoint('keepSeparate', z.object({ aId: idOf('node'), aVersion: version, bId: idOf('node'), bVersion: version }), input => {
    knowledge.keepSeparate(input)
    return { ok: true }
  })
  endpoint('extractions', course.extend({ sourceId: idOf('source').optional() }), ({ courseId, sourceId }) => knowledge.extractions(courseId, sourceId))
  // Starting is not handed back: the job's own result is, when it ends.
  endpoint('extract', course.extend({ sections: z.array(z.string().trim().min(1).max(200)).min(1).max(10), sourceId: idOf('source').optional() }),
    ({ courseId, sections, sourceId }) => knowledge.extract(courseId, sections, 'learner', sourceId))
  endpoint('cancelExtraction', course.extend({ id: idOf('extraction') }), ({ courseId, id }) => {
    const job = knowledge.sections.get(id)
    if (!job || job.courseId !== courseId) throw new Error('本课没有这个抽取任务')
    return knowledge.cancelExtraction(id)
  })

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const { nodes, edges } = knowledge.graph(request.courseId)
    const lines = [nodes.length
      ? `${nodes.length} 个节点、${edges.length} 条关系（草案或待复核 ${edges.filter(edge => !edge.usable).length} 条）：\n${nodes.slice(0, 40).map(node => `- ${node.id} ${node.title}`).join('\n')}${nodes.length > 40 ? '\n其余节点用 find_knowledge_nodes 查询。' : ''}`
      : '还没有知识节点。']
    const jobs = (() => { try { return knowledge.extractions(request.courseId).sections.flatMap(section => section.job && ['queued', 'running', 'failed'].includes(section.job.status) ? [`${section.heading}：${section.job.status === 'failed' ? `失败（${section.job.message}）` : '抽取中'}`] : []) } catch { return [] } })()
    if (jobs.length) lines.push(`按小节抽取：${jobs.slice(0, 8).join('；')}`)
    const merges = knowledge.mergeSuggestions(request.courseId).length
    if (merges) lines.push(`有 ${merges} 组节点可能和其他课程的是同一项，等学习者在知识模型页比较后决定。`)
    return [...sections, { unit: 'knowledge', title: '本课知识节点', text: lines.join('\n') }]
  })

  ctx.on('learning/describe-selection', async (selection, next) => {
    const lines = await next()
    const picked = selection.selected
    if (picked?.kind === 'node' && picked.id) {
      const node = knowledge.node(picked.id)
      if (node) {
        const related = selection.courseId
          ? knowledge.graph(selection.courseId).edges
            .filter(edge => edge.from === node.id || edge.to === node.id)
            .map(edge => `${knowledge.node(edge.from)?.title} —${EDGE_LABEL[edge.type]}→ ${knowledge.node(edge.to)?.title}`)
          : []
        lines.push(`选中的知识节点：${node.title}（${node.id}）。${node.description}${related.length ? `\n关系：${related.join('；')}` : ''}`)
      }
    }
    return lines
  })
}
