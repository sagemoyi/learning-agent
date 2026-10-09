import { describe, expect, it } from 'vitest'
import { checkPrompt, isKey, judge, markBody, numbersIn, planBatches, quoted, sentencesOf, settled, termsOf, unitsOf, type CheckChunk, type SentenceCheck } from '../src/check.ts'

const A = 'ck_01K6PQZRB8M3A4T5V6W7X8Y9Z0'
const B = 'ck_01K6PQZRB8M3A4T5V6W7X8Y9Z1'
const chunk = (id: string, text: string, kind = 'text', sourceId = 'src_a'): CheckChunk => ({ id, text, kind, citation: '《合成》p.1', sourceId })

describe('textbook check', () => {
  it('cuts paragraphs into sentences and tells key facts by rule', () => {
    expect(sentencesOf(`压强随深度增加。水深加倍，压强也加倍；方向向下。[x](cite:${A})`, false)).toEqual(['压强随深度增加。', '水深加倍，压强也加倍；', '方向向下。'])
    expect(sentencesOf('$$p = \\rho g h$$', true)).toEqual(['$$p = \\rho g h$$'])
    expect(isKey('压强是指单位面积上的力。', false)).toBe(true)
    expect(isKey('取大气压 100 kPa。', false)).toBe(true)
    expect(isKey('由 $p = \\rho g h$ 可知压强随深度增加。', false)).toBe(true)
    expect(isKey('深度越大，压强越大。', false)).toBe(false)
  })

  it('checks paragraphs that state something, not recall questions, formula lead-ins or source notes', () => {
    const body = [
      '## 1.2 标题', `压强随深度增加。[x](cite:${A}) ^aaaaa1`, '按下式计算： ^aaaaa2', '$$p = \\rho g h$$\n^aaaaa3',
      `式中 h 是深度。[x](cite:${A}) ^aaaaa4`, '上式没有找到出处。[待核实](cite:unverified) ^aaaaa5', '### 读完就答', '1. 水深加倍会怎样？ ^aaaaa6',
    ].join('\n\n')
    const units = unitsOf(body)
    expect(units.map(unit => [unit.blockId, unit.formula, unit.citations])).toEqual([['aaaaa1', false, [A]], ['aaaaa3', true, []], ['aaaaa4', false, [A]]])
    expect(units[1]!.sentences[0]).toMatchObject({ id: '2.1', key: true, formula: true })
  })

  it('keeps a formula in the batch of the paragraph after it', () => {
    const units = unitsOf(`甲句很长很长。[x](cite:${A}) ^aaaaa1\n\n$$x = 1$$\n^aaaaa2\n\n乙句也很长。[x](cite:${B}) ^aaaaa3`)
    const chunks = new Map([[A, chunk(A, '甲'.repeat(60))], [B, chunk(B, '乙'.repeat(60))]])
    const batches = planBatches(units, id => chunks.get(id), 150)
    expect(batches.map(batch => batch.units.map(unit => unit.blockId))).toEqual([['aaaaa1'], ['aaaaa2', 'aaaaa3']])
    expect(checkPrompt(batches[1]!)).toContain('段落 2（独立公式，出处在下一段）')
  })

  it('finds the numbers a sentence states, not subscripts or section, example and equation numbers', () => {
    expect(numbersIn('按 1.2 节和例 1-1，式(1-3) 中 $p_{2} = p_1 + \\rho g h$，取 998.2 kg/m³ 和 20 000 Pa，共 3 步。')).toEqual(['998.2', '20000'])
    expect(numbersIn('１０１.３ kPa')).toEqual(['101.3'])
  })

  it('cuts a sentence into keywords for the full-text search', () => {
    expect(termsOf(`压强是指单位面积上受到的垂直作用力，单位 Pascal。[x](cite:${A})`)).toBe('压强是指 单位面积 上受到的 垂直作用 Pascal')
  })

  it('accepts a judgment only with a real quote and the sentence\'s numbers in the cited text', () => {
    const units = unitsOf([
      `压强是指单位面积上的力。[x](cite:${A}) ^aaaaa1`,
      `水的密度取 998 kg/m³。[x](cite:${A}) ^aaaaa2`,
      `例 1-1 水深 2 m，表压 20 kPa。[x](cite:${B}) ^aaaaa3`,
      `深度越大压强越大。[x](cite:${A}) ^aaaaa4`,
      `液面上方压强变化多少，各点跟着变化多少。[x](cite:${A}) ^aaaaa5`,
    ].join('\n\n'))
    const allowed = new Map([[A, chunk(A, '压强是指 单位面积上的力。水的密度取 1000 kg/m³。')], [B, chunk(B, '例 1-1 水深 2 m，表压为 20 kPa。', 'example')]])
    const results = judge(units.flatMap(unit => unit.sentences), { results: [
      { id: '1.1', verdict: 'supported', evidence: [{ chunk: A, quote: '压强是指单位面积上的力' }] },
      { id: '2.1', verdict: 'supported', evidence: [{ chunk: A, quote: '水的密度取' }] },
      { id: '3.1', verdict: 'supported', evidence: [{ chunk: B, quote: '水深 2 m' }] },
      { id: '4.1', verdict: 'supported', evidence: [{ chunk: A, quote: '深度越大压强越大' }] },
      { id: '5.1', verdict: 'nonsense' },
    ] }, allowed)
    expect(results.get('1.1')).toMatchObject({ verdict: 'supported', key: true, copy: false })
    expect(results.get('2.1')).toMatchObject({ verdict: 'partial', note: '数值 998 在所引原文里找不到' })
    expect(results.get('3.1')).toMatchObject({ verdict: 'supported', copy: true })
    expect(results.get('4.1')).toMatchObject({ verdict: 'missing', note: '核对模型摘出的原文在所引片段里找不到' })
    expect(results.get('5.1')).toMatchObject({ verdict: 'unchecked' })
    // A quote from a chunk the batch was not given counts for nothing.
    expect(judge(units[0]!.sentences, { results: [{ id: '1.1', verdict: 'supported', evidence: [{ chunk: B, quote: '水深' }] }] }, new Map([[A, allowed.get(A)!]])).get('1.1')!.verdict).toBe('missing')
  })

  it('takes a formula found as it is in a given formula chunk as supported, whatever the reply says', () => {
    const units = unitsOf('$$ p_1 - p_2 = (\rho_0 - \rho) g R $$\n^aaaaa1')
    const allowed = new Map([[A, chunk(A, '$$\np_1 - p_2 = (\rho_0 - \rho) g R\n$$', 'formula')]])
    expect(judge(units[0]!.sentences, { results: [{ id: '1.1', verdict: 'supported', evidence: [{ chunk: A, quote: 'p1 - p2 = (ρ0 - ρ)gR' }] }] }, allowed).get('1.1'))
      .toMatchObject({ verdict: 'supported', key: true, evidence: [{ chunkId: A }] })
    expect(judge(units[0]!.sentences, undefined, new Map([[A, chunk(A, '$$p_1 + p_2$$', 'formula')]])).get('1.1')!.verdict).toBe('unchecked')
  })

  it('finds a quoted formula without its LaTeX markup', () => {
    expect(quoted('$$\np_{真空} = p_{大气} - p_{绝}\n$$', 'p_真空 = p_大气 - p_绝')).toBe(true)
    expect(quoted('$$\np_{真空} = p_{大气} - p_{绝}\n$$', 'p_真空 = p_绝 - p_大气')).toBe(false)
    expect(quoted('压强随深度增加', '压强随 深度增加')).toBe(true)
  })

  it('asks two independent sources of a key fact, except one copied from a worked example', () => {
    const check = (patch: Partial<SentenceCheck>): SentenceCheck => ({ text: '', verdict: 'supported', key: true, copy: false, evidence: [], groups: ['work:a'], note: '', ...patch })
    expect(settled(check({}))).toBe('single')
    expect(settled(check({ groups: ['work:a', 'site:b.edu.cn'] }))).toBe('ok')
    expect(settled(check({ copy: true }))).toBe('ok')
    expect(settled(check({ key: false }))).toBe('ok')
    expect(settled(check({ verdict: 'partial' }))).toBe('unsupported')
  })

  it('writes the check into the text', () => {
    const body = [
      `甲。[x](cite:${A}) ^aaaaa1`,
      '乙。 [待核实](cite:unverified) ^aaaaa2',
      '$$x = 1$$\n^aaaaa3',
      `丙。[x](cite:${A}) ^aaaaa4`,
      '$$y = 2$$\n^aaaaa5',
      `丁。[x](cite:${A}) ^aaaaa6`,
    ].join('\n\n') + '\n'
    const other = chunk(B, '乙', 'text', 'src_b')
    const marked = markBody(body, new Map([
      ['aaaaa1', { unsupported: true, add: [] }],
      ['aaaaa2', { unsupported: false, add: [other] }],
      ['aaaaa3', { unsupported: false, add: [other] }],
      ['aaaaa5', { unsupported: true, add: [] }],
    ]), () => 'nnnnn1')
    expect(marked).toBe([
      `甲。[x](cite:${A})[待核实](cite:unverified) ^aaaaa1`,
      `乙。[《合成》p.1](cite:${B}) ^aaaaa2`,
      '$$x = 1$$\n^aaaaa3',
      `丙。[x](cite:${A})[《合成》p.1](cite:${B}) ^aaaaa4`,
      '$$y = 2$$\n^aaaaa5',
      '上式没有在所引原文里找到依据。[待核实](cite:unverified) ^nnnnn1',
      `丁。[x](cite:${A}) ^aaaaa6`,
    ].join('\n\n') + '\n')
  })

  it('turns the note after a formula into its source once one is found', () => {
    const note = '上式没有找到出处。[待核实](cite:unverified)'
    const body = ['$$x = 1$$\n^aaaaa1', `${note} ^aaaaa2`, '$$y = 2$$\n^aaaaa3', `${note} ^aaaaa4`].join('\n\n') + '\n'
    const marked = markBody(body, new Map([
      ['aaaaa1', { unsupported: false, add: [chunk(A, 'x = 1', 'formula')] }],
      ['aaaaa3', { unsupported: true, add: [] }],
    ]), () => 'nnnnn1')
    // The second formula already has its note: no second one.
    expect(marked).toBe(['$$x = 1$$\n^aaaaa1', `上式出自[《合成》p.1](cite:${A})。 ^aaaaa2`, '$$y = 2$$\n^aaaaa3', `${note} ^aaaaa4`].join('\n\n') + '\n')
    expect(unitsOf(marked).map(unit => unit.blockId)).toEqual(['aaaaa1', 'aaaaa3'])
  })
})
