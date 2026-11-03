// curriculum (docs/curriculum/design.md, 阶段和进度页) and textbook (docs/textbook/design.md, 发布、恢复和块 ID): what
// events drive is derived again from facts at start, so an event lost between a commit and its listeners (a crash, a
// listener that failed) is made up for. A lost event is simulated by dropping it, or by putting the listener's own
// rows back to what they were before it.
import { afterEach, expect, it } from 'vitest'
import { createHarness, textbookSettled, type Harness } from '../harness.ts'
import { lessonCourse, lessonText } from '../lesson-setup.ts'

let h: Harness | undefined
afterEach(() => { h?.dispose() })

function reply(call: { purpose: string }): string {
  const lesson = lessonText(call as never)
  if (lesson !== undefined) return lesson
  throw new Error(`unexpected model call: ${call.purpose}`)
}

/** Rewrite one curriculum row's JSON as it was before an event's listener ran. */
function rewind(table: 'curriculum_stages' | 'curriculum_tasks', id: string, patch: Record<string, unknown>): void {
  const sqlite = h!.ctx.learnCore.db.sqlite
  const row = sqlite.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string }
  const data = { ...JSON.parse(row.data), ...patch }
  for (const [key, value] of Object.entries(patch)) if (value === undefined) delete data[key]
  sqlite.prepare(`UPDATE ${table} SET data = ?${table === 'curriculum_tasks' ? ', status = ?' : ''} WHERE id = ?`)
    .run(...(table === 'curriculum_tasks' ? [JSON.stringify(data), data.status, id] : [JSON.stringify(data), id]))
}

/** Stop and start again on the same data. */
async function restart(): Promise<void> {
  const root = h!.root
  h!.dispose(true)
  h = createHarness(reply, {}, { root })
  await h.settle()
}

it('makes up for lost textbook-ready, task-published and test-finished events at the next start', async () => {
  h = createHarness(reply)
  const { courseId, stage, nodeId } = await lessonCourse(h, '状态对账（合成资料）')
  expect(h.ctx.learnCurriculum.stage(stage.id)?.status).toBe('ready')

  // The handout is written, but the stage never heard: it waits in "designing" until the next start.
  rewind('curriculum_stages', stage.id, { status: 'designing' })
  await restart()
  expect(h.ctx.learnCurriculum.stage(stage.id)?.status).toBe('ready')

  // A stage test is published; the stage did not move to testing.
  const [reserved] = h.ctx.learnAssess.addProblems([{
    stem: '（合成）水深 3 m 处的静水压强是多少？', answer: { kind: 'numeric', value: 30000, unit: 'Pa', tolerance: { absolute: 1 } },
    answerSource: 'authority', tier: 2, origin: { kind: 'agent' }, nodeIds: [nodeId as never], pool: 'test-reserved',
  }])
  const test = h.ctx.learnAssess.startTest({ courseId, kind: 'stage', stageId: stage.id, problemIds: [reserved!.id] })
  const task = h.ctx.learnCurriculum.publishTask({ courseId: courseId as never, stageId: stage.id, kind: 'stage-test', title: '阶段测试', instructions: '独立完成', createdBy: 'teacher', result: { kind: 'test', id: test.id } })
  expect(h.ctx.learnCurriculum.stage(stage.id)?.status).toBe('testing')
  rewind('curriculum_stages', stage.id, { status: 'learning' })
  await restart()
  expect(h.ctx.learnCurriculum.stage(stage.id)?.status).toBe('testing')

  // The stage test is graded; its task and the stage did not follow.
  await h.endpoint('assess', 'submit', { testId: test.id, answers: [{ problemId: reserved!.id, text: '30000 Pa' }] })
  expect(h.ctx.learnCurriculum.stage(stage.id)?.status).toBe('reviewing')
  rewind('curriculum_stages', stage.id, { status: 'testing' })
  rewind('curriculum_tasks', task.id, { status: 'open', doneAt: undefined })
  await restart()
  expect(h.ctx.learnCurriculum.stage(stage.id)?.status).toBe('reviewing')
  expect(h.ctx.learnCurriculum.tasks(courseId).find(item => item.id === task.id)?.status).toBe('done')

  // Facts already reflected change nothing on another start.
  const before = h.ctx.learnCurriculum.stages(courseId)
  await restart()
  expect(h.ctx.learnCurriculum.stages(courseId)).toEqual(before)
})

it('starts the handout of a design confirmed just before a stop, and indexes a handout whose index fell behind', async () => {
  h = createHarness(reply)
  await h.settle()
  const stop = new Error('在确认设计前停下')
  await expect(lessonCourse(h, '讲义对账（合成资料）', () => { throw stop })).rejects.toBe(stop)
  const courseId = h.ctx.learnCore.courses.list()[0]!.id
  const stage = h.ctx.learnCurriculum.stages(courseId)[0]!
  const lesson = h.ctx.learnCurriculum.lessons(stage.id)[0]!

  // Confirmed; the stage-changed event that starts the handout never reached textbook.
  rewind('curriculum_stages', stage.id, { designConfirmedAt: new Date().toISOString() })
  await h.settle()
  expect(h.ctx.learnTextbook.status(lesson.id).state).toBe('missing')

  const root = h.root
  h.dispose(true)
  h = createHarness(reply, {}, { root })
  expect(await textbookSettled(h.ctx, lesson.id)).toBe('ready')
  await h.settle()
  expect(h.ctx.learnCurriculum.stage(stage.id)?.status).toBe('ready')

  // The handout was replaced, but its block index was not rebuilt.
  const file = h.ctx.learnCurriculum.lesson(lesson.id)!.textbookFile!
  const blocks = h.ctx.learnTextbook.blocks(courseId, file)
  expect(blocks.length).toBeGreaterThan(0)
  h.ctx.learnCore.db.sqlite.prepare('DELETE FROM textbook_blocks WHERE course_id = ? AND file = ?').run(courseId, file)
  await restart()
  expect(h.ctx.learnTextbook.blocks(courseId, file).map(block => block.id)).toEqual(blocks.map(block => block.id))
})
