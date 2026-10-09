// Sentence-by-sentence check of a lesson's text (docs/textbook/design.md, 逐句核对). The program cuts the
// sentences and batches them with the chunks they cite; a check model judges each sentence; a judgment
// counts only when its quote is really in the named chunk and the sentence's numbers are in the cited
// text. Pure helpers: the model and library calls are in checker.ts.
import { parseFrontmatter } from '@learning-agent/contracts'
import { indexBlocks, splitPieces } from './format.ts'

/** `unchecked`: the check model gave no usable judgment for the sentence. */
export type Verdict = 'supported' | 'partial' | 'contradicted' | 'missing' | 'unchecked'

export interface Sentence {
  /** `<paragraph>.<sentence>`, numbered per check. */
  readonly id: string
  readonly blockId: string
  /** Without citation links. */
  readonly text: string
  /** A formula, a number with a unit, or a definition (by rule). */
  readonly key: boolean
  readonly formula: boolean
}

/** One paragraph to check. */
export interface Unit {
  readonly blockId: string
  readonly citations: readonly string[]
  readonly formula: boolean
  readonly sentences: readonly Sentence[]
}

export interface Evidence {
  readonly chunkId: string
  readonly quote: string
}

export interface SentenceCheck {
  readonly text: string
  readonly verdict: Verdict
  readonly key: boolean
  /** Supported by a worked example of the material: checked as copied, no second source needed. */
  readonly copy: boolean
  readonly evidence: readonly Evidence[]
  /** Independent source groups that support it (docs/textbook/design.md, 两个独立来源). */
  readonly groups: readonly string[]
  /** Why it is not supported, in words for the learner. */
  readonly note: string
}

/** What the check needs to know about a chunk. */
export interface CheckChunk {
  readonly id: string
  readonly text: string
  readonly kind: string
  readonly citation: string
  readonly sourceId: string
}

const CITE = /\[([^\]]*)\]\(cite:([^)\s]+)\)/g
const QUESTION_HEADING = /读完就答/
/** The notes after a formula about its source (`finalize`, `markBody`); they state nothing to check. */
const NO_SOURCE_NOTE = /^上式(?:没有|出自)/

const isHeading = (piece: string) => /^#{1,6}\s/.test(piece)
const isDisplayMath = (text: string) => /^\$\$[\s\S]*\$\$$/.test(text.trim())

/** Cut prose into sentences, ending at 。！？； or a line break; a formula is one sentence. */
export function sentencesOf(text: string, formula: boolean): string[] {
  const plain = text.replace(CITE, '').trim()
  if (formula) return [plain]
  return plain.split(/(?<=[。！？；])|\n+/).map(part => part.trim()).filter(part => [...part.replace(/[\s。！？；，、：:.,;-]/g, '')].length >= 4)
}

const DEFINITION = /称为|叫做|叫作|称作|是指|定义为|记作/
const UNIT_AFTER_NUMBER = /\d\s*(?:[a-zA-Zμ°℃%Ω‰]|千|米|克|秒|帕|升|度|牛|焦|瓦)/

/** Facts the textbook rules ask two sources for: formulas, numbers with units, definitions. */
export function isKey(text: string, formula: boolean): boolean {
  return formula || /\$[^$]*=[^$]*\$/.test(text) || UNIT_AFTER_NUMBER.test(text) || DEFINITION.test(text)
}

/** The paragraphs that state something: not headings, recall questions, formula lead-ins or source notes. */
export function unitsOf(body: string): Unit[] {
  const units: Unit[] = []
  const pieces = splitPieces(parseFrontmatter(body).body)
  let questions = false
  for (const [index, piece] of pieces.entries()) {
    if (isHeading(piece)) { questions = QUESTION_HEADING.test(piece); continue }
    const [block] = indexBlocks(piece)
    if (!block || questions || NO_SOURCE_NOTE.test(block.text)) continue
    const formula = isDisplayMath(block.text)
    const next = pieces[index + 1]
    if (!formula && next && isDisplayMath(next.split('\n').filter(line => !/^\^[0-9a-z]{6}$/.test(line.trim())).join('\n')) && /[:：]\s*(?:\[[^\]]*\]\(cite:[^)]+\)\s*)*$/.test(block.text) && [...block.text.replace(CITE, '')].length <= 40) continue
    const n = units.length + 1
    const sentences = sentencesOf(block.text, formula).map((text, i) => ({ id: `${n}.${i + 1}`, blockId: block.id, text, key: isKey(text, formula), formula }))
    if (sentences.length) units.push({ blockId: block.id, citations: block.citations, formula, sentences })
  }
  return units
}

/**
 * Consecutive paragraphs and the chunks they cite, up to `limit` characters and `sentences` sentences
 * per batch (the reply judges each sentence, and must fit the output budget). A formula goes with the
 * paragraph after it, whose citations are its sources.
 */
export function planBatches(units: readonly Unit[], chunk: (id: string) => CheckChunk | undefined, limit: number, sentences = Number.POSITIVE_INFINITY): { units: Unit[]; chunks: CheckChunk[] }[] {
  const batches: { units: Unit[]; chunks: CheckChunk[] }[] = []
  let current: { units: Unit[]; chunks: CheckChunk[] } = { units: [], chunks: [] }
  let size = 0
  let count = 0
  const sizeOf = (unit: Unit, have: readonly CheckChunk[]) => unit.sentences.reduce((sum, sentence) => sum + sentence.text.length + 20, 0)
    + unit.citations.map(chunk).filter((item): item is CheckChunk => !!item && !have.includes(item)).reduce((sum, item) => sum + item.text.length + 60, 0)
  for (const [index, unit] of units.entries()) {
    const cost = sizeOf(unit, current.chunks)
    const tied = index > 0 && units[index - 1]!.formula
    if (current.units.length > 0 && !tied && (size + cost > limit || count + unit.sentences.length > sentences)) {
      batches.push(current)
      current = { units: [], chunks: [] }
      size = 0
      count = 0
    }
    count += unit.sentences.length
    current.units.push(unit)
    for (const id of unit.citations) {
      const item = chunk(id)
      if (item && !current.chunks.includes(item)) current.chunks.push(item)
    }
    size += cost
  }
  if (current.units.length) batches.push(current)
  return batches
}

export const CHECK_SYSTEM = `你核对一节教材：逐句判断它是否被给出的资料原文支持。资料片段是唯一依据，不要用你自己的知识补充或纠正。
对每一句给出：
- verdict：supported（原文完整支持这句话，包括适用条件、否定、比较方向、数值、单位和符号含义）；partial（只支持一部分，或缺了条件、改变了范围）；contradicted（原文说的相反，或数值、单位、符号不同）；missing（资料里找不到依据）。
- key：这句是不是关键事实（公式、带单位的数值、定义）。
- evidence：支持它的片段 ID 和从该片段逐字摘出的原文（quote）。quote 必须原样照抄片段里连续的一段，不改写、不省略中间的字，尽量短但要包含这句话依赖的条件和数值。不是 supported 也可以给出最接近的原文。
- note：不是 supported 时，用一句话说明缺什么、原文写的是什么。
只输出 JSON：{"results":[{"id":"1.1","verdict":"supported","key":false,"evidence":[{"chunk":"ck_…","quote":"…"}],"note":""}]}`

/** The material and the sentences of one batch; each paragraph says which chunks it cites. */
export function checkPrompt(batch: { readonly units: readonly Unit[]; readonly chunks: readonly CheckChunk[] }): string {
  const material = batch.chunks.map(chunk => `[${chunk.id}] ${chunk.citation}\n${chunk.text}`).join('\n\n')
  const sentences = batch.units.map(unit => [
    `段落 ${unit.sentences[0]!.id.split('.')[0]}${unit.formula ? '（独立公式，出处在下一段）' : unit.citations.length ? `（引用了 ${unit.citations.join('、')}）` : '（没有引用出处）'}`,
    ...unit.sentences.map(sentence => `[${sentence.id}] ${sentence.text}`),
  ].join('\n')).join('\n\n')
  return `# 资料片段\n${material || '（没有）'}\n\n# 要核对的句子\n${sentences}`
}

export const SECOND_SYSTEM = `你核对教材里的关键事实是否也被另一份资料支持。每句话后面列出了几段候选原文，只判断这些候选原文能不能完整支持这句话（包括条件、数值、单位和符号含义），不要用你自己的知识。
只输出 JSON：{"results":[{"id":"1.1","verdict":"supported","evidence":[{"chunk":"ck_…","quote":"逐字摘出的原文"}],"note":""}]}
verdict 只用 supported、partial、contradicted、missing。quote 必须原样照抄候选片段里连续的一段。`

/** Each sentence with its own candidate chunks from other sources. */
export function secondPrompt(items: readonly { readonly sentence: Sentence; readonly chunks: readonly CheckChunk[] }[]): string {
  return items.map(({ sentence, chunks }) => [
    `[${sentence.id}] ${sentence.text}`,
    ...chunks.map(chunk => `  候选 [${chunk.id}] ${chunk.citation}\n  ${chunk.text.replace(/\n/g, '\n  ')}`),
  ].join('\n')).join('\n\n')
}

/** Text compared for quotes and numbers: no whitespace, half-width digits, no thousands separators. */
export function normalized(text: string): string {
  return text
    .replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/(\d)[,，](?=\d{3})/g, '$1')
    .replace(/\{,\}/g, '')
    .replace(/[\s   ]+/g, '')
}

/**
 * Numbers a sentence states, to be found in its evidence: decimals and numbers of two digits or more.
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

/**
 * Keywords of a sentence for the full-text search, which matches each term as a phrase: Chinese runs
 * cut into pieces of four characters, and Latin words.
 */
export function termsOf(text: string): string {
  const plain = text.replace(CITE, '').replace(/\$[^$]*\$/g, ' ').replace(/\[a-zA-Z]+/g, ' ')
  const pieces: string[] = []
  for (const run of plain.match(/[一-鿿]+|[A-Za-z]{3,}/g) ?? []) {
    if (/^[A-Za-z]/.test(run)) pieces.push(run)
    else for (let i = 0; i < run.length; i += 4) if (run.length - i >= 3) pieces.push(run.slice(i, i + 4))
  }
  return [...new Set(pieces)].slice(0, 8).join(' ')
}

/**
 * Whether `quote` is a passage of `text`. LaTeX is compared without its markup (`p_{2}` and `p_2`, a
 * `$` more or less), since a model copying a formula rarely keeps it character for character.
 */
export function quoted(text: string, quote: string): boolean {
  const bare = (value: string) => normalized(value).replace(/[\$^_{}]/g, '')
  return normalized(text).includes(normalized(quote)) || (/[\$^_{}]/.test(quote) && bare(text).includes(bare(quote)))
}

const VERDICTS = new Set(['supported', 'partial', 'contradicted', 'missing'])

interface RawResult {
  readonly id?: unknown
  readonly verdict?: unknown
  readonly key?: unknown
  readonly evidence?: unknown
  readonly note?: unknown
}

/**
 * Turn a check model's reply into judgments the program stands behind: a quote must be in the chunk it
 * names (one of `allowed`), a supported sentence needs one valid quote, and its numbers must be in the
 * cited chunks; otherwise it is not supported, with the reason. Sentences the reply left out are
 * `unchecked`. A display formula found as it is among the given formula chunks is supported.
 */
export function judge(sentences: readonly Sentence[], reply: unknown, allowed: ReadonlyMap<string, CheckChunk>): Map<string, SentenceCheck> {
  const raw = new Map<string, RawResult>()
  const list = (reply as { results?: unknown })?.results
  if (Array.isArray(list)) for (const item of list as RawResult[]) if (typeof item?.id === 'string') raw.set(item.id.trim(), item)
  const results = new Map<string, SentenceCheck>()
  for (const sentence of sentences) {
    const item = raw.get(sentence.id)
    const verdict = typeof item?.verdict === 'string' && VERDICTS.has(item.verdict) ? item.verdict as Verdict : 'unchecked'
    const evidence = (Array.isArray(item?.evidence) ? item.evidence as { chunk?: unknown; quote?: unknown }[] : []).flatMap(entry => {
      const chunk = typeof entry?.chunk === 'string' ? allowed.get(entry.chunk.trim()) : undefined
      const quote = typeof entry?.quote === 'string' ? entry.quote.trim() : ''
      return chunk && quote && quoted(chunk.text, quote) ? [{ chunkId: chunk.id, quote }] : []
    })
    const key = sentence.key || item?.key === true
    const note = typeof item?.note === 'string' ? item.note.trim() : ''
    let check: SentenceCheck = { text: sentence.text, verdict, key, copy: false, evidence, groups: [], note: verdict === 'unchecked' ? '核对模型没有给出这句的判断' : note }
    if (verdict === 'supported') {
      const cited = evidence.map(entry => normalized(allowed.get(entry.chunkId)!.text)).join('\n')
      const absent = numbersIn(sentence.text).filter(number => !cited.includes(number))
      if (evidence.length === 0) check = { ...check, verdict: 'missing', note: '核对模型摘出的原文在所引片段里找不到' }
      else if (absent.length) check = { ...check, verdict: 'partial', note: `数值 ${absent.join('、')} 在所引原文里找不到` }
      else check = { ...check, note: '', copy: evidence.every(entry => allowed.get(entry.chunkId)!.kind === 'example') }
    }
    // A formula that reads exactly as one of the formulas given is supported by it, whatever the reply says.
    const verbatim = sentence.formula ? [...allowed.values()].find(chunk => chunk.kind === 'formula' && quoted(chunk.text, sentence.text.replace(/\$\$/g, '').trim())) : undefined
    if (verbatim && check.verdict !== 'supported') check = { ...check, verdict: 'supported', evidence: [{ chunkId: verbatim.id, quote: verbatim.text }], note: '' }
    results.set(sentence.id, check)
  }
  return results
}

/** Supported, and by two independent sources when it is a key fact that is not copied from a worked example. */
export function settled(check: SentenceCheck): 'ok' | 'single' | 'unsupported' {
  if (check.verdict !== 'supported') return 'unsupported'
  return check.key && !check.copy && check.groups.length < 2 ? 'single' : 'ok'
}

/** Why a paragraph is 待核实, from its sentences, for the learner. */
export function reasonOf(checks: readonly SentenceCheck[]): string {
  const WORD: Record<Verdict, string> = { supported: '', partial: '原文只支持一部分', contradicted: '和原文不一致', missing: '资料里找不到依据', unchecked: '没有核对' }
  return checks.filter(check => check.verdict !== 'supported').map(check => `「${check.text.slice(0, 30)}${check.text.length > 30 ? '…' : ''}」${check.note || WORD[check.verdict]}`).join('；')
}

/**
 * Write the check into a body (no frontmatter): a paragraph with a sentence not supported gets the
 * 待核实 link, one whose sentences are all supported loses it; sources found for it (a second source,
 * or the chunk that supports a sentence citing something else) are added as citations. A formula's
 * added sources go to the paragraph after it, or replace the "上式没有找到出处" note `finalize` put
 * there; a formula not supported gets a 待核实 note after it unless it has one.
 */
export function markBody(body: string, marks: ReadonlyMap<string, { readonly unsupported: boolean; readonly add: readonly CheckChunk[] }>, newBlockId: () => string): string {
  const pieces = splitPieces(body)
  const out: string[] = []
  let carry: CheckChunk[] = []
  for (const [index, piece] of pieces.entries()) {
    const [block] = isHeading(piece) ? [] : indexBlocks(piece)
    if (!block) { out.push(piece); continue }
    const mark = marks.get(block.id)
    if (isDisplayMath(block.text)) {
      out.push(piece)
      carry = mark && !mark.unsupported ? [...mark.add] : []
      const [after] = pieces[index + 1] && !isHeading(pieces[index + 1]!) ? indexBlocks(pieces[index + 1]!) : []
      if (mark?.unsupported && !(after && NO_SOURCE_NOTE.test(after.text))) out.push(`上式没有在所引原文里找到依据。[待核实](cite:unverified) ^${newBlockId()}`)
      continue
    }
    if (NO_SOURCE_NOTE.test(block.text)) {
      const links = carry.map(chunk => `[${chunk.citation}](cite:${chunk.id})`).join('')
      out.push(links ? `上式出自${links}。 ^${block.id}` : piece)
      carry = []
      continue
    }
    const add = [...carry, ...mark?.add ?? []].filter((chunk, index, all) => !block.citations.includes(chunk.id) && all.findIndex(other => other.id === chunk.id) === index)
    carry = []
    if (!mark && add.length === 0) { out.push(piece); continue }
    const links = add.map(chunk => `[${chunk.citation}](cite:${chunk.id})`).join('')
    // Every sentence supported means each one's chunk is cited now: the old flag no longer applies.
    const kept = mark && !mark.unsupported ? piece.replace(/\s*\[待核实\]\(cite:unverified\)/g, '') : piece
    const flag = mark?.unsupported && !block.text.includes('(cite:unverified)') ? '[待核实](cite:unverified)' : ''
    out.push(kept.replace(/\s\^([0-9a-z]{6})\s*$/, (_, id: string) => `${links}${flag} ^${id}`))
  }
  return `${out.join('\n\n')}\n`
}
