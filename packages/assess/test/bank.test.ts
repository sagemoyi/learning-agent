// The pieces of a trustworthy bank (docs/assess/design.md, A): reading printed answers, units in
// numeric grading, the restricted calculator, expression equivalence and exercise numbers.
import { describe, expect, it } from 'vitest'
import type { CitedChunk } from '@learning-agent/contracts'
import { calculate, inUnit } from '../src/calculator.ts'
import { answerFromPrinted, exercisesOf, expandRefs } from '../src/exercises.ts'
import { combine, equivalent, judgeByRule } from '../src/grading.ts'
import { splitQuantity } from '../src/units.ts'

const density = { kind: 'numeric' as const, value: 1.439, unit: 'kg/m³', tolerance: { relative: 0.02 } }

describe('numeric answers with units', () => {
  it('reads the number and the unit after it', () => {
    expect(splitQuantity('1.44 kg/m³')).toEqual({ value: 1.44, unit: 'kg/m^3' })
    expect(splitQuantity('ρ = 1.44×10³ g/m^3')).toEqual({ value: 1440, unit: 'g/m^3' })
    expect(splitQuantity('约 0.0231m')).toEqual({ value: 0.0231, unit: 'm' })
    expect(splitQuantity('$4.38 \\times 10^{3}$ W').value).toBeCloseTo(4380)
    expect(splitQuantity('不会').value).toBeUndefined()
  })

  it('converts units, and judges a missing unit as partly right and a wrong dimension as wrong', () => {
    expect(judgeByRule(density, '1.44 kg/m³')?.verdict).toBe('correct')
    expect(judgeByRule(density, '1440 g/m3')?.verdict).toBe('correct')
    expect(judgeByRule(density, '1.44')).toMatchObject({ verdict: 'partial', score: 0.5 })
    expect(judgeByRule(density, '1.44')?.rationale).toMatch(/没写单位/)
    expect(judgeByRule(density, '1.44 m')?.verdict).toBe('incorrect')
    expect(judgeByRule(density, '1.44 m')?.rationale).toMatch(/量纲不对/)
    expect(judgeByRule(density, '2.0 kg/m³')?.verdict).toBe('incorrect')
    const pressure = { kind: 'numeric' as const, value: 19.6, unit: 'kPa', tolerance: { relative: 0.02 } }
    expect(judgeByRule(pressure, '19600 Pa')?.verdict).toBe('correct')
    expect(judgeByRule(pressure, '0.2 at')?.verdict).toBe('correct')
    expect(judgeByRule({ kind: 'numeric', value: 63, unit: '℃', tolerance: { relative: 0.02 } }, '336.2 K')?.verdict).toBe('correct')
    expect(judgeByRule({ kind: 'numeric', value: 2.84, unit: 'Pa·s', tolerance: { relative: 0.02 } }, '2840 cP')?.verdict).toBe('correct')
  })

  it('compares bare numbers when the book unit is not a physical unit', () => {
    expect(judgeByRule({ kind: 'numeric', value: 13.4, unit: '块', tolerance: { relative: 0.02 } }, '13.4')?.verdict).toBe('correct')
    expect(judgeByRule({ kind: 'numeric', value: 37.5, unit: '%', tolerance: { relative: 0.02 } }, '37.5%')?.verdict).toBe('correct')
  })

  it('grades several parts on their own and combines them', () => {
    const graded = combine([
      { label: '（1）', verdict: 'correct', score: 1, rationale: 'a', method: 'rule', confidence: 'high' },
      { label: '（2）', verdict: 'incorrect', score: 0, rationale: 'b', method: 'rule', confidence: 'high' },
    ])
    expect(graded).toMatchObject({ verdict: 'partial', score: 0.5, parts: [{ label: '（1）', verdict: 'correct' }, { label: '（2）', verdict: 'incorrect' }] })
  })
})

describe('printed answers', () => {
  it('turns number-and-unit answers into numeric ones and words into the model\'s rubric', () => {
    expect(answerFromPrinted('336m')).toMatchObject({ kind: 'numeric', value: 336, unit: 'm' })
    expect(answerFromPrinted('6.28×10-3m')).toMatchObject({ kind: 'numeric', unit: 'm' })
    expect((answerFromPrinted('6.28×10-3m') as { value: number }).value).toBeCloseTo(6.28e-3)
    expect(answerFromPrinted('左侧高 0.020m')).toEqual({ kind: 'open', rubric: '参考答案：左侧高 0.020m' })
    expect(answerFromPrinted('0.0166m/s（或0.0149m/s）')).toMatchObject({ kind: 'open' })
    expect(answerFromPrinted('1:2:1')).toMatchObject({ kind: 'open' })
  })

  it('splits labelled parts', () => {
    const answer = answerFromPrinted('（1）484.8Pa；（2）480.7Pa；（3）0.0493m')
    expect(answer).toMatchObject({ kind: 'parts', parts: [
      { label: '（1）', answer: { kind: 'numeric', value: 484.8, unit: 'Pa' } },
      { label: '（2）', answer: { kind: 'numeric', value: 480.7 } },
      { label: '（3）', answer: { kind: 'numeric', value: 0.0493, unit: 'm' } },
    ] })
    expect(answerFromPrinted('①适用；②627.8W')).toMatchObject({ kind: 'parts', parts: [{ answer: { kind: 'open' } }, { answer: { kind: 'numeric', value: 627.8, unit: 'W' } }] })
  })
})

describe('exercises in a source', () => {
  const chunk = (id: string, kind: CitedChunk['kind'], text: string, section = ['第1章', '习题']): CitedChunk => ({
    id: id as CitedChunk['id'], sourceId: 'src_1' as CitedChunk['sourceId'], locator: { page: 1, block: Number(id.slice(-1)) }, kind, section, text, citation: '《合成》p.1',
  })

  it('collects stems across blocks, figures and the printed answer', () => {
    const found = exercisesOf([
      chunk('c1', 'heading', '习题'),
      chunk('c2', 'exercise', '1-1 求槽底压强。 [10 kPa]'),
      chunk('c3', 'exercise', '1-2 如附图，求（1）压强；（2）读数。'),
      chunk('c4', 'figure', '附图 1-2'),
      chunk('c5', 'answer', '[① 19.6kPa；② 2.00m]'),
      chunk('c6', 'exercise', '1-3 喷嘴向上喷射，'),
      chunk('c7', 'exercise', '求 5 m 处的直径。 [0.0231m]'),
      chunk('c8', 'exercise', '1-4 想一想。', ['第1章', '复习思考题']),
    ])
    expect(found.map(item => [item.ref, item.printed, item.figures.length, item.review])).toEqual([
      ['1-1', '10 kPa', 0, false],
      ['1-2', '① 19.6kPa；② 2.00m', 1, false],
      ['1-3', '0.0231m', 0, false],
      ['1-4', undefined, 0, true],
    ])
    expect(found[2]!.stem).toBe('喷嘴向上喷射，\n\n求 5 m 处的直径。')
  })

  it('expands homework numbers', () => {
    expect(expandRefs('1-1~1-3, 2-5，2-7 ～ 2-8')).toEqual({ refs: ['1-1', '1-2', '1-3', '2-5', '2-7', '2-8'], bad: [] })
    expect(expandRefs('1-1~2-3 第三题').bad).toEqual(['1-1~2-3', '第三题'])
  })
})

describe('the restricted calculator', () => {
  it('computes with units line by line', () => {
    const run = calculate('p = 101325 Pa + 0.2 at\nM = 29 g/mol\nR = 8.314 J/(mol K)\nT = 293.15 K\nrho = p * M / (R * T)', ['rho'])
    expect(inUnit(run.values.rho!, 'kg/m³')).toBeCloseTo(1.439, 3)
    expect(inUnit(run.values.rho!, 'm')).toBeUndefined()
    expect(run.lines).toHaveLength(5)
  })

  it('refuses anything but arithmetic', () => {
    expect(() => calculate('f(x) = x^2')).toThrow(/不能定义函数/)
    expect(() => calculate('import({}, {})')).toThrow(/不能调用 import/)
    expect(() => calculate('evaluate("1+1")')).toThrow(/不能调用 evaluate/)
    expect(() => calculate('x = [1, 2]')).toThrow(/不支持这种写法/)
    expect(() => calculate('x = 1:1000000000')).toThrow(/不支持这种写法/)
    expect(() => calculate('x = 1'.repeat(2000))).toThrow(/太长/)
    expect(() => calculate('y = 2', ['z'])).toThrow(/没有变量 z/)
  })
})

describe('expressions', () => {
  it('shows equivalence by substitution', () => {
    expect(equivalent('\\sqrt{u_1^2 - 2 g h}', 'sqrt(u_1^2 - 2*g*h)')).toBe(true)
    expect(equivalent('u_2 = \\frac{u_1 d_1^2}{d_2^2}', 'u_1*(d_1/d_2)^2')).toBe(true)
    expect(equivalent('u_1*d_1/d_2', 'u_1*(d_1/d_2)^2')).toBe(false)
    expect(judgeByRule({ kind: 'expression', value: 'u_1*(d_1/d_2)^2' }, 'u_1*d_1/d_2')).toBeUndefined()
  })
})
