import { describe, expect, it } from 'vitest'
import { addSources, bareTex, checkPrompt, flagged, formulasIn, judge, numbersIn, paragraphsOf, precheck, reasonOf } from '../src/check.ts'

const A = 'ck_01K6PQZRB8M3A4T5V6W7X8Y9Z0'
const B = 'ck_01K6PQZRB8M3A4T5V6W7X8Y9Z1'

const body = [
  '### 静力学基本方程',
  `两点压强差只看高度差。[《示例》p.2](cite:${A}) ^aaaaa1`,
  `> [!quote] 原文 · [《示例》p.2](cite:${B})\n> $$p_2 = p_1 + \\rho g h$$\n\n^bbbbb2`,
  '记录压强要写明种类。 ^ccccc3',
  '好。 ^ddddd4',
  '### 读完就答',
  '1. 等压面要满足什么？ ^eeeee5',
].join('\n\n')

describe('textbook check', () => {
  it('checks the explanation only: not source text copied in, recall questions or a word or two', () => {
    expect(paragraphsOf(body)).toEqual([
      { id: 'P1', blockId: 'aaaaa1', text: '两点压强差只看高度差。', citations: [A] },
      { id: 'P2', blockId: 'ccccc3', text: '记录压强要写明种类。', citations: [] },
    ])
    expect(paragraphsOf(body, new Set(['ccccc3'])).map(paragraph => paragraph.blockId)).toEqual(['ccccc3'])
  })

  it('compares formulas without their markup, as MinerU writes them and as a writer does', () => {
    expect(bareTex('p _ {\\mathrm{B}} = \\lim _ {\\Delta A \\to 0} (\\Delta F / \\Delta A)\\tag{1-1}')).toBe(bareTex('p_{B}=\\lim_{\\Delta A\\to 0}(\\Delta F/\\Delta A)'))
    expect(bareTex('p _ {\\text {真}} = p _ {0} - p')).toBe(bareTex('$p_{真}=p_0-p$'))
    expect(formulasIn('由 $p_2=p_1+\\rho gh$ 可知，$h$ 越大压强越大。')).toEqual(['p_2=p_1+\\rho gh'])
  })

  it('finds by rule numbers the material lacks and words copied from an exercise; formulas it only reports', () => {
    const material = '水的密度取 1000 kg/m³，1 m 水柱对应 10 kPa。$$p _ {2} = p _ {1} + \\rho g h$$'
    const stems = ['1-6 敞口水槽中水深 3 m，取大气压 100 kPa，求槽底的表压强。']
    expect(precheck('水的密度取 1000 kg/m³，所以 1 m 水柱是 10 kPa。', material, stems)).toEqual({ unknown: [] })
    expect(precheck('水的密度取 998 kg/m³。', material, stems)).toEqual({ problem: '数值 998 在资料里找不到', unknown: [] })
    expect(precheck('由 $p_2=p_1+\\rho g h$ 得 $p_1 = p_2 - \\rho g h$。', material, stems)).toEqual({ unknown: ['p_1 = p_2 - \\rho g h'] })
    expect(precheck('敞口水槽中水深 3 m，取大气压 100 kPa 时槽底表压是多少？', material, stems).problem).toMatch(/题干/)
    expect(numbersIn('式(1-8)给出 1.013×10^5 Pa，第 12 页')).toEqual(['1.013', '10'])
  })

  it('asks about each paragraph with its material, naming formulas the program did not find', () => {
    const prompt = checkPrompt(paragraphsOf(body), [{ id: A, text: '两点压强差等于 ρgh。', kind: 'text', citation: '《示例》p.2' }], new Map([['P2', ['p = 1']]]))
    expect(prompt).toContain(`[${A}] 《示例》p.2\n两点压强差等于 ρgh。`)
    expect(prompt).toContain('[P1] 两点压强差只看高度差。')
    expect(prompt).toContain('（资料里没有原样出现的式子：$p = 1$，请判断能否由资料直接得出）')
  })

  it('takes the reply\'s judgments, keeps what the program found, and calls what it left out unchecked', () => {
    const paragraphs = [...paragraphsOf(body), { id: 'P3', blockId: 'fffff6', text: '另一段。', citations: [] }]
    const reply = { results: [
      { id: 'P1', verdict: 'ok', sources: [A, 'ck_made_up', A] },
      { id: 'P2', verdict: 'ok', sources: [B] },
    ] }
    const checks = judge(paragraphs, reply, new Set([A, B]), new Map([['P2', '数值 998 在资料里找不到']]))
    expect(checks.get('aaaaa1')).toEqual({ verdict: 'ok', note: '', sources: [A] })
    expect(checks.get('ccccc3')).toEqual({ verdict: 'unsupported', note: '数值 998 在资料里找不到', sources: [B] })
    expect(checks.get('fffff6')).toEqual({ verdict: 'unchecked', note: '核对模型没有给出这段的判断', sources: [] })
    expect([...checks.values()].map(flagged)).toEqual([false, true, false])
    expect(reasonOf('记录压强要写明种类。 [x](cite:a)', checks.get('ccccc3')!)).toBe('「记录压强要写明种类。」数值 998 在资料里找不到')
  })

  it('adds the source an uncited paragraph comes from', () => {
    const out = addSources(body, new Map([['ccccc3', [{ id: A, text: '', kind: 'text', citation: '《示例》p.2' }]], ['bbbbb2', [{ id: A, text: '', kind: 'text', citation: '《示例》p.2' }]]]))
    expect(out).toContain(`记录压强要写明种类。 [《示例》p.2](cite:${A}) ^ccccc3`)
    // Source text copied in keeps the citation it came with.
    expect(out).toContain(`> [!quote] 原文 · [《示例》p.2](cite:${B})\n> $$p_2 = p_1 + \\rho g h$$`)
  })
})
