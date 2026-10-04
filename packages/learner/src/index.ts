// learner unit, host half. Provides `ctx.learnLearner` (contracts §5.1): node mastery states derived
// from the evidence log only. States are a cache: deleting them and recomputing gives the same
// result (decision #1). Skeleton rules live in rules.ts.
import { Service, type Context } from '@deepseek-ai/cordis'
import { NodeState, type LearnLearner, type MasteryState, type Migration } from '@learning-agent/contracts'
import { z } from 'zod'
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
  untested: '未探测', 'not-yet': '尚未掌握', assisted: '有帮助完成', independent: '已独立完成', retained: '已延迟验证', conflict: '证据冲突',
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

  recompute(nodeIds?: readonly string[]): NodeState[] {
    const ids = nodeIds ?? [...new Set([
      ...(this.sqlite.prepare('SELECT node_id FROM learner_states').all() as { node_id: string }[]).map(row => row.node_id),
      ...this.ctx.learnCore.log.query({ limit: 100_000 }).flatMap(entry => entry.nodeIds),
    ])]
    const changed: { nodeId: string; from: MasteryState | undefined; to: NodeState }[] = []
    const results = this.ctx.learnCore.db.transaction(() => ids.map(nodeId => {
      const previousRow = this.sqlite.prepare('SELECT data FROM learner_states WHERE node_id = ?').get(nodeId) as { data: string } | undefined
      const previous = previousRow ? NodeState.parse(JSON.parse(previousRow.data)) : undefined
      const next = deriveState(nodeId, this.ctx.learnCore.log.query({ nodeId, limit: 10_000 }), Date.now())
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

  ctx.on('learning/logged', entry => {
    if (entry.nodeIds.length) learner.recompute(entry.nodeIds)
  })

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'learner',
    method: 'states',
    input: z.object({ nodeIds: z.array(z.string()).optional() }),
    handle: ({ nodeIds }) => learner.states(nodeIds),
  }), 'learner: states')

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
    const doubtful: string[] = []
    for (const node of nodes) {
      const state = states.get(node.id)
      const key = state?.state ?? 'untested'
      groups.set(key, [...(groups.get(key) ?? []), node.title])
      if (state?.doubtful) doubtful.push(node.title)
    }
    const order: MasteryState[] = ['conflict', 'not-yet', 'assisted', 'independent', 'retained', 'untested']
    const lines = order.filter(key => groups.has(key)).map(key => `${STATE_LABEL[key]}：${groups.get(key)!.join('、')}`)
    if (doubtful.length) lines.push(`有疑点：${doubtful.join('、')}`)
    return [...sections, { unit: 'learner', title: '掌握状态（只由作答证据决定）', text: lines.join('\n') }]
  })
}
