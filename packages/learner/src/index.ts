// learner unit, host half. Provides `ctx.learnLearner` (contracts §5.1): node mastery states derived from the
// evidence log only (rules.ts, docs/learner/design.md). States are a cache: deleting them and recomputing gives
// the same result (decision #1). A merged identity's entries count for the node it was merged into; they keep
// the id they were logged with (docs/knowledge/design.md, C).
import { Service, type Context } from '@deepseek-ai/cordis'
import { NodeState, type EvidenceRecord, type LearnLearner, type LogEntry, type MasteryState, type Migration } from '@learning-agent/contracts'
import { z } from 'zod'
import { describeEvidence } from './evidence.ts'
import { RULES_VERSION, deriveState, judge, reviewDue } from './rules.ts'

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
    version: 2,
    sql: `
      -- What the states were derived from: the rules version and how many log entries had been read.
      CREATE TABLE learner_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
]

/** Log entries read per query. */
const PAGE = 5000
const STALE = 'stale'

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

  private setMeta(key: string, value: string): void {
    this.sqlite.prepare('INSERT INTO learner_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  /** States as stored, with 待复查 worked out for now. */
  states(nodeIds?: readonly string[]): NodeState[] {
    const rows = (nodeIds
      ? nodeIds.length ? this.sqlite.prepare(`SELECT data FROM learner_states WHERE node_id IN (${nodeIds.map(() => '?').join(', ')})`).all(...nodeIds) : []
      : this.sqlite.prepare('SELECT data FROM learner_states').all()) as { data: string }[]
    const now = Date.now()
    return rows.map(row => {
      const state = NodeState.parse(JSON.parse(row.data))
      return { ...state, needsReview: reviewDue(state, now), courses: state.courses.map(course => ({ ...course, needsReview: reviewDue(course, now) })) }
    })
  }

  /** Every entry matching the query, a page at a time. */
  private *read(query: { readonly nodeId?: string }): Generator<LogEntry> {
    for (let after: string | undefined; ;) {
      const page = this.ctx.learnCore.log.query({ ...query, ...(after ? { after } : {}), limit: PAGE })
      yield* page
      if (page.length < PAGE) return
      after = page.at(-1)!.id
    }
  }

  /** The node's entries and those of identities merged into it, each once, with the id each was found by. */
  private entries(nodeId: string): { entry: LogEntry; via: string }[] {
    const { current, merged } = this.ctx.learnKnowledge.identity(nodeId)
    const found = new Map<string, { entry: LogEntry; via: string }>()
    for (const id of current === nodeId ? [nodeId, ...merged] : [nodeId]) {
      for (const entry of this.read({ nodeId: id })) if (!found.has(entry.id)) found.set(entry.id, { entry, via: id })
    }
    return [...found.values()]
  }

  private current = (nodeId: string) => this.ctx.learnKnowledge.identity(nodeId).current

  evidence(nodeId: string, limit = 30, courseId?: string): EvidenceRecord[] {
    const found = this.entries(nodeId)
    const entries = found.map(item => item.entry)
    const derived = deriveState(nodeId, entries, Date.now(), this.current)
    const scope = courseId ? derived.courses.find(course => course.courseId === courseId) : derived
    const cited = new Set<string>(scope?.evidence ?? [])
    const judged = new Map(judge(entries, this.current).map(item => [item.entry.id as string, item]))
    // A regrade shows on the answer it corrects; the answers of a problem found wrong say so.
    return found
      .filter(({ entry }) => entry.type !== 'attempt.regraded' && (entry.type !== 'attempt.graded' || judged.has(entry.id)))
      .sort((a, b) => Date.parse(a.entry.at) - Date.parse(b.entry.at) || (a.entry.id < b.entry.id ? -1 : 1))
      .slice(-limit).reverse()
      .map(({ entry, via }) => {
        const record = describeEvidence(entry, cited.has(entry.id), judged.get(entry.id))
        return via === nodeId || entry.nodeIds.includes(nodeId as never) ? record : { ...record, node: this.ctx.learnKnowledge.node(via)?.title ?? '已合并的节点' }
      })
  }

  /**
   * Derive the given nodes again (and the nodes they were merged into), or every node from the whole log. Either
   * all of them are written or none.
   */
  recompute(nodeIds?: readonly string[]): NodeState[] {
    const now = Date.now()
    const derived: NodeState[] = []
    if (nodeIds) {
      // An entry on a merged identity also changes the node it was merged into.
      for (const nodeId of new Set(nodeIds.flatMap(id => [id, this.current(id)]))) {
        derived.push(deriveState(nodeId, this.entries(nodeId).map(item => item.entry), now, this.current))
      }
    } else {
      // The whole log once, each entry in its own node's bucket and in the one its node was merged into.
      const current = new Map<string, string>()
      const currentOf = (id: string) => current.get(id) ?? current.set(id, this.current(id)).get(id)!
      const buckets = new Map<string, Map<string, LogEntry>>()
      for (const row of this.sqlite.prepare('SELECT node_id FROM learner_states').all() as { node_id: string }[]) buckets.set(row.node_id, new Map())
      for (const entry of this.read({})) {
        for (const id of entry.nodeIds) {
          for (const key of new Set([id, currentOf(id)])) {
            const bucket = buckets.get(key) ?? buckets.set(key, new Map()).get(key)!
            bucket.set(entry.id, entry)
          }
        }
      }
      for (const [nodeId, bucket] of buckets) derived.push(deriveState(nodeId, [...bucket.values()], now, currentOf))
    }
    const changed: { nodeId: string; from: MasteryState | undefined; to: NodeState }[] = []
    this.ctx.learnCore.db.transaction(() => {
      for (const next of derived) {
        const row = this.sqlite.prepare('SELECT data FROM learner_states WHERE node_id = ?').get(next.nodeId) as { data: string } | undefined
        const previous = row ? NodeState.parse(JSON.parse(row.data)) : undefined
        this.sqlite.prepare(`INSERT INTO learner_states (node_id, state, data) VALUES (?, ?, ?)
          ON CONFLICT (node_id) DO UPDATE SET state = excluded.state, data = excluded.data`).run(next.nodeId, next.state, JSON.stringify(next))
        if (!previous || previous.state !== next.state || previous.doubtful !== next.doubtful || previous.explanation !== next.explanation) {
          changed.push({ nodeId: next.nodeId, from: previous?.state, to: next })
        }
      }
      if (!nodeIds) this.setMeta('rules', RULES_VERSION)
      // After a failed update only a full recompute catches up.
      if (!nodeIds || this.meta('read') !== STALE) this.setMeta('read', String(this.ctx.learnCore.log.count()))
    })
    for (const change of changed) this.ctx.emit('learning/node-state-changed', change)
    return derived
  }

  /**
   * Derive everything again when the states may not match the log: other rules, an empty or partial table, or
   * entries whose event was not handled (the log grew past what was read). Returns whether it did.
   */
  /** An update failed: the states may miss entries until everything is derived again. */
  markStale(): void {
    this.setMeta('read', STALE)
  }

  reconcile(): boolean {
    if (this.meta('rules') === RULES_VERSION && this.meta('read') === String(this.ctx.learnCore.log.count())) return false
    this.recompute()
    return true
  }
}

export function apply(ctx: Context): void {
  const learner = new LearnLearnerService(ctx)
  const logger = ctx.logger('learning-learner')
  learner.reconcile()

  // A failed update marks the states stale, so the next start derives everything again.
  const update = (nodeIds: readonly string[]) => {
    try {
      learner.recompute(nodeIds)
    } catch (error) {
      logger.warn('mastery recompute failed: %s', (error as Error).stack ?? error)
      try {
        learner.markStale()
      } catch {
        // The database itself is failing; the read count was not advanced either, so the next start still catches up.
      }
    }
  }
  ctx.on('learning/logged', entry => {
    if (entry.nodeIds.length) update(entry.nodeIds)
  })
  // A merge or its undo changes which entries count for which node.
  ctx.on('learning/identity-changed', ({ nodeIds }) => update(nodeIds))

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'learner',
    method: 'states',
    input: z.object({ nodeIds: z.array(z.string()).optional() }),
    handle: ({ nodeIds }) => learner.states(nodeIds),
  }), 'learner: states')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'learner',
    method: 'evidence',
    input: z.object({ nodeId: z.string(), limit: z.number().int().positive().max(100).optional(), courseId: z.string().optional() }),
    handle: ({ nodeId, limit, courseId }) => learner.evidence(nodeId, limit, courseId),
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
    const doubtful: string[] = [], unverified: string[] = [], review: string[] = []
    for (const node of nodes) {
      const all = states.get(node.id)
      // A node other courses share: this course's answers decide; others' are only a hint.
      const state = node.courseCount > 1 ? all?.courses.find(course => course.courseId === request.courseId) : all
      if (!state && all && all.state !== 'untested') { unverified.push(node.title); continue }
      const key = state?.state ?? 'untested'
      groups.set(key, [...(groups.get(key) ?? []), node.title])
      if (state?.doubtful) doubtful.push(node.title)
      if (state?.needsReview) review.push(node.title)
    }
    const order: MasteryState[] = ['conflict', 'not-yet', 'assisted', 'independent', 'retained', 'untested']
    const lines = order.filter(key => groups.has(key)).map(key => `${STATE_LABEL[key]}：${groups.get(key)!.join('、')}`)
    if (unverified.length) lines.push(`其他课程有作答记录、本课条件待验证：${unverified.join('、')}`)
    if (doubtful.length) lines.push(`有疑点（上次独立答对后又反复问到，或有可能的误解）：${doubtful.join('、')}`)
    if (review.length) lines.push(`待复查（最近一次独立答对在 14 天前）：${review.join('、')}`)
    return [...sections, { unit: 'learner', title: '掌握状态（只由作答证据决定）', text: lines.join('\n') }]
  })
}
