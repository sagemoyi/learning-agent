import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId, type Id, type NewProblem } from '@learning-agent/contracts'
import { Database } from '../../core/src/db.ts'
import { coreMigrations } from '../../core/src/migrations.ts'
import { CoreStore } from '../../core/src/store.ts'
import { gradeByRule, parseChoices, parseNumber } from '../src/grading.ts'
import { AssessStore, assessMigrations } from '../src/store.ts'

describe('rule grading', () => {
  it('reads numbers the way learners write them', () => {
    expect(parseNumber('724.7 mmHg')).toBe(724.7)
    expect(parseNumber('约 3.309×10^-3 m³/s')).toBeCloseTo(3.309e-3)
    expect(parseNumber('3.309x10^{-3}')).toBeCloseTo(3.309e-3)
    expect(parseNumber('1.2×10⁻³')).toBeCloseTo(1.2e-3)
    expect(parseNumber('−2.5e2')).toBe(-250)
    expect(parseNumber('101,325 Pa')).toBe(101325)
    expect(parseNumber('不会')).toBeUndefined()
  })

  it('grades numeric answers within tolerance and choices exactly', () => {
    const numeric = { kind: 'numeric' as const, value: 724.7, unit: 'mmHg', tolerance: { relative: 0.02 } }
    expect(gradeByRule(numeric, '725 mmHg')?.verdict).toBe('correct')
    expect(gradeByRule(numeric, '700')?.verdict).toBe('incorrect')
    expect(gradeByRule(numeric, '不会')?.verdict).toBe('incorrect')
    expect(parseChoices('b、c')).toEqual([1, 2])
    const choice = { kind: 'choice' as const, options: ['甲', '乙', '丙'], correct: [2, 1] }
    expect(gradeByRule(choice, 'BC')?.verdict).toBe('correct')
    expect(gradeByRule(choice, 'B')?.verdict).toBe('incorrect')
    expect(gradeByRule({ kind: 'open', rubric: '…' }, 'x')).toBeUndefined()
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
    origin: { kind: 'agent' },
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
    expect(() => store.startTest({ courseId, kind: 'stage', problemIds: [practice!.id] })).toThrow(/练习题池/)
    expect(store.startTest({ courseId, kind: 'stage', nodeIds: [node] }).problemIds).toEqual([reserved!.id])
  })

  it('refuses an empty test', () => {
    expect(() => store.startTest({ courseId, kind: 'quiz', nodeIds: [newId('node') as Id<'node'>] })).toThrow(/没有能用的题/)
  })
})
