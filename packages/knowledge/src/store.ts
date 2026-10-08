// Owns knowledge revisions. Atomic edits record snapshots in core; evidence is never rewritten.
import { createHash } from 'node:crypto'
import {
  CourseNode, KnowledgeAdd, KnowledgeEdge, KnowledgeEdgePatch, KnowledgeMembershipPatch, RelationScope,
  KnowledgeNode, KnowledgeNodePatch, LearningApiError, NodeLink, newId,
  type Change, type ChangeMeta, type ChangeTarget, type CourseGraph, type CitedChunk,
  type KnowledgeDetail, type KnowledgeGlobal, type KnowledgeOperation, type KnowledgeSourceLayer, type LearnCore, type Migration,
  type MergePlan, type MergeSide, type MergeSuggestion, type NewEdge, type NewNode, type Problem, type Source, type Block,
  type CourseSource, type ExamScope, type ExamScopeResult,
  MergeReview,
} from '@learning-agent/contracts'

export const knowledgeMigrations: Migration[] = [
  { version: 1, sql: `
    CREATE TABLE knowledge_nodes (id TEXT PRIMARY KEY, title TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX knowledge_nodes_title ON knowledge_nodes (title);
    CREATE TABLE knowledge_edges (
      id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL,
      UNIQUE (from_id, to_id, type)
    );
    CREATE TABLE knowledge_course_nodes (
      course_id TEXT NOT NULL, node_id TEXT NOT NULL, role TEXT NOT NULL, seq INTEGER NOT NULL,
      PRIMARY KEY (course_id, node_id)
    );
    CREATE TABLE knowledge_links (
      node_id TEXT NOT NULL, target_key TEXT NOT NULL, relation TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (node_id, target_key, relation)
    );
    CREATE INDEX knowledge_links_target ON knowledge_links (target_key);
  ` },
  { version: 2, sql: `
    UPDATE knowledge_nodes SET data = json_set(data, '$.version', 1, '$.status', 'active', '$.legacy', json('true'));
    ALTER TABLE knowledge_edges RENAME TO knowledge_edges_v1;
    CREATE TABLE knowledge_edges (
      id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL,
      scope_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE (from_id, to_id, type, scope_key)
    );
    INSERT INTO knowledge_edges SELECT id, from_id, to_id, type, 'global',
      json_set(data, '$.scope', json('{"kind":"global"}'), '$.status', 'legacy', '$.version', 1)
      FROM knowledge_edges_v1;
    DROP TABLE knowledge_edges_v1;
    CREATE INDEX knowledge_edges_from ON knowledge_edges (from_id);
    CREATE INDEX knowledge_edges_to ON knowledge_edges (to_id);
    CREATE INDEX knowledge_edges_scope ON knowledge_edges (scope_key);
    ALTER TABLE knowledge_course_nodes ADD COLUMN data TEXT;
    UPDATE knowledge_course_nodes SET data = json_object('courseId', course_id, 'nodeId', node_id,
      'role', role, 'order', seq, 'status', 'active', 'version', 1);
    UPDATE knowledge_links SET data = json_set(data, '$.version', 1, '$.status', 'active');
    CREATE TABLE knowledge_operations (
      id TEXT PRIMARY KEY, course_id TEXT NOT NULL, request_id TEXT, request_hash TEXT, data TEXT NOT NULL,
      UNIQUE (course_id, request_id)
    );
    CREATE INDEX knowledge_operations_course ON knowledge_operations (course_id);
  ` },
  { version: 3, sql: `
    CREATE TABLE knowledge_operation_courses (
      course_id TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY (course_id, operation_id)
    );
    INSERT INTO knowledge_operation_courses SELECT course_id, id FROM knowledge_operations;
    CREATE TABLE knowledge_merge_reviews (pair_key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE knowledge_extractions (
      id TEXT PRIMARY KEY, course_id TEXT NOT NULL, source_id TEXT NOT NULL, section TEXT NOT NULL,
      status TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX knowledge_extractions_section ON knowledge_extractions (course_id, source_id, section);
  ` },
  // learner asks for the merge map of every node it recomputes; only merged nodes are indexed.
  { version: 4, sql: `
    CREATE INDEX knowledge_nodes_replaced ON knowledge_nodes (json_extract(data, '$.replacedBy'))
      WHERE json_extract(data, '$.replacedBy') IS NOT NULL;
  ` },
]

type Core = Pick<LearnCore, 'db' | 'changes' | 'courses'>
type Target = { kind: 'node' | 'edge' | 'course-node' | 'node-link'; id: string }
type Value = KnowledgeNode | KnowledgeEdge | CourseNode | NodeLink
type Pending = Map<string, { target: Target; before: string | null; after: string }>

export interface KnowledgeReferences {
  chunk(id: string): CitedChunk | undefined
  source(id: string): Source | undefined
  courseSources(courseId: string): readonly { source: Source; role: CourseSource['role'] }[]
  problem(id: string): Problem | undefined
  blockIds(courseId: string): readonly Block['id'][]
  task(courseId: string, id: string): boolean
}

function stable(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
}
function key(target: Target): string { return `${target.kind}:${target.id}` }
function memberTarget(courseId: string, nodeId: string): Target { return { kind: 'course-node', id: `${courseId}/${nodeId}` } }
function linkKey(link: Pick<NodeLink, 'target'>): string {
  return link.target.kind === 'block' ? `block:${link.target.courseId}:${link.target.id}` : `${link.target.kind}:${link.target.id}`
}
function linkTarget(link: Pick<NodeLink, 'nodeId' | 'target' | 'relation'>): Target {
  return { kind: 'node-link', id: JSON.stringify([link.nodeId, linkKey(link), link.relation]) }
}
function scopeKey(scope: RelationScope): string {
  return scope.kind === 'global' ? 'global' : scope.kind === 'course' ? `course:${scope.courseId}` : `task:${scope.courseId}:${scope.taskId}`
}
/** A label compared for merge suggestions and extraction: case, width, spaces and punctuation ignored. */
export function normalizeLabel(label: string): string {
  return label.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}]/gu, '')
}
/** The node's comparable labels: title, title without a bracketed note such as "（Re）", and aliases. */
export function nodeLabels(node: { readonly title: string; readonly aliases: readonly string[] }): Set<string> {
  return new Set([node.title, node.title.replace(/[（(【[][^）)】\]]*[）)】\]]/g, ''), ...node.aliases].map(normalizeLabel).filter(Boolean))
}
function pairKey(a: string, b: string): string { return a < b ? `${a}|${b}` : `${b}|${a}` }
const MAX_EDGE_SOURCES = 30

export class KnowledgeStore {
  /** Block ids per course, read once per operation (a textbook reindex links many blocks at once). */
  private blockMemo?: Map<string, ReadonlySet<string>>
  constructor(private readonly core: Core, private readonly refs: KnowledgeReferences) {}
  private get sqlite() { return this.core.db.sqlite }
  private blockExists(courseId: string, id: string): boolean {
    let ids = this.blockMemo?.get(courseId)
    if (!ids) {
      ids = new Set(this.refs.blockIds(courseId))
      this.blockMemo?.set(courseId, ids)
    }
    return ids.has(id)
  }
  private course(courseId: string): void {
    if (!this.core.courses.get(courseId)) throw new LearningApiError('learning/knowledge/no-course', '课程不存在')
  }
  node(nodeId: string): KnowledgeNode | undefined {
    const row = this.sqlite.prepare('SELECT data FROM knowledge_nodes WHERE id = ?').get(nodeId) as { data: string } | undefined
    return row ? KnowledgeNode.parse(JSON.parse(row.data)) : undefined
  }
  private edges(): KnowledgeEdge[] {
    return (this.sqlite.prepare('SELECT data FROM knowledge_edges ORDER BY rowid').all() as { data: string }[]).map(row => KnowledgeEdge.parse(JSON.parse(row.data)))
  }
  private membership(courseId: string, nodeId: string): CourseNode | undefined {
    const row = this.sqlite.prepare('SELECT data FROM knowledge_course_nodes WHERE course_id = ? AND node_id = ?').get(courseId, nodeId) as { data: string } | undefined
    return row ? CourseNode.parse(JSON.parse(row.data)) : undefined
  }
  private memberships(nodeId: string): CourseNode[] {
    return (this.sqlite.prepare('SELECT data FROM knowledge_course_nodes WHERE node_id = ? ORDER BY seq').all(nodeId) as { data: string }[]).map(row => CourseNode.parse(JSON.parse(row.data)))
  }
  /** Active nodes of a course with their membership, in course order. */
  private courseNodes(courseId: string): { node: KnowledgeNode; membership: CourseNode }[] {
    const rows = this.sqlite.prepare(`SELECT n.data, c.data AS membership FROM knowledge_course_nodes c
      JOIN knowledge_nodes n ON n.id = c.node_id WHERE c.course_id = ?
      AND json_extract(c.data, '$.status') = 'active' AND json_extract(n.data, '$.status') = 'active'
      ORDER BY c.seq, n.id`).all(courseId) as { data: string; membership: string }[]
    return rows.map(row => ({ node: KnowledgeNode.parse(JSON.parse(row.data)), membership: CourseNode.parse(JSON.parse(row.membership)) }))
  }
  graph(courseId: string): CourseGraph {
    this.course(courseId)
    const counts = new Map((this.sqlite.prepare(`SELECT node_id, count(*) AS n FROM knowledge_course_nodes
      WHERE json_extract(data, '$.status') = 'active' AND node_id IN (SELECT node_id FROM knowledge_course_nodes WHERE course_id = ?)
      GROUP BY node_id`).all(courseId) as { node_id: string; n: number }[]).map(row => [row.node_id, row.n]))
    const nodes = this.courseNodes(courseId).map(({ node, membership }) => ({ ...node, role: membership.role, membership, courseCount: counts.get(node.id) ?? 0 }))
    const edges = (this.sqlite.prepare(`SELECT e.data FROM knowledge_edges e
      JOIN knowledge_course_nodes f ON f.node_id = e.from_id AND f.course_id = ?
      JOIN knowledge_course_nodes t ON t.node_id = e.to_id AND t.course_id = ?
      JOIN knowledge_nodes nf ON nf.id = e.from_id JOIN knowledge_nodes nt ON nt.id = e.to_id
      WHERE json_extract(f.data, '$.status') = 'active' AND json_extract(t.data, '$.status') = 'active'
      AND json_extract(nf.data, '$.status') = 'active' AND json_extract(nt.data, '$.status') = 'active'
      AND (e.scope_key = 'global' OR json_extract(e.data, '$.scope.courseId') = ?)
      AND json_extract(e.data, '$.status') <> 'inactive' ORDER BY e.rowid`).all(courseId, courseId, courseId) as { data: string }[])
      .map(row => {
        const edge = KnowledgeEdge.parse(JSON.parse(row.data))
        const issue = edge.status === 'valid' ? this.edgeIssue(edge) : undefined
        return { ...edge, usable: edge.status === 'valid' && !issue, ...(issue ? { issue } : {}) }
      })
    return { nodes, edges }
  }
  candidates(ref: string, courseId?: string): KnowledgeNode[] {
    const wanted = ref.trim().toLocaleLowerCase()
    if (courseId) this.course(courseId)
    const nodes = courseId ? this.courseNodes(courseId).map(entry => entry.node) : (this.sqlite.prepare("SELECT data FROM knowledge_nodes WHERE json_extract(data, '$.status') = 'active' ORDER BY id").all() as { data: string }[]).map(row => KnowledgeNode.parse(JSON.parse(row.data)))
    return nodes.filter(node => [node.id, node.title, ...node.aliases].some(label => label.toLocaleLowerCase().includes(wanted))).slice(0, 50)
  }
  resolve(courseId: string, ref: string): KnowledgeNode | undefined {
    const nodes = this.courseNodes(courseId).map(entry => entry.node)
    const found = this.pick(nodes, ref)
    if (found) return found
    // An old id or name of an identity merged into one of this course's nodes.
    const wanted = ref.trim()
    for (const id of this.replacements().keys()) {
      const former = this.node(id)
      if (!former || (former.id !== wanted && former.title !== wanted && !former.aliases.includes(wanted))) continue
      const current = nodes.find(node => node.id === this.identity(id).current)
      if (current) return current
    }
    return undefined
  }
  private pick(nodes: readonly KnowledgeNode[], ref: string): KnowledgeNode | undefined {
    const wanted = ref.trim()
    const byId = nodes.find(node => node.id === wanted)
    if (byId) return byId
    const matches = nodes.filter(node => node.title === wanted || node.aliases.includes(wanted))
    if (matches.length > 1) throw new LearningApiError('learning/knowledge/ambiguous-node', '同名或别名对应多个知识节点，请用 find_knowledge_nodes 核对领域和条件后指定 ID', { candidates: matches.slice(0, 10).map(node => ({ id: node.id, title: node.title, kind: node.kind, domain: node.domain, conditions: node.conditions.slice(0, 160) })) })
    return matches[0]
  }
  private current(target: Target): Value | undefined {
    if (target.kind === 'node') return this.node(target.id)
    if (target.kind === 'course-node') {
      const [courseId, nodeId] = target.id.split('/')
      return this.membership(courseId!, nodeId!)
    }
    if (target.kind === 'edge') {
      const row = this.sqlite.prepare('SELECT data FROM knowledge_edges WHERE id = ?').get(target.id) as { data: string } | undefined
      return row ? KnowledgeEdge.parse(JSON.parse(row.data)) : undefined
    }
    const [nodeId, targetKey, relation] = JSON.parse(target.id) as string[]
    const row = this.sqlite.prepare('SELECT data FROM knowledge_links WHERE node_id = ? AND target_key = ? AND relation = ?').get(nodeId!, targetKey!, relation!) as { data: string } | undefined
    return row ? NodeLink.parse(JSON.parse(row.data)) : undefined
  }
  private write(target: Target, value: Value): void {
    const data = JSON.stringify(value)
    if (target.kind === 'node') {
      const node = KnowledgeNode.parse(value)
      this.sqlite.prepare('INSERT INTO knowledge_nodes VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, data = excluded.data').run(node.id, node.title, data)
    } else if (target.kind === 'edge') {
      const edge = KnowledgeEdge.parse(value)
      this.sqlite.prepare(`INSERT INTO knowledge_edges VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET from_id = excluded.from_id, to_id = excluded.to_id, scope_key = excluded.scope_key, data = excluded.data`).run(edge.id, edge.from, edge.to, edge.type, scopeKey(edge.scope), data)
    } else if (target.kind === 'course-node') {
      const member = CourseNode.parse(value)
      this.sqlite.prepare(`INSERT INTO knowledge_course_nodes VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(course_id, node_id) DO UPDATE SET role = excluded.role, seq = excluded.seq, data = excluded.data`).run(member.courseId, member.nodeId, member.role, member.order, data)
    } else {
      const link = NodeLink.parse(value)
      this.sqlite.prepare(`INSERT INTO knowledge_links VALUES (?, ?, ?, ?)
        ON CONFLICT(node_id, target_key, relation) DO UPDATE SET data = excluded.data`).run(link.nodeId, linkKey(link), link.relation, data)
    }
  }
  private save(target: Target, input: Value, pending: Pending): void {
    const before = this.current(target)
    if (before && stable(before) === stable(input)) return
    const value = { ...input, version: (before?.version ?? 0) + 1 } as Value
    this.write(target, value)
    const first = pending.get(key(target))
    pending.set(key(target), { target, before: first ? first.before : before ? JSON.stringify(before) : null, after: JSON.stringify(value) })
  }
  private operation(courseId: string, meta: ChangeMeta, run: (pending: Pending) => void, options: {
    readonly request?: { id: string; input: unknown }
    readonly revertOf?: string
    readonly inverse?: Map<string, string>
    /** Other courses the operation touches; it is listed in each one's history. */
    readonly courseIds?: readonly string[]
    readonly merge?: KnowledgeOperation['merge']
  } = {}): KnowledgeOperation & { replayed?: boolean } {
    const { request, revertOf, inverse } = options
    this.course(courseId)
    if (!meta.reason.trim()) throw new LearningApiError('learning/knowledge/missing-reason', '修改知识结构时请说明理由')
    return this.core.db.transaction(() => {
      const hash = request ? createHash('sha256').update(stable(request.input)).digest('hex') : undefined
      if (request) {
        const row = this.sqlite.prepare('SELECT data, request_hash FROM knowledge_operations WHERE course_id = ? AND request_id = ?').get(courseId, request.id) as { data: string; request_hash: string } | undefined
        if (row) {
          if (row.request_hash !== hash) throw new LearningApiError('learning/knowledge/request-conflict', '这个操作标识已用于不同内容，请为新的修改使用新的标识')
          return { ...JSON.parse(row.data) as KnowledgeOperation, replayed: true }
        }
      }
      const pending: Pending = new Map()
      const outer = this.blockMemo
      this.blockMemo = outer ?? new Map()
      try { run(pending) } finally { this.blockMemo = outer }
      const id = newId('operation')
      // Nothing changed (a repeated textbook index, a reuse already in the course): leave no empty
      // group in the history, which would push real ones out of its window.
      if (!pending.size) return { id, courseId, at: new Date().toISOString(), actor: meta.actor, reason: meta.reason, changeIds: [] }
      // Only node and relation records take part in cycles; memberships and source links do not.
      if ([...pending.values()].some(change => change.target.kind === 'edge' || change.target.kind === 'node')) this.checkCycles()
      const changes = [...pending.values()].map(change => this.core.changes.record({
        ...change, target: change.target as ChangeTarget, actor: meta.actor, reason: meta.reason, size: meta.size ?? 'minor', operationId: id,
        courseId: courseId as Change['courseId'],
        ...(meta.proposalId ? { proposalId: meta.proposalId as Change['proposalId'] } : {}),
        ...(inverse?.get(key(change.target)) ? { revertOf: inverse.get(key(change.target)) as Change['revertOf'] } : {}),
      }))
      const courses = [...new Set([courseId, ...options.courseIds ?? []])]
      const op: KnowledgeOperation = {
        id, courseId, at: new Date().toISOString(), actor: meta.actor, reason: meta.reason, changeIds: changes.map(c => c.id),
        ...(revertOf ? { revertOf } : {}), ...(courses.length > 1 ? { courseIds: courses } : {}), ...(options.merge ? { merge: options.merge } : {}),
      }
      this.sqlite.prepare('INSERT INTO knowledge_operations VALUES (?, ?, ?, ?, ?)').run(id, courseId, request?.id ?? null, hash ?? null, JSON.stringify(op))
      for (const course of courses) this.sqlite.prepare('INSERT INTO knowledge_operation_courses VALUES (?, ?)').run(course, id)
      return op
    })
  }
  private expect(target: Target, version: number): Value {
    const current = this.current(target)
    if (!current) throw new LearningApiError('learning/knowledge/not-found', '知识结构记录不存在')
    if (current.version !== version) throw new LearningApiError('learning/knowledge/version-conflict', '内容已被其他操作修改，请刷新后再提交', { expected: version, actual: current.version })
    return current
  }
  private checkChunk(id: string, courseId?: string): void {
    const chunk = this.refs.chunk(id)
    const source = chunk && this.refs.source(chunk.sourceId)
    if (!chunk || !source || source.status !== 'ready' || source.authority === 'clue') throw new LearningApiError('learning/knowledge/invalid-source', '依据片段不存在或资料尚不可引用，请先把资料加入资料库并完成解析')
    if (courseId && !this.refs.courseSources(courseId).some(item => item.source.id === source.id)) throw new LearningApiError('learning/knowledge/source-not-in-course', '依据资料尚未关联本课，请先把它加入本课资料库')
  }
  private checkScope(scope: RelationScope, courseId: string): void {
    if (scope.kind === 'global') return
    if (scope.courseId !== courseId) throw new LearningApiError('learning/knowledge/wrong-scope', '只能在所属课程修改这条限定关系')
    if (scope.kind === 'task' && !this.refs.task(courseId, scope.taskId)) throw new LearningApiError('learning/knowledge/unknown-task', '限定的学习任务不属于本课或不存在')
  }
  private checkEdge(edge: KnowledgeEdge, courseId: string): void {
    this.checkScope(edge.scope, courseId)
    if (edge.from === edge.to) throw new LearningApiError('learning/knowledge/self-edge', '节点不能与自身建立关系')
    for (const id of [edge.from, edge.to]) {
      if (this.node(id)?.status !== 'active' || this.membership(courseId, id)?.status !== 'active') throw new LearningApiError('learning/knowledge/unknown-node', '关系的端点不在本课活动知识节点中')
    }
    for (const id of edge.sources) this.checkChunk(id, edge.scope.kind === 'global' ? undefined : courseId)
    if (edge.status === 'valid' && (!edge.rationale.trim() || !edge.sources.length)) throw new LearningApiError('learning/knowledge/missing-basis', '有效关系需要理由和可引用的依据；依据不足时先保存为草案')
  }
  private edgeIssue(edge: KnowledgeEdge): string | undefined {
    if (!edge.rationale.trim() || !edge.sources.length) return '缺少理由或依据，需复核'
    try {
      for (const id of edge.sources) this.checkChunk(id, edge.scope.kind === 'global' ? undefined : edge.scope.courseId)
      if (edge.scope.kind === 'task' && !this.refs.task(edge.scope.courseId, edge.scope.taskId)) return '限定任务不可用'
    } catch (error) { return (error as Error).message }
    return undefined
  }
  /** Relations of the same type and scope between the two nodes (either direction for `related`). */
  private sameEdges(type: KnowledgeEdge['type'], scope: RelationScope, fromId: string, toId: string): KnowledgeEdge[] {
    const [backFrom, backTo] = type === 'related' ? [toId, fromId] : [fromId, toId]
    return (this.sqlite.prepare(`SELECT data FROM knowledge_edges WHERE type = ? AND scope_key = ?
      AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))`).all(type, scopeKey(scope), fromId, toId, backFrom, backTo) as { data: string }[])
      .map(row => KnowledgeEdge.parse(JSON.parse(row.data)))
  }
  private duplicateEdge(existing: readonly KnowledgeEdge[]): LearningApiError {
    return new LearningApiError('learning/knowledge/duplicate-edge', existing.some(edge => edge.status === 'inactive')
      ? '这个范围内已有同类关系，但已停用；需要时修订它的状态恢复使用，不要重复添加'
      : '这个范围内已有同类关系，请打开它补充依据或修订；不要重复添加', { edges: existing })
  }
  add(courseId: string, input: { readonly requestId?: string; readonly nodes: readonly NewNode[]; readonly edges?: readonly NewEdge[] }, meta: ChangeMeta): CourseGraph {
    const parsed = KnowledgeAdd.parse(input)
    const op = this.operation(courseId, meta, pending => {
      let seq = (this.sqlite.prepare('SELECT coalesce(max(seq), 0) AS n FROM knowledge_course_nodes WHERE course_id = ?').get(courseId) as { n: number }).n
      const known = this.courseNodes(courseId).map(entry => entry.node)
      for (const draft of parsed.nodes) {
        let node = draft.reuseId ? this.node(draft.reuseId) : undefined
        if (draft.reuseId) {
          if (!node || node.status !== 'active' || node.replacedBy) throw new LearningApiError('learning/knowledge/not-found', '选择的知识身份不可用')
          if (node.title !== draft.title || node.kind !== draft.kind) throw new LearningApiError('learning/knowledge/reuse-mismatch', '复用只关联已有身份，不会修改其名称或类型；请核对选择的节点')
          if (meta.actor === 'teacher' && this.membership(courseId, node.id)?.status !== 'active') throw new LearningApiError('learning/knowledge/reuse-needs-confirmation', '跨课复用需要学习者在知识模型页选择已有身份；同名不能直接共享')
        } else {
          // The teacher keeps names unique within a course: a repeated name makes title references
          // ambiguous and stops textbook paragraphs from linking either node. The learner may still
          // create one deliberately on the page.
          const clash = meta.actor === 'teacher' && known.find(other => other.title === draft.title || other.aliases.includes(draft.title))
          if (clash) throw new LearningApiError('learning/knowledge/same-name', `本课已有同名知识节点「${clash.title}」（${clash.id}）；是同一项就用 reuseId 复用，含义不同请改用能区分的名称`, { candidates: [{ id: clash.id, title: clash.title, kind: clash.kind, domain: clash.domain }] })
          node = KnowledgeNode.parse({ ...draft, id: newId('node'), createdAt: new Date().toISOString() })
          this.save({ kind: 'node', id: node.id }, node, pending)
          known.push(node)
        }
        const member = this.membership(courseId, node!.id)
        if (!member || member.status === 'inactive') this.save(memberTarget(courseId, node!.id), CourseNode.parse({ ...member, courseId, nodeId: node!.id, role: member?.role ?? 'core', order: member?.order ?? ++seq, status: 'active' }), pending)
        for (const chunkId of draft.sources ?? []) this.registerLink({ nodeId: node!.id, target: { kind: 'chunk', id: chunkId }, relation: 'explains' }, courseId, pending)
      }
      const nodes = parsed.edges?.length ? this.courseNodes(courseId).map(entry => entry.node) : []
      for (const draft of parsed.edges ?? []) {
        const from = this.pick(nodes, draft.from), to = this.pick(nodes, draft.to)
        if (!from || !to) throw new LearningApiError('learning/knowledge/unknown-node', '关系的端点不存在，请先添加节点或使用本课已有 ID')
        const [fromId, toId] = draft.type === 'related' && from.id > to.id ? [to.id, from.id] : [from.id, to.id]
        const scope = draft.scope ?? RelationScope.parse({ kind: 'course', courseId })
        const existing = this.sameEdges(draft.type, scope, fromId, toId)
        if (existing.length) throw this.duplicateEdge(existing)
        const edge = KnowledgeEdge.parse({ ...draft, id: newId('edge'), from: fromId, to: toId, scope })
        this.checkEdge(edge, courseId)
        this.save({ kind: 'edge', id: edge.id }, edge, pending)
      }
    }, parsed.requestId ? { request: { id: parsed.requestId, input: parsed } } : {})
    return { ...this.graph(courseId), ...(op.changeIds.length ? { operationId: op.id } : {}), replayed: op.replayed }
  }
  private requireMember(courseId: string, id: string): void {
    if (!this.membership(courseId, id)) throw new LearningApiError('learning/knowledge/not-in-course', '这个节点不属于本课')
  }
  editNode(courseId: string, id: string, version: number, input: KnowledgeNodePatch, meta: ChangeMeta): KnowledgeOperation {
    const patch = KnowledgeNodePatch.strict().parse(input)
    return this.operation(courseId, meta, pending => {
      this.requireMember(courseId, id)
      const node = this.expect({ kind: 'node', id }, version) as KnowledgeNode
      if (patch.status === 'inactive' && this.memberships(id).some(m => m.courseId !== courseId && m.status === 'active')) throw new LearningApiError('learning/knowledge/shared-node', '其他课程正在使用这个身份；可先将它移出本课，不要全局停用')
      this.save({ kind: 'node', id }, KnowledgeNode.parse({ ...node, ...patch }), pending)
    })
  }
  editEdge(courseId: string, id: string, version: number, input: KnowledgeEdgePatch, meta: ChangeMeta): KnowledgeOperation {
    const patch = KnowledgeEdgePatch.strict().parse(input)
    return this.operation(courseId, meta, pending => {
      const before = this.expect({ kind: 'edge', id }, version) as KnowledgeEdge
      this.checkScope(before.scope, courseId)
      this.requireMember(courseId, before.from); this.requireMember(courseId, before.to)
      const edge = KnowledgeEdge.parse({ ...before, ...patch })
      if (scopeKey(edge.scope) !== scopeKey(before.scope)) {
        const existing = this.sameEdges(edge.type, edge.scope, edge.from, edge.to).filter(other => other.id !== id)
        if (existing.length) throw this.duplicateEdge(existing)
      }
      if (edge.status !== 'inactive') this.checkEdge(edge, courseId)
      else this.checkScope(edge.scope, courseId)
      this.save({ kind: 'edge', id }, edge, pending)
    })
  }
  setMembership(courseId: string, nodeId: string, version: number, input: KnowledgeMembershipPatch, meta: ChangeMeta): KnowledgeOperation {
    const patch = KnowledgeMembershipPatch.strict().parse(input)
    return this.operation(courseId, meta, pending => {
      const target = memberTarget(courseId, nodeId), before = this.expect(target, version) as CourseNode
      if (patch.status === 'active' && this.node(nodeId)?.status !== 'active') throw new LearningApiError('learning/knowledge/inactive-node', '节点已全局停用，须先恢复身份')
      this.save(target, CourseNode.parse({ ...before, ...patch, exam: patch.exam === null ? undefined : patch.exam ?? before.exam }), pending)
    })
  }
  /**
   * Exam scope by skeleton-textbook sections, then node by node, as one operation. A section pass
   * keeps `beyond` (a judgement, not a location) and leaves nodes without skeleton sources alone.
   */
  markExamScope(courseId: string, input: { readonly sections?: readonly string[]; readonly nodes?: readonly { readonly node: string; readonly exam: ExamScope | null }[] }, meta: ChangeMeta): ExamScopeResult {
    this.course(courseId)
    const sections = (input.sections ?? []).map(section => section.trim()).filter(Boolean)
    const inSection = (path: readonly string[]) => path.some(part => sections.some(s => part === s || part.startsWith(`${s} `) || part.startsWith(`${s}.`)))
    const skeleton = new Set(this.refs.courseSources(courseId).filter(entry => entry.role === 'skeleton').map(entry => entry.source.id as string))
    const members = this.courseNodes(courseId)
    const wanted = new Map<string, ExamScope | undefined>()
    if (sections.length) {
      for (const { node, membership } of members) {
        if (membership.exam === 'beyond') continue
        const chunks = this.links(node.id).flatMap(link => (link.target.kind === 'chunk' ? [this.refs.chunk(link.target.id)] : [])).filter(chunk => chunk && skeleton.has(chunk.sourceId))
        if (chunks.length) wanted.set(node.id, chunks.some(chunk => inSection(chunk!.section)) ? 'in-scope' : 'out-of-scope')
      }
    }
    const unknown: string[] = []
    for (const entry of input.nodes ?? []) {
      const node = this.resolve(courseId, entry.node)
      if (!node) unknown.push(entry.node)
      else wanted.set(node.id, entry.exam ?? undefined)
    }
    if (unknown.length) throw new LearningApiError('learning/knowledge/unknown-node', `本课没有这些节点：${unknown.join('、')}`)
    const op = this.operation(courseId, meta, pending => {
      for (const [nodeId, exam] of wanted) {
        const before = this.membership(courseId, nodeId)!
        if (before.exam === exam) continue
        const { exam: _old, ...rest } = before
        this.save(memberTarget(courseId, nodeId), CourseNode.parse({ ...rest, ...(exam ? { exam } : {}) }), pending)
      }
    })
    const after = this.courseNodes(courseId)
    const counts = { 'in-scope': 0, beyond: 0, 'out-of-scope': 0, untagged: 0 }
    for (const { membership } of after) counts[membership.exam ?? 'untagged'] += 1
    return {
      ...(op.changeIds.length ? { operationId: op.id } : {}),
      counts,
      untagged: after.filter(item => !item.membership.exam).map(item => ({ id: item.node.id, title: item.node.title })),
    }
  }
  private registerLink(input: Pick<NodeLink, 'nodeId' | 'target' | 'relation'>, courseId: string, pending: Pending, restore = false): void {
    this.requireMember(courseId, input.nodeId)
    if (this.node(input.nodeId)?.status !== 'active') throw new LearningApiError('learning/knowledge/inactive-node', '不能给停用的节点登记新出处')
    const parsed = NodeLink.parse({ nodeId: input.nodeId, target: input.target, relation: input.relation }), target = parsed.target
    if (target.kind === 'chunk') this.checkChunk(target.id)
    if (target.kind === 'problem') {
      const problem = this.refs.problem(target.id)
      if (!problem) throw new LearningApiError('learning/knowledge/invalid-link', '题目来源不存在')
      if (parsed.relation === 'assesses' && !problem.nodeIds.includes(parsed.nodeId)) throw new LearningApiError('learning/knowledge/invalid-link', '题库没有将这道题登记为考查该节点')
    }
    if (target.kind === 'block' && (target.courseId !== courseId || !this.blockExists(target.courseId, target.id))) throw new LearningApiError('learning/knowledge/invalid-link', '教材块不属于本课或不存在')
    const targetRef = linkTarget(parsed), before = this.current(targetRef) as NodeLink | undefined
    if (before?.status === 'inactive' && !restore) return
    this.save(targetRef, NodeLink.parse({ ...parsed, version: before?.version ?? 1 }), pending)
  }
  link(links: readonly (Pick<NodeLink, 'nodeId' | 'target' | 'relation'> & Partial<Pick<NodeLink, 'version' | 'status'>>)[], meta: ChangeMeta = { actor: 'system', reason: '登记知识来源' }, courseId?: string): KnowledgeOperation | undefined {
    if (!links.length) return
    const active = this.memberships(links[0]!.nodeId).filter(m => m.status === 'active')
    const course = courseId ?? (links[0]!.target.kind === 'block' ? links[0]!.target.courseId : active.length === 1 ? active[0]?.courseId : undefined)
    if (!course) throw new LearningApiError('learning/knowledge/link-course-required', '登记出处时需要明确所属课程')
    if (links.length > 100) throw new LearningApiError('learning/knowledge/too-many-links', '请分批登记出处，每次不超过 100 条')
    return this.operation(course, meta, pending => {
      for (const link of links) {
        if (meta.actor === 'user' && (this.current(linkTarget(link)) as NodeLink | undefined)?.status === 'inactive') throw new LearningApiError('learning/knowledge/inactive-link', '这条来源连线已停用，请在变更记录中撤销停用操作后再登记')
        this.registerLink(link, course, pending)
      }
    })
  }
  unlink(courseId: string, link: NodeLink, meta: ChangeMeta): KnowledgeOperation {
    return this.operation(courseId, meta, pending => {
      this.requireMember(courseId, link.nodeId)
      const target = linkTarget(link), before = this.expect(target, link.version) as NodeLink
      this.save(target, NodeLink.parse({ ...before, status: 'inactive' }), pending)
    })
  }
  links(nodeId: string): NodeLink[] {
    return (this.sqlite.prepare("SELECT data FROM knowledge_links WHERE node_id = ? AND json_extract(data, '$.status') = 'active' ORDER BY rowid").all(nodeId) as { data: string }[]).map(row => NodeLink.parse(JSON.parse(row.data)))
  }
  /** The operation an earlier request with this id wrote, if it wrote one. */
  operationFor(courseId: string, requestId: string): KnowledgeOperation | undefined {
    const row = this.sqlite.prepare('SELECT data FROM knowledge_operations WHERE course_id = ? AND request_id = ?').get(courseId, requestId) as { data: string } | undefined
    return row ? JSON.parse(row.data) as KnowledgeOperation : undefined
  }
  history(courseId: string): KnowledgeOperation[] {
    this.course(courseId)
    return (this.sqlite.prepare(`SELECT o.data FROM knowledge_operation_courses c JOIN knowledge_operations o ON o.id = c.operation_id
      WHERE c.course_id = ? ORDER BY o.rowid DESC LIMIT 100`).all(courseId) as { data: string }[]).map(row => JSON.parse(row.data) as KnowledgeOperation)
  }
  operationDetails(courseId: string, id: string): { operation: KnowledgeOperation; changes: Change[]; titles: Record<string, string>; citations: Record<string, string> } {
    this.course(courseId)
    const row = this.sqlite.prepare(`SELECT o.data FROM knowledge_operations o JOIN knowledge_operation_courses c ON c.operation_id = o.id
      WHERE o.id = ? AND c.course_id = ?`).get(id, courseId) as { data: string } | undefined
    if (!row) throw new LearningApiError('learning/knowledge/no-operation', '本课没有这组知识结构操作')
    const operation = JSON.parse(row.data) as KnowledgeOperation
    const changes = operation.changeIds.map(changeId => this.core.changes.get(changeId))
    if (changes.some(change => !change)) throw new LearningApiError('learning/knowledge/missing-history', '变更记录不完整')
    const ids = (changes as Change[]).flatMap(change => [change.before, change.after].flatMap(text => {
      const record = text ? JSON.parse(text) : {}
      return [record.id, record.nodeId, record.from, record.to, record.replacedBy].filter((id): id is string => typeof id === 'string' && id.startsWith('kn_'))
    }))
    const chunkIds = (changes as Change[]).flatMap(change => [change.before, change.after].flatMap(text => {
      const record = text ? JSON.parse(text) : {}
      return [...(record.sources ?? []), ...(record.target?.kind === 'chunk' ? [record.target.id] : [])] as string[]
    }))
    const titles: Record<string, string> = Object.fromEntries(ids.map(id => [id, this.node(id)?.title ?? '知识节点不可用']))
    // A merge often joins two nodes of one name: mark the merged one so before and after differ visibly.
    if (operation.merge && titles[operation.merge.mergeId]) titles[operation.merge.mergeId] += '（被合并的节点）'
    return { operation, changes: changes as Change[], titles, citations: Object.fromEntries(chunkIds.map(id => [id, this.refs.chunk(id)?.citation ?? '资料出处当前不可用'])) }
  }
  revert(id: string, meta: ChangeMeta): KnowledgeOperation {
    const row = this.sqlite.prepare('SELECT data FROM knowledge_operations WHERE id = ?').get(id) as { data: string } | undefined
    if (!row) throw new LearningApiError('learning/knowledge/no-operation', '知识结构操作不存在')
    const op = JSON.parse(row.data) as KnowledgeOperation
    if (op.revertedBy) throw new LearningApiError('learning/knowledge/already-reverted', '这组操作已经撤销，请查看撤销后的新记录')
    const records = op.changeIds.map(changeId => this.core.changes.get(changeId))
    if (records.some(change => !change)) throw new LearningApiError('learning/knowledge/missing-history', '变更记录不完整，不能安全撤销')
    const changes = records as Change[]
    return this.core.db.transaction(() => {
      const result = this.operation(op.courseId, meta, pending => {
        for (const change of changes) {
          const target = change.target as Target
          if (!['node', 'edge', 'course-node', 'node-link'].includes(target.kind)) throw new LearningApiError('learning/knowledge/wrong-owner', '这条变更不属于知识模型')
          if (stable(this.current(target)) !== stable(change.after === null ? undefined : JSON.parse(change.after))) throw new LearningApiError('learning/knowledge/revert-conflict', '这组操作之后已有其他修改，不能整组覆盖；请先处理后续变更', { target })
        }
        const targets = new Set(changes.map(change => key(change.target as Target)))
        for (const change of [...changes].reverse()) {
          const target = change.target as Target, current = this.current(target)!
          if (target.kind === 'node' && change.before === null) {
            const outside = this.memberships(target.id).some(member => member.status === 'active' && !targets.has(key(memberTarget(member.courseId, member.nodeId))))
            const outsideEdge = this.edges().some(edge => edge.status !== 'inactive' && (edge.from === target.id || edge.to === target.id) && !targets.has(`edge:${edge.id}`))
            const outsideLink = this.links(target.id).some(link => !targets.has(key(linkTarget(link))))
            if (outside || outsideEdge || outsideLink) throw new LearningApiError('learning/knowledge/revert-conflict', '创建的身份已有后续课程、关系或出处，请先处理后续结构修改')
          }
          const restored = change.before === null ? { ...current, status: 'inactive' } : { ...JSON.parse(change.before), version: current.version }
          if (target.kind === 'edge' && restored.status === 'valid') this.checkRestored(KnowledgeEdge.parse(restored))
          if (target.kind === 'node-link' && restored.status === 'active') {
            const link = NodeLink.parse(restored)
            // A merge spans courses: register the link in a course the node belongs to.
            const course = link.target.kind === 'block' ? link.target.courseId : [op.courseId, ...op.courseIds ?? []].find(id => this.membership(id, link.nodeId)) ?? op.courseId
            this.registerLink(link, course, pending, true)
          } else this.save(target, restored, pending)
        }
      }, { revertOf: op.id, inverse: new Map(changes.map(change => [key(change.target as Target), change.id])), ...(op.courseIds ? { courseIds: op.courseIds } : {}), ...(op.merge ? { merge: op.merge } : {}) })
      this.sqlite.prepare('UPDATE knowledge_operations SET data = ? WHERE id = ?').run(JSON.stringify({ ...op, revertedBy: result.id }), op.id)
      // Undoing a merge means the two are not the same; redoing one (undoing the undo) settles the pair again.
      if (op.merge && !op.revertOf) this.saveReview({ ...this.reviewPair(op.merge.keepId, op.merge.mergeId), decision: 'separate', by: 'learner', reason: '撤销了合并' })
      else if (op.merge) this.sqlite.prepare('DELETE FROM knowledge_merge_reviews WHERE pair_key = ?').run(pairKey(op.merge.keepId, op.merge.mergeId))
      return result
    })
  }
  prerequisites(courseId: string, taskId?: string): KnowledgeEdge[] {
    if (taskId && !this.refs.task(courseId, taskId)) throw new LearningApiError('learning/knowledge/unknown-task', '学习任务不属于本课或不存在')
    return this.graph(courseId).edges.filter(edge => edge.type === 'requires' && edge.usable && (edge.scope.kind !== 'task' || edge.scope.taskId === taskId))
  }
  detail(courseId: string, id: string): KnowledgeDetail {
    this.course(courseId); this.requireMember(courseId, id)
    const node = this.node(id)!
    const links = this.links(id).map(link => {
      const target = link.target
      if (target.kind === 'chunk') {
        const chunk = this.refs.chunk(target.id), source = chunk && this.refs.source(chunk.sourceId)
        return { ...link, label: chunk?.citation ?? '资料片段不可用', citation: chunk ? `[${chunk.citation}](cite:${chunk.id})` : undefined, available: !!source && source.status === 'ready' && source.authority !== 'clue' }
      }
      if (target.kind === 'problem') {
        const problem = this.refs.problem(target.id)
        return { ...link, label: problem ? problem.pool === 'test-reserved' ? '测试预留题（题干不在此展示）' : '练习题' : '题目不可用', available: !!problem }
      }
      const block = this.refs.blockIds(target.courseId).includes(target.id)
      return { ...link, label: block ? '课程教材段落' : '教材段落不可用', available: block }
    })
    const edges = this.edges().filter(edge => (edge.from === id || edge.to === id) && (edge.scope.kind === 'global' || edge.scope.courseId === courseId)).map(edge => {
      const issue = edge.status === 'valid' ? this.edgeIssue(edge) : undefined
      return { ...edge, usable: edge.status === 'valid' && !issue, ...(issue ? { issue } : {}) }
    })
    const titles = Object.fromEntries([id, ...node.replacedBy ? [node.replacedBy] : [], ...edges.flatMap(edge => [edge.from, edge.to])].map(nodeId => [nodeId, this.node(nodeId)?.title ?? '知识节点不可用']))
    const citations = Object.fromEntries([...new Set(edges.flatMap(edge => edge.sources))].map(chunkId => [chunkId, this.refs.chunk(chunkId)?.citation ?? '依据不可用']))
    return { node, memberships: this.memberships(id), edges, links, titles, citations, changes: this.core.changes.list({ target: { kind: 'node', id: node.id }, limit: 30 }) }
  }
  /** Active nodes of every course, with relations a course page would also show. */
  global(): KnowledgeGlobal {
    const courses = this.core.courses.list().map(course => ({ id: course.id, title: course.title }))
    const byNode = this.activeCourses()
    const former = new Map<string, string[]>()
    for (const id of this.replacements().keys()) {
      const current = this.identity(id).current, title = this.node(id)?.title
      if (title) former.set(current, [...former.get(current) ?? [], title])
    }
    const nodes = (this.sqlite.prepare("SELECT data FROM knowledge_nodes WHERE json_extract(data, '$.status') = 'active' ORDER BY id").all() as { data: string }[])
      .map(row => KnowledgeNode.parse(JSON.parse(row.data)))
      .filter(node => byNode.has(node.id))
      .map(node => ({ ...node, courseIds: byNode.get(node.id)!, ...(former.has(node.id) ? { formerTitles: former.get(node.id)! } : {}) }))
    // A course or task relation shows only while both ends belong to that course, as on the course page.
    const inCourse = (nodeId: string, courseId: string) => byNode.get(nodeId)?.includes(courseId) ?? false
    const edges = this.edges()
      .filter(edge => edge.status !== 'inactive' && byNode.has(edge.from) && byNode.has(edge.to)
        && (edge.scope.kind === 'global' || inCourse(edge.from, edge.scope.courseId) && inCourse(edge.to, edge.scope.courseId)))
      .map(edge => {
        const issue = edge.status === 'valid' ? this.edgeIssue(edge) : undefined
        return { ...edge, usable: edge.status === 'valid' && !issue, ...(issue ? { issue } : {}) }
      })
    return { nodes, edges, courses }
  }
  /** Material and textbook links of the course's nodes (every course's when omitted), grouped by material. */
  sourceLayer(courseId?: string): KnowledgeSourceLayer {
    if (courseId) this.course(courseId)
    const nodeIds = new Set(courseId ? this.courseNodes(courseId).map(entry => entry.node.id as string) : this.global().nodes.map(node => node.id as string))
    const sources = new Map<string, { id: string; title: string; links: Map<string, { id: string; citation: string }[]> }>()
    const textbooks = new Map<string, Set<string>>()
    const rows = this.sqlite.prepare("SELECT data FROM knowledge_links WHERE json_extract(data, '$.status') = 'active' ORDER BY rowid").all() as { data: string }[]
    for (const link of rows.map(row => NodeLink.parse(JSON.parse(row.data)))) {
      if (!nodeIds.has(link.nodeId)) continue
      const target = link.target
      if (target.kind === 'chunk') {
        const chunk = this.refs.chunk(target.id), source = chunk && this.refs.source(chunk.sourceId)
        if (!chunk || !source || source.status !== 'ready' || source.authority === 'clue') continue
        const entry = sources.get(source.id) ?? { id: source.id, title: source.title, links: new Map() }
        entry.links.set(link.nodeId, [...entry.links.get(link.nodeId) ?? [], { id: chunk.id, citation: chunk.citation }])
        sources.set(source.id, entry)
      } else if (target.kind === 'block' && (!courseId || target.courseId === courseId)) {
        textbooks.set(target.courseId, (textbooks.get(target.courseId) ?? new Set()).add(link.nodeId))
      }
    }
    return {
      sources: [...sources.values()].map(source => ({ id: source.id, title: source.title, links: [...source.links].map(([nodeId, chunks]) => ({ nodeId, chunks })) })),
      textbooks: [...textbooks].map(([course, ids]) => ({ courseId: course, nodeIds: [...ids] })),
    }
  }
  // ── identities and merges (knowledge C) ──────────────────────────────────

  /** Merged identity → the node it was merged into. Few rows: only confirmed merges set it. */
  private replacements(): Map<string, string> {
    return new Map((this.sqlite.prepare("SELECT id, json_extract(data, '$.replacedBy') AS to_id FROM knowledge_nodes WHERE json_extract(data, '$.replacedBy') IS NOT NULL")
      .all() as { id: string; to_id: string }[]).map(row => [row.id, row.to_id]))
  }
  identity(nodeId: string): { current: string; merged: string[] } {
    const replaced = this.replacements()
    let current = nodeId
    const seen = new Set([nodeId])
    while (replaced.has(current) && !seen.has(replaced.get(current)!)) { current = replaced.get(current)!; seen.add(current) }
    const merged: string[] = []
    const into = new Map<string, string[]>()
    for (const [from, to] of replaced) into.set(to, [...into.get(to) ?? [], from])
    const queue = [nodeId]
    while (queue.length) for (const from of into.get(queue.shift()!) ?? []) if (from !== nodeId && !merged.includes(from)) { merged.push(from); queue.push(from) }
    return { current, merged }
  }
  /** Active courses (live ones) of every node with any. */
  private activeCourses(): Map<string, string[]> {
    const live = new Set(this.core.courses.list().map(course => course.id as string))
    const byNode = new Map<string, string[]>()
    for (const row of this.sqlite.prepare("SELECT course_id, node_id FROM knowledge_course_nodes WHERE json_extract(data, '$.status') = 'active' ORDER BY seq").all() as { course_id: string; node_id: string }[]) {
      if (live.has(row.course_id)) byNode.set(row.node_id, [...byNode.get(row.node_id) ?? [], row.course_id])
    }
    return byNode
  }
  private side(node: KnowledgeNode, courses: ReadonlyMap<string, readonly string[]>): MergeSide {
    const edgeCount = (this.sqlite.prepare("SELECT count(*) AS n FROM knowledge_edges WHERE (from_id = ? OR to_id = ?) AND json_extract(data, '$.status') <> 'inactive'").get(node.id, node.id) as { n: number }).n
    const courseIds = courses.get(node.id) ?? []
    return { ...node, courseIds, courseTitles: courseIds.map(id => this.core.courses.get(id)?.title ?? '课程'), edgeCount, linkCount: this.links(node.id).length }
  }
  private mergeable(id: string): KnowledgeNode {
    const node = this.node(id)
    if (!node) throw new LearningApiError('learning/knowledge/not-found', '知识节点不存在')
    if (node.replacedBy) throw new LearningApiError('learning/knowledge/merged', `「${node.title}」已经合并到「${this.node(node.replacedBy)?.title ?? '其他节点'}」`)
    if (node.status !== 'active') throw new LearningApiError('learning/knowledge/inactive-node', `「${node.title}」已停用，不能合并`)
    return node
  }
  private reviewPair(aId: string, bId: string): Pick<MergeReview, 'pair' | 'versions'> & { at: string } {
    const [first, second] = aId < bId ? [aId, bId] : [bId, aId]
    return { pair: [first, second] as MergeReview['pair'], versions: [this.node(first)!.version, this.node(second)!.version], at: new Date().toISOString() }
  }
  private saveReview(review: Omit<MergeReview, 'reason'> & { reason?: string }): void {
    const parsed = MergeReview.parse(review)
    this.sqlite.prepare('INSERT INTO knowledge_merge_reviews VALUES (?, ?) ON CONFLICT(pair_key) DO UPDATE SET data = excluded.data').run(pairKey(...parsed.pair), JSON.stringify(parsed))
  }
  private reviews(): Map<string, MergeReview> {
    return new Map((this.sqlite.prepare('SELECT pair_key, data FROM knowledge_merge_reviews').all() as { pair_key: string; data: string }[]).map(row => [row.pair_key, MergeReview.parse(JSON.parse(row.data))]))
  }
  /** A "not the same" decision still holds while neither node was revised since. */
  private keptApart(review: MergeReview | undefined): boolean {
    return review?.decision === 'separate' && review.pair.every((id, i) => this.node(id)?.version === review.versions[i])
  }
  /** Same kind, same name or alias once normalized, no course in common; plus teacher proposals. */
  mergeSuggestions(courseId?: string): MergeSuggestion[] {
    if (courseId) this.course(courseId)
    const courses = this.activeCourses()
    const nodes = (this.sqlite.prepare("SELECT data FROM knowledge_nodes WHERE json_extract(data, '$.status') = 'active' ORDER BY id").all() as { data: string }[])
      .map(row => KnowledgeNode.parse(JSON.parse(row.data))).filter(node => !node.replacedBy && courses.has(node.id))
    const byId = new Map(nodes.map(node => [node.id as string, node]))
    const reviews = this.reviews()
    const found = new Map<string, MergeSuggestion>()
    const keepOf = (a: KnowledgeNode, b: KnowledgeNode) => (courses.get(b.id)!.length > courses.get(a.id)!.length ? b : courses.get(a.id)!.length > courses.get(b.id)!.length ? a : a.id < b.id ? a : b).id
    const add = (a: KnowledgeNode, b: KnowledgeNode, why: string, by: MergeSuggestion['by'], keepId = keepOf(a, b)) => {
      if (courseId && !courses.get(a.id)!.includes(courseId) && !courses.get(b.id)!.includes(courseId)) return
      found.set(pairKey(a.id, b.id), { nodes: [this.side(a, courses), this.side(b, courses)], why, by, keepId })
    }
    for (const review of reviews.values()) {
      if (review.decision !== 'proposed') continue
      const [a, b] = review.pair.map(id => byId.get(id))
      if (a && b) add(a, b, review.reason, 'teacher', review.keepId)
    }
    const buckets = new Map<string, KnowledgeNode[]>()
    for (const node of nodes) for (const label of nodeLabels(node)) buckets.set(`${node.kind}:${label}`, [...buckets.get(`${node.kind}:${label}`) ?? [], node])
    for (const group of buckets.values()) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const a = group[i]!, b = group[j]!, k = pairKey(a.id, b.id)
      if (found.has(k) || this.keptApart(reviews.get(k))) continue
      // Within one course a repeated name was a deliberate choice (the teacher cannot make one).
      if (courses.get(a.id)!.some(id => courses.get(b.id)!.includes(id))) continue
      const shared = [...nodeLabels(a)].find(label => nodeLabels(b).has(label))!
      const bare = (node: KnowledgeNode) => normalizeLabel(node.title.replace(/[（(【[][^）)】\]]*[）)】\]]/g, ''))
      const why = normalizeLabel(a.title) === normalizeLabel(b.title) ? '名称相同'
        : bare(a) === bare(b) ? '名称相同（不计括号里的说明）'
        : `别名「${[...a.aliases, ...b.aliases, a.title, b.title].find(label => normalizeLabel(label) === shared) ?? shared}」相同`
      add(a, b, why, 'system')
    }
    return [...found.values()].sort((x, y) => (x.by === y.by ? x.nodes[0].title.localeCompare(y.nodes[0].title) : x.by === 'teacher' ? -1 : 1))
  }
  proposeMerge(keepId: string, mergeId: string, reason: string): MergeReview {
    if (keepId === mergeId) throw new LearningApiError('learning/knowledge/same-node', '请选择两个不同的节点')
    const keep = this.mergeable(keepId), merge = this.mergeable(mergeId)
    if (keep.kind !== merge.kind) throw new LearningApiError('learning/knowledge/merge-kind', '类型不同的节点不是同一个身份，不能合并')
    if (!reason.trim()) throw new LearningApiError('learning/knowledge/missing-reason', '请写明为什么认为它们是同一项')
    // The learner reads the reason on the merge page, where internal ids mean nothing (AGENTS.md).
    if (/[a-z]{2,3}_[0-9A-Z]{26}/.test(reason)) throw new LearningApiError('learning/knowledge/internal-id', '理由会原样给学习者看，请用节点名称和资料页码说明，不写内部编号')
    if (this.keptApart(this.reviews().get(pairKey(keepId, mergeId)))) throw new LearningApiError('learning/knowledge/kept-apart', '学习者已确认这两个节点不是同一项；两边都没有修订前不再提出')
    const review = MergeReview.parse({ ...this.reviewPair(keepId, mergeId), decision: 'proposed', keepId, by: 'teacher', reason: reason.trim() })
    this.saveReview(review)
    return review
  }
  keepSeparate(input: { readonly aId: string; readonly aVersion: number; readonly bId: string; readonly bVersion: number }): void {
    this.expect({ kind: 'node', id: input.aId }, input.aVersion)
    this.expect({ kind: 'node', id: input.bId }, input.bVersion)
    this.saveReview({ ...this.reviewPair(input.aId, input.bId), decision: 'separate', by: 'learner' })
  }
  /** Work out a merge without writing: the plan the page shows is the one `merge` carries out. */
  private planMerge(keepId: string, mergeId: string): MergePlan & { joinMembers: CourseNode[]; leaveMembers: CourseNode[]; movedLinks: NodeLink[]; folds: { edge: KnowledgeEdge; into: KnowledgeEdge }[]; moves: { edge: KnowledgeEdge; to: KnowledgeEdge }[] } {
    if (keepId === mergeId) throw new LearningApiError('learning/knowledge/same-node', '请选择两个不同的节点')
    const keep = this.mergeable(keepId), merge = this.mergeable(mergeId)
    if (keep.kind !== merge.kind) throw new LearningApiError('learning/knowledge/merge-kind', '类型不同的节点不是同一个身份，不能合并')
    const courses = this.activeCourses()
    const map = (id: string) => (id === mergeId ? keepId : id)
    const leaveMembers = this.memberships(mergeId).filter(member => member.status === 'active')
    const joinMembers = leaveMembers.filter(member => this.membership(member.courseId, keepId)?.status !== 'active')
    const touching = (this.sqlite.prepare("SELECT data FROM knowledge_edges WHERE (from_id = ? OR to_id = ?) AND json_extract(data, '$.status') <> 'inactive' ORDER BY rowid").all(mergeId, mergeId) as { data: string }[])
      .map(row => KnowledgeEdge.parse(JSON.parse(row.data)))
    const moves: { edge: KnowledgeEdge; to: KnowledgeEdge }[] = [], folds: { edge: KnowledgeEdge; into: KnowledgeEdge }[] = [], stopped: KnowledgeEdge[] = []
    for (const edge of touching) {
      let [from, to] = [map(edge.from), map(edge.to)]
      if (edge.type === 'related' && from > to) [from, to] = [to, from]
      const mapped = { ...edge, from, to } as KnowledgeEdge
      if (from === to) { stopped.push(edge); continue }
      const into = this.sameEdges(edge.type, edge.scope, from, to).find(other => other.id !== edge.id)
      if (into) folds.push({ edge: mapped, into })
      else moves.push({ edge, to: mapped })
    }
    const movedLinks = this.links(mergeId).filter(link => !this.current(linkTarget({ ...link, nodeId: keepId as NodeLink['nodeId'] })))
    // The relations as they would stand, checked for prerequisite and part-of cycles.
    const after = new Map(this.edges().map(edge => [edge.id as string, edge]))
    for (const { edge, to } of moves) after.set(edge.id, to)
    for (const edge of [...stopped, ...folds.map(fold => fold.edge)]) after.delete(edge.id)
    const live = this.liveNodes()
    live.delete(mergeId)
    const cycle = this.findCycle([...after.values()], live)
    const ids = [keepId, mergeId, ...[...moves.map(move => move.to), ...folds.map(fold => fold.edge), ...stopped].flatMap(edge => [edge.from, edge.to])]
    const titles = Object.fromEntries(ids.map(id => [id, this.node(id)?.title ?? '知识节点']))
    const courseTitles = new Map(this.core.courses.list().map(course => [course.id as string, course.title]))
    return {
      keep: this.side(keep, courses), merge: this.side(merge, courses),
      joins: joinMembers.map(member => ({ id: member.courseId, title: courseTitles.get(member.courseId) ?? '课程' })),
      moved: moves.map(move => move.to), folded: folds.map(fold => fold.edge), stopped, links: movedLinks.length,
      ...(cycle ? { blocked: `合并后${cycle.message}。先把其中一条关系改为草案，再合并` } : {}),
      titles, joinMembers, leaveMembers, movedLinks, folds, moves,
    }
  }
  mergePlan(keepId: string, mergeId: string): MergePlan {
    const { joinMembers: _j, leaveMembers: _l, movedLinks: _m, folds: _f, moves: _v, ...plan } = this.planMerge(keepId, mergeId)
    return plan
  }
  /**
   * Fold `mergeId` into `keepId` as one operation group. Changes are recorded relations and links first,
   * memberships next and the node last, so an undo restores the node before checking what hangs on it.
   */
  merge(input: { readonly keepId: string; readonly keepVersion: number; readonly mergeId: string; readonly mergeVersion: number }, meta: ChangeMeta): KnowledgeOperation {
    const keep = this.node(input.keepId), merge = this.node(input.mergeId)
    if (!keep || !merge) throw new LearningApiError('learning/knowledge/not-found', '知识节点不存在')
    const courses = [...new Set([...this.memberships(merge.id), ...this.memberships(keep.id)].filter(m => m.status === 'active').map(m => m.courseId as string))]
      .filter(id => this.core.courses.get(id))
    if (!courses.length) throw new LearningApiError('learning/knowledge/no-course', '这两个节点都不在任何课程里')
    const op = this.operation(courses[0]!, meta, pending => {
      this.expect({ kind: 'node', id: keep.id }, input.keepVersion)
      this.expect({ kind: 'node', id: merge.id }, input.mergeVersion)
      const plan = this.planMerge(keep.id, merge.id)
      if (plan.blocked) throw new LearningApiError('learning/knowledge/cycle', plan.blocked)
      for (const { to } of plan.moves) this.save({ kind: 'edge', id: to.id }, to, pending)
      for (const { edge, into } of plan.folds) {
        // The kept relation stays as it is; the folded one's sources join it, so no basis is lost.
        const sources = [...new Set([...into.sources, ...edge.sources])].slice(0, MAX_EDGE_SOURCES)
        this.save({ kind: 'edge', id: into.id }, KnowledgeEdge.parse({ ...into, sources, rationale: into.rationale || edge.rationale, conditions: into.conditions || edge.conditions }), pending)
        this.save({ kind: 'edge', id: edge.id }, KnowledgeEdge.parse({ ...this.current({ kind: 'edge', id: edge.id }) as KnowledgeEdge, status: 'inactive' }), pending)
      }
      for (const edge of plan.stopped) this.save({ kind: 'edge', id: edge.id }, KnowledgeEdge.parse({ ...this.current({ kind: 'edge', id: edge.id }) as KnowledgeEdge, status: 'inactive' }), pending)
      for (const link of plan.movedLinks) this.save(linkTarget({ ...link, nodeId: keep.id }), NodeLink.parse({ ...link, nodeId: keep.id, version: 1 }), pending)
      for (const link of this.links(merge.id)) this.save(linkTarget(link), NodeLink.parse({ ...link, status: 'inactive' }), pending)
      for (const member of plan.joinMembers) {
        const before = this.membership(member.courseId, keep.id)
        this.save(memberTarget(member.courseId, keep.id), CourseNode.parse({ ...before, courseId: member.courseId, nodeId: keep.id, role: member.role, exam: member.exam, order: before?.order ?? member.order, status: 'active' }), pending)
      }
      for (const member of plan.leaveMembers) this.save(memberTarget(member.courseId, merge.id), CourseNode.parse({ ...member, status: 'inactive' }), pending)
      this.save({ kind: 'node', id: merge.id }, KnowledgeNode.parse({ ...this.node(merge.id), status: 'inactive', replacedBy: keep.id }), pending)
      this.sqlite.prepare('DELETE FROM knowledge_merge_reviews WHERE pair_key = ?').run(pairKey(keep.id, merge.id))
    }, { courseIds: courses, merge: { keepId: keep.id, mergeId: merge.id } })
    return op
  }
  /** A valid relation coming back in an undo. A global one only needs both ends active: a merge spans courses. */
  private checkRestored(edge: KnowledgeEdge): void {
    if (edge.scope.kind !== 'global') return this.checkEdge(edge, edge.scope.courseId)
    if (edge.from === edge.to) throw new LearningApiError('learning/knowledge/self-edge', '节点不能与自身建立关系')
    if ([edge.from, edge.to].some(id => this.node(id)?.status !== 'active')) throw new LearningApiError('learning/knowledge/unknown-node', '关系的端点已停用，不能恢复')
    for (const id of edge.sources) this.checkChunk(id)
    if (!edge.rationale.trim() || !edge.sources.length) throw new LearningApiError('learning/knowledge/missing-basis', '有效关系需要理由和可引用的依据；依据不足时先保存为草案')
  }
  private liveNodes(): Set<string> {
    return new Set((this.sqlite.prepare("SELECT id FROM knowledge_nodes WHERE json_extract(data, '$.status') = 'active'").all() as { id: string }[]).map(row => row.id))
  }
  private checkCycles(): void {
    const cycle = this.findCycle(this.edges(), this.liveNodes())
    if (cycle) throw new LearningApiError('learning/knowledge/cycle', cycle.message, { cycle: cycle.cycle, type: cycle.type })
  }
  /** The first prerequisite or part-of cycle among valid relations, per scope combination. */
  private findCycle(all: readonly KnowledgeEdge[], live: ReadonlySet<string>): { message: string; cycle: string[]; type: 'requires' | 'part-of' } | undefined {
    const active = all.filter(edge => edge.status === 'valid' && live.has(edge.from) && live.has(edge.to))
    const courses = new Set(active.flatMap(edge => edge.scope.kind === 'global' ? [] : [edge.scope.courseId]))
    const tasks = new Map(active.flatMap(edge => edge.scope.kind === 'task' ? [[scopeKey(edge.scope), edge.scope] as const] : []))
    const combinations = [{ label: '全局', edges: active.filter(edge => edge.scope.kind === 'global') }]
    for (const courseId of courses) combinations.push({ label: '本课', edges: active.filter(edge => edge.scope.kind === 'global' || edge.scope.kind === 'course' && edge.scope.courseId === courseId) })
    for (const scope of tasks.values()) combinations.push({ label: '本课任务', edges: active.filter(edge => edge.scope.kind === 'global' || edge.scope.kind === 'course' && edge.scope.courseId === scope.courseId || edge.scope.kind === 'task' && edge.scope.taskId === scope.taskId && edge.scope.courseId === scope.courseId) })
    for (const { label, edges } of combinations) for (const type of ['requires', 'part-of'] as const) {
      const adjacency = new Map<string, string[]>()
      for (const edge of edges.filter(edge => edge.type === type)) adjacency.set(edge.from, [...adjacency.get(edge.from) ?? [], edge.to])
      const done = new Set<string>(), visiting = new Set<string>(), path: string[] = []
      const visit = (id: string): string[] | undefined => {
        if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id]
        if (done.has(id)) return
        visiting.add(id); path.push(id)
        for (const next of adjacency.get(id) ?? []) {
          const found = visit(next)
          if (found) return found
        }
        path.pop(); visiting.delete(id); done.add(id)
      }
      for (const id of adjacency.keys()) {
        const cycle = visit(id)
        if (cycle) return { cycle, type, message: `${label}的${type === 'requires' ? '先修' : '组成'}关系出现循环：${cycle.map(nodeId => this.node(nodeId)?.title ?? '知识节点').join(' → ')}` }
      }
    }
  }
}
