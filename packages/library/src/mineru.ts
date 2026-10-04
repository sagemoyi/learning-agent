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
}

export interface MiddleDocument {
  readonly schema?: string
  readonly metadata?: { readonly producer?: { readonly name?: string; readonly version?: string }; readonly document?: { readonly page_count?: number } }
  readonly pages: readonly MiddlePage[]
}

export interface ParsedChunk {
  readonly locator: Locator
  readonly kind: ChunkKind
  readonly section: readonly string[]
  readonly text: string
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
  for (const document of documents) {
    if (document.schema && document.schema !== 'docvortex.middle') throw new Error(`不是 MinerU 结构化结果：${document.schema}`)
    for (const page of document.pages) pages.set(page.page_idx, page)
  }
  const ordered = [...pages.values()].sort((a, b) => a.page_idx - b.page_idx)

  const path: string[] = []
  let leaf: string | undefined
  const chunks: ParsedChunk[] = []
  for (const page of ordered) {
    for (const block of [...page.blocks].sort((a, b) => a.index - b.index)) {
      if (!block.type || SKIPPED.has(block.type)) continue
      const text = flatten(block).trim()
      if (!text && block.type !== 'image') continue
      if (block.type === 'paragraph_title' || block.type === 'title') {
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
      const kind = kindOf(block, text, section)
      if (!kind) continue
      const bbox = block.bbox?.length === 4 ? (block.bbox as [number, number, number, number]) : undefined
      chunks.push({
        locator: { page: page.page_idx + 1, block: block.index, ...(bbox ? { bbox } : {}) },
        kind,
        section: [...section],
        text: text || '（图）',
      })
    }
  }
  return chunks
}
