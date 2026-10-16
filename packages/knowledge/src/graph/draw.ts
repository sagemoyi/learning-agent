// Canvas labels and hover cards for graph nodes, in the shell's colours and font. Sigma draws them on
// a 2D layer above the WebGL shapes; the colours are read from the page's tokens (see colors.ts).
import type { Attributes } from 'graphology-types'
import type { Settings } from 'sigma/settings'
import type { NodeDisplayData, PartialButFor } from 'sigma/types'

export interface GraphTheme {
  text: string
  muted: string
  surface: string
  line: string
  font: string
}

/** Set by the view whenever it reads the page tokens (theme switch); one theme per page at a time. */
export const theme: GraphTheme = { text: '#1c1b18', muted: '#6b6962', surface: '#ffffff', line: '#e2e0d8', font: 'sans-serif' }

type Extra = { labelColor?: string; subtitle?: string }
type Data = PartialButFor<NodeDisplayData, 'x' | 'y' | 'size' | 'label' | 'color'>

export function drawNodeLabel<N extends Attributes, E extends Attributes, G extends Attributes>(context: CanvasRenderingContext2D, data: Data, settings: Settings<N, E, G>): void {
  if (!data.label) return
  const extra = data as typeof data & Extra
  context.font = `${settings.labelWeight} ${settings.labelSize}px ${theme.font}`
  let label = data.label, width = context.measureText(label).width
  const x = labelX(context, data, width)
  // A name with no room left on either side ends in "…" at the canvas edge (the hover card shows it whole).
  const canvas = context.canvas.width / (window.devicePixelRatio || 1)
  const room = x < data.x ? data.x - data.size - 4 : canvas - 4 - x
  if (width > room && room > settings.labelSize * 2) {
    const chars = [...label]
    while (chars.length > 1 && context.measureText(`${chars.join('')}…`).width > room) chars.pop()
    label = `${chars.join('')}…`
    width = context.measureText(label).width
  }
  // Skip a label that would cover one already drawn this frame; forced ones (selected, in focus) always show.
  const left = x < data.x ? data.x - data.size - 4 - width : x
  const box = { x: left - 2, y: data.y - settings.labelSize / 2 - 2, w: width + 4, h: settings.labelSize + 4 }
  const drawn = labelBoxes.get(context.canvas) ?? []
  if (!data.forceLabel && drawn.some(other => box.x < other.x + other.w && other.x < box.x + box.w && box.y < other.y + other.h && other.y < box.y + box.h)) return
  labelBoxes.set(context.canvas, [...drawn, box])
  context.fillStyle = extra.labelColor ?? theme.text
  context.textBaseline = 'middle'
  context.fillText(label, left, data.y)
}

type Box = { x: number; y: number; w: number; h: number }
const labelBoxes = new WeakMap<HTMLCanvasElement, Box[]>()

/** Forget the labels drawn on a canvas; call before each render. */
export function resetLabels(canvas: HTMLCanvasElement): void {
  labelBoxes.set(canvas, [])
}

/** Room kept clear on the right of a page's canvas: the zoom buttons sit there (a small canvas has none). */
const RIGHT_CLEAR = 52

/**
 * Labels run to the right of their node, or to the left when they would leave the canvas there; when neither side
 * has room, the side with more.
 */
function labelX(context: CanvasRenderingContext2D, data: Data, width: number): number {
  const canvas = context.canvas.width / (window.devicePixelRatio || 1)
  const right = canvas - (canvas < 480 ? 4 : RIGHT_CLEAR)
  const after = data.x + data.size + 4, before = data.x - data.size - 4 - width
  if (after + width <= right || right - after >= before) return after
  return before
}

export function drawNodeHover<N extends Attributes, E extends Attributes, G extends Attributes>(context: CanvasRenderingContext2D, data: Data, settings: Settings<N, E, G>): void {
  if (!data.label) return
  const extra = data as typeof data & Extra
  const size = settings.labelSize
  const title = `500 ${size}px ${theme.font}`, small = `400 ${size - 1}px ${theme.font}`
  context.font = title
  const titleWidth = context.measureText(data.label).width
  context.font = small
  const subtitleWidth = extra.subtitle ? context.measureText(extra.subtitle).width : 0
  const padding = 6, lineHeight = size + 4
  const height = (extra.subtitle ? 2 * lineHeight : lineHeight) + padding * 2 - 4
  const textWidth = Math.max(titleWidth, subtitleWidth)
  const textX = labelX(context, data, textWidth)
  const left = textX < data.x
  const x = left ? textX - padding : data.x - data.size - padding, y = data.y - Math.max(data.size, lineHeight / 2) - padding + 2
  const width = data.size * 2 + padding * 2 + 4 + textWidth
  context.save()
  context.shadowColor = 'rgba(0, 0, 0, 0.12)'
  context.shadowBlur = 8
  context.fillStyle = theme.surface
  context.beginPath()
  context.roundRect(x, y, width, Math.max(height, data.size * 2 + padding * 2), 6)
  context.fill()
  context.shadowBlur = 0
  context.strokeStyle = theme.line
  context.lineWidth = 1
  context.stroke()
  context.restore()
  context.textBaseline = 'middle'
  context.font = title
  context.fillStyle = theme.text
  context.fillText(data.label, textX, extra.subtitle ? data.y - lineHeight / 2 + 2 : data.y)
  if (extra.subtitle) {
    context.font = small
    context.fillStyle = theme.muted
    context.fillText(extra.subtitle, textX, data.y + lineHeight / 2 + 1)
  }
}
