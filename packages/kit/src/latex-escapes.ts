// Models often write LaTeX into JSON tool arguments without doubling the backslash, so `\rho`,
// `\frac`, `\times`, `\beta` and `\nu` arrive as a control character plus letters (JSON's \r, \f,
// \t, \b, \n escapes). Put the backslash back before the text is stored.

const CONTROL: Record<string, string> = { '\r': 'r', '\t': 't', '\f': 'f', '\b': 'b' }

/** Repair one string. A carriage return, tab, form feed or backspace followed by letters is a LaTeX command. */
export function repairLatexEscapes(text: string): string {
  let repaired = text.replace(/[\r\t\f\b](?=[A-Za-z])/g, char => `\\${CONTROL[char]}`)
  // A line feed is usually a real line break; only inside inline math `$…$` is it `\nu`, `\nabla`, `\neq`….
  repaired = repaired.replace(/\$[^$]+\$/g, math => math.replace(/\n(?=[A-Za-z])/g, '\\n'))
  return repaired
}

/** Repair every string inside a JSON-like value. */
export function repairLatexDeep<T>(value: T): T {
  if (typeof value === 'string') return repairLatexEscapes(value) as T
  if (Array.isArray(value)) return value.map(item => repairLatexDeep(item)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, repairLatexDeep(item)])) as T
  }
  return value
}
