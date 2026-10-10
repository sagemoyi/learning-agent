// textbook C (docs/textbook/design.md, 详略与局部修订): the writer is told how to write each knowledge
// point by the learner's state on it, while coverage and citation rules stay the same; the teacher can
// rewrite a few paragraphs and the rest keep their text and ids; a paragraph the check finds
// contradicted is rewritten once before the lesson is published; the reader page gets each paragraph's
// check in the learner's words. Synthetic material; fake model and learner states.
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Lesson, MasteryState } from '@learning-agent/contracts'
import * as textbookTools from '../packages/textbook/src/tools.ts'
import { FIXTURES, createHarness, headingsOf, textbookSettled, type Harness, type ModelCall } from './harness.ts'

const meta = { actor: 'teacher' as const, reason: '教材 C 测试（合成）' }
const QUESTIONS = '### 读完就答\n\n1. 等压面要满足哪些条件？\n2. 压强的方向怎么说？'

let h: Harness | undefined
afterEach(() => h?.dispose())

const isWriter = (call: ModelCall) => call.system.startsWith('你是教材编写者')
const isQuestions = (call: ModelCall) => call.system.startsWith('你为一节教材写')
const isReviser = (call: ModelCall) => call.system.startsWith('你修改一节教材')
const isCheck = (call: ModelCall) => call.purpose === 'learning-textbook-check'
const isFirst = (call: ModelCall) => call.prompt.includes('这是第一部分')
const sentencesIn = (call: ModelCall) => [...call.prompt.matchAll(/^\s*\[(\d+\.\d+)\] (.+)$/gm)].map(match => match[2]!)

/** The chunks a prompt lists: `[ck_…] citation`, then the text up to a blank line or the next chunk. */
function chunksIn(prompt: string): Map<string, string> {
  const marks = [...prompt.matchAll(/\[(ck_[0-9A-Z]{26})\][^\n]*\n/g)]
  return new Map(marks.map((match, index) => {
    const start = match.index! + match[0].length
    const blank = prompt.indexOf('\n\n', start)
    return [match[1]!, prompt.slice(start, Math.min(marks[index + 1]?.index ?? prompt.length, blank < 0 ? prompt.length : blank)).trim()]
  }))
}

/** The fake check model: judges by what each sentence says. */
function check(call: ModelCall): string {
  const chunks = chunksIn(call.prompt)
  const quote = (text: string) => {
    const id = [...chunks].find(([, body]) => body.includes(text))?.[0]
    return id ? [{ chunk: id, quote: text }] : []
  }
  const first = [...chunks][0]
  const results = [...call.prompt.matchAll(/^\s*\[(\d+\.\d+)\] (.+)$/gm)].map(([, id, text]) => {
    if (text!.includes('压强是指')) return { id, verdict: 'supported', evidence: quote('压强指单位面积上受到的垂直作用力') }
    if (text!.includes('各个方向上大小相同')) return { id, verdict: 'supported', evidence: quote('在各个方向上大小相同') }
    if (text!.includes('叫等压面')) return { id, verdict: 'supported', evidence: quote('压强相等的面叫等压面') }
    if (text!.includes('一定相等')) return { id, verdict: 'contradicted', evidence: quote('即使在同一高度也不能认为压强相等'), note: '原文说隔着另一种液体时同一高度也不能认为压强相等' }
    if (text!.includes('不能认为相等') || text!.includes('逐条检查') || text!.includes('第一步') || text!.includes('第二步')) {
      return { id, verdict: 'supported', evidence: [...quote('即使在同一高度也不能认为压强相等'), ...quote('判断等压面时要逐条检查条件')].slice(0, 1) }
    }
    return { id, verdict: 'supported', evidence: first ? [{ chunk: first[0], quote: first[1].slice(0, 6) }] : [] }
  })
  return JSON.stringify({ results })
}

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

function model(cite: Record<string, string>, options: Options) {
  return (call: ModelCall): string => {
    if (isQuestions(call)) return QUESTIONS
    if (isCheck(call)) return check(call)
    if (isReviser(call)) return (options.revise ?? same)(targetsOf(call))
    if (!isFirst(call)) return `### 小结\n\n这一部分讲的内容。[合成资料 p.3](cite:${/\[(ck_[0-9A-Z]{26})\]/.exec(call.prompt)![1]})\n\n${headingsOf(call)}`
    // Told to compress 等压面, this writer leaves it out: the coverage check must still notice.
    const compress = /- 等压面：[^\n]*压缩/.test(call.prompt) && !options.contradict
    return [
      '## 1.2 静止流体的压强（合成长小节）', '### 压强',
      `压强是指单位面积上受到的垂直作用力。[合成资料 p.1](cite:${cite.pressure})`,
      `静止流体内部任一点的压强在各个方向上大小相同。[合成资料 p.1](cite:${cite.isotropic})`,
      '### 等压面',
      ...compress ? [] : [`同一种静止、连通的液体中，同一水平面上各点的压强相等，这样的面叫等压面。[合成资料 p.2](cite:${cite.equal})`],
      ...options.contradict ? [`同一高度上的两点压强一定相等。[合成资料 p.2](cite:${cite.check})`] : [],
      ...compress ? [] : [`判断时要逐条检查静止、连通、同一种液体这几个条件。[合成资料 p.2](cite:${cite.check})`],
      headingsOf(call),
    ].join('\n\n')
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
    pressure: find('压强指单位面积上受到的垂直作用力'), isotropic: find('在各个方向上大小相同'),
    equal: find('压强相等的面叫等压面'), check: find('即使在同一高度也不能认为压强相等'), gauge: find('以当地大气压为零点量出的压强叫表压强'),
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
  return Promise.all(textbook.blocks(courseId, lesson.textbookFile!).map(async block => ({ id: block.id, text: (await textbook.block(courseId, block.id))!.text })))
}

const masteryOf = (call: ModelCall) => /# 学习者对本课知识点的掌握[^\n]*\n([\s\S]*?)(?:\n\n# |$)/.exec(call.prompt)?.[1]

it('tells the writer how to write each knowledge point by the learner state, and still checks coverage', async () => {
  const { course, lesson, setStates } = await setUp()
  setStates({ 等压面: { state: 'independent', explanation: '两次独立答对' }, 表压强: { state: 'not-yet' } })
  expect(await generate(lesson)).toBe('ready')
  const firstRun = h!.calls.filter(call => isWriter(call) && isFirst(call)).at(-1)!
  expect(masteryOf(firstRun)).toBe([
    '- 等压面：已独立完成（两次独立答对）。压缩：保留定义、符号和适用条件，不展开推导和例题。',
    '- 表压强：还没答对。展开：拆开步骤讲，对照常见错误，用资料里的例题一步一步讲。',
  ].join('\n'))
  // Compressed out of the text, it is still reported as not explained; a recall question naming it does not
  // count (表压强 is never written by this writer).
  expect(h!.ctx.learnTextbook.status(lesson.id).uncovered).toEqual(['等压面', '表压强'])

  // Answered right, then asked about again and again: written out in full.
  setStates({ 等压面: { state: 'independent', doubtful: true }, 表压强: { state: 'assisted' } })
  expect(await generate(lesson, 'again')).toBe('ready')
  const secondRun = h!.calls.filter(call => isWriter(call) && isFirst(call)).at(-1)!
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
  expect(masteryOf(h!.calls.filter(call => isWriter(call) && isFirst(call)).at(-1)!)).toContain('- 等压面：没测过。正常讲。')
  expect(await paragraphs(course.id, lesson)).not.toHaveLength(0)
})

it('rewrites the paragraphs asked for and leaves the others as they were', async () => {
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
  const rechecked = h!.calls.filter(isCheck).slice(checksBefore).flatMap(sentencesIn)
  expect(rechecked).toEqual(['第一步，看两点之间是否由同一种液体连通。', '第二步，再看液体是否静止。'])
  const view = await h!.endpoint<Record<string, { state: string; revised?: string }>>('textbook', 'checks', { lessonId: lesson.id })
  expect(view[steps.id]).toMatchObject({ state: 'ok', revised: instruction })
  expect(view[after[at + 1]!.id]).toMatchObject({ state: 'ok' })
  expect(view[before.find(item => item.text.startsWith('压强是指'))!.id]).toMatchObject({ state: 'single' })
  expect(textbook.status(lesson.id)).toMatchObject({ state: 'ready', unverified: 0, check: { stale: 0 } })

  // Ids not in the lesson, or too many at once, change nothing.
  await expect(textbook.reviseBlocks(lesson.id, { blockIds: ['zzzzzz'], instruction }, meta)).rejects.toMatchObject({ code: 'learning/textbook/no-block' })
  await expect(textbook.reviseBlocks(lesson.id, { blockIds: Array.from({ length: 9 }, (_, i) => `zzzzz${i}`), instruction }, meta)).rejects.toMatchObject({ code: 'learning/textbook/too-many' })
  expect(await paragraphs(course.id, lesson)).toEqual(after)
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

it('marks a paragraph still contradicted after the one rewrite, and explains it on the reader page', async () => {
  const { course, lesson } = await setUp({ contradict: true, revise: same })
  expect(await generate(lesson)).toBe('ready')
  expect(h!.calls.filter(isReviser)).toHaveLength(1)
  const wrong = (await paragraphs(course.id, lesson)).find(item => item.text.includes('一定相等'))!
  expect(wrong.text).toContain('[待核实](cite:unverified)')
  expect(h!.ctx.learnTextbook.status(lesson.id)).toMatchObject({ unverified: 1 })

  type View = { state: string; sentences: { text: string; result: string; tone: string; note: string; quotes: { chunkId: string; source: string; quote: string }[] }[] }
  const view = await h!.endpoint<Record<string, View>>('textbook', 'checks', { lessonId: lesson.id })
  expect(view[wrong.id]).toMatchObject({
    state: 'unsupported',
    sentences: [{ text: '同一高度上的两点压强一定相等。', result: '和原文不一致', tone: 'warn', note: '原文说隔着另一种液体时同一高度也不能认为压强相等', quotes: [{ quote: '即使在同一高度也不能认为压强相等', source: expect.stringContaining('《合成长小节》') }] }],
  })
  const single = Object.values(view).find(item => item.state === 'single')!
  expect(single.sentences[0]).toMatchObject({ result: '只找到一个来源', tone: 'neutral', note: '' })
  // Words for the learner: internal ids only where a quote opens its source.
  const shown = Object.values(view).flatMap(item => item.sentences.flatMap(sentence => [sentence.text, sentence.result, sentence.note, ...sentence.quotes.flatMap(quote => [quote.source, quote.quote])]))
  expect(shown.join('\n')).not.toMatch(/ck_|kn_/)
})
