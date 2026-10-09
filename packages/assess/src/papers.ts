// Past papers as library parsed them (docs/assess/design.md, C): sections like "三、计算题（每题 15 分，
// 共 45 分）" give the question type and points, numbered questions under them ("1." "2．") are the
// problems, numbered `三-2`. A key after a "参考答案" heading gives the answers by the same numbers.
// Reading the paper keeps the stems as printed instead of the teacher's copy, like textbook exercises.
import type { CitedChunk } from '@learning-agent/contracts'
import type { FoundExercise } from './exercises.ts'

const SECTION = /^\s*([一二三四五六七八九十]{1,3})\s*[、.．]\s*(.+)$/
/** "1." "2、" "3．", not "1.5" or "1-2". */
const QUESTION = /^\s*(\d{1,2})\s*[.．、](?!\d)\s*/
const KEY_HEADING = /^\s*(?:[一二三四五六七八九十]{1,3}\s*[、.．]\s*)?(?:参考答案|答案|评分标准|参考解答)/
const EACH = /每(?:小)?题\s*(\d+(?:\.\d+)?)\s*分/
const OWN_POINTS = /^[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[)）]\s*/
const OPTION = /(?:^|\s|\n)([A-F])\s*[.．、]\s*/g

/** A paper question: an exercise with its section's type and its points, and the options of a choice. */
export interface PaperQuestion extends FoundExercise {
  readonly type: string
  readonly points?: number
  /** A choice question's options, and its stem without them (used when the key names an option). */
  readonly options?: readonly string[]
  readonly choiceStem?: string
}

/** "填空题（每空 1 分，共 20 分）" → 填空题, "计算题" → 计算题; the words before the first 题. */
function typeOf(title: string): string {
  const head = title.replace(/[（(].*$/, '').trim()
  const at = head.indexOf('题')
  return (at >= 0 ? head.slice(0, at + 1) : head).trim() || head
}

/** Options printed in the stem ("A. … B. …"), when they run A, B, C… in order. */
function splitOptions(text: string): { stem: string; options: string[] } | undefined {
  const marks: RegExpExecArray[] = []
  for (const match of text.matchAll(OPTION)) if (match[1] === String.fromCharCode(65 + marks.length)) marks.push(match)
  if (marks.length < 2) return undefined
  const options = marks.map((match, index) => text.slice(match.index! + match[0].length, marks[index + 1]?.index ?? text.length).trim())
  return { stem: text.slice(0, marks[0]!.index!).trim(), options }
}

/** Answers on one line of the key: "1. B 2. C" or "1.（1）0.5 m/s；（2）…". */
function answersOnLine(line: string): { number: string; text: string }[] {
  const marks = [...line.matchAll(/(?:^|\s)(\d{1,2})\s*[.．、](?!\d)\s*/g)]
  return marks.map((match, index) => ({ number: match[1]!, text: line.slice(match.index! + match[0].length, marks[index + 1]?.index ?? line.length).trim() }))
}

/** The questions of one past paper in reading order, with the key's answers where it has them. */
export function paperQuestionsOf(chunks: readonly CitedChunk[]): PaperQuestion[] {
  type Open = { ref: string; chunk: CitedChunk; lines: string[]; figures: string[]; type: string; points?: number }
  const questions: Open[] = []
  const answers = new Map<string, string>()
  let section: { numeral: string; type: string; each?: number } | undefined
  let current: Open | undefined
  let inKey = false
  let lastAnswer: string | undefined
  for (const chunk of chunks) {
    if (chunk.kind === 'figure') {
      if (current && !inKey) current.figures.push(chunk.id)
      continue
    }
    for (const line of chunk.text.split(/\n+/)) {
      if (!line.trim()) continue
      if (KEY_HEADING.test(line) && line.trim().length <= 20) {
        inKey = true
        current = undefined
        section = undefined
        continue
      }
      const heading = SECTION.exec(line)
      if (heading && !QUESTION.test(line)) {
        section = { numeral: heading[1]!, type: typeOf(heading[2]!), ...(EACH.exec(heading[2]!) ? { each: Number(EACH.exec(heading[2]!)![1]) } : {}) }
        current = undefined
        lastAnswer = undefined
        continue
      }
      if (!section) continue
      if (inKey) {
        const found = answersOnLine(line)
        if (found.length === 0 && lastAnswer) answers.set(lastAnswer, `${answers.get(lastAnswer)}\n${line.trim()}`)
        for (const answer of found) {
          lastAnswer = `${section.numeral}-${answer.number}`
          answers.set(lastAnswer, answer.text)
        }
        continue
      }
      const number = QUESTION.exec(line)
      if (number) {
        let rest = line.slice(number[0].length)
        const own = OWN_POINTS.exec(rest)
        if (own) rest = rest.slice(own[0].length)
        const points = own ? Number(own[1]) : section.each
        current = { ref: `${section.numeral}-${number[1]}`, chunk, lines: [rest], figures: [], type: section.type, ...(points !== undefined ? { points } : {}) }
        questions.push(current)
        continue
      }
      if (current) current.lines.push(chunk.kind === 'formula' && !line.startsWith('$') ? `$$\n${line}\n$$` : line)
    }
  }
  const seen = new Set<string>()
  return questions.flatMap((question): PaperQuestion[] => {
    // A paper printed twice (a parse artefact): the first copy counts.
    if (seen.has(question.ref)) return []
    seen.add(question.ref)
    const text = question.lines.join('\n').trim()
    const choice = /选择/.test(question.type) ? splitOptions(text) : undefined
    const printed = answers.get(question.ref)?.trim()
    return [{
      ref: question.ref,
      sourceId: question.chunk.sourceId,
      stem: text,
      ...(printed ? { printed } : {}),
      figures: question.figures,
      chunk: question.chunk,
      review: false,
      type: question.type,
      ...(question.points !== undefined ? { points: question.points } : {}),
      ...(choice ? { options: choice.options, choiceStem: choice.stem } : {}),
    }]
  })
}

/** A choice key ("B", "A C", "BD") as option indexes, when every letter names an option. */
export function choiceKey(printed: string, options: readonly string[]): number[] | undefined {
  const letters = printed.replace(/[\s,，、;；和]/g, '').toUpperCase()
  if (!/^[A-F]+$/.test(letters)) return undefined
  const indexes = [...new Set(letters.split('').map(letter => letter.charCodeAt(0) - 65))].sort((a, b) => a - b)
  return indexes.every(index => index < options.length) ? indexes : undefined
}

/** `三-2` style numbers in the order a paper prints them, compacted: 一-1~一-10、二-1~二-3. */
export function paperRefs(questions: readonly { readonly ref: string }[]): string {
  const runs: string[] = []
  for (let i = 0; i < questions.length;) {
    const [part, first] = questions[i]!.ref.split('-') as [string, string]
    let j = i
    while (j + 1 < questions.length && questions[j + 1]!.ref === `${part}-${Number(questions[j]!.ref.split('-')[1]) + 1}`) j++
    runs.push(j > i ? `${part}-${first}~${questions[j]!.ref}` : questions[i]!.ref)
    i = j + 1
  }
  return runs.join('、')
}
