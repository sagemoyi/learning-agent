// Real knowledge/core/library/learner services on synthetic data; no network or paid model calls.
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { newId, type CourseGraph, type NewEdge } from '@learning-agent/contracts'
import { knowledgeMigrations } from '../packages/knowledge/src/store.ts'
import { FIXTURES, createHarness, type Harness } from './harness.ts'

let h: Harness
const teacher = { actor: 'teacher' as const, reason: '合成知识模型验收' }
const user = { actor: 'user' as const, reason: '合成用户修改' }
beforeEach(() => { h = createHarness(() => { throw new Error('knowledge tests must not call a model') }) })
afterEach(async () => { await h.settle(); h.dispose() })

async function setup() {
  const course = await h.ctx.learnCore.courses.create({ title: '知识模型合成课' })
  const fixture = join(FIXTURES, 'synthetic-chapter')
  const source = await h.ctx.learnLibrary.importParsed({ title: '合成资料', kind: 'textbook', authority: '1', file: join(fixture, 'source.md'), parsed: [join(fixture, 'middle.json')], courseId: course.id })
  const chunk = h.ctx.learnLibrary.section(source.id, '1.1').find(chunk => chunk.kind === 'text')!
  const graph = await h.ctx.learnKnowledge.add(course.id, { nodes: ['A', 'B', 'C'].map(title => ({ title, kind: 'knowledge' })) }, teacher)
  const valid = (from: string, to: string, type: NewEdge['type'] = 'requires'): NewEdge => ({ from, to, type, rationale: '合成关系校验依据', sources: [chunk.id], status: 'valid' })
  return { course, source, chunk, graph, valid }
}

it('keeps same-name identities separate, reports alias ambiguity, and only reuses explicit identities', async () => {
  const a = await h.ctx.learnCore.courses.create({ title: '甲课' }), b = await h.ctx.learnCore.courses.create({ title: '乙课' })
  const first = (await h.ctx.learnKnowledge.add(a.id, { nodes: [{ title: '能量', kind: 'knowledge', aliases: ['能力'], domain: '甲' }] }, teacher)).nodes[0]!
  const second = (await h.ctx.learnKnowledge.add(b.id, { nodes: [{ title: '能量', kind: 'skill', domain: '乙' }] }, teacher)).nodes[0]!
  expect(first.id).not.toBe(second.id)
  await expect(h.ctx.learnKnowledge.add(b.id, { nodes: [{ title: first.title, kind: first.kind, reuseId: first.id }] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/reuse-needs-confirmation' })
  const shared = await h.endpoint<CourseGraph>('knowledge', 'add', { courseId: b.id, input: { nodes: [{ title: first.title, kind: first.kind, reuseId: first.id }] } })
  expect(shared.nodes.map(node => node.id)).toContain(first.id)
  expect(() => h.ctx.learnKnowledge.resolve(b.id, '能量')).toThrow(/多个/)
  expect(h.ctx.learnKnowledge.resolve(b.id, first.id)?.id).toBe(first.id)
  await h.ctx.learnKnowledge.add(a.id, { nodes: [{ title: '解释力', kind: 'knowledge', aliases: ['能力'] }] }, teacher)
  expect(() => h.ctx.learnKnowledge.resolve(a.id, '能力')).toThrow(/多个/)
  expect(h.ctx.learnKnowledge.candidates('能量')).toHaveLength(2)
})

it('retries an operation by request identity, rejects different content, and rolls back the entire batch', async () => {
  const { course } = await setup(), k = h.ctx.learnKnowledge
  const input = { requestId: 'same-batch', nodes: [{ title: 'D', kind: 'skill' as const }] }
  const first = await k.add(course.id, input, teacher), again = await k.add(course.id, input, teacher)
  expect(again.operationId).toBe(first.operationId)
  expect(again.replayed).toBe(true)
  expect(again.nodes.filter(node => node.title === 'D')).toHaveLength(1)
  await expect(k.add(course.id, { ...input, nodes: [{ title: 'E', kind: 'skill' }] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/request-conflict' })
  const history = k.history(course.id).length, changes = h.ctx.learnCore.changes.list({ courseId: course.id }).length
  let events = 0
  const off = h.ctx.on('learning/change-applied', () => { events++ })
  await expect(k.add(course.id, { nodes: [{ title: '半份', kind: 'knowledge' }], edges: [{ from: '半份', to: '不存在', type: 'requires' }] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/unknown-node' })
  off()
  expect(k.resolve(course.id, '半份')).toBeUndefined()
  expect(k.history(course.id)).toHaveLength(history)
  expect(h.ctx.learnCore.changes.list({ courseId: course.id })).toHaveLength(changes)
  expect(events).toBe(0)
})

it('checks source readiness, course attachment, missing basis and self edges at the service boundary', async () => {
  const { course, chunk, valid } = await setup(), k = h.ctx.learnKnowledge
  await expect(k.add(course.id, { nodes: [], edges: [{ from: 'A', to: 'B', type: 'requires', status: 'valid' }] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/missing-basis' })
  await expect(k.add(course.id, { nodes: [], edges: [{ ...valid('A', 'B'), sources: [newId('chunk')] }] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/invalid-source' })
  await expect(k.add(course.id, { nodes: [], edges: [valid('A', 'A')] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/self-edge' })
  const other = await h.ctx.learnCore.courses.create({ title: '没有资料的课' })
  await k.add(other.id, { nodes: [{ title: 'A', kind: 'knowledge' }, { title: 'B', kind: 'knowledge' }] }, teacher)
  await expect(k.add(other.id, { nodes: [], edges: [valid('A', 'B')] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/source-not-in-course' })
  const source = h.ctx.learnLibrary.source(chunk.sourceId)!
  h.ctx.learnCore.db.sqlite.prepare('UPDATE library_sources SET data = ? WHERE id = ?').run(JSON.stringify({ ...source, status: 'importing' }), source.id)
  await expect(k.add(course.id, { nodes: [], edges: [valid('A', 'B')] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/invalid-source' })
})

it('keeps draft and disputed prerequisites out of execution and exposes unavailable current citations', async () => {
  const { course, source, valid } = await setup(), k = h.ctx.learnKnowledge
  await k.add(course.id, { nodes: [], edges: [{ from: 'A', to: 'B', type: 'requires' }, { ...valid('B', 'C'), status: 'disputed' }] }, teacher)
  expect(k.prerequisites(course.id)).toEqual([])
  const edge = k.graph(course.id).edges[0]!
  k.editEdge(course.id, edge.id, edge.version, { sources: valid('A', 'B').sources as never, rationale: '合成校验依据', status: 'valid' }, user)
  expect(k.prerequisites(course.id).map(e => [e.from, e.to])).toEqual([[edge.from, edge.to]])
  h.ctx.learnCore.db.sqlite.prepare('DELETE FROM library_course_sources WHERE course_id = ? AND source_id = ?').run(course.id, source.id)
  expect(k.prerequisites(course.id)).toEqual([])
  expect(k.graph(course.id).edges.find(e => e.id === edge.id)).toMatchObject({ status: 'valid', usable: false, issue: expect.stringContaining('关联本课') })
  expect(k.detail(course.id, edge.from).edges.find(e => e.id === edge.id)).toMatchObject({ usable: false, issue: expect.stringContaining('关联本课') })
})

it('rejects prerequisite and containment cycles with a path, but allows related cycles', async () => {
  const { course, valid } = await setup(), k = h.ctx.learnKnowledge
  await k.add(course.id, { nodes: [], edges: [valid('A', 'B'), valid('B', 'C')] }, teacher)
  await expect(k.add(course.id, { nodes: [], edges: [valid('C', 'A')] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/cycle', details: { cycle: expect.arrayContaining(k.graph(course.id).nodes.map(node => node.id)) } })
  expect(k.graph(course.id).edges).toHaveLength(2)
  await expect(k.add(course.id, { nodes: [], edges: [valid('A', 'B', 'part-of'), valid('B', 'A', 'part-of')] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/cycle' })
  await k.add(course.id, { nodes: [], edges: [valid('A', 'B', 'related'), valid('B', 'C', 'related'), valid('C', 'A', 'related')] }, teacher)
  expect(k.graph(course.id).edges.filter(e => e.type === 'related')).toHaveLength(3)
  await expect(k.add(course.id, { nodes: [], edges: [valid('B', 'A', 'related')] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/duplicate-edge' })
})

it('combines global and course prerequisites while keeping different task contexts separate', async () => {
  const { course, valid } = await setup(), k = h.ctx.learnKnowledge
  const t1 = h.ctx.learnCurriculum.publishTask({ courseId: course.id, kind: 'other', title: '条件甲', instructions: '合成条件', createdBy: 'teacher' })
  const t2 = h.ctx.learnCurriculum.publishTask({ courseId: course.id, kind: 'other', title: '条件乙', instructions: '合成条件', createdBy: 'teacher' })
  await k.add(course.id, { nodes: [], edges: [{ ...valid('A', 'B'), scope: { kind: 'task', courseId: course.id, taskId: t1.id } }, { ...valid('B', 'A'), scope: { kind: 'task', courseId: course.id, taskId: t2.id } }] }, teacher)
  expect(k.prerequisites(course.id)).toHaveLength(0)
  expect(k.prerequisites(course.id, t1.id)).toHaveLength(1)
  expect(k.prerequisites(course.id, t2.id)).toHaveLength(1)
  await expect(k.add(course.id, { nodes: [], edges: [{ ...valid('B', 'A'), scope: { kind: 'global' } }] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/cycle' })
  await expect(k.add(course.id, { nodes: [], edges: [{ ...valid('A', 'C'), scope: { kind: 'task', courseId: course.id, taskId: newId('task') } }] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/unknown-task' })
})

it('groups node, membership, edge and source snapshots and only notifies after they are committed', async () => {
  const { course, chunk } = await setup(), k = h.ctx.learnKnowledge
  let sawCommitted = false
  const off = h.ctx.on('learning/change-applied', change => { if (change.operationId) sawCommitted = k.resolve(course.id, '新节点') !== undefined })
  const graph = await k.add(course.id, { nodes: [{ title: '新节点', kind: 'skill', sources: [chunk.id] }], edges: [{ from: '新节点', to: 'A', type: 'related' }] }, teacher)
  off()
  expect(sawCommitted).toBe(true)
  const details = k.operationDetails(course.id, graph.operationId!)
  expect(details.changes.map(change => change.target.kind).sort()).toEqual(['course-node', 'edge', 'node', 'node-link'])
  expect(details.changes.every(change => change.after && change.operationId === graph.operationId && change.courseId === course.id)).toBe(true)
  expect(details.citations[chunk.id]).toBe(chunk.citation)
  expect(h.ctx.learnCore.changes.list({ operationId: graph.operationId })).toHaveLength(4)
})

it('uses revisions for edits and undoes whole creation groups without deleting evidence or identities', async () => {
  const { course, chunk } = await setup(), k = h.ctx.learnKnowledge
  const graph = await k.add(course.id, { nodes: [{ title: '撤销对象', kind: 'skill', sources: [chunk.id] }], edges: [{ from: '撤销对象', to: 'A', type: 'related' }] }, teacher)
  const node = k.resolve(course.id, '撤销对象')!
  h.ctx.learnCore.log.append({ type: 'help.given', courseId: course.id, nodeIds: [node.id], context: {}, level: 'hint', via: 'teacher' })
  const evidence = h.ctx.learnCore.db.sqlite.prepare('SELECT data FROM core_log ORDER BY id').all()
  const inverse = k.revert(graph.operationId!, user)
  expect(k.node(node.id)).toMatchObject({ status: 'inactive', version: 2 })
  expect(k.resolve(course.id, '撤销对象')).toBeUndefined()
  expect(k.links(node.id)).toEqual([])
  expect(h.ctx.learnCore.db.sqlite.prepare('SELECT data FROM core_log ORDER BY id').all()).toEqual(evidence)
  expect(k.operationDetails(course.id, inverse.id).changes.every(change => change.revertOf)).toBe(true)
  expect(() => k.revert(graph.operationId!, user)).toThrow(/已经撤销/)
  k.revert(inverse.id, user)
  expect(k.resolve(course.id, '撤销对象')?.id).toBe(node.id)
  expect(k.links(node.id)).toHaveLength(1)
  const edit = k.editNode(course.id, node.id, k.node(node.id)!.version, { description: '第一份' }, user)
  expect(() => k.editNode(course.id, node.id, node.version, { description: '过期' }, user)).toThrow(/刷新/)
  k.editNode(course.id, node.id, k.node(node.id)!.version, { description: '后续修改' }, user)
  expect(() => k.revert(edit.id, user)).toThrow(/其他修改/)
  expect(k.node(node.id)?.description).toBe('后续修改')
})

it('keeps course removal local, rejects an unsafe creation undo after reuse, and refuses stale membership edits', async () => {
  const { course, graph } = await setup(), k = h.ctx.learnKnowledge, node = graph.nodes[0]!
  const other = await h.ctx.learnCore.courses.create({ title: '共享课程' })
  await k.add(other.id, { nodes: [{ title: node.title, kind: node.kind, reuseId: node.id }] }, user)
  expect(() => k.revert(graph.operationId!, user)).toThrow(/后续课程/)
  const removal = k.setMembership(course.id, node.id, node.membership.version, { status: 'inactive' }, user)
  expect(k.graph(course.id).nodes.map(n => n.id)).not.toContain(node.id)
  expect(k.graph(other.id).nodes.map(n => n.id)).toContain(node.id)
  expect(() => k.setMembership(course.id, node.id, node.membership.version, { role: 'related' }, user)).toThrow(/刷新/)
  k.revert(removal.id, user)
  expect(k.graph(course.id).nodes.map(n => n.id)).toContain(node.id)
})

it('validates source targets and does not reveal reserved test questions in node details', async () => {
  const { course, graph, chunk } = await setup(), k = h.ctx.learnKnowledge, node = graph.nodes[0]!
  expect(() => k.link([{ nodeId: newId('node'), target: { kind: 'chunk', id: chunk.id }, relation: 'explains' }], user, course.id)).toThrow(/不属于/)
  expect(() => k.link([{ nodeId: node.id, target: { kind: 'block', courseId: course.id, id: 'abc123' }, relation: 'explains' }], user, course.id)).toThrow(/不存在/)
  const [problem] = h.ctx.learnAssess.addProblems([{ stem: '预留题干不得泄漏', answer: { kind: 'open', rubric: '预留答案不得泄漏' }, answerSource: 'book', tier: 1, origin: { kind: 'chunk', chunkId: chunk.id, label: chunk.citation }, nodeIds: [node.id], pool: 'test-reserved' }])
  k.link([{ nodeId: node.id, target: { kind: 'problem', id: problem!.id }, relation: 'assesses' }], user, course.id)
  const detail = k.detail(course.id, node.id)
  expect(detail.links[0]?.label).toContain('测试预留题')
  expect(JSON.stringify(detail)).not.toContain('预留题干不得泄漏')
  expect(JSON.stringify(detail)).not.toContain('预留答案不得泄漏')
  const unlinked = k.unlink(course.id, detail.links[0]!, user)
  expect(k.links(node.id)).toEqual([])
  expect(() => k.link([detail.links[0]!], user, course.id)).toThrow(/撤销停用/)
  k.link([detail.links[0]!], { actor: 'system', reason: '重复索引不能启用停用连线' }, course.id)
  expect(k.links(node.id)).toEqual([])
  k.revert(unlinked.id, user)
  expect(k.links(node.id)).toHaveLength(1)
})

it('records learner handoffs while teacher service calls do not emit them, and rejects kind changes', async () => {
  const course = await h.ctx.learnCore.courses.create({ title: '动作验收' }), notices: string[] = []
  h.ctx.on('learning/handoff', event => { if (event.unit === 'knowledge') notices.push(event.text) })
  const graph = await h.ctx.learnKnowledge.add(course.id, { nodes: [{ title: '课内能力', kind: 'skill' }] }, teacher)
  expect(notices).toEqual([])
  const node = graph.nodes[0]!
  await h.endpoint('knowledge', 'editNode', { courseId: course.id, nodeId: node.id, version: node.version, patch: { description: '用户修订' } })
  expect(notices).toHaveLength(1)
  expect(notices[0]).not.toContain(node.id)
  const invalid = await h.call('knowledge', 'editNode', { courseId: course.id, nodeId: node.id, version: 2, patch: { kind: 'task' } })
  expect(invalid.ok).toBe(false)
  const input = { requestId: 'page-retry', nodes: [{ title: '幂等页面节点', kind: 'knowledge' }] }
  await h.endpoint('knowledge', 'add', { courseId: course.id, input })
  await h.endpoint('knowledge', 'add', { courseId: course.id, input })
  expect(notices).toHaveLength(2)
})

it('rejects an undo that would restore a cycle and keeps the whole inverse transaction unapplied', async () => {
  const { course, valid } = await setup(), k = h.ctx.learnKnowledge
  await k.add(course.id, { nodes: [], edges: [valid('A', 'B')] }, teacher)
  const edge = k.graph(course.id).edges[0]!
  const disable = k.editEdge(course.id, edge.id, edge.version, { status: 'inactive' }, user)
  await k.add(course.id, { nodes: [], edges: [valid('B', 'A')] }, teacher)
  const count = k.history(course.id).length
  expect(() => k.revert(disable.id, user)).toThrow(/循环/)
  expect(k.history(course.id)).toHaveLength(count)
  expect(k.operationDetails(course.id, disable.id).operation.revertedBy).toBeUndefined()
  expect(k.graph(course.id).edges.map(e => e.id)).not.toContain(edge.id)
})

it('migrates the v1 graph without changing identities, links or evidence, and repeats safely', async () => {
  const course = await h.ctx.learnCore.courses.create({ title: '迁移合成库' }), db = h.ctx.learnCore.db, nodeId = newId('node'), otherId = newId('node'), edgeId = newId('edge')
  db.sqlite.exec('DROP TABLE knowledge_operations; DROP TABLE knowledge_links; DROP TABLE knowledge_course_nodes; DROP TABLE knowledge_edges; DROP TABLE knowledge_nodes;')
  db.sqlite.prepare("DELETE FROM core_migrations WHERE unit = 'knowledge'").run()
  db.migrate('knowledge', knowledgeMigrations.slice(0, 1))
  for (const [id, title] of [[nodeId, '旧 A'], [otherId, '旧 B']]) {
    db.sqlite.prepare('INSERT INTO knowledge_nodes VALUES (?, ?, ?)').run(id!, title!, JSON.stringify({ id, title, kind: 'knowledge', description: '旧说明', aliases: [], createdAt: new Date().toISOString() }))
    db.sqlite.prepare('INSERT INTO knowledge_course_nodes VALUES (?, ?, ?, ?)').run(course.id, id!, 'core', 1)
  }
  db.sqlite.prepare('INSERT INTO knowledge_edges VALUES (?, ?, ?, ?, ?)').run(edgeId, nodeId, otherId, 'requires', JSON.stringify({ id: edgeId, from: nodeId, to: otherId, type: 'requires', rationale: '', sources: [] }))
  const chunkId = newId('chunk')
  db.sqlite.prepare('INSERT INTO knowledge_links VALUES (?, ?, ?, ?)').run(nodeId, `chunk:${chunkId}`, 'explains', JSON.stringify({ nodeId, target: { kind: 'chunk', id: chunkId }, relation: 'explains' }))
  h.ctx.learnCore.log.append({ type: 'signal.self-report', courseId: course.id, nodeIds: [nodeId], context: {}, claim: 'known' })
  const evidence = db.sqlite.prepare('SELECT data FROM core_log').all()
  db.migrate('knowledge', knowledgeMigrations)
  db.migrate('knowledge', knowledgeMigrations)
  expect(h.ctx.learnKnowledge.graph(course.id).nodes.map(n => n.id).sort()).toEqual([nodeId, otherId].sort())
  expect(h.ctx.learnKnowledge.graph(course.id).edges).toEqual([expect.objectContaining({ id: edgeId, status: 'legacy', usable: false })])
  expect(h.ctx.learnKnowledge.node(nodeId)?.legacy).toBe(true)
  expect(h.ctx.learnKnowledge.links(nodeId)).toEqual([expect.objectContaining({ target: { kind: 'chunk', id: chunkId }, status: 'active' })])
  expect(h.ctx.learnKnowledge.prerequisites(course.id)).toEqual([])
  expect(db.sqlite.prepare('SELECT data FROM core_log').all()).toEqual(evidence)
})

it('records one group per textbook index and none when the index finds nothing new', async () => {
  const { course } = await setup(), k = h.ctx.learnKnowledge
  const text = Array.from({ length: 120 }, (_, i) => `这一段讲 A 和 B，第 ${i} 段。 ^p${String(i).padStart(5, '0')}`).join('\n\n')
  const reindex = () => (h.ctx.learnTextbook as unknown as { reindex(courseId: string, file: string, text: string): void }).reindex(course.id, 'stages/s1/textbook/01.md', text)
  const before = k.history(course.id).length
  reindex()
  const first = k.history(course.id).slice(0, k.history(course.id).length - before)
  expect(first).toHaveLength(3)
  expect(first.every(op => op.actor === 'system' && op.changeIds.length > 0)).toBe(true)
  reindex()
  expect(k.history(course.id)).toHaveLength(before + 3)
  expect(k.links(k.resolve(course.id, 'A')!.id)).toHaveLength(120)
})

it('stops the teacher from repeating a name in one course and explains relation conflicts', async () => {
  const { course } = await setup(), k = h.ctx.learnKnowledge
  await expect(k.add(course.id, { nodes: [{ title: 'A', kind: 'skill' }] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/same-name' })
  await expect(k.add(course.id, { nodes: [{ title: '新甲', kind: 'skill' }, { title: '新甲', kind: 'skill' }] }, teacher)).rejects.toMatchObject({ code: 'learning/knowledge/same-name' })
  const reuse = await k.add(course.id, { nodes: [{ title: 'A', kind: 'knowledge', reuseId: k.resolve(course.id, 'A')!.id }] }, teacher)
  expect(reuse.operationId).toBeUndefined()
  await k.add(course.id, { nodes: [], edges: [{ from: 'A', to: 'B', type: 'related' }, { from: 'A', to: 'B', type: 'requires' }, { from: 'A', to: 'B', type: 'requires', scope: { kind: 'global' } }] }, teacher)
  const [related, local] = [k.graph(course.id).edges.find(e => e.type === 'related')!, k.graph(course.id).edges.find(e => e.type === 'requires' && e.scope.kind === 'course')!]
  k.editEdge(course.id, related.id, related.version, { status: 'inactive' }, user)
  await expect(k.add(course.id, { nodes: [], edges: [{ from: 'B', to: 'A', type: 'related' }] }, teacher)).rejects.toThrow(/已停用/)
  expect(() => k.editEdge(course.id, local.id, local.version, { scope: { kind: 'global' } }, user)).toThrow(/已有同类关系/)
})
