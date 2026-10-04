// Read a PDF's page count without rendering it: the root of the page tree is the `/Type /Pages`
// node with the largest `/Count`. Nodes may sit in plain objects or in compressed object streams.
import { inflateSync } from 'node:zlib'

const OBJECT = /\b\d+\s+\d+\s+obj\b/g

export function pdfPageCount(pdf: Uint8Array): number | undefined {
  const text = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength).toString('latin1')
  let best = 0
  const consider = (body: string) => {
    if (!/\/Type\s*\/Pages\b/.test(body)) return
    const count = /\/Count\s+(\d+)(?!\s+\d+\s+R)/.exec(body)
    if (count) best = Math.max(best, Number(count[1]))
  }
  const starts = [...text.matchAll(OBJECT)].map(match => match.index!)
  for (const [i, start] of starts.entries()) {
    const end = text.indexOf('endobj', start)
    const body = text.slice(start, end < 0 ? starts[i + 1] ?? text.length : end)
    const head = body.slice(0, body.indexOf('stream') < 0 ? body.length : body.indexOf('stream'))
    consider(head)
    if (/\/Type\s*\/ObjStm\b/.test(head)) for (const inner of objectStream(pdf, start, body, head)) consider(inner)
  }
  if (best > 0) return best
  const linearized = /\/Linearized\b[^>]*?\/N\s+(\d+)/.exec(text.slice(0, 2048))
  return linearized ? Number(linearized[1]) : undefined
}

/** Objects packed in an `/ObjStm` stream (Flate only; others are skipped). */
function objectStream(pdf: Uint8Array, offset: number, body: string, head: string): string[] {
  const n = Number(/\/N\s+(\d+)/.exec(head)?.[1])
  const first = Number(/\/First\s+(\d+)/.exec(head)?.[1])
  const filter = /\/Filter\s*\/(\w+)/.exec(head)?.[1]
  const marker = /stream\r?\n/.exec(body)
  if (!n || !Number.isFinite(first) || (filter && filter !== 'FlateDecode') || !marker) return []
  const dataStart = offset + marker.index + marker[0].length
  const length = Number(/\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(head)?.[1])
  const dataEnd = Number.isFinite(length) && length > 0 ? dataStart + length : offset + body.lastIndexOf('endstream')
  let data: string
  try {
    const raw = pdf.subarray(dataStart, dataEnd)
    data = (filter ? inflateSync(raw) : Buffer.from(raw)).toString('latin1')
  } catch { return [] }
  const offsets = data.slice(0, first).trim().split(/\s+/).map(Number).filter((_, i) => i % 2 === 1)
  return offsets.map((at, i) => data.slice(first + at, i + 1 < offsets.length ? first + offsets[i + 1]! : data.length))
}

/** Split `pages` into consecutive 1-based ranges of at most `size` pages ("1-200", "201-400", …). */
export function pageRanges(pages: number, size: number): string[] {
  const ranges: string[] = []
  for (let start = 1; start <= pages; start += size) ranges.push(`${start}-${Math.min(pages, start + size - 1)}`)
  return ranges
}
