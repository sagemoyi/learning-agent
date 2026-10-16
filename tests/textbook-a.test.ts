// textbook A (docs/textbook/design.md, 生成与恢复), with points (讲解与原文): a lesson's run is kept in the
// database, so a restart resumes it and reuses the plan and the points already written, and the failure count
// survives; a file changed while the lesson was written is not overwritten; unchanged paragraphs keep their
// ids; paragraphs link only to the lesson's knowledge points, and the points its material sources but no
// paragraph explains are reported. Synthetic material, fake model; a restart is a second harness on the same data.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { CitedChunk, Lesson, Stage } from '@learning-agent/contracts'
import { FIXTURES, createHarness, textbookSettled, type Harness, type ModelCall } from './harness.ts'
import { isPlan, isWriter, textbookReply, titleOf, writePoint } from './textbook-fakes.ts'

const FIXTURE = join(FIXTURES, 'synthetic-long-section')
const meta = { actor: 'teacher' as const, reason: '教材 A 测试（合成）' }

const open: Harness[] = []
afterEach(() => { for (const h of open.splice(0)) h.dispose() })

type Reply = (call: ModelCall) => string | { finish: 'max-tokens' }
const plain: Reply = call => textbookReply(call) ?? (() => { throw new Error(`unexpected model call: ${call.purpose}`) })()

function harness(reply: Reply, root?: string): Harness {
  const h = createHarness(reply, {}, root ? { root } : {})
  open.push(h)
  return h
}

/** Stop `h` (its data stays) and start again on the same data. */
async function restart(h: Harness, reply: Reply): Promise<Harness> {
  await h.settle()
  open.splice(open.indexOf(h), 1)
  h.dispose(true)
  return harness(reply, h.root)
}

function setState(h: Harness, lessonId: string, state: string): void {
  h.ctx.learnCore.db.sqlite.prepare("UPDATE textbook_runs SET data = json_set(data, '$.state', ?) WHERE lesson_id = ?").run(state, lessonId)
}

function handoffs(h: Harness): string[] {
  const texts: string[] = []
  h.ctx.on('learning/handoff', event => { if (event.unit === 'textbook') texts.push(event.text) })
  return texts
}

/** A course with the long synthetic section as its skeleton, up to a confirmed-ready stage design. */
async function setUp(h: Harness, nodes: { readonly title: string; readonly source?: (chunk: CitedChunk) => boolean; readonly core?: boolean }[] = []) {
  const { ctx, endpoint } = h
  const course = await endpoint('core', 'createCourse', { title: '教材 A（合成资料）' })
  const source = await endpoint('library', 'import', {
    title: '合成长小节', kind: 'textbook', authority: '1',
    file: join(FIXTURE, 'source.md'), parsed: [join(FIXTURE, 'middle.json')], courseId: course.id, role: 'skeleton',
  })
  // The steps before the stage (goal, diagnostic), so the planner reaches the lesson.
  await ctx.learnGoal.saveDraft(course.id, {
    purpose: '验证教材生成', scenario: '合成资料', canDo: ['用静力学基本方程算压强'], level: '能独立完成', verification: '小测',
    boundaries: { exclude: [], defaultConditions: { book: 'closed', calculator: true, formulaSheet: false } },
  }, '# 目标说明\n', meta)
  await ctx.learnGoal.confirm(course.id)
  const chunks = ctx.learnLibrary.section(source.id, '1.2')
  const graph = await ctx.learnKnowledge.add(course.id, { nodes: [{ title: '诊断', kind: 'skill' as const }, ...nodes.map(node => ({ title: node.title, kind: 'knowledge' as const, ...(node.source ? { sources: [chunks.find(node.source)!.id] } : {}) }))] }, meta)
  const ids = Object.fromEntries(graph.nodes.map(node => [node.title, node.id]))
  const probe = ctx.learnLibrary.section(source.id, '习题').find(chunk => chunk.kind === 'exercise')!
  const [problem] = ctx.learnAssess.addProblems([{
    stem: probe.text, answer: { kind: 'numeric', value: 30, unit: 'kPa', tolerance: { absolute: 0.1 } }, answerSource: 'book', tier: 1,
    origin: { kind: 'chunk', chunkId: probe.id, label: probe.citation }, nodeIds: [ids['诊断']!], pool: 'practice',
  }])
  const diagnostic = ctx.learnAssess.startTest({ courseId: course.id, kind: 'diagnostic', problemIds: [problem!.id] })
  await ctx.learnAssess.submit(diagnostic.id, [{ problemId: problem!.id, text: '30 kPa' }])
  const { stages: [stage] } = await ctx.learnCurriculum.saveRoadmap(course.id, [{ title: '静止流体', objective: '会用静力学基本方程' }], meta)
  const { lessons } = await ctx.learnCurriculum.saveDesign(stage!.id, {
    markdown: '# 阶段设计\n\n## 课时\n\n1.2 静止流体的压强。', lessons: [{ number: '1.2', title: '静止流体的压强' }],
    nodeIds: nodes.filter(node => node.core).map(node => ids[node.title]!),
  }, meta)
  await h.settle()
  return { course, source, chunks, ids, stage: stage as Stage, lesson: lessons[0]! as Lesson }
}

async function generate(h: Harness, lesson: Lesson, how: 'confirm' | 'again' = 'again') {
  const settled = textbookSettled(h.ctx, lesson.id)
  if (how === 'confirm') await h.endpoint('curriculum', 'confirmDesign', { stageId: lesson.stageId })
  else await h.endpoint('textbook', 'generate', { lessonId: lesson.id })
  return settled
}

it('resumes a lesson cut off by a restart, reusing the plan and the points already written', async () => {
  const h = harness(call => {
    if (isWriter(call) && titleOf(call) === '静力学基本方程') throw new Error('模型服务暂时不可用')
    return plain(call)
  })
  const { lesson } = await setUp(h)
  expect(await generate(h, lesson, 'confirm')).toBe('failed')
  expect(h.ctx.learnTextbook.status(lesson.id)).toMatchObject({ state: 'failed', failures: 1, message: expect.stringContaining('模型服务暂时不可用') })
  const before = h.calls.filter(isWriter).map(titleOf)
  expect(before).toContain('压强的含义')
  // The retry was under way when the program stopped.
  setState(h, lesson.id, 'running')

  const after = await restart(h, plain)
  expect(after.ctx.learnTextbook.status(lesson.id)).toMatchObject({ state: 'running' })
  expect(await textbookSettled(after.ctx, lesson.id)).toBe('ready')
  // The plan and the points written before the restart are not asked for again.
  expect(after.calls.filter(isPlan)).toEqual([])
  const again = after.calls.filter(isWriter).map(titleOf)
  expect(again).toContain('静力学基本方程')
  expect(again.filter(title => before.includes(title) && title !== '静力学基本方程')).toEqual([])
  expect(after.ctx.learnTextbook.status(lesson.id)).toMatchObject({ state: 'ready', unverified: 0 })
})

it('keeps the failure count across a restart, so the second failure goes to the learner', async () => {
  const cut: Reply = () => ({ finish: 'max-tokens' })
  const h = harness(cut)
  const { course, lesson } = await setUp(h)
  expect(await generate(h, lesson, 'confirm')).toBe('failed')
  const after = await restart(h, cut)
  expect(after.ctx.learnTextbook.status(lesson.id)).toMatchObject({ state: 'failed', failures: 1 })
  expect(await after.ctx.learnPlanner.next(course.id)).toMatchObject({ actor: 'teacher', title: '教材 1.2 生成失败' })
  expect(await generate(after, lesson)).toBe('failed')
  expect(after.ctx.learnTextbook.status(lesson.id)).toMatchObject({ state: 'failed', failures: 2 })
  expect(await after.ctx.learnPlanner.next(course.id)).toMatchObject({ actor: 'learner', title: '教材 1.2 生成失败' })
})

it('finishes a lesson published just before a restart without writing it again or handing it over twice', async () => {
  const h = harness(plain)
  const { lesson } = await setUp(h)
  expect(await generate(h, lesson, 'confirm')).toBe('ready')
  // The file is written, the run not yet marked done.
  setState(h, lesson.id, 'running')

  const after = await restart(h, () => { throw new Error('no model call expected') })
  const said = handoffs(after)
  expect(await textbookSettled(after.ctx, lesson.id)).toBe('ready')
  await after.settle()
  expect(after.calls).toEqual([])
  expect(said).toHaveLength(1)
  expect(said[0]).toMatch(/^教材 1\.2 静止流体的压强 已生成/)
})

it('does not overwrite a textbook edited while the lesson was being written', async () => {
  let edit: (() => void) | undefined
  const h = harness(call => {
    edit?.()
    edit = undefined
    return plain(call)
  })
  const { course, lesson } = await setUp(h)
  expect(await generate(h, lesson, 'confirm')).toBe('ready')
  const path = join(h.ctx.learnCore.courses.folder(course.id), lesson.textbookFile!)
  edit = () => writeFileSync(path, '我在应用外改过这一节。\n', 'utf8')
  expect(await generate(h, lesson)).toBe('failed')
  expect(h.ctx.learnTextbook.status(lesson.id).message).toMatch(/被修改过.*没有覆盖/)
  expect((await h.ctx.learnCore.files.read(course.id, lesson.textbookFile!))!.text).toBe('我在应用外改过这一节。\n')
})

it('keeps the ids of the paragraphs that read the same when a lesson is written again', async () => {
  let words = '这一点用自己的话讲'
  const h = harness(call => (isWriter(call) && titleOf(call) === '静力学基本方程' ? writePoint(call, words) : plain(call)))
  const { course, lesson } = await setUp(h)
  expect(await generate(h, lesson, 'confirm')).toBe('ready')
  const ids = () => h.ctx.learnTextbook.blocks(course.id, lesson.textbookFile).map(block => block.id)
  const first = ids()
  expect(await generate(h, lesson)).toBe('ready')
  expect(ids()).toEqual(first)
  words = '这一点换了说法'
  expect(await generate(h, lesson)).toBe('ready')
  // Only the reworded paragraph is new; the copied source text and the other points keep theirs.
  expect(ids().filter((id, index) => id !== first[index])).toHaveLength(1)
})

it('links paragraphs only to the lesson\'s knowledge points and reports what is not explained', async () => {
  let cite: Record<string, string> = {}
  const h = harness(call => {
    if (!isWriter(call) || titleOf(call) !== '静力学基本方程') return plain(call)
    const formula = /\[(ck_[0-9A-Z]{26})\] [^\n]* · 公式 ·/.exec(call.prompt)![1]
    return [
      '### 静力学基本方程',
      `同一水平面上压强相等，这是列方程的出发点。[合成资料 p.2](cite:${cite.equal})`,
      `![[${formula}]]`,
      `这个式子叫静力学基本方程，读数时也要用到它。[合成资料 p.2](cite:${cite.equation})`,
    ].join('\n\n')
  })
  const said = handoffs(h)
  const { course, chunks, ids, lesson } = await setUp(h, [
    { title: '等压面', source: chunk => chunk.text.startsWith('在同一种静止、连通、密度不变的液体中，同一水平面') },
    { title: '真空度', source: chunk => chunk.text.startsWith('当绝对压强低于当地大气压时') },
    { title: '静力学基本方程', core: true },
    { title: '读数' },
  ])
  cite = {
    equal: chunks.find(chunk => chunk.text.startsWith('在同一种静止、连通、密度不变的液体中，同一水平面'))!.id,
    equation: chunks.find(chunk => chunk.text.includes('称为静力学基本方程'))!.id,
  }
  expect(await generate(h, lesson, 'confirm')).toBe('ready')
  const blocks = h.ctx.learnTextbook.blocks(course.id, lesson.textbookFile)
  const text = (await h.ctx.learnCore.files.read(course.id, lesson.textbookFile!))!.text
  const of = (start: string) => blocks.find(block => (text.split(`^${block.id}`)[0]!.split('\n\n').at(-1) ?? '').startsWith(start))!

  // By citation: the paragraph cites the chunk 等压面 is sourced in. By name: the stage's core node.
  expect(of('同一水平面上压强相等').nodeIds).toEqual([ids['等压面']])
  expect(of('这个式子叫静力学基本方程').nodeIds).toEqual([ids['静力学基本方程']])
  // 读数 is named but is neither a core node of the stage nor sourced in the lesson's material.
  expect(h.ctx.learnKnowledge.links(ids['读数']!)).toEqual([])
  // The formula copied in cites its own chunk and is source text.
  const formula = chunks.find(chunk => chunk.kind === 'formula' && chunk.text.includes('p_2 = p_1'))!
  expect(blocks.find(block => block.citations.includes(formula.id) && block.original)).toBeDefined()

  expect(h.ctx.learnTextbook.status(lesson.id)).toMatchObject({ state: 'ready', unverified: 0, uncovered: ['真空度'] })
  expect(said.at(-1)).toContain('这些知识点正文没有讲到：真空度')
  const brief = await h.ctx.learnTutor.brief(course.id, await h.ctx.learnTutor.session(course.id))
  expect(brief).toContain('这些知识点正文没有讲到：真空度')
})

it('writes by subsection when the plan is unusable', async () => {
  const h = harness(call => (isPlan(call) ? '我没法规划这一节。' : plain(call)))
  const { course, lesson } = await setUp(h)
  expect(await generate(h, lesson, 'confirm')).toBe('ready')
  expect(h.calls.filter(isPlan)).toHaveLength(1)
  expect(h.calls.filter(isWriter).map(titleOf)[0]).toMatch(/^1\.2/)
  expect(h.ctx.learnTextbook.blocks(course.id, lesson.textbookFile).length).toBeGreaterThan(0)
  expect(h.ctx.learnTextbook.status(lesson.id).check?.notes).toContainEqual(expect.stringMatching(/^列要点没有成功，按小标题分了要点：/))
})
