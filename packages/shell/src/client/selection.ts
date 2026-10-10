// What the learner selected inside a textbook paragraph, as the Markdown source the server compares against
// (docs/annotation/design.md, 选区). The page shows rendered text: a formula is KaTeX markup and a citation is a
// badge. The server's plain text keeps a formula as its `$…$` source and leaves citations out, so the selection
// is turned back the same way, and a selection that touches a formula takes the whole formula.
import type { TextQuote } from '@learning-agent/contracts'

/** How much text before and after the selection is kept to tell several places apart. */
const CONTEXT = 24

const isElement = (node: Node): node is Element => node.nodeType === 1

/** The outermost rendered formula around a node, if it is inside one. */
function formulaAround(node: Node | null): Element | undefined {
  let found: Element | undefined
  for (let at: Node | null = node; at; at = at.parentNode) {
    if (isElement(at) && (at.classList.contains('katex-display') || at.classList.contains('katex'))) found = at
  }
  return found
}

function tex(formula: Element): string {
  const source = formula.querySelector('annotation[encoding="application/x-tex"]')?.textContent
  // A formula KaTeX could not parse is shown as its source.
  const text = (source ?? formula.textContent ?? '').trim()
  return formula.classList.contains('katex-display') ? `$$${text}$$` : `$${text}$`
}

/** The text of rendered nodes as Markdown source: formulas as `$…$`, citation badges dropped. */
export function sourceText(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? ''
  if (isElement(node)) {
    if (node.hasAttribute('data-cite')) return ''
    if (node.classList.contains('katex-display') || node.classList.contains('katex')) return tex(node)
  }
  return Array.from(node.childNodes, sourceText).join('')
}

/**
 * The selection inside `block` as a quote with context, or nothing when no text is selected there. A selection
 * running past the block is cut at the block's edge: a note belongs to one paragraph.
 */
export function selectedQuote(block: Element, selection: Selection | null | undefined): TextQuote | undefined {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return undefined
  const picked = selection.getRangeAt(0)
  if (!picked.intersectsNode(block)) return undefined
  const range = picked.cloneRange()
  if (!block.contains(range.startContainer)) range.setStart(block, 0)
  if (!block.contains(range.endContainer)) range.setEnd(block, block.childNodes.length)
  const first = formulaAround(range.startContainer)
  if (first) range.setStartBefore(first)
  const last = formulaAround(range.endContainer)
  if (last) range.setEndAfter(last)

  const exact = sourceText(range.cloneContents()).trim()
  if (!exact) return undefined
  const before = range.cloneRange()
  before.selectNodeContents(block)
  before.setEnd(range.startContainer, range.startOffset)
  const after = range.cloneRange()
  after.selectNodeContents(block)
  after.setStart(range.endContainer, range.endOffset)
  return {
    exact,
    prefix: [...sourceText(before.cloneContents())].slice(-CONTEXT).join(''),
    suffix: [...sourceText(after.cloneContents())].slice(0, CONTEXT).join(''),
  }
}
