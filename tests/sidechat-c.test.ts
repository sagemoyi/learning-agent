// sidechat C (docs/sidechat/design.md, 后续行动): a side chat drafts a change only for a definite target and only as a
// draft; the learner hands it to the teacher, who sees it in the brief and decides it as any proposal ("applied" needs
// a change made after it); the panel shows the decision; the summary and the note list the drafts. Questions are asked
// in one course from the main interface too. Synthetic data; fake model and sessions.
import { afterEach, expect, it } from 'vitest'
import type { Proposal, SideChatDraft } from '@learning-agent/contracts'
import * as sidechatTools from '../packages/sidechat/src/tools.ts'
import * as tutorTools from '../packages/tutor/src/tools.ts'
import { createHarness, type Harness, type ModelCall } from './harness.ts'
import { lessonCourse, lessonText } from './lesson-setup.ts'

let h: Harness | undefined
afterEach(() => h?.dispose())

function reply(call: ModelCall): string {
  const text = lessonText(call)
  if (text) return text
  if (call.purpose === 'learning-sidechat-summary') return JSON.stringify({ questions: [{ quote: '能不能先学浮力', text: '能不能先学浮力', nodes: [] }] })
  if (call.purpose === 'learning-tutor-ledger') return JSON.stringify({ help: [] })
  throw new Error(`unexpected model call: ${call.purpose}`)
}

type Tool = { execute(args: unknown, exec: unknown): Promise<string> }

function tools(h: Harness): Map<string, Tool> {
  const registered = new Map<string, Tool>()
  ;(h.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { registered.set(tool.name, tool as never); return () => registered.delete(tool.name) } })
  sidechatTools.apply(h.ctx as never)
  tutorTools.apply(h.ctx as never)
  return registered
}

it('drafts a change for a definite target only, and hands it to the teacher when the learner submits it', async () => {
  h = createHarness(reply)
  const { ctx, endpoint, call } = h
  const { courseId, lesson, problems, stage } = await lessonCourse(h, '侧边会话 C 修改建议（合成资料）')
  const registered = tools(h)
  const draft = (sessionId: string, args: Record<string, unknown>) => registered.get('draft_proposal')!.execute(args, { agent: { session: { id: sessionId } } })
  const file = (await ctx.learnCore.files.read(courseId, lesson.textbookFile!))!.text
  const blockId = /计算。.*\^([0-9a-z]{6})/.exec(file)![1]!

  // Asked about the whole course: "this" is nothing definite; the roadmap is.
  const whole = await ctx.learnSidechat.open({ courseId, page: 'course' } as never)
  await expect(draft(whole.sessionId, { target: 'selection', change: '换一种讲法', reason: '看不懂' })).rejects.toThrow('没有选中可以修改的内容')
  // A problem goes through 这题有问题 on the test page, not a proposal.
  const onProblem = await ctx.learnSidechat.open({ courseId, page: 'assess.test', selected: { kind: 'problem', id: problems[0]!.id, label: '第 1 题' } } as never)
  await expect(draft(onProblem.sessionId, { target: 'selection', change: '答案不对', reason: '算出来不一样' })).rejects.toThrow('这题有问题')

  const said = await draft(whole.sessionId, { target: 'roadmap', change: '把浮力调到静水压强前面先学', reason: '学习者说先学浮力更好理解' })
  expect(said).toContain('已起草（课程路线）')
  expect(said).toContain('不要说已经改了')
  // The same call again is the same draft.
  await draft(whole.sessionId, { target: 'roadmap', change: '把浮力调到静水压强前面先学', reason: '学习者说先学浮力更好理解' })
  const onBlock = await ctx.learnSidechat.open({ courseId, page: 'textbook.reader', selected: { kind: 'block', id: blockId, label: '1.1 静水压强 · 第 1 段' } } as never)
  await draft(onBlock.sessionId, { target: 'selection', change: '这一段先举个水池的例子再给公式', reason: '学习者说直接给公式太跳' })

  // Nothing reaches the teacher before the learner submits.
  expect(ctx.learnCore.proposals.list({ courseId })).toEqual([])
  const roadmapDrafts = await endpoint<SideChatDraft[]>('sidechat', 'drafts', { sessionId: whole.sessionId })
  expect(roadmapDrafts).toHaveLength(1)
  expect(roadmapDrafts[0]).toMatchObject({ status: 'draft', label: '课程路线', targets: [{ kind: 'file', path: 'roadmap.md' }] })
  const [blockDraft] = await endpoint<SideChatDraft[]>('sidechat', 'drafts', { sessionId: onBlock.sessionId })
  expect(blockDraft).toMatchObject({ label: '教材 1.1 静水压强', targets: [{ kind: 'file', path: lesson.textbookFile }] })

  // While a test is open the side chat drafts nothing either.
  const quiz = ctx.learnAssess.startTest({ courseId, kind: 'quiz', problemIds: [problems[1]!.id] })
  await expect(draft(onBlock.sessionId, { target: 'goal', change: '期末改成开卷', reason: '老师说的' })).rejects.toThrow('测试正在进行')
  await ctx.learnAssess.submit(quiz.id, [{ problemId: problems[1]!.id, text: '20000 Pa' }] as never)

  // Submitted: a side-chat proposal, the teacher is told, the brief names the target in the teacher's words.
  const heard: string[] = []
  ctx.on('learning/handoff', handoff => { heard.push(handoff.text) })
  const proposal = await endpoint<Proposal>('sidechat', 'submitDraft', { draftId: roadmapDrafts[0]!.id })
  expect(proposal).toMatchObject({ source: 'side-chat', status: 'open', summary: '课程路线：把浮力调到静水压强前面先学' })
  expect((await endpoint<Proposal>('sidechat', 'submitDraft', { draftId: roadmapDrafts[0]!.id })).id).toBe(proposal.id)
  expect(heard).toEqual(['学习者从侧边提问交来一条修改建议（课程路线）：把浮力调到静水压强前面先学'])
  expect((await call('sidechat', 'dropDraft', { draftId: roadmapDrafts[0]!.id })).error?.code).toBe('learning/sidechat/draft-submitted')
  const brief = await ctx.learnTutor.brief(courseId, '')
  expect(brief).toContain(`${proposal.id}（侧边提问里的修改建议，课程路线（roadmap.md））`)
  expect(brief).toContain('先问清学习者的想法再决定')
  expect(brief).not.toContain('教材报错')

  // The teacher has not changed the roadmap: "applied" is refused; after it rewrites the roadmap, it is accepted.
  const teacher = await ctx.learnTutor.session(courseId)
  const decide = (args: Record<string, unknown>) => registered.get('decide_proposal')!.execute(args, { agent: { session: { id: teacher } } })
  await expect(decide({ proposalId: proposal.id, decision: 'applied' })).rejects.toThrow('还没有改动')
  const roadmap = (await ctx.learnCore.files.read(courseId, 'roadmap.md'))!.text
  await ctx.learnCore.files.write(courseId, 'roadmap.md', `${roadmap}\n<!-- 浮力调整待定 -->\n`, { actor: 'teacher', reason: '按侧边提问的建议调整路线' })
  await decide({ proposalId: proposal.id, decision: 'applied', note: '先学浮力，再学静水压强' })
  await h.settle()
  const after = await endpoint<(SideChatDraft & { proposal?: { status: string; note?: string } })[]>('sidechat', 'drafts', { sessionId: whole.sessionId })
  expect(after[0]).toMatchObject({ status: 'submitted', proposal: { status: 'applied', note: '先学浮力，再学静水压强' } })

  // The learner lets the paragraph's draft go: it is no longer listed.
  await endpoint('sidechat', 'dropDraft', { draftId: blockDraft!.id })
  expect(await endpoint('sidechat', 'drafts', { sessionId: onBlock.sessionId })).toEqual([])
  expect(stage.id).toBeTruthy()
})

it('lists the chat’s drafts in its summary and note', async () => {
  h = createHarness(reply)
  const { ctx, endpoint } = h
  const { courseId } = await lessonCourse(h, '侧边会话 C 总结里的修改建议（合成资料）')
  const side = await ctx.learnSidechat.open({ courseId, page: 'course' } as never)
  await ctx.sessionController.prompt({ sessionId: side.sessionId, content: [{ type: 'text', text: '能不能先学浮力？' }] } as never, new AbortController().signal)
  const submitted = await ctx.learnSidechat.draft(side.sessionId, { target: 'roadmap', change: '先学浮力', reason: '学习者想先学浮力' })
  await ctx.learnSidechat.draft(side.sessionId, { target: 'goal', change: '目标里加上浮力的计算', reason: '学习者说考试会考' })
  const proposal = await endpoint<Proposal>('sidechat', 'submitDraft', { draftId: submitted.id })

  const summary = await ctx.learnSidechat.close(side.sessionId)
  expect(summary.proposalIds).toEqual([proposal.id])
  const note = (await ctx.learnCore.files.read(courseId, 'notes/side-chats.md'))!.text
  expect(note).toContain('- 修改建议：')
  expect(note).toContain('课程路线：先学浮力（已交给主老师）')
  expect(note).toContain('目标说明：目标里加上浮力的计算（结束时还没有交给主老师）')
})
