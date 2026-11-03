// What an expression from a learner, a book or the teacher may do before it runs (docs/assess/design.md, 判分), shared by
// expression grading and the calculator: numbers, variables, operators and a short list of maths functions, within a
// size budget. Matrices, ranges, function definitions, property access and every other call are refused before
// anything is evaluated, so text can neither reach mathjs' own `createUnit`/`import`/`evaluate` nor build something
// that never ends.
import { all, create, type MathJsInstance, type MathNode } from 'mathjs'

export const FUNCTIONS: ReadonlySet<string> = new Set([
  'sqrt', 'cbrt', 'exp', 'log', 'log10', 'log2', 'pow', 'abs', 'min', 'max', 'round', 'floor', 'ceil',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'number',
])

const NODES = new Set(['ConstantNode', 'SymbolNode', 'OperatorNode', 'ParenthesisNode', 'FunctionNode'])

export interface Budget {
  /** Nodes in the syntax tree. */
  readonly nodes: number
  /** Nesting depth. */
  readonly depth: number
  /** Distinct variables. */
  readonly variables: number
}

/** Far beyond any textbook formula, small enough that checking and evaluating stay instant. */
export const BUDGET: Budget = { nodes: 400, depth: 40, variables: 20 }

/** The names an expression uses as variables (not as the function it calls), without `pi` and `e`. */
export function variablesOf(root: MathNode): Set<string> {
  const names = new Set<string>()
  root.traverse((node, _path, parent) => {
    const name = (node as unknown as { name?: string }).name
    const called = parent?.type === 'FunctionNode' && (parent as unknown as { fn: unknown }).fn === node
    if (node.type === 'SymbolNode' && name && !called && name !== 'pi' && name !== 'e') names.add(name)
  })
  return names
}

/**
 * Why `root` may not run, or undefined when it may. `assignment` lets it be `name = …` (a calculator line); the name
 * cannot be one of the functions, or a later call to it would run whatever was assigned.
 */
export function refusal(root: MathNode, { assignment = false, budget = BUDGET }: { readonly assignment?: boolean; readonly budget?: Budget } = {}): string | undefined {
  let nodes = 0
  let reason: string | undefined
  const visit = (node: MathNode, depth: number, top: boolean): void => {
    if (reason) return
    if (++nodes > budget.nodes) { reason = `式子太长（超过 ${budget.nodes} 个部分）`; return }
    if (depth > budget.depth) { reason = `括号或函数套得太深（超过 ${budget.depth} 层）`; return }
    if (node.type === 'AssignmentNode' && assignment) {
      const { object, index } = node as unknown as { object: MathNode; index?: unknown }
      const name = (object as unknown as { name?: string }).name ?? ''
      if (!top) reason = '赋值只能写在一行的开头'
      else if (object.type !== 'SymbolNode' || index) reason = '只能给变量赋值'
      else if (FUNCTIONS.has(name)) reason = `${name} 是函数名，不能当变量`
    } else if (!NODES.has(node.type)) {
      reason = node.type === 'FunctionAssignmentNode' ? '不能定义函数' : node.type === 'AssignmentNode' ? '这里不能赋值' : `不支持这种写法（${node.type}）`
    } else if (node.type === 'FunctionNode') {
      const fn = (node as unknown as { fn: MathNode }).fn
      const name = fn.type === 'SymbolNode' ? (fn as unknown as { name: string }).name : ''
      if (!FUNCTIONS.has(name)) reason = `不能调用 ${name || '这个函数'}，只能用 ${[...FUNCTIONS].join('、')}`
    }
    if (reason) return
    node.forEach(child => visit(child, depth + 1, false))
  }
  visit(root, 1, true)
  if (!reason && variablesOf(root).size > budget.variables) reason = `变量太多（超过 ${budget.variables} 个）`
  return reason
}

/** mathjs functions that change the instance or run text; turned off once an instance is set up. */
const RISKY = ['import', 'createUnit', 'evaluate', 'parse', 'compile', 'simplify', 'simplifyConstant', 'simplifyCore', 'derivative', 'resolve', 'rationalize', 'reviver', 'parser']

/**
 * Turn off the functions that change `instance` or run text, and give back its parser for our own use. Behind the
 * syntax-tree check: a call that slips past it still cannot redefine units or evaluate text.
 */
export function lockDown(instance: MathJsInstance): MathJsInstance['parse'] {
  const parse = instance.parse
  instance.import(Object.fromEntries(RISKY.map(name => [name, () => { throw new Error(`${name} 已关闭`) }])), { override: true })
  return parse
}

/** Expression grading's own instance: nothing a learner writes reaches the one with the textbook units. */
const grading = create(all!, { number: 'number' })
export const parseExpression = lockDown(grading)
