// Finding an annotation's place again (docs/annotation/design.md, 定位). Pure functions, no services.
//
// The quote the learner selected (with a little text before and after) is the only thing trusted: a
// position is never stored, and a paragraph id only says which paragraph to look in. A place is shown
// automatically only when it can be verified: the quote occurs once, or the context tells several
// occurrences apart. Anything else is left for the learner to confirm, so a note is never put on a
// sentence the learner did not choose. A close but different sentence is only a suggestion.
import type { AnnotationLocation, TextQuote } from '@learning-agent/contracts'

const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff\u00ad]/g
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f\u3040-\u30ff]/u

/**
 * The comparison form of a text: Unicode NFC (never NFKC: it would fold superscripts and ligatures that
 * carry meaning in formulas), no invisible characters, whitespace runs as one space, and no space between
 * two CJK characters (a line break inside Chinese text is not a space).
 */
export function normalizeText(text: string): string {
  const collapsed = text.normalize('NFC').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim()
  const chars = [...collapsed]
  let out = ''
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]!
    if (char === ' ' && i > 0 && i < chars.length - 1 && CJK.test(chars[i - 1]!) && CJK.test(chars[i + 1]!)) continue
    out += char
  }
  return out
}

/**
 * The text a reader sees for a paragraph of textbook Markdown: block id, citation and link syntax, emphasis
 * marks, list and quote markers removed. Formulas stay as their `$…$` source: a quote that takes a formula
 * must take it whole.
 */
export function plainText(markdown: string): string {
  const math: string[] = []
  const hidden = markdown
    .replace(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g, found => { math.push(tightMath(found)); return `\u0000${math.length - 1}\u0000` })
    .replace(/(?:^|\s)\^[0-9a-z]{6}\s*$/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // A citation badge is not part of the sentence (the page shows only its page number).
    .replace(/\[[^\]]*\]\(cite:ck_[^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|`)/g, '')
  return hidden.replace(/\u0000(\d+)\u0000/g, (_, index: string) => math[Number(index)] ?? '')
}

/** A formula as the page can give it back: the delimiters hug the source, whatever spacing the file used. */
function tightMath(found: string): string {
  const display = found.startsWith('$$')
  const inner = found.slice(display ? 2 : 1, found.length - (display ? 2 : 1)).trim()
  return display ? `$$${inner}$$` : `$${inner}$`
}

export type Located =
  | { readonly status: 'anchored'; readonly start: number; readonly end: number }
  | { readonly status: 'needs-confirmation'; readonly reason: string; readonly suggestion?: string }
  | { readonly status: 'original-only'; readonly reason: string }

function occurrences(text: string, needle: string): number[] {
  const found: number[] = []
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) found.push(at)
  return found
}

/** Characters shared at the end of `a` and `b`. */
function commonTail(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n += 1
  return n
}

function commonHead(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1
  return n
}

/**
 * The most similar stretch of `text` to `needle` (Sellers' approximate substring match), if it differs by at
 * most `maxRatio` of the needle's length.
 */
export function closestPassage(text: string, needle: string, maxRatio = 0.35): { readonly passage: string; readonly distance: number } | undefined {
  const t = [...text]
  const q = [...needle]
  if (q.length < 4 || t.length === 0) return undefined
  const limit = Math.floor(q.length * maxRatio)
  let previous = Array.from({ length: q.length + 1 }, (_, i) => i)
  let best = { distance: Infinity, end: 0 }
  // Row j: best cost of matching the first i needle characters ending at text character j.
  for (let j = 1; j <= t.length; j += 1) {
    const row = [0]
    for (let i = 1; i <= q.length; i += 1) {
      const cost = q[i - 1] === t[j - 1] ? 0 : 1
      row[i] = Math.min(previous[i - 1]! + cost, previous[i]! + 1, row[i - 1]! + 1)
    }
    if (row[q.length]! < best.distance) best = { distance: row[q.length]!, end: j }
    previous = row
  }
  if (best.distance > limit) return undefined
  const start = Math.max(0, best.end - q.length - best.distance)
  return { passage: t.slice(start, best.end).join(''), distance: best.distance }
}

/** Find the quote in one paragraph's text. */
export function locateQuote(text: string, quote: TextQuote): Located {
  const body = normalizeText(text)
  const exact = normalizeText(quote.exact)
  if (!exact) return { status: 'original-only', reason: '批注没有记下原句' }
  const at = occurrences(body, exact)
  const prefix = normalizeText(quote.prefix)
  const suffix = normalizeText(quote.suffix)
  const before = (start: number) => body.slice(0, start).trimEnd()
  const after = (end: number) => body.slice(end).trimStart()
  if (at.length === 1) {
    const start = at[0]!
    const end = start + exact.length
    // The text right next to the quote must be what it was: "能忽略" inside a new "不能忽略" is another claim.
    const leftChanged = prefix !== '' && before(start).at(-1) !== prefix.at(-1)
    const rightChanged = suffix !== '' && after(end)[0] !== suffix[0]
    if (!leftChanged && !rightChanged) return { status: 'anchored', start, end }
    return {
      status: 'needs-confirmation',
      reason: '这句话还在，但紧挨着它的文字改过了，请确认意思没变',
      suggestion: body.slice(Math.max(0, start - 12), Math.min(body.length, end + 12)),
    }
  }
  if (at.length > 1) {
    const scored = at.map(start => ({
      start,
      score: commonTail(before(start), prefix) + commonHead(after(start + exact.length), suffix),
    })).sort((a, b) => b.score - a.score)
    const best = scored[0]!
    const second = scored[1]!
    // Context decides only when it clearly favours one place; no context, or a tie, is left to the learner.
    if (prefix.length + suffix.length > 0 && best.score >= Math.min(4, prefix.length + suffix.length) && best.score > second.score) {
      return { status: 'anchored', start: best.start, end: best.start + exact.length }
    }
    return { status: 'needs-confirmation', reason: `这句话在这一段里出现了 ${at.length} 次，请确认是哪一处` }
  }
  const near = closestPassage(body, exact)
  if (near) return { status: 'needs-confirmation', reason: '这句话被改过，现在只剩相近的文字', suggestion: near.passage }
  return { status: 'original-only', reason: '这句话已经不在正文里了' }
}

const MATH = /\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g

/**
 * Does the quote take only part of a formula? The page shows a formula as rendered text, the Markdown holds
 * its source, so half a formula cannot be matched to anything: a quote takes a formula whole or leaves it.
 * True when every place the quote is found starts or ends inside a formula.
 */
export function quoteCutsFormula(text: string, quote: TextQuote): boolean {
  const body = normalizeText(plainText(text))
  const exact = normalizeText(quote.exact)
  if (!exact) return false
  const spans = [...body.matchAll(MATH)].map(found => ({ start: found.index, end: found.index + found[0].length }))
  const places = occurrences(body, exact)
  if (places.length === 0 || spans.length === 0) return false
  return places.every(start => {
    const end = start + exact.length
    return spans.some(span => (start > span.start && start < span.end) || (end > span.start && end < span.end))
  })
}

/** One paragraph a note may belong to now. */
export interface Candidate {
  readonly blockId: string
  readonly hash: string
  /** The paragraph's Markdown. */
  readonly text: string
}

/**
 * The place of an annotation among the paragraphs it can be on now: its own paragraph when that still
 * exists, otherwise the paragraphs it was rewritten or split into.
 *
 * @param anchorHash `Block.hash` when the annotation was made.
 * @param previous the stored place; a place the learner confirmed holds while the paragraph is as it was then.
 */
export function placeAnnotation(
  quote: TextQuote | undefined,
  candidates: readonly Candidate[],
  options: { readonly anchorHash?: string; readonly previous?: AnnotationLocation; readonly at: string },
): AnnotationLocation {
  const { anchorHash, previous, at } = options
  const base = (fields: Omit<AnnotationLocation, 'checkedAt'>): AnnotationLocation => ({ ...fields, checkedAt: at })
  if (candidates.length === 0) return base({ status: 'original-only', reason: '这一段已经不在教材里了，批注和原句还保留着' })

  const held = previous?.confirmedAt ? candidates.find(candidate => candidate.blockId === previous.blockId && candidate.hash === previous.hash) : undefined
  if (held) return base({ status: 'anchored', blockId: held.blockId, hash: held.hash, confirmedAt: previous!.confirmedAt! })

  if (!quote) {
    const first = candidates[0]!
    if (candidates.length === 1 && (!anchorHash || anchorHash === first.hash)) return base({ status: 'anchored', blockId: first.blockId, hash: first.hash })
    return base({ status: 'needs-confirmation', ...(candidates.length === 1 ? { blockId: first.blockId, hash: first.hash } : {}), reason: '这一段改过或拆开了，请确认批注还属于哪里' })
  }

  const results = candidates.map(candidate => ({ candidate, found: locateQuote(plainText(candidate.text), quote) }))
  const anchored = results.filter(result => result.found.status === 'anchored')
  if (anchored.length === 1) {
    const { candidate } = anchored[0]!
    return base({ status: 'anchored', blockId: candidate.blockId, hash: candidate.hash })
  }
  if (anchored.length > 1) return base({ status: 'needs-confirmation', reason: '这句话在改写后的几段里都有，请确认是哪一处' })
  const near = results.find(result => result.found.status === 'needs-confirmation')
  if (near && near.found.status === 'needs-confirmation') {
    return base({ status: 'needs-confirmation', blockId: near.candidate.blockId, hash: near.candidate.hash, reason: near.found.reason, ...(near.found.suggestion ? { suggestion: near.found.suggestion } : {}) })
  }
  return base({ status: 'original-only', reason: '这句话已经不在正文里了，批注和原句还保留着' })
}
