// textbook (docs/textbook/design.md): each section's length is set by the learner's state on its knowledge points,
// and a section written too long is shortened once; the teacher can rewrite a few paragraphs while the rest keep
// their text and ids, never source text or a table; the learner edits a paragraph in place, its citations shown as
// short markers and put back, an empty paragraph removed, nothing checked, and a regeneration replaces what they
// changed. Synthetic material; fake model and learner states.
import { afterEach, expect, it } from 'vitest'
import type { MasteryState } from '@learning-agent/contracts'
import * as textbookTools from '../../packages/textbook/src/tools.ts'
import { textbookSettled, type ModelCall } from '../harness.ts'
import {
  blockOf, confirm, handoutCourse, handoutText, isReviser, isSection, materialOf, reviseReply, sectionOf, sectionReply, usual,
  type HandoutCourse, type HandoutOptions, type Reply,
} from './fakes.ts'

let course: HandoutCourse | undefined
afterEach(() => course?.h.dispose())

const THREE = [{ number: '1.2.2', title: '压强的几种表示' }, { number: '1.2.3', title: '静力学基本方程' }, { number: '1.2.4', title: '基本方程的应用' }]
const meta = { actor: 'teacher' as const, reason: '讲义测试（合成）' }

type States = Record<string, { readonly state: MasteryState; readonly doubtful?: boolean; readonly explanation?: string }>
type Info = { kind: string; state: string; note: string; sources: { chunkId: string; citation: string; text: string }[]; web: unknown[]; revised?: string }

/** A course whose learner states the test sets, as the learner unit would give them. */
async function setUp(reply: Reply, options: HandoutOptions = {}) {
  course = await handoutCourse(reply, options)
  const { ids } = course
  let states: States = {}
  course.h.ctx.learnLearner.states = nodeIds => (nodeIds ?? []).flatMap(nodeId => {
    const title = Object.keys(ids).find(key => ids[key] === nodeId)
    const state = title ? states[title] : undefined
    return state ? [{ nodeId, state: state.state, doubtful: state.doubtful ?? false, needsReview: false, explanation: state.explanation ?? '', evidence: [], rulesVersion: 'test', computedAt: '2026-10-10T00:00:00.000Z', courses: [] } as never] : []
  })
  return { ...course, setStates: (next: States) => { states = next } }
}

async function again(target: HandoutCourse) {
  const settled = textbookSettled(target.h.ctx, target.lessons[0]!.id)
  await target.h.endpoint('textbook', 'generate', { lessonId: target.lessons[0]!.id })
  return settled
}

const capOf = (call: ModelCall) => /字数上限：(.+)/.exec(call.prompt)![1]!
const masteryOf = (call: ModelCall) => /# 学习者对本节知识点的掌握\n([\s\S]*?)(?:\n\n# |$)/.exec(call.prompt)?.[1]
const lastSection = (h: HandoutCourse['h'], title: string) => h.calls.filter(call => isSection(call) && sectionOf(call) === title).at(-1)!

/** The paragraphs of the handout in order, with their text. */
async function paragraphs(target: HandoutCourse) {
  const textbook = target.h.ctx.learnTextbook
  return Promise.all(textbook.blocks(target.courseId).map(async block => ({ id: block.id, text: (await textbook.block(target.courseId, block.id))!.text, original: block.original })))
}

/** The teacher's tools, run in the course's teacher session. */
async function teacherTools(target: HandoutCourse) {
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  ;(target.h.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  textbookTools.apply(target.h.ctx as never)
  const exec = { agent: { session: { id: await target.h.ctx.learnTutor.session(target.courseId) } } }
  return (name: string, args: unknown) => tools.get(name)!.execute(args, exec)
}

it('sets each section\'s length by the learner\'s state on its knowledge points, and shortens one written too long, once', async () => {
  const long = Array.from({ length: 20 }, () => '表压强从当地大气压量起。').join('')
  const { h, setStates } = await setUp(call => {
    if (isReviser(call)) return reviseReply(call, text => `表压强从当地大气压量起，绝对压强从真空量起。${/\[[^\]]*\]\(cite:ck_\w+\)/.exec(text)![0]}`)
    if (isSection(call) && sectionOf(call) === '1.2.2 压强的几种表示' && capOf(call).startsWith('150')) return `${long}[合成资料 p.1](cite:${materialOf(call)[0]!.id})`
    return usual(call)
  }, {
    lessons: THREE,
    nodes: [
      { title: '表压强', source: chunk => chunk.text.includes('以当地大气压为零点量出的压强叫表压强') },
      { title: '等压面', source: chunk => chunk.text.includes('压强相等的面叫等压面') },
    ],
  })
  setStates({ 表压强: { state: 'independent', explanation: '两次独立答对' }, 等压面: { state: 'not-yet' } })
  expect(await confirm(course!)).toBe('ready')
  const gauge = lastSection(h, '1.2.2 压强的几种表示')
  expect(capOf(gauge)).toBe('150 字（这一节的知识点都已经会了）')
  expect(masteryOf(gauge)).toBe('- 表压强：已独立完成。一两句带过，保留定义、符号和适用条件。')
  const equation = lastSection(h, '1.2.3 静力学基本方程')
  expect(capOf(equation)).toBe('700 字（有还没掌握的知识点）')
  expect(masteryOf(equation)).toBe('- 等压面：还没答对。多讲一步：拆开步骤，点明常见错误。')
  expect(capOf(lastSection(h, '1.2.4 基本方程的应用'))).toBe('400 字（正常讲）')
  // The plan sees the states too, with what they rest on.
  expect(h.calls.find(call => call.purpose === 'learning-textbook-plan')!.prompt).toContain('- 表压强：已独立完成（两次独立答对）。')
  // 240 characters against a cap of 150: shortened once, by the reviser.
  const [reviser, ...more] = h.calls.filter(isReviser)
  expect(more).toEqual([])
  expect(reviser!.prompt).toContain('1.2.2 压强的几种表示 的讲解')
  expect(reviser!.prompt).toContain('超过了 150 字的上限，压缩到上限以内')
  const text = await handoutText(course!)
  expect(text).not.toContain(long)
  expect(text).toContain('表压强从当地大气压量起，绝对压强从真空量起。')

  // Answered right, then asked about again and again: written out in full.
  setStates({ 表压强: { state: 'independent', doubtful: true } })
  expect(await again(course!)).toBe('ready')
  const doubtful = lastSection(h, '1.2.2 压强的几种表示')
  expect(capOf(doubtful)).toBe('700 字（有还没掌握的知识点）')
  expect(masteryOf(doubtful)).toBe('- 表压强：已独立完成，反复提问过。多讲一步：拆开步骤，点明常见错误。')
  // The rules and the material are the same: only the detail asked for differs.
  expect(doubtful.system).toBe(gauge.system)
  expect(doubtful.prompt.split('# 资料片段')[1]).toBe(gauge.prompt.split('# 资料片段')[1])
})

it('rewrites the paragraphs the teacher asks for, leaves the others as they were, and never source text or a table', async () => {
  const { h, courseId, lessons } = await setUp(call => {
    if (isReviser(call)) {
      return reviseReply(call, text => (text.includes('逐条检查')
        ? `第一步，看两点之间是否由同一种液体连通。${/\[[^\]]*\]\(cite:ck_\w+\)/.exec(text)![0]}\n\n第二步，再看液体是否静止。${/\[[^\]]*\]\(cite:ck_\w+\)/.exec(text)![0]}`
        : '（删除）'))
    }
    if (!isSection(call)) return usual(call)
    const cite = materialOf(call).find(chunk => chunk.kind === '正文')!.id
    return [
      `判断时要逐条检查静止、连通、同一种液体这几个条件。[合成资料 p.2](cite:${cite})`,
      `静止流体里任意一点的压强，朝哪个方向量都一样大。[合成资料 p.1](cite:${cite})`,
      `记录压强要写明是哪一种。[合成资料 p.1](cite:${cite})`,
      `![[${materialOf(call).find(chunk => chunk.kind === '公式')!.id}]]`,
    ].join('\n\n')
  })
  expect(await confirm(course!)).toBe('ready')
  const before = await paragraphs(course!)
  const steps = before.find(item => item.text.includes('逐条检查'))!
  const isotropic = before.find(item => item.text.includes('朝哪个方向量都一样大'))!

  // Through the teacher's tool.
  const run = await teacherTools(course!)
  const instruction = '把检查条件拆成两步'
  expect(await run('revise_textbook', { lessonId: lessons[0]!.id, blocks: [steps.id, isotropic.id], instruction })).toBe('已修改 1 段，多出 1 段，删去 1 段。\n改过的段落程序检查没有发现问题。')
  const after = await paragraphs(course!)
  // The others: same text, same ids, same order.
  const untouched = (list: typeof before) => list.filter(item => item.id !== steps.id && item.id !== isotropic.id && !item.text.startsWith('第二步'))
  expect(untouched(after)).toEqual(untouched(before))
  // The rewritten paragraph keeps its id; the extra one follows it with a new id; the removed one is gone.
  const at = after.findIndex(item => item.id === steps.id)
  expect(after[at]!.text).toMatch(/^第一步，看两点之间是否由同一种液体连通。/)
  expect(after[at + 1]!.text).toMatch(/^第二步，再看液体是否静止。/)
  expect(before.some(item => item.id === after[at + 1]!.id)).toBe(false)
  expect(after.some(item => item.id === isotropic.id)).toBe(false)
  const textbook = h.ctx.learnTextbook
  expect(textbook.revisions(courseId, isotropic.id)).toMatchObject([{ into: [], reason: instruction }])
  expect(textbook.revisions(courseId, steps.id)).toMatchObject([{ into: [steps.id, after[at + 1]!.id], reason: instruction }])
  expect(await h.endpoint<Info>('textbook', 'blockInfo', { courseId, blockId: steps.id })).toMatchObject({ kind: 'explanation', state: 'none', revised: instruction })
  // The new paragraph is in the same lesson's section.
  expect(textbook.blocks(courseId).find(block => block.id === after[at + 1]!.id)!.lessonId).toBe(lessons[0]!.id)

  // Source text, a table, ids not in the handout, or too many at once change nothing.
  const original = after.find(item => item.original)!
  const table = after.find(item => item.text.startsWith('| 名词 |'))!
  await expect(textbook.reviseBlocks(lessons[0]!.id, { blockIds: [original.id], instruction }, meta)).rejects.toMatchObject({ code: 'learning/textbook/original' })
  await expect(textbook.reviseBlocks(lessons[0]!.id, { blockIds: [table.id], instruction }, meta)).rejects.toMatchObject({ code: 'learning/textbook/table' })
  await expect(textbook.reviseBlocks(lessons[0]!.id, { blockIds: ['zzzzzz'], instruction }, meta)).rejects.toMatchObject({ code: 'learning/textbook/no-block' })
  await expect(textbook.reviseBlocks(lessons[0]!.id, { blockIds: Array.from({ length: 9 }, (_, i) => `zzzzz${i}`), instruction }, meta)).rejects.toMatchObject({ code: 'learning/textbook/too-many' })
  expect(await paragraphs(course!)).toEqual(after)
  expect(await h.endpoint<Info>('textbook', 'blockInfo', { courseId, blockId: original.id })).toMatchObject({ kind: 'original', sources: [{ chunkId: expect.stringMatching(/^ck_/) }] })
})

it('lets the learner edit a paragraph in place, unchecked, and says a regeneration replaces it', async () => {
  const { h, courseId, lessons } = await setUp(call => {
    if (!isSection(call)) return usual(call)
    const [first, second] = materialOf(call).filter(chunk => chunk.kind === '正文')
    return `${sectionReply(call, '静止流体里各方向的压强一样大')}\n\n压强的单位是帕斯卡。[《合成长小节》p.1](cite:${first!.id})[《合成长小节》p.1](cite:${second!.id})`
  })
  expect(await confirm(course!)).toBe('ready')
  const unit = await blockOf(course!, '压强的单位是帕斯卡')

  // The paragraph as the editor opens it, with the fingerprint a save must bring back.
  const open = (blockId: string) => h.endpoint<{ text: string; hash: string }>('textbook', 'blockSource', { courseId, blockId })
  const edit = async (blockId: string, text: string) => h.endpoint<{ blocks: string[] }>('textbook', 'editBlock', { courseId, blockId, text, base: (await open(blockId)).hash })

  // Its citations as short markers; the same page of two chunks, one marker each.
  const opened = await open(unit.id)
  expect(opened).toEqual({ text: '压强的单位是帕斯卡。〔p.1〕〔p.1〕', hash: expect.any(String) })
  // A new marker is not a source; a number the material lacks is the learner's to write.
  const edited = await h.endpoint('textbook', 'editBlock', { courseId, blockId: unit.id, text: '我的笔记：1 Pa 等于 1 N/m²，998 只是举例。〔p.1〕〔p.9〕', base: opened.hash })
  expect(edited).toEqual({ blocks: [unit.id] })
  const now = await blockOf(course!, '我的笔记')
  expect(now.id).toBe(unit.id)
  expect(now.text).toBe(`我的笔记：1 Pa 等于 1 N/m²，998 只是举例。[《合成长小节》p.1](cite:${unit.citations[0]})`)
  expect(now.unverified).toBe(false)
  const info = await h.endpoint<Info>('textbook', 'blockInfo', { courseId, blockId: unit.id })
  expect(info).toMatchObject({ kind: 'explanation', state: 'edited', note: '', sources: [{ chunkId: unit.citations[0], citation: expect.stringContaining('《合成长小节》') }] })
  expect(info).not.toHaveProperty('revised')
  // Words for the learner: internal ids only where a source opens.
  expect([info.note, ...info.sources.flatMap(source => [source.citation, source.text])].join('\n')).not.toMatch(/ck_|kn_/)
  expect(h.ctx.learnTextbook.status(lessons[0]!.id)).toMatchObject({ state: 'ready', unverified: 0, edited: 1 })

  // A second editor opened before that save does not overwrite it: the paragraph as it is now comes back.
  const stale = await h.call('textbook', 'editBlock', { courseId, blockId: unit.id, text: '另一个标签页的笔记。', base: opened.hash })
  expect(stale.error).toMatchObject({ code: 'learning/textbook/edited', details: { text: expect.stringContaining('我的笔记') } })
  expect(await handoutText(course!)).not.toContain('另一个标签页')
  // The same for an edit in Obsidian; a change to another paragraph does not stop the save.
  const before = await open(unit.id)
  const lesson = h.ctx.learnCurriculum.lesson(lessons[0]!.id)!
  const file = (await h.ctx.learnCore.files.read(courseId, lesson.textbookFile!))!.text
  await h.ctx.learnCore.files.write(courseId, lesson.textbookFile!, file.replace('静止流体里各方向的压强一样大', '静止流体里各方向的压强一样大（在 Obsidian 里补的）'), { actor: 'user', reason: '在应用外修改' })
  expect(await h.endpoint('textbook', 'editBlock', { courseId, blockId: unit.id, text: '我的笔记（改第二遍）。〔p.1〕', base: before.hash })).toEqual({ blocks: [unit.id] })
  const reopened = await open(unit.id)
  const outside = (await h.ctx.learnCore.files.read(courseId, lesson.textbookFile!))!.text
  await h.ctx.learnCore.files.write(courseId, lesson.textbookFile!, outside.replace('我的笔记（改第二遍）。', '我的笔记（Obsidian 改的）。'), { actor: 'user', reason: '在应用外修改' })
  expect((await h.call('textbook', 'editBlock', { courseId, blockId: unit.id, text: '页面上的笔记。', base: reopened.hash })).error?.code).toBe('learning/textbook/edited')
  expect(await handoutText(course!)).toContain('我的笔记（Obsidian 改的）')

  // Two paragraphs: the second gets a new id in the same section; an empty one is removed.
  const split = await edit(unit.id, '第一行笔记。\n\n第二行笔记。')
  expect(split.blocks).toHaveLength(2)
  expect(split.blocks[0]).toBe(unit.id)
  expect(h.ctx.learnTextbook.blocks(courseId).find(block => block.id === split.blocks[1])!.lessonId).toBe(lessons[0]!.id)
  expect(h.ctx.learnTextbook.status(lessons[0]!.id)).toMatchObject({ edited: 2 })
  expect(await edit(split.blocks[1]!, '  ')).toEqual({ blocks: [] })
  expect(await handoutText(course!)).not.toContain('第二行笔记')
  expect(h.ctx.learnTextbook.revisions(courseId, split.blocks[1]!).at(-1)).toMatchObject({ into: [], reason: '学习者在讲义页修改' })

  // Source text cannot be edited.
  const original = (await paragraphs(course!)).find(item => item.original)!
  expect(await h.endpoint('textbook', 'blockSource', { courseId, blockId: original.id })).toEqual({ refused: expect.stringContaining('原书原文') })
  expect((await h.call('textbook', 'editBlock', { courseId, blockId: original.id, text: '改原文', base: '' })).error?.code).toBe('learning/textbook/original')

  // Written again: the learner's paragraph is replaced, and recorded as such.
  expect(await again(course!)).toBe('ready')
  expect(await handoutText(course!)).not.toContain('第一行笔记')
  expect(h.ctx.learnTextbook.status(lessons[0]!.id)).not.toHaveProperty('edited')
  expect(h.ctx.learnTextbook.revisions(courseId, unit.id).at(-1)).toMatchObject({ into: [], reason: '重新生成讲义' })
})
