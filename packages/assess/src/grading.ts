// Rule grading: numeric, choice and (when equivalence can be shown) expression answers are checked by
// program, never by the model (packages/AGENTS.md, 调用模型). Numeric answers are read from the answer
// box, so the working above it never supplies the number; units are converted before comparing. Where the
// program cannot show an answer right it says "待复核" rather than "对" (docs/assess/design.md, 判分).
import type { Answer, AnswerInput, Grading, PartialReason, SingleAnswer, Verdict } from '@learning-agent/contracts'
import { equivalence } from './equivalence.ts'
import { convert, normalizeUnit, prettyUnit, splitQuantity, unitOf } from './units.ts'

/** Choice letters (`A`, `B、C`, `ac`) → option indices. */
export function parseChoices(text: string): number[] {
  const letters = text.toUpperCase().match(/[A-H]/g) ?? []
  return [...new Set(letters.map(letter => letter.charCodeAt(0) - 65))].sort((a, b) => a - b)
}

/** Part-level result before it becomes a Grading. */
type Judged = { verdict: Verdict; score: number; rationale: string; partial?: PartialReason }

const pending = (rationale: string): Judged => ({ verdict: 'pending-review', score: 0, rationale })

/**
 * A unit without dimension and its factor to a plain number: none, a share (`%` is 0.01), `ppm`, "比例", or counting
 * words (块、台); undefined for any other unit.
 */
function dimensionless(unit: string): number | undefined {
  const text = unit.trim()
  if (text === '%' || text === '％') return 0.01
  if (text === '‰') return 0.001
  if (/^ppm$/i.test(text)) return 1e-6
  if (text === '比例') return 1
  return normalizeUnit(text) === '' ? 1 : undefined
}

/** More arithmetic after the number ("+100", "* 2", "/3", "= 5"): the box holds no single value. */
const ARITHMETIC = /^[+\-*/×÷=]|[+×÷=]\s*[\d.]/

/** The same unit written alike: textbook units the converter does not know are compared as text. */
const sameUnit = (a: string, b: string) => normalizeUnit(a).replace(/\s+/g, '') === normalizeUnit(b).replace(/\s+/g, '')

/**
 * The whole answer box is read: the number, then only a unit or a counting word. A reference without dimension (none,
 * `%`, `ppm`) takes shares as ratios and refuses units; a unit the converter knows is converted; one it does not know
 * (kg 水/kg 滤饼) must be written the same. What the program cannot read waits for the teacher.
 */
function judgeNumeric(answer: Extract<SingleAnswer, { kind: 'numeric' }>, final: string): Judged {
  const given = splitQuantity(final)
  if (given.value === undefined) return { verdict: 'incorrect', score: 0, rationale: '答案栏里没有数值' }
  const rest = given.unit.replace(/[。．，,；;！!]+$/, '').replace(/^[(（[]\s*(.*?)\s*[)）\]]$/, '$1').trim()
  const reference = answer.unit.trim()
  const shown = reference ? ` ${prettyUnit(reference)}` : ''
  const { relative, absolute } = answer.tolerance
  const allowed = Math.max(absolute ?? 0, Math.abs(answer.value) * (relative ?? (absolute === undefined ? 0.02 : 0)))
  const within = (value: number) => Math.abs(value - answer.value) <= allowed
  const expected = `参考答案 ${answer.value}${shown}（允许误差 ±${Number(allowed.toPrecision(3))}${shown}）`
  const judged = (ok: boolean, rationale: string): Judged => ({ verdict: ok ? 'correct' : 'incorrect', score: ok ? 1 : 0, rationale })
  const unitOnly = (rationale: string): Judged => ({ verdict: 'partial', score: 0.5, rationale, partial: 'unit' })
  if (ARITHMETIC.test(rest)) return pending(`答案栏里不只一个数（"${final.trim()}"），程序没法确定你的最后结果，等老师看。${expected}`)

  const share = dimensionless(reference)
  const factor = dimensionless(rest)
  if (share !== undefined) {
    if (factor === undefined) {
      return unitOf(rest) ? judged(false, `参考答案没有量纲，你写了单位 ${rest}。${expected}`) : pending(`没认出"${rest}"，等老师看。${expected}`)
    }
    const value = given.value * factor / share
    if (within(value)) return judged(true, `你的答案 ${given.value}${rest ? ` ${rest}` : ''}；${expected}`)
    // 20 for 20 %: the number of the share without its sign.
    if (!rest && share !== 1 && within(given.value)) return unitOnly(`数值对，但没写 ${reference}。${expected}`)
    return judged(false, `你的答案 ${given.value}${rest ? ` ${rest}` : ''}；${expected}`)
  }
  if (!rest) {
    return within(given.value) ? unitOnly(`数值对，但没写单位（应为 ${prettyUnit(reference)}）。${expected}`) : judged(false, `你的数值 ${given.value}，没写单位；${expected}`)
  }
  // A unit the converter does not know: the answer has to write the same one.
  if (!unitOf(reference)) {
    return sameUnit(rest, reference) ? judged(within(given.value), `你的答案 ${given.value} ${rest}；${expected}`)
      : pending(`你写的单位"${rest}"和参考答案的"${reference}"写法不同，程序没法换算，等老师看。${expected}`)
  }
  if (factor !== undefined) return judged(false, `单位的量纲不对：你写的是 ${rest}，应为 ${prettyUnit(reference)}`)
  if (!unitOf(rest)) return pending(`没认出单位"${rest}"，等老师看。${expected}`)
  const converted = convert(given.value, rest, reference)
  if (converted === undefined) return judged(false, `单位的量纲不对：你写的是 ${prettyUnit(normalizeUnit(rest))}，应为 ${prettyUnit(reference)}`)
  const same = normalizeUnit(rest) === normalizeUnit(reference)
  return judged(within(converted), `你的答案 ${given.value} ${prettyUnit(normalizeUnit(rest))}${same ? '' : `，换算为 ${Number(converted.toPrecision(4))}${shown}`}；${expected}`)
}

function judgeChoice(answer: Extract<SingleAnswer, { kind: 'choice' }>, final: string): Judged {
  const given = parseChoices(final)
  const correct = [...answer.correct].sort((a, b) => a - b)
  const ok = given.length === correct.length && given.every((value, index) => value === correct[index])
  const letters = (indices: readonly number[]) => indices.map(index => String.fromCharCode(65 + index)).join('')
  return { verdict: ok ? 'correct' : 'incorrect', score: ok ? 1 : 0, rationale: `你选 ${letters(given) || '（未选）'}，正确答案 ${letters(correct)}` }
}

const short = (value: number) => Number(value.toPrecision(4))

/** Shown equal or different by the program; undefined leaves it to the model (equivalence.ts). */
function judgeExpression(answer: Extract<SingleAnswer, { kind: 'expression' }>, final: string): Judged | undefined {
  const found = equivalence(final, answer.value, answer.domain)
  if (found.kind === 'different') {
    const at = Object.entries(found.at).map(([name, value]) => `${name} = ${short(value)}`).join('、')
    return { verdict: 'incorrect', score: 0, rationale: `代入 ${at || '数值'} 时，你的式子等于 ${short(found.given)}，参考答案等于 ${short(found.reference)}` }
  }
  if (found.kind === 'equal') {
    const why = found.by === 'form' ? '和参考表达式只是写法或顺序不同' : found.by === 'rational' ? `两边都是有理式，代入 ${found.points} 组数值都相等` : `在题目给的范围（${answer.domain}）内代入 ${found.points} 组数值都相等`
    return { verdict: 'correct', score: 1, rationale: why }
  }
  return undefined
}

/** One part by rule, or undefined when it needs the model (open answers, expressions not shown equal or different). */
export function judgeByRule(answer: SingleAnswer, final: string): Judged | undefined {
  if (answer.kind === 'numeric') return judgeNumeric(answer, final)
  if (answer.kind === 'choice') return judgeChoice(answer, final)
  if (answer.kind === 'expression' && final.trim()) return judgeExpression(answer, final)
  return undefined
}

/** The answer boxes of a problem: one per part. */
export function answerParts(answer: Answer): { label: string; answer: SingleAnswer }[] {
  return answer.kind === 'parts' ? answer.parts : [{ label: '', answer }]
}

export function inputsOf(answer: Answer): AnswerInput[] {
  return answerParts(answer).map(part => ({ label: part.label, kind: part.answer.kind, ...(part.answer.kind === 'choice' ? { options: part.answer.options } : {}) }))
}

/**
 * Several parts → one grading: right only when every part is right; pending when a part is. Partly right says why:
 * only units missing, or a part wrong.
 */
export function combine(parts: readonly ({ label: string } & Judged & { method: Grading['method']; confidence?: Grading['confidence'] })[]): Grading {
  if (parts.length === 1 && !parts[0]!.label) {
    const [only] = parts
    return { verdict: only!.verdict, score: only!.score, method: only!.method, ...(only!.confidence ? { confidence: only!.confidence } : {}), rationale: only!.rationale, ...(only!.verdict === 'partial' && only!.partial ? { partial: only!.partial } : {}) }
  }
  const verdicts = parts.map(part => part.verdict)
  const verdict: Verdict = verdicts.includes('pending-review') ? 'pending-review'
    : verdicts.every(item => item === 'correct') ? 'correct'
      : verdicts.every(item => item === 'incorrect') ? 'incorrect' : 'partial'
  const score = parts.reduce((sum, part) => sum + part.score, 0) / parts.length
  const methods = new Set(parts.map(part => part.method))
  const confidences = parts.flatMap(part => (part.confidence ? [part.confidence] : []))
  const lowest = (['low', 'medium', 'high'] as const).find(level => confidences.includes(level))
  const unitsOnly = parts.every(part => part.verdict === 'correct' || part.partial === 'unit')
  return {
    verdict,
    score,
    method: methods.has('llm') ? 'llm' : 'rule',
    ...(lowest ? { confidence: lowest } : { confidence: 'high' }),
    rationale: parts.map(part => `${part.label} ${part.rationale}`.trim()).join('\n\n'),
    ...(verdict === 'partial' ? { partial: unitsOnly ? 'unit' as const : 'part' as const } : {}),
    parts: parts.map(part => ({ label: part.label, verdict: part.verdict, score: part.score, rationale: part.rationale, ...(part.verdict === 'partial' && part.partial ? { partial: part.partial } : {}) })),
  }
}

/** A grading, or one part of it (which has no method of its own). */
type Graded = Pick<Grading, 'verdict' | 'partial'> & Partial<Pick<Grading, 'method' | 'parts'>>

/**
 * Why a grading is partly right. Gradings from before the reason was kept: a rule's is a missing unit, a model's is
 * steps or points, and several parts' is a part.
 */
export function partialOf(grading: Graded): PartialReason | undefined {
  if (grading.verdict !== 'partial') return undefined
  return grading.partial ?? (grading.parts?.length ? 'part' : grading.method === 'rule' ? 'unit' : grading.method ? 'steps' : undefined)
}

/** Whether a grading shows the method known: right, or right but for the unit (docs/assess/design.md, 摸底和前测). */
export function knowsMethod(grading: Graded): boolean {
  return grading.verdict === 'correct' || partialOf(grading) === 'unit'
}

export const VERDICT_LABEL = { correct: '对', partial: '部分对', incorrect: '错', 'pending-review': '待复核' } as const
const PARTIAL_LABEL: Record<PartialReason, string> = { unit: '只差单位', part: '有一问不对', steps: '步骤或要点不全' }

/** A grading in words: "部分对" says why ("部分对（只差单位）"); none yet is "待复核". */
export function verdictLabel(grading: Graded | undefined): string {
  const reason = grading && partialOf(grading)
  return `${VERDICT_LABEL[grading?.verdict ?? 'pending-review']}${reason ? `（${PARTIAL_LABEL[reason]}）` : ''}`
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
    case 'expression': return `${answer.value}${answer.domain ? `（${answer.domain}）` : ''}`
    case 'open': return answer.rubric
    case 'parts': return answer.parts.map(part => `${part.label} ${answerText(part.answer)}`).join('；')
  }
}
