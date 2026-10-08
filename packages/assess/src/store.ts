// Problem bank, tests and attempts. Owner of `assess_*` tables (contracts §4.6).
// Gradings are evidence: they go to core's append-only log; `assess_gradings` only caches the latest
// verdict per attempt for display and can be rebuilt from the log.
import type { DatabaseSync } from 'node:sqlite'
import {
  Attempt,
  Grading,
  LearningApiError,
  Problem,
  Test,
  newId,
  type BankOverview,
  type GradedAttempt,
  type HomeworkMark,
  type LearnCore,
  type Migration,
  type NewProblem,
  type ProblemSize,
  type StartTestInput,
  type TestView,
} from '@learning-agent/contracts'
import { inputsOf } from './grading.ts'

export const assessMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE assess_problems (
        id TEXT PRIMARY KEY,
        pool TEXT NOT NULL,
        status TEXT NOT NULL,
        node_ids TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE assess_tests (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        lesson_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX assess_tests_course ON assess_tests (course_id);
      CREATE TABLE assess_attempts (
        id TEXT PRIMARY KEY,
        test_id TEXT,
        problem_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX assess_attempts_test ON assess_attempts (test_id);
      CREATE TABLE assess_gradings (
        attempt_id TEXT PRIMARY KEY,
        log_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `,
  },
  {
    // One problem per source exercise (docs/assess/design.md, A). Banks written before that may hold an
    // exercise twice, one copy per pool: the copy with answers stays, otherwise the older one; the
    // rest are retired, so a reserved copy never passes as new after the practice copy was answered.
    version: 2,
    sql: `
      ALTER TABLE assess_problems ADD COLUMN source_key TEXT;
      CREATE INDEX assess_problems_source_key ON assess_problems (source_key);
      CREATE TABLE assess_homework (
        course_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (course_id, ref)
      );
      UPDATE assess_problems SET status = 'retired', data = json_set(data, '$.status', 'retired')
      WHERE status = 'active' AND json_extract(data, '$.origin.kind') = 'chunk' AND EXISTS (
        SELECT 1 FROM assess_problems other
        WHERE other.id <> assess_problems.id
          AND json_extract(other.data, '$.origin.chunkId') = json_extract(assess_problems.data, '$.origin.chunkId')
          AND json_extract(other.data, '$.stem') = json_extract(assess_problems.data, '$.stem')
          AND (
            (EXISTS (SELECT 1 FROM assess_attempts a WHERE a.problem_id = other.id) AND NOT EXISTS (SELECT 1 FROM assess_attempts a WHERE a.problem_id = assess_problems.id))
            OR (EXISTS (SELECT 1 FROM assess_attempts a WHERE a.problem_id = other.id) = EXISTS (SELECT 1 FROM assess_attempts a WHERE a.problem_id = assess_problems.id) AND other.id < assess_problems.id)
          )
      );
    `,
  },
]

const DEFAULT_CONDITIONS = { book: 'closed', calculator: true, formulaSheet: false } as const

export class AssessStore {
  constructor(private readonly core: Pick<LearnCore, 'db' | 'log'>) {}

  private get sqlite(): DatabaseSync {
    return this.core.db.sqlite
  }

  addProblems(drafts: readonly NewProblem[]): Problem[] {
    return this.core.db.transaction(() => drafts.map(draft => {
      const problem = Problem.parse({ ...draft, media: draft.media ?? [], id: newId('problem'), status: 'active', createdAt: new Date().toISOString() })
      const label = problem.ref ? `习题 ${problem.ref}` : `"${problem.stem.slice(0, 20)}…"`
      if (problem.tier === 4 && problem.pool === 'test-reserved') {
        throw new LearningApiError('learning/assess/tier4-in-test', 'Agent 自己出的题（第 4 级）只能用于练习，不能进测试题池', { stem: problem.stem.slice(0, 40) })
      }
      // A reserved problem is the evidence of a stage test: its answer needs a source or a calculation.
      if (problem.pool === 'test-reserved' && problem.answerSource === 'unverified') {
        throw new LearningApiError('learning/assess/unverified-in-test', `${label}的答案没有依据（不是书后答案、权威答案或计算工具算出的），只能进练习题池`)
      }
      if (problem.answerSource === 'calculated' && !problem.calculation) {
        throw new LearningApiError('learning/assess/no-calculation', `${label}标了"已验算"，但没有计算过程`)
      }
      if (problem.tier === 3 && !problem.adaptedFrom) {
        throw new LearningApiError('learning/assess/no-original', `${label}是改编题，要写明原题`)
      }
      if (problem.tier === 3 && problem.answer.kind === 'numeric' && problem.answerSource !== 'calculated') {
        throw new LearningApiError('learning/assess/no-calculation', `${label}是改编的数值题，答案要由计算工具算出`)
      }
      const twin = this.twin(problem)
      if (twin) throw new LearningApiError('learning/assess/duplicate', `${label}已经在题库里（${twin.id}，${twin.pool === 'practice' ? '练习题池' : '测试预留题池'}），同一道题只入库一次`, { problemId: twin.id })
      this.sqlite.prepare('INSERT INTO assess_problems (id, pool, status, node_ids, data, source_key) VALUES (?, ?, ?, ?, ?, ?)')
        .run(problem.id, problem.pool, problem.status, JSON.stringify(problem.nodeIds), JSON.stringify(problem), problem.sourceKey ?? null)
      return problem
    }))
  }

  /** The bank's copy of the same exercise: same source number, or the same source chunk when not adapted. */
  twin(problem: Pick<Problem, 'sourceKey' | 'origin' | 'adaptedFrom'>): Problem | undefined {
    if (problem.sourceKey) {
      const same = this.bySourceKey(problem.sourceKey)
      if (same) return same
    }
    if (problem.origin.kind !== 'chunk' || problem.adaptedFrom) return undefined
    const row = this.sqlite.prepare(`SELECT data FROM assess_problems WHERE status <> 'retired' AND json_extract(data, '$.origin.chunkId') = ? AND json_extract(data, '$.adaptedFrom') IS NULL`)
      .get(problem.origin.chunkId) as { data: string } | undefined
    return row ? Problem.parse(JSON.parse(row.data)) : undefined
  }

  bySourceKey(sourceKey: string): Problem | undefined {
    const row = this.sqlite.prepare("SELECT data FROM assess_problems WHERE source_key = ? AND status <> 'retired'").get(sourceKey) as { data: string } | undefined
    return row ? Problem.parse(JSON.parse(row.data)) : undefined
  }

  saveProblem(problem: Problem): Problem {
    const parsed = Problem.parse(problem)
    this.sqlite.prepare('UPDATE assess_problems SET pool = ?, status = ?, node_ids = ?, data = ?, source_key = ? WHERE id = ?')
      .run(parsed.pool, parsed.status, JSON.stringify(parsed.nodeIds), JSON.stringify(parsed), parsed.sourceKey ?? null, parsed.id)
    return parsed
  }

  /**
   * The pool for a new problem when the teacher names none: about a third of each node's problems are
   * reserved for tests, at least one; short checks, exercises done as homework and answers without a
   * source only practise. `planned` carries the counts across one import.
   */
  poolFor(nodeIds: readonly string[], options: { size: ProblemSize; seen: boolean; verified: boolean }, planned: Map<string, { practice: number; reserved: number }> = new Map()): Problem['pool'] {
    const node = nodeIds[0]
    if (!node) return 'practice'
    const counts = planned.get(node) ?? (() => {
      // Short checks never go to tests, so they do not count towards the split.
      const bank = this.problems({ nodeIds: [node] }).filter(problem => problem.size !== 'check')
      return { practice: bank.filter(problem => problem.pool === 'practice').length, reserved: bank.filter(problem => problem.pool === 'test-reserved').length }
    })()
    if (options.size === 'check') return 'practice'
    const reserve = !options.seen && options.verified && counts.reserved < Math.ceil((counts.reserved + counts.practice + 1) / 3)
    planned.set(node, reserve ? { ...counts, reserved: counts.reserved + 1 } : { ...counts, practice: counts.practice + 1 })
    return reserve ? 'test-reserved' : 'practice'
  }

  homework(courseId: string): HomeworkMark[] {
    return (this.sqlite.prepare('SELECT ref, at FROM assess_homework WHERE course_id = ? ORDER BY at, ref').all(courseId) as { ref: string; at: string }[])
      .map(row => ({ ref: row.ref, at: row.at }))
  }

  setHomework(courseId: string, refs: readonly string[], done: boolean): void {
    const at = new Date().toISOString()
    this.core.db.transaction(() => {
      for (const ref of refs) {
        if (done) this.sqlite.prepare('INSERT INTO assess_homework (course_id, ref, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(courseId, ref, at)
        else this.sqlite.prepare('DELETE FROM assess_homework WHERE course_id = ? AND ref = ?').run(courseId, ref)
      }
    })
  }

  /** Counts per node, so the page never receives a reserved problem's stem. */
  bank(courseId: string, nodeIds: readonly string[]): BankOverview {
    const seen = this.seenProblemIds(courseId)
    const all = this.problems({ nodeIds, includeReview: true })
    const nodes = nodeIds.map(nodeId => {
      const mine = all.filter(problem => problem.nodeIds.some(id => id === nodeId))
      return {
        nodeId,
        practice: mine.filter(problem => problem.status === 'active' && problem.pool === 'practice').length,
        reserved: mine.filter(problem => problem.status === 'active' && problem.pool === 'test-reserved').length,
        seen: mine.filter(problem => seen.has(problem.id)).length,
        doubtful: mine.filter(problem => problem.status === 'under-review').length,
      }
    }).filter(node => node.practice + node.reserved + node.doubtful > 0)
    const active = all.filter(problem => problem.status === 'active')
    return {
      practice: active.filter(problem => problem.pool === 'practice').length,
      reserved: active.filter(problem => problem.pool === 'test-reserved').length,
      nodes,
      doubtful: all.filter(problem => problem.status === 'under-review').map(problem => ({ problemId: problem.id, ...(problem.ref ? { ref: problem.ref } : {}), pool: problem.pool, reason: problem.review?.reason ?? '' })),
      homework: this.homework(courseId),
    }
  }

  problem(problemId: string): Problem | undefined {
    const row = this.sqlite.prepare('SELECT data FROM assess_problems WHERE id = ?').get(problemId) as { data: string } | undefined
    return row ? Problem.parse(JSON.parse(row.data)) : undefined
  }

  /** Active problems; `includeReview` adds those under review (for the bank overview). */
  problems(filter: { nodeIds?: readonly string[]; pool?: Problem['pool']; includeReview?: boolean }): Problem[] {
    const rows = this.sqlite.prepare(`SELECT data FROM assess_problems WHERE status ${filter.includeReview ? "<> 'retired'" : "= 'active'"} ${filter.pool ? 'AND pool = ?' : ''} ORDER BY id`)
      .all(...(filter.pool ? [filter.pool] : [])) as { data: string }[]
    const wanted = filter.nodeIds ? new Set(filter.nodeIds) : undefined
    return rows.map(row => Problem.parse(JSON.parse(row.data))).filter(problem => !wanted || problem.nodeIds.some(id => wanted.has(id)))
  }

  /** Problems the learner has already met: answered or marked seen (evidence log), or done as homework. */
  seenProblemIds(courseId: string): Set<string> {
    const seen = new Set<string>()
    for (const entry of this.core.log.query({ courseId, types: ['attempt.graded', 'problem.seen'], limit: 10_000 })) {
      if ('problemId' in entry && entry.problemId) seen.add(entry.problemId)
    }
    const homework = new Set(this.homework(courseId).map(mark => mark.ref))
    if (homework.size > 0) {
      const rows = this.sqlite.prepare("SELECT id, json_extract(data, '$.ref') AS ref FROM assess_problems WHERE json_extract(data, '$.ref') IS NOT NULL").all() as { id: string; ref: string }[]
      for (const row of rows) if (homework.has(row.ref)) seen.add(row.id)
    }
    return seen
  }

  startTest(input: StartTestInput): Test {
    // Practice and test problems stay apart (docs/assess/design.md): only stage tests and mock exams draw on
    // the reserved pool, so their problems are new to the learner.
    const pool = input.kind === 'stage' || input.kind === 'mock' ? 'test-reserved' : 'practice'
    let problemIds = [...(input.problemIds ?? [])]
    if (problemIds.length === 0) {
      const seen = this.seenProblemIds(input.courseId)
      const candidates = this.problems({ nodeIds: input.nodeIds ?? [], pool })
      const fresh = candidates.filter(problem => !seen.has(problem.id))
      problemIds = [...fresh, ...candidates.filter(problem => seen.has(problem.id))].slice(0, input.count ?? 3).map(problem => problem.id)
    }
    if (problemIds.length === 0) throw new LearningApiError('learning/assess/no-problems', '题库里没有能用的题：先用 add_problems 加题，或换几个知识节点')
    for (const id of problemIds) {
      const problem = this.problem(id)
      if (!problem) throw new LearningApiError('learning/assess/not-found', `找不到题目：${id}`, { problemId: id })
      if (problem.status !== 'active') throw new LearningApiError('learning/assess/not-active', `题目 ${id}${problem.status === 'under-review' ? '答案存疑，暂停使用' : '已停用'}`, { problemId: id })
      if (problem.pool !== pool) {
        throw new LearningApiError('learning/assess/wrong-pool', pool === 'practice'
          ? `题目 ${id} 属于测试预留题池，不能用在摸底、小测或练习里`
          : `题目 ${id} 属于练习题池，阶段测试只用测试预留题`, { problemId: id, pool: problem.pool })
      }
    }
    const test = Test.parse({
      id: newId('test'),
      courseId: input.courseId,
      ...(input.stageId ? { stageId: input.stageId } : {}),
      ...(input.lessonId ? { lessonId: input.lessonId } : {}),
      kind: input.kind,
      conditions: input.conditions ?? DEFAULT_CONDITIONS,
      problemIds,
      swapLimit: input.kind === 'diagnostic' ? 0 : 1,
      status: 'open',
      startedAt: new Date().toISOString(),
    })
    this.saveTest(test)
    return test
  }

  saveTest(test: Test): void {
    this.sqlite.prepare(`INSERT INTO assess_tests (id, course_id, lesson_id, kind, status, data) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET status = excluded.status, data = excluded.data`)
      .run(test.id, test.courseId, test.lessonId ?? null, test.kind, test.status, JSON.stringify(test))
  }

  test(testId: string): Test | undefined {
    const row = this.sqlite.prepare('SELECT data FROM assess_tests WHERE id = ?').get(testId) as { data: string } | undefined
    return row ? Test.parse(JSON.parse(row.data)) : undefined
  }

  tests(courseId: string, filter: { lessonId?: string; kind?: Test['kind'] } = {}): Test[] {
    return (this.sqlite.prepare('SELECT data FROM assess_tests WHERE course_id = ? ORDER BY id').all(courseId) as { data: string }[])
      .map(row => Test.parse(JSON.parse(row.data)))
      .filter(test => (!filter.lessonId || test.lessonId === filter.lessonId) && (!filter.kind || test.kind === filter.kind))
  }

  addAttempt(attempt: Attempt): void {
    const parsed = Attempt.parse(attempt)
    this.sqlite.prepare('INSERT INTO assess_attempts (id, test_id, problem_id, data) VALUES (?, ?, ?, ?)')
      .run(parsed.id, parsed.testId ?? null, parsed.problemId, JSON.stringify(parsed))
  }

  cacheGrading(attemptId: string, logId: string, grading: Grading): void {
    this.sqlite.prepare(`INSERT INTO assess_gradings (attempt_id, log_id, data) VALUES (?, ?, ?)
      ON CONFLICT (attempt_id) DO UPDATE SET log_id = excluded.log_id, data = excluded.data`)
      .run(attemptId, logId, JSON.stringify(Grading.parse(grading)))
  }

  attempts(testId: string): GradedAttempt[] {
    const rows = this.sqlite.prepare(`SELECT a.data, g.data AS grading FROM assess_attempts a
      LEFT JOIN assess_gradings g ON g.attempt_id = a.id WHERE a.test_id = ? ORDER BY a.id`).all(testId) as { data: string; grading: string | null }[]
    return rows.map(row => ({ ...Attempt.parse(JSON.parse(row.data)), ...(row.grading ? { grading: Grading.parse(JSON.parse(row.grading)) } : {}) }))
  }

  view(testId: string): TestView | undefined {
    const test = this.test(testId)
    if (!test) return undefined
    const open = test.status === 'open'
    const problems = test.problemIds.flatMap(id => {
      const problem = this.problem(id)
      if (!problem) return []
      if (!open) return [{ ...problem, inputs: inputsOf(problem.answer) }]
      const { answer, calculation: _calculation, ...rest } = problem
      return [{ ...rest, inputs: inputsOf(answer) }]
    })
    return { test, problems, attempts: this.attempts(testId) }
  }
}
