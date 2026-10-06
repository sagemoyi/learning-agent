// Rule grading: numeric and choice answers are checked by program, never by the model (docs/PLAN.md, model strategy).
import type { Answer, Grading } from '@learning-agent/contracts'

const SUPERSCRIPT: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' }

/**
 * The first number in a free-text answer. Understands `1.2e-3`, `1.2×10^-3`, `1.2x10^{-3}`,
 * `1.2×10⁻³`, full-width minus, and thousands separators.
 */
export function parseNumber(text: string): number | undefined {
  const normalized = text
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, run => `^${[...run].map(char => SUPERSCRIPT[char]).join('')}`)
    .replace(/[−–—]/g, '-')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\s+/g, ' ')
  const match = /([-+]?\d+(?:\.\d+)?|[-+]?\.\d+)(?:\s*(?:[×xX*·]\s*10\s*\^?\s*\{?\s*([-+]?\d+)\s*\}?)|[eE]([-+]?\d+))?/.exec(normalized)
  if (!match) return undefined
  const mantissa = Number(match[1])
  const exponent = match[2] ?? match[3]
  const value = exponent === undefined ? mantissa : mantissa * 10 ** Number(exponent)
  return Number.isFinite(value) ? value : undefined
}

/** Choice letters (`A`, `B、C`, `ac`) → option indices. */
export function parseChoices(text: string): number[] {
  const letters = text.toUpperCase().match(/[A-H]/g) ?? []
  return [...new Set(letters.map(letter => letter.charCodeAt(0) - 65))].sort((a, b) => a - b)
}

/** Grade by rule, or return undefined when the answer kind needs a model (expression, open). */
export function gradeByRule(answer: Answer, text: string): Grading | undefined {
  if (answer.kind === 'numeric') {
    const given = parseNumber(text)
    if (given === undefined) return { verdict: 'incorrect', score: 0, method: 'rule', confidence: 'high', rationale: '答案里没有找到数值' }
    const { relative, absolute } = answer.tolerance
    const allowed = Math.max(absolute ?? 0, Math.abs(answer.value) * (relative ?? (absolute === undefined ? 0.02 : 0)))
    const ok = Math.abs(given - answer.value) <= allowed
    return {
      verdict: ok ? 'correct' : 'incorrect',
      score: ok ? 1 : 0,
      method: 'rule',
      confidence: 'high',
      rationale: `你的数值 ${given}，参考答案 ${answer.value}${answer.unit ? ` ${answer.unit}` : ''}（允许误差 ±${Number(allowed.toPrecision(3))}）`,
    }
  }
  if (answer.kind === 'choice') {
    const given = parseChoices(text)
    const correct = [...answer.correct].sort((a, b) => a - b)
    const ok = given.length === correct.length && given.every((value, index) => value === correct[index])
    const letters = (indices: readonly number[]) => indices.map(index => String.fromCharCode(65 + index)).join('')
    return { verdict: ok ? 'correct' : 'incorrect', score: ok ? 1 : 0, method: 'rule', confidence: 'high', rationale: `你选 ${letters(given) || '（未选）'}，正确答案 ${letters(correct)}` }
  }
  return undefined
}

/** The reference answer as text (shown after grading, and given to the model grader). */
export function answerText(answer: Answer): string {
  switch (answer.kind) {
    case 'numeric': return `${answer.value}${answer.unit ? ` ${answer.unit}` : ''}`
    case 'choice': return answer.correct.map(index => `${String.fromCharCode(65 + index)}. ${answer.options[index] ?? ''}`).join('；')
    case 'expression': return answer.value
    case 'open': return answer.rubric
  }
}
