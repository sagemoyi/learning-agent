// What a learner selects in a rendered textbook paragraph must come back as the text the annotation unit compares
// against: formulas as their `$…$` source, citation badges left out (packages/shell/src/client/selection.ts).
import { parseHTML } from 'linkedom'
import { expect, it } from 'vitest'
import { locateQuote, normalizeText, plainText } from '../packages/annotation/src/anchor.ts'
import { toHtml } from '../packages/shell/src/client/html.ts'
import { sourceText } from '../packages/shell/src/client/selection.ts'

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
