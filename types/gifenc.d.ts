// gifenc ships no type declarations; these cover the calls scripts/gif.ts makes.
declare module 'gifenc' {
  export type Palette = number[][]
  export type ColorFormat = 'rgb565' | 'rgb444' | 'rgba4444'

  export interface FrameOptions {
    /** Required on the first frame (it becomes the global color table). */
    palette?: Palette
    /** Milliseconds; the file stores hundredths of a second. */
    delay?: number
    /** 0 loops forever, -1 plays once. */
    repeat?: number
    transparent?: boolean
    transparentIndex?: number
    dispose?: number
  }

  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, options?: FrameOptions): void
    finish(): void
    bytes(): Uint8Array
  }

  export function GIFEncoder(options?: { auto?: boolean; initialCapacity?: number }): Encoder
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: ColorFormat }): Palette
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: ColorFormat): Uint8Array

  const gifenc: { GIFEncoder: typeof GIFEncoder; quantize: typeof quantize; applyPalette: typeof applyPalette }
  export default gifenc
}
