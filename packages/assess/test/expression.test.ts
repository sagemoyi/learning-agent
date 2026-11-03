// assess (docs/assess/design.md, 判分): what a learner, a book or the teacher writes as an expression is checked before
// it runs, in grading and in the calculator alike; nothing written can redefine units or tie up the service.
import { describe, expect, it } from 'vitest'
import { LearningApiError } from '@learning-agent/contracts'
import { calculate } from '../src/calculator.ts'
import { parseExpression } from '../src/expression.ts'
import { equivalence, parseDomain } from '../src/equivalence.ts'
import { judgeByRule } from '../src/grading.ts'
import { convert, parse, unitOf } from '../src/units.ts'

const expression = { kind: 'expression' as const, value: 'rho*g*h' }
const nested = (depth: number) => `${'('.repeat(depth)}x${')'.repeat(depth)}`

/** Answers that must never be evaluated. */
const REFUSED = [
  'createUnit("fathom2", "1.8288 m")',
  'import({ sqrt: 1 }, { override: true })',
  'evaluate("1+1")',
  'ones(1000, 1000)',
  'zeros(3000, 3000) * 2',
  '1:1e9',
  '[1, 2, 3]',
  'a.b + 1',
  'x > 0 ? x : -x',
  nested(60),
  Array.from({ length: 300 }, (_, i) => `x${i % 10}`).join('+'),
  Array.from({ length: 30 }, (_, i) => `v${i}`).join('+'),
]

describe('expressions before they run', () => {
  it('leaves an answer it may not run to the grader, quickly, with the units untouched', () => {
    const start = performance.now()
    for (const answer of REFUSED) {
      expect(equivalence(answer, 'x').kind, answer).toBe('unknown')
      expect(judgeByRule(expression, answer), answer).toBeUndefined()
    }
    expect(performance.now() - start).toBeLessThan(1000)
    // Grading reads what is right of the last "=", so a definition on the left is never parsed.
    expect(equivalence('f(x) = x^2', 'x^2').kind).toBe('equal')
    expect(unitOf('fathom2')).toBeUndefined()
    expect(convert(1, 'at', 'kPa')).toBeCloseTo(98.0665)
  })

  it('still grades what textbooks write', () => {
    expect(equivalence('\\frac{\\rho g h}{2}', 'rho*g*h/2').kind).toBe('equal')
    expect(equivalence('2x+3', 'x+x+3').kind).toBe('equal')
    expect(equivalence('x+1', 'x').kind).toBe('different')
    expect(judgeByRule(expression, 'ρ g h')?.verdict).toBe('correct')
  })

  it('takes agreement for proof only for rational expressions, or within the ranges the problem declares', () => {
    const judge = (given: string, value: string, domain?: string) => judgeByRule({ kind: 'expression', value, ...(domain ? { domain } : {}) }, given)
    // Negatives, zero, tiny and huge numbers find the difference.
    expect(judge('sqrt(x^2)', 'x')).toMatchObject({ verdict: 'incorrect', rationale: expect.stringMatching(/^代入 x = -/) })
    expect(judge('abs(x)/x', '1')?.verdict).toBe('incorrect')
    expect(judge('max(x, 0)', 'x')?.verdict).toBe('incorrect')
    expect(judge('x*1e-7', '0')?.verdict).toBe('incorrect')
    expect(judge('1e-7/x', '0')?.verdict).toBe('incorrect')
    // Declared ranges: equal where the problem says the variable lies.
    expect(judge('sqrt(x^2)', 'x', 'x ≥ 0')).toMatchObject({ verdict: 'correct', rationale: expect.stringContaining('x ≥ 0') })
    expect(judge('sqrt(2*g*h)', 'sqrt(2*g)*sqrt(h)', 'g > 0, h > 0')?.verdict).toBe('correct')
    // No range and no counterexample: not shown, so the grader model decides.
    expect(judge('sqrt(2*g)*sqrt(h)', 'sqrt(2*g*h)')).toBeUndefined()
    expect(judge('exp(a)*exp(b)', 'exp(a+b)')).toBeUndefined()
    // Rational expressions, and the same expression in another order, are shown equal.
    expect(judge('a^2 + 2*a*b + b^2', '(a+b)^2')?.verdict).toBe('correct')
    expect(judge('(x^2-1)/(x-1)', 'x+1')?.verdict).toBe('correct')
    expect(judge('sqrt(2 h g)', 'sqrt(2*g*h)')).toMatchObject({ verdict: 'correct', rationale: '和参考表达式只是写法或顺序不同' })
    // The same answer is graded the same every time.
    expect(judge('sqrt(x^2)', 'x')).toEqual(judge('sqrt(x^2)', 'x'))
  })

  it('reads the ranges a problem declares', () => {
    expect(parseDomain('x > 0, 0 ≤ y ≤ 1；3 >= z')).toEqual(new Map([
      ['x', { min: 0, minOpen: true }],
      ['y', { min: 0, minOpen: false, max: 1, maxOpen: false }],
      ['z', { max: 3, maxOpen: false }],
    ]))
    expect(parseDomain('ρ > 0 且 1 ≥ t > 0').get('rho')).toEqual({ min: 0, minOpen: true })
    expect(() => parseDomain('x 是正数')).toThrow('看不懂变量范围"x 是正数"')
    expect(() => parseDomain('x > 2, x < 1')).toThrow('变量 x 的范围是空的')
  })

  it('refuses the same in the calculator, line by line', () => {
    for (const line of ['createUnit("fathom3", "1.8288 m")', 'm = ones(1000, 1000)', 'f(x) = x^2', 'r = 1:1e9', 'sqrt = 2', `y = ${nested(60)}`, 'y = (x = 2)']) {
      expect(() => calculate(`x = 1\n${line}`), line).toThrow(LearningApiError)
    }
    expect(calculate('p = 101.3 kPa\nh = p / (1000 kg/m^3 * 9.81 m/s^2)', ['h']).values.h).toMatchObject({ unit: 'm' })
    expect(unitOf('fathom3')).toBeUndefined()
  })

  it('cannot change either instance even past the syntax-tree check', () => {
    for (const run of [
      () => parseExpression('createUnit("fathom4", "1.8288 m")').compile().evaluate(),
      () => parse('createUnit("fathom4", "1.8288 m")').compile().evaluate(),
      () => parse('import({ pi: 3 }, { override: true })').compile().evaluate(),
      () => parse('evaluate("1+1")').compile().evaluate(),
    ]) expect(run).toThrow('已关闭')
    expect(unitOf('fathom4')).toBeUndefined()
    expect(parse('pi').compile().evaluate()).toBeCloseTo(Math.PI)
  })
})
