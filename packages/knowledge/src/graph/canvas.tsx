// The sigma canvas. It owns one graphology graph and one live layout (layout.ts) for its lifetime and copies
// each new model into the graph: attributes change in place, so a state push keeps the camera, the selection
// and the positions; new nodes start next to their neighbours and the layout wakes up a little.
// - Coordinates stay put: the bounding box is fixed (sigma would otherwise rescale the whole picture whenever a
//   node moves), sizes are in graph units (nodes grow as you zoom in, and names appear), and "复位" fits the
//   camera to the nodes.
// - Drag a node and its neighbours follow; hover one and only it and its neighbours stay bright.
// - Click selects (the sidebar canvas opens instead), double click or Ctrl/⌘-click opens, right click asks for
//   a menu. `+`, `-` and the arrow keys zoom and pan.
// - Out of sight (a background tab, a hidden window) the layout pauses; closing the tab kills the renderer,
//   the layout and the observers.
import { forwardRef, useEffect, useImperativeHandle, useRef, type KeyboardEvent, type ReactNode } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import { EdgeArrowProgram, EdgeRectangleProgram } from 'sigma/rendering'
import type { CameraState } from 'sigma/types'
import type { GraphColors } from './colors.ts'
import { drawNodeHover, drawNodeLabel, resetLabels, theme } from './draw.ts'
import { LiveLayout, placeNear, seed, seedSpread } from './layout.ts'
import { loadPositions, savePositions } from './positions.ts'
import type { DrawEdge, DrawNode, GraphModel } from './model.ts'
import { labelThreshold, physicsOf, sizeScale, type GraphSettings } from './settings.ts'
import { NODE_PROGRAMS } from './shapes.ts'

export interface GraphCanvasHandle {
  zoomIn(): void
  zoomOut(): void
  /** Fit the camera to the nodes shown. */
  reset(): void
  /** Throw the positions away and lay the graph out from scratch. */
  relayout(): void
  /** Move the camera to a node (search, list). */
  focus(id: string): void
  /** Light a node and its neighbours up as hovering does (the sidebar list); undefined clears it. */
  highlight(id: string | undefined): void
}

interface Props {
  readonly model: GraphModel
  /** Where positions are remembered: one key per course, one for the main page; none lays out afresh each time. */
  readonly layoutKey?: string
  readonly colors: GraphColors
  readonly settings: GraphSettings
  /** The page is on screen; out of sight the layout pauses. */
  readonly active: boolean
  onSelect(id: string | undefined): void
  /** Double click (this tab) or Ctrl/⌘-click (a new tab). */
  onOpen?(id: string, newTab: boolean): void
  /** Right click on a node, at the pointer (viewport pixels). */
  onMenu?(id: string, at: { x: number; y: number }): void
  /** WebGL could not start; the page falls back to the list. */
  onUnavailable(): void
  /** The sidebar's small graph: a click opens the node instead of selecting it. */
  readonly clickOpens?: boolean
  /** Multiplies node and line sizes: a small canvas shows a few nodes across many relation lengths. */
  readonly boost?: number
  readonly label: string
}

/** Half the side of the fixed bounding box, in graph units: positions never get rescaled to fit it. */
const HALF = 2000
const framed = (value: number) => (value + HALF) / (2 * HALF)

interface Hover {
  readonly id: string
  readonly nodes: ReadonlySet<string>
  readonly edges: ReadonlySet<string>
}

interface Live {
  readonly sigma: Sigma
  readonly graph: Graph
  readonly layout: LiveLayout
  laidOut: boolean
  /** The camera keeps the whole graph in view while it spreads out, until the learner moves it. */
  following: boolean
  hover?: Hover
  /** Hover from outside the canvas (the list beside it). */
  outerHover?: Hover
  drag?: { id: string; x: number; y: number; moved: boolean }
  /** A drag just ended on a node: the click that follows is not a click. */
  dragged: boolean
}

function nodeAttributes(node: DrawNode, colors: GraphColors, scale: number) {
  return { label: node.label, type: node.type, color: node.color, baseColor: node.baseColor, labelColor: node.labelColor, fillColor: colors.surface, size: node.size * scale, subtitle: node.subtitle, forceLabel: node.forceLabel, zIndex: node.zIndex, kind: node.kind }
}

function edgeAttributes(edge: DrawEdge, scale: number) {
  return { type: edge.arrow ? 'arrow' : 'line', color: edge.color, size: edge.size * scale, zIndex: edge.faded ? 0 : 1 }
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export const GraphCanvas = forwardRef<GraphCanvasHandle, Props>(function GraphCanvas(props, ref): ReactNode {
  const container = useRef<HTMLDivElement>(null)
  const live = useRef<Live>()
  const latest = useRef(props)
  latest.current = props

  /** The camera that shows every visible node, with room for names. */
  const fitState = (): CameraState | undefined => {
    const current = live.current
    if (!current) return undefined
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    current.graph.forEachNode((_id, attributes) => {
      if (attributes.hidden) return
      const x = attributes.x as number, y = attributes.y as number, r = attributes.size as number
      minX = Math.min(minX, x - r); maxX = Math.max(maxX, x + r); minY = Math.min(minY, y - r); maxY = Math.max(maxY, y + r)
    })
    if (!Number.isFinite(minX)) return { x: 0.5, y: 0.5, ratio: 1, angle: 0 }
    const center = { x: framed((minX + maxX) / 2), y: framed((minY + maxY) / 2), angle: 0 }
    const probe = { cameraState: { ...center, ratio: 1 } }
    const a = current.sigma.framedGraphToViewport({ x: framed(minX), y: framed(minY) }, probe)
    const b = current.sigma.framedGraphToViewport({ x: framed(maxX), y: framed(maxY) }, probe)
    const { width, height } = current.sigma.getDimensions()
    // Labels run to the right of their node; keep room for them and for the zoom buttons (less on a small canvas).
    const roomX = width - Math.min(150, width * 0.3), roomY = height - Math.min(48, height * 0.15)
    const ratio = Math.max(Math.abs(b.x - a.x) / Math.max(40, roomX), Math.abs(b.y - a.y) / Math.max(40, roomY), 0.02)
    return { ...center, ratio: Math.min(ratio, 20) }
  }
  const fit = (duration = 0) => {
    const state = fitState(), camera = live.current?.sigma.getCamera()
    if (!state || !camera) return
    if (duration) void camera.animate(state, { duration })
    else camera.setState(state)
  }

  const hoverOf = (graph: Graph, id: string): Hover => {
    const nodes = new Set([id]), edges = new Set<string>()
    graph.forEachEdge(id, (edge, attributes, source, target) => {
      if (attributes.hidden) return
      edges.add(edge)
      nodes.add(source)
      nodes.add(target)
    })
    return { id, nodes, edges }
  }
  const repaint = () => live.current?.sigma.refresh({ skipIndexation: true })

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
        labelDensity: 0.6,
        labelGridCellSize: 110,
        labelRenderedSizeThreshold: labelThreshold(latest.current.settings),
        itemSizesReference: 'positions',
        zoomToSizeRatioFunction: ratio => ratio,
        minEdgeThickness: 0.7,
        zIndex: true,
        allowInvalidContainer: true,
        minCameraRatio: 0.004,
        maxCameraRatio: 24,
        nodeReducer: (id, data) => {
          const current = live.current, hover = current?.hover ?? current?.outerHover
          if (!hover || data.hidden) return data
          if (hover.nodes.has(id)) return { ...data, color: (data as { baseColor?: string }).baseColor ?? data.color, forceLabel: true, highlighted: id === hover.id, zIndex: id === hover.id ? 4 : 3 }
          return { ...data, color: latest.current.colors.faint, label: null, forceLabel: false, zIndex: 0 }
        },
        edgeReducer: (id, data) => {
          const current = live.current, hover = current?.hover ?? current?.outerHover
          if (!hover || data.hidden) return data
          return hover.edges.has(id) ? { ...data, color: latest.current.colors.accent, size: data.size * 1.4, zIndex: 2 } : { ...data, color: latest.current.colors.line, zIndex: 0 }
        },
      })
    } catch {
      latest.current.onUnavailable()
      return
    }
    sigma.setCustomBBox({ x: [-HALF, HALF], y: [-HALF, HALF] })
    const layout = new LiveLayout(graph, physicsOf(latest.current.settings), {
      tick: () => { if (live.current?.following) fit() },
      end: () => {
        const current = live.current
        if (!current) return
        current.following = false
        performance.mark('knowledge-graph:rest')
        if (latest.current.layoutKey) savePositions(latest.current.layoutKey, graph)
      },
    }, { calm: reducedMotion() })
    const current: Live = { sigma, graph, layout, laidOut: false, following: false, dragged: false }
    live.current = current
    const element = container.current!

    sigma.on('beforeRender', () => resetLabels(sigma.getCanvases().labels!))
    sigma.on('enterNode', ({ node }) => {
      current.hover = hoverOf(graph, node)
      if (!current.drag) element.style.cursor = 'pointer'
      repaint()
    })
    sigma.on('leaveNode', () => {
      current.hover = undefined
      if (!current.drag) element.style.cursor = ''
      repaint()
    })
    sigma.on('clickNode', ({ node, event }) => {
      if (current.dragged) { current.dragged = false; return }
      const original = event.original as MouseEvent
      const open = latest.current.onOpen
      if (open && (original.ctrlKey || original.metaKey)) open(node, true)
      else if (open && latest.current.clickOpens) open(node, false)
      else latest.current.onSelect(node)
    })
    sigma.on('doubleClickNode', payload => {
      payload.preventSigmaDefault()
      if (!latest.current.clickOpens) latest.current.onOpen?.(payload.node, false)
    })
    sigma.on('rightClickNode', ({ node, event }) => {
      const original = event.original as MouseEvent
      original.preventDefault()
      latest.current.onMenu?.(node, { x: original.clientX, y: original.clientY })
    })
    sigma.on('clickStage', () => { if (!latest.current.clickOpens) latest.current.onSelect(undefined) })

    // Dragging: the node follows the pointer, the camera holds still, the layout warms up while it moves.
    sigma.on('downNode', ({ node, event }) => {
      current.following = false
      current.drag = { id: node, x: event.x, y: event.y, moved: false }
    })
    sigma.on('moveBody', ({ event, preventSigmaDefault }) => {
      const drag = current.drag
      if (!drag) return
      if (!drag.moved && Math.hypot(event.x - drag.x, event.y - drag.y) < 3) return
      drag.moved = true
      element.style.cursor = 'grabbing'
      const at = sigma.viewportToGraph({ x: event.x, y: event.y })
      layout.drag(drag.id, at.x, at.y)
      preventSigmaDefault()
      event.original.preventDefault()
      event.original.stopPropagation()
    })
    const release = () => {
      const drag = current.drag
      if (!drag) return
      current.drag = undefined
      element.style.cursor = current.hover ? 'pointer' : ''
      if (!drag.moved) return
      current.dragged = true
      // The click event follows mouseup; forget a drag that ended off any node.
      setTimeout(() => { current.dragged = false }, 0)
      layout.release(drag.id)
    }
    window.addEventListener('pointerup', release)
    // Moving the camera yourself stops it following the spreading layout.
    const stopFollowing = () => { current.following = false }
    element.addEventListener('wheel', stopFollowing, { passive: true })
    element.addEventListener('pointerdown', stopFollowing)
    const noMenu = (event: MouseEvent) => event.preventDefault()
    element.addEventListener('contextmenu', noMenu)

    // Sigma follows window resizes only; split panes and hidden tabs resize the container itself.
    const observer = new ResizeObserver(() => {
      if (!element.offsetWidth) return
      sigma.resize()
      sigma.refresh()
      if (current.following) fit()
    })
    observer.observe(element)
    const visibility = () => { if (document.hidden || !latest.current.active) layout.pause(); else layout.resume() }
    document.addEventListener('visibilitychange', visibility)
    performance.mark('knowledge-graph:created')
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pointerup', release)
      element.removeEventListener('wheel', stopFollowing)
      element.removeEventListener('pointerdown', stopFollowing)
      element.removeEventListener('contextmenu', noMenu)
      if (current.laidOut && latest.current.layoutKey && layout.running) savePositions(latest.current.layoutKey, graph)
      layout.kill()
      sigma.kill()
      graph.clear()
      live.current = undefined
    }
  }, [])

  useEffect(() => {
    const layout = live.current?.layout
    if (!layout) return
    if (props.active && !document.hidden) layout.resume()
    else layout.pause()
  }, [props.active])

  // Forces and the label threshold: applied at once, and the layout moves to its new rest.
  const { center, repel, link, distance, labels } = props.settings
  useEffect(() => {
    const current = live.current
    if (!current?.laidOut) return
    // The camera keeps the whole graph in view while it moves to its new rest.
    current.following = true
    current.layout.setPhysics(physicsOf(props.settings))
  }, [center, repel, link, distance])
  useEffect(() => { live.current?.sigma.setSetting('labelRenderedSizeThreshold', labelThreshold(props.settings)) }, [labels])

  // Copy the model into the graph.
  const { nodeSize, edgeSize } = props.settings
  useEffect(() => {
    const current = live.current
    if (!current) return
    const { graph, sigma, layout } = current
    const { model, colors, layoutKey } = props
    const boost = props.boost ?? 1, nodeScale = sizeScale(nodeSize) * boost, edgeScale = sizeScale(edgeSize) * Math.sqrt(boost)
    Object.assign(theme, { text: colors.text, muted: colors.muted, surface: colors.surface, line: colors.line, font: colors.font })
    const nodes = new Map(model.nodes.map(node => [node.id, node]))
    const edges = new Map(model.edges.map(edge => [edge.id, edge]))
    const remembered = current.laidOut || !layoutKey ? {} : loadPositions(layoutKey)
    const placed = new Set<string>(graph.nodes())
    const added: string[] = []
    for (const node of model.nodes) {
      if (graph.hasNode(node.id)) continue
      const position = remembered[node.id]
      graph.addNode(node.id, { ...nodeAttributes(node, colors, nodeScale), x: position?.[0] ?? 0, y: position?.[1] ?? 0 })
      if (position) placed.add(node.id)
      else added.push(node.id)
    }
    for (const edge of model.edges) {
      if (!graph.hasEdge(edge.id) && graph.hasNode(edge.source) && graph.hasNode(edge.target)) graph.addEdgeWithKey(edge.id, edge.source, edge.target, edgeAttributes(edge, edgeScale))
    }
    // New nodes start next to their placed neighbours, or on a small seeded disc the first time.
    const positions = new Map<string, { x: number; y: number }>()
    const at = (id: string) => positions.get(id) ?? { x: graph.getNodeAttribute(id, 'x') as number, y: graph.getNodeAttribute(id, 'y') as number }
    const fresh = !current.laidOut && added.length > graph.order * 0.3
    for (const id of added) {
      positions.set(id, fresh ? seed(id, seedSpread(graph.order)) : placeNear(graph, id, placed, at))
      placed.add(id)
    }
    // Items the model leaves out stay in the graph, hidden: positions hold still while filters change,
    // and one batched update costs one refresh instead of one per node or relation. The hints must name
    // type and zIndex, or sigma treats the update as repaint-only and fails on relations just added.
    graph.updateEachNodeAttributes((id, attributes) => {
      const node = nodes.get(id)
      return node ? { ...attributes, ...nodeAttributes(node, colors, nodeScale), ...positions.get(id), hidden: false } : { ...attributes, hidden: true }
    }, { attributes: ['x', 'y', 'type', 'zIndex', 'hidden', 'color', 'size', 'label'] })
    graph.updateEachEdgeAttributes((id, attributes) => {
      const edge = edges.get(id)
      return edge ? { ...attributes, ...edgeAttributes(edge, edgeScale), hidden: false } : { ...attributes, hidden: true }
    }, { attributes: ['type', 'zIndex', 'hidden', 'color', 'size'] })
    // A hovered node may have been hidden, or gained relations.
    if (current.hover) current.hover = graph.hasNode(current.hover.id) && !graph.getNodeAttribute(current.hover.id, 'hidden') ? hoverOf(graph, current.hover.id) : undefined
    // Structure or sizes may have changed: the layout reads both (collisions use the sizes).
    layout.sync()
    sigma.refresh()
    if (!current.laidOut) {
      current.laidOut = true
      performance.mark('knowledge-graph:first-render')
      if (fresh) {
        // From scratch: spread out from the middle with the camera keeping it all in view.
        current.following = true
        layout.heat(1)
        fit()
      } else {
        fit()
        if (added.length) layout.heat(0.1)
      }
    } else if (added.length) {
      layout.heat(0.1)
    }
  }, [props.model, props.colors, nodeSize, edgeSize])

  useImperativeHandle(ref, () => ({
    zoomIn: () => { const current = live.current; if (current) { current.following = false; void current.sigma.getCamera().animatedZoom({ duration: 200 }) } },
    zoomOut: () => { const current = live.current; if (current) { current.following = false; void current.sigma.getCamera().animatedUnzoom({ duration: 200 }) } },
    reset: () => fit(300),
    relayout: () => {
      const current = live.current
      if (!current) return
      const spread = seedSpread(current.graph.order)
      current.graph.forEachNode(id => { const spot = seed(id, spread); current.layout.place(id, spot.x, spot.y) })
      current.following = true
      current.layout.heat(1)
      fit()
    },
    focus: id => {
      const current = live.current
      const data = current?.sigma.getNodeDisplayData(id)
      if (!current || !data) return
      current.following = false
      const camera = current.sigma.getCamera(), whole = fitState()
      // A small graph keeps its zoom and pans; a large one zooms in so the node's neighbours are readable.
      const ratio = current.graph.order > 100 && whole ? Math.min(camera.ratio, whole.ratio * 0.3) : camera.ratio
      void camera.animate({ x: data.x, y: data.y, ratio }, { duration: 400 })
    },
    highlight: id => {
      const current = live.current
      if (!current) return
      current.outerHover = id && current.graph.hasNode(id) && !current.graph.getNodeAttribute(id, 'hidden') ? hoverOf(current.graph, id) : undefined
      repaint()
    },
  }), [])

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = live.current
    if (!current || event.altKey || event.ctrlKey || event.metaKey) return
    const camera = current.sigma.getCamera(), state = camera.getState(), step = 0.12 * state.ratio
    const moves: Record<string, Partial<CameraState>> = {
      ArrowLeft: { x: state.x - step }, ArrowRight: { x: state.x + step }, ArrowUp: { y: state.y + step }, ArrowDown: { y: state.y - step },
    }
    if (event.key === '+' || event.key === '=') void camera.animatedZoom({ duration: 150 })
    else if (event.key === '-' || event.key === '_') void camera.animatedUnzoom({ duration: 150 })
    else if (event.key === '0') fit(300)
    else if (moves[event.key]) void camera.animate(moves[event.key]!, { duration: 120 })
    else return
    current.following = false
    event.preventDefault()
  }

  return <div ref={container} className="la-graph-canvas" role="application" tabIndex={0} aria-label={`${props.label}；加号、减号缩放，方向键平移，0 复位`} onKeyDown={keys} />
})
