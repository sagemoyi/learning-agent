// learner (docs/learner/design.md, 有效证据): the stage report, the review facts and the mastery state read each answer
// the same way. An answer to a problem corrected later counts for nothing, a helped one does not pass, and one handed in
// around talk the classroom record could not sort has help uncertain until the talk is sorted again. The paper keeps its
// gradings and says how each answer counts now. Synthetic data; fake model and fake DSH sessions.
import { afterEach, expect, it } from 'vitest'
import type { NewProblem, NodeState, Problem, TestView } from '@learning-agent/contracts'
import * as assessTools from '../../packages/assess/src/tools.ts'
import * as curriculumTools from '../../packages/curriculum/src/tools.ts'
import * as tutorTools from '../../packages/tutor/src/tools.ts'
import { adapted, createHarness, type Harness, type ModelCall } from '../harness.ts'
import { lessonCourse, lessonText, type LessonCourse } from '../lesson-setup.ts'

let h: Harness | undefined
afterEach(() => h?.dispose())

/** What the fake 课堂记录 model answers next: a reply, or an error. */
let ledger: unknown = { help: [] }

function reply(call: ModelCall): string {
  const text = lessonText(call)
  if (text) return text
  if (call.purpose === 'learning-tutor-ledger') {
    if (ledger instanceof Error) throw ledger
    return JSON.stringify(ledger)
  }
  throw new Error(`unexpected model call: ${call.purpose}`)
}

const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
function registerTools(): void {
  tools.clear()
  ;(h!.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  assessTools.apply(h!.ctx as never)
  tutorTools.apply(h!.ctx as never)
  // The review facts in the brief come with curriculum's tools.
  curriculumTools.apply(h!.ctx as never)
}

/** A reserved problem on the course's node, adapted and calculated (no source chunk needed). */
function reserved(course: LessonCourse, value: number): Problem {
  return h!.ctx.learnAssess.addProblems([{
    stem: `（合成）水深 ${value / 10} m 处的静水压强是多少？取 g = 10 m/s²。`, answer: { kind: 'numeric', value, unit: 'kPa', tolerance: { relative: 0.02 } },
    ...adapted(h!.ctx, value), origin: { kind: 'agent' }, nodeIds: [course.nodeId as never], pool: 'test-reserved',
  } as NewProblem])[0]!
}

/** The stage test of `problem`, published as the stage's task and answered right; the stage then waits for its review. */
async function stageTest(course: LessonCourse, problem: Problem): Promise<TestView> {
  const blueprint = { core: [{ id: course.nodeId as never, title: '表压换算', requires: [], also: [] }], earlier: [], goals: [] }
  const test = h!.ctx.learnAssess.startTest({ courseId: course.courseId, kind: 'stage', stageId: course.stage.id, blueprint, problemIds: [problem.id] })
  h!.ctx.learnCurriculum.publishTask({ courseId: course.courseId as never, stageId: course.stage.id, kind: 'stage-test', title: '阶段测试', instructions: '独立完成', createdBy: 'teacher', result: { kind: 'test', id: test.id } })
  return h!.endpoint<TestView>('assess', 'submit', { testId: test.id, answers: [{ problemId: problem.id, text: '', finals: [`${problem.answer.kind === 'numeric' ? problem.answer.value : 0} kPa`] }] })
}

/** A course at its first lesson, on a knowledge point of its own: lessonCourse's diagnostic already answered the first one. */
async function courseOn(title: string): Promise<LessonCourse> {
  const base = await lessonCourse(h!, title)
  const graph = await h!.ctx.learnKnowledge.add(base.courseId, { nodes: [{ title: '表压换算', kind: 'skill' }] }, { actor: 'teacher', reason: '有效证据测试（合成）' })
  return { ...base, nodeId: graph.nodes.find(node => node.title === '表压换算')!.id }
}

const state = (course: LessonCourse) => h!.ctx.learnLearner.states([course.nodeId])[0]!.courses.find(item => item.courseId === course.courseId)!
const brief = (course: LessonCourse) => h!.ctx.learnTutor.brief(course.courseId, 'brief')
const view = (testId: string) => h!.endpoint<TestView>('assess', 'view', { testId })

it('does not count an answer to a problem corrected later anywhere; the paper keeps its grading and says why', async () => {
  h = createHarness(reply)
  const course = await courseOn('有效证据 改正（合成资料）')
  registerTools()
  const problem = reserved(course, 30)
  const handedIn = await stageTest(course, problem)
  expect(handedIn.stageReport?.nodes[0]?.outcome).toBe('pass')
  expect(state(course).state).toBe('independent')

  // The teacher finds the problem wrong and corrects it.
  h.ctx.learnAssess.reviewProblem(problem.id, 'fixed', '题干的水深写错了', { stem: '（合成）水深 3 m 处的静水压强是多少？取 g = 10 m/s²。' })
  const after = await view(handedIn.test.id)
  expect(after.attempts[0]!.grading?.verdict).toBe('correct')
  expect(after.counting).toEqual([expect.objectContaining({ status: 'void', note: expect.stringContaining('核对出有错，这次作答不计') })])
  expect(after.stageReport?.nodes[0]).toMatchObject({ outcome: 'insufficient', notes: [expect.stringContaining('第 1 题：这道题')] })
  expect(state(course).state).toBe('untested')
  // The review facts read the same report: no conclusion either way, so the default is to go on and verify later.
  const text = await brief(course)
  expect(text).toContain('表压换算：待验证（没有算数的新题作答')
  expect(text).toContain('默认建议：进入下一阶段')
  const result = await tools.get('get_test_result')!.execute({ testId: handedIn.test.id }, { agent: { session: { id: 'teacher' } } })
  expect(result).toContain('现在怎么算：这道题')
})

it('does not pass a point answered right after seeing the answer, in the state, the report or the review', async () => {
  h = createHarness(reply)
  const course = await courseOn('有效证据 帮助（合成资料）')
  registerTools()
  const problem = reserved(course, 40)
  h.ctx.learnCore.log.append({ type: 'help.given', courseId: course.courseId as never, nodeIds: [course.nodeId as never], context: {}, level: 'answer-revealed', problemId: problem.id, via: 'side-chat' })
  const handedIn = await stageTest(course, problem)
  expect(state(course).state).toBe('assisted')
  expect(handedIn.stageReport?.nodes[0]).toMatchObject({ outcome: 'assisted', notes: [expect.stringContaining('算有帮助')] })
  expect(handedIn.counting?.[0]).toMatchObject({ status: 'counted', help: 'helped' })
  const text = await brief(course)
  expect(text).toContain('表压换算：待验证（新题做对了，但有帮助或帮助状态不确定')
  expect(text).not.toContain('表压换算：过了')
})

it('leaves help uncertain around talk the classroom record could not sort, until it is sorted again', async () => {
  h = createHarness(reply)
  const course = await courseOn('有效证据 没整理（合成资料）')
  registerTools()
  const teacher = await h.ctx.learnTutor.session(course.courseId)
  await h.settle()
  const sessions = h.sessions
  const say = (who: 'learner' | 'teacher', text: string) => {
    const session = sessions.get(teacher) ?? { events: [] }
    sessions.set(teacher, session)
    const content = [{ type: 'text', text }]
    session.events.push(who === 'teacher'
      ? { type: 'assistant/message', time: Date.now(), data: { message: { content } } } as never
      : { type: 'user/message', time: Date.now(), data: { content, source: { kind: 'user' } } } as never)
  }
  const endTurn = async () => {
    ;(h!.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('agent/status', { agent: { session: { id: teacher } }, status: 'idle' })
    await h!.settle(60)
  }

  // The same stretch fails three times: it is logged as not recorded.
  ledger = new Error('模型不可用')
  say('learner', '水深 4 m 处的压强怎么算？')
  say('teacher', '按 p = ρgh，水的密度取 1000 kg/m³，g 取 10 m/s²，代入 4 m 就能算出以帕斯卡为单位的压强。')
  for (let i = 0; i < 3; i++) await endTurn()
  const gaps = h.ctx.learnCore.log.query({ courseId: course.courseId, types: ['help.unrecorded'] })
  expect(gaps).toEqual([expect.objectContaining({ via: 'teacher', reason: expect.stringContaining('模型不可用') })])

  const problem = reserved(course, 40)
  const handedIn = await stageTest(course, problem)
  expect(state(course)).toMatchObject({ state: 'assisted', explanation: expect.stringContaining('没整理成功') })
  expect(handedIn.stageReport?.nodes[0]).toMatchObject({ outcome: 'assisted', notes: [expect.stringContaining('帮助状态不确定')] })
  expect(await brief(course)).toContain('retry_records')

  // Sorted again (the talk had no help in it): the answer counts as independent everywhere.
  ledger = { help: [] }
  expect(await tools.get('retry_records')!.execute({}, { agent: { session: { id: teacher } } })).toBe('重新整理好 1 段。')
  await h.settle()
  expect(h.ctx.learnCore.log.query({ courseId: course.courseId, types: ['help.recorded'] })).toHaveLength(1)
  expect(state(course).state).toBe('independent')
  expect((await view(handedIn.test.id)).stageReport?.nodes[0]?.outcome).toBe('pass')
  expect(await brief(course)).not.toContain('retry_records')

  // The states are a cache: emptied and derived again, nothing changes.
  const stable = (states: NodeState[]) => states.map(({ computedAt: _, ...rest }) => rest)
  const before = stable(h.ctx.learnLearner.states())
  h.ctx.learnCore.db.sqlite.prepare('DELETE FROM learner_states').run()
  h.ctx.learnLearner.recompute()
  expect(stable(h.ctx.learnLearner.states())).toEqual(before)
})
