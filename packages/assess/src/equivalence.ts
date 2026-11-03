// Expression answers (docs/assess/design.md, 判分): equal or not, by their values at sample points over negatives, zero,
// small and large numbers. Points only ever find a difference. Agreeing wherever they look shows equality for rational
// expressions (two different rational functions agree at random points with probability zero) and, for the rest, only
// within ranges the problem declares for every variable, as WeBWorK grades formulas; anything else is left to the
// grader model. The points come from the texts, so the same answer is always graded the same.
import type { MathNode } from 'mathjs'
import { parseExpression, refusal, variablesOf } from './expression.ts'

/** LaTeX and textbook notation → mathjs syntax. */
export function expressionText(text: string): string {
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

/** Where a variable may lie; an absent end is unbounded. */
export interface Range {
  readonly min?: number
  readonly max?: number
  readonly minOpen?: boolean
  readonly maxOpen?: boolean
}

const COMPARE = /(<=|>=|≤|≥|⩽|⩾|<|>)/

/** `x > 0, 0 ≤ y ≤ 1` (also with ；、和 or 且) → each variable's range; throws on a condition it cannot read. */
export function parseDomain(text: string): Map<string, Range> {
  const ranges = new Map<string, Range>()
  const number = (part: string) => {
    const value = Number(part.trim().replace(/[−–]/g, '-'))
    return part.trim() && Number.isFinite(value) ? value : undefined
  }
  const name = (part: string) => {
    const symbol = expressionText(part)
    return /^[A-Za-z_]\w*$/.test(symbol) ? symbol : undefined
  }
  const narrow = (variable: string, bound: Range) => {
    const current = ranges.get(variable) ?? {}
    ranges.set(variable, {
      ...current,
      ...(bound.min !== undefined && (current.min === undefined || bound.min >= current.min) ? { min: bound.min, minOpen: bound.minOpen } : {}),
      ...(bound.max !== undefined && (current.max === undefined || bound.max <= current.max) ? { max: bound.max, maxOpen: bound.maxOpen } : {}),
    })
  }
  for (const condition of text.split(/[,，;；、]|且|和|\band\b/).map(item => item.trim()).filter(Boolean)) {
    const parts = condition.split(COMPARE).map(part => part.trim())
    const below = (op: string) => op === '<' || op === '<=' || op === '≤' || op === '⩽'
    const open = (op: string) => op === '<' || op === '>'
    if (parts.length === 3) {
      const [left, op, right] = parts as [string, string, string]
      const variable = name(left) ?? name(right)
      const bound = number(name(left) ? right : left)
      if (!variable || bound === undefined) throw new Error(`看不懂变量范围"${condition}"：写成 x > 0 或 0 ≤ x ≤ 1`)
      // `x < 3` and `3 > x` both bound x from above.
      const upper = below(op) === Boolean(name(left))
      narrow(variable, upper ? { max: bound, maxOpen: open(op) } : { min: bound, minOpen: open(op) })
    } else if (parts.length === 5 && below(parts[1]!) === below(parts[3]!)) {
      const [low, first, middle, second, high] = parts as [string, string, string, string, string]
      const variable = name(middle)
      const [a, b] = [number(low), number(high)]
      if (!variable || a === undefined || b === undefined) throw new Error(`看不懂变量范围"${condition}"：写成 0 ≤ x ≤ 1`)
      const ascending = below(first)
      narrow(variable, ascending ? { min: a, minOpen: open(first), max: b, maxOpen: open(second) } : { min: b, minOpen: open(second), max: a, maxOpen: open(first) })
    } else {
      throw new Error(`看不懂变量范围"${condition}"：写成 x > 0 或 0 ≤ x ≤ 1`)
    }
  }
  for (const [variable, range] of ranges) {
    if (range.min !== undefined && range.max !== undefined && (range.min > range.max || (range.min === range.max && (range.minOpen || range.maxOpen)))) {
      throw new Error(`变量 ${variable} 的范围是空的`)
    }
  }
  return ranges
}

/** Polynomials and their ratios: numbers, variables, + − × ÷ and whole-number powers. */
function rational(root: MathNode): boolean {
  const whole = (node: MathNode): boolean => {
    if (node.type === 'ParenthesisNode') return whole((node as unknown as { content: MathNode }).content)
    if (node.type === 'ConstantNode') return Number.isInteger((node as unknown as { value: unknown }).value)
    const { op, args } = node as unknown as { op?: string; args?: MathNode[] }
    return node.type === 'OperatorNode' && (op === '-' || op === '+') && args?.length === 1 && whole(args[0]!)
  }
  let ok = true
  root.traverse(node => {
    if (!ok || node.type === 'ConstantNode' || node.type === 'SymbolNode' || node.type === 'ParenthesisNode') return
    const { op, args } = node as unknown as { op?: string; args?: MathNode[] }
    ok = node.type === 'OperatorNode' && (['+', '-', '*', '/'].includes(op!) || (op === '^' && whole(args![1]!)))
  })
  return ok
}

/** The tree written out without parentheses, sums and products in a fixed order: the same text is the same expression. */
function canonical(node: MathNode): string {
  const { type } = node
  const inner = node as unknown as { content: MathNode; value: unknown; name: string; fn: MathNode; op: string; args: MathNode[] }
  if (type === 'ParenthesisNode') return canonical(inner.content)
  if (type === 'ConstantNode') return String(inner.value)
  if (type === 'SymbolNode') return inner.name
  if (type === 'FunctionNode') return `${canonical(inner.fn)}(${inner.args.map(canonical).join(',')})`
  if (type !== 'OperatorNode') return `?${type}`
  const { op, args } = inner
  if (args.length === 1) return `${op}(${canonical(args[0]!)})`
  if (op === '+' || op === '*') {
    const terms: string[] = []
    const gather = (child: MathNode): void => {
      const bare = child.type === 'ParenthesisNode' ? (child as unknown as { content: MathNode }).content : child
      if (bare.type === 'OperatorNode' && (bare as unknown as { op: string }).op === op && (bare as unknown as { args: MathNode[] }).args.length === 2) (bare as unknown as { args: MathNode[] }).args.forEach(gather)
      else terms.push(canonical(bare))
    }
    args.forEach(gather)
    return `${op}[${terms.sort().join(',')}]`
  }
  return `(${canonical(args[0]!)}${op}${canonical(args[1]!)})`
}

/** `gh` as g, h when those are the reference's variables: letters side by side are a product, as in print. */
function spelled(name: string, known: readonly string[]): string[] | undefined {
  if (!name) return []
  for (const head of known.filter(item => name.startsWith(item)).sort((x, y) => y.length - x.length)) {
    const rest = spelled(name.slice(head.length), known)
    if (rest) return [head, ...rest]
  }
  return undefined
}

/** The answer with each variable the reference lacks, but which spells several of its variables, written as their product. */
function asProducts(answer: MathNode, reference: MathNode): MathNode {
  const known = [...variablesOf(reference)]
  return answer.transform((node, _path, parent) => {
    const name = (node as unknown as { name?: string }).name
    const called = parent?.type === 'FunctionNode' && (parent as unknown as { fn: unknown }).fn === node
    if (node.type !== 'SymbolNode' || !name || called || known.includes(name)) return node
    const parts = spelled(name, known)
    return parts && parts.length > 1 ? parseExpression(`(${parts.join('*')})`) : node
  })
}

/** A small seeded generator (mulberry32). */
function generator(text: string): () => number {
  let seed = 2166136261
  for (const char of text) seed = Math.imul(seed ^ char.codePointAt(0)!, 16777619)
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Each trial's size of numbers; the variables of one trial stay within a factor of three, so sums do not cancel to noise. */
const SCALES = [1e-3, 0.05, 0.37, 1.3, 4.1, 29, 1e3, 1e6]

function pick(range: Range | undefined, scale: number, random: () => number): number {
  const size = scale * (0.5 + random())
  const { min, max } = range ?? {}
  if (min !== undefined && max !== undefined) {
    // Near either end as often as inside: where a piecewise answer would differ.
    const u = random()
    const t = u < 0.25 ? random() ** 4 : u < 0.5 ? 1 - random() ** 4 : random()
    const value = min + (max - min) * t
    return (value === min && range!.minOpen) || (value === max && range!.maxOpen) ? (min + max) / 2 : value
  }
  if (min !== undefined) return random() < 0.1 && !range!.minOpen ? min : min + size
  if (max !== undefined) return random() < 0.1 && !range!.maxOpen ? max : max - size
  return random() < 0.08 ? 0 : random() < 0.5 ? -size : size
}

export type Equivalence =
  | { readonly kind: 'equal'; readonly points: number; readonly by: 'form' | 'rational' | 'domain' }
  | { readonly kind: 'different'; readonly at: Readonly<Record<string, number>>; readonly given: number; readonly reference: number }
  | { readonly kind: 'unknown' }

/** Whether the learner's expression equals the reference, within the problem's `domain` when it declares one. */
export function equivalence(given: string, reference: string, domain?: string): Equivalence {
  let a: MathNode, b: MathNode, ranges: Map<string, Range>
  try {
    a = parseExpression(expressionText(given))
    b = parseExpression(expressionText(reference))
    ranges = domain?.trim() ? parseDomain(domain) : new Map()
  } catch {
    return { kind: 'unknown' }
  }
  if (refusal(a) || refusal(b)) return { kind: 'unknown' }
  a = asProducts(a, b)
  // Written in another order or notation only (LaTeX, implicit products).
  if (canonical(a) === canonical(b)) return { kind: 'equal', points: 0, by: 'form' }
  const names = [...new Set([...variablesOf(a), ...variablesOf(b)])].sort()
  const [fa, fb] = [a.compile(), b.compile()]
  const random = generator(`${given}\n${reference}\n${domain ?? ''}`)
  const differences: { at: Record<string, number>; given: number; reference: number }[] = []
  let compared = 0
  for (let trial = 0; trial < 160 && compared < 24; trial++) {
    const at = Object.fromEntries(names.map(name => [name, pick(ranges.get(name), SCALES[trial % SCALES.length]!, random)]))
    let x: unknown, y: unknown
    try {
      [x, y] = [fa.evaluate({ ...at }), fb.evaluate({ ...at })]
    } catch {
      continue
    }
    // Where either side is not a real number (a root of a negative, a pole) says nothing.
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue
    compared++
    if (Math.abs(x - y) > 1e-6 * Math.max(Math.abs(x), Math.abs(y)) + 1e-12) differences.push({ at, given: x, reference: y })
  }
  // Two points, so one rounding slip does not decide it.
  if (differences.length >= 2) return { kind: 'different', ...differences[0]! }
  if (differences.length > 0 || compared < 8) return { kind: 'unknown' }
  if (rational(a) && rational(b)) return { kind: 'equal', points: compared, by: 'rational' }
  if (names.every(name => ranges.has(name))) return { kind: 'equal', points: compared, by: 'domain' }
  return { kind: 'unknown' }
}
