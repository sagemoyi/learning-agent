// assess unit, host half. Provides `ctx.learnAssess` (contracts §5.1): problem bank, tests,
// attempts, grading. Numeric and choice answers are graded by rule; open answers by the model,
// with its confidence (low → pending review, never "wrong"). Every grading is appended to the
// evidence log, which is what mastery is computed from.
// Textbook exercises are imported by number from library's parse (docs/assess/design.md, A); answers
// without a printed or authoritative source come from the restricted calculator.
// Not yet: swap/report flow, handwriting, adaptive diagnostic (docs/assess/design.md, B and C).
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  Grading,
  LearningApiError,
  newId,
  type AnswerCheck,
  type CalculationResult,
  type ExerciseImport,
  type ExerciseImportResult,
  type LearnAssess,
  type NewProblem,
  type Problem,
  type SingleAnswer,
  type StartTestInput,
  type SubmittedAnswer,
  type Test,
  type TestView,
} from '@learning-agent/contracts'
import { complete, must, now, parseJsonReply } from '@learning-agent/kit'
import { roleModel, Schema } from '@learning-agent/kit/settings'
import { z } from 'zod'
import { calculate, inUnit } from './calculator.ts'
import { answerFromPrinted, EXERCISE_SECTIONS, exercisesOf, expandRefs, type FoundExercise } from './exercises.ts'
import { answerParts, answerText, combine, judgeByRule } from './grading.ts'
import { AssessStore, assessMigrations } from './store.ts'
import { prettyUnit } from './units.ts'

export const name = 'learning-assess'
export const inject = ['learnCore', 'learnLibrary', 'llm', 'sessionController']

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
  problems = (filter: { readonly nodeIds?: readonly string[]; readonly pool?: Problem['pool']; readonly includeReview?: boolean }) => this.store.problems(filter)
  startTest = (input: StartTestInput) => this.store.startTest(input)
  view = (testId: string) => this.store.view(testId)
  tests = (courseId: string, filter?: { readonly lessonId?: string; readonly kind?: Test['kind'] }) => this.store.tests(courseId, filter)
  calculate = (script: string, results?: readonly string[]): CalculationResult => calculate(script, results)
  homework = (courseId: string) => this.store.homework(courseId)
  bank = (courseId: string, nodeIds: readonly string[]) => this.store.bank(courseId, nodeIds)

  /** The course sources' exercises by number; the skeleton textbook first, then the first source that has it. */
  private exercises(courseId: string): Map<string, FoundExercise[]> {
    const sources = this.ctx.learnLibrary.courseSources(courseId).sort((a, b) => Number(b.role === 'skeleton') - Number(a.role === 'skeleton'))
    const byRef = new Map<string, FoundExercise[]>()
    for (const { sourceId } of sources) {
      const chunks = EXERCISE_SECTIONS.flatMap(section => this.ctx.learnLibrary.section(sourceId, section))
      const seen = new Set<string>()
      for (const exercise of exercisesOf(chunks)) {
        // A source can print the same exercise twice (a parse artefact); the first one counts.
        if (seen.has(exercise.ref)) continue
        seen.add(exercise.ref)
        byRef.set(exercise.ref, [...(byRef.get(exercise.ref) ?? []), exercise])
      }
    }
    return byRef
  }

  importExercises(courseId: string, items: readonly ExerciseImport[]): ExerciseImportResult[] {
    const found = this.exercises(courseId)
    const homework = new Set(this.store.homework(courseId).map(mark => mark.ref))
    const planned = new Map<string, { practice: number; reserved: number }>()
    return items.map((item): ExerciseImportResult => {
      const ref = item.ref.trim()
      const exercise = (found.get(ref) ?? []).find(candidate => !item.sourceId || candidate.sourceId === item.sourceId)
      if (!exercise) return { ref, status: 'failed', reason: `本课资料的习题里没有 ${ref}` }
      const sourceKey = `${exercise.sourceId}#${ref}`
      const existing = this.store.bySourceKey(sourceKey)
      // The teacher's correction of a parsed answer replaces it; earlier gradings keep their verdicts.
      if (existing && item.answer) return { ref, status: 'updated', problem: this.store.saveProblem({ ...existing, answer: item.answer }) }
      if (existing) return { ref, status: 'existing', problem: existing }
      const origin = { kind: 'chunk' as const, chunkId: exercise.chunk.id, locator: exercise.chunk.locator, label: exercise.chunk.citation }
      // A copy written before exercises had numbers: give it its number instead of adding another.
      const older = this.store.twin({ origin, sourceKey: undefined, adaptedFrom: undefined })
      if (older) return { ref, status: 'existing', problem: this.store.saveProblem({ ...older, ref, sourceKey }) }
      const answer = item.answer ?? (exercise.printed ? answerFromPrinted(exercise.printed) : undefined)
      if (!answer) return { ref, status: 'failed', reason: `${ref} 书后没有答案：在 answer 里写参考答案（标为未核对，只进练习题池），或用 calculate 算出后再加` }
      const answerSource = exercise.printed ? 'book' as const : 'unverified' as const
      const size = item.size ?? (exercise.review ? 'check' : 'standard')
      const seen = homework.has(ref)
      if (item.pool === 'test-reserved' && seen) return { ref, status: 'failed', reason: `${ref} 学习者标了作业做过，不能进测试预留题池` }
      const pool = item.pool ?? this.store.poolFor(item.nodeIds, { size, seen, verified: answerSource !== 'unverified' }, planned)
      try {
        const [problem] = this.store.addProblems([{
          stem: exercise.stem,
          figures: [...exercise.figures] as NewProblem['figures'],
          answer,
          answerSource,
          tier: 1,
          origin,
          ref,
          sourceKey,
          size,
          nodeIds: [...item.nodeIds] as NewProblem['nodeIds'],
          pool,
        }])
        return { ref, status: 'added', problem: problem! }
      } catch (error) {
        return { ref, status: 'failed', reason: (error as Error).message }
      }
    })
  }

  checkAnswer(problemId: string, script: string, results: readonly string[], apply = false): AnswerCheck {
    const problem = must(this.store.problem(problemId), 'assess', '题目', problemId)
    const parts = answerParts(problem.answer)
    if (results.length !== parts.length) {
      throw new LearningApiError('learning/assess/calculation', `这道题有 ${parts.length} 问，results 要按顺序给 ${parts.length} 个变量名（不是数值题的那一问写 "-"）`)
    }
    const run = calculate(script, results.filter(name => name !== '-'))
    const lines: string[] = []
    let agrees = true
    const replaced = parts.map((part, index) => {
      const name = results[index]!
      const label = part.label || '答案'
      if (name === '-' || part.answer.kind !== 'numeric') {
        lines.push(`${label}：不是数值，没有比较`)
        return part
      }
      const numeric = part.answer
      const value = inUnit(run.values[name]!, numeric.unit)
      if (value === undefined) {
        agrees = false
        lines.push(`${label}：算出 ${run.values[name]!.text}，和答案的单位 ${prettyUnit(numeric.unit) || '（无）'} 对不上`)
        return part
      }
      const allowed = Math.max(numeric.tolerance.absolute ?? 0, Math.abs(numeric.value) * (numeric.tolerance.relative ?? 0.02))
      const ok = Math.abs(value - numeric.value) <= allowed
      if (!ok) agrees = false
      lines.push(`${label}：答案 ${numeric.value} ${prettyUnit(numeric.unit)}，算出 ${Number(value.toPrecision(6))}，${ok ? '一致' : `差 ${Number(((value - numeric.value) / (numeric.value || 1) * 100).toPrecision(3))}%`}`)
      return { ...part, answer: { ...numeric, value: Number(value.toPrecision(6)) } as SingleAnswer }
    })
    const calculation = { script, results: [...results], lines: [...run.lines], at: now() }
    let next: Problem
    if (apply) {
      const answer = problem.answer.kind === 'parts' ? { kind: 'parts' as const, parts: replaced } : replaced[0]!.answer
      const { review: _review, ...rest } = problem
      next = { ...rest, answer, answerSource: 'calculated', calculation, status: 'active' }
    } else if (agrees) {
      const { review: _review, ...rest } = problem
      next = { ...rest, calculation, status: problem.status === 'under-review' ? 'active' : problem.status }
    } else {
      next = { ...problem, calculation, status: 'under-review', review: { reason: `计算工具的结果和答案不符：${lines.join('；')}`, at: now() } }
    }
    return { problem: this.store.saveProblem(next), agrees, lines }
  }

  markHomework(courseId: string, refs: string, done: boolean, by: 'learner' | 'teacher' = 'learner') {
    const { refs: expanded, bad } = expandRefs(refs)
    if (bad.length > 0) throw new LearningApiError('learning/assess/refs', `看不懂这些题号：${bad.join('、')}。写成 1-3 或 1-1~1-10，用逗号隔开`)
    if (expanded.length === 0) throw new LearningApiError('learning/assess/refs', '没有写题号')
    this.store.setHomework(courseId, expanded, done)
    const reserved = done ? this.store.problems({ pool: 'test-reserved' }).filter(problem => problem.ref && expanded.includes(problem.ref)).map(problem => problem.ref!) : []
    if (done && by === 'learner') {
      this.ctx.emit('learning/handoff', {
        courseId,
        unit: 'assess',
        text: `学习者标了作业做过的习题：${refs.trim()}（共 ${expanded.length} 道），这些题以后不算新题。${reserved.length ? `其中 ${reserved.join('、')} 在测试预留题池里，阶段测试要另备新题。` : ''}`,
      })
    }
    return { marks: this.store.homework(courseId), refs: expanded, reserved }
  }

  /** Model grading for one part (open answers, and expressions not shown equal by substitution). */
  private async gradeByModel(problem: Problem, part: { label: string; answer: SingleAnswer }, final: string, working: string, signal?: AbortSignal) {
    const reference = part.answer.kind === 'open' ? `评分标准：\n${answerText(part.answer)}` : `参考答案：\n${answerText(part.answer)}`
    const asked = part.label ? `\n\n要判的是第 ${part.label} 问。` : ''
    const steps = working && working !== final ? `\n\n学习者的解题过程：\n${working}` : ''
    try {
      const reply = await complete(this.ctx, {
        system: GRADER_SYSTEM,
        prompt: `题目：\n${problem.stem}${asked}\n\n${reference}\n\n学习者的作答：\n${final || '（空）'}${steps}`,
        purpose: 'learning-grade',
        model: this.config.model.get(),
        maxTokens: 4000,
        ...(signal ? { signal } : {}),
      })
      const parsed = Grading.omit({ method: true, parts: true }).parse(parseJsonReply(reply))
      const verdict = parsed.confidence === 'low' ? 'pending-review' as const : parsed.verdict
      return { label: part.label, verdict, score: parsed.score ?? (verdict === 'correct' ? 1 : 0), rationale: parsed.rationale, method: 'llm' as const, ...(parsed.confidence ? { confidence: parsed.confidence } : {}) }
    } catch (error) {
      return { label: part.label, verdict: 'pending-review' as const, score: 0, rationale: `自动判分失败，待复核：${(error as Error).message}`, method: 'llm' as const, confidence: 'low' as const }
    }
  }

  private async grade(problem: Problem, answer: SubmittedAnswer | undefined, signal?: AbortSignal): Promise<Grading> {
    const parts = answerParts(problem.answer)
    const working = answer?.text.trim() ?? ''
    const judged = []
    for (const [index, part] of parts.entries()) {
      // Answers sent without answer boxes (older pages) are read from the working when there is one part.
      const final = (answer?.finals?.[index] ?? (parts.length === 1 ? working : '')).trim()
      const rule = judgeByRule(part.answer, final)
      judged.push(rule ? { label: part.label, ...rule, method: 'rule' as const, confidence: 'high' as const } : await this.gradeByModel(problem, part, final, working, signal))
    }
    return combine(judged)
  }

  async submit(testId: string, answers: readonly SubmittedAnswer[], signal?: AbortSignal): Promise<TestView> {
    const test = must(this.store.test(testId), 'assess', '测试', testId)
    if (test.status !== 'open') return this.store.view(testId)!
    const byProblem = new Map(answers.map(answer => [answer.problemId, answer]))
    const context = {
      testId: test.id,
      ...(test.stageId ? { stageId: test.stageId } : {}),
      ...(test.lessonId ? { lessonId: test.lessonId } : {}),
    }
    for (const problemId of test.problemIds) {
      const problem = must(this.store.problem(problemId), 'assess', '题目', problemId)
      const answer = byProblem.get(problemId)
      const attempt = {
        id: newId('attempt'),
        problemId: problem.id,
        testId: test.id,
        courseId: test.courseId,
        text: answer?.text.trim() ?? '',
        finals: (answer?.finals ?? []).map(final => final.trim()),
        images: [],
        submittedAt: now(),
      }
      const grading = await this.grade(problem, answer, signal)
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
    input: z.object({ testId: z.string(), answers: z.array(z.object({ problemId: z.string(), text: z.string().max(20_000), finals: z.array(z.string().max(2000)).max(20).optional() })) }),
    handle: ({ testId, answers }, signal) => assess.submit(testId, answers, signal),
  }), 'assess: submit')

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'bank',
    input: z.object({ courseId: z.string(), nodeIds: z.array(z.string()).max(5000) }),
    handle: ({ courseId, nodeIds }) => assess.bank(courseId, nodeIds),
  }), 'assess: bank')

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'markHomework',
    input: z.object({ courseId: z.string(), refs: z.string().max(2000), done: z.boolean() }),
    handle: ({ courseId, refs, done }) => assess.markHomework(courseId, refs, done),
  }), 'assess: mark homework')

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
