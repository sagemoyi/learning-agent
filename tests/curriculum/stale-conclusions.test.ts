// curriculum (docs/curriculum/design.md, 阶段复盘, 阶段设计): a saved review rests on its stage test's facts, so an
// appeal, a regrade or a problem found wrong since makes it stale and the learner cannot decide on it; once decided, a
// later change is carried on with a note. A design the learner confirmed changes only by a revision they confirm, which
// keeps started lessons and the ids of the others. Synthetic data; fake model and fake DSH sessions.
import { afterEach, expect, it } from 'vitest'
import { STAGE_LAYOUT, parseFrontmatter, type NewProblem, type Problem, type TestView } from '@learning-agent/contracts'
import * as assessTools from '../../packages/assess/src/tools.ts'
import * as curriculumTools from '../../packages/curriculum/src/tools.ts'
import { adapted, createHarness, type Harness, type ModelCall } from '../harness.ts'
import { lessonCourse, lessonText, type LessonCourse } from '../lesson-setup.ts'

let h: Harness | undefined
afterEach(() => h?.dispose())

function reply(call: ModelCall): string {
  const text = lessonText(call)
  if (text) return text
  throw new Error(`unexpected model call: ${call.purpose}`)
}

const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
function registerTools(): void {
  tools.clear()
  ;(h!.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  assessTools.apply(h!.ctx as never)
  curriculumTools.apply(h!.ctx as never)
}

/** A course at its first lesson, on a knowledge point of its own: lessonCourse's diagnostic already answered the first one. */
async function courseOn(title: string): Promise<LessonCourse> {
  const base = await lessonCourse(h!, title)
  const graph = await h!.ctx.learnKnowledge.add(base.courseId, { nodes: [{ title: '表压换算', kind: 'skill' }] }, { actor: 'teacher', reason: '复盘测试（合成）' })
  return { ...base, nodeId: graph.nodes.find(node => node.title === '表压换算')!.id }
}

function reserved(course: LessonCourse, value: number): Problem {
  return h!.ctx.learnAssess.addProblems([{
    stem: `（合成）表压 ${value} kPa 换算成多少 Pa？`, answer: { kind: 'numeric', value, unit: 'kPa', tolerance: { relative: 0.02 } },
    ...adapted(h!.ctx, value), origin: { kind: 'agent' }, nodeIds: [course.nodeId as never], pool: 'test-reserved',
  } as NewProblem])[0]!
}

const brief = (course: LessonCourse) => h!.ctx.learnTutor.brief(course.courseId, 'brief')

it('makes a saved review stale when its facts change, and carries a change after the decision with a note', async () => {
  h = createHarness(reply)
  const course = await courseOn('复盘失效（合成资料）')
  registerTools()
  const teacher = { agent: { session: { id: await h.ctx.learnTutor.session(course.courseId) } } }
  const problem = reserved(course, 50)
  // Lessons are tested elsewhere: the stage's are done, so the next step is about its test and review.
  for (const lesson of h.ctx.learnCurriculum.lessons(course.stage.id)) h.ctx.learnCurriculum.setLessonStatus(lesson.id, 'done')
  const blueprint = { core: [{ id: course.nodeId as never, title: '表压换算', requires: [], also: [] }], earlier: [], goals: [] }
  const test = h.ctx.learnAssess.startTest({ courseId: course.courseId, kind: 'stage', stageId: course.stage.id, blueprint, problemIds: [problem.id] })
  h.ctx.learnCurriculum.publishTask({ courseId: course.courseId as never, stageId: course.stage.id, kind: 'stage-test', title: '阶段测试', instructions: '独立完成', createdBy: 'teacher', result: { kind: 'test', id: test.id } })
  const graded = await h.endpoint<TestView>('assess', 'submit', { testId: test.id, answers: [{ problemId: problem.id, text: '', finals: ['50 kPa'] }] })
  const attemptId = graded.attempts[0]!.id
  await tools.get('save_stage_review')!.execute({ markdown: '表压换算做对了。', recommend: 'next' }, teacher)
  expect(h.ctx.learnCurriculum.reviewChanges(course.stage.id)).toEqual([])

  // An appeal after the review was saved: the review is stale, and deciding on it is refused.
  h.ctx.learnAssess.appeal(attemptId, '（合成）想再确认一下单位')
  expect(await h.endpoint('curriculum', 'reviewChanges', { stageId: course.stage.id })).toEqual(['第 1 题：原来"对"，现在"对，有申诉待复核"'])
  const refused = await h.call('curriculum', 'decideReview', { stageId: course.stage.id, choice: 'next' })
  expect(refused.error).toMatchObject({ code: 'learning/curriculum/review-stale', message: expect.stringContaining('等主老师更新复盘') })
  expect(await brief(course)).toContain('的复盘要更新')
  expect(await h.ctx.learnPlanner.next(course.courseId)).toMatchObject({ actor: 'teacher', key: `stage.review-update:${course.stage.id}` })

  // Kept on review: the facts are as the review read them again, and the learner decides.
  h.ctx.learnAssess.regrade(attemptId, 'correct', '复核后维持：单位写对了')
  expect(h.ctx.learnCurriculum.reviewChanges(course.stage.id)).toEqual([])
  await h.endpoint('curriculum', 'decideReview', { stageId: course.stage.id, choice: 'next' })
  expect(h.ctx.learnCurriculum.carried(course.courseId)).toEqual([])

  // The problem is found wrong after the decision: the point is carried on as unverified, saying why.
  h.ctx.learnAssess.reviewProblem(problem.id, 'fixed', '题干的单位写错了', { stem: '（合成）表压 50 kPa 换算成多少 Pa？（单位已改正）' })
  expect(h.ctx.learnCurriculum.carried(course.courseId)).toEqual([expect.objectContaining({ nodeId: course.nodeId, kind: 'unverified', note: '复盘决定后结果从"过了"变成"待验证"' })])
})

it('changes a confirmed design only by a revision the learner confirms, keeping started lessons and lesson ids', async () => {
  h = createHarness(reply)
  const course = await lessonCourse(h, '设计书修订（合成资料）')
  const { stage } = course
  const path = `${stage.folder}/${STAGE_LAYOUT.design}`
  const original = (await h.ctx.learnCore.files.read(course.courseId, path))!.text
  const [first] = h.ctx.learnCurriculum.lessons(stage.id)
  h.ctx.learnCurriculum.setLessonStatus(first!.id, 'in-progress')
  const teacher = { actor: 'teacher' as const, reason: '主老师修订阶段设计（合成）' }

  await expect(h.ctx.learnCurriculum.saveDesign(stage.id, { markdown: '# 新设计\n', lessons: [{ number: '1.1', title: '静水压强' }] }, teacher)).rejects.toMatchObject({ code: 'learning/curriculum/no-reason' })
  await expect(h.ctx.learnCurriculum.saveDesign(stage.id, { markdown: '# 新设计\n', lessons: [{ number: '1.1', title: '静水压强' }, { number: '1.1', title: '等压面' }], reason: '加一节' }, teacher)).rejects.toMatchObject({ code: 'learning/curriculum/duplicate-lesson' })
  const { stage: pending } = await h.ctx.learnCurriculum.saveDesign(stage.id, {
    markdown: '# 新设计\n\n加一节等压面。\n', lessons: [{ number: '1.1', title: '静水压强（含单位换算）' }, { number: '1.2', title: '等压面' }], reason: '学习者想多练等压面',
  }, teacher)
  // Waiting: the stage goes on with its current design and lessons.
  expect(pending).toMatchObject({ status: stage.status, designConfirmedAt: stage.designConfirmedAt, designRevision: { reason: '学习者想多练等压面' } })
  expect(h.ctx.learnCurriculum.lessons(stage.id).map(lesson => lesson.number)).toEqual(['1.1'])
  expect((await h.ctx.learnCore.files.read(course.courseId, path))!.text).toBe(original)
  expect(await h.ctx.learnPlanner.next(course.courseId)).toMatchObject({ actor: 'learner', key: `stage.design-revision:${stage.id}` })

  const applied = await h.endpoint('curriculum', 'decideDesignRevision', { stageId: stage.id, apply: true })
  expect(applied.designRevision).toBeUndefined()
  expect(applied.status).toBe(stage.status)
  const lessons = h.ctx.learnCurriculum.lessons(stage.id)
  expect(lessons.map(lesson => [lesson.index, lesson.number, lesson.title, lesson.status])).toEqual([[1, '1.1', '静水压强（含单位换算）', 'in-progress'], [2, '1.2', '等压面', 'not-started']])
  expect(lessons[0]!.id).toBe(first!.id)
  const written = parseFrontmatter((await h.ctx.learnCore.files.read(course.courseId, path))!.text)
  expect([written.data.status, written.body.trim()]).toEqual(['confirmed', '# 新设计\n\n加一节等压面。'])

  // A revision that drops both: the started lesson stays after the new list, the other goes; no number or place repeats.
  const added = lessons[1]!.id
  await h.ctx.learnCurriculum.saveDesign(stage.id, { markdown: '# 再改\n', lessons: [{ number: '1.3', title: '压强计' }, { number: '1.2', title: '等压面（两例）' }], reason: '换个顺序' }, teacher)
  await h.ctx.learnCurriculum.decideDesignRevision(stage.id, true)
  const again = h.ctx.learnCurriculum.lessons(stage.id)
  expect(again.map(lesson => [lesson.index, lesson.number])).toEqual([[1, '1.3'], [2, '1.2'], [3, '1.1']])
  expect(again.find(lesson => lesson.number === '1.2')!.id).toBe(added)

  // Kept as it was when the learner says no.
  await h.ctx.learnCurriculum.saveDesign(stage.id, { markdown: '# 不要的修改\n', lessons: [{ number: '9.9', title: '无关' }], reason: '试试看' }, teacher)
  const kept = await h.ctx.learnCurriculum.decideDesignRevision(stage.id, false)
  expect(kept.designRevision).toBeUndefined()
  expect(h.ctx.learnCurriculum.lessons(stage.id).map(lesson => lesson.number)).toEqual(['1.3', '1.2', '1.1'])
})
