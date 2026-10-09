// Textbook file format (contracts §3.2): blocks end with ` ^id` (display math: `^id` on the next
// line), citations are `[label](cite:ck_…)`, content without a source carries `[待核实](cite:unverified)`.
// `finalize` turns a model draft into that format; `indexBlocks` reads it back. Display math cannot
// hold a link: a formula's source is the explanation paragraph right after it.
import { createHash } from 'node:crypto'
import { parseFrontmatter } from '@learning-agent/contracts'

const UNVERIFIED_LINK = '[待核实](cite:unverified)'
const CITE = /\[([^\]]*)\]\(cite:([^)\s]+)\)/g
const TRAILING_ID = /\s\^([0-9a-z]{6})\s*$/
const LONE_ID = /^\^([0-9a-z]{6})\s*$/

export interface BlockIndex {
  readonly id: string
  readonly text: string
  readonly hash: string
  readonly citations: string[]
  readonly unverified: boolean
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

/** Headings whose blocks ask the learner questions instead of stating facts, so they need no source. */
const QUESTION_HEADING = /读完就答/

/** A short lead-in such as "静水压强按下式计算：" right before display math; the formula's source follows it. */
function isFormulaLeadIn(piece: string, next: string | undefined): boolean {
  return next !== undefined && isDisplayMath(next) && /[:：]$/.test(piece.trim()) && [...piece].length <= 40
}

/** The note after a formula with no explanation paragraph to take its source from. */
const NO_FORMULA_SOURCE = `上式没有找到出处。${UNVERIFIED_LINK}`

/**
 * Turn a model draft into a textbook body: every non-heading block gets an id (`reuse` keeps the old
 * id of a block whose text is unchanged); citations to chunks that are not known sources become
 * 待核实; prose blocks without any citation are flagged 待核实, except recall questions and formula
 * lead-ins (they claim nothing themselves); a formula with no paragraph after it gets a 待核实 note.
 */
export function finalize(draft: string, options: { readonly knownChunk: (id: string) => boolean; readonly newBlockId: () => string; readonly reuse?: (text: string) => string | undefined }): { body: string; blocks: BlockIndex[]; dropped: string[] } {
  const dropped: string[] = []
  const out: string[] = []
  let questions = false
  // A line holding only citations (models put them after a list or table) belongs to the block before it.
  const pieces: string[] = []
  const split = splitPieces(unwrap(draft))
  for (const piece of split) {
    const citationsOnly = /\]\(cite:/.test(piece) && piece.replace(CITE, '').replace(/[\s。．.，,、;；]/g, '') === ''
    const previous = pieces.at(-1)
    if (citationsOnly && previous && !isHeading(previous) && !isDisplayMath(previous)) pieces[pieces.length - 1] = `${previous.replace(TRAILING_ID, '')} ${piece.trim()}`
    else pieces.push(piece)
  }
  const idOf = (text: string) => options.reuse?.(text) ?? options.newBlockId()
  const contents = pieces.map(piece => piece.replace(TRAILING_ID, '')).filter(piece => !LONE_ID.test(piece))
  for (const [index, raw] of contents.entries()) {
    let piece = raw
    if (isHeading(piece)) {
      questions = QUESTION_HEADING.test(piece)
      out.push(piece)
      continue
    }
    if (isDisplayMath(piece)) {
      out.push(`${piece}\n^${idOf(piece)}`)
      const after = contents[index + 1]
      if (!questions && (after === undefined || isHeading(after) || isDisplayMath(after))) out.push(`${NO_FORMULA_SOURCE} ^${idOf(NO_FORMULA_SOURCE)}`)
      continue
    }
    piece = piece.replace(CITE, (link, label: string, target: string) => {
      if (target === 'unverified' || options.knownChunk(target)) return link
      dropped.push(target)
      return UNVERIFIED_LINK
    })
    const exempt = questions || isFormulaLeadIn(piece, contents[index + 1])
    if (!exempt && !/\(cite:[^)]+\)/.test(piece)) piece = `${piece} ${UNVERIFIED_LINK}`
    out.push(`${piece} ^${idOf(piece)}`)
  }
  const body = `${out.join('\n\n')}\n`
  return { body, blocks: indexBlocks(body), dropped }
}

/**
 * Read the blocks of a textbook file (with or without frontmatter). A formula takes the citations of
 * the paragraph right after it, and is 待核实 when that paragraph is, or when none follows.
 */
export function indexBlocks(text: string): BlockIndex[] {
  const blocks: BlockIndex[] = []
  const pieces = splitPieces(parseFrontmatter(text).body)
  let formula: { -readonly [K in keyof BlockIndex]: BlockIndex[K] } | undefined
  const settle = (next: BlockIndex | undefined) => {
    if (formula && formula.citations.length === 0) {
      const source = next && !isDisplayMath(next.text) ? next : undefined
      formula.citations = source?.citations ?? []
      formula.unverified = !source || source.unverified || source.citations.length === 0
    }
    formula = undefined
  }
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i]!
    if (isHeading(piece)) { settle(undefined); continue }
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
        // `^id` alone after a table or math block that ended the previous piece.
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
    }
    settle(block)
    blocks.push(block)
    if (isDisplayMath(block.text)) formula = block
  }
  settle(undefined)
  return blocks
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

/**
 * Subsection headings of a part's material that its reply never mentions, by number (`1.2.3`) or by
 * title: the writer sometimes covers the first subsection and stops.
 */
export function missingHeadings(chunks: readonly { readonly kind: string; readonly text: string }[], reply: string): string[] {
  const squeeze = (text: string) => text.replace(/\s+/g, '')
  const written = squeeze(reply)
  return chunks.filter(chunk => chunk.kind === 'heading').map(chunk => chunk.text.replace(/^#+\s*/, '').trim()).filter(title => {
    const [number = '', ...rest] = title.split(/\s+/)
    const name = squeeze(rest.join(''))
    const numbered = /^\d+(?:\.\d+)+$/.test(number)
    return !(written.includes(squeeze(title)) || (numbered && written.includes(number)) || (name.length >= 2 && written.includes(name)) || (!numbered && written.includes(squeeze(number))))
  })
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
