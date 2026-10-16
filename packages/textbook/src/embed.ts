// Source text copied into a lesson as it is (docs/textbook/design.md, 讲解与原文). The writer names chunks with
// `![[ck_…]]` or `![[ck_…..ck_…]]` on a line of its own; the program puts the chunks' own text in an Obsidian
// quote box headed by its citation. A worked example's solution comes as a box of its own, folded.
import type { CitedChunk } from '@learning-agent/contracts'

/** Chunks one embed may span: a worked solution, a derivation, a few formulas. */
export const EMBED_LIMIT = 12

const ID = 'ck_[0-9A-HJKMNP-TV-Z]{26}'
/** One embed, alone on its line. */
export const EMBED_LINE = new RegExp(`^!\\[\\[\\s*(${ID})(?:\\s*(?:\\.\\.|…|~|～|—|–|-)\\s*(${ID}))?\\s*\\]\\]$`)
/** An embed anywhere in a line, for one the writer left inside a paragraph. */
export const EMBED_ANYWHERE = new RegExp(`!\\[\\[\\s*(${ID})(?:\\s*(?:\\.\\.|…|~|～|—|–|-)\\s*(${ID}))?\\s*\\]\\]`, 'g')

/** Where embeds may come from: the lesson's material in reading order, and single chunks found for a gap. */
export interface EmbedSource {
  readonly order: readonly CitedChunk[]
  readonly extra: readonly CitedChunk[]
}

/** What a solution's first chunk usually starts with, after the example it follows. */
const SOLUTION_START = /^\s*[（(]?\s*解\s*[）)]?|^\s*\*\*解/

/** The quote boxes for one embed, or why it cannot be embedded. */
export function expandEmbed(from: string, to: string | undefined, source: EmbedSource): { readonly boxes: string[] } | { readonly error: string } {
  const at = source.order.findIndex(chunk => chunk.id === from)
  if (at < 0) {
    const single = source.extra.find(chunk => chunk.id === from)
    if (single && (!to || to === from)) return { boxes: [box([single], false)] }
    return { error: `${from} 不在本节资料里` }
  }
  const end = to ? source.order.findIndex(chunk => chunk.id === to) : at
  if (end < 0) return { error: `${to} 不在本节资料里` }
  if (end < at) return { error: `${from}..${to} 的顺序反了` }
  const chunks = source.order.slice(at, end + 1)
  if (chunks.length > EMBED_LIMIT) return { error: `${from}..${to} 有 ${chunks.length} 段，超过 ${EMBED_LIMIT} 段` }
  if (chunks.some((chunk, index) => chunk.kind === 'heading' && index > 0)) return { error: `${from}..${to} 跨了小标题` }
  const own = chunks.filter(chunk => chunk.kind !== 'heading')
  if (own.length === 0) return { error: `${from} 是小标题，不用嵌入` }
  // An example with what follows it: the problem, then its solution folded.
  if (own[0]!.kind === 'example' && own.length > 1) return { boxes: [box(own.slice(0, 1), false), box(own.slice(1), true)] }
  const before = source.order[at - 1]
  const solution = before?.kind === 'example' || (own[0]!.kind !== 'example' && SOLUTION_START.test(own[0]!.text))
  // Prose the explanation retells would be said twice; its citation badge shows the source on hover.
  if (!solution && own.every(chunk => chunk.kind === 'text')) return { error: `${from} 是正文段落，讲解里讲过就不再放原文（出处标签能看原文）` }
  return { boxes: [box(own, solution)] }
}

/** `> [!quote] 原文 · [《书》p.8](cite:ck_…)` and the chunks' text, each line quoted. */
function box(chunks: readonly CitedChunk[], solution: boolean): string {
  const first = chunks[0]!
  const last = chunks.at(-1)!
  const label = solution ? '原书解答'
    : first.kind === 'example' ? '原题'
      : chunks.every(chunk => chunk.kind === 'figure') ? '原图'
        : chunks.every(chunk => chunk.kind === 'table') ? '原表' : '原文'
  const cites = [first, ...(last.locator.page !== first.locator.page ? [last] : [])].map(chunk => `[${chunk.citation}](cite:${chunk.id})`).join('、')
  const body = chunks.flatMap((chunk, index) => [...(index ? ['>'] : []), ...quoted(chunk)])
  return [`> [!quote]${solution ? '-' : ''} ${label} · ${cites}`, ...body].join('\n')
}

/** A figure is drawn from its page (`![caption](cite:ck_…)`); other chunks are their text. */
function quoted(chunk: CitedChunk): string[] {
  if (chunk.kind === 'figure') {
    const [caption = '', ...rest] = chunk.text.trim().split('\n')
    const alt = /^（?图）?$/.test(caption.trim()) || !caption.trim() ? '图' : caption.trim()
    return [`> ![${alt.replace(/\[/g, '［').replace(/\]/g, '］')}](cite:${chunk.id})`, ...rest.filter(line => line.trim()).map(line => `> ${line.trim()}`)]
  }
  return chunk.text.trim().split('\n').map(line => (line.trim() ? `> ${line.trimEnd()}` : '>'))
}

/** Whether a paragraph of a lesson file is a quote box of source text. */
export function isOriginal(text: string): boolean {
  return /^>\s*\[!quote\]/.test(text.trim())
}
