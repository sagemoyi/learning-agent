// Finding an annotation's place again: what may be shown automatically and what the learner must confirm.
import { expect, it } from 'vitest'
import { closestPassage, locateQuote, normalizeText, placeAnnotation, plainText, quoteCutsFormula } from '../src/anchor.ts'

const AT = '2026-10-10T00:00:00.000Z'
const quote = (exact: string, prefix = '', suffix = '') => ({ exact, prefix, suffix })

it('normalizes spacing and invisible characters, but not what carries meaning in a formula', () => {
  expect(normalizeText('  水深\n加倍，\t压强   也加倍 ')).toBe('水深加倍，压强也加倍')
  expect(normalizeText('p  =  ρgh')).toBe('p = ρgh')
  expect(normalizeText('a\u200bb\u00adc')).toBe('abc')
  // NFC joins a combining accent; NFKC would also turn the superscript two into a plain 2.
  expect(normalizeText('e\u0301')).toBe('\u00e9')
  expect(normalizeText('x²')).toBe('x²')
  expect(normalizeText('ρ')).not.toBe(normalizeText('p'))
})

it('reads a paragraph as the reader sees it, keeping formulas as written', () => {
  const markdown = '- **静水压强**按 $p=\\rho g h$ 计算，见[合成资料 p.1](cite:ck_01JABCDEFGHJKMNPQRSTVWXYZ0)。 ^b7k2qx'
  // The citation badge is not part of the sentence: the page shows only its page number.
  expect(plainText(markdown)).toBe('静水压强按 $p=\\rho g h$ 计算，见。')
  expect(plainText('结论[句子](cite:unverified)成立 ^abc123')).toBe('结论句子成立')
  // A formula's delimiters hug its source, however the file spaced it: the page gives it back that way.
  expect(plainText('$$\n  p = \\rho g h\n$$ ^abc123')).toBe('$$p = \\rho g h$$')
  // Emphasis marks inside a formula are not emphasis.
  expect(plainText('结果 $a*b*c$ 成立 ^abc123')).toBe('结果 $a*b*c$ 成立')
})

it('anchors a quote that occurs once, and counts Chinese by character', () => {
  const found = locateQuote('水深加倍时，静水压强也加倍。流速不变。', quote('静水压强也加倍', '水深加倍时，', '。流速'))
  expect(found).toEqual({ status: 'anchored', start: 6, end: 13 })
  expect(locateQuote('𠮷野家的压强', quote('压强'))).toMatchObject({ status: 'anchored' })
})

it('does not pick the first of several matches when the context cannot tell them apart', () => {
  const text = '压强相同。其他条件不变时，压强相同。'
  expect(locateQuote(text, quote('压强相同'))).toMatchObject({ status: 'needs-confirmation' })
  expect(locateQuote(text, quote('压强相同', '其他条件不变时，', '。'))).toMatchObject({ status: 'anchored', start: 13 })
  // Context that fits neither place equally is no decision either.
  expect(locateQuote('甲压强相同。乙压强相同。', quote('压强相同', '丙', '。'))).toMatchObject({ status: 'needs-confirmation' })
})

it('does not call a changed sentence the same one', () => {
  // "能忽略" is still in "不能忽略", but the next word changed the claim.
  expect(locateQuote('这里不能忽略高差。', quote('能忽略', '这里', '高差。'))).toMatchObject({ status: 'needs-confirmation' })
  // A sign, an exponent or a number inside the quote: no exact match, only a suggestion.
  const sign = locateQuote('压力降 Δp = +ρgh 的方向向上。', quote('压力降 Δp = -ρgh 的方向向上'))
  expect(sign).toMatchObject({ status: 'needs-confirmation', suggestion: expect.stringContaining('+ρgh') })
  expect(locateQuote('速度按 $u^3$ 增长', quote('速度按 $u^2$ 增长'))).toMatchObject({ status: 'needs-confirmation' })
  expect(locateQuote('水深加倍时压强变为三倍', quote('水深加倍时压强变为两倍'))).toMatchObject({ status: 'needs-confirmation' })
})

it('keeps the note when the sentence is gone', () => {
  expect(locateQuote('完全不同的一段话，没有那个意思。', quote('静水压强与水深成正比'))).toEqual({ status: 'original-only', reason: expect.any(String) })
  expect(locateQuote('任何文字', quote('   '))).toMatchObject({ status: 'original-only' })
})

it('finds the closest passage by edit distance, and only when it is close', () => {
  expect(closestPassage('abc 静水压强随深度增加而增大 xyz', '静水压强随深度增加而增大')?.distance).toBe(0)
  expect(closestPassage('abc 静水压强随深度增加而减少 xyz', '静水压强随深度增加而增大')?.distance).toBe(2)
  expect(closestPassage('毫不相干的一些文字内容在这里', '静水压强随深度增加而增大')).toBeUndefined()
  expect(closestPassage('短', '太短')).toBeUndefined()
})

const block = (blockId: string, hash: string, text: string) => ({ blockId, hash, text })

it('places an annotation on its own paragraph, or among the paragraphs it became', () => {
  const q = quote('静水压强也加倍', '水深加倍时，', '。')
  expect(placeAnnotation(q, [block('aaa111', 'h1', '水深加倍时，静水压强也加倍。')], { at: AT })).toMatchObject({ status: 'anchored', blockId: 'aaa111', hash: 'h1' })
  // Split into two paragraphs: the one that has the sentence is the place.
  expect(placeAnnotation(q, [block('bbb222', 'h2', '水深加倍时，静水压强也加倍。'), block('ccc333', 'h3', '其余内容。')], { at: AT })).toMatchObject({ status: 'anchored', blockId: 'bbb222' })
  // Both have it, or neither: no automatic place.
  expect(placeAnnotation(q, [block('bbb222', 'h2', '水深加倍时，静水压强也加倍。'), block('ccc333', 'h3', '水深加倍时，静水压强也加倍。')], { at: AT })).toMatchObject({ status: 'needs-confirmation' })
  expect(placeAnnotation(q, [block('bbb222', 'h2', '换了说法。')], { at: AT })).toMatchObject({ status: 'original-only' })
  expect(placeAnnotation(q, [], { at: AT })).toMatchObject({ status: 'original-only', reason: expect.stringContaining('保留') })
})

it('a note on a whole paragraph follows the paragraph only while it is unchanged', () => {
  expect(placeAnnotation(undefined, [block('aaa111', 'h1', '内容')], { anchorHash: 'h1', at: AT })).toMatchObject({ status: 'anchored', blockId: 'aaa111' })
  expect(placeAnnotation(undefined, [block('aaa111', 'h9', '改过的内容')], { anchorHash: 'h1', at: AT })).toMatchObject({ status: 'needs-confirmation', blockId: 'aaa111' })
})

it('a place the learner confirmed holds until the paragraph changes again', () => {
  const q = quote('静水压强也加倍', '水深加倍时，', '。')
  const confirmed = placeAnnotation(q, [block('bbb222', 'h2', '水深加倍时，静水压强也加倍。'), block('ccc333', 'h3', '水深加倍时，静水压强也加倍。')], { at: AT })
  expect(confirmed.status).toBe('needs-confirmation')
  const picked = { status: 'anchored' as const, blockId: 'bbb222', hash: 'h2', confirmedAt: AT, checkedAt: AT }
  expect(placeAnnotation(q, [block('bbb222', 'h2', '水深加倍时，静水压强也加倍。'), block('ccc333', 'h3', '水深加倍时，静水压强也加倍。')], { previous: picked, at: AT })).toMatchObject({ status: 'anchored', blockId: 'bbb222', confirmedAt: AT })
  // The paragraph was edited after the confirmation: the quote is checked again.
  expect(placeAnnotation(q, [block('bbb222', 'h8', '水深加倍时，静水压强也不加倍。')], { previous: picked, at: AT })).toMatchObject({ status: 'needs-confirmation' })
})

it('a quote may not start or end inside a formula', () => {
  const text = '压强按 $p=\\rho g h$ 计算，与深度成正比。'
  expect(quoteCutsFormula(text, quote('rho g'))).toBe(true)
  expect(quoteCutsFormula(text, quote('压强按 $p=\\rho'))).toBe(true)
  expect(quoteCutsFormula(text, quote('按 $p=\\rho g h$ 计算'))).toBe(false)
  expect(quoteCutsFormula(text, quote('与深度成正比'))).toBe(false)
  // Where one place is outside the formula, the quote is not about the formula.
  expect(quoteCutsFormula('h 是高度，$h=1$', quote('h'))).toBe(false)
})
