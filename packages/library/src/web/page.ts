// A web page as citable chunks: decode, keep the main text (Mozilla Readability, which found the article
// on old university sites where Defuddle took the navigation; compatibility.md 10-07), turn it into
// Markdown, and split it into blocks. Pages have no page numbers: every chunk is on "page 1", in order.
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'
import { tables } from 'turndown-plugin-gfm'
import type { ChunkKind } from '@learning-agent/contracts'

export interface PageChunk {
  readonly locator: { readonly page: 1; readonly block: number }
  readonly kind: ChunkKind
  readonly section: string[]
  readonly text: string
}

/** The declared charset (header, then meta tag); GBK-family pages decode as GB18030, its superset. */
export function decodeHtml(body: Buffer, contentType: string): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1] ?? 'utf-8'
  const label = /^(gb2312|gbk|x-gbk|gb_2312-80)$/i.test(declared) ? 'gb18030' : declared
  try { return new TextDecoder(label).decode(body) } catch { return new TextDecoder('utf-8').decode(body) }
}

function turndown(): TurndownService {
  const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
  service.use(tables)
  // Images are not downloaded; their description, if any, stays as text. Links keep only their words.
  service.addRule('image', { filter: 'img', replacement: (_, node) => { const alt = (node as HTMLElement).getAttribute('alt')?.trim(); return alt ? `[图：${alt}]` : '' } })
  service.addRule('link', { filter: 'a', replacement: content => content })
  service.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button'])
  return service
}

/** The page's main text as Markdown, with its title. Falls back to the whole body when no article is found. */
export function readPage(html: string): { title: string; markdown: string } {
  const { document } = parseHTML(html)
  if (!document.documentElement) return { title: '', markdown: '' }
  const title = document.querySelector('title')?.textContent?.trim() ?? ''
  // Readability edits the document it reads, so it gets its own copy.
  const article = new Readability(parseHTML(html).document as unknown as Document, { charThreshold: 200 }).parse()
  const markdown = turndown().turndown(article?.content ?? document.body?.innerHTML ?? '')
  return { title: article?.title?.trim() || title, markdown: tidy(markdown) }
}

function tidy(markdown: string): string {
  return markdown.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const MERGE_UNDER = 200
const MERGE_UP_TO = 800
const SPLIT_OVER = 1500
const PIECE = 1200

/** Split at sentence ends so no chunk is longer than a reranker can weigh or a reader can check. */
function pieces(text: string): string[] {
  if (text.length <= SPLIT_OVER) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > PIECE) {
    const window = rest.slice(0, PIECE)
    const cut = Math.max(...['。', '！', '？', '. ', '! ', '? ', '\n'].map(mark => window.lastIndexOf(mark)))
    const at = cut > PIECE / 3 ? cut + 1 : PIECE
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at)
  }
  if (rest.trim()) out.push(rest.trim())
  return out
}

/** Blocks separated by blank lines; fenced code and display math stay whole. */
function blocks(markdown: string): string[] {
  const out: string[] = []
  let current: string[] = []
  let fence: string | undefined
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^(```|~~~|\$\$)/.exec(line.trim())?.[1]
    if (fence) {
      current.push(line)
      if (marker === fence && current.length > 1) { out.push(current.join('\n')); current = []; fence = undefined }
      continue
    }
    if (marker && !(marker === '$$' && line.trim().length > 2 && line.trim().endsWith('$$'))) {
      if (current.length) out.push(current.join('\n'))
      current = [line]
      fence = marker
      continue
    }
    if (!line.trim()) { if (current.length) out.push(current.join('\n')); current = []; continue }
    // A heading is a block of its own even without blank lines around it.
    if (/^#{1,6}\s/.test(line)) { if (current.length) out.push(current.join('\n')); out.push(line); current = []; continue }
    current.push(line)
  }
  if (current.length) out.push(current.join('\n'))
  return out.map(block => block.trim()).filter(Boolean)
}

/** Headings set the section path; short paragraphs under one heading merge; long ones split. */
export function chunksFromMarkdown(markdown: string): PageChunk[] {
  const chunks: { kind: ChunkKind; section: string[]; text: string }[] = []
  const path: { level: number; title: string }[] = []
  for (const block of blocks(markdown)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(block)
    if (heading) {
      const level = heading[1]!.length
      while (path.length && path.at(-1)!.level >= level) path.pop()
      path.push({ level, title: heading[2]!.trim() })
      chunks.push({ kind: 'heading', section: path.map(entry => entry.title), text: heading[2]!.trim() })
      continue
    }
    const section = path.map(entry => entry.title)
    const kind: ChunkKind = /^\|.*\|$/m.test(block) && /^\|?\s*:?-{3,}/m.test(block) ? 'table' : /^\$\$[\s\S]*\$\$$/.test(block) ? 'formula' : 'text'
    const previous = chunks.at(-1)
    if (kind === 'text' && previous?.kind === 'text' && previous.section.join('\u0000') === section.join('\u0000') && (previous.text.length < MERGE_UNDER || block.length < MERGE_UNDER) && previous.text.length + block.length <= MERGE_UP_TO) {
      previous.text = `${previous.text}\n\n${block}`
      continue
    }
    for (const text of kind === 'text' ? pieces(block) : [block]) chunks.push({ kind, section, text })
  }
  return chunks.map((chunk, block) => ({ locator: { page: 1, block }, ...chunk }))
}
