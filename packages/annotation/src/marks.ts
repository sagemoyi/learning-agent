// Notes marked in the rendered paragraph they are on (browser side). The paragraph is the textbook's HTML and is
// never changed: the quote's place is found in its text and painted with the CSS Custom Highlight API, one
// highlight per note type, styled by `::highlight(la-note-<type>)` in shell.css. Without the API nothing is painted
// and the notes still show under the paragraph.
//
// The text is read the way the server reads the Markdown (anchor.ts): a formula as its `$…$` source, citation badges
// left out, whitespace as in normalizeText. A formula is one unit, so a quote that takes it paints all of it.
import type { AnnotationType, TextQuote } from '@learning-agent/contracts'

/** One place in the paragraph: a character of a text node, or a whole rendered formula. */
type Unit = { readonly node: Node; readonly offset: number } | { readonly formula: Element }

export interface Span {
  readonly start: Unit
  readonly end: Unit
}

const ZERO_WIDTH = /[​-‍⁠﻿­]/
const CJK = /[⺀-鿿豈-﫿＀-￯　-〿぀-ヿ]/u
const isElement = (node: Node): node is Element => node.nodeType === 1
const isFormula = (node: Element) => node.classList.contains('katex-display') || node.classList.contains('katex')

function tex(formula: Element): string {
  const source = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent
  const text = (source ?? formula.textContent ?? '').trim()
  return formula.classList.contains('katex-display') ? `$$${text}$$` : `$${text}$`
}

/** The paragraph's characters in reading order, each with the unit it came from. */
function characters(root: Node): { char: string; unit: Unit }[] {
  const out: { char: string; unit: Unit }[] = []
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? ''
      for (let offset = 0; offset < text.length; offset += 1) out.push({ char: text[offset]!, unit: { node, offset } })
      return
    }
    if (!isElement(node)) return
    if (node.hasAttribute('data-cite')) return
    if (isFormula(node)) {
      const unit = { formula: node }
      for (const char of tex(node)) out.push({ char, unit })
      return
    }
    for (const child of Array.from(node.childNodes)) walk(child)
  }
  walk(root)
  return out
}

/** normalizeText (anchor.ts) on a list of characters, keeping each one's unit. */
function normalized(chars: readonly { char: string; unit: Unit }[]): { char: string; unit: Unit }[] {
  const collapsed: { char: string; unit: Unit }[] = []
  for (const item of chars) {
    if (ZERO_WIDTH.test(item.char)) continue
    const space = /\s/.test(item.char)
    if (space && (collapsed.length === 0 || collapsed.at(-1)!.char === ' ')) continue
    collapsed.push(space ? { char: ' ', unit: item.unit } : item)
  }
  while (collapsed.at(-1)?.char === ' ') collapsed.pop()
  return collapsed.filter((item, i) => !(item.char === ' ' && i > 0 && i < collapsed.length - 1 && CJK.test(collapsed[i - 1]!.char) && CJK.test(collapsed[i + 1]!.char)))
}

const squeeze = (text: string) => normalized([...text].map(char => ({ char, unit: { formula: undefined as never } }))).map(item => item.char).join('')

/**
 * Where the quote is in the rendered paragraph, or nothing when it is not there word for word. Several matches are
 * told apart by the text around them, as the server does.
 */
export function findQuote(root: Node, quote: TextQuote): Span | undefined {
  const chars = normalized(characters(root))
  const text = chars.map(item => item.char).join('')
  const exact = squeeze(quote.exact)
  if (!exact) return undefined
  const starts: number[] = []
  for (let at = text.indexOf(exact); at >= 0; at = text.indexOf(exact, at + 1)) starts.push(at)
  if (starts.length === 0) return undefined
  const prefix = squeeze(quote.prefix)
  const suffix = squeeze(quote.suffix)
  const score = (start: number) => {
    let n = 0
    while (n < prefix.length && start - 1 - n >= 0 && text[start - 1 - n] === prefix[prefix.length - 1 - n]) n += 1
    let m = 0
    while (m < suffix.length && text[start + exact.length + m] === suffix[m]) m += 1
    return n + m
  }
  const start = starts.reduce((best, at) => (score(at) > score(best) ? at : best), starts[0]!)
  return { start: chars[start]!.unit, end: chars[start + exact.length - 1]!.unit }
}

function toRange(span: Span): Range {
  const range = document.createRange()
  if ('formula' in span.start) range.setStartBefore(span.start.formula)
  else range.setStart(span.start.node, span.start.offset)
  if ('formula' in span.end) range.setEndAfter(span.end.formula)
  else range.setEnd(span.end.node, span.end.offset + 1)
  return range
}

// ── the page's highlights ────────────────────────────────────────────────────

type Highlights = { set(name: string, value: unknown): void; delete(name: string): void }
type HighlightClass = new (...ranges: Range[]) => unknown

const painted = new Map<string, { readonly type: AnnotationType; readonly range: Range }[]>()

function repaint(): void {
  const registry = (globalThis.CSS as unknown as { highlights?: Highlights } | undefined)?.highlights
  const Highlight = (globalThis as unknown as { Highlight?: HighlightClass }).Highlight
  if (!registry || !Highlight) return
  const byType = new Map<AnnotationType, Range[]>()
  for (const marks of painted.values()) for (const mark of marks) byType.set(mark.type, [...(byType.get(mark.type) ?? []), mark.range])
  for (const type of ['question', 'understanding', 'highlight', 'error'] as const) {
    const ranges = byType.get(type)
    if (ranges?.length) registry.set(`la-note-${type}`, new Highlight(...ranges))
    else registry.delete(`la-note-${type}`)
  }
}

/** Paint the quotes of one paragraph's notes (replacing what `owner` painted before); returns the eraser. */
export function paint(owner: string, block: Element, notes: readonly { readonly type: AnnotationType; readonly quote: TextQuote }[]): () => void {
  const marks = notes.flatMap(note => {
    const span = findQuote(block, note.quote)
    return span ? [{ type: note.type, range: toRange(span) }] : []
  })
  painted.set(owner, marks)
  repaint()
  return () => {
    if (painted.get(owner) !== marks) return
    painted.delete(owner)
    repaint()
  }
}
