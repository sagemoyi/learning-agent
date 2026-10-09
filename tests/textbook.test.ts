// Textbook generation for a long lesson (the 10-04 trial: 1.2 hit the model's output limit).
// A synthetic section larger than one part is written in parts, joined into one lesson with one
// title and one "读完就答"; a part cut off at the output limit is retried as two halves; a lesson
// that still fails is reported to the teacher, who retries once before handing it back to the learner.
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Stage } from '@learning-agent/contracts'
import { FIXTURES, createHarness, textbookSettled, type Harness, type ModelCall } from './harness.ts'

const FIXTURE = join(FIXTURES, 'synthetic-long-section')
const meta = { actor: 'teacher' as const, reason: '长小节测试' }

let h: Harness | undefined
afterEach(() => h?.dispose())

const isWriter = (call: ModelCall) => call.purpose === 'learning-textbook' && call.system.startsWith('你是教材编写者')
const isQuestions = (call: ModelCall) => call.purpose === 'learning-textbook' && call.system.startsWith('你为一节教材写')

/** A writer reply for one part: a paragraph citing the first chunk the part was given. */
function writePart(call: ModelCall): string {
  const chunk = /\[(ck_[0-9A-Z]{26})\]/.exec(call.prompt)![1]
  const title = call.prompt.includes('这是第一部分') || call.prompt.includes('整节') ? '## 1.2 静止流体的压强（合成长小节）\n\n' : ''
  return `${title}### 一部分\n\n这一部分讲的内容。[合成资料 p.1](cite:${chunk})`
}

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

it('writes a long lesson in parts and joins them', async () => {
  const { course, stage, lesson } = await setUp(call => {
    if (isQuestions(call)) return '### 读完就答\n\n1. 表压强和绝对压强差在哪里？\n2. 等压面要满足哪些条件？'
    return writePart(call)
  })
  const settled = textbookSettled(h!.ctx, lesson.id)
  await h!.endpoint('curriculum', 'confirmDesign', { stageId: stage.id })
  expect(await settled).toBe('ready')

  const writers = h!.calls.filter(isWriter)
  expect(writers).toHaveLength(2)
  const [first, ...rest] = [...writers].sort((a, b) => Number(b.prompt.includes('这是第一部分')) - Number(a.prompt.includes('这是第一部分')))
  expect(first!.prompt).toContain('这是第一部分')
  expect(rest.every(call => call.prompt.includes('这不是第一部分'))).toBe(true)
  // Parts split the section's material (every part sees the outline) and never see exercises or their answers.
  expect(first!.prompt).toContain('单位面积上受到的垂直作用力')
  expect(first!.prompt).not.toContain('本小节的合成内容可以归纳为三点')
  expect(rest.at(-1)!.prompt).toContain('本小节的合成内容可以归纳为三点')
  for (const call of writers) {
    expect(call.prompt).not.toContain('1-6')
    expect(call.prompt).not.toContain('[30 kPa]')
  }
  expect(h!.calls.filter(isQuestions)).toHaveLength(1)

  const file = await h!.ctx.learnCore.files.read(course.id, lesson.textbookFile!)
  const lines = file!.text.split('\n')
  expect(lines.filter(line => line.startsWith('## '))).toEqual(['## 1.2 静止流体的压强（合成长小节）'])
  expect(lines.filter(line => line.startsWith('### 读完就答'))).toHaveLength(1)
  expect(h!.ctx.learnTextbook.status(lesson.id)).toMatchObject({ state: 'ready', unverified: 0 })
  expect(h!.ctx.learnCurriculum.stage(stage.id)?.status).toBe('ready')
})

it('does not bind textbook blocks to every same-name identity', async () => {
  const { course, stage, lesson } = await setUp(call => {
    if (isQuestions(call)) return '### 读完就答\n\n1. 合成问题？'
    return writePart(call).replace('这一部分讲的内容', '静力学基本方程用于这一部分')
  })
  // The teacher may not repeat a name in a course; the learner may, deliberately.
  const duplicate = await h!.ctx.learnKnowledge.add(course.id, { nodes: [{ title: '静力学基本方程', kind: 'skill', domain: '不同能力' }] }, { actor: 'user', reason: '同名异义' })
  const settled = textbookSettled(h!.ctx, lesson.id)
  await h!.endpoint('curriculum', 'confirmDesign', { stageId: stage.id })
  expect(await settled).toBe('ready')
  expect(h!.ctx.learnTextbook.blocks(course.id).length).toBeGreaterThan(0)
  expect(h!.ctx.learnTextbook.blocks(course.id).every(block => block.nodeIds.length === 0)).toBe(true)
  expect(duplicate.nodes.every(node => h!.ctx.learnKnowledge.links(node.id).length === 0)).toBe(true)
})

it('retries a cut-off part as two halves', async () => {
  let cut = false
  const { lesson } = await setUp(call => {
    if (isQuestions(call)) return '### 读完就答\n\n1. 问题一？\n2. 问题二？'
    // The first part's first attempt runs out of output budget.
    if (!cut && call.prompt.includes('这是第一部分')) {
      cut = true
      return { finish: 'max-tokens' }
    }
    return writePart(call)
  })
  const settled = textbookSettled(h!.ctx, lesson.id)
  await h!.endpoint('curriculum', 'confirmDesign', { stageId: lesson.stageId })
  expect(await settled).toBe('ready')
  // 1 cut-off attempt + 2 halves + the second part.
  expect(h!.calls.filter(isWriter)).toHaveLength(4)
  const file = await h!.ctx.learnCore.files.read((await h!.ctx.learnCurriculum.stage(lesson.stageId))!.courseId, lesson.textbookFile!)
  expect(file!.text.split('\n').filter(line => line.startsWith('## '))).toHaveLength(1)
})

it('keeps the stage designing when the first lesson fails and a later textbook succeeds', async () => {
  const { course, stage } = await setUp(call => isQuestions(call)
    ? '### 读完就答\n\n1. 问题一？\n2. 问题二？'
    : writePart(call))
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
