// Textbook exercises as library parsed them: a numbered stem (`1-25 …`) in an exercise section,
// possibly continued over several blocks and pages, figures in between, and the printed answer in
// brackets at the end (`[336m]`, `[（1）484.8Pa；（2）480.7Pa]`). Reading the exercise from the source
// keeps the stem, the number and the printed answer exactly as printed, instead of the teacher's copy.
import type { AnswerPart, CitedChunk, Problem, SingleAnswer } from '@learning-agent/contracts'
import { splitQuantity, unitOf } from './units.ts'

/** Sections that hold exercises; review questions are short and conceptual. */
export const EXERCISE_SECTIONS = ['习题', '复习思考题', '思考题'] as const

const STEM = /^\s*(\d+-\d+)\s*/
const PRINTED = /\[\s*([^[\]]+?)\s*\]\s*$/

export interface FoundExercise {
  readonly ref: string
  readonly sourceId: string
  /** The stem without its number and printed answer. */
  readonly stem: string
  /** The printed answer, without brackets; absent when the book prints none. */
  readonly printed?: string
  readonly figures: readonly string[]
  /** The stem's first chunk: the citation for the problem. */
  readonly chunk: CitedChunk
  /** 复习思考题 and the like: conceptual questions. */
  readonly review: boolean
}

/** Group a source's exercise-section chunks into exercises, in reading order. */
export function exercisesOf(chunks: readonly CitedChunk[]): FoundExercise[] {
  const found: FoundExercise[] = []
  let current: { ref: string; chunk: CitedChunk; texts: string[]; figures: string[]; section: string; answer?: string } | undefined
  const close = () => {
    if (!current) return
    const joined = current.texts.join('\n\n').trim()
    const printed = current.answer ?? PRINTED.exec(joined)?.[1]
    const stem = (current.answer ? joined : joined.replace(PRINTED, '')).replace(STEM, '').trim()
    found.push({
      ref: current.ref,
      sourceId: current.chunk.sourceId,
      stem,
      ...(printed?.trim() ? { printed: printed.trim() } : {}),
      figures: current.figures,
      chunk: current.chunk,
      review: !current.section.endsWith('习题'),
    })
    current = undefined
  }
  for (const chunk of chunks) {
    const section = chunk.section.join(' › ')
    if (!EXERCISE_SECTIONS.some(name => chunk.section.at(-1)?.startsWith(name))) {
      close()
      continue
    }
    if (chunk.kind === 'heading') {
      close()
      continue
    }
    const stem = STEM.exec(chunk.text)
    if (stem && (chunk.kind === 'exercise' || chunk.kind === 'text')) {
      close()
      current = { ref: stem[1]!, chunk, texts: [chunk.text], figures: [], section }
      continue
    }
    if (!current || current.section !== section) continue
    if (chunk.kind === 'figure') current.figures.push(chunk.id)
    else if (chunk.kind === 'answer') current.answer = PRINTED.exec(chunk.text)?.[1] ?? chunk.text.replace(/^\s*\[|\]\s*$/g, '')
    else current.texts.push(chunk.kind === 'formula' && !chunk.text.startsWith('$') ? `$$\n${chunk.text}\n$$` : chunk.text)
  }
  close()
  return found
}

/** Part markers in printed answers: ①②③, （1）(2), 1)… */
const MARKER = /(?:^|[；;，,\s])\s*(①|②|③|④|⑤|⑥|⑦|⑧|[（(]\s*\d+\s*[)）])\s*/g
const CIRCLED = '①②③④⑤⑥⑦⑧'

/** The printed answer split into labelled parts; one unlabelled part when it has no markers. */
export function printedParts(printed: string): { label: string; text: string }[] {
  const markers = [...printed.matchAll(MARKER)]
  if (markers.length < 2) return [{ label: '', text: printed.trim() }]
  return markers.map((match, index) => {
    const start = match.index! + match[0].length
    const end = markers[index + 1]?.index ?? printed.length
    const raw = match[1]!
    const number = CIRCLED.includes(raw) ? CIRCLED.indexOf(raw) + 1 : Number(raw.replace(/\D/g, ''))
    return { label: `（${number}）`, text: printed.slice(start, end).replace(/^[\s；;，,]+|[\s；;，,]+$/g, '') }
  })
}

/**
 * One printed answer → a gradable answer: `number unit` (unit known to the converter, or none)
 * becomes numeric with the default 2 % tolerance; anything else (words, alternatives, "略") is
 * graded by the model against the answer text (printed, or the teacher's when the book prints none).
 */
export function answerOfPrinted(text: string): SingleAnswer {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  const quantity = splitQuantity(cleaned)
  const unit = quantity.unit.replace(/^\$|\$$/g, '').trim()
  const wordy = /[一-龥]/.test(unit.replace(/[块台根个次层级]/g, '')) || /[，,；;或]/.test(unit)
  const startsWithNumber = /^[-+]?(?:\d|\.\d|\$\s*[-+]?\d)/.test(cleaned)
  if (quantity.value !== undefined && startsWithNumber && !wordy && (!unit || unitOf(unit) || /^[块台根个次层级%]$/.test(unit))) {
    return { kind: 'numeric', value: quantity.value, unit: unit === '%' ? '%' : unit, tolerance: { relative: 0.02 } }
  }
  return { kind: 'open', rubric: `参考答案：${cleaned}` }
}

/** The printed answer as a problem answer: several parts when the book labels them. */
export function answerFromPrinted(printed: string): Problem['answer'] {
  const parts = printedParts(printed)
  if (parts.length === 1) return answerOfPrinted(parts[0]!.text)
  return { kind: 'parts', parts: parts.map((part): AnswerPart => ({ label: part.label, answer: answerOfPrinted(part.text) })) }
}

/** `1-1~1-10, 2-3, 2-5～2-7` → every number it names (ranges stay within one chapter). */
export function expandRefs(text: string): { refs: string[]; bad: string[] } {
  const refs: string[] = []
  const bad: string[] = []
  for (const piece of text.replace(/\s*([~～—–])\s*/g, '$1').split(/[,，、;；\s]+/).map(part => part.trim()).filter(Boolean)) {
    const range = /^(\d+)-(\d+)\s*[~～—–-]\s*(?:(\d+)-)?(\d+)$/.exec(piece)
    if (range) {
      const [, chapter, from, toChapter, to] = range
      if (toChapter && toChapter !== chapter) { bad.push(piece); continue }
      const [a, b] = [Number(from), Number(to)]
      if (b < a || b - a > 200) { bad.push(piece); continue }
      for (let n = a; n <= b; n++) refs.push(`${chapter}-${n}`)
    } else if (/^\d+-\d+$/.test(piece)) refs.push(piece)
    else bad.push(piece)
  }
  return { refs: [...new Set(refs)], bad }
}
