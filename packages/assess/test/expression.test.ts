// assess (docs/assess/design.md, 判分): what a learner, a book or the teacher writes as an expression is checked before
// it runs, in grading and in the calculator alike; nothing written can redefine units or tie up the service.
import { describe, expect, it } from 'vitest'
import { LearningApiError } from '@learning-agent/contracts'
import { calculate } from '../src/calculator.ts'
import { parseExpression } from '../src/expression.ts'
import { equivalent, judgeByRule } from '../src/grading.ts'
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
      expect(equivalent(answer, 'x'), answer).toBeUndefined()
      expect(judgeByRule(expression, answer), answer).toBeUndefined()
    }
    expect(performance.now() - start).toBeLessThan(1000)
    // Grading reads what is right of the last "=", so a definition on the left is never parsed.
    expect(equivalent('f(x) = x^2', 'x^2')).toBe(true)
    expect(unitOf('fathom2')).toBeUndefined()
    expect(convert(1, 'at', 'kPa')).toBeCloseTo(98.0665)
  })

  it('still grades what textbooks write', () => {
    expect(equivalent('\\frac{\\rho g h}{2}', 'rho*g*h/2')).toBe(true)
    expect(equivalent('2x+3', 'x+x+3')).toBe(true)
    expect(equivalent('x+1', 'x')).toBe(false)
    expect(judgeByRule(expression, 'ρ g h')?.verdict).toBe('correct')
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
