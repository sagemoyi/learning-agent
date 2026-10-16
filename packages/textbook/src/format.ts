// Textbook file format (contracts §3.2): blocks end with ` ^id` (display math and quote boxes: `^id` on a
// line of its own), citations are `[label](cite:ck_…)` or a web page's address, source text copied in is a
// `> [!quote]` box (embed.ts). `finalize` turns a model draft into that format; `indexBlocks` reads it back.
// Files written before 10-15 may still carry `[待核实](cite:unverified)`; it is read, never written.
import { createHash } from 'node:crypto'
import { parseFrontmatter } from '@learning-agent/contracts'
import { EMBED_ANYWHERE, EMBED_LINE, expandEmbed, isOriginal, type EmbedSource } from './embed.ts'

const CITE = /\[([^\]]*)\]\(cite:([^)\s]+)\)/g
const WEB_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
const TRAILING_ID = /\s\^([0-9a-z]{6})\s*$/
const LONE_ID = /^\^([0-9a-z]{6})\s*$/
/** A comma between two citation links: the reader shows them as tags side by side. */
const BETWEEN_LINKS = /(\]\((?:cite:|https?:\/\/)[^)\s]+\))\s*[、，,；;]\s*(?=\[[^\]]*\]\((?:cite:|https?:\/\/))/g

export interface BlockIndex {
  readonly id: string
  readonly text: string
  readonly hash: string
  readonly citations: string[]
  readonly unverified: boolean
  /** Under a "读完就答" heading: asks the learner, explains nothing. */
  readonly recall: boolean
  /** A quote box of source text the program copied in. */
  readonly original: boolean
}

/** Split Markdown into paragraphs, keeping `$$ … $$` display math whole. */
export function splitPieces(text: string): string[] {
  const pieces: string[] = []
  let current: string[] = []
  let inMath = false
  const flush = () => {
    if (current.some(line => line.trim())) pieces.push(current.join('\n').trim())
    current = []
  }
  for (const line of text.split(/\r?\n/)) {
    // Models may put consecutive headings and body text together without blank lines.
    // Keep headings separate so the following prose gets its own citation check and block id.
    if (!inMath && isHeading(line)) {
      flush()
      pieces.push(line.trim())
      continue
    }
    if (!inMath && line.trim() === '') {
      flush()
      continue
    }
    current.push(line)
    const fences = (line.match(/\$\$/g) ?? []).length
    if (fences % 2 === 1) inMath = !inMath
  }
  flush()
  return pieces
}

function isHeading(piece: string): boolean {
  return /^#{1,6}\s/.test(piece)
}

function isDisplayMath(piece: string): boolean {
  return /^\$\$[\s\S]*\$\$$/.test(piece.trim())
}

/** Strip code fences and frontmatter a model sometimes wraps its answer in. */
function unwrap(draft: string): string {
  let text = draft.trim()
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(text)
  if (fenced) text = fenced[1]!
  return parseFrontmatter(text).body.trim()
}

/** Headings whose blocks ask the learner questions instead of explaining. */
const QUESTION_HEADING = /读完就答/

export interface FinalizeOptions {
  readonly knownChunk: (id: string) => boolean
  /** Web pages the writer was given; links to any other address are dropped. */
  readonly knownUrl?: (url: string) => boolean
  /** Chunks that `![[…]]` may copy in; without it, embeds are dropped. */
  readonly embed?: EmbedSource
  readonly newBlockId: () => string
  readonly reuse?: (text: string) => string | undefined
}

/** A quote box the model wrote itself is not source text: it becomes an ordinary paragraph. */
function unquote(piece: string): string {
  return piece.split('\n').map(line => line.replace(/^>\s?/, '')).join('\n').replace(/^\[!\w+\][+-]?\s*/, '').trim()
}

/**
 * Turn a model draft into a textbook body: embeds become quote boxes of source text; every non-heading
 * block gets an id (`reuse` keeps the old id of a block whose text is unchanged); citations to chunks that
 * are not known sources and links to pages not given are dropped. `dropped` says what was left out and why.
 */
export function finalize(draft: string, options: FinalizeOptions): { body: string; blocks: BlockIndex[]; dropped: string[] } {
  const dropped: string[] = []
  const out: string[] = []
  // A line holding only citations (models put them after a list or table) belongs to the block before it.
  const pieces: string[] = []
  for (const piece of splitPieces(unwrap(draft))) {
    const citationsOnly = /\]\(cite:/.test(piece) && piece.replace(CITE, '').replace(/[\s。．.，,、;；]/g, '') === ''
    const previous = pieces.at(-1)
    if (citationsOnly && previous && !isHeading(previous) && !isDisplayMath(previous) && !EMBED_LINE.test(previous.trim())) pieces[pieces.length - 1] = `${previous.replace(TRAILING_ID, '')} ${piece.trim()}`
    else pieces.push(piece)
  }
  const idOf = (text: string) => options.reuse?.(text) ?? options.newBlockId()
  const boxes = (from: string, to: string | undefined) => {
    if (!options.embed) { dropped.push(`嵌入 ${from} 没有可用的资料`); return [] }
    const result = expandEmbed(from, to, options.embed)
    if ('error' in result) { dropped.push(`嵌入：${result.error}`); return [] }
    return result.boxes
  }
  const prose = (raw: string) => {
    let piece = raw.replace(CITE, (link, _label: string, target: string) => {
      if (target !== 'unverified' && options.knownChunk(target)) return link
      if (target !== 'unverified') dropped.push(`出处 ${target} 不在给出的资料里`)
      return ''
    })
    piece = piece.replace(WEB_LINK, (link, label: string, url: string) => {
      if (options.knownUrl?.(url)) return link
      dropped.push(`网址 ${url} 不是给出的网页`)
      return label
    }).replace(BETWEEN_LINKS, '$1').replace(/[ \t]+$/gm, '').trim()
    if (piece) out.push(`${piece} ^${idOf(piece)}`)
  }
  const box = (item: string) => out.push(`${item}\n\n^${idOf(item)}`)
  for (const raw of pieces.map(piece => piece.replace(TRAILING_ID, '')).filter(piece => !LONE_ID.test(piece))) {
    if (isHeading(raw)) { out.push(raw); continue }
    if (isDisplayMath(raw)) { out.push(`${raw}\n^${idOf(raw)}`); continue }
    if (isOriginal(raw)) { prose(unquote(raw)); continue }
    // Embeds on lines of their own split the paragraph; one left inside a sentence goes after it.
    let text: string[] = []
    const flush = () => {
      const after: string[] = []
      const joined = text.join('\n').replace(EMBED_ANYWHERE, (_, from: string, to?: string) => { after.push(...boxes(from, to)); return '' }).trim()
      if (joined) prose(joined)
      after.forEach(box)
      text = []
    }
    for (const line of raw.split('\n')) {
      const embed = EMBED_LINE.exec(line.trim())
      if (!embed) { text.push(line); continue }
      flush()
      boxes(embed[1]!, embed[2]).forEach(box)
    }
    flush()
  }
  const body = `${out.join('\n\n')}\n`
  return { body, blocks: indexBlocks(body), dropped }
}

/**
 * Read the blocks of a textbook file (with or without frontmatter). A formula takes the citations of the
 * paragraph right after it, so it is linked to what that paragraph explains.
 */
export function indexBlocks(text: string): BlockIndex[] {
  const blocks: BlockIndex[] = []
  const pieces = splitPieces(parseFrontmatter(text).body)
  let formula: { -readonly [K in keyof BlockIndex]: BlockIndex[K] } | undefined
  let recall = false
  const settle = (next: BlockIndex | undefined) => {
    if (formula && formula.citations.length === 0 && next && !isDisplayMath(next.text)) formula.citations = next.citations
    formula = undefined
  }
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i]!
    if (isHeading(piece)) { settle(undefined); recall = QUESTION_HEADING.test(piece); continue }
    const lastLine = piece.split('\n').at(-1)!.trim()
    let id: string | undefined
    let body = piece
    const lone = LONE_ID.exec(lastLine)
    if (lone && piece.includes('\n')) {
      id = lone[1]
      body = piece.split('\n').slice(0, -1).join('\n')
    } else {
      const trailing = TRAILING_ID.exec(piece)
      if (trailing) {
        id = trailing[1]
        body = piece.slice(0, trailing.index)
      } else {
        // `^id` alone after a table, math block or quote box that ended the previous piece.
        const next = pieces[i + 1]
        const loneNext = next ? LONE_ID.exec(next.trim()) : null
        if (loneNext) {
          id = loneNext[1]
          i += 1
        }
      }
    }
    if (!id) continue
    const citations = [...body.matchAll(CITE)].map(match => match[2]!).filter(target => target !== 'unverified')
    const block = {
      id,
      text: body.trim(),
      hash: createHash('sha256').update(body.trim()).digest('hex').slice(0, 16),
      citations: [...new Set(citations)],
      unverified: body.includes('(cite:unverified)'),
      recall,
      original: isOriginal(body),
    }
    settle(block)
    blocks.push(block)
    if (isDisplayMath(block.text)) formula = block
  }
  settle(undefined)
  return blocks
}

/**
 * A point's reply as part of the lesson: under the point's own heading (none when the point is the whole
 * lesson, or the second half of a long one), headings inside it one level lower, the recall questions only
 * when they were asked for. The lesson's own title is the program's.
 */
export function pointText(reply: string, title: string | undefined, questions: boolean): string {
  const lines = reply.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/, '$1').split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  let opening = true
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim())
    if (heading) {
      if (/读完就答/.test(heading[2]!)) {
        skipping = !questions
        if (questions) out.push('### 读完就答')
        opening = false
        continue
      }
      skipping = false
      // The lesson's title, and the point's own heading before any text: the program writes them.
      if (heading[1]!.length <= 2) continue
      if (opening) { opening = false; continue }
      out.push(`${'#'.repeat(Math.max(4, heading[1]!.length))} ${heading[2]}`)
      continue
    }
    if (skipping) continue
    if (line.trim()) opening = false
    out.push(line)
  }
  const body = out.join('\n').trim()
  return title ? `### ${title}\n\n${body}` : body
}

/** Rough prompt cost of a chunk: its text plus the id and citation label written before it. */
export function materialSize(chunk: { readonly text: string }): number {
  return chunk.text.length + 80
}

/**
 * Split a lesson's material into parts the writer can handle in one reply, in reading order.
 * Parts start at headings where possible: the material is cut into heading-led runs, small runs are
 * packed together up to `limit`, and a run larger than `limit` is cut between its chunks.
 */
export function planParts<T extends { readonly kind: string; readonly text: string }>(chunks: readonly T[], limit: number): T[][] {
  const runs: T[][] = []
  for (const chunk of chunks) {
    if (chunk.kind === 'heading' || runs.length === 0) runs.push([chunk])
    else runs.at(-1)!.push(chunk)
  }
  const parts: T[][] = []
  let current: T[] = []
  let size = 0
  const add = (chunk: T) => {
    const cost = materialSize(chunk)
    if (current.length > 0 && size + cost > limit) {
      parts.push(current)
      current = []
      size = 0
    }
    current.push(chunk)
    size += cost
  }
  for (const run of runs) {
    const cost = run.reduce((sum, chunk) => sum + materialSize(chunk), 0)
    // A run that fits in a fresh part starts one rather than being split across two.
    if (current.length > 0 && size + cost > limit && cost <= limit) {
      parts.push(current)
      current = []
      size = 0
    }
    for (const chunk of run) add(chunk)
  }
  if (current.length > 0) parts.push(current)
  return parts
}

/** Halve a part that was still too long for one reply, cutting at the heading nearest the middle. */
export function halve<T extends { readonly kind: string }>(part: readonly T[]): [T[], T[]] {
  const middle = Math.floor(part.length / 2)
  let cut = middle
  for (let offset = 0; offset < middle; offset += 1) {
    if (part[middle + offset]?.kind === 'heading') { cut = middle + offset; break }
    if (middle - offset > 0 && part[middle - offset]?.kind === 'heading') { cut = middle - offset; break }
  }
  return [part.slice(0, cut), part.slice(cut)]
}

/**
 * The stage design without its assessment sections, so quiz problems cannot leak into the textbook.
 * Drops every heading section that names a test, blueprint or exercises, with its subsections.
 */
export function teachingPartOf(design: string): string {
  const out: string[] = []
  let skipDepth = 0
  for (const line of design.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const depth = heading[1]!.length
      if (skipDepth && depth > skipDepth) continue
      skipDepth = /测试|蓝图|小测|考核|考试|测验|习题/.test(heading[2]!) ? depth : 0
      if (skipDepth) continue
    } else if (skipDepth) {
      continue
    }
    out.push(line)
  }
  return out.join('\n').trim()
}
