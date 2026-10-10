// learner unit, host half. Provides `ctx.learnLearner` (contracts §5.1): node mastery states derived
// from the evidence log only. States are a cache: deleting them and recomputing gives the same
// result (decision #1). Rules live in rules.ts. A merged identity's entries count for the
// node it was merged into; they keep the id they were logged with (docs/knowledge/design.md, C).
// The log is read whole, page by page, and the cache records how far it has read (the watermark), so a
// restart, a lost event or a cleared table is made good from the log; a failed recompute is reported, never hidden.
import { Service, type Context } from '@deepseek-ai/cordis'
import { NodeState, type EvidenceRecord, type LearnLearner, type LearnerStatus, type LogEntry, type LogQuery, type MasteryState, type Migration } from '@learning-agent/contracts'
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
  {
    // What the cache has read of the log (`watermark`: the last log id every state includes), the nodes still to
    // recompute after a failure (`dirty`), the last failure, and the rules the states came from.
    version: 2,
    sql: `
      CREATE TABLE learner_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
]

/** Entries read from the log per query. */
const PAGE = 2_000

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

  private meta(key: string): string | undefined {
    return (this.sqlite.prepare('SELECT value FROM learner_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
  }

  private setMeta(key: string, value: string | undefined): void {
    if (value === undefined) this.sqlite.prepare('DELETE FROM learner_meta WHERE key = ?').run(key)
    else this.sqlite.prepare('INSERT INTO learner_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  private dirty(): string[] {
    return JSON.parse(this.meta('dirty') ?? '[]') as string[]
  }

  states(nodeIds?: readonly string[]): NodeState[] {
    const rows = this.sqlite.prepare('SELECT data FROM learner_states').all() as { data: string }[]
    const wanted = nodeIds ? new Set(nodeIds) : undefined
    return rows.map(row => NodeState.parse(JSON.parse(row.data))).filter(state => !wanted || wanted.has(state.nodeId))
  }

  /** Every entry the query matches, oldest first, a page at a time: nothing is cut off at the end. */
  private *pages(query: Omit<LogQuery, 'limit'>): Generator<LogEntry[]> {
    let after = query.after
    for (;;) {
      const page = this.ctx.learnCore.log.query({ ...query, ...(after ? { after } : {}), limit: PAGE })
      if (page.length === 0) return
      yield page
      if (page.length < PAGE) return
      after = page.at(-1)!.id
    }
  }

  /** The node's entries and those of identities merged into it, each once, oldest first, with the id each was found by. */
  private entries(nodeId: string): { entry: LogEntry; via: string }[] {
    const { current, merged } = this.ctx.learnKnowledge.identity(nodeId)
    const found = new Map<string, { entry: LogEntry; via: string }>()
    for (const id of current === nodeId ? [nodeId, ...merged] : [nodeId]) {
      for (const page of this.pages({ nodeId: id })) for (const entry of page) if (!found.has(entry.id)) found.set(entry.id, { entry, via: id })
    }
    return [...found.values()].sort((a, b) => (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0))
  }

  evidence(nodeId: string, limit = 30): EvidenceRecord[] {
    const state = this.states([nodeId])[0]
    const cited = new Set<string>(state?.evidence ?? [])
    const notes = new Map((state?.excluded ?? []).map(item => [item.id as string, item.reason]))
    return this.entries(nodeId).slice(-limit).reverse().map(({ entry, via }) => {
      const record = describeEvidence(entry, cited.has(entry.id), notes.get(entry.id))
      return via === nodeId || entry.nodeIds.includes(nodeId as never) ? record : { ...record, node: this.ctx.learnKnowledge.node(via)?.title ?? '已合并的节点' }
    })
  }

  status(): LearnerStatus {
    const watermark = this.meta('watermark')
    const failure = this.meta('failed')
    const behind = this.dirty().length > 0 || this.ctx.learnCore.log.query({ ...(watermark ? { after: watermark } : {}), limit: 1 }).length > 0
    return {
      rulesVersion: RULES_VERSION,
      ...(watermark ? { computedThrough: watermark } : {}),
      behind,
      ...(failure ? { failed: JSON.parse(failure) as NonNullable<LearnerStatus['failed']> } : {}),
    }
  }

  /**
   * Derive the nodes again and publish them together with the watermark and the cleared failure in one
   * transaction: a failure leaves the states, the watermark and the failure note as they were.
   */
  private compute(nodeIds: readonly string[], publish?: { watermark: string }): NodeState[] {
    // An entry on a merged identity also changes the node it was merged into.
    const ids = [...new Set(nodeIds.flatMap(id => [id, this.ctx.learnKnowledge.identity(id).current]))]
    const changed: { nodeId: string; from: MasteryState | undefined; to: NodeState }[] = []
    const results = this.ctx.learnCore.db.transaction(() => {
      const out = ids.map(nodeId => {
        const previousRow = this.sqlite.prepare('SELECT data FROM learner_states WHERE node_id = ?').get(nodeId) as { data: string } | undefined
        const previous = previousRow ? NodeState.parse(JSON.parse(previousRow.data)) : undefined
        const next = deriveState(nodeId, this.entries(nodeId).map(item => item.entry), Date.now())
        this.sqlite.prepare(`INSERT INTO learner_states (node_id, state, data) VALUES (?, ?, ?)
          ON CONFLICT (node_id) DO UPDATE SET state = excluded.state, data = excluded.data`).run(nodeId, next.state, JSON.stringify(next))
        if (!previous || previous.state !== next.state || previous.doubtful !== next.doubtful || previous.needsReview !== next.needsReview) {
          changed.push({ nodeId, from: previous?.state, to: next })
        }
        return next
      })
      if (publish) {
        this.setMeta('watermark', publish.watermark)
        this.setMeta('rulesVersion', RULES_VERSION)
        this.setMeta('dirty', undefined)
        this.setMeta('failed', undefined)
      }
      return out
    })
    for (const change of changed) this.ctx.emit('learning/node-state-changed', change)
    return results
  }

  /** Remember a failed recompute: the states shown are from before, and `nodes` are made good by the next catch-up. */
  private fail(error: unknown, nodes: readonly string[]): void {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 200)
    this.setMeta('failed', JSON.stringify({ at: new Date().toISOString(), error: message }))
    if (nodes.length) this.setMeta('dirty', JSON.stringify([...new Set([...this.dirty(), ...nodes])]))
  }

  recompute(nodeIds?: readonly string[]): NodeState[] {
    let nodes: string[] = [...(nodeIds ?? [])]
    try {
      if (nodeIds) return this.compute(nodeIds)
      // Everything: the nodes with a state and every node any log entry mentions, up to the log's end now.
      let watermark = ''
      const all = new Set<string>((this.sqlite.prepare('SELECT node_id FROM learner_states').all() as { node_id: string }[]).map(row => row.node_id))
      for (const page of this.pages({})) {
        for (const entry of page) for (const id of entry.nodeIds) all.add(id)
        watermark = page.at(-1)!.id
      }
      nodes = [...all]
      return this.compute(nodes, { watermark })
    } catch (error) {
      this.fail(error, nodes)
      throw error
    }
  }

  /** Make the states include everything logged since the watermark, and the nodes a failure left behind. */
  catchUp(): void {
    const watermark = this.meta('watermark') ?? ''
    const nodes = new Set(this.dirty())
    let last = watermark
    try {
      for (const page of this.pages(watermark ? { after: watermark } : {})) {
        for (const entry of page) for (const id of entry.nodeIds) nodes.add(id)
        last = page.at(-1)!.id
      }
      if (last === watermark && nodes.size === 0) return
      this.compute([...nodes], { watermark: last })
    } catch (error) {
      this.fail(error, [...nodes])
      throw error
    }
  }

  /** The rest of the plugin never sees a failure here: it is in `status()`, and an event handler that threw would break the unit that logged. */
  safely(run: () => unknown): void {
    try { run() } catch (error) { this.ctx.logger('learning-learner').warn(`recompute failed: ${error instanceof Error ? error.message : String(error)}`) }
  }

  /** At start: everything again when the cache is from other rules, was never filled or was emptied; else only what the log added. */
  start(): void {
    const unfilled = this.meta('watermark') === undefined || this.meta('rulesVersion') !== RULES_VERSION
    const states = this.states()
    const emptied = states.length === 0 && this.ctx.learnCore.log.query({ limit: 1 }).length > 0
    this.safely(() => (unfilled || emptied || states.some(state => state.rulesVersion !== RULES_VERSION) ? this.recompute() : this.catchUp()))
  }
}

export function apply(ctx: Context): void {
  const learner = new LearnLearnerService(ctx)
  // Each state records the rules that derived it; after a rules change every state is derived again (decision #1).
  learner.start()

  // Catching up reads what the log gained since the watermark, so an event that never arrived is made good by the next.
  ctx.on('learning/logged', () => { learner.safely(() => learner.catchUp()) })
  // A merge or its undo changes which entries count for which node.
  ctx.on('learning/identity-changed', ({ nodeIds }) => { learner.safely(() => learner.recompute(nodeIds)) })

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
    method: 'status',
    handle: () => learner.status(),
  }), 'learner: status')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'learner',
    method: 'recompute',
    handle: () => ({ count: learner.recompute().length, rulesVersion: learner.rulesVersion }),
  }), 'learner: recompute')

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const nodes = ctx.learnKnowledge.graph(request.courseId).nodes
    if (nodes.length === 0) return sections
    const status = learner.status()
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
    if (status.failed || status.behind) lines.push(status.failed ? `注意：掌握状态上次重算失败（${status.failed.error}），上面可能不是最新的。` : '注意：掌握状态还没更新到最新的作答，上面可能不是最新的。')
    return [...sections, { unit: 'learner', title: '掌握状态（只由作答证据决定）', text: lines.join('\n') }]
  })
}
