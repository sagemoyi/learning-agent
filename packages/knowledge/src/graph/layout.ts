// Where nodes sit. A node's first position comes from its id, so the same graph opens the same way;
// ForceAtlas2 then spreads the graph in a worker for a bounded time and stops. Positions are
// remembered in this browser as a view preference, so reopening does not lay out again; new nodes
// start next to their neighbours while the others stay put. Distance means nothing about learning.
import type Graph from 'graphology'
import { inferSettings } from 'graphology-layout-forceatlas2'
import FA2Layout from 'graphology-layout-forceatlas2/worker'
import { readLocal, writeLocal } from '@learning-agent/kit/client'

type Positions = Record<string, [number, number]>
const MAX_REMEMBERED = 3000

function hash(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

/** A stable spot on a disc, from the id alone. */
export function seed(id: string, spread: number): { x: number; y: number } {
  const angle = hash(id) * 2 * Math.PI, radius = Math.sqrt(hash(`${id}#r`)) * spread
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) }
}

/** Next to the already placed neighbours (their centre plus a small offset), else a seeded spot. */
export function placeNear(graph: Graph, id: string, placed: ReadonlySet<string>, at: (id: string) => { x: number; y: number }): { x: number; y: number } {
  const around = graph.neighbors(id).filter(other => placed.has(other))
  const spread = Math.sqrt(graph.order) * 10
  if (!around.length) return seed(id, spread)
  const x = around.reduce((sum, other) => sum + at(other).x, 0) / around.length
  const y = around.reduce((sum, other) => sum + at(other).y, 0) / around.length
  const offset = seed(id, 6)
  return { x: x + offset.x, y: y + offset.y }
}

export function loadPositions(key: string): Positions {
  return readLocal<Positions>(`knowledge.layout.${key}`, {})
}

export function savePositions(key: string, graph: Graph): void {
  const positions: Positions = {}
  let count = 0
  graph.forEachNode((id, attributes) => {
    if (count >= MAX_REMEMBERED || id.includes(':')) return
    positions[id] = [Math.round(attributes.x * 100) / 100, Math.round(attributes.y * 100) / 100]
    count++
  })
  writeLocal(`knowledge.layout.${key}`, positions)
}

/** Time budget: small graphs settle in under a second, large ones get a few seconds at most. */
export function layoutBudget(order: number): number {
  return Math.min(4000, 700 + order * 2)
}

/**
 * Run ForceAtlas2 in a worker for `ms`, then stop and release the worker. `fixed` nodes keep their
 * place. Strong gravity keeps unconnected groups near the centre. Pauses while the page is hidden. Returns a cancel function; `done` runs once either way.
 */
export function runLayout(graph: Graph, options: { ms: number; fixed?: ReadonlySet<string>; done(): void }): () => void {
  if (graph.order < 2) { options.done(); return () => {} }
  graph.updateEachNodeAttributes((id, attributes) => ({ ...attributes, fixed: options.fixed?.has(id) ?? false }))
  const layout = new FA2Layout(graph, { settings: { ...inferSettings(graph), strongGravityMode: true, gravity: 0.6, scalingRatio: graph.order > 300 ? 6 : 24, barnesHutOptimize: graph.order > 300, slowDown: 3 } })
  let left = options.ms, startedAt = 0, timer: ReturnType<typeof setTimeout> | undefined, finished = false
  const finish = () => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', visibility)
    layout.kill()
    graph.updateEachNodeAttributes((_id, { fixed: _fixed, ...attributes }) => attributes)
    options.done()
  }
  const resume = () => {
    startedAt = performance.now()
    layout.start()
    timer = setTimeout(finish, left)
  }
  const visibility = () => {
    if (document.hidden && layout.isRunning()) {
      clearTimeout(timer)
      layout.stop()
      left = Math.max(0, left - (performance.now() - startedAt))
    } else if (!document.hidden && !finished && !layout.isRunning()) {
      resume()
    }
  }
  document.addEventListener('visibilitychange', visibility)
  if (document.hidden) visibility()
  else resume()
  return finish
}
