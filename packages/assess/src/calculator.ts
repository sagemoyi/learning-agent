// The restricted calculator (docs/assess/design.md, A): assignments with units, one per line, and
// nothing else. Every line is parsed and its syntax tree checked before anything runs: no function
// definitions, matrices, ranges, property access or calls outside a short list of maths functions,
// so a script can neither reach mathjs' own `import`/`evaluate` nor build something that never ends.
import type { MathNode } from 'mathjs'
import { LearningApiError, type CalculationResult } from '@learning-agent/contracts'
import { math, normalizeUnit } from './units.ts'

const MAX_LENGTH = 4000
const MAX_LINES = 80

const FUNCTIONS = new Set([
  'sqrt', 'cbrt', 'exp', 'log', 'log10', 'log2', 'pow', 'abs', 'min', 'max', 'round', 'floor', 'ceil',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'number',
])
const NODES = new Set(['ConstantNode', 'SymbolNode', 'OperatorNode', 'ParenthesisNode', 'FunctionNode', 'AssignmentNode'])

/** Why a line is refused, or undefined when every node is allowed. */
function refusal(root: MathNode): string | undefined {
  let reason: string | undefined
  root.traverse((node, _path, parent) => {
    if (reason) return
    if (!NODES.has(node.type)) {
      reason = node.type === 'FunctionAssignmentNode' ? '不能定义函数' : `不支持这种写法（${node.type}）`
      return
    }
    if (node.type === 'FunctionNode') {
      const name = (node as unknown as { fn: MathNode }).fn
      const fn = name.type === 'SymbolNode' ? (name as unknown as { name: string }).name : ''
      if (!FUNCTIONS.has(fn)) reason = `不能调用 ${fn || '这个函数'}，只能用 ${[...FUNCTIONS].join('、')}`
    }
    if (node.type === 'AssignmentNode') {
      const target = (node as unknown as { object: MathNode; index?: unknown }).object
      if (target.type !== 'SymbolNode' || (node as unknown as { index?: unknown }).index) reason = '只能给变量赋值'
      if (parent) reason = '赋值只能写在一行的开头'
    }
  })
  return reason
}

/** A value as the calculator prints it: six significant digits, units in their written form. */
export function formatValue(value: unknown): string {
  if (typeof value === 'number') return Number(value.toPrecision(6)).toString()
  return math.format(value as never, { precision: 6 })
}

/** Script text people write (× · ², ℃) → mathjs syntax, line by line. */
function scriptLines(script: string): { number: number; text: string }[] {
  return script.split(/\r?\n|；|;/).map((line, index) => ({
    number: index + 1,
    text: line.replace(/(?:#|\/\/).*$/, '').replace(/[×·⋅]/g, '*').replace(/℃|°C/g, 'degC').replace(/[²³]/g, char => (char === '²' ? '^2' : '^3')).trim(),
  })).filter(line => line.text)
}

export function calculate(script: string, results: readonly string[] = []): CalculationResult {
  if (script.length > MAX_LENGTH) throw new LearningApiError('learning/assess/calculation', `计算过程太长（${script.length} 字），上限 ${MAX_LENGTH} 字`)
  const lines = scriptLines(script)
  if (lines.length === 0) throw new LearningApiError('learning/assess/calculation', '计算过程是空的：每行写一个赋值，例如 rho = p * M / (R * T)')
  if (lines.length > MAX_LINES) throw new LearningApiError('learning/assess/calculation', `计算过程超过 ${MAX_LINES} 行`)
  const scope = new Map<string, unknown>()
  const printed: string[] = []
  for (const line of lines) {
    let node: MathNode
    try {
      node = math.parse(line.text)
    } catch (error) {
      throw new LearningApiError('learning/assess/calculation', `第 ${line.number} 行写法不对：${(error as Error).message}`)
    }
    const refused = refusal(node)
    if (refused) throw new LearningApiError('learning/assess/calculation', `第 ${line.number} 行：${refused}`)
    let value: unknown
    try {
      value = node.compile().evaluate(scope)
    } catch (error) {
      throw new LearningApiError('learning/assess/calculation', `第 ${line.number} 行算不出来：${(error as Error).message}`)
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw new LearningApiError('learning/assess/calculation', `第 ${line.number} 行的结果不是有限的数`)
    printed.push(`${line.text} → ${formatValue(value)}`)
  }
  const values: Record<string, { value: number; unit: string; text: string }> = {}
  for (const name of results) {
    if (!scope.has(name)) throw new LearningApiError('learning/assess/calculation', `计算过程里没有变量 ${name}`)
    const value = scope.get(name)
    if (typeof value === 'number') values[name] = { value, unit: '', text: formatValue(value) }
    else if (value && typeof value === 'object' && 'toNumber' in value) {
      // Units multiply as written (Pa g mol K / mol J K); simplify them to what they amount to (kg/m^3).
      const unit = (value as unknown as { simplify(): { formatUnits(): string; toNumber(unit: string): number } }).simplify()
      const units = unit.formatUnits()
      values[name] = { value: unit.toNumber(units), unit: units, text: formatValue(value) }
    } else throw new LearningApiError('learning/assess/calculation', `变量 ${name} 不是数值`)
  }
  return { lines: printed, values }
}

/** A calculated value expressed in `unit` (the answer's unit), or undefined when the dimensions differ. */
export function inUnit(value: { value: number; unit: string }, unit: string): number | undefined {
  if (!value.unit) return unit.trim() ? undefined : value.value
  if (!unit.trim()) return undefined
  try {
    const quantity = math.unit(value.value, value.unit)
    const target = normalizeUnit(unit)
    if (!quantity.equalBase(math.unit(1, target))) return undefined
    return quantity.toNumber(target)
  } catch {
    return undefined
  }
}
