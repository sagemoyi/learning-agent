// MinerU `docvortex.middle` output → locatable chunks (contracts §4.5).
// One parser block = one chunk. Page furniture (headers, page numbers, footers) is dropped;
// numbered headings build the section path (`第1章 …` › `1.2 …` › `1.2.3 …`).
import type { ChunkKind, Locator } from '@learning-agent/contracts'

interface MiddleContent {
  readonly type?: string
  readonly content?: string | readonly MiddleContent[]
}

interface MiddleBlock extends MiddleContent {
  readonly index: number
  readonly bbox?: readonly number[]
}

interface MiddlePage {
  readonly page_idx: number
  readonly blocks: readonly MiddleBlock[]
  readonly extensions?: { readonly docvortex_layout?: { readonly width_pt?: number; readonly height_pt?: number } }
}

export interface MiddleDocument {
  readonly schema?: string
  readonly schema_version?: string
  readonly extensions?: { readonly docvortex_layout?: { readonly version?: number; readonly pages?: readonly { readonly page_idx: number; readonly width_pt: number; readonly height_pt: number }[] } }
  readonly metadata?: { readonly producer?: { readonly name?: string; readonly version?: string }; readonly document?: { readonly page_count?: number } }
  readonly pages: readonly MiddlePage[]
}

/** MinerU 3 middle JSON (`pdf_info`), as the MinerU cloud returns it. Coordinates are PDF points. */
interface PdfInfoSpan { readonly type?: string; readonly content?: string; readonly html?: string; readonly image_path?: string }
interface PdfInfoBlock {
  readonly type?: string
  readonly index?: number
  readonly bbox?: readonly number[]
  readonly lines?: readonly { readonly spans?: readonly PdfInfoSpan[] }[]
  readonly blocks?: readonly PdfInfoBlock[]
}
export interface PdfInfoDocument {
  readonly pdf_info: readonly { readonly page_idx: number; readonly page_size?: readonly number[]; readonly para_blocks?: readonly PdfInfoBlock[] }[]
  readonly _version_name?: string
}

const PDF_INFO_TYPES: Record<string, string> = { title: 'paragraph_title', interline_equation: 'equation', inline_equation: 'equation_inline' }

function spansOf(block: PdfInfoBlock): MiddleContent[] {
  const parts: MiddleContent[] = []
  for (const line of block.lines ?? []) {
    for (const span of line.spans ?? []) {
      const type = PDF_INFO_TYPES[span.type ?? ''] ?? span.type
      if (span.type === 'table' && span.html) parts.push({ type: 'table_body', content: span.html })
      else if (typeof span.content === 'string') {
        // Lines of Latin text need a space where MinerU broke them; Chinese joins directly.
        const previous = parts.at(-1)?.content
        const joint = typeof previous === 'string' && /[A-Za-z0-9,.;:)]$/.test(previous) && /^[A-Za-z0-9(]/.test(span.content) ? ' ' : ''
        parts.push({ type: type === 'equation_inline' || type === 'interline_equation' ? type : 'text', content: joint + span.content })
      } else if (span.image_path) parts.push({ type: 'image_path', content: '', image_path: span.image_path } as MiddleContent)
    }
  }
  return parts
}

/**
 * Convert a cloud `pdf_info` document into the `docvortex.middle` shape `chunksFromMiddle` reads.
 * `firstPage` is the 1-based PDF page the part starts at: cloud page indexes restart at 0 per range.
 */
export function fromPdfInfo(document: PdfInfoDocument, firstPage = 1): MiddleDocument {
  if (!Array.isArray(document.pdf_info)) throw new Error('云端解析结果缺少页面')
  const pages = document.pdf_info.map(page => {
    const pageIdx = page.page_idx + firstPage - 1
    const [width, height] = page.page_size ?? []
    const blocks = (page.para_blocks ?? []).map((block: PdfInfoBlock, order: number): MiddleBlock => {
      const index = block.index ?? order
      const bbox = block.bbox?.length === 4 ? block.bbox : undefined
      if (block.type === 'list') {
        const items = (block.blocks ?? [block]).map((item: PdfInfoBlock) => flatten({ content: spansOf(item) })).filter(Boolean)
        return { type: 'text', index, bbox, content: items.join('\n') }
      }
      if (block.type === 'image' || block.type === 'table' || block.type === 'chart') {
        return { type: block.type, index, bbox, content: (block.blocks ?? []).map((child: PdfInfoBlock) => ({ type: child.type, content: spansOf(child) })) }
      }
      if (block.type === 'interline_equation') {
        const latex = spansOf(block).map(part => part.content).join('').trim()
        return { type: 'equation', index, bbox, content: [{ type: 'equation', content: latex }] }
      }
      return { type: PDF_INFO_TYPES[block.type ?? ''] ?? block.type, index, bbox, content: spansOf(block) }
    })
    return { page_idx: pageIdx, blocks, ...(width && height ? { extensions: { docvortex_layout: { width_pt: width, height_pt: height } } } : {}) }
  })
  return { schema: 'docvortex.middle', metadata: { producer: { name: 'mineru-cloud', version: document._version_name ?? '' }, document: { page_count: pages.length } }, pages }
}

export interface ParsedChunk {
  readonly locator: Locator
  readonly kind: ChunkKind
  readonly section: readonly string[]
  readonly text: string
  readonly problemGroup?: string
}

const SKIPPED = new Set(['header', 'page_number', 'footer', 'page_footnote'])
const CHAPTER = /^第\s*\d+\s*章/
const NUMBERED = /^(\d+(?:\.\d+)*)\s/
/** Unnumbered headings that sit directly under the chapter. */
const CHAPTER_PARTS = /^(习题|复习思考题|本章主要符号|本章小结|思考题)/

/** HTML table → plain rows (`a | b | c`). */
function tableText(html: string): string {
  return html
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/ \| \n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** Flatten a block's content into Markdown text with `$…$` inline math. */
export function flatten(item: MiddleContent): string {
  const { type, content } = item
  if (typeof content === 'string') {
    if (type === 'equation_inline') return `$${content.trim()}$`
    if (type === 'equation' || type === 'interline_equation') return `$$\n${content.trim()}\n$$`
    if (type === 'table_body') return tableText(content)
    return content
  }
  if (!content) return ''
  const parts = content.map(flatten).filter(part => part.trim())
  const block = type === 'image' || type === 'chart' || type === 'table'
  return parts.join(block ? '\n' : '').replace(/[ \t]{2,}/g, ' ').trim()
}

function kindOf(block: MiddleBlock, text: string, section: readonly string[]): ChunkKind | undefined {
  switch (block.type) {
    case 'paragraph_title':
    case 'title':
      return 'heading'
    case 'equation':
    case 'interline_equation':
      return 'formula'
    case 'table':
      return 'table'
    case 'image':
    case 'chart':
      return 'figure'
  }
  const inExercises = section.some(part => /^(习题|复习思考题|思考题)/.test(part))
  if (/^\s*\[[^\]]+\]\s*$/.test(text) && inExercises) return 'answer'
  if (/^\s*\[?例\s*\d+-\d+\]?/.test(text)) return 'example'
  if (inExercises && /^\s*\d+-\d+\s/.test(text)) return 'exercise'
  return 'text'
}

/** Depth of a heading in the section path, or undefined to keep it as a leaf label. */
function headingDepth(title: string): number | undefined {
  if (CHAPTER.test(title)) return 0
  const numbered = NUMBERED.exec(title)
  if (numbered) return numbered[1]!.split('.').length - 1
  if (CHAPTER_PARTS.test(title)) return 1
  return undefined
}

/** Merge several parsed files (page ranges) of one source and cut them into chunks in reading order. */
export function chunksFromMiddle(documents: readonly MiddleDocument[]): ParsedChunk[] {
  const pages = new Map<number, MiddlePage>()
  const sizes = new Map<number, [number, number]>()
  const normalizedPages = new Set<number>()
  for (const document of documents) {
    if (document.schema && document.schema !== 'docvortex.middle') throw new Error(`不是 MinerU 结构化结果：${document.schema}`)
    if (document.schema_version && document.schema_version !== '2.0') throw new Error('不支持此结构化结果版本，请使用已验证的 MinerU 4')
    const layout = document.extensions?.docvortex_layout
    if (layout?.version === 1) for (const page of layout.pages ?? []) {
      if (Number.isFinite(page.width_pt) && Number.isFinite(page.height_pt) && page.width_pt > 0 && page.height_pt > 0) sizes.set(page.page_idx, [page.width_pt, page.height_pt])
    }
    if (!Array.isArray(document.pages)) throw new Error('解析结果缺少页面')
    for (const page of document.pages) {
      if (!Number.isInteger(page.page_idx) || page.page_idx < 0 || !Array.isArray(page.blocks)) throw new Error('解析结果的页面无效')
      if (pages.has(page.page_idx)) throw new Error('解析页范围重叠，不能静默覆盖已有页面')
      pages.set(page.page_idx, page)
      if (document.schema_version === '2.0') normalizedPages.add(page.page_idx)
    }
  }
  const ordered = [...pages.values()].sort((a, b) => a.page_idx - b.page_idx)

  const path: string[] = []
  let leaf: string | undefined
  const chunks: ParsedChunk[] = []
  let problemGroup: string | undefined
  let inAnswer = false
  for (const page of ordered) {
    for (const block of [...page.blocks].sort((a, b) => a.index - b.index)) {
      if (!block.type || SKIPPED.has(block.type)) continue
      const text = flatten(block).trim()
      if (!text && block.type !== 'image') continue
      const isHeading = block.type === 'paragraph_title' || block.type === 'title' || /^(习题|复习思考题|思考题)$/.test(text)
      if (isHeading) {
        problemGroup = undefined; inAnswer = false
        const depth = headingDepth(text)
        if (depth === undefined) {
          leaf = text
        } else {
          path.length = Math.min(path.length, depth)
          path[depth] = text
          path.length = depth + 1
          leaf = undefined
        }
      }
      const section = leaf ? [...path.filter(Boolean), leaf] : path.filter(Boolean)
      let kind = isHeading ? 'heading' as const : kindOf(block, text, section)
      if (!kind) continue
      const inExercises = section.some(part => /^(习题|复习思考题|思考题)/.test(part))
      if (inExercises && kind !== 'heading') {
        const stem = /^\s*(\d+-\d+)\s/.exec(text)
        if (stem) { problemGroup = stem[1]; inAnswer = false }
        if (problemGroup && /^\s*\[[\s\S]+\]\s*$/.test(text)) inAnswer = true
        if (kind === 'text') kind = inAnswer ? 'answer' : 'exercise'
      }
      let bbox = block.bbox?.length === 4 && block.bbox.every(Number.isFinite) ? (block.bbox as [number, number, number, number]) : undefined
      const geometry = page.extensions?.docvortex_layout
      const pageSize: [number, number] | undefined = sizes.get(page.page_idx) ?? (geometry?.width_pt && geometry?.height_pt ? [geometry.width_pt, geometry.height_pt] : undefined)
      if (bbox && normalizedPages.has(page.page_idx)) {
        if (bbox.some(n => n < 0 || n > 1) || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) throw new Error('解析块的归一化坐标无效')
        if (pageSize) bbox = [bbox[0] * pageSize[0], bbox[1] * pageSize[1], bbox[2] * pageSize[0], bbox[3] * pageSize[1]]
      }
      chunks.push({
        locator: { page: page.page_idx + 1, block: block.index, ...(bbox ? { bbox } : {}), ...(pageSize ? { pageSize } : {}) },
        kind,
        section: [...section],
        text: text || '（图）',
        ...(inExercises && problemGroup ? { problemGroup } : {}),
      })
    }
  }
  return chunks
}
