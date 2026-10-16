// Node positions remembered in this browser as a view preference, one key per course and one for the main page.
import type Graph from 'graphology'
import { readLocal, writeLocal } from '@learning-agent/kit/client'

type Positions = Record<string, [number, number]>
const MAX_REMEMBERED = 3000
/** Positions saved with ForceAtlas2 (before 10-16) are on another scale; this key starts afresh. */
const STORE = 'knowledge.positions.'

export function loadPositions(key: string): Positions {
  return readLocal<Positions>(`${STORE}${key}`, {})
}

export function savePositions(key: string, graph: Graph): void {
  const positions: Positions = {}
  let count = 0
  graph.forEachNode((id, attributes) => {
    // Source rings (`src:`, `tb:`) are placed afresh each time the overlay is shown.
    if (count >= MAX_REMEMBERED || id.includes(':')) return
    positions[id] = [Math.round(attributes.x * 10) / 10, Math.round(attributes.y * 10) / 10]
    count++
  })
  writeLocal(`${STORE}${key}`, positions)
}
