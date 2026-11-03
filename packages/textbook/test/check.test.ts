import { describe, expect, it } from 'vitest'
import { bareTex, checkOf, copiesOf, flagged, formulasIn, numbersIn, paragraphsOf, precheck, reasonOf, statesFormula } from '../src/check.ts'

const A = 'ck_01K6PQZRB8M3A4T5V6W7X8Y9Z0'
const B = 'ck_01K6PQZRB8M3A4T5V6W7X8Y9Z1'

const body = [
  '### 静力学基本方程',
  `两点压强差只看高度差。[《示例》p.2](cite:${A}) ^aaaaa1`,
  `> [!quote] 原文 · [《示例》p.2](cite:${B})\n> $$p_2 = p_1 + \\rho g h$$\n\n^bbbbb2`,
  '记录压强要写明种类。 ^ccccc3',
  '好。 ^ddddd4',
  `| 名词 | 是什么 | 出处 |\n|---|---|---|\n| **压强** | 单位面积上的力 | [x](cite:${A}) |\n\n^hhhhh8`,
  '> [!note] 资料里没有讲到：扩大室。可以问主老师。 ^ggggg7',
  '### 读完就答',
  '1. 等压面要满足什么？ ^eeeee5',
].join('\n\n')

describe('handout check', () => {
  it('checks the explanation only: not tables, source text copied in, the program\'s notes, older recall questions or a word or two', () => {
    expect(paragraphsOf(body)).toEqual([
      { blockId: 'aaaaa1', text: '两点压强差只看高度差。', citations: [A] },
      { blockId: 'ccccc3', text: '记录压强要写明种类。', citations: [] },
    ])
    expect(paragraphsOf(body, new Set(['ccccc3'])).map(paragraph => paragraph.blockId)).toEqual(['ccccc3'])
  })

  it('compares formulas without their markup, as MinerU writes them and as a writer does', () => {
    expect(bareTex('p _ {\\mathrm{B}} = \\lim _ {\\Delta A \\to 0} (\\Delta F / \\Delta A)\\tag{1-1}')).toBe(bareTex('p_{B}=\\lim_{\\Delta A\\to 0}(\\Delta F/\\Delta A)'))
    expect(bareTex('p _ {\\text {真}} = p _ {0} - p')).toBe(bareTex('$p_{真}=p_0-p$'))
    expect(formulasIn('由 $p_2=p_1+\\rho gh$ 可知，$h$ 越大压强越大。')).toEqual(['p_2=p_1+\\rho gh'])
  })

  it('keeps what a formula says: sub- and superscripts, grouping, signs and bars', () => {
    const material = bareTex('$$p _ {2} = p _ {1} + \\rho g h$$ 和 $$h = \\left| \\Delta p \\right| / (\\rho g)$$，$$H = \\frac {\\Delta p} {\\rho g}$$')
    // Only spacing, braces around one character and \left/\right differ.
    for (const same of ['p_2=p_1+\\rho gh', 'p_{2} = p_{1} + \\rho\\, g h', 'h=|\\Delta p|/(\\rho g)', 'H=\\dfrac{\\Delta p}{\\rho g}']) expect(statesFormula(material, same), same).toBe(true)
    for (const changed of [
      'p^2=p^1+\\rho gh', // superscripts for subscripts
      'p_1=p_2+\\rho gh', // subscripts swapped
      'p_2=p_1-\\rho gh', // a sign
      'h=\\Delta p/(\\rho g)', // the bars gone
      'H=\\frac{\\Delta p}{\\rho}g', // the denominator regrouped
    ]) expect(statesFormula(material, changed), changed).toBe(false)
    // A PDF's text layer writes subscripts flat; superscripts still count.
    const plain = bareTex('静止液体中 p2=p1+ρgh。')
    expect(statesFormula(plain, 'p_2=p_1+\\rho g h')).toBe(true)
    expect(statesFormula(plain, 'p^2=p^1+\\rho g h')).toBe(false)
  })

  it('finds by rule words copied from an exercise, an exercise named, formulas unlike the source, and numbers the material lacks', () => {
    const material = '水的密度取 1000 kg/m³，1 m 水柱对应 10 kPa，层流时 Re≤2000。$$p _ {2} = p _ {1} + \\rho g h$$'
    const stems = ['1-6 敞口水槽中水深 3 m，取大气压 100 kPa，求槽底的表压强。']
    expect(precheck('水的密度取 1000 kg/m³，所以 1 m 水柱是 10 kPa。', material, stems)).toBeUndefined()
    expect(precheck('水的密度取 998 kg/m³。', material, stems)).toEqual({ note: '数值 998 在资料里找不到', contradicts: false })
    // The formula as the source writes it, whatever the markup; a rearranged one is at odds with the source (10-31).
    expect(precheck('由 $p_2=p_1+\\rho g h$ 可知，层流要求 $Re \\le 2000$。', material, stems)).toBeUndefined()
    expect(precheck('由 $p_2=p_1+\\rho g h$ 得 $p_1 = p_2 - \\rho g h$。', material, stems)).toEqual({ note: '式子 $p_1 = p_2 - \\rho g h$ 和资料里的写法不一致，公式要和原文一样', contradicts: true })
    expect(precheck('敞口水槽中水深 3 m，取大气压 100 kPa 时槽底表压是多少？', material, stems)!.note).toMatch(/题干/)
    // A handout says how to solve a kind of problem, never which exercise (11-01).
    expect(precheck('习题 1-6 就是这一类。', material, stems)).toEqual({ note: '提到了习题的题号，讲义只讲方法', contradicts: false })
    expect(precheck('第 3 题也是这样算。', material, stems)!.note).toMatch(/题号/)
    expect(numbersIn('式(1-8)给出 1.013×10^5 Pa，第 12 页')).toEqual(['1.013', '10'])
  })

  it('finds a paragraph that copies 20 characters of its material in a row, leaving out formulas and links', () => {
    const copies = copiesOf('流体在单位面积上所受的垂直压力，称为流体的静压强，简称压强。$$p = \\frac{F}{A}$$')
    expect(copies(`压强：流体在单位面积上所受的垂直压力称为流体的静压强。[《示例》p.2](cite:${A})`)).toBe(true)
    expect(copies('压强就是垂直压在单位面积上的力，写作 $p = \\frac{F}{A}$，流体里通常说的压强都是这个意思。')).toBe(false)
  })

  it('keeps what it found as the paragraph\'s check, and says why in words', () => {
    const check = checkOf({ note: '数值 998 在资料里找不到', contradicts: false })
    expect(check).toEqual({ verdict: 'unsupported', note: '数值 998 在资料里找不到', sources: [] })
    expect(flagged(check)).toBe(true)
    expect(flagged(checkOf({ note: '式子不一致', contradicts: true }))).toBe(true)
    expect(reasonOf('记录压强要写明种类。 [x](cite:a)', check)).toBe('「记录压强要写明种类。」数值 998 在资料里找不到')
  })
})
