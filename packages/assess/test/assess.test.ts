import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId, type Grading, type Id, type NewProblem } from '@learning-agent/contracts'
import { Database } from '../../core/src/db.ts'
import { coreMigrations } from '../../core/src/migrations.ts'
import { CoreStore } from '../../core/src/store.ts'
import { diagnose } from '../src/adaptive.ts'
import { judgeByRule, parseChoices } from '../src/grading.ts'
import { AssessStore, assessMigrations } from '../src/store.ts'
import { splitQuantity } from '../src/units.ts'

describe('rule grading', () => {
  it('reads numbers the way learners write them', () => {
    expect(splitQuantity('724.7 mmHg').value).toBe(724.7)
    expect(splitQuantity('约 3.309×10^-3 m³/s').value).toBeCloseTo(3.309e-3)
    expect(splitQuantity('3.309x10^{-3}').value).toBeCloseTo(3.309e-3)
    expect(splitQuantity('1.2×10⁻³').value).toBeCloseTo(1.2e-3)
    expect(splitQuantity('−2.5e2').value).toBe(-250)
    expect(splitQuantity('101,325 Pa').value).toBe(101325)
    expect(splitQuantity('不会').value).toBeUndefined()
  })

  it('grades numeric answers within tolerance and choices exactly', () => {
    const numeric = { kind: 'numeric' as const, value: 724.7, unit: 'mmHg', tolerance: { relative: 0.02 } }
    expect(judgeByRule(numeric, '725 mmHg')?.verdict).toBe('correct')
    expect(judgeByRule(numeric, '700')?.verdict).toBe('incorrect')
    expect(judgeByRule(numeric, '不会')?.verdict).toBe('incorrect')
    expect(parseChoices('b、c')).toEqual([1, 2])
    const choice = { kind: 'choice' as const, options: ['甲', '乙', '丙'], correct: [2, 1] }
    expect(judgeByRule(choice, 'BC')?.verdict).toBe('correct')
    expect(judgeByRule(choice, 'B')?.verdict).toBe('incorrect')
    expect(judgeByRule({ kind: 'open', rubric: '…' }, 'x')).toBeUndefined()
  })
})

describe('assess store', () => {
  let root: string
  let db: Database
  let core: CoreStore
  let store: AssessStore
  const courseId = newId('course')
  const node = newId('node')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'learning-assess-'))
    db = new Database(join(root, 'learning.db'))
    db.migrate('core', coreMigrations)
    db.migrate('assess', assessMigrations)
    core = new CoreStore(db, root, () => {}, () => ({ create: async () => ({ id: 'ws' }) }))
    store = new AssessStore({ db: { sqlite: db.sqlite, migrate: (unit, steps) => db.migrate(unit, steps), transaction: fn => db.transaction(fn) }, log: core.log })
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  const problem = (stem: string, pool: NewProblem['pool'] = 'practice'): NewProblem => ({
    stem,
    answer: { kind: 'numeric', value: 1, unit: '', tolerance: { relative: 0.02 } },
    answerSource: 'book',
    tier: 1,
    // A chunk of its own: the store checks a printed answer has a source (the library checks the chunk, elsewhere).
    origin: { kind: 'chunk', chunkId: newId('chunk'), label: '《合成》p.1' },
    nodeIds: [node],
    pool,
  })

  it('keeps agent-written problems out of the test pool', () => {
    expect(() => store.addProblems([{ ...problem('x', 'test-reserved'), tier: 4 }])).toThrow(/第 4 级/)
  })

  it('picks unseen problems first and hides answers while a test is open', () => {
    const [a, b] = store.addProblems([problem('a'), problem('b')])
    core.log.append({
      type: 'attempt.graded',
      courseId,
      nodeIds: [node],
      context: {},
      attemptId: newId('attempt'),
      problemId: a!.id,
      grading: { verdict: 'correct', method: 'rule', rationale: '' },
    })
    const test = store.startTest({ courseId, kind: 'quiz', nodeIds: [node], count: 1 })
    expect(test.problemIds).toEqual([b!.id])
    const view = store.view(test.id)!
    expect(view.problems[0]!.answer).toBeUndefined()
    store.saveTest({ ...test, status: 'graded' })
    expect(store.view(test.id)!.problems[0]!.answer?.kind).toBe('numeric')
  })

  it('keeps reserved test problems out of quizzes and practice problems out of stage tests', () => {
    const [practice, reserved] = store.addProblems([problem('p'), problem('r', 'test-reserved')])
    expect(() => store.startTest({ courseId, kind: 'quiz', problemIds: [reserved!.id] })).toThrow(/测试预留题池/)
    const blueprint = { core: [{ id: node, title: '静压', requires: [], also: [] }], earlier: [], goals: [] }
    expect(() => store.startTest({ courseId, kind: 'stage', blueprint, problemIds: [practice!.id] })).toThrow(/练习题池/)
    expect(store.startTest({ courseId, kind: 'stage', blueprint }).problemIds).toEqual([reserved!.id])
  })

  it('counts a probe as known only when it is right or misses just the unit, and probes below otherwise', () => {
    const base = newId('node')
    const top = newId('node')
    const scope = [{ id: base, title: '密度', requires: [], also: [] }, { id: top, title: '静力学', requires: [base], also: [] }]
    const numeric = { kind: 'numeric' as const, value: 1, unit: 'kPa', tolerance: { relative: 0.02 } }
    const graded = (testId: string, problemId: string, grading: Grading) => {
      const attemptId = newId('attempt')
      store.addAttempt({ id: attemptId, problemId: problemId as Id<'problem'>, testId: testId as Id<'test'>, courseId, version: 1, text: '', gaveUp: false, finals: [], images: [], submittedAt: new Date().toISOString() })
      store.cacheGrading(attemptId, newId('log'), grading)
    }
    for (const partial of ['part', 'unit'] as const) {
      const [two] = store.addProblems([{ ...problem(`两问（${partial}）`), nodeIds: [top], answer: { kind: 'parts', parts: [{ label: '（1）', answer: numeric }, { label: '（2）', answer: numeric }] } }])
      const test = store.startTest({ courseId, kind: 'diagnostic', scope })
      expect(test.problemIds).toEqual([two!.id])
      graded(test.id, two!.id, { verdict: 'partial', score: 0.5, method: 'rule', rationale: '', partial, parts: [] })
      const answers = store.probeAnswers(scope, test.id)
      const states = Object.fromEntries(diagnose(scope, answers).nodes.map(node => [node.title, node.state]))
      // One part wrong: not known, and its prerequisite is still asked. Only the unit missing: the method is known.
      expect(states).toEqual(partial === 'part' ? { 密度: 'unprobed', 静力学: 'not-yet' } : { 密度: 'inferred', 静力学: 'known' })
      store.addProblems([{ ...problem(`密度（${partial}）`), nodeIds: [base] }])
      expect(store.nextProbe(courseId, scope, answers, test.problemIds) !== undefined).toBe(partial === 'part')
      store.saveTest({ ...test, status: 'graded' })
      for (const item of store.problems({ nodeIds: [base, top] })) store.saveProblem({ ...item, status: 'retired' })
    }
  })

  it('refuses an empty test', () => {
    expect(() => store.startTest({ courseId, kind: 'quiz', nodeIds: [newId('node') as Id<'node'>] })).toThrow(/没有能用的题/)
  })
})

describe('upgrading a bank that holds an exercise twice', () => {
  it('keeps the answered copy and retires the rest', () => {
    const root = mkdtempSync(join(tmpdir(), 'learning-assess-upgrade-'))
    const db = new Database(join(root, 'learning.db'))
    try {
      db.migrate('assess', [assessMigrations[0]!])
      const chunkId = newId('chunk')
      const insert = (pool: string, stem: string) => {
        const id = newId('problem')
        const data = { id, stem, media: [], answer: { kind: 'numeric', value: 1, unit: '', tolerance: { relative: 0.02 } }, answerSource: 'book', tier: 1, origin: { kind: 'chunk', chunkId, label: '《合成》p.1' }, nodeIds: [newId('node')], pool, status: 'active', createdAt: new Date().toISOString() }
        db.sqlite.prepare('INSERT INTO assess_problems (id, pool, status, node_ids, data) VALUES (?, ?, ?, ?, ?)').run(id, pool, 'active', '[]', JSON.stringify(data))
        return id
      }
      const reserved = insert('test-reserved', '同一道题')
      const practiced = insert('practice', '同一道题')
      const other = insert('practice', '另一道题')
      db.sqlite.prepare('INSERT INTO assess_attempts (id, test_id, problem_id, data) VALUES (?, ?, ?, ?)').run(newId('attempt'), null, practiced, '{}')
      db.migrate('assess', assessMigrations)
      const status = (id: string) => (db.sqlite.prepare("SELECT status, json_extract(data, '$.status') AS inner FROM assess_problems WHERE id = ?").get(id) as { status: string; inner: string })
      expect(status(reserved)).toEqual({ status: 'retired', inner: 'retired' })
      expect(status(practiced).status).toBe('active')
      expect(status(other).status).toBe('active')
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('upgrading problems and answers written before versions', () => {
  it('makes every problem its version 1, which every earlier answer answered, and versions later corrections', () => {
    const root = mkdtempSync(join(tmpdir(), 'learning-assess-versions-'))
    const db = new Database(join(root, 'learning.db'))
    try {
      db.migrate('core', coreMigrations)
      db.migrate('assess', assessMigrations.slice(0, 4))
      const courseId = newId('course')
      const problemId = newId('problem')
      const testId = newId('test')
      const attemptId = newId('attempt')
      const at = new Date().toISOString()
      const problem = { id: problemId, stem: '（合成）求压强', media: [], answer: { kind: 'numeric', value: 2, unit: 'kPa', tolerance: { relative: 0.02 } }, answerSource: 'book', tier: 4, origin: { kind: 'agent' }, nodeIds: [newId('node')], pool: 'practice', status: 'active', createdAt: at }
      db.sqlite.prepare('INSERT INTO assess_problems (id, pool, status, node_ids, data) VALUES (?, ?, ?, ?, ?)').run(problemId, 'practice', 'active', '[]', JSON.stringify(problem))
      const test = { id: testId, courseId, kind: 'quiz', conditions: { book: 'closed', calculator: true, formulaSheet: false }, problemIds: [problemId], swapLimit: 1, status: 'graded', startedAt: at, endedAt: at }
      db.sqlite.prepare('INSERT INTO assess_tests (id, course_id, kind, status, data) VALUES (?, ?, ?, ?, ?)').run(testId, courseId, 'quiz', 'graded', JSON.stringify(test))
      db.sqlite.prepare('INSERT INTO assess_attempts (id, test_id, problem_id, data) VALUES (?, ?, ?, ?)')
        .run(attemptId, testId, problemId, JSON.stringify({ id: attemptId, problemId, testId, courseId, text: '', finals: ['2 kPa'], submittedAt: at }))
      db.migrate('assess', assessMigrations)

      const core = new CoreStore(db, root, () => {}, () => ({ create: async () => ({ id: 'ws' }) }))
      const store = new AssessStore({ db: { sqlite: db.sqlite, migrate: (unit, steps) => db.migrate(unit, steps), transaction: fn => db.transaction(fn) }, log: core.log })
      expect(store.problem(problemId)?.version).toBe(1)
      expect(store.attempts(testId).map(attempt => attempt.version)).toEqual([1])
      // Corrected: the problem moves on to version 2; the old answer still shows the version it answered.
      store.saveProblem({ ...store.problem(problemId)!, answer: { kind: 'numeric', value: 99, unit: 'kPa', tolerance: { relative: 0.02 } } })
      expect(store.problem(problemId)).toMatchObject({ version: 2, answer: { value: 99 } })
      expect(store.view(testId)!.problems[0]).toMatchObject({ version: 1, answer: { value: 2 }, revised: true })
      // Only content makes a version: moving the problem to another pool does not.
      store.saveProblem({ ...store.problem(problemId)!, pool: 'test-reserved' })
      expect(store.problem(problemId)?.version).toBe(2)
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
