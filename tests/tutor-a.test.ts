// tutor A (docs/tutor/design.md, 可靠接课与简报): the course brief goes in only when the model cannot
// already see the same one, judged from the committed session log; a next step that moves on within a
// turn gets a one-line update; handoffs are stored, retried and sent again after a restart; a stage
// session is introduced on its first wake-up unless the teacher already spoke there; a failed session
// creation does not leave the course pointing at a session DSH never made. Synthetic data, fake model.
import { afterEach, expect, it } from 'vitest'
import { BRIEF_SOURCE, briefAction, fingerprint, foldBrief, type BriefState } from '../packages/tutor/src/brief.ts'
import { createHarness, type Harness } from './harness.ts'
import { lessonCourse, lessonText } from './lesson-setup.ts'

const meta = { actor: 'teacher' as const, reason: '主老师 A 测试（合成）' }
const GOAL = {
  purpose: '验证主老师的接课', scenario: '合成资料短题', canDo: ['按给定参数计算静水压强'], level: '能独立完成资料中的计算', verification: '小测',
  boundaries: { exclude: ['资料以外的内容'], defaultConditions: { book: 'closed' as const, calculator: true, formulaSheet: false } },
}

let h: Harness | undefined
afterEach(() => h?.dispose())

function reply(call: { purpose: string }): string {
  throw new Error(`unexpected model call: ${call.purpose}`)
}

async function newCourse(harness: Harness): Promise<{ courseId: string; teacher: string }> {
  const course = await harness.endpoint('core', 'createCourse', { title: '主老师 A（合成资料）' })
  await harness.settle()
  return { courseId: course.id, teacher: await harness.ctx.learnTutor.session(course.id) }
}

it('folds the committed log: a brief, an update, and a compaction that hides the brief', () => {
  let state: BriefState = { hash: null, seq: null, step: null }
  const brief = { type: 'user/message', seq: 4, data: { content: [{ type: 'text', text: '简报一' }], source: { kind: BRIEF_SOURCE, step: 'teacher|商量学习目标' } } } as never
  state = foldBrief(state, brief)
  expect(state).toEqual({ hash: fingerprint('简报一'), seq: 4, step: 'teacher|商量学习目标' })
  // Someone else's message, or a compaction of other events, leaves it alone.
  expect(foldBrief(state, { type: 'user/message', seq: 5, data: { content: [], source: { kind: 'user' } } } as never)).toBe(state)
  expect(foldBrief(state, { type: 'compaction/summary', seq: 9, data: { shadowedSeqs: [1, 2, 3] } } as never)).toBe(state)
  state = foldBrief(state, { type: 'user/message', seq: 6, data: { content: [], source: { kind: 'learning-next-step', step: 'learner|确认目标说明' } } } as never)
  expect(state.step).toBe('learner|确认目标说明')
  expect(foldBrief(state, { type: 'compaction/prune', seq: 10, data: { shadowedSeqs: [3, 4, 5] } } as never)).toEqual({ hash: null, seq: null, step: null })
  // A brief logged before the step was recorded still counts as seen.
  expect(foldBrief(state, { type: 'user/message', seq: 11, data: { content: [{ type: 'text', text: '旧简报' }], source: { kind: BRIEF_SOURCE } } } as never).step).toBeNull()

  expect(briefAction(undefined, 1, 'a', 's')).toBe('brief')
  expect(briefAction({ hash: 'a', seq: 1, step: 's' }, 1, 'a', 's')).toBe('none')
  expect(briefAction({ hash: 'a', seq: 1, step: 's' }, 1, 'b', 's')).toBe('brief')
  expect(briefAction({ hash: 'a', seq: 1, step: 's' }, 2, undefined, 't')).toBe('update')
  expect(briefAction({ hash: null, seq: null, step: null }, 3, 'a', 's')).toBe('brief')
})

it('injects the brief only when the model cannot see the same one, and updates the next step within a turn', async () => {
  h = createHarness(reply)
  const { ctx } = h
  const { courseId, teacher } = await newCourse(h)

  const first = await h.preStep(teacher)
  expect(first).toHaveLength(1)
  expect(first[0]).toMatchObject({ source: BRIEF_SOURCE, text: expect.stringContaining('该你做：商量学习目标') })
  expect(await h.preStep(teacher)).toEqual([])

  // A tool call moves the next step on: the next model call in the turn gets one line, once.
  await ctx.learnGoal.saveDraft(courseId, GOAL, '# 目标说明\n\n仅用于测试。\n', meta)
  const update = await h.preStep(teacher, 2)
  expect(update).toEqual([{ source: 'learning-next-step', text: expect.stringMatching(/^【下一步更新】等学习者：确认目标说明。.*停下来等/) }])
  expect(await h.preStep(teacher, 3)).toEqual([])

  // The next turn gets the whole brief again (the goal section changed). A brief that was assembled
  // but never committed (the turn was cancelled) does not count as seen.
  await ctx.waterfall('agent/pre-step', { agent: { session: { id: teacher } }, messages: [], turn: 2, step: 1, signal: new AbortController().signal } as never, async () => ({ kind: 'enter', messages: [] }) as never)
  const second = await h.preStep(teacher)
  expect(second.map(item => item.source)).toEqual([BRIEF_SOURCE])
  expect(second[0]!.text).toContain('等学习者：确认目标说明')
  expect(await h.preStep(teacher)).toEqual([])

  // Compaction summarizes the brief away: it goes in again though nothing changed.
  const events = h.sessions.get(teacher)!.events
  const seq = events.findLastIndex(event => (event.data as { source?: { kind?: string } }).source?.kind === BRIEF_SOURCE)
  events.push({ type: 'compaction/summary', data: { shadowedSeqs: [seq - 1, seq] } })
  expect((await h.preStep(teacher)).map(item => item.source)).toEqual([BRIEF_SOURCE])

  // Only teacher sessions get it.
  const side = await ctx.learnSidechat.open({ courseId, page: 'curriculum.progress' } as never)
  expect((await h.preStep(side.sessionId)).map(item => item.source)).not.toContain(BRIEF_SOURCE)
})

it('keeps handoffs until they are delivered: merged per course, retried after a failure, sent again after a restart', async () => {
  h = createHarness(reply)
  const { ctx } = h
  const a = await newCourse(h)
  const b = await newCourse(h)
  const before = h.delivered.length

  // Two notices for one course and one for another, together: one notice each.
  ctx.emit('learning/handoff', { courseId: a.courseId, unit: 'core', text: '甲一。' })
  ctx.emit('learning/handoff', { courseId: a.courseId, unit: 'core', text: '甲二。' })
  ctx.emit('learning/handoff', { courseId: b.courseId, unit: 'core', text: '乙一。' })
  await h.settle()
  const merged = h.delivered.slice(before)
  expect(merged).toHaveLength(2)
  expect(merged.find(item => item.sessionId === a.teacher)?.text).toMatch(/- 甲一。\n- 甲二。/)
  expect(merged.find(item => item.sessionId === b.teacher)?.text).toContain('- 乙一。')

  // DSH refuses once: nothing is lost, the retry delivers it.
  const controller = ctx.sessionController as unknown as { resolveAgent(id: string): Promise<unknown> }
  const resolve = controller.resolveAgent
  controller.resolveAgent = async () => ({ error: new Error('agent busy') })
  ctx.emit('learning/handoff', { courseId: a.courseId, unit: 'core', text: '甲三。' })
  await h.settle()
  expect(h.delivered.some(item => item.text.includes('甲三'))).toBe(false)
  controller.resolveAgent = resolve
  await h.settle(2300)
  expect(h.delivered.filter(item => item.text.includes('甲三'))).toHaveLength(1)

  // Received but not sent when DSH stopped: sent once after the restart; what was sent is not sent again.
  controller.resolveAgent = async () => ({ error: new Error('stopping') })
  ctx.emit('learning/handoff', { courseId: b.courseId, unit: 'core', text: '乙二。' })
  await h.settle()
  const root = h.root
  h.dispose(true)
  h = createHarness(reply, {}, { root })
  h.sessions.set(b.teacher, { events: [] })
  h.sessions.set(a.teacher, { events: [] })
  await h.settle()
  expect(h.delivered.map(item => item.text)).toEqual([expect.stringContaining('- 乙二。')])
})

it('introduces a stage on its first wake-up unless the teacher already spoke there', async () => {
  h = createHarness(call => lessonText(call) ?? reply(call))
  const { ctx } = h
  // DSH refuses the first wake-up of the new stage session; meanwhile the learner opened the teacher
  // page and the teacher answered. When the notice finally goes out, it does not introduce the stage again.
  const controller = ctx.sessionController as unknown as { resolveAgent(id: string): Promise<unknown> }
  const resolve = controller.resolveAgent
  const { stage, lesson } = await lessonCourse(h, '主老师 A 阶段开场（合成资料）', () => {
    controller.resolveAgent = async () => ({ error: new Error('agent busy') })
  })
  const session = ctx.learnCurriculum.stage(stage.id)!.sessionId!
  expect(session).toBeTruthy()
  h.sessions.get(session)!.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我们开始阶段 1。' }] } } })
  controller.resolveAgent = resolve
  await h.settle(2300)
  const late = h.delivered.filter(item => item.sessionId === session)
  expect(late.at(-1)?.text).toContain(`教材 ${lesson.number} ${lesson.title} 已生成`)
  expect(late.at(-1)?.text).not.toContain('第一次课')
})

it('does not leave the course on a session DSH never made', async () => {
  h = createHarness(reply, { tutor: { model: 'fixture/teacher' } })
  const { ctx } = h
  const controller = ctx.sessionController as unknown as { create(input: unknown): Promise<unknown>; selectModel(input: unknown): Promise<unknown> }
  const create = controller.create
  controller.create = async () => { throw new Error('workspace locked') }
  // The new course's own notice tries first and fails the same way.
  const course = await h.endpoint('core', 'createCourse', { title: '主老师 A 建会话（合成资料）' })
  await h.settle()
  await expect(ctx.learnTutor.session(course.id)).rejects.toThrow('workspace locked')
  const failed = ctx.learnCore.sessions.list({ courseId: course.id, role: 'teacher' })
  expect(failed.every(link => link.closedAt)).toBe(true)
  controller.create = create

  // Choosing the 主老师 model fails: the session is still usable, on the default model.
  controller.selectModel = async () => { throw new Error('no such model') }
  const sessionId = await ctx.learnTutor.session(course.id)
  expect(h.sessions.has(sessionId)).toBe(true)
  expect(await ctx.learnTutor.session(course.id)).toBe(sessionId)
})
