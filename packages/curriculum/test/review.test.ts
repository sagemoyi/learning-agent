import { describe, expect, it } from 'vitest'
import { newId, type Stage, type TestView } from '@learning-agent/contracts'
import { carriedOf, remedialNodes, reviewFacts } from '../src/review.ts'

const [a, b] = [newId('node'), newId('node')]
const stage = { id: newId('stage'), courseId: newId('course'), index: 1, title: '静力学', objective: '', kind: 'normal', status: 'reviewing', folder: 'stages/01-静力学', supports: [], nodeIds: [a, b] } as Stage

/** A graded stage test: problem 1 on `a`, problem 2 on `b`, problem 3 the complete task on both. */
function view(outcomes: [string, string], task: string | Record<string, unknown> | undefined): TestView {
  const problems = [[a], [b], [a, b]].map(nodeIds => ({ id: newId('problem'), nodeIds, status: 'active' }))
  return {
    test: { id: newId('test') },
    problems,
    attempts: [],
    appeals: [],
    reports: [],
    stageReport: {
      nodes: [{ nodeId: a, title: 'A', outcome: outcomes[0], problems: [1, 3] }, { nodeId: b, title: 'B', outcome: outcomes[1], problems: [2, 3] }],
      ...(task ? { task: { number: 3, ...(typeof task === 'string' ? { verdict: task } : task) } } : {}),
      earlier: [],
      goals: [],
    },
  } as unknown as TestView
}

const facts = (test: TestView) => reviewFacts({ stage, view: test, states: new Map(), signals: new Map(), dependents: new Map(), carried: [] })

describe('stage review facts', () => {
  it('goes on when every node passed and carries mixed nodes as unverified', () => {
    expect(facts(view(['pass', 'pass'], 'correct')).recommendation).toBe('next')
    const mixed = facts(view(['pass', 'mixed'], 'correct'))
    expect([mixed.recommendation, mixed.nodes.map(node => node.result)]).toEqual(['next', ['pass', 'unverified']])
  })

  it('remedies a failed node, or the complete task partly right', () => {
    expect(remedialNodes(facts(view(['pass', 'fail'], 'correct')))).toEqual([b])
    const partial = facts(view(['pass', 'pass'], 'partial'))
    expect([partial.recommendation, partial.task?.result]).toEqual(['remedial', 'fail'])
    expect(remedialNodes(partial)).toEqual([a, b])
  })

  it('reads the stage report as it counts now: helped, or found wrong later, is not verified either way', () => {
    // The report already left out the answer whose problem was found wrong (insufficient) and marked a helped one.
    const counted = facts(view(['assisted', 'insufficient'], { void: true }))
    expect([counted.recommendation, counted.nodes.map(node => node.result), counted.task?.result]).toEqual(['next', ['unverified', 'unverified'], 'unverified'])
    expect(facts(view(['pass', 'pass'], { verdict: 'correct', assisted: true })).task?.result).toBe('unverified')
  })

  it("carries failed nodes as risks when passed over, and a failed task's unverified nodes too", () => {
    const reviewed = (task: 'pass' | 'fail', choice: 'next' | 'remedial') => ({
      ...stage,
      status: 'done',
      review: { testId: newId('test'), nodes: [{ nodeId: a, title: 'A', result: 'fail' }, { nodeId: b, title: 'B', result: 'unverified' }], task, recommendation: 'remedial', savedAt: '', choice },
    }) as Stage
    const kinds = (task: 'pass' | 'fail', choice: 'next' | 'remedial') => carriedOf([reviewed(task, choice)]).map(item => [item.title, item.kind])
    expect(kinds('pass', 'next')).toEqual([['A', 'risk'], ['B', 'unverified']])
    expect(kinds('fail', 'next')).toEqual([['A', 'risk'], ['B', 'risk']])
    expect(kinds('fail', 'remedial')).toEqual([['B', 'unverified']])
  })
})
