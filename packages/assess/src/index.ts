// assess unit, host half. Provides `ctx.learnAssess` (contracts §5.1): problem bank, tests,
// attempts, grading. Numeric and choice answers are graded by rule; open answers by the model,
// with its confidence (low → pending review, never "wrong"). Every grading is appended to the
// evidence log, which is what mastery is computed from.
// Textbook exercises are imported by number from library's parse (docs/assess/design.md, A); answers
// without a printed or authoritative source come from the restricted calculator.
// Diagnostics probe one problem at a time along the prerequisites; stage tests are assembled by rule and
// reported per node; flagged problems are swapped and checked by the teacher; gradings can be appealed
// and regraded, the regrade appended to the log (docs/assess/design.md, B). Answers are saved as they are
// written; photo answers are read twice by a vision model and graded once the learner confirms the reading;
// past papers are imported by number; mock exams are assembled by the exam's question types, timed and
// scored by section (docs/assess/design.md, C).
import { mkdirSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  COURSE_LAYOUT,
  Grading,
  LearningApiError,
  REPORT_REASON_LABEL,
  ReportReason,
  TEST_KIND_LABEL,
  newId,
  type AnswerDraft,
  type Appeal,
  type AnswerCheck,
  type CalculationResult,
  type DraftInput,
  type ExerciseImport,
  type ExerciseImportResult,
  type LearnAssess,
  type MockSection,
  type NewProblem,
  type Problem,
  type ProbeNode,
  type SingleAnswer,
  type StartTestInput,
  type SubmittedAnswer,
  type Test,
  type TestView,
  type Verdict,
} from '@learning-agent/contracts'
import { complete, must, now, parseJsonReply } from '@learning-agent/kit'
import { roleModel, Schema } from '@learning-agent/kit/settings'
import { z } from 'zod'
import { diagnosisText } from './adaptive.ts'
import { calculate, inUnit } from './calculator.ts'
import { answerFromPrinted, EXERCISE_SECTIONS, exercisesOf, expandRefs, type FoundExercise } from './exercises.ts'
import { answerParts, answerText, combine, inputsOf, judgeByRule, rubricPoints } from './grading.ts'
import { finalReportText } from './final.ts'
import { mockReportText } from './mock.ts'
import { choiceKey, paperQuestionsOf, paperRefs, type PaperQuestion } from './papers.ts'
import { compareReadings, PHOTO_EXTENSION, photoType, READER_SYSTEM, readerPrompt, readingOf } from './reading.ts'
import { stageReportText } from './stage.ts'
import { AssessStore, assessMigrations, deadlineOf } from './store.ts'
import { prettyUnit } from './units.ts'

export const name = 'learning-assess'
export const inject = ['learnCore', 'learnLibrary', 'llm', 'sessionController', 'connection']

export const Config = Schema.object({
  model: roleModel('判分'),
  vision: roleModel('识别手写'),
})
export type Config = ReturnType<typeof Config>

const GRADER_SYSTEM = `你是化工原理课程的判分助手。只根据给出的题目、参考答案或评分标准判断学习者的作答，不要自己补充知识。
只输出一个 JSON 对象：{"verdict":"correct|partial|incorrect","score":0到1之间的数,"confidence":"high|medium|low","rationale":"一两句中文理由"}。
看不懂作答、或参考答案本身可疑时，confidence 用 low。`

const CHECKLIST_SYSTEM = `你是化工原理课程的判分助手。评分标准是几条要点，逐条判断学习者的作答是否做到，不要自己补充知识。
只输出一个 JSON 对象：{"points":[{"met":true或false,"note":"没做到时用一句话说明"}],"confidence":"high|medium|low"}。points 按要点的顺序，条数和要点一样。
看不懂作答、或要点本身可疑时，confidence 用 low。`

const KIND_LABEL = TEST_KIND_LABEL

const Answered = z.object({ problemId: z.string(), text: z.string().max(20_000), finals: z.array(z.string().max(2000)).max(20).optional(), gaveUp: z.boolean().optional() })
const VERDICT_LABEL = { correct: '对', partial: '部分对', incorrect: '错', 'pending-review': '待复核' } as const
const GAVE_UP = { verdict: 'incorrect', score: 0, method: 'learner', confidence: 'high', rationale: '选了"不会"' } as const satisfies Grading
const UNREAD = { verdict: 'pending-review', score: 0, method: 'rule', confidence: 'low', rationale: '到时间时照片的识别结果还没确认，等老师对照照片判分' } as const satisfies Grading

const PHOTO_LIMIT = 8 * 1024 * 1024
const PHOTOS_PER_PROBLEM = 4

/** Readings compare without spaces. */
const same = (a: string, b: string) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '')

const isPaper = (exercise: FoundExercise): exercise is PaperQuestion => 'type' in exercise

/** "第 2 题（习题 1-3）". */
function numbered(number: number, problem: Pick<Problem, 'ref'> | undefined): string {
  return `第 ${number} 题${problem?.ref ? `（习题 ${problem.ref}）` : ''}`
}

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

  /** Past papers among a course's sources: attached as past papers, or exam material. */
  private papers(courseId: string) {
    return this.ctx.learnLibrary.courseSources(courseId).filter(entry => entry.role === 'exam-archive' || entry.source.kind === 'exam')
  }

  /**
   * The course sources' exercises by number; the skeleton textbook first, then the first source that has it.
   * Textbooks are read in their exercise sections, past papers whole (numbers like `三-2`).
   */
  private exercises(courseId: string): Map<string, FoundExercise[]> {
    const sources = this.ctx.learnLibrary.courseSources(courseId).sort((a, b) => Number(b.role === 'skeleton') - Number(a.role === 'skeleton'))
    const papers = new Set(this.papers(courseId).map(entry => entry.sourceId as string))
    const byRef = new Map<string, FoundExercise[]>()
    for (const { sourceId } of sources) {
      const found = papers.has(sourceId) ? paperQuestionsOf(this.ctx.learnLibrary.chunks(sourceId))
        : exercisesOf(EXERCISE_SECTIONS.flatMap(section => this.ctx.learnLibrary.section(sourceId, section)))
      const seen = new Set<string>()
      for (const exercise of found) {
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
    const paperTitle = (sourceId: string) => this.ctx.learnLibrary.source(sourceId)?.title ?? sourceId
    return items.map((item): ExerciseImportResult => {
      const ref = item.ref.trim()
      const candidates = (found.get(ref) ?? []).filter(candidate => !item.sourceId || candidate.sourceId === item.sourceId)
      const fromPapers = [...new Set(candidates.filter(isPaper).map(candidate => candidate.sourceId))]
      if (!item.sourceId && fromPapers.length > 1) return { ref, status: 'failed', reason: `${ref} 在几份试卷里都有，在 source 里写是哪一份：${fromPapers.map(paperTitle).join('、')}` }
      const exercise = candidates[0]
      if (!exercise) {
        const paper = this.papers(courseId).find(entry => entry.sourceId === item.sourceId) ?? (/^[一二三四五六七八九十]/.test(ref) ? this.papers(courseId)[0] : undefined)
        const listed = paper ? paperQuestionsOf(this.ctx.learnLibrary.chunks(paper.sourceId)) : []
        return { ref, status: 'failed', reason: paper ? `《${paper.source.title}》里没有 ${ref}。${listed.length ? `这份试卷的题号：${paperRefs(listed)}` : '没有认出这份试卷的大题和题号'}` : `本课资料的习题里没有 ${ref}` }
      }
      const paper = isPaper(exercise) ? exercise : undefined
      // A choice key ("B") names the options split from the stem; any other answer is read like a printed one.
      const answerText = item.answerText?.trim() || exercise.printed
      const key = paper?.options && answerText ? choiceKey(answerText, paper.options) : undefined
      const choice = key && paper?.options ? { kind: 'choice' as const, options: [...paper.options], correct: key } : undefined
      const given = item.answerText?.trim() ? (choice ? undefined : answerFromPrinted(item.answerText.trim())) : item.answer
      const sourceKey = `${exercise.sourceId}#${ref}`
      const existing = this.store.bySourceKey(sourceKey)
      // The teacher's correction of a parsed answer replaces it; earlier gradings keep their verdicts.
      if (existing && (given || (choice && item.answerText?.trim()))) {
        return { ref, status: 'updated', problem: this.store.saveProblem({ ...existing, answer: choice ?? given!, ...(choice ? { stem: paper!.choiceStem ?? existing.stem } : {}) }) }
      }
      if (existing) return { ref, status: 'existing', problem: existing }
      const origin = { kind: 'chunk' as const, chunkId: exercise.chunk.id, locator: exercise.chunk.locator, label: exercise.chunk.citation }
      // A copy written before exercises had numbers: give it its number instead of adding another.
      const older = this.store.twin({ origin, sourceKey: undefined, adaptedFrom: undefined })
      if (older) return { ref, status: 'existing', problem: this.store.saveProblem({ ...older, ref, sourceKey }) }
      const answer = choice ?? given ?? (exercise.printed ? answerFromPrinted(exercise.printed) : undefined)
      if (!answer) return { ref, status: 'failed', reason: `${ref} ${paper ? '试卷没有附答案' : '书后没有答案'}：在 answer 里写参考答案（标为未核对，只进练习题池），或用 calculate 算出后再加` }
      const answerSource = exercise.printed ? 'book' as const : 'unverified' as const
      const size = item.size ?? (exercise.review ? 'check' : 'standard')
      const seen = homework.has(ref)
      if (item.pool === 'test-reserved' && seen) return { ref, status: 'failed', reason: `${ref} 学习者标了作业做过，不能进测试预留题池` }
      const verified = answerSource !== 'unverified'
      // Past-paper questions are the mock exam's material: reserved when their answer has a source.
      const pool = item.pool ?? (paper ? (verified ? 'test-reserved' : 'practice') : this.store.poolFor(item.nodeIds, { size, seen, verified }, planned))
      const type = paper?.type ?? item.type?.trim()
      try {
        const [problem] = this.store.addProblems([{
          stem: choice ? paper!.choiceStem ?? exercise.stem : exercise.stem,
          figures: [...exercise.figures] as NewProblem['figures'],
          answer,
          answerSource,
          tier: paper ? 2 : 1,
          origin,
          ref,
          sourceKey,
          size,
          ...(type ? { type } : {}),
          ...(paper?.points !== undefined ? { points: paper.points } : {}),
          ...(paper ? { paper: paperTitle(exercise.sourceId) } : {}),
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

  /**
   * Model grading for one part (open answers, and expressions not shown equal by substitution). A rubric of
   * several points is judged point by point and scored by the share met (docs/assess/design.md, B).
   */
  private async gradeByModel(problem: Problem, part: { label: string; answer: SingleAnswer }, final: string, working: string, signal?: AbortSignal) {
    const points = part.answer.kind === 'open' ? rubricPoints(part.answer.rubric) : []
    const reference = points.length > 1 ? `评分要点：\n${points.map((point, index) => `${index + 1}. ${point}`).join('\n')}`
      : part.answer.kind === 'open' ? `评分标准：\n${answerText(part.answer)}` : `参考答案：\n${answerText(part.answer)}`
    const asked = part.label ? `\n\n要判的是第 ${part.label} 问。` : ''
    const steps = working && working !== final ? `\n\n学习者的解题过程：\n${working}` : ''
    try {
      const reply = await complete(this.ctx, {
        system: points.length > 1 ? CHECKLIST_SYSTEM : GRADER_SYSTEM,
        prompt: `题目：\n${problem.stem}${asked}\n\n${reference}\n\n学习者的作答：\n${final || '（空）'}${steps}`,
        purpose: 'learning-grade',
        model: this.config.model.get(),
        maxTokens: 4000,
        ...(signal ? { signal } : {}),
      })
      if (points.length > 1) return { label: part.label, ...this.checklist(points, parseJsonReply(reply)), method: 'llm' as const }
      const parsed = Grading.omit({ method: true, parts: true }).parse(parseJsonReply(reply))
      const verdict = parsed.confidence === 'low' ? 'pending-review' as const : parsed.verdict
      return { label: part.label, verdict, score: parsed.score ?? (verdict === 'correct' ? 1 : 0), rationale: parsed.rationale, method: 'llm' as const, ...(parsed.confidence ? { confidence: parsed.confidence } : {}) }
    } catch (error) {
      return { label: part.label, verdict: 'pending-review' as const, score: 0, rationale: `自动判分失败，待复核：${(error as Error).message}`, method: 'llm' as const, confidence: 'low' as const }
    }
  }

  /** The model's point-by-point judgement → verdict, score (share of points met) and the points in words. */
  private checklist(points: readonly string[], reply: unknown) {
    const parsed = z.object({
      points: z.array(z.object({ met: z.boolean(), note: z.string().default('') })),
      confidence: z.enum(['high', 'medium', 'low']).default('medium'),
    }).parse(reply)
    if (parsed.points.length !== points.length) throw new Error(`判了 ${parsed.points.length} 条，评分要点有 ${points.length} 条`)
    const met = points.filter((_, index) => parsed.points[index]!.met)
    const missed = points.flatMap((point, index) => (parsed.points[index]!.met ? [] : [`${point}${parsed.points[index]!.note ? `（${parsed.points[index]!.note}）` : ''}`]))
    const verdict: Verdict = parsed.confidence === 'low' ? 'pending-review' : missed.length === 0 ? 'correct' : met.length === 0 ? 'incorrect' : 'partial'
    const rationale = [met.length ? `做到：${met.join('；')}` : '', missed.length ? `没做到：${missed.join('；')}` : ''].filter(Boolean).join('\n')
    return { verdict, score: met.length / points.length, rationale: `要点做到 ${met.length}/${points.length}。\n${rationale}`, confidence: parsed.confidence }
  }

  private async grade(problem: Problem, answer: SubmittedAnswer | undefined, signal?: AbortSignal): Promise<Grading> {
    if (answer?.gaveUp) return GAVE_UP
    const parts = answerParts(problem.answer)
    const working = answer?.text.trim() ?? ''
    const judged = []
    for (const [index, part] of parts.entries()) {
      // Answers sent without answer boxes (older pages) are read from the working when there is one part.
      const final = (answer?.finals?.[index] ?? (parts.length === 1 ? working : '')).trim()
      // Nothing written is wrong by rule: the model is not asked about a blank.
      const rule = !final && !working ? { verdict: 'incorrect' as const, score: 0, rationale: '没有作答' } : judgeByRule(part.answer, final)
      judged.push(rule ? { label: part.label, ...rule, method: 'rule' as const, confidence: 'high' as const } : await this.gradeByModel(problem, part, final, working, signal))
    }
    return combine(judged)
  }

  private contextOf(test: Test) {
    return { testId: test.id, ...(test.stageId ? { stageId: test.stageId } : {}), ...(test.lessonId ? { lessonId: test.lessonId } : {}) }
  }

  /**
   * The answer to grade: what the page sent, else (when it sent nothing for the problem) the saved draft. A
   * photo answer's working is the learner's checked reading of the photos; the photos and their reading
   * always come from the saved draft.
   */
  private answerFor(testId: string, problemId: string, sent: SubmittedAnswer | undefined): { answer: SubmittedAnswer | undefined; draft: AnswerDraft | undefined } {
    const draft = this.store.draft(testId, problemId)
    const empty = !sent || (!sent.gaveUp && !sent.text.trim() && !(sent.finals ?? []).some(final => final.trim()))
    const base = empty && draft ? { problemId, text: draft.text, finals: [...draft.finals], ...(draft.gaveUp ? { gaveUp: true } : {}) } : sent
    if (!draft?.images.length || base?.gaveUp) return { answer: base, draft }
    return { answer: { problemId, finals: [...(base?.finals ?? [])], text: draft.transcription?.text ?? '' }, draft }
  }

  /** Numbers of the photo answers whose reading the learner has not confirmed. */
  private unconfirmed(test: Test, problemIds: readonly string[]): number[] {
    return problemIds.flatMap(id => {
      const draft = this.store.draft(test.id, id)
      return draft?.images.length && !draft.gaveUp && !draft.transcription?.confirmedAt ? [test.problemIds.indexOf(id as never) + 1] : []
    })
  }

  /**
   * Store one answer and its grading; the grading goes to the evidence log, dated when the answer was handed in
   * (`lockedAt`), so help given while it was being graded does not count against it.
   */
  private record(test: Test, problem: Problem, answer: SubmittedAnswer | undefined, grading: Grading, lockedAt: string, draft?: AnswerDraft): void {
    const first = draft?.recognition?.runs[0]
    const finals = answer?.gaveUp ? [] : (answer?.finals ?? []).map(final => final.trim())
    const photos = draft?.images.length && !answer?.gaveUp ? draft : undefined
    const transcription = photos?.transcription && {
      text: photos.transcription.text,
      ...(photos.transcription.confirmedAt ? { confirmedAt: photos.transcription.confirmedAt } : {}),
      // Edited: the checked reading differs from the first one, in the working or an answer box.
      edited: !first || !same(first.working, photos.transcription.text) || first.finals.some((value, index) => !same(value, finals[index] ?? '')),
    }
    const attempt = {
      id: newId('attempt'),
      problemId: problem.id,
      testId: test.id,
      courseId: test.courseId,
      text: answer?.gaveUp ? '' : answer?.text.trim() ?? '',
      gaveUp: answer?.gaveUp ?? false,
      finals,
      images: photos ? [...photos.images] : [],
      ...(transcription ? { transcription } : {}),
      submittedAt: lockedAt,
    }
    this.ctx.learnCore.db.transaction(() => {
      this.store.addAttempt(attempt)
      const entry = this.ctx.learnCore.log.append({
        type: 'attempt.graded',
        at: lockedAt,
        courseId: test.courseId,
        nodeIds: problem.nodeIds,
        context: this.contextOf(test),
        attemptId: attempt.id,
        problemId: problem.id,
        testKind: test.kind,
        conditions: test.conditions,
        grading,
      })
      this.store.cacheGrading(attempt.id, entry.id, grading)
    })
  }

  async submit(testId: string, answers: readonly SubmittedAnswer[], signal?: AbortSignal): Promise<TestView> {
    const test = must(this.store.test(testId), 'assess', '测试', testId)
    if (test.status !== 'open') return this.store.view(testId)!
    if (test.scope?.adaptive) throw new LearningApiError('learning/assess/adaptive', '这份摸底一次答一题，用"提交这题"')
    if (test.conditions.timeLimit && !test.openedAt) throw new LearningApiError('learning/assess/not-started', '这份测试限时，先点"开始"')
    const deadline = deadlineOf(test)
    const expired = deadline !== undefined && Date.now() >= Date.parse(deadline)
    // Handing in by hand needs every photo reading checked; when time is up, unchecked ones wait for the teacher.
    const unconfirmed = this.unconfirmed(test, test.problemIds)
    if (unconfirmed.length && !expired) throw new LearningApiError('learning/assess/unconfirmed', `第 ${unconfirmed.join('、')} 题的照片识别结果还没确认：核对后点"确认识别结果"再交卷`)
    const byProblem = new Map(answers.map(answer => [answer.problemId, answer]))
    const lockedAt = now()
    for (const problemId of test.problemIds) {
      const problem = must(this.store.problem(problemId), 'assess', '题目', problemId)
      const { answer, draft } = this.answerFor(testId, problemId, byProblem.get(problemId))
      const unread = Boolean(draft?.images.length) && !answer?.gaveUp && !draft?.transcription?.confirmedAt
      this.record(test, problem, answer, unread ? UNREAD : await this.grade(problem, answer, signal), lockedAt, draft)
    }
    const late = deadline ? Math.floor((Date.now() - Date.parse(deadline)) / 60_000) : 0
    return this.finalize({ ...test, ...(late >= 1 ? { overtime: late } : {}) })
  }

  /** The problem an adaptive test is waiting on: the first one without an answer. */
  private current(test: Test): string | undefined {
    const answered = new Set(this.store.attempts(test.id).map(attempt => attempt.problemId as string))
    return test.problemIds.find(id => !answered.has(id))
  }

  async answer(testId: string, answer: SubmittedAnswer, signal?: AbortSignal): Promise<TestView> {
    const test = must(this.store.test(testId), 'assess', '测试', testId)
    if (!test.scope?.adaptive) throw new LearningApiError('learning/assess/not-adaptive', '这份测试要整卷交')
    if (test.status !== 'open') return this.store.view(testId)!
    if (answer.problemId !== this.current(test)) throw new LearningApiError('learning/assess/not-current', '这道题已经答过了，或者不是现在要答的题')
    const problem = must(this.store.problem(answer.problemId), 'assess', '题目', answer.problemId)
    if (!answer.gaveUp && this.unconfirmed(test, [answer.problemId]).length) throw new LearningApiError('learning/assess/unconfirmed', '照片的识别结果还没确认：核对后点"确认识别结果"再提交')
    const prepared = this.answerFor(testId, answer.problemId, answer)
    const lockedAt = now()
    this.record(test, problem, prepared.answer, await this.grade(problem, prepared.answer, signal), lockedAt, prepared.draft)
    return this.advance(test.id)
  }

  /** After an answer or a flag in an adaptive test: the next problem, or the end. */
  private advance(testId: string): TestView {
    const test = this.store.test(testId)!
    const scope = test.scope!
    const answered = this.store.attempts(test.id).length
    const flagged = this.store.reports({ testId }).map(report => report.problemId)
    const pending = this.current(test)
    if (pending) return this.store.view(testId)!
    const next = answered < scope.max ? this.store.nextProbe(test.courseId, scope.nodes, this.store.probeAnswers(scope.nodes, test.id), [...test.problemIds, ...flagged]) : undefined
    if (!next) return this.finalize(test)
    this.store.saveTest({ ...test, problemIds: [...test.problemIds, next as Test['problemIds'][number]] })
    return this.store.view(testId)!
  }

  finish(testId: string): TestView {
    const test = must(this.store.test(testId), 'assess', '测试', testId)
    if (test.status !== 'open') return this.store.view(testId)!
    if (!test.scope?.adaptive) throw new LearningApiError('learning/assess/not-adaptive', '这份测试要整卷交')
    // The problem on screen was seen, though not answered: it no longer counts as new.
    const current = this.current(test)
    if (current) {
      const problem = this.store.problem(current)
      if (problem) this.ctx.learnCore.log.append({ type: 'problem.seen', courseId: test.courseId, nodeIds: problem.nodeIds, context: this.contextOf(test), problemId: problem.id, way: 'test' })
    }
    return this.finalize({ ...test, problemIds: test.problemIds.filter(id => id !== current) })
  }

  /** Close a test: graded (abandoned when nothing was answered), the task done, the teacher told. */
  private finalize(test: Test): TestView {
    const answered = this.store.attempts(test.id).length
    const done: Test = { ...test, status: answered > 0 ? 'graded' : 'abandoned', endedAt: now() }
    this.store.saveTest(done)
    // The attempts keep the answers; the photos stay in the course folder.
    this.store.clearDrafts(test.id)
    this.ctx.emit('learning/test-finished', { test: done })
    const view = this.store.view(test.id)!
    this.ctx.emit('learning/handoff', { courseId: test.courseId, unit: 'assess', text: this.summary(view) })
    return view
  }

  /** The handoff after a test: the result in words (per node for diagnostics and stage tests), and what was flagged. */
  private summary(view: TestView): string {
    const { test } = view
    const kind = KIND_LABEL[test.kind]
    if (test.status === 'abandoned') return `学习者结束了${kind}，没有作答任何题。`
    const marks = view.attempts.map(attempt => VERDICT_LABEL[attempt.grading?.verdict ?? 'pending-review'])
    const result = view.diagnosis ? `结果：${diagnosisText(view.diagnosis)}`
      : view.stageReport ? `按知识点：${stageReportText(view.stageReport)}${view.stageReport.task ? `；完整任务题${VERDICT_LABEL[view.stageReport.task.verdict ?? 'pending-review']}` : ''}`
        : view.mockReport ? `${mockReportText(view.mockReport)}${test.overtime ? `（超时 ${test.overtime} 分钟交卷）` : ''}`
          : view.finalReport ? `按目标条目：${finalReportText(view.finalReport)}`
            : `判分：${marks.join('、')}`
    const photos = view.attempts.filter(attempt => attempt.images.length)
    const read = photos.length ? `其中 ${photos.length} 道拍照作答（${photos.filter(attempt => attempt.transcription?.edited).length} 道学习者改过识别结果）。` : ''
    const flagged = view.reports.map(report => `${report.ref ? `习题 ${report.ref}` : `"${report.stem.slice(0, 16)}…"`}（${REPORT_REASON_LABEL[report.reason]}${report.note ? `："${report.note}"` : ''}，${report.replacedBy ? '已换题' : '已跳过'}）`)
    const review = view.reports.some(report => report.reason !== 'done-before') ? '用 review_problem 核对后，把结果告诉学习者。' : ''
    return `学习者${test.scope?.adaptive ? '做完了' : '交了'}${kind}（${view.attempts.length} 题），${result}。${read}${flagged.length ? `作答时报告了 ${flagged.length} 道题有问题：${flagged.join('；')}。${review}` : ''}用 get_test_result 看详情。`
  }

  report(testId: string, problemId: string, reason: ReportReason, note = ''): TestView {
    const test = must(this.store.test(testId), 'assess', '测试', testId)
    if (test.status !== 'open') throw new LearningApiError('learning/assess/closed', '交卷后不能再报告题目有问题；对判分有疑问可以申诉')
    if (!test.problemIds.includes(problemId as never)) throw new LearningApiError('learning/assess/not-in-test', '这道题不在这份测试里')
    if (this.store.attempts(testId).some(attempt => attempt.problemId === problemId)) throw new LearningApiError('learning/assess/answered', '这道题已经答过了')
    const problem = must(this.store.problem(problemId), 'assess', '题目', problemId)
    const adaptive = test.scope?.adaptive ?? false
    const flagged = this.store.reports({ testId })
    const at = now()
    let next: Test = test
    this.ctx.learnCore.db.transaction(() => {
      const context = this.contextOf(test)
      this.ctx.learnCore.log.append({ type: 'problem.reported', courseId: test.courseId, nodeIds: problem.nodeIds, context, problemId: problem.id, reason, note: note.trim() })
      // Seen problems no longer count as new, even when swapped out (docs/assess/design.md).
      this.ctx.learnCore.log.append({ type: 'problem.seen', courseId: test.courseId, nodeIds: problem.nodeIds, context, problemId: problem.id, way: reason === 'done-before' ? 'homework' : 'test' })
      if (reason !== 'done-before' && problem.status === 'active') {
        this.store.saveProblem({ ...problem, status: 'under-review', review: { reason: `学习者报告"${REPORT_REASON_LABEL[reason]}"${note.trim() ? `：${note.trim()}` : ''}`, at } })
      }
      // Diagnostics ask the next problem instead; other tests swap while the limit allows, then skip.
      const swaps = flagged.filter(report => report.replacedBy).length
      const section = test.mock?.sections.find(item => item.problemIds.includes(problemId as never))
      const substitute = !adaptive && swaps < test.swapLimit ? this.store.replacement(test, problem, [...flagged.map(report => report.problemId), problem.id], section?.type) : undefined
      const problemIds = substitute ? test.problemIds.map(id => (id === problemId ? substitute.id : id)) : test.problemIds.filter(id => id !== problemId)
      const plan = test.plan && {
        ...test.plan,
        fresh: substitute ? [...test.plan.fresh, substitute.id] : test.plan.fresh,
        ...(test.plan.task === problemId ? (substitute?.size === 'task' ? { task: substitute.id } : { task: undefined }) : {}),
      }
      const mock = test.mock && { ...test.mock, sections: test.mock.sections.map(item => ({ ...item, problemIds: substitute ? item.problemIds.map(id => (id === problemId ? substitute.id : id)) : item.problemIds.filter(id => id !== problemId) })) }
      next = { ...test, problemIds, ...(plan ? { plan: Object.fromEntries(Object.entries(plan).filter(([, value]) => value !== undefined)) as Test['plan'] } : {}), ...(mock ? { mock } : {}) }
      this.store.saveTest(next)
      this.store.saveReport({ id: newId('report'), courseId: test.courseId, testId: test.id, problemId: problem.id, reason, note: note.trim(), ...(substitute ? { replacedBy: substitute.id } : {}), at })
    })
    if (adaptive) return this.advance(testId)
    if (next.problemIds.length === 0) return this.finalize(next)
    return this.store.view(testId)!
  }

  reviewProblem(problemId: string, action: 'keep' | 'fixed' | 'retired', note: string, changes: { readonly stem?: string; readonly answer?: Problem['answer'] } = {}): Problem {
    const problem = must(this.store.problem(problemId), 'assess', '题目', problemId)
    const { review: _review, calculation, ...rest } = problem
    let next: Problem
    if (action === 'retired') next = { ...rest, ...(calculation ? { calculation } : {}), status: 'retired' }
    else if (action === 'keep') next = { ...rest, ...(calculation ? { calculation } : {}), status: 'active' }
    else {
      // The teacher's own answer is unverified: it may only practise (use calculate's apply to keep it reserved).
      const answered = changes.answer ? { answer: changes.answer, answerSource: 'unverified' as const, pool: 'practice' as const } : { ...(calculation ? { calculation } : {}) }
      next = { ...rest, ...(changes.stem?.trim() ? { stem: changes.stem.trim() } : {}), ...answered, status: 'active' }
    }
    const at = now()
    const saved = this.ctx.learnCore.db.transaction(() => {
      const saved = this.store.saveProblem(next)
      for (const report of this.store.reports({ problemId, open: true })) this.store.saveReport({ ...report, outcome: { action, note: note.trim(), at } })
      // A problem found wrong takes the answers given to it with it (docs/learner/design.md, A).
      this.ctx.learnCore.log.append({ type: 'problem.reviewed', at, nodeIds: problem.nodeIds, context: {}, problemId: problem.id, outcome: action, note: note.trim() })
      return saved
    })
    return saved
  }

  appeal(attemptId: string, text: string): Appeal {
    const attempt = must(this.store.attempt(attemptId), 'assess', '作答', attemptId)
    if (!attempt.grading) throw new LearningApiError('learning/assess/not-graded', '这道题还没判分')
    if (!text.trim()) throw new LearningApiError('learning/assess/empty-appeal', '写一句为什么觉得判得不对')
    if (this.store.appeals({ attemptId }).length) throw new LearningApiError('learning/assess/appealed', '这道题已经申诉过了，老师的复核结果在题目下面')
    const appeal = this.store.saveAppeal({ id: newId('appeal'), courseId: attempt.courseId, ...(attempt.testId ? { testId: attempt.testId } : {}), attemptId: attempt.id, problemId: attempt.problemId, text: text.trim(), at: now() })
    const test = attempt.testId ? this.store.test(attempt.testId) : undefined
    const where = test ? `${KIND_LABEL[test.kind]}${numbered(test.problemIds.indexOf(attempt.problemId) + 1, this.store.problem(attempt.problemId))}` : '一道题'
    this.ctx.emit('learning/handoff', {
      courseId: attempt.courseId,
      unit: 'assess',
      text: `学习者对${where}的判分提出申诉："${appeal.text}"。原判：${VERDICT_LABEL[attempt.grading.verdict]}。核对题目和作答后用 regrade 改判或维持，并把理由告诉学习者。`,
    })
    return appeal
  }

  regrade(attemptId: string, verdict: Exclude<Verdict, 'pending-review'>, reason: string): { grading: Grading; changed: boolean } {
    const attempt = must(this.store.attempt(attemptId), 'assess', '作答', attemptId)
    if (!reason.trim()) throw new LearningApiError('learning/assess/no-reason', '改判要写明理由')
    const current = attempt.grading
    const changed = current?.verdict !== verdict
    let grading = current!
    if (changed) {
      const problem = must(this.store.problem(attempt.problemId), 'assess', '题目', attempt.problemId)
      const test = attempt.testId ? this.store.test(attempt.testId) : undefined
      const corrects = this.store.gradingLogId(attemptId)
      if (!corrects) throw new LearningApiError('learning/assess/not-graded', '这道题还没判分')
      grading = { verdict, score: verdict === 'correct' ? 1 : verdict === 'partial' ? 0.5 : 0, method: 'teacher', confidence: 'high', rationale: reason.trim() }
      this.ctx.learnCore.db.transaction(() => {
        // A new entry, never an edit: the original grading stays in the log (docs/learner/design.md).
        const entry = this.ctx.learnCore.log.append({
          type: 'attempt.regraded',
          courseId: attempt.courseId,
          nodeIds: problem.nodeIds,
          context: test ? this.contextOf(test) : {},
          attemptId: attempt.id,
          corrects: corrects as never,
          grading,
          reason: reason.trim(),
        })
        this.store.cacheGrading(attempt.id, entry.id, grading)
      })
    }
    const at = now()
    for (const appeal of this.store.appeals({ attemptId, open: true })) this.store.saveAppeal({ ...appeal, outcome: { verdict, changed, note: reason.trim(), at } })
    return { grading, changed }
  }

  queue = (courseId: string) => this.store.queue(courseId)
  coverage = (courseId: string, nodes: readonly ProbeNode[]) => this.store.coverage(courseId, nodes)
  mockCoverage = (courseId: string, sections: readonly MockSection[]) => this.store.mockCoverage(courseId, sections)

  /** An open test and one of its problems, for the calls that change an answer in progress. */
  private openProblem(testId: string, problemId: string): { test: Test; problem: Problem } {
    const test = must(this.store.test(testId), 'assess', '测试', testId)
    if (test.status !== 'open') throw new LearningApiError('learning/assess/closed', '这份测试已经交卷了')
    if (!test.problemIds.includes(problemId as never)) throw new LearningApiError('learning/assess/not-in-test', '这道题不在这份测试里')
    return { test, problem: must(this.store.problem(problemId), 'assess', '题目', problemId) }
  }

  private draftOf(testId: string, problemId: string): AnswerDraft {
    return this.store.draft(testId, problemId) ?? { problemId, text: '', finals: [], images: [] }
  }

  saveDraft(testId: string, input: DraftInput): AnswerDraft {
    this.openProblem(testId, input.problemId)
    const { gaveUp: _gaveUp, transcription: current, ...draft } = this.draftOf(testId, input.problemId)
    // Confirming keeps the first confirmation time while the text stays the same.
    const kept = current?.confirmedAt && current.text === input.transcription?.text ? current.confirmedAt : now()
    const transcription = draft.images.length && input.transcription
      ? { text: input.transcription.text, ...(input.transcription.confirmed ? { confirmedAt: kept } : {}) }
      : current
    return this.store.saveDraft(testId, { ...draft, text: input.text, finals: [...input.finals], ...(input.gaveUp ? { gaveUp: true } : {}), ...(transcription ? { transcription } : {}) })
  }

  async addPhoto(testId: string, problemId: string, image: { readonly data: Uint8Array }): Promise<AnswerDraft> {
    const { test } = this.openProblem(testId, problemId)
    const type = photoType(image.data)
    if (!type) throw new LearningApiError('learning/assess/photo', '照片要是 JPG、PNG 或 WebP 图片')
    if (image.data.length > PHOTO_LIMIT) throw new LearningApiError('learning/assess/photo', '照片超过 8 MB')
    if (this.draftOf(testId, problemId).images.length >= PHOTOS_PER_PROBLEM) throw new LearningApiError('learning/assess/photo', `一道题最多 ${PHOTOS_PER_PROBLEM} 张照片`)
    const path = `${COURSE_LAYOUT.attachments}/tests/${testId}/${problemId}-${Date.now().toString(36)}.${PHOTO_EXTENSION[type]}`
    const file = join(this.ctx.learnCore.courses.folder(test.courseId), path)
    mkdirSync(dirname(file), { recursive: true })
    await writeFile(file, image.data)
    // Changed photos are read again from the start.
    const { recognition: _recognition, transcription: _transcription, ...rest } = this.draftOf(testId, problemId)
    return this.store.saveDraft(testId, { ...rest, images: [...rest.images, path] })
  }

  removePhoto(testId: string, problemId: string, path: string): AnswerDraft {
    const { test } = this.openProblem(testId, problemId)
    const { recognition: _recognition, transcription: _transcription, ...draft } = this.draftOf(testId, problemId)
    if (!draft.images.includes(path)) throw new LearningApiError('learning/assess/not-found', '找不到这张照片')
    rmSync(join(this.ctx.learnCore.courses.folder(test.courseId), path), { force: true })
    return this.store.saveDraft(testId, { ...draft, images: draft.images.filter(item => item !== path) })
  }

  /** The file of a photo answer of this test, in progress or handed in. */
  photoFile(testId: string, path: string): string {
    const test = must(this.store.test(testId), 'assess', '测试', testId)
    const owned = [...this.store.drafts(testId), ...this.store.attempts(testId)].some(item => item.images.includes(path))
    if (!owned) throw new LearningApiError('learning/assess/not-found', '找不到这张照片')
    return join(this.ctx.learnCore.courses.folder(test.courseId), path)
  }

  async transcribe(testId: string, problemId: string, signal?: AbortSignal): Promise<AnswerDraft> {
    const { test, problem } = this.openProblem(testId, problemId)
    const draft = this.draftOf(testId, problemId)
    if (draft.images.length === 0) throw new LearningApiError('learning/assess/no-photo', '先拍照，再识别')
    const folder = this.ctx.learnCore.courses.folder(test.courseId)
    const images = await Promise.all(draft.images.map(async (path, index) => {
      const data = new Uint8Array(await readFile(join(folder, path)))
      return { data, mediaType: photoType(data) ?? 'image/jpeg' as const, name: `第 ${index + 1} 张` }
    }))
    const boxes = inputsOf(problem.answer).map(input => input.label || '答案')
    // Two independent readings: where they differ is where the learner should look (V9).
    const read = async () => readingOf(parseJsonReply(await complete(this.ctx, {
      system: READER_SYSTEM,
      prompt: readerPrompt(problem.stem, boxes, images.length),
      images,
      purpose: 'learning-handwriting',
      model: this.config.vision.get(),
      maxTokens: 8000,
      ...(signal ? { signal } : {}),
    })), boxes.length)
    const [first, second] = await Promise.all([read(), read()])
    const latest = this.draftOf(testId, problemId)
    if (latest.images.join('\n') !== draft.images.join('\n')) throw new LearningApiError('learning/assess/photo-changed', '识别时照片改过了，请重新识别')
    // The answer boxes take the reading only where the learner has not typed an answer.
    const finals = boxes.map((_, index) => (latest.finals[index]?.trim() ? latest.finals[index]! : first.finals[index] ?? ''))
    return this.store.saveDraft(testId, { ...latest, finals, recognition: { runs: [first, second], differences: compareReadings(first, second), at: now() }, transcription: { text: first.working } })
  }

  begin(testId: string): TestView {
    const test = must(this.store.test(testId), 'assess', '测试', testId)
    if (test.status === 'open' && !test.openedAt) this.store.saveTest({ ...test, openedAt: now() })
    return this.store.view(testId)!
  }

  withdraw(testId: string): TestView {
    const test = must(this.store.test(testId), 'assess', '测试', testId)
    if (test.status !== 'open') throw new LearningApiError('learning/assess/closed', '这份测试已经结束了')
    if (this.store.attempts(testId).length) throw new LearningApiError('learning/assess/answered', '学习者已经答了题，不能撤回：请学习者交卷或结束')
    const done: Test = { ...test, status: 'abandoned', endedAt: now() }
    this.store.saveTest(done)
    this.store.clearDrafts(testId)
    // The teacher's own action: the task closes, nobody is handed back.
    this.ctx.emit('learning/test-finished', { test: done })
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
      const mock = test.mock && test.status === 'graded' ? assess.view(test.id)?.mockReport?.total : undefined
      return { test, correct, total: test.problemIds.length, ...(mock ? { score: mock } : {}) }
    }),
  }), 'assess: tests')

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'submit',
    input: z.object({ testId: z.string(), answers: z.array(Answered) }),
    handle: ({ testId, answers }, signal) => assess.submit(testId, answers, signal),
  }), 'assess: submit')

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'answer',
    input: z.object({ testId: z.string(), answer: Answered }),
    handle: ({ testId, answer }, signal) => assess.answer(testId, answer, signal),
  }), 'assess: answer')

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'finish',
    input: z.object({ testId: z.string() }),
    handle: ({ testId }) => assess.finish(testId),
  }), 'assess: finish')

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'report',
    input: z.object({ testId: z.string(), problemId: z.string(), reason: ReportReason, note: z.string().max(500).optional() }),
    handle: ({ testId, problemId, reason, note }) => assess.report(testId, problemId, reason, note),
  }), 'assess: report')

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'appeal',
    input: z.object({ attemptId: z.string(), text: z.string().max(1000) }),
    handle: ({ attemptId, text }) => assess.appeal(attemptId, text),
  }), 'assess: appeal')

  const DraftBody = z.object({
    problemId: z.string(),
    text: z.string().max(20_000),
    finals: z.array(z.string().max(2000)).max(20),
    gaveUp: z.boolean().optional(),
    transcription: z.object({ text: z.string().max(20_000), confirmed: z.boolean() }).optional(),
  })

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'draft',
    input: z.object({ testId: z.string(), draft: DraftBody }),
    handle: ({ testId, draft }) => assess.saveDraft(testId, draft),
  }), 'assess: draft')

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'removePhoto',
    input: z.object({ testId: z.string(), problemId: z.string(), path: z.string().max(500) }),
    handle: ({ testId, problemId, path }) => assess.removePhoto(testId, problemId, path),
  }), 'assess: remove photo')

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'transcribe',
    input: z.object({ testId: z.string(), problemId: z.string() }),
    handle: ({ testId, problemId }, signal) => assess.transcribe(testId, problemId, signal),
  }), 'assess: transcribe')

  ctx.effect(() => endpoint({
    unit: 'assess',
    method: 'begin',
    input: z.object({ testId: z.string() }),
    handle: ({ testId }) => assess.begin(testId),
  }), 'assess: begin')

  // Photos are binary: exact fetch routes. DSH takes a streaming body only on a POST route, so the upload
  // (the page has already scaled the photo down) and the download are two routes, as in library.
  const binary = (method: string, methods: ('GET' | 'POST')[], requestBody: 'streaming' | 'buffered', handle: (params: URLSearchParams, request: Request) => Promise<Response>) => {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/learning/assess.${method}`,
      methods,
      requestBody,
      fetch: async request => {
        try {
          return await handle(new URL(request.url).searchParams, request)
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : '照片处理失败' }, { status: 400 })
        }
      },
    }), `assess: ${method}`)
  }
  binary('upload', ['POST'], 'streaming', async (params, request) => {
    const parts: Uint8Array[] = []
    let bytes = 0
    const reader = request.body?.getReader()
    for (;;) {
      const part = await reader?.read()
      if (!part || part.done) break
      bytes += part.value.length
      if (bytes > PHOTO_LIMIT) {
        await reader!.cancel().catch(() => {})
        throw new Error('照片超过 8 MB')
      }
      parts.push(part.value)
    }
    return Response.json(await assess.addPhoto(params.get('testId') ?? '', params.get('problemId') ?? '', { data: new Uint8Array(Buffer.concat(parts)) }))
  })
  binary('photo', ['GET'], 'buffered', async params => {
    const data = await readFile(assess.photoFile(params.get('testId') ?? '', params.get('path') ?? ''))
    return new Response(new Uint8Array(data), { headers: { 'Content-Type': photoType(data) ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } })
  })

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
      const deadline = deadlineOf(test)
      const late = deadline && Date.now() > Date.parse(deadline) ? '，已到时间，学习者回到测试页时自动交卷' : ''
      if (test.status === 'open') return `- ${test.id} ${KIND_LABEL[test.kind]}：进行中（${test.scope?.adaptive ? `逐题出，最多 ${test.scope.max} 题` : `${test.problemIds.length} 题`}${test.conditions.timeLimit && !test.openedAt ? `，限时 ${test.conditions.timeLimit} 分钟，还没开始` : late}）`
      if (test.status === 'abandoned') return `- ${test.id} ${KIND_LABEL[test.kind]}：没有作答就结束了`
      const view = assess.view(test.id)!
      const result = view.diagnosis ? diagnosisText(view.diagnosis)
        : view.stageReport ? stageReportText(view.stageReport)
          : view.mockReport ? mockReportText(view.mockReport)
            : view.finalReport ? finalReportText(view.finalReport)
              : view.attempts.map(attempt => VERDICT_LABEL[attempt.grading?.verdict ?? 'pending-review']).join('、')
      return `- ${test.id} ${KIND_LABEL[test.kind]}：已判分（${result}）`
    })
    const queue = assess.queue(request.courseId)
    const label = (ref: string | undefined, fallback: string) => (ref ? `习题 ${ref}` : fallback)
    const todo = [
      ...queue.reports.map(report => `- 学习者报告${label(report.ref, report.problemId)}"${REPORT_REASON_LABEL[report.reason]}"${report.note ? `：${report.note}` : ''}。核对原书或用 calculate 验算后，用 review_problem 处理。`),
      ...queue.appeals.map(appeal => `- 学习者对测试 ${appeal.testId ?? ''} 第 ${appeal.number} 题（${label(appeal.ref, appeal.problemId)}）申诉："${appeal.text}"。用 regrade 改判或维持。`),
      ...queue.pending.map(item => `- 测试 ${item.testId} 第 ${item.number} 题（${label(item.ref, item.problemId)}）判分待复核，用 regrade 改判。`),
    ]
    return [
      ...sections,
      { unit: 'assess', title: '最近的测试', text: lines.join('\n') },
      ...(todo.length ? [{ unit: 'assess', title: '待你处理的题目和判分', text: todo.join('\n') }] : []),
    ]
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
