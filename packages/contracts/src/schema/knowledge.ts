// Knowledge model, global across courses (contracts §4.4). Owner: knowledge.
import { z } from 'zod'
import { idOf, instant } from './common.ts'

/** knowledge / skill / integrated ability / whole task (PLAN §3.2). */
export const NodeKind = z.enum(['knowledge', 'skill', 'integrated', 'task'])
export type NodeKind = z.infer<typeof NodeKind>

export const KnowledgeNode = z.object({
  id: idOf('node'),
  title: z.string().min(1),
  kind: NodeKind,
  description: z.string().default(''),
  aliases: z.array(z.string()).default([]),
  /** Set when a confirmed merge folded this node into another (CASE `replacedBy`). */
  replacedBy: idOf('node').optional(),
  /** The change that created the node. */
  createdBy: idOf('change').optional(),
  createdAt: instant,
})
export type KnowledgeNode = z.infer<typeof KnowledgeNode>

/**
 * Edge types, aligned with 1EdTech CASE where one exists:
 * part-of = isPartOf, recommended-before = precedes, related = isRelatedTo.
 * `requires` (hard prerequisite) is our extension and the only edge that constrains scheduling.
 */
export const EdgeType = z.enum(['part-of', 'requires', 'recommended-before', 'related'])
export type EdgeType = z.infer<typeof EdgeType>

/** `from` → `to`: "from is part of to", "from requires to", "from is recommended before to". */
export const KnowledgeEdge = z.object({
  id: idOf('edge'),
  from: idOf('node'),
  to: idOf('node'),
  type: EdgeType,
  rationale: z.string().default(''),
  /** Chunks backing this edge. */
  sources: z.array(idOf('chunk')).default([]),
})
export type KnowledgeEdge = z.infer<typeof KnowledgeEdge>

/** How a node sits in one course. */
export const CourseNode = z.object({
  courseId: idOf('course'),
  nodeId: idOf('node'),
  role: z.enum(['core', 'related']),
  /** Only when the goal has an exam profile. */
  exam: z.enum(['in-scope', 'out-of-scope']).optional(),
})
export type CourseNode = z.infer<typeof CourseNode>

/** Source layer: material, problems and textbook blocks pointing at nodes. */
export const NodeLinkTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chunk'), id: idOf('chunk') }),
  z.object({ kind: z.literal('problem'), id: idOf('problem') }),
  z.object({ kind: z.literal('block'), courseId: idOf('course'), id: z.string() }),
])

export const NodeLink = z.object({
  nodeId: idOf('node'),
  target: NodeLinkTarget,
  relation: z.enum(['explains', 'example', 'assesses']),
})
export type NodeLink = z.infer<typeof NodeLink>
