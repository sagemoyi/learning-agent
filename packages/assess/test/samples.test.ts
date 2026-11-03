// The grading sample set (docs/assess/design.md, 判分): synthetic chemical-engineering problems with checked answers and
// near misses (tests/fixtures/grading-samples.json), through rule grading on every run. Rules never take a wrong
// answer or one missing its unit for right, and never call a right one wrong; what they cannot show goes to review or
// to the grader model, and the counts are printed. The model's own run needs the learner's consent (it costs money).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Answer, type Grading } from '@learning-agent/contracts'
import { answerParts, combine, judgeByRule } from '../src/grading.ts'

type Truth = 'right' | 'unit' | 'part' | 'wrong'
interface Sample { readonly id: string; readonly topic: string; readonly answer: unknown; readonly answers: readonly { readonly finals?: readonly string[]; readonly text?: string; readonly truth: Truth }[] }

const { problems } = JSON.parse(readFileSync(join(import.meta.dirname, '../../../tests/fixtures/grading-samples.json'), 'utf8')) as { problems: Sample[] }

/** The rules' grading of the answer boxes, or undefined when a part needs the model. */
function byRule(answer: Answer, finals: readonly string[]): Grading | undefined {
  const parts = answerParts(answer).map((part, index) => {
    const judged = judgeByRule(part.answer, finals[index] ?? '')
    return judged && { label: part.label, ...judged, method: 'rule' as const, confidence: 'high' as const }
  })
  return parts.every(Boolean) ? combine(parts as NonNullable<(typeof parts)[number]>[]) : undefined
}

/** What a grading gives for the truth: full credit, credit for the method, or none. */
function credit(grading: Grading): 'full' | 'method' | 'some' | 'none' | 'review' {
  if (grading.verdict === 'pending-review') return 'review'
  if (grading.verdict === 'correct') return 'full'
  if (grading.verdict === 'incorrect') return 'none'
  return grading.partial === 'unit' ? 'method' : 'some'
}
const EXPECTED: Record<Truth, ReturnType<typeof credit>> = { right: 'full', unit: 'method', part: 'some', wrong: 'none' }

it('grades the sample set by rule without taking a wrong answer for right', () => {
  const counts = { graded: 0, falseRight: [] as string[], falseWrong: [] as string[], review: 0, model: 0 }
  for (const problem of problems) {
    const answer = Answer.parse(problem.answer)
    for (const sample of problem.answers.filter(item => item.finals)) {
      const label = `${problem.id}: ${sample.finals!.join(' | ')}`
      const grading = byRule(answer, sample.finals!)
      if (!grading) { counts.model++; continue }
      const got = credit(grading)
      if (got === 'review') { counts.review++; continue }
      counts.graded++
      // More credit than the answer earns is the error that matters most; less is the next.
      const rank = { none: 0, some: 1, method: 2, full: 3 } as const
      if (rank[got] > rank[EXPECTED[sample.truth] as keyof typeof rank]) counts.falseRight.push(`${label} → ${grading.verdict}`)
      else if (got !== EXPECTED[sample.truth]) counts.falseWrong.push(`${label} → ${grading.verdict}`)
    }
  }
  const total = counts.graded + counts.review + counts.model
  console.log(`判分样例集（规则）：${total} 个作答，规则判了 ${counts.graded}，错的判成对 ${counts.falseRight.length}，对的判成错 ${counts.falseWrong.length}，待复核 ${counts.review}，交给模型 ${counts.model}`)
  expect(counts.falseRight).toEqual([])
  expect(counts.falseWrong).toEqual([])
  // Still graded by the program for the most part: review and the model are the exception.
  expect(counts.graded / total).toBeGreaterThan(0.8)
})
