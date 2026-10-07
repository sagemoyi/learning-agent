// Node shapes for the four kinds: knowledge is a circle, skill a square, integrated ability a
// diamond, complete task a triangle. The diamond and triangle reuse the square program's shader,
// which places the corners at fixed angles around the centre, so picking and sizing work the same.
// All share the themed label and hover card from draw.ts.
import { createNodeBorderProgram } from '@sigma/node-border'
import { NodeSquareProgram } from '@sigma/node-square'
import { NodeCircleProgram } from 'sigma/rendering'
import { drawNodeHover, drawNodeLabel } from './draw.ts'

type Definition = ReturnType<NodeSquareProgram['getDefinition']>
type Item = Parameters<NodeSquareProgram['processVisibleItem']>[2]

/** Same area as a circle of the same size, roughly: the square shader puts corners far out. */
const SHAPE_SCALE = { square: 0.8, diamond: 0.7, triangle: 0.86 }

export class KindCircleProgram extends NodeCircleProgram {
  drawLabel = drawNodeLabel
  drawHover = drawNodeHover
}

export class KindSquareProgram extends NodeSquareProgram {
  drawLabel = drawNodeLabel
  drawHover = drawNodeHover
  processVisibleItem(nodeIndex: number, startIndex: number, data: Item): void {
    super.processVisibleItem(nodeIndex, startIndex, { ...data, size: data.size * SHAPE_SCALE.square })
  }
}

export class KindDiamondProgram extends NodeSquareProgram {
  drawLabel = drawNodeLabel
  drawHover = drawNodeHover
  getDefinition(): Definition {
    const { PI } = Math
    return { ...super.getDefinition(), CONSTANT_DATA: [[0], [PI / 2], [PI], [0], [PI], [-PI / 2]] }
  }
  processVisibleItem(nodeIndex: number, startIndex: number, data: Item): void {
    super.processVisibleItem(nodeIndex, startIndex, { ...data, size: data.size * SHAPE_SCALE.diamond })
  }
}

export class KindTriangleProgram extends NodeSquareProgram {
  drawLabel = drawNodeLabel
  drawHover = drawNodeHover
  getDefinition(): Definition {
    const { PI } = Math
    return { ...super.getDefinition(), VERTICES: 3, CONSTANT_DATA: [[PI / 2], [PI / 2 + (2 * PI) / 3], [PI / 2 + (4 * PI) / 3]] }
  }
  processVisibleItem(nodeIndex: number, startIndex: number, data: Item): void {
    super.processVisibleItem(nodeIndex, startIndex, { ...data, size: data.size * SHAPE_SCALE.triangle })
  }
}

/** Materials in the source overlay: a ring, so they never read as a knowledge circle. */
export const SourceProgram = createNodeBorderProgram({
  borders: [{ size: { value: 0.32 }, color: { attribute: 'color' } }, { size: { fill: true }, color: { attribute: 'fillColor' } }],
  drawLabel: drawNodeLabel,
  drawHover: drawNodeHover,
})

export const NODE_PROGRAMS = { circle: KindCircleProgram, square: KindSquareProgram, diamond: KindDiamondProgram, triangle: KindTriangleProgram, source: SourceProgram }
