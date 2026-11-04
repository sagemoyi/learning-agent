// The grading sample set through the grader model: only the answers rules cannot judge, with the real prompts and the
// real reading of the reply. Costs money, so it runs only when asked, when the prompt or the model changes and the
// learner agrees (docs/assess/design.md, 判分):
//   . .tools/dsh-env.sh && GRADING_MODEL=1 pnpm vitest run tests/assess/grading-model.test.ts
// DEEPSEEK_API_KEY comes from the environment; the optional DEEPSEEK_BASE_URL too. Synthetic problems only.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Answer, type Grading, type Id } from '@learning-agent/contracts'
import { answerParts, judgeByRule } from '../../packages/assess/src/grading.ts'
import { FIXTURES, createHarness } from '../harness.ts'

type Truth = 'right' | 'unit' | 'part' | 'wrong'
interface Sample { readonly finals?: readonly string[]; readonly text?: string; readonly truth: Truth }
interface Problem { readonly id: string; readonly stem: string; readonly answer: unknown; readonly answers: readonly Sample[] }

const { problems } = JSON.parse(readFileSync(join(FIXTURES, 'grading-samples.json'), 'utf8')) as { problems: Problem[] }
const MODEL = process.env.GRADING_MODEL_NAME ?? 'deepseek-flash'
const BASE = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic').replace(/\/$/, '')

async function realModel(system: string, prompt: string): Promise<string> {
  const response = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.DEEPSEEK_API_KEY ?? '', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, thinking: { type: 'enabled' }, system, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) throw new Error(`模型服务回复 ${response.status}`)
  const reply = await response.json() as { content: { type: string; text?: string }[] }
  return reply.content.filter(part => part.type === 'text').map(part => part.text).join('')
}

/** Answers the rules leave to the model. */
const needsModel = (problem: Problem, sample: Sample) => {
  const parts = answerParts(Answer.parse(problem.answer))
  return parts.some((part, index) => !judgeByRule(part.answer, (sample.finals ?? [sample.text ?? ''])[index] ?? ''))
}

const RANK = { none: 0, some: 1, method: 2, full: 3 } as const
const WANTED: Record<Truth, keyof typeof RANK> = { right: 'full', unit: 'method', part: 'some', wrong: 'none' }
const creditOf = (grading: Grading): keyof typeof RANK | 'review' =>
  grading.verdict === 'pending-review' ? 'review' : grading.verdict === 'correct' ? 'full' : grading.verdict === 'incorrect' ? 'none' : grading.partial === 'unit' ? 'method' : 'some'

describe.skipIf(!process.env.GRADING_MODEL)('grading samples through the grader model', () => {
  const h = createHarness(call => {
    if (call.purpose !== 'learning-grade') throw new Error(`unexpected model call: ${call.purpose}`)
    return realModel(call.system ?? '', call.prompt)
  })
  afterAll(() => h.dispose())

  it('never takes a wrong answer for right', async () => {
    const { ctx, endpoint } = h
    const course = await endpoint('core', 'createCourse', { title: '判分样例（合成）' })
    const graph = await ctx.learnKnowledge.add(course.id, { nodes: [{ title: '判分样例', kind: 'skill' }] }, { actor: 'teacher', reason: '判分样例（合成）' })
    const nodeId = graph.nodes[0]!.id as Id<'node'>
    const lines: string[] = []
    const tooMuch: string[] = []
    const tooLittle: string[] = []
    let review = 0
    for (const problem of problems) {
      const samples = problem.answers.filter(sample => needsModel(problem, sample))
      if (!samples.length) continue
      const [added] = ctx.learnAssess.addProblems([{ stem: problem.stem, answer: Answer.parse(problem.answer), answerSource: 'unverified', tier: 4, origin: { kind: 'agent' }, nodeIds: [nodeId], pool: 'practice' }] as never, course.id)
      for (const sample of samples) {
        const test = ctx.learnAssess.startTest({ courseId: course.id, kind: 'practice', problemIds: [added!.id] })
        await endpoint('assess', 'submit', { testId: test.id, answers: [{ problemId: added!.id, text: sample.text ?? '', finals: sample.finals ?? [sample.text ?? ''] }] })
        await h.settle()
        const grading = (await endpoint('assess', 'view', { testId: test.id })).attempts[0].grading as Grading
        const got = creditOf(grading)
        const label = `${problem.id}: ${(sample.finals ?? [sample.text!]).join(' | ').slice(0, 40)}（${sample.truth}）`
        lines.push(`${label} → ${grading.verdict}${grading.confidence ? `/${grading.confidence}` : ''}，${(grading.rationale ?? '').replaceAll('\n', ' ').slice(0, 80)}`)
        if (got === 'review') review++
        else if (RANK[got] > RANK[WANTED[sample.truth]]) tooMuch.push(label)
        else if (RANK[got] < RANK[WANTED[sample.truth]]) tooLittle.push(label)
      }
    }
    console.log(`判分样例集（${MODEL}）：${lines.length} 个作答交给模型，错的判成对 ${tooMuch.length}，对的判低了 ${tooLittle.length}，待复核 ${review}\n${lines.join('\n')}`)
    expect(lines.length).toBeGreaterThan(0)
    expect(tooMuch).toEqual([])
    // A right answer marked down is an error; how much credit a half-right answer earns is a judgement, and is only printed.
    expect(tooLittle.filter(label => label.endsWith('（right）'))).toEqual([])
  }, 900_000)
})
