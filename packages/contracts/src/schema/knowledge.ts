// Knowledge model, global across courses (contracts §4.4). Owner: knowledge.
import { z } from 'zod'
import { idOf, instant } from './common.ts'

/** knowledge / skill / integrated ability / whole task (docs/knowledge/design.md). */
export const NodeKind = z.enum(['knowledge', 'skill', 'integrated', 'task'])
export type NodeKind = z.infer<typeof NodeKind>

export const KnowledgeNode = z.object({
  id: idOf('node'),
  title: z.string().min(1),
  kind: NodeKind,
  description: z.string().default(''),
  aliases: z.array(z.string()).default([]),
  domain: z.string().default(''),
  conditions: z.string().default(''),
  status: z.enum(['active', 'inactive']).default('active'),
  version: z.number().int().positive().default(1),
  legacy: z.boolean().default(false),
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

export const RelationScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }),
  z.object({ kind: z.literal('course'), courseId: idOf('course') }),
  z.object({ kind: z.literal('task'), courseId: idOf('course'), taskId: idOf('task') }),
])
export type RelationScope = z.infer<typeof RelationScope>

export const RelationStatus = z.enum(['draft', 'valid', 'disputed', 'legacy', 'inactive'])
export type RelationStatus = z.infer<typeof RelationStatus>

/** `from` → `to`: "from is part of to", "from requires to", "from is recommended before to". */
export const KnowledgeEdge = z.object({
  id: idOf('edge'),
  from: idOf('node'),
  to: idOf('node'),
  type: EdgeType,
  rationale: z.string().default(''),
  /** Chunks backing this edge. */
  sources: z.array(idOf('chunk')).default([]),
  scope: RelationScope.default({ kind: 'global' }),
  conditions: z.string().default(''),
  status: RelationStatus.default('draft'),
  version: z.number().int().positive().default(1),
})
export type KnowledgeEdge = z.infer<typeof KnowledgeEdge>

/** How a node sits in one course. */
export const CourseNode = z.object({
  courseId: idOf('course'),
  nodeId: idOf('node'),
  role: z.enum(['core', 'related']),
  /** Only when the goal has an exam profile. */
  exam: z.enum(['in-scope', 'out-of-scope']).optional(),
  status: z.enum(['active', 'inactive']).default('active'),
  version: z.number().int().positive().default(1),
  order: z.number().int().nonnegative().default(0),
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
  status: z.enum(['active', 'inactive']).default('active'),
  version: z.number().int().positive().default(1),
})
export type NodeLink = z.infer<typeof NodeLink>

/** Mutation inputs stay separate from stored revisions. */
export const NewKnowledgeNode = z.object({
  title: z.string().trim().min(1).max(200),
  kind: NodeKind,
  description: z.string().max(8000).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
  domain: z.string().max(200).optional(),
  conditions: z.string().max(2000).optional(),
  reuseId: idOf('node').optional(),
  sources: z.array(idOf('chunk')).max(30).optional(),
})

export const NewKnowledgeEdge = z.object({
  from: z.string().trim().min(1), to: z.string().trim().min(1), type: EdgeType,
  rationale: z.string().max(4000).optional(),
  sources: z.array(idOf('chunk')).max(30).optional(),
  scope: RelationScope.optional(),
  conditions: z.string().max(2000).optional(),
  status: z.enum(['draft', 'valid', 'disputed']).optional(),
})

export const KnowledgeAdd = z.object({
  requestId: z.string().trim().min(1).max(100).optional(),
  nodes: z.array(NewKnowledgeNode).max(50),
  edges: z.array(NewKnowledgeEdge).max(100).optional(),
})
export type KnowledgeAdd = z.infer<typeof KnowledgeAdd>

export const KnowledgeNodePatch = NewKnowledgeNode.omit({ kind: true, reuseId: true, sources: true }).partial().extend({
  status: z.enum(['active', 'inactive']).optional(),
})
export type KnowledgeNodePatch = z.infer<typeof KnowledgeNodePatch>

export const KnowledgeEdgePatch = NewKnowledgeEdge.omit({ from: true, to: true, type: true }).partial().extend({
  status: RelationStatus.exclude(['legacy']).optional(),
})
export type KnowledgeEdgePatch = z.infer<typeof KnowledgeEdgePatch>

export const KnowledgeMembershipPatch = z.object({
  role: z.enum(['core', 'related']).optional(),
  exam: z.enum(['in-scope', 'out-of-scope']).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
})
export type KnowledgeMembershipPatch = z.infer<typeof KnowledgeMembershipPatch>
