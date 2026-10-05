// Encode PNG screenshots into an animated GIF storyboard (gifenc + pngjs; no ffmpeg or Python).
// Used by the learning-record-gif skill (.agents/skills/).
//
// Usage: node scripts/gif.ts <frames-dir | a.png b.png ...> --out <file.gif>
//          [--durations 1.5,1.5,3] [--colors 256] [--force]
// A directory contributes its PNGs in file-name order (name them 00-start.png, 01-typed.png, ...).
// One duration applies to every frame; otherwise give one per frame. Default: 1.5 s each, 3 s on the last.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as gifencModule from 'gifenc'
import { PNG } from 'pngjs'

// Node loads gifenc's CommonJS build (functions on the default export); vitest loads its ESM build (named exports).
const gifenc = typeof gifencModule.GIFEncoder === 'function' ? gifencModule : gifencModule.default

export interface Frame {
  readonly png: Uint8Array
  /** How long the frame stays on screen; GIF stores hundredths of a second. */
  readonly seconds: number
}

export interface GifSummary {
  readonly frames: number
  readonly width: number
  readonly height: number
  readonly seconds: number
  readonly bytes: number
}

/**
 * Encode frames that share one size into a looping GIF. Each frame gets its own palette of at most
 * `colors` entries. Throws on fewer than two frames, mismatched sizes, or a non-positive duration.
 */
export function encodeGif(frames: readonly Frame[], { colors = 256 }: { readonly colors?: number } = {}): { bytes: Uint8Array; summary: GifSummary } {
  if (frames.length < 2) throw new Error(`GIF 至少要两帧，现在只有 ${frames.length} 帧`)
  const gif = gifenc.GIFEncoder()
  let size: { width: number; height: number } | undefined
  frames.forEach((frame, index) => {
    if (!(frame.seconds > 0)) throw new Error(`第 ${index + 1} 帧的时长必须大于 0`)
    const image = PNG.sync.read(Buffer.from(frame.png))
    size ??= { width: image.width, height: image.height }
    if (image.width !== size.width || image.height !== size.height) {
      throw new Error(`第 ${index + 1} 帧是 ${image.width}×${image.height}，与第 1 帧的 ${size.width}×${size.height} 不同；用同一视口截图`)
    }
    const palette = gifenc.quantize(image.data, colors)
    gif.writeFrame(gifenc.applyPalette(image.data, palette), image.width, image.height, { palette, delay: Math.round(frame.seconds * 1000), repeat: 0 })
  })
  gif.finish()
  const bytes = gif.bytes()
  const seconds = frames.reduce((sum, frame) => sum + frame.seconds, 0)
  return { bytes, summary: { frames: frames.length, width: size!.width, height: size!.height, seconds, bytes: bytes.length } }
}

function framePaths(inputs: readonly string[]): string[] {
  return inputs.flatMap(input => statSync(input).isDirectory()
    ? readdirSync(input).filter(name => name.toLowerCase().endsWith('.png')).sort().map(name => join(input, name))
    : [input])
}

function durationsFor(count: number, spec: string | undefined): number[] {
  if (!spec) return Array.from({ length: count }, (_, index) => (index === count - 1 ? 3 : 1.5))
  const values = spec.split(',').map(Number)
  if (values.length === 1) return Array.from({ length: count }, () => values[0]!)
  if (values.length !== count) throw new Error(`给了 ${values.length} 个时长，但有 ${count} 帧`)
  return values
}

function main(argv: readonly string[]): void {
  const inputs: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) inputs.push(arg)
    else if (arg === '--force') flags.force = true
    else flags[arg.slice(2)] = argv[++i] ?? ''
  }
  const out = typeof flags.out === 'string' ? resolve(flags.out) : undefined
  if (!out || inputs.length === 0) throw new Error('用法：node scripts/gif.ts <帧目录或 PNG...> --out <文件.gif> [--durations 1.5,3] [--colors 256] [--force]')
  if (existsSync(out) && !flags.force) throw new Error(`${out} 已存在；确认要覆盖时加 --force`)
  const paths = framePaths(inputs)
  const seconds = durationsFor(paths.length, typeof flags.durations === 'string' ? flags.durations : undefined)
  const colors = typeof flags.colors === 'string' ? Number(flags.colors) : undefined
  const { bytes, summary } = encodeGif(paths.map((path, index) => ({ png: readFileSync(path), seconds: seconds[index]! })), colors ? { colors } : {})
  writeFileSync(out, bytes)
  console.log(JSON.stringify({ out, ...summary }))
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
  }
}
