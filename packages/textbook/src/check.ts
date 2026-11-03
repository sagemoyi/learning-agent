// What the program checks in a handout by rule (docs/textbook/design.md, 程序检查): no model reads it again
// (11-01: a handout is notes, not every sentence checked). A formula is as the source writes it, the numbers are
// in the material, nothing is copied from an exercise or names one, and the explanation is not the source copied.
// Source text copied in and the tables' formulas come from the source and need none. Pure helpers.
import { parseFrontmatter } from '@learning-agent/contracts'
import { indexBlocks, isTable, splitPieces } from './format.ts'
import { NAMES_EXERCISE, copiesStem } from './handout.ts'

/** `unchecked` is only in what older handouts kept: a check model that gave no judgment. */
export type Verdict = 'ok' | 'unsupported' | 'contradicted' | 'unchecked'

export interface ParagraphCheck {
  readonly verdict: Verdict
  /** What is wrong, in words for the learner; empty when nothing is. */
  readonly note: string
  /** Chunks the paragraph's content comes from, as an older check named them. */
  readonly sources: readonly string[]
}

/** One explanation paragraph to check. */
export interface Paragraph {
  readonly blockId: string
  /** Without citation links. */
  readonly text: string
  readonly citations: readonly string[]
}

const CITE = /\[([^\]]*)\]\(cite:([^)\s]+)\)/g
const WEB_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
const isHeading = (piece: string) => /^#{1,6}\s/.test(piece)
/** The program's note box: what the material does not explain. */
const NOTE = /^>\s*\[!note\]/

/**
 * The explanation paragraphs of a text: not headings, tables (checked by row), quote boxes of source text, the
 * program's notes of what the material does not explain, or the recall questions of older files.
 */
export function paragraphsOf(body: string, only?: ReadonlySet<string>): Paragraph[] {
  const out: Paragraph[] = []
  let questions = false
  for (const piece of splitPieces(parseFrontmatter(body).body)) {
    if (isHeading(piece)) { questions = /读完就答/.test(piece); continue }
    const [block] = indexBlocks(piece)
    if (!block || questions || block.original || isTable(block.text) || NOTE.test(block.text) || (only && !only.has(block.id))) continue
    const text = block.text.replace(CITE, '').replace(WEB_LINK, '$1').trim()
    if ([...text.replace(/[\s。！？；，、：:.,;-]/g, '')].length < 4) continue
    out.push({ blockId: block.id, text, citations: block.citations })
  }
  return out
}

/** Text compared for numbers: no whitespace, half-width digits, no thousands separators. */
export function normalized(text: string): string {
  return text
    .replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/(\d)[,，](?=\d{3})/g, '$1')
    .replace(/\{,\}/g, '')
    .replace(/[\s   ]+/g, '')
}

/**
 * Numbers a sentence states, to be found in its material: decimals and numbers of two digits or more.
 * Subscripts, and section, equation, example and figure numbers are left out.
 */
export function numbersIn(text: string): string[] {
  const plain = normalized(text.replace(CITE, ''))
    .replace(/\\(?:text|mathrm|rm|mathbf)\{([^}]*)\}/g, '$1')
    .replace(/_\{[^}]*\}|_[A-Za-z0-9]/g, '')
    .replace(/(?:第|式|例|图|表|习题|附录)[（(]?\d+(?:[-–—.．]\d+)*[)）]?/g, '')
    .replace(/\d+(?:\.\d+)+节/g, '')
  return [...new Set((plain.match(/\d+(?:\.\d+)?/g) ?? []).filter(number => number.includes('.') || number.length >= 2))]
}

const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  le: '≤', leq: '≤', leqslant: '≤', ge: '≥', geq: '≥', geqslant: '≥', ne: '≠', neq: '≠', approx: '≈', times: '×', cdot: '·',
}

/**
 * LaTeX without the markup that does not change what it says, so `p_{2}=p_{1}+\rho gh` and MinerU's
 * `p _ {2} = p _ {1} + \rho g h` compare equal. Sub- and superscripts, grouping, signs and bars stay: `p^2` is not
 * `p_2`, and `\frac{\Delta p}{\rho g}` is not `\frac{\Delta p}{\rho}g`.
 */
export function bareTex(text: string): string {
  // Symbols first: `\rho g` loses the space that ends the command once whitespace goes.
  let bare = normalized(text.replace(/\\([A-Za-z]+)/g, (command, name: string) => SYMBOLS[name] ?? command))
    .replace(/\\tag\{[^}]*\}/g, '')
    .replace(/\\(?:mathrm|text|rm|mathbf|mathit|operatorname|boldsymbol)\{([^}]*)\}/g, '$1')
    .replace(/\\(?:left|right|displaystyle|textstyle|,|;|:|!|quad|qquad)/g, '')
    .replace(/\\dfrac|\\tfrac/g, '\\frac')
    .replace(/[$~]/g, '')
  // A group of one character is that character (`p_{2}` is `p_2`); inner groups first.
  for (let pass = 0; pass < 4; pass++) bare = bare.replace(/\{([^{}\\])\}/g, '$1')
  return bare
}

/** A formula with its subscripts written flat, as a PDF's text layer has them (`p_2` is `p2`); superscripts stay. */
function flatSubscripts(bare: string): string {
  return bare.replace(/_\{([^{}]*)\}/g, '$1').replace(/_/g, '')
}

/** Whether `material` (already through `bareTex`) states `formula` as written, its subscripts flat or not. */
export function statesFormula(material: string, formula: string): boolean {
  const own = bareTex(formula)
  return material.includes(own) || flatSubscripts(material).includes(flatSubscripts(own))
}

/** Formulas a paragraph states (inline or display math with `=` or an inequality), as written. */
export function formulasIn(text: string): string[] {
  return [...text.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g)].map(match => (match[1] ?? match[2]!).trim()).filter(formula => /=|<|>|\\(?:approx|le|ge|ne)/.test(formula))
}

/** What the program finds wrong with a paragraph by rule; `contradicts` when it is at odds with the material. */
export interface Problem {
  readonly note: string
  readonly contradicts: boolean
}

/**
 * What the program finds wrong with a paragraph by rule, given the material: a stretch copied from an exercise or
 * an exercise named by its number, a formula the material does not have as written (formulas stay as the source
 * writes them, 10-31), or numbers the material does not have.
 */
export function precheck(text: string, material: string, stems: readonly string[]): Problem | undefined {
  if (copiesStem(text, stems, 14)) return { note: '和课后习题的题干文字相同，可能把题目写进了讲义', contradicts: false }
  if (NAMES_EXERCISE.test(text)) return { note: '提到了习题的题号，讲义只讲方法', contradicts: false }
  const bare = bareTex(material)
  const changed = formulasIn(text).filter(formula => !statesFormula(bare, formula))
  if (changed.length) return { note: `式子 ${changed.slice(0, 2).map(formula => `$${formula}$`).join('、')} 和资料里的写法不一致，公式要和原文一样`, contradicts: true }
  const own = normalized(material)
  const missing = numbersIn(text).filter(number => !own.includes(number))
  if (missing.length) return { note: `数值 ${missing.join('、')} 在资料里找不到`, contradicts: false }
  return undefined
}

/** Characters in a row a paragraph may share with its material before it reads as copied. */
export const COPY_RUN = 20

/** What copying is judged on: the words, without math, links, markup or punctuation. */
const wordsOf = (text: string) => text
  .replace(CITE, '').replace(WEB_LINK, '$1')
  .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, '')
  .replace(/[\s*_>#[\]()（）。，、；：！？“”‘’"',.;:!?-]/g, '')

/**
 * Whether a paragraph repeats `run` characters of `material` in a row (10-31: the explanation is in other
 * words; the source is one click away). Built once per material.
 */
export function copiesOf(material: string, run = COPY_RUN): (text: string) => boolean {
  const source = [...wordsOf(material)]
  const windows = new Set<string>()
  for (let i = 0; i + run <= source.length; i += 1) windows.add(source.slice(i, i + run).join(''))
  return text => {
    const own = [...wordsOf(text)]
    for (let i = 0; i + run <= own.length; i += 1) if (windows.has(own.slice(i, i + run).join(''))) return true
    return false
  }
}

/** Whether a paragraph's check says to read it with care. */
export function flagged(check: Pick<ParagraphCheck, 'verdict'>): boolean {
  return check.verdict === 'contradicted' || check.verdict === 'unsupported'
}

/** A problem as the check kept for a paragraph. */
export function checkOf(problem: Problem): ParagraphCheck {
  return { verdict: problem.contradicts ? 'contradicted' : 'unsupported', note: problem.note, sources: [] }
}

/** Why a paragraph is 待核实, for the teacher and the learner. */
export function reasonOf(text: string, check: ParagraphCheck): string {
  const plain = text.replace(CITE, '').replace(/\s+/g, ' ').trim()
  return `「${[...plain].slice(0, 30).join('')}${[...plain].length > 30 ? '…' : ''}」${check.note || (check.verdict === 'contradicted' ? '和资料不一致' : '资料里找不到依据')}`
}
