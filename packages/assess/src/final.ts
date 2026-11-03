// Final checks (docs/curriculum/design.md, 结课): assembled by rule from reserved problems new to the
// learner, at least one per goal "can do" item, and reported per item. Pure, like stage.ts.
import type { FinalPlan, FinalReport, NodeOutcome, Problem, ProbeNode } from '@learning-agent/contracts'
import { answerNotes, covers, outcomeOf, reportVerdict, type AnswerOf } from './stage.ts'

export interface FinalItem {
  readonly key: string
  readonly text: string
  /** What the goal item asked for when the check was published (its `rev`). */
  readonly rev?: number
  readonly nodes: readonly ProbeNode[]
}

/**
 * Pick from `fresh`: for each goal item in order, a problem on its nodes unless one already picked covers
 * it — a complete task first, then the one covering most of its nodes; then up to two on the carried
 * nodes not covered yet. Items left without a problem (none fresh, or `max` reached) are `uncovered`.
 * Order: the others first, complete tasks last.
 */
export function assembleFinal(items: readonly FinalItem[], risks: readonly ProbeNode[], fresh: readonly Problem[], max: number): Omit<FinalPlan, 'risks' | 'stageIds' | 'skipped'> & { problemIds: string[] } {
  const used: Problem[] = []
  const on = (problem: Problem, nodes: readonly ProbeNode[]) => nodes.filter(node => covers(problem, node)).length
  const planned = items.map(item => {
    const mine = used.filter(problem => on(problem, item.nodes) > 0)
    if (mine.length === 0 && used.length < max) {
      const best = fresh.filter(problem => !used.includes(problem) && on(problem, item.nodes) > 0)
        .sort((a, b) => Number(b.size === 'task') - Number(a.size === 'task') || on(b, item.nodes) - on(a, item.nodes) || a.id.localeCompare(b.id))[0]
      if (best) { used.push(best); mine.push(best) }
    }
    return { key: item.key, text: item.text, ...(item.rev ? { rev: item.rev } : {}), nodes: [...item.nodes], problemIds: mine.map(problem => problem.id) as FinalPlan['items'][number]['problemIds'] }
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

/**
 * A final check of named problems: each item takes those on its nodes; `stray` are the ones asking neither an item's
 * node nor a carried one. Items none of them asks are `uncovered`.
 */
export function namedFinalPlan(items: readonly FinalItem[], risks: readonly ProbeNode[], given: readonly Problem[]): Omit<FinalPlan, 'risks' | 'stageIds' | 'skipped'> & { stray: string[] } {
  const planned = items.map(item => ({ key: item.key, text: item.text, ...(item.rev ? { rev: item.rev } : {}), nodes: [...item.nodes], problemIds: given.filter(problem => item.nodes.some(node => covers(problem, node))).map(problem => problem.id) as FinalPlan['items'][number]['problemIds'] }))
  return {
    items: planned,
    uncovered: planned.filter(item => item.problemIds.length === 0).map(item => item.key),
    stray: given.filter(problem => !items.some(item => item.nodes.some(node => covers(problem, node))) && !risks.some(node => covers(problem, node))).map(problem => problem.id),
  }
}

/**
 * Per goal item, from its problems' answers as they count now (`outcomeOf`: partly right or helped does not pass); the
 * carried nodes' problems apart. `raw`: the gradings alone, without learner's effective evidence.
 */
export function finalReport(plan: Pick<FinalPlan, 'items' | 'risks' | 'uncovered' | 'skipped'>, problemIds: readonly string[], problemOf: (id: string) => Pick<Problem, 'nodeIds'> | undefined, answerOf: AnswerOf, raw = false): FinalReport {
  const number = (id: string) => problemIds.indexOf(id) + 1
  const items = plan.items.filter(item => item.problemIds.length > 0).map(item => {
    const answered = item.problemIds.flatMap(id => { const answer = answerOf(id); return answer ? [{ answer, number: number(id) }] : [] })
    const notes = answerNotes(answered)
    return {
      key: item.key,
      text: item.text,
      ...(item.rev ? { rev: item.rev } : {}),
      outcome: outcomeOf(answered.map(entry => entry.answer)),
      problems: item.problemIds.map(number).filter(value => value > 0),
      ...(notes.length ? { notes } : {}),
    }
  })
  const inItems = new Set(plan.items.flatMap(item => item.problemIds as string[]))
  const risks = problemIds.filter(id => !inItems.has(id)).flatMap(id => {
    const problem = problemOf(id)
    const node = problem ? plan.risks.find(candidate => covers(problem, candidate)) : undefined
    return node ? [{ nodeId: node.id as string, title: node.title, number: number(id), ...reportVerdict(answerOf(id, node)) }] : []
  })
  return {
    items,
    risks,
    uncovered: plan.items.filter(item => plan.uncovered.includes(item.key)).map(item => ({ key: item.key, text: item.text, ...(plan.skipped.includes(item.key) ? { skipped: true } : {}) })),
    ...(raw ? { raw: true } : {}),
  }
}

const OUTCOME_WORD: Record<NodeOutcome, string> = { pass: '做到', assisted: '有帮助做到', fail: '没做到', mixed: '有对有错', pending: '待复核', insufficient: '没答' }

/** "做到：…；没做到：…" for handoffs, briefs and the test list. */
export function finalReportText(report: FinalReport): string {
  const groups = (['pass', 'fail', 'mixed', 'pending', 'insufficient'] as const).flatMap(outcome => {
    const items = report.items.filter(item => item.outcome === outcome)
    return items.length ? [`${OUTCOME_WORD[outcome]}：${items.map(item => item.text).join('；')}`] : []
  })
  const notes = [...new Set(report.items.flatMap(item => item.notes ?? []))]
  return [
    ...groups,
    ...(report.uncovered.length ? [`没测到：${report.uncovered.map(item => `${item.text}${item.skipped ? '（题报告有问题，换题次数用完）' : ''}`).join('；')}`] : []),
    ...(notes.length ? [`说明：${notes.join('；')}`] : []),
    ...(report.raw ? ['（按原始判分算，没算有效证据）'] : []),
  ].join('。')
}
