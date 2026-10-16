// The graph's live layout (d3-force over a graphology graph), stepped synchronously: no browser, no timer.
import Graph from 'graphology'
import { describe, expect, it } from 'vitest'
import { LiveLayout, seed } from '../src/graph/layout.ts'
import { DEFAULT_SETTINGS, physicsOf } from '../src/graph/settings.ts'

describe('live layout', () => {
  it('lays the same graph out the same way, keeps a dragged node under the pointer, and keeps hidden nodes in', () => {
    const build = () => {
      const graph = new Graph({ type: 'directed', multi: true })
      for (const id of ['a', 'b', 'c', 'd']) graph.addNode(id, { ...seed(id, 20), size: 5 })
      graph.addEdgeWithKey('ab', 'a', 'b')
      graph.addEdgeWithKey('bc', 'b', 'c')
      graph.setNodeAttribute('d', 'hidden', true)
      return graph
    }
    const run = () => {
      const graph = build(), ends: string[] = []
      const layout = new LiveLayout(graph, physicsOf(DEFAULT_SETTINGS), { tick: () => {}, end: () => ends.push('end') }, { calm: true })
      layout.sync()
      layout.settle(2000)
      return { graph, layout, ends }
    }
    const first = run(), second = run()
    expect(first.ends).toEqual(['end'])
    expect(first.graph.getNodeAttributes('c')).toEqual(second.graph.getNodeAttributes('c'))
    const linked = Math.hypot(first.graph.getNodeAttribute('a', 'x') - first.graph.getNodeAttribute('b', 'x'), first.graph.getNodeAttribute('a', 'y') - first.graph.getNodeAttribute('b', 'y'))
    expect(linked).toBeGreaterThan(20)
    expect(linked).toBeLessThan(200)
    // The hidden node takes part, so showing it again moves nothing.
    expect(first.layout.position('d')).toBeDefined()
    first.layout.drag('a', 500, 500)
    first.layout.settle(500)
    expect(first.layout.position('a')).toEqual({ x: 500, y: 500 })
    expect(first.graph.getNodeAttribute('b', 'x')).toBeGreaterThan(second.graph.getNodeAttribute('b', 'x'))
    first.layout.release('a')
    first.layout.kill()
    second.layout.kill()
  })

})
