// The points of a lesson (docs/textbook/design.md, 讲解与原文): one model call splits the section's material
// into a few points, each a run of consecutive chunks, and says what the chapter's exercises need the
// learner to know. The program owns the shape: every chunk belongs to one point, in reading order, and a
// worked example stays in one point with its solution. The writer later sees what is needed, never the
// exercises themselves.
import type { CitedChunk } from '@learning-agent/contracts'
import { materialSize, planParts } from './format.ts'

/** Points per lesson, and the most material one point is written from. */
const MAX_POINTS = 8
const POINT_LIMIT = 12_000
/** Exercise stems shown when planning, and how much of each. */
const MAX_STEMS = 24
const STEM_CHARS = 300
/** Characters of each chunk in the plan's outline of the material. */
const OUTLINE_CHARS = 110

export interface Need {
  /** What doing the exercises needs, as something to learn. */
  readonly text: string
  /** The material says nothing about it: the gap is looked for elsewhere. */
  readonly covered: boolean
}

export interface Point {
  readonly title: string
  /** What the point has to make clear, in one sentence. */
  readonly focus: string
  /** A run of the lesson's material, in reading order. */
  readonly chunks: readonly CitedChunk[]
  readonly needs: readonly Need[]
}

export const PLAN_SYSTEM = `你为一位学习者规划一节教材怎么讲。给你本节资料的提纲（按顺序编号的片段，每段只列开头）、学习目标、阶段设计书的教学部分、学习者的掌握情况，以及本章的课后习题（只有题干，没有答案）。
1. 把本节资料按顺序分成 3 到 8 个要点（资料很短时可以只有 1 到 2 个）。每个要点是资料里连续的一段：from、to 是片段编号。按"学习者要弄懂的一件事"来分，不必和资料的小标题一一对应；例题和它的解答放在同一个要点里。title 是要点标题（简短，不带编号），focus 用一句话说这一点要讲清什么。
2. 从习题里挑出和本节有关的题，写出做这些题要会的概念、方法、装置或条件（needs），每条一句，写成要学的内容，不抄题目、不写题目里的数字。point 是它属于第几个要点；covered 表示本节资料有没有讲到（资料没讲、做题却要用的写 false）。和本节无关的题不用管；没有习题就给空数组。
只输出 JSON：{"points":[{"title":"…","focus":"…","from":1,"to":12}],"needs":[{"text":"…","point":1,"covered":true}]}`

const KIND: Record<string, string> = { heading: '小标题', text: '正文', formula: '公式', table: '表', figure: '图', example: '例题' }

/** The material as numbered lines: kind, subsection and the first words of each chunk. */
export function outlineOf(material: readonly CitedChunk[]): string {
  return material.map((chunk, index) => {
    const text = chunk.text.replace(/\s+/g, ' ').trim()
    const head = chunk.kind === 'heading' ? text : `${[...text].slice(0, OUTLINE_CHARS).join('')}${[...text].length > OUTLINE_CHARS ? '…' : ''}`
    return `[${index + 1}] ${KIND[chunk.kind] ?? chunk.kind} · ${head}`
  }).join('\n')
}

/** Exercise stems for planning: numbered, cut short, no answers. */
export function stemsOf(exercises: readonly CitedChunk[]): string[] {
  return exercises.slice(0, MAX_STEMS).map(chunk => {
    const text = chunk.text.replace(/\s+/g, ' ').trim()
    return [...text].length > STEM_CHARS ? `${[...text].slice(0, STEM_CHARS).join('')}…` : text
  })
}

export function planPrompt(input: { readonly context: string; readonly material: readonly CitedChunk[]; readonly stems: readonly string[]; readonly remedial: boolean }): string {
  return [
    input.context,
    input.remedial ? '# 补课\n这是补课课时：只为复盘里没过的地方列要点，可以只有 1 到 3 个，没过的地方之外的资料归到最近的要点里。' : '',
    `# 本节资料提纲（${input.material.length} 段）\n${outlineOf(input.material)}`,
    `# 本章课后习题（只有题干）\n${input.stems.length ? input.stems.map((stem, index) => `${index + 1}. ${stem}`).join('\n') : '（没有）'}`,
  ].filter(Boolean).join('\n\n')
}

const squeeze = (text: string) => text.replace(/[\s$\\{}_^]/g, '')

/** Whether `text` repeats a stretch of an exercise: what is needed is said in the writer's words, not the problem's. */
export function copiesStem(text: string, stems: readonly string[], run = 10): boolean {
  const own = squeeze(text)
  if (own.length < run) return false
  return stems.some(stem => {
    const other = squeeze(stem)
    for (let i = 0; i + run <= own.length; i += 1) if (other.includes(own.slice(i, i + run))) return true
    return false
  })
}

interface Range { from: number; to: number; title: string; focus: string; needs: Need[] }

/**
 * The points of a reply, shaped by the program; undefined when the reply gives no usable point.
 * Indexes in the reply are 1-based chunk numbers of `material`.
 */
export function readPlan(reply: unknown, material: readonly CitedChunk[], stems: readonly string[]): Point[] | undefined {
  const raw = (reply as { points?: unknown })?.points
  if (!Array.isArray(raw)) return undefined
  const n = material.length
  const ranges: (Range & { order: number })[] = []
  raw.forEach((item: { from?: unknown; to?: unknown; title?: unknown; focus?: unknown }, order) => {
    const from = Number(item?.from), to = Number(item?.to)
    const title = typeof item?.title === 'string' ? item.title.replace(/^#+\s*/, '').trim() : ''
    if (!Number.isInteger(from) || !Number.isInteger(to) || !title) return
    const start = Math.max(1, Math.min(from, to)), end = Math.min(n, Math.max(from, to))
    if (start > n) return
    ranges.push({ from: start - 1, to: end - 1, title, focus: typeof item?.focus === 'string' ? item.focus.trim() : '', needs: [], order })
  })
  if (ranges.length === 0) return undefined
  const needs = (reply as { needs?: unknown }).needs
  const list = Array.isArray(needs) ? needs as { text?: unknown; point?: unknown; covered?: unknown }[] : []
  const shaped = shape(ranges, material)
  for (const need of list) {
    const text = typeof need?.text === 'string' ? need.text.trim() : ''
    if ([...text].length < 2 || [...text].length > 80 || copiesStem(text, stems)) continue
    // The point the reply named, wherever its first chunk ended up after shaping.
    const named = ranges.find(range => range.order === Number(need.point) - 1)
    const target = (named && shaped.find(point => point.from <= named.from && named.from <= point.to)) ?? shaped[0]!
    if (!target.needs.some(item => item.text === text)) target.needs.push({ text, covered: need.covered !== false })
  }
  return split(shaped, material).map(range => ({ title: range.title, focus: range.focus, chunks: material.slice(range.from, range.to + 1), needs: range.needs }))
}

/** Points by subsection when there is no usable plan: the parts the material was written in before 10-15. */
export function fallbackPoints(material: readonly CitedChunk[], heading: string, limit: number): Point[] {
  let last = heading
  const ranges: Range[] = []
  let at = 0
  for (const part of planParts(material, limit)) {
    const first = part.find(chunk => chunk.kind === 'heading')
    const title = first ? first.text.replace(/^#+\s*/, '').trim() : `${last}（续）`
    last = title.replace(/（续）$/, '')
    ranges.push({ from: at, to: at + part.length - 1, title, focus: '', needs: [] })
    at += part.length
  }
  return shape(ranges, material).map(range => ({ title: range.title, focus: range.focus, chunks: material.slice(range.from, range.to + 1), needs: range.needs }))
}

/**
 * Ranges in order, without overlaps or holes, covering the material; a boundary is never inside a worked
 * example; at most `MAX_POINTS`, the smallest neighbours merged first.
 */
function shape(input: readonly Range[], material: readonly CitedChunk[]): Range[] {
  const n = material.length
  const sorted = [...input].sort((a, b) => a.from - b.from || a.to - b.to).map(range => ({ ...range, needs: [...range.needs] }))
  const out: Range[] = []
  for (const range of sorted) {
    const previous = out.at(-1)
    if (previous && range.from <= previous.to) range.from = previous.to + 1
    if (range.from > range.to) { previous?.needs.push(...range.needs); continue }
    out.push(range)
  }
  out[0]!.from = 0
  for (let i = 0; i + 1 < out.length; i += 1) out[i]!.to = out[i + 1]!.from - 1
  out.at(-1)!.to = n - 1
  for (let i = 0; i + 1 < out.length; i += 1) {
    const end = solutionEnd(material, out[i]!.to)
    if (end <= out[i]!.to) continue
    out[i]!.to = end
    // The next points start after the solution; one swallowed whole joins this one.
    while (out[i + 1] && out[i + 1]!.to <= end) { out[i]!.needs.push(...out[i + 1]!.needs); out.splice(i + 1, 1) }
    if (out[i + 1]) out[i + 1]!.from = end + 1
  }
  const size = (range: Range) => material.slice(range.from, range.to + 1).reduce((sum, chunk) => sum + materialSize(chunk), 0)
  while (out.length > MAX_POINTS) {
    let best = 0
    for (let i = 1; i + 1 < out.length; i += 1) if (size(out[i]!) + size(out[i + 1]!) < size(out[best]!) + size(out[best + 1]!)) best = i
    const [a, b] = [out[best]!, out[best + 1]!]
    out.splice(best, 2, { from: a.from, to: b.to, title: a.title, focus: [a.focus, b.focus].filter(Boolean).join('；'), needs: [...a.needs, ...b.needs] })
  }
  return out
}

/** Chunks that read as part of a solution: formulas, figures and the short steps between them. */
const STEP = /^\s*[（(]?\s*\d?\s*[）)]?\s*(?:解|所以|即|故|则|得|由|将|代入|因为|因|于是|边界条件|式中|其中)/

/**
 * Where a worked example running through `at` ends: the last chunk of the solution after the example, or
 * `at` itself when `at` is not inside one.
 */
function solutionEnd(material: readonly CitedChunk[], at: number): number {
  let example = -1
  for (let i = at; i >= 0; i -= 1) {
    const kind = material[i]!.kind
    if (kind === 'example') { example = i; break }
    if (kind === 'heading' || !inSolution(material[i]!)) return at
  }
  if (example < 0) return at
  let end = at
  while (end + 1 < material.length && inSolution(material[end + 1]!)) end += 1
  return end
}

function inSolution(chunk: CitedChunk): boolean {
  if (chunk.kind === 'formula' || chunk.kind === 'figure' || chunk.kind === 'table') return true
  return chunk.kind === 'text' && (STEP.test(chunk.text) || [...chunk.text.trim()].length <= 40)
}

/** A point with more material than one reply handles well is cut at its subsections, still in order. */
function split(ranges: readonly Range[], material: readonly CitedChunk[]): Range[] {
  return ranges.flatMap(range => {
    const chunks = material.slice(range.from, range.to + 1)
    if (chunks.reduce((sum, chunk) => sum + materialSize(chunk), 0) <= POINT_LIMIT) return [range]
    let at = range.from
    return planParts(chunks, POINT_LIMIT / 2).map((part, index) => {
      const piece = { ...range, from: at, to: at + part.length - 1, title: index ? `${range.title}（续）` : range.title, needs: index ? [] : range.needs }
      at += part.length
      return piece
    })
  })
}
