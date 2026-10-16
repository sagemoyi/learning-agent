// Where nodes sit. A d3-force simulation runs over the graph the whole time the canvas lives, as in Obsidian
// and Logseq: nodes push each other apart, relations pull their ends to a length, and a weak pull keeps
// loose groups near the centre. It slows down and stops by itself; dragging a node, changing a force or
// adding nodes wakes it up. Each step writes the positions back into the graph, and sigma redraws.
// A node's first position comes from its id and d3's jiggle has a fixed seed, so the same data lays out the
// same way. Positions are remembered in this browser (positions.ts), so reopening starts where it stopped.
// Distance means nothing about learning.
import type Graph from 'graphology'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type ForceCollide, type ForceLink, type ForceManyBody, type ForceX, type ForceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import type { Physics } from './settings.ts'

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

/** The disc new graphs start on: small, so the first layout spreads out from the middle. */
export function seedSpread(order: number): number {
  return 8 * Math.sqrt(Math.max(1, order))
}

/** Next to the already placed neighbours (their centre plus a small offset), else a seeded spot. */
export function placeNear(graph: Graph, id: string, placed: ReadonlySet<string>, at: (id: string) => { x: number; y: number }): { x: number; y: number } {
  const around = graph.neighbors(id).filter(other => placed.has(other))
  if (!around.length) return seed(id, seedSpread(graph.order) * 4)
  const x = around.reduce((sum, other) => sum + at(other).x, 0) / around.length
  const y = around.reduce((sum, other) => sum + at(other).y, 0) / around.length
  const offset = seed(id, 12)
  return { x: x + offset.x, y: y + offset.y }
}

interface SimNode extends SimulationNodeDatum {
  readonly id: string
  /** The node's radius in graph units, so shapes do not overlap. */
  r: number
}
type SimLink = SimulationLinkDatum<SimNode>

/** The pull a drag keeps up: neighbours follow the dragged node while the pointer moves. */
const DRAG_HEAT = 0.3

/**
 * The live layout of one canvas. `events.tick` runs after each step has been written into the graph; `events.end`
 * when the layout has come to rest (save positions then). `calm` (the system asks for reduced motion) computes a
 * new rest at once instead of animating towards it; a drag still follows the pointer.
 */
export class LiveLayout {
  private readonly simulation: Simulation<SimNode, SimLink>
  private readonly nodes = new Map<string, SimNode>()
  private paused = false
  private moving = false
  private physics: Physics

  private readonly calm: boolean

  constructor(private readonly graph: Graph, physics: Physics, private readonly events: { tick(): void; end(): void }, options: { calm?: boolean } = {}) {
    this.physics = physics
    this.calm = options.calm ?? false
    this.simulation = forceSimulation<SimNode, SimLink>([])
      .stop()
      .force('charge', forceManyBody<SimNode>().theta(0.9).distanceMax(800))
      .force('link', forceLink<SimNode, SimLink>([]).id(node => node.id))
      .force('x', forceX<SimNode>(0))
      .force('y', forceY<SimNode>(0))
      .force('collide', forceCollide<SimNode>(node => node.r + 2).strength(0.7))
      .on('tick', () => this.write())
      .on('end', () => { this.moving = false; this.events.end() })
    this.applyPhysics()
  }

  /** In motion now (not resting and not paused). */
  get running(): boolean {
    return this.moving && !this.paused
  }

  /**
   * Take in the graph's nodes, sizes and relations: a node new to the layout starts where the graph has it, a known
   * one keeps its position and speed. Hidden nodes stay in, so a filter never moves anything.
   */
  sync(): void {
    const nodes: SimNode[] = []
    this.graph.forEachNode((id, attributes) => {
      let node = this.nodes.get(id)
      if (!node) {
        node = { id, x: attributes.x as number, y: attributes.y as number, r: 0 }
        this.nodes.set(id, node)
      }
      node.r = (attributes.size as number | undefined) ?? 4
      nodes.push(node)
    })
    const degree = new Map<string, number>()
    const links: SimLink[] = []
    this.graph.forEachEdge((_edge, _attributes, source, target) => {
      if (source === target) return
      links.push({ source, target })
      degree.set(source, (degree.get(source) ?? 0) + 1)
      degree.set(target, (degree.get(target) ?? 0) + 1)
    })
    this.degree = degree
    // Nodes first: the link force looks its ends up among them. The collision force reads the radii again.
    this.simulation.nodes(nodes)
    this.linkForce().links(links)
    ;(this.simulation.force('collide') as ForceCollide<SimNode>).radius(node => node.r + 2)
  }

  setPhysics(physics: Physics): void {
    this.physics = physics
    this.applyPhysics()
    this.heat(0.5)
  }

  /** Set the layout moving (at least at `alpha`: 1 lays out from scratch, 0.1 nudges). */
  heat(alpha: number): void {
    if (this.graph.order < 2) return
    this.simulation.alpha(Math.max(this.simulation.alpha(), alpha))
    if (this.calm && this.simulation.alphaTarget() === 0) return this.settle(400)
    this.moving = true
    if (!this.paused) this.simulation.restart()
  }

  /** Compute up to `ms` of the layout at once and write it, without animating (reduced motion, first frame). */
  settle(ms: number): void {
    if (this.graph.order < 2) return
    const start = performance.now()
    this.simulation.stop()
    if (this.simulation.alpha() < this.simulation.alphaMin()) this.simulation.alpha(1)
    while (this.simulation.alpha() >= this.simulation.alphaMin() && performance.now() - start < ms) this.simulation.tick()
    this.write()
    if (this.simulation.alpha() < this.simulation.alphaMin()) {
      this.moving = false
      this.events.end()
    } else {
      this.moving = true
      if (!this.paused) this.simulation.restart()
    }
  }

  /** Hold a node at a point (while it is dragged); its neighbours follow. */
  drag(id: string, x: number, y: number): void {
    const node = this.nodes.get(id)
    if (!node) return
    node.fx = x
    node.fy = y
    if (this.simulation.alphaTarget() < DRAG_HEAT) {
      this.simulation.alphaTarget(DRAG_HEAT)
      this.heat(DRAG_HEAT)
    }
  }

  /** Let a dragged node go: the layout comes to rest again. */
  release(id: string): void {
    const node = this.nodes.get(id)
    if (node) node.fx = node.fy = null
    this.simulation.alphaTarget(0)
    if (this.calm) this.settle(300)
  }

  /** Where the layout has a node (undefined before the first `sync`). */
  position(id: string): { x: number; y: number } | undefined {
    const node = this.nodes.get(id)
    return node ? { x: node.x ?? 0, y: node.y ?? 0 } : undefined
  }

  /** Move a node without motion (re-seeding for "重新排布"). */
  place(id: string, x: number, y: number): void {
    const node = this.nodes.get(id)
    if (!node) return
    node.x = x
    node.y = y
    node.vx = node.vy = 0
  }

  /** Stop stepping while the canvas is out of sight; `resume` carries on where it was. */
  pause(): void {
    this.paused = true
    this.simulation.stop()
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    if (this.moving) this.simulation.restart()
  }

  kill(): void {
    this.simulation.stop()
    this.simulation.on('tick', null).on('end', null)
    this.nodes.clear()
  }

  private degree = new Map<string, number>()

  private linkForce(): ForceLink<SimNode, SimLink> {
    return this.simulation.force('link') as ForceLink<SimNode, SimLink>
  }

  private applyPhysics(): void {
    const { center, repel, link, distance } = this.physics
    const degreeOf = (end: string | number | SimNode) => this.degree.get(typeof end === 'object' ? end.id : String(end)) ?? 1
    ;(this.simulation.force('charge') as ForceManyBody<SimNode>).strength(repel)
    this.linkForce().distance(distance).strength(edge => link / Math.max(1, Math.min(degreeOf(edge.source), degreeOf(edge.target))))
    ;(this.simulation.force('x') as ForceX<SimNode>).strength(center)
    ;(this.simulation.force('y') as ForceY<SimNode>).strength(center)
  }

  /** Copy the layout's positions into the graph in one batch: one sigma refresh per step. */
  private write(): void {
    const nodes = this.nodes
    this.graph.updateEachNodeAttributes((id, attributes) => {
      const node = nodes.get(id)
      if (node) {
        attributes.x = node.x
        attributes.y = node.y
      }
      return attributes
    }, { attributes: ['x', 'y'] })
    this.events.tick()
  }
}
