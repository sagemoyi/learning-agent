// planner A (docs/planner/design.md, 验收标准 A): the next step says who acts and names its object, tests left
// open come back, waiting is nobody's turn, a goal that cannot be read is not a new course, a withdrawn quiz or
// an empty diagnostic is not a finished one, dropping a check hands back once, and reading a step changes
// nothing. Synthetic data, fake model.
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { COURSE_LAYOUT, type NextStep, type Task, type Test } from '@learning-agent/contracts'
import { createHarness, FIXTURES, type Harness } from './harness.ts'
import { lessonCourse, lessonText } from './lesson-setup.ts'

const meta = { actor: 'teacher' as const, reason: 'planner A 测试（合成）' }

let h: Harness | undefined
afterEach(() => h?.dispose())

function reply(call: { purpose: string }): string {
  const text = lessonText(call as never)
  if (text !== undefined) return text
  throw new Error(`unexpected model call: ${call.purpose}`)
}

const next = (courseId: string): Promise<NextStep> => h!.ctx.learnPlanner.next(courseId)
const readTask = (courseId: string, lessonId: string): Task => h!.ctx.learnCurriculum.publishTask({ courseId: courseId as never, lessonId: lessonId as never, kind: 'read', title: '读 1.1', instructions: '读教材 1.1（合成）', createdBy: 'teacher' })

it('names the action and its object: a quiz withdrawn and set again is a new step under the same title', async () => {
  h = createHarness(reply)
  const { courseId, lesson, problems } = await lessonCourse(h, 'planner A 步骤（合成资料）')
  expect(await next(courseId)).toMatchObject({ actor: 'teacher', key: `read.publish:${lesson.id}` })
  const read = readTask(courseId, lesson.id)
  expect(await next(courseId)).toMatchObject({ actor: 'learner', key: `read.do:${read.id}` })
  h.ctx.learnCurriculum.completeTask(read.id)
  expect(await next(courseId)).toMatchObject({ actor: 'teacher', key: `quiz.publish:${lesson.id}` })

  const teacher = await h.ctx.learnTutor.session(courseId)
  const quiz = h.ctx.learnAssess.startTest({ courseId, kind: 'quiz', lessonId: lesson.id, problemIds: [problems[1]!.id] })
  expect(await next(courseId)).toMatchObject({ actor: 'learner', key: `test.do:${quiz.id}`, title: '做 1.1 的小测' })
  expect((await h.preStep(teacher)).map(item => item.text).join('')).toContain('等学习者：做 1.1 的小测')
  // Withdrawn: the lesson needs a quiz again, not its summary.
  h.ctx.learnAssess.withdraw(quiz.id)
  expect(await next(courseId)).toMatchObject({ actor: 'teacher', key: `quiz.publish:${lesson.id}` })
  const again = h.ctx.learnAssess.startTest({ courseId, kind: 'quiz', lessonId: lesson.id, problemIds: [problems[2]!.id] })
  expect(await next(courseId)).toMatchObject({ key: `test.do:${again.id}`, title: '做 1.1 的小测' })
  // The same words about another test: the teacher is told within the turn.
  expect(await h.preStep(teacher, 2)).toEqual([{ source: 'learning-next-step', text: expect.stringMatching(/^【下一步更新】等学习者：做 1\.1 的小测/) }])
})

it('brings back tests left open, a timed one first, and hands back once when the learner drops a check', async () => {
  h = createHarness(reply)
  const { courseId, nodeId, lesson, problems } = await lessonCourse(h, 'planner A 没做完（合成资料）')
  const read = readTask(courseId, lesson.id)
  const check = await h.endpoint<Test>('assess', 'check', { courseId, nodeId })
  let step = await next(courseId)
  // A check does not take over the lesson: it waits beside the step.
  expect(step).toMatchObject({ actor: 'learner', key: `read.do:${read.id}` })
  expect(step.unfinished).toEqual([expect.objectContaining({ testId: check.id, kind: 'review', title: '考我一下 · 静水压强计算（1 题）' })])

  const timed = h.ctx.learnAssess.startTest({ courseId, kind: 'practice', problemIds: [problems[3]!.id], conditions: { book: 'closed', calculator: true, formulaSheet: false, timeLimit: 20 } })
  expect((await next(courseId)).key).toBe(`read.do:${read.id}`)
  h.ctx.learnAssess.begin(timed.id)
  step = await next(courseId)
  expect(step).toMatchObject({ actor: 'learner', key: `test.timed:${timed.id}`, title: '继续做「练习」', page: 'assess.test', params: { id: timed.id } })
  expect(step.unfinished?.map(test => test.testId)).toEqual([check.id])

  await h.settle()
  const before = h.delivered.length
  await h.endpoint('assess', 'dropCheck', { testId: check.id })
  await h.endpoint('assess', 'dropCheck', { testId: check.id })
  await h.settle()
  const notices = h.delivered.slice(before)
  expect(notices).toHaveLength(1)
  // It is the learner's turn (the timed test): the teacher reads it and waits.
  expect(notices[0]).toMatchObject({ mode: 'inject', text: expect.stringContaining('学习者没做「考我一下 · 静水压强计算（1 题）」就关掉了') })
  expect((await next(courseId)).unfinished).toBeUndefined()
  // The teacher taking a test back is the teacher's own doing: nobody is told.
  const other = h.ctx.learnAssess.startTest({ courseId, kind: 'practice', problemIds: [problems[4]!.id] })
  h.ctx.learnAssess.withdraw(other.id)
  await h.settle()
  expect(h.delivered.length).toBe(before + 1)
})

it('says nobody acts while the textbook is written, the course is archived, or the goal cannot be read', async () => {
  h = createHarness(reply)
  const { courseId, lesson } = await lessonCourse(h, 'planner A 等待（合成资料）')
  const status = vi.spyOn(h.ctx.learnTextbook, 'status').mockReturnValue({ state: 'running', message: '正在写 1.1（合成）' } as never)
  expect(await next(courseId)).toMatchObject({ actor: 'none', key: `textbook.wait:${lesson.id}`, title: '等教材 1.1 生成' })
  // A handoff now does not wake the teacher.
  await h.settle()
  const before = h.delivered.length
  h.ctx.emit('learning/handoff', { courseId, unit: 'library', text: '（合成）一份资料解析好了。' })
  await h.settle()
  expect(h.delivered.slice(before)).toEqual([expect.objectContaining({ mode: 'inject', text: expect.stringContaining('现在不需要回复') })])
  status.mockRestore()

  // A goal file the learner broke by hand: not "no goal yet", which would send the teacher to write one over it.
  await h.ctx.learnCore.files.write(courseId, COURSE_LAYOUT.goal, '---\nstatus: [confirmed\n---\n', meta)
  await expect(h.ctx.learnGoal.get(courseId)).rejects.toThrow()
  const broken = await next(courseId)
  expect(broken).toMatchObject({ actor: 'none', key: 'goal.unreadable', title: '读不了目标说明' })
  expect(broken.detail).toMatch(/^目标说明文件（goal\.md）读不出来：/)
  expect(await h.endpoint<{ text: string }>('tutor', 'brief', { courseId })).toMatchObject({ text: expect.stringContaining('现在不用你做：读不了目标说明') })

  h.ctx.learnCore.courses.setStatus(courseId, 'archived')
  expect(await next(courseId)).toMatchObject({ actor: 'none', key: 'course.archived' })
})

it('asks again after a diagnostic ended with nothing answered, until there is a roadmap', async () => {
  h = createHarness(reply)
  const course = await h.endpoint('core', 'createCourse', { title: 'planner A 摸底（合成资料）' })
  const courseId = course.id as string
  await h.ctx.learnGoal.saveDraft(courseId, {
    purpose: '摸底测试', scenario: '合成资料短题', canDo: ['按给定参数计算静水压强'], level: '能独立完成资料中的计算', verification: '小测',
    boundaries: { exclude: ['资料以外的内容'], defaultConditions: { book: 'closed', calculator: true, formulaSheet: false } },
  }, '# 目标说明\n\n仅用于测试。\n', meta)
  await h.endpoint('goal', 'confirm', { courseId })
  const fixture = join(FIXTURES, 'synthetic-chapter')
  await h.endpoint('library', 'import', { title: '合成验收资料', kind: 'textbook', authority: '1', file: join(fixture, 'source.md'), parsed: [join(fixture, 'middle.json')], courseId, role: 'skeleton' })
  const graph = await h.ctx.learnKnowledge.add(courseId, { nodes: [{ title: '静水压强计算', kind: 'skill' }] }, meta)
  const [problem] = h.ctx.learnAssess.addProblems([{
    stem: '（合成）水深 1 m，求静水压强。', answer: { kind: 'numeric', value: 10000, unit: 'Pa', tolerance: { absolute: 1 } },
    answerSource: 'book', tier: 1, origin: { kind: 'agent' }, nodeIds: [graph.nodes[0]!.id], pool: 'practice',
  }])
  expect(await next(courseId)).toMatchObject({ actor: 'teacher', key: 'diagnostic.publish' })
  const diagnostic = h.ctx.learnAssess.startTest({ courseId, kind: 'diagnostic', problemIds: [problem!.id] })
  expect(await next(courseId)).toMatchObject({ actor: 'learner', key: `test.do:${diagnostic.id}` })
  // Taken back before any answer: not a diagnostic done, so not "排课程路线" yet.
  h.ctx.learnAssess.withdraw(diagnostic.id)
  expect(await next(courseId)).toMatchObject({ actor: 'teacher', key: `diagnostic.redo:${diagnostic.id}`, title: '摸底没有做' })
  // The learner would rather not: a roadmap without a diagnostic carries the course on.
  const { stages } = await h.ctx.learnCurriculum.saveRoadmap(courseId, [{ title: '静水压强', objective: '按资料参数计算静水压强' }], meta)
  expect(await next(courseId)).toMatchObject({ actor: 'teacher', key: `stage.design:${stages[0]!.id}` })
})

it('changes nothing when read: no evidence, tests, tasks or model calls', async () => {
  h = createHarness(reply)
  const { courseId, nodeId, lesson } = await lessonCourse(h, 'planner A 只读（合成资料）')
  readTask(courseId, lesson.id)
  await h.endpoint('assess', 'check', { courseId, nodeId })
  await h.settle()
  const count = () => ({
    log: h!.ctx.learnCore.log.count(),
    tests: h!.ctx.learnAssess.tests(courseId).length,
    tasks: h!.ctx.learnCurriculum.tasks(courseId).length,
    calls: h!.calls.length,
    notices: h!.delivered.length,
  })
  const before = count()
  for (let i = 0; i < 3; i += 1) {
    await h.endpoint('planner', 'next', { courseId })
    await h.endpoint('planner', 'home', {})
  }
  await h.endpoint('tutor', 'brief', { courseId })
  await h.settle()
  expect(count()).toEqual(before)
})

it('starts one check when asked twice at once, and gives a check started without its task the task', async () => {
  h = createHarness(reply)
  const { courseId, nodeId, problems } = await lessonCourse(h, 'planner A 考我一下（合成资料）')
  const [a, b] = await Promise.all([h.endpoint<Test>('assess', 'check', { courseId, nodeId }), h.endpoint<Test>('assess', 'check', { courseId, nodeId })])
  expect(a.id).toBe(b.id)
  const tasksOf = (testId: string) => h!.ctx.learnCurriculum.tasks(courseId).filter(task => task.result?.id === testId)
  expect(tasksOf(a.id)).toHaveLength(1)
  h.ctx.learnAssess.withdraw(a.id)

  // A check whose task never got published (the process stopped in between).
  const orphan = h.ctx.learnAssess.startTest({ courseId, kind: 'review', problemIds: [problems[4]!.id], check: { nodeId } })
  expect(tasksOf(orphan.id)).toHaveLength(0)
  expect((await h.endpoint<Test>('assess', 'check', { courseId, nodeId })).id).toBe(orphan.id)
  expect(tasksOf(orphan.id)).toEqual([expect.objectContaining({ kind: 'review', status: 'open', title: '考我一下 · 静水压强计算（1 题）' })])
})
