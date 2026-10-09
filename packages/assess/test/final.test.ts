import { describe, expect, it } from 'vitest'
import { newId, type Problem, type ProbeNode } from '@learning-agent/contracts'
import { assembleFinal, finalReport } from '../src/final.ts'

const node = (title: string): ProbeNode => ({ id: newId('node'), title, requires: [], also: [] })
const [a, b, c, risk] = [node('A'), node('B'), node('C'), node('R')]
let counter = 0
const problem = (nodes: readonly ProbeNode[], size: Problem['size'] = 'standard') => ({ id: `pb_${String(counter++).padStart(26, '0')}`, nodeIds: nodes.map(item => item.id), size }) as unknown as Problem

describe('final checks', () => {
  it('gives each goal item a problem, a complete task first, and reuses one that covers several', () => {
    const single = problem([a])
    const task = problem([a, b], 'task')
    const other = problem([b])
    const built = assembleFinal([{ key: 'c1', text: '一', nodes: [a] }, { key: 'c2', text: '二', nodes: [b] }, { key: 'c3', text: '三', nodes: [c] }], [], [single, task, other], 10)
    expect(built.items.map(item => item.problemIds)).toEqual([[task.id], [task.id], []])
    expect(built.uncovered).toEqual(['c3'])
    expect(built.problemIds).toEqual([task.id])
  })

  it('adds up to two problems on carried nodes, tasks last, and reports per item', () => {
    const forA = problem([a])
    const risks = [problem([risk]), problem([risk])]
    const built = assembleFinal([{ key: 'c1', text: '一', nodes: [a] }], [risk, node('S')], [forA, ...risks], 10)
    expect(built.problemIds).toEqual([forA.id, risks[0]!.id])
    const verdicts: Record<string, 'correct' | 'incorrect'> = { [forA.id]: 'incorrect', [risks[0]!.id]: 'correct' }
    const report = finalReport({ ...built, risks: [risk] }, built.problemIds, id => [forA, ...risks].find(item => item.id === id), id => verdicts[id])
    expect(report.items).toEqual([{ key: 'c1', text: '一', outcome: 'fail', problems: [1] }])
    expect(report.risks).toEqual([{ nodeId: risk.id, title: 'R', number: 2, verdict: 'correct' }])
  })
})
