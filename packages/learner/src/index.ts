// learner unit, host half. Provides `ctx.learnLearner` (contracts §5.1): node mastery states derived
// from the evidence log only. States are a cache: deleting them and recomputing gives the same
// result (decision #1). Skeleton rules live in rules.ts. A merged identity's entries count for the
// node it was merged into; they keep the id they were logged with (docs/knowledge/design.md, C).
import { Service, type Context } from '@deepseek-ai/cordis'
import { NodeState, type EvidenceRecord, type LearnLearner, type LogEntry, type MasteryState, type Migration } from '@learning-agent/contracts'
import { z } from 'zod'
import { describeEvidence } from './evidence.ts'
import { RULES_VERSION, deriveState } from './rules.ts'

export const name = 'learning-learner'
export const inject = ['learnCore', 'learnKnowledge']

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE learner_states (
        node_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `,
  },
]

export const STATE_LABEL: Record<MasteryState, string> = {
  untested: '未探测', 'not-yet': '还没答对', assisted: '有帮助完成', independent: '已独立完成', retained: '已延迟验证', conflict: '证据冲突',
}

class LearnLearnerService extends Service implements LearnLearner {
  readonly rulesVersion = RULES_VERSION

  constructor(ctx: Context) {
    super(ctx, 'learnLearner')
    ctx.learnCore.db.migrate('learner', migrations)
  }

  private get sqlite() {
    return this.ctx.learnCore.db.sqlite
  }

  states(nodeIds?: readonly string[]): NodeState[] {
    const rows = this.sqlite.prepare('SELECT data FROM learner_states').all() as { data: string }[]
    const wanted = nodeIds ? new Set(nodeIds) : undefined
    return rows.map(row => NodeState.parse(JSON.parse(row.data))).filter(state => !wanted || wanted.has(state.nodeId))
  }

  /** The node's entries and those of identities merged into it, each once, oldest first, with the id each was found by. */
  private entries(nodeId: string, limit = 10_000): { entry: LogEntry; via: string }[] {
    const { current, merged } = this.ctx.learnKnowledge.identity(nodeId)
    const found = new Map<string, { entry: LogEntry; via: string }>()
    for (const id of current === nodeId ? [nodeId, ...merged] : [nodeId]) {
      for (const entry of this.ctx.learnCore.log.query({ nodeId: id, limit })) if (!found.has(entry.id)) found.set(entry.id, { entry, via: id })
    }
    return [...found.values()].sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))
  }

  evidence(nodeId: string, limit = 30): EvidenceRecord[] {
    const cited = new Set<string>(this.states([nodeId])[0]?.evidence ?? [])
    return this.entries(nodeId).slice(-limit).reverse().map(({ entry, via }) => {
      const record = describeEvidence(entry, cited.has(entry.id))
      return via === nodeId || entry.nodeIds.includes(nodeId as never) ? record : { ...record, node: this.ctx.learnKnowledge.node(via)?.title ?? '已合并的节点' }
    })
  }

  recompute(nodeIds?: readonly string[]): NodeState[] {
    const base = nodeIds ?? [...new Set([
      ...(this.sqlite.prepare('SELECT node_id FROM learner_states').all() as { node_id: string }[]).map(row => row.node_id),
      ...this.ctx.learnCore.log.query({ limit: 100_000 }).flatMap(entry => entry.nodeIds),
    ])]
    // An entry on a merged identity also changes the node it was merged into.
    const ids = [...new Set(base.flatMap(id => [id, this.ctx.learnKnowledge.identity(id).current]))]
    const changed: { nodeId: string; from: MasteryState | undefined; to: NodeState }[] = []
    const results = this.ctx.learnCore.db.transaction(() => ids.map(nodeId => {
      const previousRow = this.sqlite.prepare('SELECT data FROM learner_states WHERE node_id = ?').get(nodeId) as { data: string } | undefined
      const previous = previousRow ? NodeState.parse(JSON.parse(previousRow.data)) : undefined
      const next = deriveState(nodeId, this.entries(nodeId).map(item => item.entry), Date.now())
      this.sqlite.prepare(`INSERT INTO learner_states (node_id, state, data) VALUES (?, ?, ?)
        ON CONFLICT (node_id) DO UPDATE SET state = excluded.state, data = excluded.data`).run(nodeId, next.state, JSON.stringify(next))
      if (!previous || previous.state !== next.state || previous.doubtful !== next.doubtful || previous.needsReview !== next.needsReview) {
        changed.push({ nodeId, from: previous?.state, to: next })
      }
      return next
    }))
    for (const change of changed) this.ctx.emit('learning/node-state-changed', change)
    return results
  }
}

export function apply(ctx: Context): void {
  const learner = new LearnLearnerService(ctx)
  // Each state records the rules that derived it; after a rules change every state is derived again (decision #1).
  if (learner.states().some(state => state.rulesVersion !== learner.rulesVersion)) learner.recompute()

  ctx.on('learning/logged', entry => {
    if (entry.nodeIds.length) learner.recompute(entry.nodeIds)
  })
  // A merge or its undo changes which entries count for which node.
  ctx.on('learning/identity-changed', ({ nodeIds }) => { learner.recompute(nodeIds) })

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'learner',
    method: 'states',
    input: z.object({ nodeIds: z.array(z.string()).optional() }),
    handle: ({ nodeIds }) => learner.states(nodeIds),
  }), 'learner: states')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'learner',
    method: 'evidence',
    input: z.object({ nodeId: z.string(), limit: z.number().int().positive().max(100).optional() }),
    handle: ({ nodeId, limit }) => learner.evidence(nodeId, limit),
  }), 'learner: evidence')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'learner',
    method: 'recompute',
    handle: () => ({ count: learner.recompute().length, rulesVersion: learner.rulesVersion }),
  }), 'learner: recompute')

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const nodes = ctx.learnKnowledge.graph(request.courseId).nodes
    if (nodes.length === 0) return sections
    const states = new Map(learner.states(nodes.map(node => node.id)).map(state => [state.nodeId as string, state]))
    const groups = new Map<MasteryState, string[]>()
    const doubtful: string[] = [], unverified: string[] = []
    for (const node of nodes) {
      const all = states.get(node.id)
      // A node other courses share: this course's answers decide; others' are only a hint.
      const state = node.courseCount > 1 ? all?.courses.find(course => course.courseId === request.courseId) : all
      if (!state && all && all.state !== 'untested') { unverified.push(node.title); continue }
      const key = state?.state ?? 'untested'
      groups.set(key, [...(groups.get(key) ?? []), node.title])
      if (state?.doubtful) doubtful.push(node.title)
    }
    const order: MasteryState[] = ['conflict', 'not-yet', 'assisted', 'independent', 'retained', 'untested']
    const lines = order.filter(key => groups.has(key)).map(key => `${STATE_LABEL[key]}：${groups.get(key)!.join('、')}`)
    if (unverified.length) lines.push(`其他课程有作答记录、本课条件待验证：${unverified.join('、')}`)
    if (doubtful.length) lines.push(`有疑点：${doubtful.join('、')}`)
    return [...sections, { unit: 'learner', title: '掌握状态（只由作答证据决定）', text: lines.join('\n') }]
  })
}
