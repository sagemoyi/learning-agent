// Handwriting photos read by a vision model (docs/assess/design.md, C). Three safeguards from stage 0
// (V9): the stem is never read from the photo (the program states it), every photo set is read twice and
// the differences are shown, and the learner confirms the reading before it is graded.
import { Recognition, type ReadingDifference } from '@learning-agent/contracts'

export const READER_SYSTEM = `你在转写学习者手写的解答照片。题干由程序给出，不要转写题干。
逐行转写照片里的解题过程：文字照写；公式用 LaTeX，行内写 $…$，单独一行的写 $$…$$；数字和单位照原样写。不要改正、补全或重新计算，写错的也照写。看不清的字写成 [?]。
再按答案栏把学习者写下的最后答案分别填好（数值带单位、选择题写选项字母、其余照写）；照片里没有的填空字符串。
文字和公式前后对不上的地方（例如文字写的物质和化学式不一致、同一个数前后写得不一样），以及看不清的地方，写进 doubts，一条一句。
只输出一个 JSON 对象：{"working":"转写的解题过程","finals":["第 1 个答案栏的答案"],"doubts":["没把握的地方"]}`

/** The prompt beside the photos: the stem as stored and the answer boxes to fill. */
export function readerPrompt(stem: string, boxes: readonly string[], photos: number): string {
  const listed = boxes.length > 1 ? boxes.map((label, index) => `${index + 1}. ${label}`).join('\n') : '只有一个答案栏'
  return `题目（程序给出，不用转写）：\n${stem}\n\n答案栏（finals 按这个顺序，共 ${boxes.length} 个）：\n${listed}\n\n照片共 ${photos} 张，按顺序是同一份解答。`
}

/** The model's reply as a reading, with as many finals as answer boxes. */
export function readingOf(reply: unknown, boxes: number): Recognition {
  const parsed = Recognition.parse(reply)
  return { working: parsed.working.trim(), finals: Array.from({ length: boxes }, (_, index) => (parsed.finals[index] ?? '').trim()), doubts: parsed.doubts.map(doubt => doubt.trim()).filter(Boolean) }
}

const SYMBOLS: Readonly<Record<string, string>> = {
  times: '×', cdot: '·', div: '÷', pi: 'π', rho: 'ρ', mu: 'μ', nu: 'ν', lambda: 'λ', Delta: 'Δ', delta: 'δ', alpha: 'α', beta: 'β', gamma: 'γ',
  theta: 'θ', zeta: 'ζ', eta: 'η', xi: 'ξ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', omega: 'ω', epsilon: 'ε', varepsilon: 'ε',
  approx: '≈', le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠', infty: '∞', circ: '°', degree: '°', pm: '±', to: '→', rightarrow: '→',
  Rightarrow: '⇒', sqrt: '√', sum: 'Σ', partial: '∂', left: '', right: '', displaystyle: '',
}
const WIDE: Readonly<Record<string, string>> = { '，': ',', '；': ';', '：': ':', '（': '(', '）': ')', '＝': '=', '＋': '+', '－': '-', '²': '^2', '³': '^3', '⁻': '^-', '¹': '1' }

/**
 * A reading as plain text, so two readings compare by what they say rather than how they write it:
 * `\text{mm}` and `\mathrm{mm}`, `$` and `$$`, `，` and `,`, `m³` and `m^{3}` read the same.
 */
export function plainOf(text: string): string {
  const wrap = (part: string) => (/^[\p{L}\p{N}.]+$/u.test(part.trim()) ? part.trim() : `(${part.trim()})`)
  return text
    .replace(/\\(?:text|mathrm|mathit|mathbf|operatorname|rm|it|bf)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\(?:[,;:!]|quad|qquad)|\\ /g, ' ')
    // Symbols first, so a fraction of symbols reads like one of letters.
    .replace(/\\([A-Za-z]+)/g, (whole, name: string) => (/^[dt]?frac$/.test(name) ? whole : SYMBOLS[name] ?? name))
    .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, top: string, bottom: string) => `${wrap(top)}/${wrap(bottom)}`)
    .replace(/[，；：（）＝＋－²³⁻¹]/g, char => WIDE[char]!)
    .replace(/[{}$]/g, '')
    .replace(/[ \t]+/g, ' ')
}

interface Token {
  readonly text: string
  readonly start: number
  readonly end: number
}

/** LaTeX commands, numbers, Latin words, single CJK characters and single symbols; spaces are not compared. */
function tokens(text: string): Token[] {
  return [...text.matchAll(/\\[A-Za-z]+|\d+(?:\.\d+)?|[A-Za-z]+|\S/gu)].map(match => ({ text: match[0], start: match.index!, end: match.index! + match[0].length }))
}

/** Longer readings are not compared token by token (the table would be too large); they count as one difference. */
const MAX_TOKENS = 3000
const MAX_DIFFERENCES = 30
const CONTEXT = 12

/**
 * Where two readings of the working differ, as runs of differing tokens with a little context, all in plain
 * text (see `plainOf`): notation that differs but says the same is not a difference.
 */
export function differencesOf(firstReading: string, secondReading: string): ReadingDifference[] {
  const [first, second] = [plainOf(firstReading), plainOf(secondReading)]
  const a = tokens(first)
  const b = tokens(second)
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return first.replace(/\s+/g, '') === second.replace(/\s+/g, '') ? [] : [{ first: '（解答较长，没有逐字比较）', second: '两次识别不完全一样，请对照照片通读一遍', before: '', after: '' }]
  }
  // Longest common subsequence, then walk it to collect the runs that differ.
  const width = b.length + 1
  const table = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i]!.text === b[j]!.text ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const runs: ReadingDifference[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i]!.text === b[j]!.text) {
      i++
      j++
      continue
    }
    const [fromA, fromB] = [i, j]
    while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && a[i]!.text === b[j]!.text)) {
      if (j >= b.length || (i < a.length && table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) i++
      else j++
    }
    const startA = fromA < a.length ? a[fromA]!.start : first.length
    const endA = i > fromA ? a[i - 1]!.end : startA
    runs.push({
      first: first.slice(startA, endA),
      second: j > fromB ? second.slice(b[fromB]!.start, b[j - 1]!.end) : '',
      before: first.slice(Math.max(0, startA - CONTEXT), startA).replace(/\s+/g, ' ').trimStart(),
      after: first.slice(endA, endA + CONTEXT).replace(/\s+/g, ' ').trimEnd(),
    })
    if (runs.length >= MAX_DIFFERENCES) break
  }
  return runs
}

/** Differences between two readings: the working, then each answer box that reads differently. */
export function compareReadings(first: Recognition, second: Recognition): ReadingDifference[] {
  const same = (a: string, b: string) => plainOf(a).replace(/\s+/g, '') === plainOf(b).replace(/\s+/g, '')
  const boxes = first.finals.flatMap((answer, box) => (same(answer, second.finals[box] ?? '') ? [] : [{ box, first: answer, second: second.finals[box] ?? '', before: '', after: '' }]))
  return [...differencesOf(first.working, second.working), ...boxes]
}

/** Image type by the file's first bytes; anything else is refused. */
export function photoType(data: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | undefined {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (String.fromCharCode(...data.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return undefined
}

export const PHOTO_EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const
