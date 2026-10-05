// assess unit, host half. Provides `ctx.learnAssess` (contracts §5.1): problem bank, tests,
// attempts, grading. Numeric and choice answers are graded by rule; open answers by the model,
// with its confidence (low → pending review, never "wrong"). Every grading is appended to the
// evidence log, which is what mastery is computed from.
// Skeleton: no swap/report flow, no handwriting, no adaptive diagnostic yet (PLAN §4.3, §5).
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  Grading,
  newId,
  type LearnAssess,
  type NewProblem,
  type Problem,
  type StartTestInput,
  type Test,
  type TestView,
} from '@learning-agent/contracts'
import { complete, must, now, parseJsonReply } from '@learning-agent/kit'
import { roleModel, Schema } from '@learning-agent/kit/settings'
import { z } from 'zod'
import { answerText, gradeByRule } from './grading.ts'
import { AssessStore, assessMigrations } from './store.ts'

export const name = 'learning-assess'
export const inject = ['learnCore', 'llm', 'sessionController']

export const Config = Schema.object({
  model: roleModel('判分'),
})
export type Config = ReturnType<typeof Config>

const GRADER_SYSTEM = `你是化工原理课程的判分助手。只根据给出的题目、参考答案或评分标准判断学习者的作答，不要自己补充知识。
只输出一个 JSON 对象：{"verdict":"correct|partial|incorrect","score":0到1之间的数,"confidence":"high|medium|low","rationale":"一两句中文理由"}。
看不懂作答、或参考答案本身可疑时，confidence 用 low。`

const KIND_LABEL: Record<Test['kind'], string> = { diagnostic: '摸底', quiz: '小测', practice: '练习', stage: '阶段测试', review: '复查', mock: '模拟考' }
const VERDICT_LABEL = { correct: '对', partial: '部分对', incorrect: '错', 'pending-review': '待复核' } as const

class LearnAssessService extends Service implements LearnAssess {
  readonly store: AssessStore

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'learnAssess')
    ctx.learnCore.db.migrate('assess', assessMigrations)
    this.store = new AssessStore(ctx.learnCore)
  }

  addProblems = (problems: readonly NewProblem[]) => this.store.addProblems(problems)
  problem = (problemId: string) => this.store.problem(problemId)
  problems = (filter: { readonly nodeIds?: readonly string[]; readonly pool?: Problem['pool'] }) => this.store.problems(filter)
  startTest = (input: StartTestInput) => this.store.startTest(input)
  view = (testId: string) => this.store.view(testId)
  tests = (courseId: string, filter?: { readonly lessonId?: string; readonly kind?: Test['kind'] }) => this.store.tests(courseId, filter)

  /** Model grading for expression and open answers. */
  private async gradeByModel(problem: Problem, text: string, signal?: AbortSignal): Promise<Grading> {
    try {
      const reply = await complete(this.ctx, {
        system: GRADER_SYSTEM,
        prompt: `题目：\n${problem.stem}\n\n${problem.answer.kind === 'open' ? '评分标准' : '参考答案'}：\n${answerText(problem.answer)}\n\n学习者的作答：\n${text || '（空）'}`,
        purpose: 'learning-grade',
        model: this.config.model.get(),
        maxTokens: 4000,
        ...(signal ? { signal } : {}),
      })
      const parsed = Grading.omit({ method: true }).parse(parseJsonReply(reply))
      const grading: Grading = { ...parsed, method: 'llm' }
      return grading.confidence === 'low' ? { ...grading, verdict: 'pending-review' } : grading
    } catch (error) {
      return { verdict: 'pending-review', method: 'llm', confidence: 'low', rationale: `自动判分失败，待复核：${(error as Error).message}` }
    }
  }

  async submit(testId: string, answers: readonly { readonly problemId: string; readonly text: string }[], signal?: AbortSignal): Promise<TestView> {
    const test = must(this.store.test(testId), 'assess', '测试', testId)
    if (test.status !== 'open') return this.store.view(testId)!
    const byProblem = new Map(answers.map(answer => [answer.problemId, answer.text]))
    const context = {
      testId: test.id,
      ...(test.stageId ? { stageId: test.stageId } : {}),
      ...(test.lessonId ? { lessonId: test.lessonId } : {}),
    }
    for (const problemId of test.problemIds) {
      const problem = must(this.store.problem(problemId), 'assess', '题目', problemId)
      const text = byProblem.get(problemId)?.trim() ?? ''
      const attempt = { id: newId('attempt'), problemId: problem.id, testId: test.id, courseId: test.courseId, text, images: [], submittedAt: now() }
      const grading = gradeByRule(problem.answer, text) ?? await this.gradeByModel(problem, text, signal)
      this.ctx.learnCore.db.transaction(() => {
        this.store.addAttempt(attempt)
        const entry = this.ctx.learnCore.log.append({
          type: 'attempt.graded',
          courseId: test.courseId,
          nodeIds: problem.nodeIds,
          context,
          attemptId: attempt.id,
          problemId: problem.id,
          testKind: test.kind,
          conditions: test.conditions,
          grading,
        })
        this.store.cacheGrading(attempt.id, entry.id, grading)
      })
    }
    const graded: Test = { ...test, status: 'graded', endedAt: now() }
    this.store.saveTest(graded)
    this.ctx.emit('learning/test-finished', { test: graded })
    const marks = this.store.attempts(testId).map(attempt => VERDICT_LABEL[attempt.grading?.verdict ?? 'pending-review'])
    this.ctx.emit('learning/handoff', { courseId: test.courseId, unit: 'assess', text: `学习者交了${KIND_LABEL[test.kind]}（${test.problemIds.length} 题），判分：${marks.join('、')}。用 get_test_result 看详情。` })
    return this.store.view(testId)!
  }
}

export function apply(ctx: Context, config: Config): void {
  const assess = new LearnAssessService(ctx, config)
  const endpoint = ctx.learnCore.api.endpoint

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'view',
    input: z.object({ testId: z.string() }),
    handle: ({ testId }) => must(assess.view(testId), 'assess', '测试', testId),
  }), 'assess: view')

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'tests',
    input: z.object({ courseId: z.string() }),
    handle: ({ courseId }) => assess.tests(courseId).map(test => {
      const attempts = test.status === 'graded' ? assess.store.attempts(test.id) : []
      const correct = attempts.filter(attempt => attempt.grading?.verdict === 'correct').length
      return { test, correct, total: test.problemIds.length }
    }),
  }), 'assess: tests')

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'submit',
    input: z.object({ testId: z.string(), answers: z.array(z.object({ problemId: z.string(), text: z.string().max(20_000) })) }),
    handle: ({ testId, answers }, signal) => assess.submit(testId, answers, signal),
  }), 'assess: submit')

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const tests = assess.tests(request.courseId).slice(-5)
    if (tests.length === 0) return [...sections, { unit: 'assess', title: '测试', text: '还没有做过测试。' }]
    const lines = tests.map(test => {
      if (test.status !== 'graded') return `- ${test.id} ${KIND_LABEL[test.kind]}：进行中（${test.problemIds.length} 题）`
      const attempts = assess.store.attempts(test.id)
      const marks = attempts.map(attempt => VERDICT_LABEL[attempt.grading?.verdict ?? 'pending-review'])
      return `- ${test.id} ${KIND_LABEL[test.kind]}：已判分（${marks.join('、')}）`
    })
    return [...sections, { unit: 'assess', title: '最近的测试', text: lines.join('\n') }]
  })

  ctx.on('learning/describe-selection', async (selection, next) => {
    const lines = await next()
    const picked = selection.selected
    if (picked?.kind === 'problem' && picked.id) {
      const problem = assess.problem(picked.id)
      if (problem) lines.push(`选中的题目（${problem.id}）：\n${problem.stem}`)
    }
    return lines
  })
}
