// The check of a lesson's explanation (docs/textbook/design.md, 讲解与原文): source text copied in as it is
// needs none; each explanation paragraph is checked against the material of its point. The program tests
// what it can by rule (numbers, words copied from an exercise); a check model judges whether a paragraph
// contradicts the material or adds facts it does not have, and names the chunks it comes from. Pure helpers:
// the model and library calls are in checker.ts.
import { parseFrontmatter } from '@learning-agent/contracts'
import { indexBlocks, splitPieces } from './format.ts'
import { copiesStem } from './plan.ts'

/** `unchecked`: the check model gave no usable judgment. */
export type Verdict = 'ok' | 'unsupported' | 'contradicted' | 'unchecked'

export interface ParagraphCheck {
  readonly verdict: Verdict
  /** What is wrong, in words for the learner; empty when nothing is. */
  readonly note: string
  /** Chunks the paragraph's content comes from, as the check model named them. */
  readonly sources: readonly string[]
}

/** One explanation paragraph to check. */
export interface Paragraph {
  /** `P1`, `P2`… within one check call. */
  readonly id: string
  readonly blockId: string
  /** Without citation links. */
  readonly text: string
  readonly citations: readonly string[]
}

/** What the check needs to know about a chunk or a web passage. */
export interface CheckChunk {
  readonly id: string
  readonly text: string
  readonly kind: string
  readonly citation: string
}

const CITE = /\[([^\]]*)\]\(cite:([^)\s]+)\)/g
const WEB_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
const isHeading = (piece: string) => /^#{1,6}\s/.test(piece)

/** The explanation paragraphs of a text: not headings, quote boxes of source text, or recall questions. */
export function paragraphsOf(body: string, only?: ReadonlySet<string>): Paragraph[] {
  const out: Paragraph[] = []
  let questions = false
  for (const piece of splitPieces(parseFrontmatter(body).body)) {
    if (isHeading(piece)) { questions = /读完就答/.test(piece); continue }
    const [block] = indexBlocks(piece)
    if (!block || questions || block.original || (only && !only.has(block.id))) continue
    const text = block.text.replace(CITE, '').replace(WEB_LINK, '$1').trim()
    if ([...text.replace(/[\s。！？；，、：:.,;-]/g, '')].length < 4) continue
    out.push({ id: `P${out.length + 1}`, blockId: block.id, text, citations: block.citations })
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

/** LaTeX without its markup, so `p_{2}=p_{1}+\rho gh` and MinerU's `p _ {2} = p _ {1} + \rho g h` compare equal. */
export function bareTex(text: string): string {
  return normalized(text)
    .replace(/\\tag\{[^}]*\}/g, '')
    .replace(/\\(?:mathrm|text|rm|mathbf|operatorname|boldsymbol)\{([^}]*)\}/g, '$1')
    .replace(/\\(?:left|right|displaystyle|,|;|!|quad|qquad)/g, '')
    .replace(/\\dfrac|\\tfrac/g, '\\frac')
    .replace(/[$^_{}~]/g, '')
}

/** Formulas a paragraph states (inline or display math with `=`), as written. */
export function formulasIn(text: string): string[] {
  return [...text.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g)].map(match => (match[1] ?? match[2]!).trim()).filter(formula => /=|<|>|\\approx/.test(formula))
}

/**
 * What the program finds wrong with a paragraph by rule, given its point's material: numbers the material
 * does not have, or a stretch copied from an exercise. Formulas are only reported (`unknown`): a rearranged
 * formula is fine, so the check model judges them.
 */
export function precheck(text: string, material: string, stems: readonly string[]): { readonly problem?: string; readonly unknown: readonly string[] } {
  const own = normalized(material)
  const missing = numbersIn(text).filter(number => !own.includes(number))
  const bare = bareTex(material)
  const unknown = formulasIn(text).filter(formula => !bare.includes(bareTex(formula)))
  if (copiesStem(text, stems, 14)) return { problem: '和课后习题的题干文字相同，可能把题目写进了教材', unknown }
  if (missing.length) return { problem: `数值 ${missing.join('、')} 在资料里找不到`, unknown }
  return { unknown }
}

export const CHECK_SYSTEM = `你核对一节教材里的讲解段落是否忠实于给出的资料。讲解可以换说法、举资料里有的例子、省略细节，但不能和资料矛盾，也不能加入资料里没有的事实（数值、公式、结论、适用条件）。教学性的过渡、提问、学习建议、解题思路和步骤安排、常见错误的提醒不算事实，只要它们用到的事实都在资料里。资料是唯一依据，不要用你自己的知识判断对错。
对每段给出：
- verdict：ok（没有矛盾，事实都能在资料里找到，包括由资料里的式子直接变形得到的式子）；contradicted（和资料说的相反，或条件、数值、符号、单位不同）；unsupported（有资料里找不到的事实）。
- sources：这段内容出自哪些片段，写片段 ID（最多 3 个）；网页摘录写它的网址。
- note：不是 ok 时，用一句话说明哪里不对、资料原文怎么说。
只输出 JSON：{"results":[{"id":"P1","verdict":"ok","sources":["ck_…"],"note":""}]}`

/** The material of one point and its explanation paragraphs; formulas the program did not find are named. */
export function checkPrompt(paragraphs: readonly Paragraph[], chunks: readonly CheckChunk[], unknown: ReadonlyMap<string, readonly string[]>): string {
  const material = chunks.map(chunk => `[${chunk.id}] ${chunk.citation}\n${chunk.text}`).join('\n\n')
  const lines = paragraphs.map(paragraph => {
    const formulas = unknown.get(paragraph.id) ?? []
    return [`[${paragraph.id}] ${paragraph.text}`, ...formulas.length ? [`（资料里没有原样出现的式子：${formulas.map(formula => `$${formula}$`).join('、')}，请判断能否由资料直接得出）`] : []].join('\n')
  }).join('\n\n')
  return `# 资料\n${material || '（没有）'}\n\n# 要核对的讲解段落\n${lines}`
}

const VERDICTS = new Set(['ok', 'contradicted', 'unsupported'])

/**
 * Turn a check reply into judgments, by block id. A paragraph the reply leaves out is `unchecked`; sources
 * outside `allowed` are dropped; a problem the program found stands whatever the reply says.
 */
export function judge(paragraphs: readonly Paragraph[], reply: unknown, allowed: ReadonlySet<string>, found: ReadonlyMap<string, string>): Map<string, ParagraphCheck> {
  type Raw = { readonly id?: unknown; readonly verdict?: unknown; readonly sources?: unknown; readonly note?: unknown }
  const raw = new Map<string, Raw>()
  const list = (reply as { results?: unknown })?.results
  if (Array.isArray(list)) for (const item of list as Raw[]) if (typeof item?.id === 'string') raw.set(item.id.trim(), item)
  const out = new Map<string, ParagraphCheck>()
  for (const paragraph of paragraphs) {
    const item = raw.get(paragraph.id)
    const verdict = typeof item?.verdict === 'string' && VERDICTS.has(item.verdict) ? item.verdict as Verdict : 'unchecked'
    const sources = Array.isArray(item?.sources) ? [...new Set((item.sources as unknown[]).filter((id): id is string => typeof id === 'string').map(id => id.trim()).filter(id => allowed.has(id)))].slice(0, 3) : []
    const note = typeof item?.note === 'string' ? item.note.trim() : ''
    const problem = found.get(paragraph.id)
    if (problem) out.set(paragraph.blockId, { verdict: verdict === 'contradicted' ? 'contradicted' : 'unsupported', note: [problem, verdict !== 'ok' ? note : ''].filter(Boolean).join('；'), sources })
    else out.set(paragraph.blockId, { verdict, note: verdict === 'ok' ? '' : verdict === 'unchecked' ? '核对模型没有给出这段的判断' : note, sources })
  }
  return out
}

/** Whether a paragraph's check says to read it with care. */
export function flagged(check: Pick<ParagraphCheck, 'verdict'>): boolean {
  return check.verdict === 'contradicted' || check.verdict === 'unsupported'
}

/** Why a paragraph is 待核实, for the teacher and the learner. */
export function reasonOf(text: string, check: ParagraphCheck): string {
  const plain = text.replace(CITE, '').replace(/\s+/g, ' ').trim()
  return `「${[...plain].slice(0, 30).join('')}${[...plain].length > 30 ? '…' : ''}」${check.note || (check.verdict === 'contradicted' ? '和资料不一致' : '资料里找不到依据')}`
}

/**
 * Add citations to paragraphs that have none, from the chunks the check found them in: every explanation
 * paragraph then opens on the source it comes from.
 */
export function addSources(body: string, additions: ReadonlyMap<string, readonly CheckChunk[]>): string {
  if (additions.size === 0) return body
  return `${splitPieces(body).map(piece => {
    const [block] = isHeading(piece) ? [] : indexBlocks(piece)
    const add = block ? additions.get(block.id) : undefined
    if (!block || !add?.length || block.original) return piece
    const links = add.map(chunk => `[${chunk.citation}](cite:${chunk.id})`).join('')
    return piece.replace(/\s\^([0-9a-z]{6})\s*$/, (_, id: string) => ` ${links} ^${id}`)
  }).join('\n\n')}\n`
}
