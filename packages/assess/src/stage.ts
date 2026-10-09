// Stage tests (docs/assess/design.md, B): assembled by rule from reserved problems new to the learner,
// and reported per core node instead of a pass mark on the total. Pure, like adaptive.ts.
import type { NodeOutcome, Problem, ProbeNode, StagePlan, StageReport, Verdict } from '@learning-agent/contracts'

export function covers(problem: Pick<Problem, 'nodeIds'>, node: ProbeNode): boolean {
  return problem.nodeIds.some(id => id === node.id || node.also.includes(id))
}

const SIZE_ORDER: Record<Problem['size'], number> = { standard: 0, check: 1, task: 2 }

/**
 * Pick from `fresh` (active reserved problems the learner has not met): one complete task, then for each
 * core node a problem of its own (the task alone would leave a wrong answer without a clue to which node
 * failed), covering the most nodes first, then up to two on earlier stages' nodes, in the blueprint's
 * order. A slot is kept for an earlier stage when it has a problem. Order: core, earlier, the task last. `uncovered`: core nodes
 * neither the task nor another problem covers.
 */
export function assemble(blueprint: { readonly core: readonly ProbeNode[]; readonly earlier: readonly ProbeNode[] }, fresh: readonly Problem[], max: number): { problemIds: string[]; task?: string; uncovered: string[] } {
  const coreOf = (problem: Problem) => blueprint.core.filter(node => covers(problem, node))
  const task = fresh.filter(problem => problem.size === 'task' && coreOf(problem).length > 0)
    .sort((a, b) => coreOf(b).length - coreOf(a).length || a.id.localeCompare(b.id))[0]
  const used = new Set<string>(task ? [task.id] : [])
  const uncovered = new Set(blueprint.core.map(node => node.id as string))
  // Earlier nodes in the blueprint's order of priority (nodes earlier reviews carried on first).
  const rank = (problem: Problem) => blueprint.earlier.findIndex(node => covers(problem, node))
  const earlierPool = fresh.filter(problem => problem.size !== 'task' && coreOf(problem).length === 0 && rank(problem) >= 0).sort((a, b) => rank(a) - rank(b))
  const budget = max - (task ? 1 : 0) - (earlierPool.length ? 1 : 0)
  const body: Problem[] = []
  while (uncovered.size > 0 && body.length < budget) {
    const gain = (problem: Problem) => coreOf(problem).filter(node => uncovered.has(node.id)).length
    const best = fresh.filter(problem => !used.has(problem.id) && problem.size !== 'task' && gain(problem) > 0)
      .sort((a, b) => gain(b) - gain(a) || SIZE_ORDER[a.size] - SIZE_ORDER[b.size] || a.id.localeCompare(b.id))[0]
    if (!best) break
    body.push(best)
    used.add(best.id)
    for (const node of coreOf(best)) uncovered.delete(node.id)
  }
  // Earlier stages: one problem per node, two at most (delayed verification, not the whole course again).
  const earlier: Problem[] = []
  const earlierNodes = new Set<string>()
  for (const problem of earlierPool) {
    if (earlier.length >= Math.min(2, max - body.length - (task ? 1 : 0))) break
    const node = blueprint.earlier.find(candidate => covers(problem, candidate))!
    if (used.has(problem.id) || earlierNodes.has(node.id)) continue
    earlier.push(problem)
    earlierNodes.add(node.id)
    used.add(problem.id)
  }
  return {
    problemIds: [...body, ...earlier, ...(task ? [task] : [])].map(problem => problem.id),
    ...(task ? { task: task.id } : {}),
    uncovered: [...uncovered].filter(id => !task || !coreOf(task).some(node => node.id === id)),
  }
}

/**
 * Per core node, from its new problems in the test: pass when all were right, fail when none was, mixed
 * when both, pending while one waits for review, insufficient without a new problem answered. Partly
 * right (e.g. the unit missing) does not pass.
 */
export function stageReport(plan: StagePlan, problems: readonly Pick<Problem, 'id' | 'nodeIds'>[], verdictOf: (problemId: string) => Verdict | undefined): StageReport {
  const numbered = problems.map((problem, index) => ({ problem, number: index + 1 }))
  const nodes = plan.core.map(node => {
    const mine = numbered.filter(({ problem }) => covers(problem, node))
    const verdicts = mine.filter(({ problem }) => plan.fresh.includes(problem.id as never)).flatMap(({ problem }) => {
      const verdict = verdictOf(problem.id)
      return verdict ? [verdict] : []
    })
    const decided = verdicts.filter(verdict => verdict !== 'pending-review')
    const right = decided.filter(verdict => verdict === 'correct').length
    const outcome: NodeOutcome = verdicts.length === 0 ? 'insufficient'
      : decided.length < verdicts.length && (right === 0 || right === decided.length) ? 'pending'
        : right === decided.length ? 'pass'
          : right === 0 ? 'fail' : 'mixed'
    return { nodeId: node.id as string, title: node.title, outcome, problems: mine.map(({ number }) => number) }
  })
  const task = numbered.find(({ problem }) => problem.id === plan.task)
  const earlier = numbered.flatMap(({ problem, number }) => {
    if (plan.core.some(node => covers(problem, node))) return []
    const node = plan.earlier.find(candidate => covers(problem, candidate))
    const verdict = verdictOf(problem.id)
    return node ? [{ nodeId: node.id as string, title: node.title, number, ...(verdict ? { verdict } : {}) }] : []
  })
  const taskVerdict = task ? verdictOf(task.problem.id) : undefined
  return {
    nodes,
    ...(task ? { task: { number: task.number, ...(taskVerdict ? { verdict: taskVerdict } : {}) } } : {}),
    earlier,
    goals: plan.goals,
  }
}

export const NODE_OUTCOME_LABEL: Record<NodeOutcome, string> = {
  pass: '通过', fail: '没过', mixed: '对错不一', pending: '待复核', insufficient: '证据不够',
}

/** "通过：A、B；没过：C" in the order of the labels; empty groups left out. */
export function stageReportText(report: StageReport): string {
  return (Object.keys(NODE_OUTCOME_LABEL) as NodeOutcome[])
    .map(outcome => [outcome, report.nodes.filter(node => node.outcome === outcome).map(node => node.title)] as const)
    .filter(([, titles]) => titles.length)
    .map(([outcome, titles]) => `${NODE_OUTCOME_LABEL[outcome]}：${titles.join('、')}`)
    .join('；')
}
