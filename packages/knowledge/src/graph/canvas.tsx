// The sigma canvas. It owns one graphology graph for its lifetime and copies each new model into
// it: attributes change in place, so a state push keeps the camera, the selection and the positions;
// only new nodes get a place (next to their neighbours) and a short layout with the others fixed.
// Closing the tab kills the renderer, the layout worker and the observers.
import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import { EdgeArrowProgram, EdgeRectangleProgram } from 'sigma/rendering'
import type { GraphColors } from './colors.ts'
import { drawNodeHover, drawNodeLabel, resetLabels, theme } from './draw.ts'
import { layoutBudget, loadPositions, placeNear, runLayout, savePositions, seed } from './layout.ts'
import type { DrawEdge, DrawNode, GraphModel } from './model.ts'
import { NODE_PROGRAMS } from './shapes.ts'

export interface GraphCanvasHandle {
  zoomIn(): void
  zoomOut(): void
  reset(): void
  relayout(): void
  /** Move the camera to a node (search, list). */
  focus(id: string): void
}

interface Props {
  readonly model: GraphModel
  /** Where positions are remembered: one key per course, one for the main page. */
  readonly layoutKey: string
  readonly colors: GraphColors
  onSelect(id: string | undefined): void
  /** WebGL could not start; the page falls back to the list. */
  onUnavailable(): void
  onLayout?(running: boolean): void
  readonly label: string
}

interface Live {
  readonly sigma: Sigma
  readonly graph: Graph
  stop?: () => void
  laidOut: boolean
}

function nodeAttributes(node: DrawNode, colors: GraphColors) {
  return { label: node.label, type: node.type, color: node.color, labelColor: node.labelColor, fillColor: colors.surface, size: node.size, subtitle: node.subtitle, forceLabel: node.forceLabel, zIndex: node.zIndex, kind: node.kind }
}

function edgeAttributes(edge: DrawEdge) {
  return { type: edge.arrow ? 'arrow' : 'line', color: edge.color, size: edge.size, zIndex: edge.faded ? 0 : 1 }
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(props, ref): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const live = useRef<Live>()
  const latest = useRef(props)
  latest.current = props

  const layout = (fixed?: ReadonlySet<string>) => {
    const current = live.current
    if (!current) return
    current.stop?.()
    latest.current.onLayout?.(true)
    current.stop = runLayout(current.graph, {
      ms: fixed ? Math.min(800, layoutBudget(current.graph.order)) : layoutBudget(current.graph.order),
      fixed,
      done: () => {
        current.stop = undefined
        savePositions(latest.current.layoutKey, current.graph)
        latest.current.onLayout?.(false)
      },
    })
  }

  useEffect(() => {
    const graph = new Graph({ type: 'directed', multi: true, allowSelfLoops: false })
    const colors = latest.current.colors
    let sigma: Sigma
    try {
      sigma = new Sigma(graph, container.current!, {
        nodeProgramClasses: NODE_PROGRAMS,
        defaultNodeType: 'circle',
        edgeProgramClasses: { arrow: EdgeArrowProgram, line: EdgeRectangleProgram },
        defaultEdgeType: 'line',
        defaultDrawNodeLabel: drawNodeLabel,
        defaultDrawNodeHover: drawNodeHover,
        labelSize: 12,
        labelWeight: '400',
        labelFont: colors.font,
        labelDensity: 0.5,
        labelGridCellSize: 120,
        labelRenderedSizeThreshold: 5,
        zIndex: true,
        allowInvalidContainer: true,
        // Room for labels, which run to the right of their node, and for the zoom buttons.
        stagePadding: 64,
        minCameraRatio: 0.05,
        maxCameraRatio: 4,
      })
    } catch {
      latest.current.onUnavailable()
      return
    }
    live.current = { sigma, graph, laidOut: false }
    sigma.on('beforeRender', () => resetLabels(sigma.getCanvases().labels!))
    sigma.on('clickNode', ({ node }) => latest.current.onSelect(node))
    sigma.on('clickStage', () => latest.current.onSelect(undefined))
    sigma.on('enterNode', () => { container.current!.style.cursor = 'pointer' })
    sigma.on('leaveNode', () => { container.current!.style.cursor = '' })
    // Sigma follows window resizes only; split panes and hidden tabs resize the container itself.
    const observer = new ResizeObserver(() => {
      if (!container.current?.offsetWidth) return
      sigma.resize()
      sigma.refresh()
    })
    observer.observe(container.current!)
    performance.mark('knowledge-graph:created')
    return () => {
      observer.disconnect()
      live.current?.stop?.()
      sigma.kill()
      graph.clear()
      live.current = undefined
    }
  }, [])

  // Copy the model into the graph.
  useEffect(() => {
    const current = live.current
    if (!current) return
    const { graph, sigma } = current
    const { model, colors, layoutKey } = props
    Object.assign(theme, { text: colors.text, muted: colors.muted, surface: colors.surface, line: colors.line, font: colors.font })
    const nodes = new Map(model.nodes.map(node => [node.id, node]))
    const edges = new Map(model.edges.map(edge => [edge.id, edge]))
    const remembered = current.laidOut ? {} : loadPositions(layoutKey)
    const placed = new Set<string>(graph.nodes())
    const added: string[] = []
    for (const node of model.nodes) {
      if (graph.hasNode(node.id)) continue
      const position = remembered[node.id]
      graph.addNode(node.id, { ...nodeAttributes(node, colors), x: position?.[0] ?? 0, y: position?.[1] ?? 0 })
      if (position) placed.add(node.id)
      else added.push(node.id)
    }
    for (const edge of model.edges) {
      if (!graph.hasEdge(edge.id) && graph.hasNode(edge.source) && graph.hasNode(edge.target)) graph.addEdgeWithKey(edge.id, edge.source, edge.target, edgeAttributes(edge))
    }
    // New nodes start next to their placed neighbours, or on a seeded spot the first time.
    const positions = new Map<string, { x: number; y: number }>()
    const at = (id: string) => positions.get(id) ?? { x: graph.getNodeAttribute(id, 'x') as number, y: graph.getNodeAttribute(id, 'y') as number }
    const spread = Math.sqrt(graph.order) * 10
    for (const id of added) {
      positions.set(id, current.laidOut || placed.size ? placeNear(graph, id, placed, at) : seed(id, spread))
      placed.add(id)
    }
    // Items the model leaves out stay in the graph, hidden: positions hold still while filters change,
    // and one batched update costs one refresh instead of one per node or relation. The hints must name
    // type and zIndex, or sigma treats the update as repaint-only and fails on relations just added.
    graph.updateEachNodeAttributes((id, attributes) => {
      const node = nodes.get(id)
      return node ? { ...attributes, ...nodeAttributes(node, colors), ...positions.get(id), hidden: false } : { ...attributes, hidden: true }
    }, { attributes: ['x', 'y', 'type', 'zIndex', 'hidden', 'color', 'size', 'label'] })
    graph.updateEachEdgeAttributes((id, attributes) => {
      const edge = edges.get(id)
      return edge ? { ...attributes, ...edgeAttributes(edge), hidden: false } : { ...attributes, hidden: true }
    }, { attributes: ['type', 'zIndex', 'hidden', 'color', 'size'] })
    sigma.refresh()
    if (!current.laidOut) {
      current.laidOut = true
      performance.mark('knowledge-graph:first-render')
      // Remembered positions cover most of the graph: only settle the newcomers.
      if (added.length > graph.order * 0.3) layout()
      else if (added.length) layout(new Set(graph.nodes().filter(id => !positions.has(id))))
    } else if (added.length) {
      layout(new Set(graph.nodes().filter(id => !positions.has(id))))
    }
  }, [props.model, props.colors])

  useImperativeHandle(ref, () => ({
    zoomIn: () => { void live.current?.sigma.getCamera().animatedZoom({ duration: 200 }) },
    zoomOut: () => { void live.current?.sigma.getCamera().animatedUnzoom({ duration: 200 }) },
    reset: () => { void live.current?.sigma.getCamera().animatedReset({ duration: 300 }) },
    relayout: () => {
      const current = live.current
      if (!current) return
      const spread = Math.sqrt(current.graph.order) * 10
      current.graph.updateEachNodeAttributes((id, attributes) => ({ ...attributes, ...seed(id, spread) }))
      void current.sigma.getCamera().animatedReset({ duration: 0 })
      layout()
    },
    focus: id => {
      const current = live.current
      const data = current?.sigma.getNodeDisplayData(id)
      if (!current || !data) return
      const camera = current.sigma.getCamera()
      // A small graph fits the canvas: pan only. A large one zooms in so the node's neighbours are readable.
      void camera.animate({ x: data.x, y: data.y, ratio: Math.min(camera.ratio, current.graph.order > 100 ? 0.5 : 1) }, { duration: 400 })
    },
  }), [])

  return <div ref={container} className="la-graph-canvas" role="img" aria-label={props.label} />
})
