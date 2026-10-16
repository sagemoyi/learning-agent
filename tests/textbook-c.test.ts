// textbook C (docs/textbook/design.md, 详略与局部修订): the writer is told how to write each knowledge
// point by the learner's state on it, while coverage and citation rules stay the same; the teacher can
// rewrite a few paragraphs of explanation and the rest keep their text and ids, while source text copied in
// is never rewritten; a paragraph the check finds contradicted is rewritten once before the lesson is
// published; the reader page gets each paragraph's sources and check in the learner's words. Synthetic
// material; fake model and learner states.
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Lesson, MasteryState } from '@learning-agent/contracts'
import * as textbookTools from '../packages/textbook/src/tools.ts'
import { FIXTURES, createHarness, textbookSettled, type Harness, type ModelCall } from './harness.ts'
import { checkOk, isCheck, isReviser, isWriter, paragraphsOf, textbookReply, titleOf, writePoint } from './textbook-fakes.ts'

const meta = { actor: 'teacher' as const, reason: '教材 C 测试（合成）' }

let h: Harness | undefined
afterEach(() => h?.dispose())

/** The paragraphs a reviser call was asked to rewrite, by id. */
function targetsOf(call: ModelCall): Map<string, string> {
  const section = /# 要改的段落\n([\s\S]*?)(?:\n\n# |$)/.exec(call.prompt)![1]!
  return new Map([...section.matchAll(/\[\[段落 ([0-9a-z]{6})\]\]\n([\s\S]*?)(?=\n\n\[\[段落 |$)/g)].map(match => [match[1]!, match[2]!.trim()]))
}

const citationOf = (text: string) => /\[[^\]]*\]\(cite:ck_\w+\)/.exec(text)![0]

type Reviser = (targets: Map<string, string>) => string
/** Corrects the contradicted paragraph from the material; leaves the others as they were. */
const fixes: Reviser = targets => [...targets].map(([id, text]) => `[[段落 ${id}]]\n${text.includes('一定相等') ? `两点之间隔着另一种液体时，即使在同一高度也不能认为相等。${citationOf(text)}` : text}`).join('\n\n')
/** Says it rewrote the paragraphs but gives them back unchanged. */
const same: Reviser = targets => [...targets].map(([id, text]) => `[[段落 ${id}]]\n${text}`).join('\n\n')

interface Options {
  /** Write the sentence the material contradicts. */
  readonly contradict?: boolean
  readonly revise?: Reviser
}

const NOTE = '原文说隔着另一种液体时同一高度也不能认为压强相等'

function model(cite: Record<string, string>, options: Options) {
  return (call: ModelCall): string => {
    if (isCheck(call)) return checkOk(call, text => (text.includes('一定相等') ? { verdict: 'contradicted', note: NOTE } : { verdict: 'ok' }))
    if (isReviser(call)) return (options.revise ?? same)(targetsOf(call))
    if (isWriter(call) && titleOf(call) === '压强的含义') {
      return [
        '### 压强的含义',
        `压强是指单位面积上受到的垂直作用力。[合成资料 p.1](cite:${cite.pressure})`,
        `静止流体内部任一点的压强在各个方向上大小相同。[合成资料 p.1](cite:${cite.isotropic})`,
      ].join('\n\n')
    }
    // Never names the gauge pressure, so the coverage check has something to report.
    if (isWriter(call) && titleOf(call) === '压强的几种表示') return `### 压强的几种表示\n\n记录压强要写明是哪一种。[合成资料 p.1](cite:${cite.record})`
    if (isWriter(call) && titleOf(call) === '静力学基本方程') {
      // Told to compress 等压面, this writer leaves it out: the coverage check must still notice.
      const compress = /- 等压面：[^\n]*压缩/.test(call.prompt) && !options.contradict
      return [
        '### 静力学基本方程',
        ...compress ? [] : [`同一种静止、连通的液体中，同一水平面上各点的压强相等，这样的面叫等压面。[合成资料 p.2](cite:${cite.equal})`],
        ...options.contradict ? [`同一高度上的两点压强一定相等。[合成资料 p.2](cite:${cite.check})`] : [],
        ...compress ? [] : [`判断时要逐条检查静止、连通、同一种液体这几个条件。[合成资料 p.2](cite:${cite.check})`],
        `![[${cite.formula}]]`,
      ].join('\n\n')
    }
    if (isWriter(call)) return writePoint(call)
    return textbookReply(call) ?? (() => { throw new Error(`unexpected model call: ${call.purpose}`) })()
  }
}

type States = Record<string, { readonly state: MasteryState; readonly doubtful?: boolean; readonly explanation?: string }>

async function setUp(options: Options = {}) {
  const cite: Record<string, string> = {}
  h = createHarness(call => model(cite, options)(call))
  const { ctx, endpoint } = h
  const course = await endpoint('core', 'createCourse', { title: '教材 C（合成资料）' })
  const skeleton = await endpoint('library', 'import', {
    title: '合成长小节', kind: 'textbook', authority: '1', courseId: course.id, role: 'skeleton',
    file: join(FIXTURES, 'synthetic-long-section', 'source.md'), parsed: [join(FIXTURES, 'synthetic-long-section', 'middle.json')],
  })
  const chunks = ctx.learnLibrary.section(skeleton.id, '1.2')
  const find = (text: string) => chunks.find(chunk => chunk.text.includes(text))!.id
  Object.assign(cite, {
    pressure: find('压强指单位面积上受到的垂直作用力'), isotropic: find('在各个方向上大小相同'), record: find('记录压强数据时要注明'),
    equal: find('压强相等的面叫等压面'), check: find('即使在同一高度也不能认为压强相等'), gauge: find('以当地大气压为零点量出的压强叫表压强'),
    formula: chunks.find(chunk => chunk.kind === 'formula' && chunk.text.includes('p_2 = p_1'))!.id,
  })
  const graph = await ctx.learnKnowledge.add(course.id, { nodes: [
    { title: '等压面', kind: 'knowledge' as const, sources: [cite.equal!] },
    { title: '表压强', kind: 'knowledge' as const, sources: [cite.gauge!] },
  ] }, meta)
  const ids = Object.fromEntries(graph.nodes.map(node => [node.title, node.id]))
  // The learner's states, as the learner unit would give them.
  let states: States = {}
  const setStates = (next: States) => { states = next }
  ctx.learnLearner.states = nodeIds => (nodeIds ?? []).flatMap(nodeId => {
    const title = Object.keys(ids).find(key => ids[key] === nodeId)
    const state = title ? states[title] : undefined
    return state ? [{ nodeId, state: state.state, doubtful: state.doubtful ?? false, needsReview: false, explanation: state.explanation ?? '', evidence: [], rulesVersion: 'test', computedAt: '2026-10-10T00:00:00.000Z', courses: [] } as never] : []
  })
  const { stages: [stage] } = await ctx.learnCurriculum.saveRoadmap(course.id, [{ title: '静止流体', objective: '会用静力学基本方程' }], meta)
  const { lessons } = await ctx.learnCurriculum.saveDesign(stage!.id, { markdown: '# 阶段设计\n\n1.2 静止流体的压强。', lessons: [{ number: '1.2', title: '静止流体的压强' }] }, meta)
  return { course, cite, ids, setStates, lesson: lessons[0]! as Lesson }
}

async function generate(lesson: Lesson, how: 'confirm' | 'again' = 'confirm') {
  const settled = textbookSettled(h!.ctx, lesson.id)
  if (how === 'confirm') await h!.endpoint('curriculum', 'confirmDesign', { stageId: lesson.stageId })
  else await h!.endpoint('textbook', 'generate', { lessonId: lesson.id })
  return settled
}

/** The lesson's paragraphs in order, with their text. */
async function paragraphs(courseId: string, lesson: Lesson) {
  const textbook = h!.ctx.learnTextbook
  return Promise.all(textbook.blocks(courseId, lesson.textbookFile!).map(async block => ({ id: block.id, text: (await textbook.block(courseId, block.id))!.text, original: block.original })))
}

const masteryOf = (call: ModelCall) => /# 学习者对本课知识点的掌握[^\n]*\n([\s\S]*?)(?:\n\n# |$)/.exec(call.prompt)?.[1]
const equationWriter = () => h!.calls.filter(call => isWriter(call) && titleOf(call) === '静力学基本方程').at(-1)!

type Info = { kind: string; state: string; note: string; sources: { chunkId: string; citation: string; text: string }[]; web: unknown[]; revised?: string }

it('tells the writer how to write each knowledge point by the learner state, and still checks coverage', async () => {
  const { course, lesson, setStates } = await setUp()
  setStates({ 等压面: { state: 'independent', explanation: '两次独立答对' }, 表压强: { state: 'not-yet' } })
  expect(await generate(lesson)).toBe('ready')
  const firstRun = equationWriter()
  expect(masteryOf(firstRun)).toBe([
    '- 等压面：已独立完成（两次独立答对）。压缩：保留定义、符号和适用条件，不展开推导和例题。',
    '- 表压强：还没答对。展开：拆开步骤讲，对照常见错误，用资料里的例题一步一步讲。',
  ].join('\n'))
  // Compressed out of the text, it is still reported as not explained.
  expect(h!.ctx.learnTextbook.status(lesson.id).uncovered).toEqual(['等压面', '表压强'])

  // Answered right, then asked about again and again: written out in full.
  setStates({ 等压面: { state: 'independent', doubtful: true }, 表压强: { state: 'assisted' } })
  expect(await generate(lesson, 'again')).toBe('ready')
  const secondRun = equationWriter()
  expect(masteryOf(secondRun)).toBe([
    '- 等压面：已独立完成，反复提问过。展开：拆开步骤讲，对照常见错误，用资料里的例题一步一步讲。',
    '- 表压强：有帮助才完成。正常讲，并提醒学习者自己独立做一遍。',
  ].join('\n'))
  expect(h!.ctx.learnTextbook.status(lesson.id).uncovered).toEqual(['表压强'])
  // The rules and the material are the same: only the detail asked for differs.
  expect(secondRun.system).toBe(firstRun.system)
  expect(secondRun.prompt.split('# 资料片段')[1]).toBe(firstRun.prompt.split('# 资料片段')[1])

  // Nothing tested yet: written as normal.
  setStates({})
  expect(await generate(lesson, 'again')).toBe('ready')
  expect(masteryOf(equationWriter())).toContain('- 等压面：没测过。正常讲。')
  expect(await paragraphs(course.id, lesson)).not.toHaveLength(0)
})

it('rewrites the paragraphs asked for, leaves the others as they were, and never rewrites source text', async () => {
  const { course, lesson } = await setUp({
    revise: targets => [...targets].map(([id, text]) => text.includes('逐条检查')
      ? `[[段落 ${id}]]\n第一步，看两点之间是否由同一种液体连通。${citationOf(text)}\n\n第二步，再看液体是否静止。${citationOf(text)}`
      : `[[段落 ${id}]]\n（删除）`).join('\n\n'),
  })
  expect(await generate(lesson)).toBe('ready')
  const before = await paragraphs(course.id, lesson)
  const steps = before.find(item => item.text.includes('逐条检查'))!
  const isotropic = before.find(item => item.text.includes('各个方向上大小相同'))!
  const checksBefore = h!.calls.filter(isCheck).length

  // Through the teacher's tool.
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  ;(h!.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  textbookTools.apply(h!.ctx as never)
  const exec = { agent: { session: { id: await h!.ctx.learnTutor.session(course.id) } } }
  const instruction = '把检查条件拆成两步'
  const reply = await tools.get('revise_textbook')!.execute({ lessonId: lesson.id, blocks: [steps.id, isotropic.id], instruction }, exec)
  expect(reply).toBe('已修改 1.2 的 1 段，多出 1 段，删去 1 段。\n改过的段落核对通过。')

  const after = await paragraphs(course.id, lesson)
  // The others: same text, same ids, same order.
  const untouched = (list: typeof before) => list.filter(item => item.id !== steps.id && item.id !== isotropic.id && !item.text.startsWith('第二步'))
  expect(untouched(after)).toEqual(untouched(before))
  // The rewritten paragraph keeps its id; the extra one follows it with a new id; the removed one is gone.
  const at = after.findIndex(item => item.id === steps.id)
  expect(after[at]!.text).toMatch(/^第一步，看两点之间是否由同一种液体连通。/)
  expect(after[at + 1]!.text).toMatch(/^第二步，再看液体是否静止。/)
  expect(before.some(item => item.id === after[at + 1]!.id)).toBe(false)
  expect(after.some(item => item.id === isotropic.id)).toBe(false)
  // Where they went.
  const textbook = h!.ctx.learnTextbook
  expect(textbook.revisions(course.id, isotropic.id)).toMatchObject([{ into: [], reason: instruction }])
  expect(textbook.revisions(course.id, steps.id)).toMatchObject([{ into: [steps.id, after[at + 1]!.id], reason: instruction }])
  // Only what changed was checked again; the others keep their check.
  const rechecked = h!.calls.filter(isCheck).slice(checksBefore).flatMap(call => paragraphsOf(call).map(paragraph => paragraph.text))
  expect(rechecked).toEqual(['第一步，看两点之间是否由同一种液体连通。', '第二步，再看液体是否静止。'])
  expect(await h!.endpoint<Info>('textbook', 'blockInfo', { courseId: course.id, blockId: steps.id })).toMatchObject({ kind: 'explanation', state: 'ok', revised: instruction })
  expect(textbook.status(lesson.id)).toMatchObject({ state: 'ready', unverified: 0, check: { stale: 0 } })

  // Source text, ids not in the lesson, or too many at once change nothing.
  const original = after.find(item => item.original)!
  await expect(textbook.reviseBlocks(lesson.id, { blockIds: [original.id], instruction }, meta)).rejects.toMatchObject({ code: 'learning/textbook/original' })
  await expect(textbook.reviseBlocks(lesson.id, { blockIds: ['zzzzzz'], instruction }, meta)).rejects.toMatchObject({ code: 'learning/textbook/no-block' })
  await expect(textbook.reviseBlocks(lesson.id, { blockIds: Array.from({ length: 9 }, (_, i) => `zzzzz${i}`), instruction }, meta)).rejects.toMatchObject({ code: 'learning/textbook/too-many' })
  expect(await paragraphs(course.id, lesson)).toEqual(after)
  expect(await h!.endpoint<Info>('textbook', 'blockInfo', { courseId: course.id, blockId: original.id })).toMatchObject({ kind: 'original', sources: [{ chunkId: expect.stringMatching(/^ck_/) }] })
})

it('rewrites a contradicted paragraph once before publishing it', async () => {
  const { course, lesson } = await setUp({ contradict: true, revise: fixes })
  expect(await generate(lesson)).toBe('ready')
  expect(h!.calls.filter(isReviser)).toHaveLength(1)
  const text = (await h!.ctx.learnCore.files.read(course.id, lesson.textbookFile!))!.text
  expect(text).not.toContain('一定相等')
  expect(text).toContain('两点之间隔着另一种液体时，即使在同一高度也不能认为相等。')
  expect(h!.ctx.learnTextbook.status(lesson.id)).toMatchObject({ state: 'ready', unverified: 0, check: { state: 'checked', notes: [] } })
})

it('marks a paragraph still contradicted after the one rewrite in the margin, not in the text, and explains it', async () => {
  const { course, lesson } = await setUp({ contradict: true, revise: same })
  expect(await generate(lesson)).toBe('ready')
  expect(h!.calls.filter(isReviser)).toHaveLength(1)
  const wrong = (await paragraphs(course.id, lesson)).find(item => item.text.includes('一定相等'))!
  expect(wrong.text).not.toContain('待核实')
  expect(h!.ctx.learnTextbook.status(lesson.id)).toMatchObject({ unverified: 1 })
  expect(await h!.endpoint('textbook', 'checks', { lessonId: lesson.id })).toEqual({ [wrong.id]: 'flagged' })

  const info = await h!.endpoint<Info>('textbook', 'blockInfo', { courseId: course.id, blockId: wrong.id })
  expect(info).toMatchObject({ kind: 'explanation', state: 'flagged', note: NOTE, sources: expect.arrayContaining([expect.objectContaining({ citation: expect.stringContaining('《合成长小节》'), text: expect.stringContaining('即使在同一高度也不能认为压强相等') })]) })
  // Words for the learner: internal ids only where a source opens.
  expect([info.note, ...info.sources.flatMap(source => [source.citation, source.text])].join('\n')).not.toMatch(/ck_|kn_/)
})
