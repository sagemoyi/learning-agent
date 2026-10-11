// planner B (docs/planner/design.md, 验收标准 B): a check is suggested only once learner says an answer alone would
// add evidence, from this course's own answers; a few a day across all courses, the longest-waiting first; a
// dropped check still takes its place in the day; "今天先不做" lasts until tomorrow, restart included; starting a
// suggestion twice at once gives one test, and one no longer suggested is refused. Synthetic data, no model.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Id, NextStep, Problem, Task, Test } from '@learning-agent/contracts'
import * as assessTools from '../packages/assess/src/tools.ts'
import { createHarness, type Harness, type HarnessSettings } from './harness.ts'

const meta = { actor: 'teacher' as const, reason: 'planner B 测试（合成）' }
const reply = () => { throw new Error('no model call expected') }
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR
/** A Monday morning, local time. */
const T0 = new Date(2026, 9, 5, 9, 0).getTime()

let h: Harness | undefined
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})
afterEach(() => {
  h?.dispose()
  vi.useRealTimers()
})

function harness(settings: HarnessSettings = {}, root?: string): Harness {
  h = createHarness(reply, settings, root ? { root } : {})
  return h
}

async function course(title: string, nodes: readonly string[]): Promise<{ courseId: string; ids: Record<string, string> }> {
  const created = await h!.endpoint('core', 'createCourse', { title })
  const graph = await h!.ctx.learnKnowledge.add(created.id, { nodes: nodes.map(node => ({ title: node, kind: 'skill' as const })) }, meta)
  return { courseId: created.id, ids: Object.fromEntries(nodes.map(node => [node, graph.nodes.find(item => item.title === node)!.id as string])) }
}

let made = 0
function problems(nodeId: string, count: number): Problem[] {
  return h!.ctx.learnAssess.addProblems(Array.from({ length: count }, () => {
    made += 1
    return {
      stem: `（合成）第 ${made} 题：水深 ${made} m，求底部表压强。取 g = 10 m/s²。`,
      answer: { kind: 'numeric' as const, value: made * 10, unit: 'kPa', tolerance: { relative: 0.02 } },
      answerSource: 'unverified' as const, tier: 4 as const, origin: { kind: 'agent' as const }, nodeIds: [nodeId as Id<'node'>], pool: 'practice' as const,
    }
  }))
}

/** Hand in a test, every answer right or every answer wrong. */
async function hand(test: Test, right = true): Promise<void> {
  await h!.endpoint('assess', 'submit', {
    testId: test.id,
    answers: test.problemIds.map(problemId => {
      const answer = h!.ctx.learnAssess.problem(problemId)!.answer
      return { problemId, text: '', finals: [right && answer.kind === 'numeric' ? `${answer.value} kPa` : '1 kPa'] }
    }),
  })
  await h!.settle()
}

const practise = (courseId: string, problem: Problem, right = true) => hand(h!.ctx.learnAssess.startTest({ courseId, kind: 'practice', problemIds: [problem.id] }), right)
const next = (courseId: string): Promise<NextStep> => h!.endpoint('planner', 'next', { courseId })
const at = (ms: number) => vi.setSystemTime(ms)

async function brief(courseId: string): Promise<string> {
  return (await h!.endpoint<{ text: string }>('tutor', 'brief', { courseId })).text
}

it('suggests a check once an answer alone would add evidence, from this course\'s own answers', async () => {
  harness()
  const x = await course('planner B 甲（合成资料）', ['静水压强'])
  const node = x.ids['静水压强']!
  const [first] = problems(node, 4)
  await practise(x.courseId, first!)
  const y = await h!.endpoint('core', 'createCourse', { title: 'planner B 乙（合成资料）' })
  await h!.ctx.learnKnowledge.add(y.id, { nodes: [{ title: '静水压强', kind: 'skill', reuseId: node }] }, { actor: 'user', reason: '学习者复用（合成）' })

  at(T0 + DAY)
  expect((await next(x.courseId)).review).toBeUndefined()
  at(T0 + 3 * DAY + MINUTE)
  expect((await next(x.courseId)).review).toMatchObject({ nodeId: node, title: '静水压强', purpose: 'delayed', reason: expect.stringMatching(/^10月5日独立做对过/), used: 0, limit: 3 })
  expect(await brief(x.courseId)).toMatch(/可以复查（不急）：「静水压强」.*start_check/)
  // The other course has no answer of its own: its state is not checked by this one.
  expect((await next(y.id)).review).toBeUndefined()

  // An explanation now: an answer within days of it is no delayed check.
  h!.ctx.learnCore.log.append({ type: 'help.given', courseId: x.courseId as never, nodeIds: [node] as never, context: {}, level: 'explanation', via: 'teacher' })
  await h!.settle()
  expect((await next(x.courseId)).review).toBeUndefined()
  at(T0 + 6 * DAY + 2 * MINUTE)
  expect((await next(x.courseId)).review?.nodeId).toBe(node)

  // Started: it waits beside the step until handed in; a success makes the point retained, due again in two weeks.
  const check = await h!.endpoint<Test>('planner', 'check', { courseId: x.courseId, nodeId: node })
  expect(check).toMatchObject({ kind: 'review', status: 'open', check: { nodeId: node } })
  let step = await next(x.courseId)
  expect(step.review).toBeUndefined()
  expect(step.unfinished?.map(test => test.testId)).toEqual([check.id])
  await hand(check)
  step = await next(x.courseId)
  expect(h!.ctx.learnLearner.states([node])[0]!.courses.find(item => item.courseId === x.courseId)?.state).toBe('retained')
  expect(step.review).toBeUndefined()
  at(T0 + 21 * DAY)
  expect((await next(x.courseId)).review).toMatchObject({ nodeId: node, purpose: 'review' })
  // With this course's check put off, the other still has nothing of its own to check.
  await h!.endpoint('planner', 'defer', { courseId: x.courseId })
  expect((await next(y.id)).review).toBeUndefined()
})

it('keeps to the day\'s number across courses, the longest-waiting first; a dropped check still counts', async () => {
  harness({ planner: { dailyChecks: 2 } })
  const x = await course('planner B 甲（合成资料）', ['静水压强', '表压', '压差计'])
  const y = await course('planner B 乙（合成资料）', ['伯努利方程'])
  const [a1] = problems(x.ids['静水压强']!, 3), [b1] = problems(x.ids['表压']!, 2), [c1] = problems(y.ids['伯努利方程']!, 2), [d1] = problems(x.ids['压差计']!, 1)
  await practise(x.courseId, a1!)
  at(T0 + HOUR)
  await practise(y.courseId, c1!)
  at(T0 + 2 * HOUR)
  await practise(x.courseId, b1!)
  at(T0 + 3 * HOUR)
  await practise(x.courseId, d1!)

  at(T0 + 4 * DAY)
  expect((await next(x.courseId)).review?.title).toBe('静水压强')
  expect((await next(y.courseId)).review?.title).toBe('伯努利方程')
  // Due, but every problem on it is done: the teacher is asked to add some, nothing is made up.
  expect(await brief(x.courseId)).toContain('到了检查时间、但没有学习者没做过的练习题：压差计')

  const dropped = await h!.endpoint<Test>('planner', 'check', { courseId: x.courseId, nodeId: x.ids['静水压强']! })
  await h!.endpoint('assess', 'dropCheck', { testId: dropped.id })
  // One left today: the earliest due of what remains (乙's point waited longer than 表压), and not the point just dropped.
  expect((await next(x.courseId)).review).toBeUndefined()
  expect((await next(y.courseId)).review).toMatchObject({ title: '伯努利方程', used: 1, limit: 2 })
  await hand(await h!.endpoint<Test>('planner', 'check', { courseId: y.courseId, nodeId: y.ids['伯努利方程']! }), false)
  expect((await next(x.courseId)).review).toBeUndefined()
  expect((await next(y.courseId)).review).toBeUndefined()
  const home = await h!.endpoint<{ next: NextStep | null }[]>('planner', 'home', {})
  expect(home.every(row => !row.next?.review)).toBe(true)

  // A new day: the number starts again. 乙's point went wrong (a conflict): teaching first, no check.
  at(T0 + 5 * DAY)
  expect((await next(x.courseId)).review?.title).toBe('静水压强')
  expect((await next(y.courseId)).review).toBeUndefined()
})

it('puts a course\'s check off until tomorrow, across a restart', async () => {
  harness()
  const x = await course('planner B 推后（合成资料）', ['静水压强'])
  const [first] = problems(x.ids['静水压强']!, 2)
  await practise(x.courseId, first!)
  at(T0 + 4 * DAY)
  expect((await next(x.courseId)).review).toBeDefined()
  await h!.endpoint('planner', 'defer', { courseId: x.courseId })
  expect((await next(x.courseId)).review).toBeUndefined()
  await expect(h!.call('planner', 'check', { courseId: x.courseId, nodeId: x.ids['静水压强']! })).resolves.toMatchObject({ ok: false, error: { code: 'learning/planner/not-suggested' } })

  const root = h!.root
  h!.dispose(true)
  harness({}, root)
  at(new Date(2026, 9, 9, 23, 59).getTime())
  expect((await next(x.courseId)).review).toBeUndefined()
  at(new Date(2026, 9, 10, 0, 1).getTime())
  expect((await next(x.courseId)).review?.title).toBe('静水压强')
})

it('starts one test when a suggestion is taken twice at once, refuses one no longer suggested, and lets the teacher start any', async () => {
  harness({ planner: { dailyChecks: 1 } })
  const x = await course('planner B 甲（合成资料）', ['静水压强'])
  const y = await course('planner B 乙（合成资料）', ['伯努利方程'])
  const [a1] = problems(x.ids['静水压强']!, 2), [c1] = problems(y.ids['伯努利方程']!, 2)
  await practise(x.courseId, a1!)
  at(T0 + HOUR)
  await practise(y.courseId, c1!)
  at(T0 + 4 * DAY)
  // Pages loaded earlier could offer both; only the longest-waiting is still on when they are pressed.
  const [one, other, again] = await Promise.all([
    h!.call<Test>('planner', 'check', { courseId: x.courseId, nodeId: x.ids['静水压强']! }),
    h!.call<Test>('planner', 'check', { courseId: y.courseId, nodeId: y.ids['伯努利方程']! }),
    h!.call<Test>('planner', 'check', { courseId: x.courseId, nodeId: x.ids['静水压强']! }),
  ])
  expect(one.ok && again.ok && one.value!.id === again.value!.id).toBe(true)
  expect(other).toMatchObject({ ok: false, error: { code: 'learning/planner/not-suggested' } })
  expect(h!.ctx.learnAssess.tests(y.courseId, { kind: 'review' })).toHaveLength(0)

  // The teacher may start one anyway (the learner asked in the conversation); it counts for the day like any.
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  ;(h!.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  assessTools.apply(h!.ctx as never)
  const exec = { agent: { session: { id: await h!.ctx.learnTutor.session(y.courseId) } } }
  expect(await tools.get('start_check')!.execute({ node: '伯努利方程' }, exec)).toMatch(/^已发布"考我一下 · 伯努利方程"/)
  const task = h!.ctx.learnCurriculum.tasks(y.courseId).find(item => item.kind === 'review') as Task
  expect(task).toMatchObject({ createdBy: 'teacher', title: '考我一下 · 伯努利方程（1 题）' })
})
