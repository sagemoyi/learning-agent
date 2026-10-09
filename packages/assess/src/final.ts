// Final checks (docs/curriculum/design.md, 结课): assembled by rule from reserved problems new to the
// learner, at least one per goal "can do" item, and reported per item. Pure, like stage.ts.
import type { FinalPlan, FinalReport, NodeOutcome, Problem, ProbeNode, Verdict } from '@learning-agent/contracts'
import { covers } from './stage.ts'

export interface FinalItem {
  readonly key: string
  readonly text: string
  readonly nodes: readonly ProbeNode[]
}

/**
 * Pick from `fresh`: for each goal item in order, a problem on its nodes unless one already picked covers
 * it — a complete task first, then the one covering most of its nodes; then up to two on the carried
 * nodes not covered yet. Items left without a problem (none fresh, or `max` reached) are `uncovered`.
 * Order: the others first, complete tasks last.
 */
export function assembleFinal(items: readonly FinalItem[], risks: readonly ProbeNode[], fresh: readonly Problem[], max: number): Omit<FinalPlan, 'risks' | 'stageIds'> & { problemIds: string[] } {
  const used: Problem[] = []
  const on = (problem: Problem, nodes: readonly ProbeNode[]) => nodes.filter(node => covers(problem, node)).length
  const planned = items.map(item => {
    const mine = used.filter(problem => on(problem, item.nodes) > 0)
    if (mine.length === 0 && used.length < max) {
      const best = fresh.filter(problem => !used.includes(problem) && on(problem, item.nodes) > 0)
        .sort((a, b) => Number(b.size === 'task') - Number(a.size === 'task') || on(b, item.nodes) - on(a, item.nodes) || a.id.localeCompare(b.id))[0]
      if (best) { used.push(best); mine.push(best) }
    }
    return { key: item.key, text: item.text, nodes: [...item.nodes], problemIds: mine.map(problem => problem.id) as FinalPlan['items'][number]['problemIds'] }
  })
  let extra = 0
  for (const node of risks) {
    if (extra >= 2 || used.length >= max || used.some(problem => covers(problem, node))) continue
    const pick = fresh.filter(problem => !used.includes(problem) && covers(problem, node)).sort((a, b) => Number(a.size === 'task') - Number(b.size === 'task') || a.id.localeCompare(b.id))[0]
    if (pick) { used.push(pick); extra += 1 }
  }
  const ordered = [...used.filter(problem => problem.size !== 'task'), ...used.filter(problem => problem.size === 'task')]
  return {
    problemIds: ordered.map(problem => problem.id),
    items: planned,
    uncovered: planned.filter(item => item.problemIds.length === 0).map(item => item.key),
  }
}

function outcomeOf(verdicts: readonly Verdict[]): NodeOutcome {
  const decided = verdicts.filter(verdict => verdict !== 'pending-review')
  const right = decided.filter(verdict => verdict === 'correct').length
  if (verdicts.length === 0) return 'insufficient'
  if (decided.length < verdicts.length && (right === 0 || right === decided.length)) return 'pending'
  return right === decided.length ? 'pass' : right === 0 ? 'fail' : 'mixed'
}

/** Per goal item, from its problems in the test (partly right does not pass); the carried nodes' problems apart. */
export function finalReport(plan: Pick<FinalPlan, 'items' | 'risks' | 'uncovered'>, problemIds: readonly string[], problemOf: (id: string) => Pick<Problem, 'nodeIds'> | undefined, verdictOf: (problemId: string) => Verdict | undefined): FinalReport {
  const number = (id: string) => problemIds.indexOf(id) + 1
  const items = plan.items.filter(item => item.problemIds.length > 0).map(item => ({
    key: item.key,
    text: item.text,
    outcome: outcomeOf(item.problemIds.flatMap(id => { const verdict = verdictOf(id); return verdict ? [verdict] : [] })),
    problems: item.problemIds.map(number).filter(value => value > 0),
  }))
  const inItems = new Set(plan.items.flatMap(item => item.problemIds as string[]))
  const risks = problemIds.filter(id => !inItems.has(id)).flatMap(id => {
    const problem = problemOf(id)
    const node = problem ? plan.risks.find(candidate => covers(problem, candidate)) : undefined
    const verdict = verdictOf(id)
    return node ? [{ nodeId: node.id as string, title: node.title, number: number(id), ...(verdict ? { verdict } : {}) }] : []
  })
  return { items, risks, uncovered: plan.items.filter(item => plan.uncovered.includes(item.key)).map(item => ({ key: item.key, text: item.text })) }
}

const OUTCOME_WORD: Record<NodeOutcome, string> = { pass: '做到', fail: '没做到', mixed: '有对有错', pending: '待复核', insufficient: '没答' }

/** "做到：…；没做到：…" for handoffs, briefs and the test list. */
export function finalReportText(report: FinalReport): string {
  const groups = (['pass', 'fail', 'mixed', 'pending', 'insufficient'] as const).flatMap(outcome => {
    const items = report.items.filter(item => item.outcome === outcome)
    return items.length ? [`${OUTCOME_WORD[outcome]}：${items.map(item => item.text).join('；')}`] : []
  })
  return [...groups, ...(report.uncovered.length ? [`没测到：${report.uncovered.map(item => item.text).join('；')}`] : [])].join('。')
}
