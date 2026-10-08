// Rule grading: numeric, choice and (when equivalence can be shown) expression answers are checked by
// program, never by the model (docs/PLAN.md, model strategy). Numeric answers are read from the answer
// box, so the working above it never supplies the number; units are converted before comparing.
import type { Answer, AnswerInput, Grading, SingleAnswer, Verdict } from '@learning-agent/contracts'
import { convert, math, normalizeUnit, prettyUnit, splitQuantity, unitOf } from './units.ts'

/** The first number in a free-text answer (answers submitted before there was an answer box). */
export function parseNumber(text: string): number | undefined {
  for (const line of text.split(/\n/)) {
    const value = splitQuantity(line).value
    if (value !== undefined) return value
  }
  const match = /([-+]?\d+(?:\.\d+)?|[-+]?\.\d+)/.exec(text)
  return match ? Number(match[1]) : undefined
}

/** Choice letters (`A`, `B、C`, `ac`) → option indices. */
export function parseChoices(text: string): number[] {
  const letters = text.toUpperCase().match(/[A-H]/g) ?? []
  return [...new Set(letters.map(letter => letter.charCodeAt(0) - 65))].sort((a, b) => a - b)
}

/** Part-level result before it becomes a Grading. */
type Judged = { verdict: Verdict; score: number; rationale: string }

function judgeNumeric(answer: Extract<SingleAnswer, { kind: 'numeric' }>, final: string): Judged {
  const given = splitQuantity(final)
  if (given.value === undefined) return { verdict: 'incorrect', score: 0, rationale: '答案栏里没有数值' }
  const reference = answer.unit.trim()
  const shown = reference ? ` ${prettyUnit(reference)}` : ''
  const { relative, absolute } = answer.tolerance
  const allowed = Math.max(absolute ?? 0, Math.abs(answer.value) * (relative ?? (absolute === undefined ? 0.02 : 0)))
  const within = (value: number) => Math.abs(value - answer.value) <= allowed
  const expected = `参考答案 ${answer.value}${shown}（允许误差 ±${Number(allowed.toPrecision(3))}${shown}）`
  const referenceUnit = reference ? unitOf(reference) : undefined
  // The book's unit is not one the converter knows (kg 水/kg 滤饼, 块) or there is none: compare numbers.
  if (!referenceUnit) {
    const ok = within(given.value)
    return { verdict: ok ? 'correct' : 'incorrect', score: ok ? 1 : 0, rationale: `你的数值 ${given.value}，${expected}` }
  }
  if (!given.unit) {
    return within(given.value)
      ? { verdict: 'partial', score: 0.5, rationale: `数值对，但没写单位（应为 ${prettyUnit(reference)}）。${expected}` }
      : { verdict: 'incorrect', score: 0, rationale: `你的数值 ${given.value}，没写单位；${expected}` }
  }
  if (!unitOf(given.unit)) {
    return within(given.value)
      ? { verdict: 'partial', score: 0.5, rationale: `没认出单位"${given.unit}"，按 ${prettyUnit(reference)} 比较数值是对的。${expected}` }
      : { verdict: 'incorrect', score: 0, rationale: `没认出单位"${given.unit}"；你的数值 ${given.value}，${expected}` }
  }
  const converted = convert(given.value, given.unit, reference)
  if (converted === undefined) return { verdict: 'incorrect', score: 0, rationale: `单位的量纲不对：你写的是 ${prettyUnit(normalizeUnit(given.unit))}，应为 ${prettyUnit(reference)}` }
  const ok = within(converted)
  const same = normalizeUnit(given.unit) === normalizeUnit(reference)
  return {
    verdict: ok ? 'correct' : 'incorrect',
    score: ok ? 1 : 0,
    rationale: `你的答案 ${given.value} ${prettyUnit(normalizeUnit(given.unit))}${same ? '' : `，换算为 ${Number(converted.toPrecision(4))}${shown}`}；${expected}`,
  }
}

function judgeChoice(answer: Extract<SingleAnswer, { kind: 'choice' }>, final: string): Judged {
  const given = parseChoices(final)
  const correct = [...answer.correct].sort((a, b) => a - b)
  const ok = given.length === correct.length && given.every((value, index) => value === correct[index])
  const letters = (indices: readonly number[]) => indices.map(index => String.fromCharCode(65 + index)).join('')
  return { verdict: ok ? 'correct' : 'incorrect', score: ok ? 1 : 0, rationale: `你选 ${letters(given) || '（未选）'}，正确答案 ${letters(correct)}` }
}

/** LaTeX and textbook notation → mathjs syntax, for equivalence checks. */
function expressionText(text: string): string {
  let body = text.replace(/\$/g, '').trim()
  body = body.split(/=/).at(-1) ?? body
  for (let i = 0; i < 4; i++) body = body.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '(($1)/($2))').replace(/\\sqrt\s*\{([^{}]*)\}/g, 'sqrt($1)')
  const greek: Record<string, string> = { ρ: 'rho', μ: 'mu', λ: 'lambda', Δ: 'Delta', α: 'alpha', β: 'beta', ζ: 'zeta', ξ: 'xi', η: 'eta', ν: 'nu', π: 'pi', θ: 'theta', τ: 'tau', ε: 'epsilon', σ: 'sigma', φ: 'phi', ω: 'omega' }
  return body
    .replace(/\\(rho|mu|lambda|Delta|alpha|beta|zeta|xi|eta|nu|pi|theta|tau|epsilon|varepsilon|sigma|phi|omega)\b/g, (_m, name: string) => (name === 'varepsilon' ? 'epsilon' : name))
    .replace(/[ρμλΔαβζξηνπθτεσφω]/g, char => greek[char] ?? char)
    .replace(/\\(?:cdot|times)|[×·]/g, '*')
    .replace(/\\left|\\right|\\,|\\;/g, '')
    .replace(/[{]/g, '(').replace(/[}]/g, ')')
    .replace(/²/g, '^2').replace(/³/g, '^3')
    .trim()
}

/** True when the two expressions agree at several random points; undefined when either cannot be read. */
export function equivalent(given: string, reference: string): boolean | undefined {
  try {
    const a = math.parse(expressionText(given))
    const b = math.parse(expressionText(reference))
    const symbols = new Set<string>()
    for (const node of [a, b]) node.traverse((child, _path, parent) => {
      const name = (child as unknown as { name?: string }).name
      if (child.type === 'SymbolNode' && name && !(parent?.type === 'FunctionNode' && (parent as unknown as { fn: unknown }).fn === child) && !['pi', 'e'].includes(name)) symbols.add(name)
    })
    const [fa, fb] = [a.compile(), b.compile()]
    // Points where either side is not a real number (a square root of a negative) say nothing.
    let compared = 0
    for (let trial = 0; trial < 40 && compared < 6; trial++) {
      const scope = Object.fromEntries([...symbols].map(name => [name, 0.5 + Math.random() * 1.5]))
      const [x, y] = [fa.evaluate(scope), fb.evaluate(scope)]
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue
      if (Math.abs(x - y) > 1e-6 * Math.max(1, Math.abs(x), Math.abs(y))) return false
      compared++
    }
    return compared >= 3 ? true : undefined
  } catch {
    return undefined
  }
}

/** One part by rule, or undefined when it needs the model (open answers, expressions not shown equal). */
export function judgeByRule(answer: SingleAnswer, final: string): Judged | undefined {
  if (answer.kind === 'numeric') return judgeNumeric(answer, final)
  if (answer.kind === 'choice') return judgeChoice(answer, final)
  if (answer.kind === 'expression' && final.trim() && equivalent(final, answer.value) === true) {
    return { verdict: 'correct', score: 1, rationale: '代入几组数值，和参考表达式相等' }
  }
  return undefined
}

/** One answer by rule as a grading, or undefined when it needs the model. */
export function gradeByRule(answer: SingleAnswer, final: string): Grading | undefined {
  const judged = judgeByRule(answer, final)
  return judged && { ...judged, method: 'rule', confidence: 'high' }
}

/** The answer boxes of a problem: one per part. */
export function answerParts(answer: Answer): { label: string; answer: SingleAnswer }[] {
  return answer.kind === 'parts' ? answer.parts : [{ label: '', answer }]
}

export function inputsOf(answer: Answer): AnswerInput[] {
  return answerParts(answer).map(part => ({ label: part.label, kind: part.answer.kind, ...(part.answer.kind === 'choice' ? { options: part.answer.options } : {}) }))
}

/** Several parts → one grading: right only when every part is right; pending when a part is. */
export function combine(parts: readonly ({ label: string } & Judged & { method: Grading['method']; confidence?: Grading['confidence'] })[]): Grading {
  if (parts.length === 1 && !parts[0]!.label) {
    const [only] = parts
    return { verdict: only!.verdict, score: only!.score, method: only!.method, ...(only!.confidence ? { confidence: only!.confidence } : {}), rationale: only!.rationale }
  }
  const verdicts = parts.map(part => part.verdict)
  const verdict: Verdict = verdicts.includes('pending-review') ? 'pending-review'
    : verdicts.every(item => item === 'correct') ? 'correct'
      : verdicts.every(item => item === 'incorrect') ? 'incorrect' : 'partial'
  const score = parts.reduce((sum, part) => sum + part.score, 0) / parts.length
  const methods = new Set(parts.map(part => part.method))
  const confidences = parts.flatMap(part => (part.confidence ? [part.confidence] : []))
  const lowest = (['low', 'medium', 'high'] as const).find(level => confidences.includes(level))
  return {
    verdict,
    score,
    method: methods.has('llm') ? 'llm' : 'rule',
    ...(lowest ? { confidence: lowest } : { confidence: 'high' }),
    rationale: parts.map(part => `${part.label} ${part.rationale}`.trim()).join('\n\n'),
    parts: parts.map(part => ({ label: part.label, verdict: part.verdict, score: part.score, rationale: part.rationale })),
  }
}

/** A rubric's points: one per line, without bullets or numbering ("- ", "1.", "（1）", "①"). */
export function rubricPoints(rubric: string): string[] {
  return rubric.split(/\r?\n/)
    .map(line => line.trim().replace(/^(?:[-*•·]|\d+[.、)）]|[（(]\d+[）)]|[①-⑳])\s*/, '').trim())
    .filter(Boolean)
}

/** The reference answer as text (shown after grading, and given to the model grader). */
export function answerText(answer: Answer): string {
  switch (answer.kind) {
    case 'numeric': return `${answer.value}${answer.unit ? ` ${prettyUnit(answer.unit)}` : ''}`
    case 'choice': return answer.correct.map(index => `${String.fromCharCode(65 + index)}. ${answer.options[index] ?? ''}`).join('；')
    case 'expression': return answer.value
    case 'open': return answer.rubric
    case 'parts': return answer.parts.map(part => `${part.label} ${answerText(part.answer)}`).join('；')
  }
}
