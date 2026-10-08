// Adaptive diagnostics (docs/assess/design.md, B): one problem at a time along the hard prerequisites
// of the nodes the test probes. Right → probe what depends on the node; wrong or "不会" → probe what it
// requires. Pure: the scope the test saved when it started and its answers decide the next node and the
// result, so a diagnosis can always be recomputed. Inferred nodes are for planning only, never evidence.
import type { Diagnosis, ProbeNode, ProbeState } from '@learning-agent/contracts'

/** One graded answer: the scope nodes its problem covers (the node it was asked for first), right or wrong. */
export interface ProbeAnswer {
  readonly nodeIds: readonly string[]
  /** right: correct, or only the unit missing (the method is known); wrong: incorrect or "不会". */
  readonly outcome: 'right' | 'wrong'
}

class Scope {
  private readonly byId: Map<string, ProbeNode>
  private readonly below = new Map<string, Set<string>>()
  private readonly depths = new Map<string, number>()

  constructor(readonly nodes: readonly ProbeNode[]) {
    this.byId = new Map(nodes.map(node => [node.id as string, node]))
  }

  /** Everything the node requires, directly or not, within the scope. */
  prerequisites(id: string): Set<string> {
    const cached = this.below.get(id)
    if (cached) return cached
    const found = new Set<string>()
    const stack = [...(this.byId.get(id)?.requires ?? [])]
    while (stack.length) {
      const next = stack.pop()!
      if (next === id || found.has(next) || !this.byId.has(next)) continue
      found.add(next)
      stack.push(...(this.byId.get(next)?.requires ?? []))
    }
    this.below.set(id, found)
    return found
  }

  /** Every node that requires this one, directly or not. */
  dependents(id: string): Set<string> {
    return new Set(this.nodes.filter(node => this.prerequisites(node.id).has(id)).map(node => node.id as string))
  }

  /** The longest chain of prerequisites under the node (0 for a node that requires nothing). */
  depth(id: string, path: ReadonlySet<string> = new Set()): number {
    const cached = this.depths.get(id)
    if (cached !== undefined) return cached
    const requires = (this.byId.get(id)?.requires ?? []).filter(next => this.byId.has(next) && !path.has(next))
    const depth = requires.length ? 1 + Math.max(...requires.map(next => this.depth(next, new Set([...path, id])))) : 0
    this.depths.set(id, depth)
    return depth
  }

  /** The middle one by depth (then by the scope's order): halfway up or down the chain. */
  middle(ids: readonly string[]): string | undefined {
    const order = new Map(this.nodes.map((node, index) => [node.id as string, index]))
    const sorted = [...ids].sort((a, b) => this.depth(a) - this.depth(b) || order.get(a)! - order.get(b)!)
    return sorted[Math.floor((sorted.length - 1) / 2)]
  }
}

/** The scope nodes a problem covers, the first of its nodes first; merged identities count for their node. */
export function scopeNodesOf(nodes: readonly ProbeNode[], problemNodeIds: readonly string[]): string[] {
  const found: string[] = []
  for (const id of problemNodeIds) {
    const node = nodes.find(candidate => candidate.id === id || candidate.also.includes(id as never))
    if (node && !found.includes(node.id)) found.push(node.id)
  }
  return found
}

/** Per node: right when any answer on it was right, otherwise wrong. */
function outcomesOf(answers: readonly ProbeAnswer[]): Map<string, 'right' | 'wrong'> {
  const outcomes = new Map<string, 'right' | 'wrong'>()
  for (const answer of answers) {
    for (const id of answer.nodeIds) if (outcomes.get(id) !== 'right') outcomes.set(id, answer.outcome)
  }
  return outcomes
}

/**
 * The node to probe next, or undefined when nothing is left to learn from. Nodes already answered, those
 * a right answer implies, and those requiring a node answered wrong (they are likely unknown too, and
 * stay unprobed) are skipped; so are nodes without a problem to ask (`probeable`).
 * Order: below the last wrong answer; then anything below a wrong answer (the boundary lies between a
 * right and a wrong answer); after a right answer, what depends on it; then the middle of what is left.
 */
export function nextNode(nodes: readonly ProbeNode[], answers: readonly ProbeAnswer[], probeable: (nodeId: string) => boolean): string | undefined {
  const scope = new Scope(nodes)
  const outcomes = outcomesOf(answers)
  const inferred = new Set([...outcomes].filter(([, outcome]) => outcome === 'right').flatMap(([id]) => [...scope.prerequisites(id)]))
  const open = nodes.map(node => node.id as string).filter(id => !outcomes.has(id) && !inferred.has(id)
    && ![...scope.prerequisites(id)].some(below => outcomes.get(below) === 'wrong') && probeable(id))
  if (open.length === 0) return undefined
  const last = answers.at(-1)
  const lastNode = last?.nodeIds[0]
  const belowWrong = new Set([...outcomes].filter(([, outcome]) => outcome === 'wrong').flatMap(([id]) => [...scope.prerequisites(id)]))
  const pools = [
    last?.outcome === 'wrong' && lastNode ? scope.prerequisites(lastNode) : new Set<string>(),
    belowWrong,
    last?.outcome === 'right' && lastNode ? scope.dependents(lastNode) : new Set<string>(),
  ].map(pool => open.filter(id => pool.has(id)))
  return scope.middle(pools.find(pool => pool.length > 0) ?? open)
}

/** The diagnosis: each scope node's place from the direct answers, in the scope's order. */
export function diagnose(nodes: readonly ProbeNode[], answers: readonly ProbeAnswer[]): Diagnosis {
  const scope = new Scope(nodes)
  const outcomes = outcomesOf(answers)
  const inferred = new Set([...outcomes].filter(([, outcome]) => outcome === 'right').flatMap(([id]) => [...scope.prerequisites(id)]))
  const known = (id: string) => outcomes.get(id) === 'right' || (!outcomes.has(id) && inferred.has(id))
  return {
    nodes: nodes.map(node => {
      const outcome = outcomes.get(node.id)
      const requires = node.requires.filter(id => nodes.some(other => other.id === id))
      const state: ProbeState = outcome === 'right' ? 'known'
        : outcome === 'wrong' ? (requires.every(known) ? 'boundary' : 'not-yet')
          : inferred.has(node.id) ? 'inferred' : 'unprobed'
      return { nodeId: node.id, title: node.title, state }
    }),
  }
}

export const PROBE_STATE_LABEL: Record<ProbeState, string> = {
  known: '已会', boundary: '边界', 'not-yet': '还不会', inferred: '推测已会', unprobed: '未探测',
}

/** "已会：A、B；边界：C" in the order of the labels; empty groups left out. */
export function diagnosisText(diagnosis: Diagnosis): string {
  return (Object.keys(PROBE_STATE_LABEL) as ProbeState[])
    .map(state => [state, diagnosis.nodes.filter(node => node.state === state).map(node => node.title)] as const)
    .filter(([, titles]) => titles.length)
    .map(([state, titles]) => `${PROBE_STATE_LABEL[state]}：${titles.join('、')}`)
    .join('；')
}
