// textbook (docs/textbook/design.md): a stage's generation is kept in the database, so a restart resumes it and
// reuses the replies already written, and the failure count survives; a file changed since the run began (while it
// was written, or while the program was stopped) is not overwritten, and the learner picks the new handout or the
// file; unchanged paragraphs keep their ids, replaced ones are recorded; paragraphs link only to the
// stage's knowledge points, and the points its material sources but no paragraph explains are reported; an
// unusable plan still gives the sections. Synthetic material, fake model; a restart is a second harness on the
// same data.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createHarness, textbookSettled, type Harness } from '../harness.ts'
import {
  blockOf, confirm, handoutCourse, handoutText, isOverview, isPlan, isSection, materialOf, planReply, sectionOf, sectionReply, usual,
  type HandoutCourse, type HandoutOptions, type Reply,
} from './fakes.ts'

const open: Harness[] = []
afterEach(() => { for (const h of open.splice(0)) h.dispose() })

const THREE = [{ number: '1.2.2', title: '压强的几种表示' }, { number: '1.2.3', title: '静力学基本方程' }, { number: '1.2.4', title: '基本方程的应用' }]

async function setUp(reply: Reply, options?: HandoutOptions): Promise<HandoutCourse> {
  const course = await handoutCourse(reply, options)
  open.push(course.h)
  return course
}

/** Stop the course's harness (its data stays) and start again on the same data. */
async function restart(course: HandoutCourse, reply: Reply): Promise<HandoutCourse> {
  const { h } = course
  await h.settle()
  open.splice(open.indexOf(h), 1)
  h.dispose(true)
  const after = createHarness(reply, { textbook: { webCheck: false } }, { root: h.root })
  open.push(after)
  return { ...course, h: after }
}

function setState(course: HandoutCourse, state: string): void {
  course.h.ctx.learnCore.db.sqlite.prepare("UPDATE textbook_handouts SET data = json_set(data, '$.state', ?) WHERE stage_id = ?").run(state, course.stage.id)
}

function handoffs(h: Harness): string[] {
  const texts: string[] = []
  h.ctx.on('learning/handoff', event => { if (event.unit === 'textbook') texts.push(event.text) })
  return texts
}

/** The handout's state once it is no longer being written (a held handout fires neither ready nor failed). */
async function stopped(course: HandoutCourse): Promise<string> {
  for (let i = 0; i < 300; i++) {
    const { state } = course.h.ctx.learnTextbook.status(course.lessons[0]!.id)
    if (state !== 'running') return state
    await course.h.settle(10)
  }
  throw new Error('the handout is still being written')
}

/** Write the handout again, as the teacher's regenerate_textbook and the reader's button do. */
async function again(course: HandoutCourse) {
  const settled = textbookSettled(course.h.ctx, course.lessons[0]!.id)
  await course.h.endpoint('textbook', 'generate', { lessonId: course.lessons[0]!.id })
  return settled
}

it('resumes a handout cut off by a restart, reusing the replies already written', async () => {
  const course = await setUp(call => {
    if (isSection(call) && sectionOf(call) === '1.2.4 基本方程的应用') throw new Error('模型服务暂时不可用')
    return usual(call)
  }, { lessons: THREE })
  const [lesson] = course.lessons
  expect(await confirm(course)).toBe('failed')
  expect(course.h.ctx.learnTextbook.status(lesson!.id)).toMatchObject({ state: 'failed', failures: 1, message: expect.stringContaining('模型服务暂时不可用') })
  const before = course.h.calls.filter(isSection).map(sectionOf)
  expect(before).toContain('1.2.2 压强的几种表示')
  // The retry was under way when the program stopped.
  setState(course, 'running')

  const after = await restart(course, usual)
  expect(after.h.ctx.learnTextbook.status(lesson!.id)).toMatchObject({ state: 'running' })
  expect(await textbookSettled(after.h.ctx, lesson!.id)).toBe('ready')
  // The plan, the overview and the sections written before the restart are not asked for again.
  expect(after.h.calls.filter(call => isPlan(call) || isOverview(call))).toEqual([])
  const written = after.h.calls.filter(isSection).map(sectionOf)
  expect(written).toContain('1.2.4 基本方程的应用')
  expect(written.filter(title => before.includes(title) && title !== '1.2.4 基本方程的应用')).toEqual([])
  expect(after.h.ctx.learnTextbook.status(lesson!.id)).toMatchObject({ state: 'ready', unverified: 0 })
  expect(await handoutText(after)).toContain('### 1.2.4 基本方程的应用')
})

it('keeps the failure count across a restart, so the second failure goes to the learner', async () => {
  const cut: Reply = () => ({ finish: 'max-tokens' })
  const course = await setUp(cut)
  const [lesson] = course.lessons
  expect(await confirm(course)).toBe('failed')
  const after = await restart(course, cut)
  expect(after.h.ctx.learnTextbook.status(lesson!.id)).toMatchObject({ state: 'failed', failures: 1 })
  expect(await after.h.ctx.learnPlanner.next(after.courseId)).toMatchObject({ actor: 'teacher', title: '讲义生成失败' })
  expect(await again(after)).toBe('failed')
  expect(after.h.ctx.learnTextbook.status(lesson!.id)).toMatchObject({ state: 'failed', failures: 2 })
  expect(await after.h.ctx.learnPlanner.next(after.courseId)).toMatchObject({ actor: 'learner', title: '讲义生成失败' })
})

it('finishes a handout published just before a restart without writing it again or handing it over twice', async () => {
  const course = await setUp(usual)
  expect(await confirm(course)).toBe('ready')
  // The file is written, the run not yet marked done.
  setState(course, 'running')

  const after = await restart(course, () => { throw new Error('no model call expected') })
  const said = handoffs(after.h)
  expect(await textbookSettled(after.h.ctx, after.lessons[0]!.id)).toBe('ready')
  await after.h.settle()
  expect(after.h.calls).toEqual([])
  expect(said).toHaveLength(1)
  expect(said[0]).toMatch(/^讲义 静止流体 已生成/)
})

it('does not overwrite a handout edited while it was being written; the learner may take the new one', async () => {
  let edit: (() => void) | undefined
  const course = await setUp(call => {
    edit?.()
    edit = undefined
    return usual(call)
  })
  const { h, courseId } = course
  const lessonId = course.lessons[0]!.id
  expect(await confirm(course)).toBe('ready')
  const file = h.ctx.learnCurriculum.lesson(lessonId)!.textbookFile!
  const path = join(h.ctx.learnCore.courses.folder(courseId), file)
  edit = () => writeFileSync(path, '我在应用外改过讲义。\n', 'utf8')
  await h.endpoint('textbook', 'generate', { lessonId })
  expect(await stopped(course)).toBe('conflict')
  expect(readFileSync(path, 'utf8')).toBe('我在应用外改过讲义。\n')
  expect(h.ctx.learnTextbook.status(lessonId)).toMatchObject({ state: 'conflict', draft: expect.stringContaining('### ') })
  expect(await h.ctx.learnPlanner.next(courseId)).toMatchObject({ actor: 'learner', title: '选用哪一份讲义' })

  expect(await h.endpoint('textbook', 'resolveConflict', { lessonId, choice: 'replace' })).toMatchObject({ state: 'ready' })
  expect(readFileSync(path, 'utf8')).toContain('### ')
  // The outside version is in the change log.
  expect(h.ctx.learnCore.changes.list({ courseId, limit: 10 }).map(change => change.after)).toContain('我在应用外改过讲义。\n')
  expect((await h.call('textbook', 'resolveConflict', { lessonId, choice: 'keep' })).error?.code).toBe('learning/textbook/no-conflict')
})

it('does not overwrite a handout changed while the program was stopped, resuming without asking the model again', async () => {
  let cut = false
  const reply: Reply = call => {
    if (cut && isSection(call)) throw new Error('模型服务暂时不可用')
    return usual(call)
  }
  let course = await setUp(reply)
  const lessonId = course.lessons[0]!.id
  expect(await confirm(course)).toBe('ready')
  const path = () => join(course.h.ctx.learnCore.courses.folder(course.courseId), course.h.ctx.learnCurriculum.lesson(lessonId)!.textbookFile!)
  const published = readFileSync(path(), 'utf8')

  // Written again, cut off; while the program is stopped the learner adds a note in Obsidian.
  cut = true
  expect(await again(course)).toBe('failed')
  setState(course, 'running')
  const noted = `${published}\n我在程序停着时补的笔记。\n`
  writeFileSync(path(), noted, 'utf8')
  cut = false
  course = await restart(course, reply)
  expect(await stopped(course)).toBe('conflict')
  expect(readFileSync(path(), 'utf8')).toBe(noted)
  expect(course.h.calls.filter(call => isPlan(call) || isOverview(call))).toEqual([])
  // The learner keeps the file: it is the stage's handout, indexed as it is.
  expect(await course.h.endpoint('textbook', 'resolveConflict', { lessonId, choice: 'keep' })).toMatchObject({ state: 'ready' })
  expect(readFileSync(path(), 'utf8')).toBe(noted)
  expect(await course.h.endpoint('textbook', 'lesson', { lessonId })).toMatchObject({ text: noted, status: { state: 'ready' } })

  // The same with the file deleted meanwhile: there is nothing to keep, the new handout can be taken.
  cut = true
  expect(await again(course)).toBe('failed')
  setState(course, 'running')
  rmSync(path())
  cut = false
  course = await restart(course, reply)
  expect(await stopped(course)).toBe('conflict')
  expect((await course.h.call('textbook', 'resolveConflict', { lessonId, choice: 'keep' })).error?.code).toBe('learning/textbook/missing')
  expect(await course.h.endpoint('textbook', 'resolveConflict', { lessonId, choice: 'replace' })).toMatchObject({ state: 'ready' })
  expect(readFileSync(path(), 'utf8')).toContain('### ')
})

it('keeps the ids of the paragraphs that read the same when written again, and records the ones replaced', async () => {
  let words = '这一节用自己的话讲'
  const course = await setUp(call => (isSection(call) && sectionOf(call) === '1.2.3 静力学基本方程' ? sectionReply(call, words) : usual(call)), { lessons: THREE })
  const { h, courseId } = course
  expect(await confirm(course)).toBe('ready')
  const ids = () => h.ctx.learnTextbook.blocks(courseId).map(block => block.id)
  const first = ids()
  expect(await again(course)).toBe('ready')
  expect(ids()).toEqual(first)
  const reworded = h.ctx.learnTextbook.blocks(courseId).find(block => block.lessonId === course.lessons[1]!.id && !block.original)!
  words = '这一节换了说法'
  expect(await again(course)).toBe('ready')
  // Only the reworded paragraph is new; the tables, the source text and the other sections keep theirs. The old
  // one is recorded as replaced, so its notes can still find its text.
  const now = ids()
  expect(now.filter(id => !first.includes(id))).toHaveLength(1)
  expect(first.filter(id => !now.includes(id))).toEqual([reworded.id])
  expect(h.ctx.learnTextbook.revisions(courseId, reworded.id)).toEqual([expect.objectContaining({ blockId: reworded.id, into: [], reason: '重新生成讲义' })])
})

it('links paragraphs only to the stage\'s knowledge points and reports what is not explained', async () => {
  const equal = (text: string) => text.startsWith('在同一种静止、连通、密度不变的液体中，同一水平面')
  const course = await setUp(call => {
    if (isPlan(call)) return planReply(call, { terms: [{ name: '等压面', chunk: 0 }] })
    if (!isSection(call)) return usual(call)
    const material = materialOf(call)
    return [
      `同一水平面上压强相等，这是列方程的出发点。[合成资料 p.2](cite:${material.find(chunk => equal(chunk.text))!.id})`,
      `![[${material.find(chunk => chunk.kind === '公式' )!.id}]]`,
      `这个式子叫静力学基本方程，读数时也要用到它。[合成资料 p.2](cite:${material.find(chunk => chunk.text.includes('称为静力学基本方程'))!.id})`,
    ].join('\n\n')
  }, {
    nodes: [
      { title: '等压面', source: chunk => equal(chunk.text) },
      { title: '真空度', source: chunk => chunk.text.startsWith('当绝对压强低于当地大气压时') },
      { title: '静力学基本方程', core: true },
      { title: '读数' },
    ],
  })
  const { h, courseId, ids, chunks } = course
  const said = handoffs(h)
  expect(await confirm(course)).toBe('ready')

  // By citation: the paragraph cites the chunk 等压面 is sourced in, and so does its row of the terms table. By
  // name: the stage's core node.
  expect((await blockOf(course, '同一水平面上压强相等')).nodeIds).toEqual([ids['等压面']])
  expect((await blockOf(course, '| 名词 |')).nodeIds).toEqual([ids['等压面']])
  expect((await blockOf(course, '这个式子叫静力学基本方程')).nodeIds).toEqual([ids['静力学基本方程']])
  // 读数 is named but is neither a core node of the stage nor sourced in its material.
  expect(h.ctx.learnKnowledge.links(ids['读数']!)).toEqual([])
  // The formula copied in cites its own chunk and is source text.
  const formula = chunks.find(chunk => chunk.kind === 'formula')!
  expect(h.ctx.learnTextbook.blocks(courseId).find(block => block.citations.includes(formula.id) && block.original)).toBeDefined()

  expect(h.ctx.learnTextbook.status(course.lessons[0]!.id)).toMatchObject({ state: 'ready', unverified: 0, uncovered: ['真空度'] })
  expect(said.at(-1)).toContain('这些知识点正文没有讲到：真空度')
  expect(await h.ctx.learnTutor.brief(courseId, await h.ctx.learnTutor.session(courseId))).toContain('这些知识点正文没有讲到：真空度')
})

it('keeps the knowledge side in step when a paragraph changes subject or goes, leaving links made by hand alone', async () => {
  const course = await setUp(call => {
    if (isPlan(call)) return planReply(call)
    if (!isSection(call)) return usual(call)
    return '等压面是压强相等的面。\n\n这一段讲真空度的读法。'
  }, {
    nodes: [{ title: '等压面', core: true }, { title: '真空度', core: true }, { title: '静力学基本方程', core: true }],
  })
  const { h, courseId, ids } = course
  expect(await confirm(course)).toBe('ready')
  const k = h.ctx.learnKnowledge
  const blockLinks = (id: string) => k.links(id).filter(link => link.target.kind === 'block').map(link => (link.target as { id: string }).id)
  const about = await blockOf(course, '等压面是压强相等的面')
  const vacuum = await blockOf(course, '这一段讲真空度的读法')
  expect(blockLinks(ids['等压面']!)).toContain(about.id)
  expect(blockLinks(ids['真空度']!)).toContain(vacuum.id)

  // By hand, the learner or the teacher ties the second paragraph to a third point: not the index's to change.
  k.link([{ nodeId: ids['静力学基本方程']! as never, target: { kind: 'block', courseId: courseId as never, id: vacuum.id }, relation: 'example' }], { actor: 'teacher', reason: '合成：手工关联' }, courseId)
  const handMade = () => k.links(ids['静力学基本方程']!).filter(link => link.relation === 'example').map(link => (link.target as { id: string }).id)
  const history = k.history(courseId).length

  // Read back unchanged: no group is recorded.
  const path = about.file
  const text = (await h.ctx.learnCore.files.read(courseId, path))!.text
  ;(h.ctx.learnTextbook as unknown as { reindex(courseId: string, file: string, text: string): unknown }).reindex(courseId, path, text)
  expect(k.history(courseId)).toHaveLength(history)

  // The paragraph changes subject and is edited outside: the link goes on both sides; a paragraph on the old subject brings it back.
  const edited = text.replace('等压面是压强相等的面', '这里说的是别的内容')
  await h.ctx.learnCore.files.write(courseId, path, edited, { actor: 'user', reason: '合成：改写段落', size: 'minor' })
  await h.settle()
  expect((await blockOf(course, '这里说的是别的内容')).nodeIds).toEqual([])
  expect(blockLinks(ids['等压面']!)).not.toContain(about.id)
  await h.ctx.learnCore.files.write(courseId, path, text, { actor: 'user', reason: '合成：改回去', size: 'minor' })
  await h.settle()
  expect(blockLinks(ids['等压面']!)).toContain(about.id)

  // The paragraph is deleted: its derived link stops, and the hand-made one stays until it is undone by hand.
  const without = text.split('\n\n').filter(part => !part.includes('这一段讲真空度的读法')).join('\n\n')
  await h.ctx.learnCore.files.write(courseId, path, without, { actor: 'user', reason: '合成：删段', size: 'minor' })
  await h.settle()
  expect(blockLinks(ids['真空度']!)).not.toContain(vacuum.id)
  expect(handMade()).toEqual([vacuum.id])
  expect(blockLinks(ids['等压面']!)).toContain(about.id)

  // A link stopped by hand stays stopped when the paragraph is indexed again.
  const link = k.links(ids['等压面']!).find(item => item.target.kind === 'block' && item.target.id === about.id)!
  k.unlink(courseId, link, { actor: 'user', reason: '合成：这段不算讲它' })
  ;(h.ctx.learnTextbook as unknown as { reindex(courseId: string, file: string, text: string): unknown }).reindex(courseId, path, without)
  expect(blockLinks(ids['等压面']!)).not.toContain(about.id)
})

it('writes the sections alone when the plan is unusable', async () => {
  const course = await setUp(call => (isPlan(call) ? '我没法规划这一章。' : usual(call)), { lessons: THREE })
  const { h, lessons } = course
  expect(await confirm(course)).toBe('ready')
  expect(h.calls.filter(isPlan)).toHaveLength(1)
  expect(h.calls.filter(call => call.purpose === 'learning-textbook').map(sectionOf).sort()).toEqual(THREE.map(lesson => `${lesson.number} ${lesson.title}`))
  const text = await handoutText(course)
  expect(text).not.toContain('### 本章速览')
  expect(text).not.toContain('### 题型与方法')
  expect(text).toContain('### 1.2.3 静力学基本方程')
  expect(h.ctx.learnTextbook.status(lessons[0]!.id).notes).toContainEqual(expect.stringMatching(/^列提纲没有成功，只按小节写了讲解，没有本章速览、易混点和题型：/))
})
