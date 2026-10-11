// planner C (docs/planner/design.md, 验收标准 C): coming back after a break is read from studying (answers, the
// conversation, tasks done), not from background work; the pace estimate is a range from the stages already done,
// says what it rests on, and says nothing until a stage is done; the teacher hears both. Synthetic data, no model.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Id, Lesson, NextStep, Stage, Test } from '@learning-agent/contracts'
import { paceOf } from '../packages/planner/src/pace.ts'
import { createHarness, type Harness } from './harness.ts'

const meta = { actor: 'teacher' as const, reason: 'planner C 测试（合成）' }
const reply = () => { throw new Error('no model call expected') }
const HOUR = 3_600_000, DAY = 24 * HOUR
const T0 = new Date(2026, 9, 5, 9, 0).getTime()
const iso = (at: number) => new Date(at).toISOString()

describe('the pace estimate', () => {
  const stage = (index: number, status: Stage['status'], options: { start?: number; end?: number; lessons?: Lesson['status'][] } = {}) => ({
    id: `st_${index}`, index, status, title: `阶段 ${index}`,
    ...(options.start !== undefined ? { designConfirmedAt: iso(options.start) } : {}),
    ...(options.end !== undefined ? { review: { decidedAt: iso(options.end) } } : {}),
    lessons: (options.lessons ?? []).map((lesson, i) => ({ id: `ls_${index}_${i}`, status: lesson })),
  }) as never as Stage & { lessons: Lesson[] }

  it('says nothing until a stage is done', () => {
    expect(paceOf([], 30)).toEqual({ verdict: 'unknown', text: '还没有课程路线，估不了。' })
    expect(paceOf([stage(1, 'learning', { start: T0, lessons: ['done', 'not-started'] }), stage(2, 'planned')], 30).verdict).toBe('unknown')
  })

  it('ranges one stage done from three quarters to half again its time, and several from the shortest to the longest', () => {
    // Stage 1 took 10 days; two whole stages left: 15–30 days.
    const one = [stage(1, 'done', { start: T0, end: T0 + 10 * DAY }), stage(2, 'planned'), stage(3, 'planned')]
    expect(paceOf(one, 40)).toEqual({ verdict: 'ok', text: '按第 1 个阶段用了 10 天、上下浮动粗算，剩下的大约要 2–5 周，照这个节奏来得及。' })
    expect(paceOf(one, 20).verdict).toBe('tight')
    expect(paceOf(one, 14)).toMatchObject({ verdict: 'late', text: expect.stringMatching(/照这个节奏赶不上：可以每周多花些时间、缩小目标范围，或者调整后面的路线/) })
    // 8 and 12 days; the stage under way has 2 of 3 lessons done (its test and review count as one more): 1.5 stages left.
    const two = [
      stage(1, 'done', { start: T0, end: T0 + 8 * DAY }), stage(2, 'done', { end: T0 + 20 * DAY }),
      stage(3, 'learning', { lessons: ['done', 'done', 'in-progress'] }), stage(4, 'planned'),
    ]
    expect(paceOf(two, 30)).toEqual({ verdict: 'ok', text: '按前 2 个阶段的用时（每个 8–12 天）粗算，剩下的大约要 12–18 天，照这个节奏来得及。' })
    expect(paceOf(two, 15).verdict).toBe('tight')
    expect(paceOf(two, 11).verdict).toBe('late')
    expect(paceOf([stage(1, 'done', { start: T0, end: T0 + 8 * DAY })], 3)).toEqual({ verdict: 'ok', text: '路线上的阶段都学完了，剩结课检验。' })
  })
})

describe('coming back', () => {
  let h: Harness | undefined
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    h?.dispose()
    vi.useRealTimers()
  })

  async function setup() {
    h = createHarness(reply)
    const course = await h.endpoint('core', 'createCourse', { title: 'planner C 回来（合成资料）' })
    const graph = await h.ctx.learnKnowledge.add(course.id, { nodes: [{ title: '静水压强', kind: 'skill' }] }, meta)
    const nodeId = graph.nodes[0]!.id as string
    const problems = h.ctx.learnAssess.addProblems([1, 2].map(n => ({
      stem: `（合成）水深 ${n} m，求底部表压强。取 g = 10 m/s²。`,
      answer: { kind: 'numeric' as const, value: n * 10, unit: 'kPa', tolerance: { relative: 0.02 } },
      answerSource: 'unverified' as const, tier: 4 as const, origin: { kind: 'agent' as const }, nodeIds: [nodeId as Id<'node'>], pool: 'practice' as const,
    })))
    return { courseId: course.id as string, nodeId, problems }
  }
  const next = (courseId: string): Promise<NextStep> => h!.endpoint('planner', 'next', { courseId })
  const answer = async (courseId: string, problemId: string) => {
    const test: Test = h!.ctx.learnAssess.startTest({ courseId, kind: 'practice', problemIds: [problemId] })
    await h!.endpoint('assess', 'submit', { testId: test.id, answers: [{ problemId, text: '', finals: ['10 kPa'] }] })
  }

  it('counts the days since the learner last studied, not since anything happened', async () => {
    const { courseId, nodeId, problems } = await setup()
    // A new course nobody studied yet: no break to come back from.
    vi.setSystemTime(T0 + 30 * DAY)
    expect((await next(courseId)).back).toBeUndefined()
    await answer(courseId, problems[0]!.id)
    vi.setSystemTime(T0 + 36 * DAY)
    expect((await next(courseId)).back).toBeUndefined()
    // A background job, the teacher's notice, or the teacher explaining on its own is not studying.
    h!.ctx.emit('learning/handoff', { courseId, unit: 'textbook', text: '（合成）教材写好了。' })
    h!.ctx.learnCore.log.append({ type: 'help.given', courseId: courseId as never, nodeIds: [nodeId] as never, context: {}, level: 'explanation', via: 'teacher' })
    await h!.settle()
    vi.setSystemTime(T0 + 37 * DAY + 2 * HOUR)
    const step = await next(courseId)
    expect(step.back).toMatchObject({ days: 7, last: '做了练习' })
    const home = await h!.endpoint<{ course: { id: string }; activeAt?: string }[]>('planner', 'home', {})
    expect(home.find(row => row.course.id === courseId)?.activeAt).toBe(step.back!.at)
    expect((await h!.endpoint<{ text: string }>('tutor', 'brief', { courseId })).text).toMatch(/学习者隔了 7 天回来（上次学习是11月4日，做了练习）。先欢迎回来/)

    // A question the learner asked is studying; so is a task done.
    h!.ctx.learnCore.log.append({ type: 'signal.question', courseId: courseId as never, nodeIds: [nodeId] as never, context: {}, text: '（合成）为什么压强和形状无关' })
    await h!.settle()
    expect((await next(courseId)).back).toBeUndefined()
    vi.setSystemTime(T0 + 44 * DAY + 3 * HOUR)
    expect((await next(courseId)).back).toMatchObject({ days: 7, last: '问了「静水压强」' })
    const task = h!.ctx.learnCurriculum.publishTask({ courseId: courseId as never, kind: 'read', title: '读 1.1', instructions: '（合成）', createdBy: 'teacher' })
    h!.ctx.learnCurriculum.completeTask(task.id)
    expect((await next(courseId)).back).toBeUndefined()
    vi.setSystemTime(T0 + 52 * DAY)
    expect((await next(courseId)).back).toMatchObject({ days: 8, last: '完成了「读 1.1」' })
    // Not once the course has ended.
    h!.ctx.learnCore.courses.setStatus(courseId, 'finished')
    expect((await next(courseId)).back).toBeUndefined()
  })
})
