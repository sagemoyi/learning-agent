// Owns knowledge revisions. Atomic edits record snapshots in core; evidence is never rewritten.
import { createHash } from 'node:crypto'
import {
  CourseNode, KnowledgeAdd, KnowledgeEdge, KnowledgeEdgePatch, KnowledgeMembershipPatch, RelationScope,
  KnowledgeNode, KnowledgeNodePatch, LearningApiError, NodeLink, newId,
  type Change, type ChangeMeta, type ChangeTarget, type CourseGraph, type CitedChunk,
  type KnowledgeDetail, type KnowledgeOperation, type LearnCore, type Migration,
  type NewEdge, type NewNode, type Problem, type Source, type Block,
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
]

type Core = Pick<LearnCore, 'db' | 'changes' | 'courses'>
type Target = { kind: 'node' | 'edge' | 'course-node' | 'node-link'; id: string }
type Value = KnowledgeNode | KnowledgeEdge | CourseNode | NodeLink
type Pending = Map<string, { target: Target; before: string | null; after: string }>

export interface KnowledgeReferences {
  chunk(id: string): CitedChunk | undefined
  source(id: string): Source | undefined
  courseSources(courseId: string): readonly { source: Source }[]
  problem(id: string): Problem | undefined
  block(courseId: string, id: string): Block | undefined
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

export class KnowledgeStore {
  constructor(private readonly core: Core, private readonly refs: KnowledgeReferences) {}
  private get sqlite() { return this.core.db.sqlite }
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
  graph(courseId: string): CourseGraph {
    this.course(courseId)
    const rows = this.sqlite.prepare(`SELECT n.data, c.data AS membership FROM knowledge_course_nodes c
      JOIN knowledge_nodes n ON n.id = c.node_id WHERE c.course_id = ?
      AND json_extract(c.data, '$.status') = 'active' AND json_extract(n.data, '$.status') = 'active'
      ORDER BY c.seq, n.id`).all(courseId) as { data: string; membership: string }[]
    const nodes = rows.map(row => {
      const membership = CourseNode.parse(JSON.parse(row.membership))
      const node = KnowledgeNode.parse(JSON.parse(row.data))
      return { ...node, role: membership.role, membership, courseCount: this.memberships(node.id).filter(m => m.status === 'active').length }
    })
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
    const nodes = courseId ? this.graph(courseId).nodes : (this.sqlite.prepare("SELECT data FROM knowledge_nodes WHERE json_extract(data, '$.status') = 'active' ORDER BY id").all() as { data: string }[]).map(row => KnowledgeNode.parse(JSON.parse(row.data)))
    return nodes.filter(node => [node.id, node.title, ...node.aliases].some(label => label.toLocaleLowerCase().includes(wanted))).slice(0, 50)
  }
  resolve(courseId: string, ref: string): KnowledgeNode | undefined {
    const wanted = ref.trim()
    const nodes = this.graph(courseId).nodes
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
        ON CONFLICT(id) DO UPDATE SET scope_key = excluded.scope_key, data = excluded.data`).run(edge.id, edge.from, edge.to, edge.type, scopeKey(edge.scope), data)
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
  private operation(courseId: string, meta: ChangeMeta, run: (pending: Pending) => void, request?: { id: string; input: unknown }, revertOf?: string, inverse?: Map<string, string>): KnowledgeOperation & { replayed?: boolean } {
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
      run(pending)
      this.checkCycles()
      const id = newId('operation')
      const changes = [...pending.values()].map(change => this.core.changes.record({
        ...change, target: change.target as ChangeTarget, actor: meta.actor, reason: meta.reason, size: meta.size ?? 'minor', operationId: id,
        courseId: courseId as Change['courseId'],
        ...(meta.proposalId ? { proposalId: meta.proposalId as Change['proposalId'] } : {}),
        ...(inverse?.get(key(change.target)) ? { revertOf: inverse.get(key(change.target)) as Change['revertOf'] } : {}),
      }))
      const op: KnowledgeOperation = { id, courseId, at: new Date().toISOString(), actor: meta.actor, reason: meta.reason, changeIds: changes.map(c => c.id), ...(revertOf ? { revertOf } : {}) }
      this.sqlite.prepare('INSERT INTO knowledge_operations VALUES (?, ?, ?, ?, ?)').run(id, courseId, request?.id ?? null, hash ?? null, JSON.stringify(op))
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
  add(courseId: string, input: { readonly requestId?: string; readonly nodes: readonly NewNode[]; readonly edges?: readonly NewEdge[] }, meta: ChangeMeta): CourseGraph {
    const parsed = KnowledgeAdd.parse(input)
    const op = this.operation(courseId, meta, pending => {
      let seq = (this.sqlite.prepare('SELECT coalesce(max(seq), 0) AS n FROM knowledge_course_nodes WHERE course_id = ?').get(courseId) as { n: number }).n
      for (const draft of parsed.nodes) {
        let node = draft.reuseId ? this.node(draft.reuseId) : undefined
        if (draft.reuseId) {
          if (!node || node.status !== 'active' || node.replacedBy) throw new LearningApiError('learning/knowledge/not-found', '选择的知识身份不可用')
          if (node.title !== draft.title || node.kind !== draft.kind) throw new LearningApiError('learning/knowledge/reuse-mismatch', '复用只关联已有身份，不会修改其名称或类型；请核对选择的节点')
          if (meta.actor === 'teacher' && this.membership(courseId, node.id)?.status !== 'active') throw new LearningApiError('learning/knowledge/reuse-needs-confirmation', '跨课复用需要学习者在知识模型页选择已有身份；同名不能直接共享')
        } else {
          node = KnowledgeNode.parse({ ...draft, id: newId('node'), createdAt: new Date().toISOString() })
          this.save({ kind: 'node', id: node.id }, node, pending)
        }
        const member = this.membership(courseId, node!.id)
        if (!member || member.status === 'inactive') this.save(memberTarget(courseId, node!.id), CourseNode.parse({ ...member, courseId, nodeId: node!.id, role: member?.role ?? 'core', order: member?.order ?? ++seq, status: 'active' }), pending)
        for (const chunkId of draft.sources ?? []) this.registerLink({ nodeId: node!.id, target: { kind: 'chunk', id: chunkId }, relation: 'explains' }, courseId, pending)
      }
      for (const draft of parsed.edges ?? []) {
        const from = this.resolve(courseId, draft.from), to = this.resolve(courseId, draft.to)
        if (!from || !to) throw new LearningApiError('learning/knowledge/unknown-node', '关系的端点不存在，请先添加节点或使用本课已有 ID')
        const [fromId, toId] = draft.type === 'related' && from.id > to.id ? [to.id, from.id] : [from.id, to.id]
        const scope = draft.scope ?? RelationScope.parse({ kind: 'course', courseId })
        const existing = this.edges().filter(edge => edge.type === draft.type && scopeKey(edge.scope) === scopeKey(scope)
          && ((edge.from === fromId && edge.to === toId) || (draft.type === 'related' && edge.from === toId && edge.to === fromId)))
        if (existing.length) throw new LearningApiError('learning/knowledge/duplicate-edge', '这个范围内已有同类关系，请打开它补充依据或修订；不要重复添加', { edges: existing })
        const edge = KnowledgeEdge.parse({ ...draft, id: newId('edge'), from: fromId, to: toId, scope })
        this.checkEdge(edge, courseId)
        this.save({ kind: 'edge', id: edge.id }, edge, pending)
      }
    }, parsed.requestId ? { id: parsed.requestId, input: parsed } : undefined)
    return { ...this.graph(courseId), operationId: op.id, replayed: op.replayed }
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
    if (target.kind === 'block' && (target.courseId !== courseId || !this.refs.block(target.courseId, target.id))) throw new LearningApiError('learning/knowledge/invalid-link', '教材块不属于本课或不存在')
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
  history(courseId: string): KnowledgeOperation[] {
    this.course(courseId)
    return (this.sqlite.prepare('SELECT data FROM knowledge_operations WHERE course_id = ? ORDER BY rowid DESC LIMIT 100').all(courseId) as { data: string }[]).map(row => JSON.parse(row.data) as KnowledgeOperation)
  }
  operationDetails(courseId: string, id: string): { operation: KnowledgeOperation; changes: Change[]; titles: Record<string, string>; citations: Record<string, string> } {
    this.course(courseId)
    const row = this.sqlite.prepare('SELECT data FROM knowledge_operations WHERE id = ? AND course_id = ?').get(id, courseId) as { data: string } | undefined
    if (!row) throw new LearningApiError('learning/knowledge/no-operation', '本课没有这组知识结构操作')
    const operation = JSON.parse(row.data) as KnowledgeOperation
    const changes = operation.changeIds.map(changeId => this.core.changes.get(changeId))
    if (changes.some(change => !change)) throw new LearningApiError('learning/knowledge/missing-history', '变更记录不完整')
    const ids = (changes as Change[]).flatMap(change => [change.before, change.after].flatMap(text => {
      const record = text ? JSON.parse(text) : {}
      return [record.id, record.nodeId, record.from, record.to].filter((id): id is string => typeof id === 'string' && id.startsWith('kn_'))
    }))
    const chunkIds = (changes as Change[]).flatMap(change => [change.before, change.after].flatMap(text => {
      const record = text ? JSON.parse(text) : {}
      return [...(record.sources ?? []), ...(record.target?.kind === 'chunk' ? [record.target.id] : [])] as string[]
    }))
    return { operation, changes: changes as Change[], titles: Object.fromEntries(ids.map(id => [id, this.node(id)?.title ?? '知识节点不可用'])), citations: Object.fromEntries(chunkIds.map(id => [id, this.refs.chunk(id)?.citation ?? '资料出处当前不可用'])) }
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
          if (target.kind === 'edge' && restored.status === 'valid') this.checkEdge(KnowledgeEdge.parse(restored), op.courseId)
          if (target.kind === 'node-link' && restored.status === 'active') this.registerLink(restored, op.courseId, pending, true)
          else this.save(target, restored, pending)
        }
      }, undefined, op.id, new Map(changes.map(change => [key(change.target as Target), change.id])))
      this.sqlite.prepare('UPDATE knowledge_operations SET data = ? WHERE id = ?').run(JSON.stringify({ ...op, revertedBy: result.id }), op.id)
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
      const block = this.refs.block(target.courseId, target.id)
      return { ...link, label: block ? '课程教材段落' : '教材段落不可用', available: !!block }
    })
    const edges = this.edges().filter(edge => (edge.from === id || edge.to === id) && (edge.scope.kind === 'global' || edge.scope.courseId === courseId)).map(edge => {
      const issue = edge.status === 'valid' ? this.edgeIssue(edge) : undefined
      return { ...edge, usable: edge.status === 'valid' && !issue, ...(issue ? { issue } : {}) }
    })
    const titles = Object.fromEntries([id, ...edges.flatMap(edge => [edge.from, edge.to])].map(nodeId => [nodeId, this.node(nodeId)?.title ?? '知识节点不可用']))
    const citations = Object.fromEntries([...new Set(edges.flatMap(edge => edge.sources))].map(chunkId => [chunkId, this.refs.chunk(chunkId)?.citation ?? '依据不可用']))
    return { node, memberships: this.memberships(id), edges, links, titles, citations, changes: this.core.changes.list({ target: { kind: 'node', id: node.id }, limit: 30 }) }
  }
  private checkCycles(): void {
    const active = this.edges().filter(edge => edge.status === 'valid' && this.node(edge.from)?.status === 'active' && this.node(edge.to)?.status === 'active')
    const courses = new Set(active.flatMap(edge => edge.scope.kind === 'global' ? [] : [edge.scope.courseId]))
    const tasks = new Map(active.flatMap(edge => edge.scope.kind === 'task' ? [[scopeKey(edge.scope), edge.scope] as const] : []))
    const combinations = [{ label: '全局', edges: active.filter(edge => edge.scope.kind === 'global') }]
    for (const courseId of courses) combinations.push({ label: '本课', edges: active.filter(edge => edge.scope.kind === 'global' || edge.scope.kind === 'course' && edge.scope.courseId === courseId) })
    for (const scope of tasks.values()) combinations.push({ label: '本课任务', edges: active.filter(edge => edge.scope.kind === 'global' || edge.scope.kind === 'course' && edge.scope.courseId === scope.courseId || edge.scope.kind === 'task' && edge.scope.taskId === scope.taskId && edge.scope.courseId === scope.courseId) })
    for (const { label, edges } of combinations) for (const type of ['requires', 'part-of'] as const) {
      const adjacency = new Map<string, string[]>()
      for (const edge of edges.filter(edge => edge.type === type)) adjacency.set(edge.from, [...adjacency.get(edge.from) ?? [], edge.to])
      const done = new Set<string>(), visiting = new Set<string>(), path: string[] = []
      const visit = (id: string): void => {
        if (visiting.has(id)) {
          const cycle = [...path.slice(path.indexOf(id)), id]
          throw new LearningApiError('learning/knowledge/cycle', `${label}的${type === 'requires' ? '先修' : '组成'}关系出现循环：${cycle.map(nodeId => this.node(nodeId)?.title ?? '知识节点').join(' → ')}`, { cycle, type })
        }
        if (done.has(id)) return
        visiting.add(id); path.push(id)
        for (const next of adjacency.get(id) ?? []) visit(next)
        path.pop(); visiting.delete(id); done.add(id)
      }
      for (const id of adjacency.keys()) visit(id)
    }
  }
}
