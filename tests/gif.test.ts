// The storyboard GIF encoder used by the learning-record-gif skill: frame count, timing, size checks.
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { encodeGif } from '../scripts/gif.ts'

function solid(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) png.data.set([...rgb, 255], i * 4)
  return PNG.sync.write(png)
}

/** Delays (hundredths of a second) of every graphic control extension block, in frame order. */
function delays(gif: Uint8Array): number[] {
  const found: number[] = []
  for (let i = 0; i + 5 < gif.length; i++) {
    if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 0x04) found.push(gif[i + 4]! | (gif[i + 5]! << 8))
  }
  return found
}

describe('storyboard GIF', () => {
  it('encodes each frame with its own duration and loops', () => {
    const frames = [solid(40, 30, [200, 40, 40]), solid(40, 30, [40, 40, 200]), solid(40, 30, [40, 160, 40])]
    const { bytes, summary } = encodeGif(frames.map((png, index) => ({ png, seconds: index === 2 ? 3 : 1.5 })))
    expect(new TextDecoder().decode(bytes.slice(0, 6))).toBe('GIF89a')
    expect([bytes[6]! | (bytes[7]! << 8), bytes[8]! | (bytes[9]! << 8)]).toEqual([40, 30])
    expect(new TextDecoder().decode(bytes)).toContain('NETSCAPE2.0')
    expect(delays(bytes)).toEqual([150, 150, 300])
    expect(bytes.at(-1)).toBe(0x3b)
    expect(summary).toEqual({ frames: 3, width: 40, height: 30, seconds: 6, bytes: bytes.length })
  })

  it('refuses a single frame, mixed sizes and empty durations', () => {
    expect(() => encodeGif([{ png: solid(4, 4, [0, 0, 0]), seconds: 1 }])).toThrow('至少要两帧')
    expect(() => encodeGif([{ png: solid(4, 4, [0, 0, 0]), seconds: 1 }, { png: solid(5, 4, [0, 0, 0]), seconds: 1 }])).toThrow('同一视口')
    expect(() => encodeGif([{ png: solid(4, 4, [0, 0, 0]), seconds: 1 }, { png: solid(4, 4, [0, 0, 0]), seconds: 0 }])).toThrow('大于 0')
  })
})
