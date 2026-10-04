// Knowledge tables: global nodes and edges, course membership, source-layer links (contracts §4.4).
import type { DatabaseSync } from 'node:sqlite'
import {
  KnowledgeEdge,
  KnowledgeNode,
  LearningApiError,
  NodeLink,
  newId,
  type ChangeMeta,
  type CourseGraph,
  type LearnCore,
  type Migration,
  type NewEdge,
  type NewNode,
} from '@learning-agent/contracts'

export const knowledgeMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE knowledge_nodes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX knowledge_nodes_title ON knowledge_nodes (title);
      CREATE TABLE knowledge_edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (from_id, to_id, type)
      );
      CREATE TABLE knowledge_course_nodes (
        course_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        role TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (course_id, node_id)
      );
      CREATE TABLE knowledge_links (
        node_id TEXT NOT NULL,
        target_key TEXT NOT NULL,
        relation TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (node_id, target_key, relation)
      );
      CREATE INDEX knowledge_links_target ON knowledge_links (target_key);
    `,
  },
]

type Core = Pick<LearnCore, 'db' | 'changes'>

function linkKey(link: NodeLink): string {
  const target = link.target
  return target.kind === 'block' ? `block:${target.courseId}:${target.id}` : `${target.kind}:${target.id}`
}

export class KnowledgeStore {
  constructor(private readonly core: Core) {}

  private get sqlite(): DatabaseSync {
    return this.core.db.sqlite
  }

  node(nodeId: string): KnowledgeNode | undefined {
    const row = this.sqlite.prepare('SELECT data FROM knowledge_nodes WHERE id = ?').get(nodeId) as { data: string } | undefined
    return row ? KnowledgeNode.parse(JSON.parse(row.data)) : undefined
  }

  graph(courseId: string): CourseGraph {
    const rows = this.sqlite.prepare(`SELECT n.data, c.role FROM knowledge_course_nodes c JOIN knowledge_nodes n ON n.id = c.node_id
      WHERE c.course_id = ? ORDER BY c.seq`).all(courseId) as { data: string; role: 'core' | 'related' }[]
    const nodes = rows.map(row => ({ ...KnowledgeNode.parse(JSON.parse(row.data)), role: row.role }))
    const ids = new Set<string>(nodes.map(node => node.id))
    const edges = (this.sqlite.prepare('SELECT data FROM knowledge_edges').all() as { data: string }[])
      .map(row => KnowledgeEdge.parse(JSON.parse(row.data)))
      .filter(edge => ids.has(edge.from) && ids.has(edge.to))
    return { nodes, edges }
  }

  /** A course node by id, exact title, or alias. */
  resolve(courseId: string, ref: string): KnowledgeNode | undefined {
    const wanted = ref.trim()
    const nodes = this.graph(courseId).nodes
    return nodes.find(node => node.id === wanted)
      ?? nodes.find(node => node.title === wanted)
      ?? nodes.find(node => node.aliases.includes(wanted))
  }

  /** Global lookup by title, so courses share nodes (PLAN §3.4). */
  private byTitle(title: string): KnowledgeNode | undefined {
    const row = this.sqlite.prepare('SELECT data FROM knowledge_nodes WHERE title = ? LIMIT 1').get(title.trim()) as { data: string } | undefined
    return row ? KnowledgeNode.parse(JSON.parse(row.data)) : undefined
  }

  add(courseId: string, input: { readonly nodes: readonly NewNode[]; readonly edges?: readonly NewEdge[] }, meta: ChangeMeta): CourseGraph {
    return this.core.db.transaction(() => {
      let seq = (this.sqlite.prepare('SELECT coalesce(max(seq), 0) AS n FROM knowledge_course_nodes WHERE course_id = ?').get(courseId) as { n: number }).n
      for (const draft of input.nodes) {
        let node = this.resolve(courseId, draft.title) ?? this.byTitle(draft.title)
        if (!node) {
          const id = newId('node')
          const change = this.core.changes.record({
            actor: meta.actor,
            target: { kind: 'node', id },
            size: 'minor',
            before: null,
            after: JSON.stringify(draft),
            reason: meta.reason,
          })
          node = KnowledgeNode.parse({
            id,
            title: draft.title.trim(),
            kind: draft.kind,
            description: draft.description ?? '',
            aliases: draft.aliases ?? [],
            createdBy: change.id,
            createdAt: change.at,
          })
          this.sqlite.prepare('INSERT INTO knowledge_nodes (id, title, data) VALUES (?, ?, ?)').run(node.id, node.title, JSON.stringify(node))
        }
        const exists = this.sqlite.prepare('SELECT 1 FROM knowledge_course_nodes WHERE course_id = ? AND node_id = ?').get(courseId, node.id)
        if (!exists) {
          seq += 1
          this.sqlite.prepare('INSERT INTO knowledge_course_nodes (course_id, node_id, role, seq) VALUES (?, ?, ?, ?)').run(courseId, node.id, 'core', seq)
        }
      }
      for (const draft of input.edges ?? []) {
        const from = this.resolve(courseId, draft.from)
        const to = this.resolve(courseId, draft.to)
        if (!from || !to) {
          throw new LearningApiError('learning/knowledge/unknown-node', `关系的端点不在本课知识图里：${!from ? draft.from : draft.to}`, { edge: draft })
        }
        if (from.id === to.id) continue
        const edge = KnowledgeEdge.parse({ id: newId('edge'), from: from.id, to: to.id, type: draft.type, rationale: draft.rationale ?? '' })
        const inserted = this.sqlite.prepare('INSERT OR IGNORE INTO knowledge_edges (id, from_id, to_id, type, data) VALUES (?, ?, ?, ?, ?)')
          .run(edge.id, edge.from, edge.to, edge.type, JSON.stringify(edge))
        if (inserted.changes) {
          this.core.changes.record({ actor: meta.actor, target: { kind: 'edge', id: edge.id }, size: 'minor', before: null, after: JSON.stringify(edge), reason: meta.reason })
        }
      }
      return this.graph(courseId)
    })
  }

  link(links: readonly NodeLink[]): void {
    this.core.db.transaction(() => {
      const insert = this.sqlite.prepare('INSERT OR IGNORE INTO knowledge_links (node_id, target_key, relation, data) VALUES (?, ?, ?, ?)')
      for (const link of links) {
        const parsed = NodeLink.parse(link)
        insert.run(parsed.nodeId, linkKey(parsed), parsed.relation, JSON.stringify(parsed))
      }
    })
  }

  links(nodeId: string): NodeLink[] {
    return (this.sqlite.prepare('SELECT data FROM knowledge_links WHERE node_id = ?').all(nodeId) as { data: string }[])
      .map(row => NodeLink.parse(JSON.parse(row.data)))
  }
}
