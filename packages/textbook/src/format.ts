// Textbook file format (contracts §3.2): blocks end with ` ^id` (display math: `^id` on the next
// line), citations are `[label](cite:ck_…)`, content without a source carries `[待核实](cite:unverified)`.
// `finalize` turns a model draft into that format; `indexBlocks` reads it back.
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

/**
 * Turn a model draft into a textbook body: every non-heading block gets a fresh id; citations to
 * chunks that are not known sources become 待核实; prose blocks without any citation are flagged
 * 待核实, except recall questions and formula lead-ins (they claim nothing themselves).
 */
export function finalize(draft: string, options: { readonly knownChunk: (id: string) => boolean; readonly newBlockId: () => string }): { body: string; blocks: BlockIndex[]; dropped: string[] } {
  const dropped: string[] = []
  const out: string[] = []
  let questions = false
  // A line holding only citations (models put them after a list or table) belongs to the block before it.
  const pieces: string[] = []
  for (const piece of splitPieces(unwrap(draft))) {
    const citationsOnly = /\]\(cite:/.test(piece) && piece.replace(CITE, '').replace(/[\s。．.，,、;；]/g, '') === ''
    const previous = pieces.at(-1)
    if (citationsOnly && previous && !isHeading(previous) && !isDisplayMath(previous)) pieces[pieces.length - 1] = `${previous.replace(TRAILING_ID, '')} ${piece.trim()}`
    else pieces.push(piece)
  }
  for (const [index, raw] of pieces.entries()) {
    let piece = raw.replace(TRAILING_ID, '')
    if (LONE_ID.test(piece)) continue
    if (isHeading(piece)) {
      questions = QUESTION_HEADING.test(piece)
      out.push(piece)
      continue
    }
    const id = options.newBlockId()
    if (isDisplayMath(piece)) {
      out.push(`${piece}\n^${id}`)
      continue
    }
    piece = piece.replace(CITE, (link, label: string, target: string) => {
      if (target === 'unverified' || options.knownChunk(target)) return link
      dropped.push(target)
      return UNVERIFIED_LINK
    })
    const exempt = questions || isFormulaLeadIn(piece, pieces[index + 1]?.replace(TRAILING_ID, ''))
    if (!exempt && !/\(cite:[^)]+\)/.test(piece)) piece = `${piece} ${UNVERIFIED_LINK}`
    out.push(`${piece} ^${id}`)
  }
  const body = `${out.join('\n\n')}\n`
  return { body, blocks: indexBlocks(body), dropped }
}

/** Read the blocks of a textbook file (with or without frontmatter). */
export function indexBlocks(text: string): BlockIndex[] {
  const blocks: BlockIndex[] = []
  const pieces = splitPieces(parseFrontmatter(text).body)
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i]!
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
    blocks.push({
      id,
      text: body.trim(),
      hash: createHash('sha256').update(body.trim()).digest('hex').slice(0, 16),
      citations: [...new Set(citations)],
      unverified: body.includes('(cite:unverified)'),
    })
  }
  return blocks
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
