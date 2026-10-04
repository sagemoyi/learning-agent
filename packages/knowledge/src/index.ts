// knowledge unit, host half. Provides `ctx.learnKnowledge` (contracts §5.1): global nodes and typed
// edges, each course's part of the graph, source-layer links. Skeleton: the teacher adds nodes
// through a tool; merging, the global view and graph layout come when the unit is built out.
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ChangeMeta, LearnKnowledge, NewEdge, NewNode, NodeLink } from '@learning-agent/contracts'
import { z } from 'zod'
import { KnowledgeStore, knowledgeMigrations } from './store.ts'

export const name = 'learning-knowledge'
export const inject = ['learnCore']

export const EDGE_LABEL = { 'part-of': '组成', requires: '先修', 'recommended-before': '建议先学', related: '相关' } as const

class LearnKnowledgeService extends Service implements LearnKnowledge {
  readonly store: KnowledgeStore

  constructor(ctx: Context) {
    super(ctx, 'learnKnowledge')
    ctx.learnCore.db.migrate('knowledge', knowledgeMigrations)
    this.store = new KnowledgeStore(ctx.learnCore)
  }

  async add(courseId: string, input: { readonly nodes: readonly NewNode[]; readonly edges?: readonly NewEdge[] }, meta: ChangeMeta) {
    return this.store.add(courseId, input, meta)
  }
  graph = (courseId: string) => this.store.graph(courseId)
  node = (nodeId: string) => this.store.node(nodeId)
  resolve = (courseId: string, ref: string) => this.store.resolve(courseId, ref)
  link = (links: readonly NodeLink[]) => this.store.link(links)
  links = (nodeId: string) => this.store.links(nodeId)
}

export function apply(ctx: Context): void {
  const knowledge = new LearnKnowledgeService(ctx)

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'knowledge',
    method: 'graph',
    input: z.object({ courseId: z.string() }),
    handle: ({ courseId }) => knowledge.graph(courseId),
  }), 'knowledge: graph')

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const { nodes, edges } = knowledge.graph(request.courseId)
    const text = nodes.length
      ? `${nodes.length} 个节点、${edges.length} 条关系：\n${nodes.map(node => `- ${node.id} ${node.title}`).join('\n')}`
      : '还没有知识节点。'
    return [...sections, { unit: 'knowledge', title: '本课知识节点', text }]
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
