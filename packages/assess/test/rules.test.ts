// The rules of tests by rule (docs/assess/design.md, B): probing along the prerequisites, the diagnosis,
// stage-test assembly and the per-node report, and rubric points.
import { describe, expect, it } from 'vitest'
import type { Problem, ProbeNode } from '@learning-agent/contracts'
import { diagnose, nextNode, scopeNodesOf, type ProbeAnswer } from '../src/adaptive.ts'
import { rubricPoints } from '../src/grading.ts'
import { assemble, stageReport } from '../src/stage.ts'

const node = (id: string, requires: string[] = [], also: string[] = []) => ({ id, title: id.replace('kn_', ''), requires, also }) as unknown as ProbeNode
// 密度 ← 静力学 ← { 压差计, 伯努利 ← 管路 }: three layers of prerequisites.
const chain = [node('kn_密度'), node('kn_静力学', ['kn_密度']), node('kn_压差计', ['kn_静力学']), node('kn_伯努利', ['kn_静力学']), node('kn_管路', ['kn_伯努利'])]
const all = () => true
const right = (...nodeIds: string[]): ProbeAnswer => ({ nodeIds, outcome: 'right' })
const wrong = (...nodeIds: string[]): ProbeAnswer => ({ nodeIds, outcome: 'wrong' })

describe('adaptive diagnostics', () => {
  it('starts in the middle, goes up after a right answer and down after a wrong one', () => {
    expect(nextNode(chain, [], all)).toBe('kn_压差计')
    // Wrong: probe what it requires. Right: probe what depends on it.
    expect(['kn_密度', 'kn_静力学']).toContain(nextNode(chain, [wrong('kn_压差计')], all))
    expect(nextNode(chain, [wrong('kn_压差计'), right('kn_密度')], all)).toBe('kn_静力学')
    expect(nextNode(chain, [right('kn_静力学')], all)).toBe('kn_伯努利')
  })

  it('skips what a right answer implies, what requires a wrong answer, and nodes without a problem', () => {
    // 压差计 right implies 静力学 and 密度; 伯努利 wrong blocks 管路: nothing left.
    expect(nextNode(chain, [right('kn_压差计'), wrong('kn_伯努利')], all)).toBeUndefined()
    expect(nextNode(chain, [], id => id === 'kn_管路')).toBe('kn_管路')
  })

  it('diagnoses known, boundary, not yet, inferred and unprobed; inferred only from right answers', () => {
    const diagnosis = diagnose(chain, [right('kn_压差计'), wrong('kn_伯努利')])
    expect(Object.fromEntries(diagnosis.nodes.map(item => [item.nodeId, item.state]))).toEqual({
      kn_密度: 'inferred', kn_静力学: 'inferred', kn_压差计: 'known', kn_伯努利: 'boundary', kn_管路: 'unprobed',
    })
    // Wrong with a prerequisite not yet confirmed: not yet, not boundary.
    expect(diagnose(chain, [wrong('kn_伯努利')]).nodes.find(item => item.nodeId === 'kn_伯努利')?.state).toBe('not-yet')
  })

  it('counts a merged identity for its node', () => {
    const scope = [node('kn_a', [], ['kn_old']), node('kn_b', ['kn_a'])]
    expect(scopeNodesOf(scope, ['kn_x', 'kn_old', 'kn_b'])).toEqual(['kn_a', 'kn_b'])
  })
})

const problem = (id: string, nodeIds: string[], size: Problem['size'] = 'standard') => ({ id, nodeIds, size }) as unknown as Problem

describe('stage tests', () => {
  const core = [node('kn_静力学'), node('kn_压差计'), node('kn_伯努利')]
  const earlier = [node('kn_密度')]
  const fresh = [
    problem('pb_1', ['kn_静力学']),
    problem('pb_2', ['kn_压差计']),
    problem('pb_3', ['kn_压差计', 'kn_静力学']),
    problem('pb_task', ['kn_伯努利', 'kn_静力学'], 'task'),
    problem('pb_old', ['kn_密度']),
    problem('pb_old2', ['kn_密度']),
  ]

  it('assembles a complete task, a problem per core node and one per earlier node, the task last', () => {
    const built = assemble({ core, earlier }, fresh, 10)
    // pb_3 covers 静力学 and 压差计; 伯努利 has only the task, which covers it.
    expect(built).toEqual({ problemIds: ['pb_3', 'pb_old', 'pb_task'], task: 'pb_task', uncovered: [] })
    // Without room, the core comes first and what is left uncovered is reported.
    expect(assemble({ core: [...core, node('kn_管路')], earlier }, fresh, 3).uncovered).toEqual(['kn_管路'])
  })

  it('reports per core node from its new problems, without a pass mark', () => {
    const plan = { core, earlier, fresh: ['pb_2', 'pb_old', 'pb_task'], task: 'pb_task', uncovered: [], goals: [{ key: 'c1', text: '能算压强' }] } as never
    // A test of 压差计's own problem, the earlier stage's and the task.
    const verdicts: Record<string, 'correct' | 'incorrect'> = { pb_2: 'correct', pb_old: 'incorrect', pb_task: 'incorrect' }
    const report = stageReport(plan, [fresh[1]!, fresh[4]!, fresh[3]!], id => verdicts[id])
    expect(report.nodes.map(item => [item.title, item.outcome, item.problems])).toEqual([['静力学', 'fail', [3]], ['压差计', 'pass', [1]], ['伯努利', 'fail', [3]]])
    expect(report.task).toEqual({ number: 3, verdict: 'incorrect' })
    expect(report.earlier).toEqual([{ nodeId: 'kn_密度', title: '密度', number: 2, verdict: 'incorrect' }])
    // A problem the learner had already met (not in `fresh`) gives no verdict for its node.
    const seen = stageReport({ ...(plan as object), fresh: ['pb_task'] } as never, [fresh[1]!, fresh[3]!], id => verdicts[id])
    expect(seen.nodes.find(item => item.title === '压差计')?.outcome).toBe('insufficient')
  })
})

it('reads rubric points one per line, without bullets or numbers', () => {
  expect(rubricPoints('1. 列出伯努利方程\n- 选对基准面\n（3）代入数值\n\n')).toEqual(['列出伯努利方程', '选对基准面', '代入数值'])
  expect(rubricPoints('参考答案：左侧液面高 0.20 m')).toHaveLength(1)
})
