// What a learner selects in a rendered textbook paragraph must come back as the text the annotation unit compares
// against: formulas as their `$…$` source, citation badges left out (packages/shell/src/client/selection.ts).
import { parseHTML } from 'linkedom'
import { expect, it } from 'vitest'
import { locateQuote, normalizeText, plainText } from '../packages/annotation/src/anchor.ts'
import { toHtml } from '../packages/shell/src/client/html.ts'
import { sourceText } from '../packages/shell/src/client/selection.ts'
import { findQuote } from '../packages/annotation/src/marks.ts'

const CITE = '[《合成资料》p.3](cite:ck_01K6PQZRB8M3A4T5V6W7X8Y9Z0)'

/** The paragraph as the page draws it, read back the way a selection of all of it would be. */
function readBack(markdown: string): string {
  const { document } = parseHTML('<div id="block"></div>')
  const block = document.getElementById('block')!
  block.innerHTML = toHtml(markdown)
  return sourceText(block)
}

it('gives a rendered paragraph back as the server reads its Markdown', () => {
  for (const markdown of [
    `静水压强按 $p=\\rho g h$ 计算，见${CITE}。`,
    '水深加倍时，**静水压强**也加倍，`h` 是深度。',
    '$$\n  p = \\rho g h\n$$',
    '结论[这句话没有出处](cite:unverified)成立。',
    '- 第一条：流速不变\n- 第二条：质量流量不变',
  ]) {
    expect(normalizeText(readBack(markdown)), markdown).toBe(normalizeText(plainText(markdown)))
  }
})

it('a formula comes back whole, as source, and what is read back is found where it was selected', () => {
  const markdown = `压强按 $p=\\rho g h$ 计算，与深度成正比，见${CITE}。`
  const text = readBack(markdown)
  expect(text).toContain('$p=\\rho g h$')
  expect(text).not.toContain('p.3')
  const found = locateQuote(plainText(markdown), { exact: '$p=\\rho g h$ 计算', prefix: '压强按 ', suffix: '，与深度' })
  expect(found).toMatchObject({ status: 'anchored' })
})

/** The text of a found span, read back from the paragraph: a formula whole, as source. */
function spanText(block: Element, quote: { exact: string; prefix: string; suffix: string }): string | undefined {
  const span = findQuote(block, quote)
  if (!span) return undefined
  const units: string[] = []
  let on = false
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      const text = node.textContent ?? ''
      for (let offset = 0; offset < text.length; offset += 1) {
        const at = (unit: typeof span.start) => 'node' in unit && unit.node === node && unit.offset === offset
        if (at(span.start)) on = true
        if (on) units.push(text[offset]!)
        if (at(span.end)) on = false
      }
      return
    }
    const element = node as Element
    if (element.hasAttribute?.('data-cite')) return
    if (element.classList?.contains('katex')) {
      const formula = (unit: typeof span.start) => 'formula' in unit && unit.formula === element
      if (formula(span.start)) on = true
      if (on) units.push(`$${element.querySelector('annotation')!.textContent}$`)
      if (formula(span.end)) on = false
      return
    }
    node.childNodes.forEach(walk)
  }
  walk(block)
  return units.join('')
}

it('finds a note\'s quote again in the rendered paragraph, to mark it there', () => {
  const { document } = parseHTML('<div id="block"></div>')
  const block = document.getElementById('block')!
  block.innerHTML = toHtml(`水深加倍时，静水压强按 $p=\\rho g h$ 也加倍，见${CITE}。静水压强与容器形状无关。`)
  // A formula is marked whole; a citation badge between the words is skipped.
  expect(spanText(block, { exact: '静水压强按 $p=\\rho g h$ 也加倍', prefix: '', suffix: '' })).toBe('静水压强按 $p=\\rho g h$ 也加倍')
  expect(spanText(block, { exact: '也加倍，见。静水', prefix: '', suffix: '' })).toBe('也加倍，见。静水')
  // Two places: the text around the quote picks one.
  const second = findQuote(block, { exact: '静水压强', prefix: '。', suffix: '与容器' })
  const first = findQuote(block, { exact: '静水压强', prefix: '加倍时，', suffix: '按' })
  expect(second && first && 'node' in second.start && 'node' in first.start && second.start.node !== first.start.node).toBe(true)
  // What is not there word for word is not marked.
  expect(findQuote(block, { exact: '静水压力', prefix: '', suffix: '' })).toBeUndefined()
})
