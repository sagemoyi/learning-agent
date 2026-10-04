import type { Locator } from '@learning-agent/contracts'

/** Parser coordinates start at the top left; PDF coordinates start at the bottom left. */
export function citationRectangle(locator: Locator, pdfView: readonly number[], convert: (rect: number[]) => number[], intrinsicRotation = 0): { left: number; top: number; width: number; height: number } | undefined {
  if (!locator.bbox || !locator.pageSize) return undefined
  const [x0, y0, x1, y1] = locator.bbox
  const [width, height] = locator.pageSize
  if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0 || x1 > width || y1 > height) return undefined
  const [px0, py0, px1, py1] = pdfView as [number, number, number, number]
  // MinerU uses the visible (already intrinsically rotated) page; undo that rotation first.
  const point = (x: number, y: number): [number, number] => {
    const sx = x / width, sy = y / height, w = px1 - px0, h = py1 - py0
    switch ((intrinsicRotation % 360 + 360) % 360) {
      case 90: return [px0 + sy * w, py0 + sx * h]
      case 180: return [px1 - sx * w, py0 + sy * h]
      case 270: return [px1 - sy * w, py1 - sx * h]
      default: return [px0 + sx * w, py1 - sy * h]
    }
  }
  const rect = convert([...point(x0, y0), ...point(x1, y1)])
  const [a, b, c, d] = rect as [number, number, number, number]
  return { left: Math.min(a, c), top: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b) }
}
