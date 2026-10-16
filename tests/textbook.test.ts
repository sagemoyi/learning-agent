// A lesson is planned, then written point by point (docs/textbook/design.md, 讲解与原文): the writer explains in
// its own words and names the source text to copy in; the program copies it and joins the points into one
// lesson with one title and one "读完就答". A point cut off at the output limit is written again as two
// halves; a lesson that still fails is reported to the teacher, who retries once before handing it back.
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Stage } from '@learning-agent/contracts'
import { FIXTURES, createHarness, textbookSettled, type Harness, type ModelCall } from './harness.ts'
import { isPlan, isWriter, textbookReply, titleOf, writePoint } from './textbook-fakes.ts'

const FIXTURE = join(FIXTURES, 'synthetic-long-section')
const meta = { actor: 'teacher' as const, reason: '长小节测试' }

let h: Harness | undefined
afterEach(() => h?.dispose())

/** The usual fake, or `fallback` for a call it does not know. */
const usual = (call: ModelCall) => textbookReply(call) ?? (() => { throw new Error(`unexpected model call: ${call.purpose}`) })()

async function setUp(reply: (call: ModelCall) => string | { finish: 'max-tokens' }) {
  h = createHarness(reply)
  const { ctx, endpoint } = h
  const course = await endpoint('core', 'createCourse', { title: '长小节（合成资料）' })
  const source = await endpoint('library', 'import', {
    title: '合成长小节', kind: 'textbook', authority: '1',
    file: join(FIXTURE, 'source.md'), parsed: [join(FIXTURE, 'middle.json')], courseId: course.id, role: 'skeleton',
  })
  // The steps before the stage (goal, graph, diagnostic), so the planner reaches the lesson.
  await ctx.learnGoal.saveDraft(course.id, {
    purpose: '验证长小节', scenario: '合成资料', canDo: ['用静力学基本方程算压强'], level: '能独立完成', verification: '小测',
    boundaries: { exclude: [], defaultConditions: { book: 'closed', calculator: true, formulaSheet: false } },
  }, '# 目标说明\n', meta)
  await ctx.learnGoal.confirm(course.id)
  const node = (await ctx.learnKnowledge.add(course.id, { nodes: [{ title: '静力学基本方程', kind: 'knowledge' }] }, meta)).nodes[0]!
  const exercise = ctx.learnLibrary.section(source.id, '习题').find(chunk => chunk.kind === 'exercise')!
  const [problem] = ctx.learnAssess.addProblems([{
    stem: exercise.text, answer: { kind: 'numeric', value: 30, unit: 'kPa', tolerance: { absolute: 0.1 } }, answerSource: 'book', tier: 1,
    origin: { kind: 'chunk', chunkId: exercise.id, label: exercise.citation }, nodeIds: [node.id], pool: 'practice',
  }])
  const diagnostic = ctx.learnAssess.startTest({ courseId: course.id, kind: 'diagnostic', problemIds: [problem!.id] })
  await ctx.learnAssess.submit(diagnostic.id, [{ problemId: problem!.id, text: '30 kPa' }])
  const { stages: [stage] } = await ctx.learnCurriculum.saveRoadmap(course.id, [{ title: '静止流体', objective: '会用静力学基本方程' }], meta)
  const { lessons } = await ctx.learnCurriculum.saveDesign(stage!.id, { markdown: '# 阶段设计\n\n## 课时\n\n1.2 静止流体的压强。', lessons: [{ number: '1.2', title: '静止流体的压强' }] }, meta)
  await h.settle()
  return { course, stage: stage as Stage, lesson: lessons[0]! }
}

it('plans the points, writes each in its own words with the source text copied in, and joins them', async () => {
  const { course, stage, lesson } = await setUp(usual)
  const settled = textbookSettled(h!.ctx, lesson.id)
  await h!.endpoint('curriculum', 'confirmDesign', { stageId: stage.id })
  expect(await settled).toBe('ready')

  // One plan over the whole section, which also sees the chapter's exercises (stems only).
  const [plan, ...others] = h!.calls.filter(isPlan)
  expect(others).toEqual([])
  expect(plan!.prompt).toContain('1.2.1 压强的含义')
  expect(plan!.prompt).toContain('敞口水槽中水深 3 m')
  expect(plan!.prompt).not.toContain('[30 kPa]')
  // A point per subsection; each writer sees only its own material, and never an exercise.
  const writers = h!.calls.filter(isWriter)
  expect(writers.map(titleOf).sort()).toEqual(['压强的几种表示', '压强的含义', '基本方程的应用', '小结', '常见误区', '静力学基本方程'].sort())
  const first = writers.find(call => titleOf(call) === '压强的含义')!
  expect(first.prompt).toContain('单位面积上受到的垂直作用力')
  expect(first.prompt).not.toContain('本小节的合成内容可以归纳为三点')
  for (const call of writers) {
    expect(call.prompt).not.toContain('敞口水槽中水深 3 m')
    expect(call.prompt).not.toContain('[30 kPa]')
  }
  expect(h!.calls.filter(call => call.system.startsWith('你为一节教材写'))).toHaveLength(1)

  const text = (await h!.ctx.learnCore.files.read(course.id, lesson.textbookFile!))!.text
  const lines = text.split('\n')
  expect(lines.filter(line => line.startsWith('## '))).toEqual(['## 1.2 静止流体的压强'])
  // Each point once, in reading order, then the questions.
  expect(lines.filter(line => line.startsWith('### '))).toEqual(['### 压强的含义', '### 压强的几种表示', '### 静力学基本方程', '### 基本方程的应用', '### 常见误区', '### 小结', '### 读完就答'])
  // The formula comes in as the material has it, in a quote box headed by its citation.
  const formula = h!.ctx.learnLibrary.courseSources(course.id).flatMap(entry => h!.ctx.learnLibrary.section(entry.sourceId, '1.2.3')).find(chunk => chunk.kind === 'formula')!
  expect(text).toContain(`> [!quote] 原文 · [${formula.citation}](cite:${formula.id})\n${formula.text.split('\n').map(line => `> ${line}`).join('\n')}\n\n^`)
  const blocks = h!.ctx.learnTextbook.blocks(course.id, lesson.textbookFile)
  expect(blocks.filter(block => block.original).length).toBeGreaterThan(0)
  expect(h!.ctx.learnTextbook.status(lesson.id)).toMatchObject({ state: 'ready', unverified: 0, check: { state: 'checked' } })
  expect(h!.ctx.learnCurriculum.stage(stage.id)?.status).toBe('ready')
})

it('does not bind textbook blocks to every same-name identity', async () => {
  const { course, stage, lesson } = await setUp(call => (isWriter(call) ? writePoint(call, '静力学基本方程用于这一点') : usual(call)))
  // The teacher may not repeat a name in a course; the learner may, deliberately.
  const duplicate = await h!.ctx.learnKnowledge.add(course.id, { nodes: [{ title: '静力学基本方程', kind: 'skill', domain: '不同能力' }] }, { actor: 'user', reason: '同名异义' })
  const settled = textbookSettled(h!.ctx, lesson.id)
  await h!.endpoint('curriculum', 'confirmDesign', { stageId: stage.id })
  expect(await settled).toBe('ready')
  expect(h!.ctx.learnTextbook.blocks(course.id).length).toBeGreaterThan(0)
  expect(h!.ctx.learnTextbook.blocks(course.id).every(block => block.nodeIds.length === 0)).toBe(true)
  expect(duplicate.nodes.every(node => h!.ctx.learnKnowledge.links(node.id).length === 0)).toBe(true)
})

it('writes a cut-off point again as two halves, the second going on without a heading', async () => {
  let cut = false
  const { course, lesson } = await setUp(call => {
    // The first attempt at 静力学基本方程 runs out of output budget.
    if (!cut && isWriter(call) && titleOf(call) === '静力学基本方程') {
      cut = true
      return { finish: 'max-tokens' }
    }
    return usual(call)
  })
  const settled = textbookSettled(h!.ctx, lesson.id)
  await h!.endpoint('curriculum', 'confirmDesign', { stageId: lesson.stageId })
  expect(await settled).toBe('ready')
  const again = h!.calls.filter(isWriter).filter(call => titleOf(call) === '静力学基本方程')
  // 1 cut-off attempt + 2 halves; the second half goes on under the same heading.
  expect(again).toHaveLength(3)
  expect(again[2]!.prompt).toContain('不要写标题')
  const text = (await h!.ctx.learnCore.files.read(course.id, lesson.textbookFile!))!.text
  expect(text.split('\n').filter(line => line === '### 静力学基本方程')).toHaveLength(1)
})

it('keeps the stage designing when the first lesson fails and a later textbook succeeds', async () => {
  const { course, stage } = await setUp(usual)
  const { lessons } = await h!.ctx.learnCurriculum.saveDesign(stage.id, {
    markdown: '# 阶段设计\n\n## 课时\n\n先学 1.1，再学 1.2。',
    lessons: [{ number: '1.1', title: '无资料占位' }, { number: '1.2', title: '静止流体的压强' }],
  }, meta)
  const later = textbookSettled(h!.ctx, lessons[1]!.id)
  await h!.endpoint('curriculum', 'confirmDesign', { stageId: stage.id })
  expect(await later).toBe('ready')
  await h!.settle()
  expect(h!.ctx.learnTextbook.status(lessons[0]!.id)).toMatchObject({ state: 'failed' })
  expect(h!.ctx.learnCurriculum.stage(stage.id)?.status).toBe('designing')
  const sessionId = await h!.ctx.learnTutor.session(course.id)
  expect(h!.ctx.learnCore.sessions.get(sessionId)?.stageId).toBeUndefined()
  expect(await h!.ctx.learnPlanner.next(course.id)).toMatchObject({ actor: 'teacher', title: '教材 1.1 生成失败' })
})

it('hands a failed lesson to the teacher once, then to the learner', async () => {
  const { course, lesson } = await setUp(() => ({ finish: 'max-tokens' }))
  let settled = textbookSettled(h!.ctx, lesson.id)
  await h!.endpoint('curriculum', 'confirmDesign', { stageId: lesson.stageId })
  expect(await settled).toBe('failed')
  await h!.settle()
  const status = h!.ctx.learnTextbook.status(lesson.id)
  expect(status).toMatchObject({ state: 'failed', failures: 1 })
  expect(status.message).toContain('超出模型单次能写的长度')
  const first = await h!.ctx.learnPlanner.next(course.id)
  expect(first).toMatchObject({ actor: 'teacher', title: '教材 1.2 生成失败' })
  expect(h!.delivered.at(-1)).toMatchObject({ mode: 'followup', text: expect.stringContaining('教材 1.2 静止流体的压强 生成失败') })

  // The teacher retries (regenerate_textbook); a second failure goes back to the learner, without waking the teacher.
  settled = textbookSettled(h!.ctx, lesson.id)
  void h!.ctx.learnTextbook.generateLesson(lesson.id).catch(() => {})
  expect(await settled).toBe('failed')
  await h!.settle()
  expect(await h!.ctx.learnPlanner.next(course.id)).toMatchObject({ actor: 'learner', title: '教材 1.2 生成失败' })
  expect(h!.delivered.at(-1)).toMatchObject({ mode: 'inject' })
})
