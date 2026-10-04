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
  type GradedAttempt,
  type LearnCore,
  type Migration,
  type NewProblem,
  type StartTestInput,
  type TestView,
} from '@learning-agent/contracts'

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
      if (problem.tier === 4 && problem.pool === 'test-reserved') {
        throw new LearningApiError('learning/assess/tier4-in-test', 'Agent 自己出的题（第 4 级）只能用于练习，不能进测试题池', { stem: problem.stem.slice(0, 40) })
      }
      this.sqlite.prepare('INSERT INTO assess_problems (id, pool, status, node_ids, data) VALUES (?, ?, ?, ?, ?)')
        .run(problem.id, problem.pool, problem.status, JSON.stringify(problem.nodeIds), JSON.stringify(problem))
      return problem
    }))
  }

  problem(problemId: string): Problem | undefined {
    const row = this.sqlite.prepare('SELECT data FROM assess_problems WHERE id = ?').get(problemId) as { data: string } | undefined
    return row ? Problem.parse(JSON.parse(row.data)) : undefined
  }

  problems(filter: { nodeIds?: readonly string[]; pool?: Problem['pool'] }): Problem[] {
    const rows = this.sqlite.prepare(`SELECT data FROM assess_problems WHERE status = 'active' ${filter.pool ? 'AND pool = ?' : ''} ORDER BY id`)
      .all(...(filter.pool ? [filter.pool] : [])) as { data: string }[]
    const wanted = filter.nodeIds ? new Set(filter.nodeIds) : undefined
    return rows.map(row => Problem.parse(JSON.parse(row.data))).filter(problem => !wanted || problem.nodeIds.some(id => wanted.has(id)))
  }

  /** Problems the learner has already met (answered or marked seen), from the evidence log. */
  seenProblemIds(courseId: string): Set<string> {
    const seen = new Set<string>()
    for (const entry of this.core.log.query({ courseId, types: ['attempt.graded', 'problem.seen'], limit: 10_000 })) {
      if ('problemId' in entry && entry.problemId) seen.add(entry.problemId)
    }
    return seen
  }

  startTest(input: StartTestInput): Test {
    // Practice and test problems stay apart (PLAN §5.2): only stage tests and mock exams draw on
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
      if (!open) return [problem]
      const { answer, ...rest } = problem
      return [answer.kind === 'choice' ? { ...rest, options: answer.options } : rest]
    })
    return { test, problems, attempts: this.attempts(testId) }
  }
}
