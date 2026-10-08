// Quantities with units, shared by numeric grading and the calculator: a mathjs instance with the
// units chemical-engineering textbooks use (at, mH2O, cP…), and readers for the ways people write
// them (℃, m³, kg/m3, \mathrm{kg/m^{3}}, 千帕).
import { all, create, type MathJsInstance, type Unit } from 'mathjs'

export const math: MathJsInstance = create(all!, { number: 'number' })

const EXTRA_UNITS: readonly [string, string | { definition: string; prefixes?: string; aliases?: string[] }][] = [
  // Technical atmosphere (kgf/cm²) and metres of water: old textbook pressure units.
  ['at', '98066.5 Pa'],
  ['mH2O', '9806.65 Pa'],
  // Viscosity: 1 P = 0.1 Pa·s, so cP is mPa·s.
  ['poise', { definition: '0.1 Pa s', prefixes: 'short', aliases: ['P'] }],
]
for (const [name, definition] of EXTRA_UNITS) {
  try {
    math.createUnit(name, definition as never)
  } catch {
    // Already defined by this mathjs version; its definition is the standard one.
  }
}

const SUPERSCRIPT: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-', '⁺': '+' }

/** Chinese unit words, longest first; counting words (块、台…) are dimensionless. */
const CHINESE_UNITS: readonly [RegExp, string][] = [
  [/千帕/g, 'kPa'], [/兆帕/g, 'MPa'], [/帕/g, 'Pa'],
  [/千克|公斤/g, 'kg'], [/厘米/g, 'cm'], [/毫米/g, 'mm'], [/米/g, 'm'], [/克/g, 'g'],
  [/小时/g, 'h'], [/分钟/g, 'min'], [/秒/g, 's'],
  [/千瓦/g, 'kW'], [/瓦/g, 'W'], [/千焦/g, 'kJ'], [/焦/g, 'J'],
  [/[块台根个次层级]/g, ''],
]

/** Superscript digits as `^n`, full-width minus as `-`. */
function plainDigits(text: string): string {
  return text
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, run => `^${[...run].map(char => SUPERSCRIPT[char]).join('')}`)
    .replace(/[−–—]/g, '-')
}

/** A unit as written by a person or a textbook → mathjs syntax. */
export function normalizeUnit(text: string): string {
  let unit = plainDigits(text)
    .replace(/\$/g, ' ')
    .replace(/\\(?:mathrm|text|operatorname)\s*/g, '')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\^\s*\{\s*\\circ\s*\}\s*C|\^\s*\\circ\s*C|\\circ\s*C|°\s*C|℃/g, 'degC')
    .replace(/\\(?:cdot|times)|[·⋅•∙]/g, ' ')
    .replace(/\^\s*\{([^{}]*)\}/g, '^($1)')
    .replace(/[{}]/g, '')
    .replace(/[μµ]/g, 'u')
    .replace(/Ω/g, 'ohm')
    .replace(/（/g, '(').replace(/）/g, ')')
  for (const [pattern, replacement] of CHINESE_UNITS) unit = unit.replace(pattern, replacement)
  return unit
    // m3, m2, s2, cm3 → m^3…; H2O stays (the digit is followed by a letter).
    .replace(/([a-zA-Z])([23])(?![\w^])/g, '$1^$2')
    .replace(/\^\((-?\d+)\)/g, '^$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A mathjs unit for the text, or undefined when it is empty, dimensionless or not a unit. */
export function unitOf(text: string): Unit | undefined {
  const normalized = normalizeUnit(text)
  if (!normalized || !/[a-zA-Z]/.test(normalized)) return undefined
  try {
    const unit = math.unit(1, normalized)
    return unit
  } catch {
    return undefined
  }
}

const NUMBER = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*(?:[×xX*·]\s*10\s*\^?\s*\(?\s*([-+]?\d+)\s*\)?)|[eE]([-+]?\d+))?/

/**
 * Split a final answer like `1.44 kg/m³`, `ρ = 1.44×10³ g/m^3`, `约 0.0231m` into its number and the
 * unit text after it. Thousands separators and LaTeX powers of ten are understood.
 */
export function splitQuantity(text: string): { readonly value?: number; readonly unit: string } {
  let body = plainDigits(text)
    .replace(/\$/g, ' ')
    .replace(/\\(?:times|cdot)/g, '×')
    .replace(/\^\s*\{\s*([-+]?\d+)\s*\}/g, '^$1')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .trim()
  const assigned = body.split(/[=≈]/)
  body = (assigned.at(-1) ?? body).replace(/^\s*(?:约|大约|~)\s*/, '').trim()
  const match = NUMBER.exec(body)
  if (!match) return { unit: '' }
  const mantissa = Number(match[1])
  const exponent = match[2] ?? match[3]
  const value = exponent === undefined ? mantissa : mantissa * 10 ** Number(exponent)
  return Number.isFinite(value) ? { value, unit: body.slice(match[0].length).trim() } : { unit: '' }
}

/** `value` in unit `from`, expressed in unit `to`; undefined when the dimensions differ or a unit is unknown. */
export function convert(value: number, from: string, to: string): number | undefined {
  try {
    const given = math.unit(value, normalizeUnit(from))
    if (!given.equalBase(math.unit(1, normalizeUnit(to)))) return undefined
    return given.toNumber(normalizeUnit(to))
  } catch {
    return undefined
  }
}

/** A unit for display: `kg/m^3` → `kg/m³`. */
export function prettyUnit(unit: string): string {
  return unit.replace(/\^2/g, '²').replace(/\^3/g, '³').replace(/\^-1/g, '⁻¹').replace(/degC/g, '℃')
}
