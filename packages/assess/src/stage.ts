// Stage tests (docs/assess/design.md, 阶段测试和结课检验): assembled by rule from reserved problems new to the learner,
// and reported per core node instead of a pass mark on the total. Pure, like adaptive.ts.
import type { CurrentIdentity, NodeOutcome, Problem, ProbeNode, ReportVerdict, StagePlan, StageReport, Verdict } from '@learning-agent/contracts'

/**
 * An answer as the reports read it, from learner's effective evidence: the grading that stands, whether it no longer
 * counts (`void`: its problem was found wrong later), whether it was helped or its help is uncertain, and why.
 */
export interface ReportAnswer {
  readonly verdict: Verdict
  readonly void?: boolean
  readonly assisted?: boolean
  readonly note?: string
}

/** The answer to a problem, as it counts for `node` when given (help is judged per knowledge point). */
export type AnswerOf = (problemId: string, node?: ProbeNode) => ReportAnswer | undefined

/**
 * From the answers that count: pass when all were right on the learner's own, assisted when all were right but some
 * with help, fail when none was right, mixed when both, pending while one waits for review, insufficient without
 * one that counts. Partly right (e.g. the unit missing) does not pass.
 */
export function outcomeOf(answers: readonly ReportAnswer[]): NodeOutcome {
  const counted = answers.filter(answer => !answer.void)
  const decided = counted.filter(answer => answer.verdict !== 'pending-review')
  const right = decided.filter(answer => answer.verdict === 'correct')
  if (counted.length === 0) return 'insufficient'
  if (decided.length < counted.length && (right.length === 0 || right.length === decided.length)) return 'pending'
  if (right.length === decided.length) return right.some(answer => answer.assisted) ? 'assisted' : 'pass'
  return right.length === 0 ? 'fail' : 'mixed'
}

/** One answer in a report: no verdict once it no longer counts; `assisted` only on a right one. */
export function reportVerdict(answer: ReportAnswer | undefined): ReportVerdict {
  if (!answer) return {}
  if (answer.void) return { void: true }
  return { verdict: answer.verdict, ...(answer.assisted && answer.verdict === 'correct' ? { assisted: true } : {}) }
}

/** "第 2 题：…" for the answers that count otherwise than graded: no longer counted, or right but helped. */
export function answerNotes(answers: readonly { readonly answer: ReportAnswer; readonly number: number }[]): string[] {
  return answers.flatMap(({ answer, number }) => (answer.note && (answer.void || (answer.assisted && answer.verdict === 'correct')) ? [`第 ${number} 题：${answer.note}`] : []))
}

/** What knowledge says about identities now; without it (unit tests), nothing was merged. */
export interface Identities {
  current(nodeIds: readonly string[]): ReadonlyMap<string, CurrentIdentity>
  title(nodeId: string): string | undefined
}
export const NO_MERGES: Identities = { current: nodeIds => new Map(nodeIds.map(id => [id, { id, merged: [] }])), title: () => undefined }

/**
 * A test's nodes as they read now, for its reports: the test keeps the nodes it was published with, and a merge since
 * folds two of them into one, an undone merge parts them again. A problem counts for the identity its node is now.
 */
export function nodesNow(nodes: readonly ProbeNode[], identities: Identities): ProbeNode[] {
  const current = identities.current(nodes.flatMap(node => [node.id, ...node.also, ...node.requires]))
  const idOf = (id: string) => current.get(id)?.id ?? id
  const groups = new Map<string, { title: string; ids: Set<string>; requires: Set<string> }>()
  for (const node of nodes) {
    for (const id of [node.id, ...node.also]) {
      const now = idOf(id)
      const group = groups.get(now) ?? groups.set(now, { title: identities.title(now) ?? (now === node.id ? node.title : id === node.id ? node.title : now), ids: new Set(), requires: new Set() }).get(now)!
      group.ids.add(id)
      if (id === node.id) for (const required of node.requires) group.requires.add(idOf(required))
    }
  }
  return [...groups].map(([id, group]) => ({
    id: id as ProbeNode['id'],
    title: group.title,
    requires: [...group.requires].filter(required => required !== id) as ProbeNode['requires'],
    also: [...new Set([...group.ids, ...current.get(id)?.merged ?? []])].filter(other => other !== id) as ProbeNode['also'],
  }))
}

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
 * A stage test of named problems, checked against its blueprint: the complete task among them, the problems that ask
 * neither a core node nor an earlier stage's (`stray`), and the core nodes none of them asks (`uncovered`).
 */
export function namedStagePlan(blueprint: { readonly core: readonly ProbeNode[]; readonly earlier: readonly ProbeNode[] }, given: readonly Problem[]): { task?: string; stray: string[]; uncovered: string[] } {
  const asksCore = (problem: Problem) => blueprint.core.some(node => covers(problem, node))
  const task = given.find(problem => problem.size === 'task' && asksCore(problem))
  return {
    ...(task ? { task: task.id } : {}),
    stray: given.filter(problem => !asksCore(problem) && !blueprint.earlier.some(node => covers(problem, node))).map(problem => problem.id),
    uncovered: blueprint.core.filter(node => !given.some(problem => covers(problem, node))).map(node => node.id),
  }
}

/**
 * Per core node, from its new problems' answers as they count now (`outcomeOf`). `raw`: the answers are the gradings
 * alone, learner's effective evidence was not at hand.
 */
export function stageReport(plan: StagePlan, problems: readonly Pick<Problem, 'id' | 'nodeIds'>[], answerOf: AnswerOf, raw = false): StageReport {
  const numbered = problems.map((problem, index) => ({ problem, number: index + 1 }))
  const nodes = plan.core.map(node => {
    const mine = numbered.filter(({ problem }) => covers(problem, node))
    const answered = mine.filter(({ problem }) => plan.fresh.includes(problem.id as never)).flatMap(({ problem, number }) => {
      const answer = answerOf(problem.id, node)
      return answer ? [{ answer, number }] : []
    })
    const notes = answerNotes(answered)
    return { nodeId: node.id as string, title: node.title, outcome: outcomeOf(answered.map(item => item.answer)), problems: mine.map(({ number }) => number), ...(notes.length ? { notes } : {}) }
  })
  const task = numbered.find(({ problem }) => problem.id === plan.task)
  const earlier = numbered.flatMap(({ problem, number }) => {
    if (plan.core.some(node => covers(problem, node))) return []
    const node = plan.earlier.find(candidate => covers(problem, candidate))
    return node ? [{ nodeId: node.id as string, title: node.title, number, ...reportVerdict(answerOf(problem.id, node)) }] : []
  })
  return {
    nodes,
    ...(task ? { task: { number: task.number, ...reportVerdict(answerOf(task.problem.id)) } } : {}),
    earlier,
    goals: plan.goals,
    ...(raw ? { raw: true } : {}),
  }
}

export const NODE_OUTCOME_LABEL: Record<NodeOutcome, string> = {
  pass: '通过', assisted: '有帮助完成', fail: '没过', mixed: '对错不一', pending: '待复核', insufficient: '证据不够',
}

/** A single answer in words for handoffs: its verdict, "有帮助做对", or that it no longer counts. */
export function reportVerdictText(item: ReportVerdict, labels: Record<Verdict, string>): string {
  return item.void ? '题目有错，不计' : item.assisted ? '有帮助做对' : item.verdict ? labels[item.verdict] : '没答'
}

/** "通过：A、B；没过：C" in the order of the labels; empty groups left out; why answers count otherwise after it. */
export function stageReportText(report: StageReport): string {
  const groups = (Object.keys(NODE_OUTCOME_LABEL) as NodeOutcome[])
    .map(outcome => [outcome, report.nodes.filter(node => node.outcome === outcome).map(node => node.title)] as const)
    .filter(([, titles]) => titles.length)
    .map(([outcome, titles]) => `${NODE_OUTCOME_LABEL[outcome]}：${titles.join('、')}`)
  const notes = [...new Set(report.nodes.flatMap(node => node.notes ?? []))]
  return [...groups, ...(notes.length ? [`说明：${notes.join('；')}`] : []), ...(report.raw ? ['（按原始判分算，没算有效证据）'] : [])].join('；')
}
