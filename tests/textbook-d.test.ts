// textbook D (docs/textbook/design.md, 讲解与原文): the writer explains in its own words and names source text
// to copy in, which the program copies word for word and never checks; the explanation is checked against its
// point's material, by rule (numbers, words copied from an exercise) and by the check model, and problems are
// marked in the index, not in the text; the plan sees the chapter's exercises, the writer only what they need;
// what the material lacks is looked for in the course's other material, then on the web (a page quoted by its
// address, never added to the library), and said to be missing otherwise. Synthetic material; fake model,
// fake web search.
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Lesson, WebCandidate } from '@learning-agent/contracts'
import * as textbookTools from '../packages/textbook/src/tools.ts'
import { FIXTURES, createHarness, textbookSettled, type Harness, type ModelCall } from './harness.ts'
import { checkOk, isCheck, isPlan, isWriter, materialOf, planBySubsection, textbookReply, titleOf, writePoint } from './textbook-fakes.ts'

const meta = { actor: 'teacher' as const, reason: '教材 D 测试（合成）' }
const WEB = { url: 'https://hg.example.edu.cn/notes/incline', title: '倾斜液柱压差计（合成网页）' }

let h: Harness | undefined
afterEach(() => h?.dispose())

type Reply = (call: ModelCall) => string | { finish: 'max-tokens' }
const usual: Reply = call => textbookReply(call) ?? (() => { throw new Error(`unexpected model call: ${call.purpose}`) })()

async function setUp(reply: Reply, options: { readonly web?: boolean; readonly reference?: boolean } = {}) {
  h = createHarness(reply, { textbook: { webCheck: options.web ?? false } })
  const { ctx, endpoint } = h
  const course = await endpoint('core', 'createCourse', { title: '教材 D（合成资料）' })
  const fixture = (name: string) => ({ file: join(FIXTURES, name, 'source.md'), parsed: [join(FIXTURES, name, 'middle.json')] })
  const skeleton = await endpoint('library', 'import', { title: '合成长小节', kind: 'textbook', authority: '1', courseId: course.id, role: 'skeleton', ...fixture('synthetic-long-section') })
  if (options.reference) await endpoint('library', 'import', { title: '合成参考书', kind: 'textbook', authority: '1', courseId: course.id, role: 'reference', ...fixture('synthetic-reference') })
  // The web: one university page; reading it gives its passages, adding it to the library must not happen.
  const searched: string[][] = []
  ctx.learnLibrary.searchWeb = async questions => {
    searched.push([...questions])
    const candidates = questions.map((question): WebCandidate => ({
      url: WEB.url, title: WEB.title, snippet: '', site: 'hg.example.edu.cn', organization: 'example.edu.cn', authority: '2', rule: '国内高校', format: 'html', provider: 'Exa', question,
    }))
    return { candidates, clues: [], notes: [] }
  }
  ctx.learnLibrary.readWeb = async url => ({
    status: 'read', url, title: WEB.title, site: 'hg.example.edu.cn', authority: '2', rule: '国内高校',
    passages: ['课程介绍与考核方式。', '倾斜液柱压差计把 U 形管的一支斜放，读数沿斜管读，倾斜让读数放大，适合测很小的压差。'],
  })
  ctx.learnLibrary.addWeb = async () => { throw new Error('the textbook must not add web pages to the library') }
  const { stages: [stage] } = await ctx.learnCurriculum.saveRoadmap(course.id, [{ title: '静止流体', objective: '会用静力学基本方程' }], meta)
  const { lessons } = await ctx.learnCurriculum.saveDesign(stage!.id, { markdown: '# 阶段设计\n\n1.2 静止流体的压强。', lessons: [{ number: '1.2', title: '静止流体的压强' }] }, meta)
  const chunks = ctx.learnLibrary.section(skeleton.id, '1.2')
  return { course, chunks, searched, lesson: lessons[0]! as Lesson }
}

async function generate(lesson: Lesson) {
  const settled = textbookSettled(h!.ctx, lesson.id)
  await h!.endpoint('curriculum', 'confirmDesign', { stageId: lesson.stageId })
  return settled
}

type Info = { kind: string; state: string; note: string; sources: { chunkId: string; citation: string; text: string }[]; web: { url: string; title: string; passage: string }[] }

/** The block whose text starts with `start`, from the published file. */
async function blockOf(courseId: string, lesson: Lesson, start: string) {
  const textbook = h!.ctx.learnTextbook
  for (const block of textbook.blocks(courseId, lesson.textbookFile!)) {
    const text = (await textbook.block(courseId, block.id))!.text
    if (text.startsWith(start)) return { ...block, text }
  }
  throw new Error(`no block starting with ${start}`)
}

it('copies the source text the writer names word for word, never checks it, and leaves out what it may not copy', async () => {
  let later = ''
  const { course, chunks, lesson } = await setUp(call => {
    if (!isWriter(call) || titleOf(call) !== '静力学基本方程') return usual(call)
    const material = materialOf(call)
    const formula = material.find(chunk => chunk.kind === '公式')!
    return [
      '### 静力学基本方程',
      `两点的压强差只看高度差。[合成资料 p.2](cite:${material.find(chunk => chunk.kind === '正文')!.id})`,
      `![[${formula.id}]]`,
      // Not in this lesson's material; a range across a subsection heading; a quote box the writer made up.
      '![[ck_01K6PQZRB8M3A4T5V6W7X8Y9ZZ]]',
      `![[${formula.id}..${later}]]`,
      '> [!quote] 原文 · 这段是写作模型自己编的。',
    ].join('\n\n')
  })
  // A formula of the next subsection: a range up to it crosses a heading.
  later = chunks.find(chunk => chunk.kind === 'formula' && chunk.text.includes('p_1 - p_2'))!.id
  expect(await generate(lesson)).toBe('ready')
  const text = (await h!.ctx.learnCore.files.read(course.id, lesson.textbookFile!))!.text
  const formula = chunks.find(chunk => chunk.kind === 'formula' && chunk.text.includes('p_2 = p_1'))!
  expect(text).toContain(`> [!quote] 原文 · [${formula.citation}](cite:${formula.id})\n${formula.text.split('\n').map(line => `> ${line}`).join('\n')}`)
  expect(text).not.toContain('ck_01K6PQZRB8M3A4T5V6W7X8Y9ZZ')
  // The made-up box is explanation like any other, checked against the material.
  const madeUp = await blockOf(course.id, lesson, '原文 · 这段是写作模型自己编的。')
  expect(madeUp.original).toBe(false)
  const checked = h!.calls.filter(isCheck).flatMap(call => call.prompt.split('# 要核对的讲解段落')[1]!.split('\n').filter(line => line.startsWith('[P')))
  expect(checked.some(line => line.includes('这段是写作模型自己编的'))).toBe(true)
  expect(checked.some(line => line.includes('p_2 = p_1'))).toBe(false)
  expect(h!.ctx.learnTextbook.status(lesson.id)).toMatchObject({ state: 'ready', unverified: 0, check: { notes: expect.arrayContaining(['2 处出处或嵌入无效，已去掉']) } })
})

it('flags explanation the material does not support, by rule and by the check, in the index and not in the text', async () => {
  const { course, lesson } = await setUp(call => {
    if (isCheck(call)) return checkOk(call, text => (text.includes('还能拿来做饭') ? { verdict: 'unsupported', note: '资料里没有说压强计能做饭' } : { verdict: 'ok' }))
    if (!isWriter(call) || titleOf(call) !== '压强的几种表示') return usual(call)
    const cite = materialOf(call).find(chunk => chunk.kind === '正文')!.id
    return [
      '### 压强的几种表示',
      // A number the material does not have: flagged whatever the check says.
      `液柱表示压强时，水的密度取 998 kg/m³。[合成资料 p.1](cite:${cite})`,
      // No citation: the check says where it comes from, and the source is added.
      '记录压强时要写明是表压还是绝压。',
      `压强计还能拿来做饭。[合成资料 p.1](cite:${cite})`,
    ].join('\n\n')
  })
  expect(await generate(lesson)).toBe('ready')
  const text = (await h!.ctx.learnCore.files.read(course.id, lesson.textbookFile!))!.text
  expect(text).not.toContain('待核实')
  expect(h!.ctx.learnTextbook.status(lesson.id)).toMatchObject({ state: 'ready', unverified: 2, check: { state: 'checked' } })
  const number = await blockOf(course.id, lesson, '液柱表示压强时')
  expect(await h!.endpoint<Info>('textbook', 'blockInfo', { courseId: course.id, blockId: number.id })).toMatchObject({ state: 'flagged', note: expect.stringContaining('数值 998 在资料里找不到') })
  const cooking = await blockOf(course.id, lesson, '压强计还能拿来做饭')
  expect(await h!.endpoint<Info>('textbook', 'blockInfo', { courseId: course.id, blockId: cooking.id })).toMatchObject({ state: 'flagged', note: '资料里没有说压强计能做饭' })
  const record = await blockOf(course.id, lesson, '记录压强时要写明')
  expect(record.citations).toHaveLength(1)
  expect(await h!.endpoint('textbook', 'checks', { lessonId: lesson.id })).toEqual({ [number.id]: 'flagged', [cooking.id]: 'flagged' })

  // The teacher reads the lesson with the flagged paragraphs listed at the end.
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  ;(h!.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  textbookTools.apply(h!.ctx as never)
  const exec = { agent: { session: { id: await h!.ctx.learnTutor.session(course.id) } } }
  const read = await tools.get('read_lesson_textbook')!.execute({ lessonId: lesson.id }, exec)
  expect(read.split('\n').at(-1)).toBe(`（待核实的段落：^${number.id}、^${cooking.id}。它们和资料不一致或在资料里找不到依据，可以用 revise_textbook 按原文改。）`)
})

it('publishes a lesson whose check failed as not checked, without flagging anything', async () => {
  const { course, lesson } = await setUp(call => {
    if (isCheck(call)) throw new Error('核对服务暂时不可用')
    return usual(call)
  })
  expect(await generate(lesson)).toBe('ready')
  const status = h!.ctx.learnTextbook.status(lesson.id)
  expect(status).toMatchObject({ state: 'ready', unverified: 0, check: { state: 'unchecked', notes: expect.arrayContaining([expect.stringContaining('核对服务暂时不可用')]) } })
  const marks = await h!.endpoint<Record<string, string>>('textbook', 'checks', { lessonId: lesson.id })
  expect(Object.values(marks).length).toBeGreaterThan(0)
  expect(new Set(Object.values(marks))).toEqual(new Set(['unchecked']))
  expect(h!.ctx.learnTextbook.blocks(course.id, lesson.textbookFile).some(block => block.original)).toBe(true)
})

it('plans from the chapter\'s exercises without showing them to the writer, and finds what the material lacks in the course\'s other material', async () => {
  const { course, lesson } = await setUp(call => {
    if (isPlan(call)) {
      return planBySubsection(call, [
        { text: '记录压强时注明表压还是绝压', point: 2, covered: true },
        { text: '深度相差两点压强', point: 3, covered: false },
        // Copies the exercise: never reaches the writer.
        { text: '敞口水槽中水深 3 m，求槽底的表压强', point: 3, covered: true },
      ])
    }
    return usual(call)
  }, { reference: true })
  expect(await generate(lesson)).toBe('ready')
  const plan = h!.calls.find(isPlan)!
  expect(plan.prompt).toContain('敞口水槽中水深 3 m')
  expect(plan.prompt).not.toContain('[30 kPa]')
  const writers = h!.calls.filter(isWriter)
  for (const call of writers) {
    expect(call.prompt).not.toContain('敞口水槽中水深 3 m')
    expect(call.prompt).not.toContain('1-6')
  }
  const equation = writers.find(call => titleOf(call) === '静力学基本方程')!
  expect(equation.prompt).toContain('# 做练习要会的')
  expect(equation.prompt).toContain('- 深度相差两点压强（本节资料没讲，见补充资料）')
  // The other book's passage is given as supplementary material the writer may cite and copy in.
  expect(equation.prompt.split('# 补充资料')[1]).toContain('深度相差 h 的两点压强差等于 ρgh')
  expect(writers.find(call => titleOf(call) === '压强的几种表示')!.prompt).toContain('- 记录压强时注明表压还是绝压\n')
  expect(h!.ctx.learnTextbook.status(lesson.id)).not.toHaveProperty('missing')
  expect(h!.ctx.learnLibrary.courseSources(course.id)).toHaveLength(2)
})

it('quotes a web page by its address for what no material explains, without adding it to the library', async () => {
  const { course, lesson, searched } = await setUp(call => {
    if (isPlan(call)) return planBySubsection(call, [{ text: '倾斜液柱压差计为什么能放大读数', point: 4, covered: false }])
    if (isWriter(call) && call.prompt.includes('# 网页摘录')) return `${writePoint(call)}\n\n倾斜放置让读数变大，适合测很小的压差。[${WEB.title}](${WEB.url})`
    return usual(call)
  }, { web: true })
  expect(await generate(lesson)).toBe('ready')
  expect(searched).toEqual([['倾斜液柱压差计为什么能放大读数']])
  const writer = h!.calls.filter(isWriter).find(call => titleOf(call) === '基本方程的应用')!
  // The passages that say something about what is needed; a scrap of navigation is left out.
  expect(writer.prompt.split('# 网页摘录')[1]).toContain('倾斜液柱压差计把 U 形管的一支斜放')
  expect(writer.prompt).not.toContain('课程介绍与考核方式')
  const text = (await h!.ctx.learnCore.files.read(course.id, lesson.textbookFile!))!.text
  expect(text).toContain(`[${WEB.title}](${WEB.url})`)
  expect(h!.ctx.learnLibrary.courseSources(course.id)).toHaveLength(1)
  expect(h!.ctx.learnTextbook.status(lesson.id)).toMatchObject({ check: { notes: expect.arrayContaining([`联网补充：《${WEB.title}》（${WEB.url}）`]) } })
  const paragraph = await blockOf(course.id, lesson, '倾斜放置让读数变大')
  expect(await h!.endpoint<Info>('textbook', 'blockInfo', { courseId: course.id, blockId: paragraph.id })).toMatchObject({ web: [{ url: WEB.url, title: WEB.title, passage: expect.stringContaining('倾斜液柱压差计') }] })
})

it('says where the material lacks what the exercises need, and tells the teacher', async () => {
  const said: string[] = []
  const { course, lesson } = await setUp(call => (isPlan(call) ? planBySubsection(call, [{ text: '微差压差计里扩大室的作用', point: 4, covered: false }]) : usual(call)))
  h!.ctx.on('learning/handoff', event => { if (event.unit === 'textbook') said.push(event.text) })
  expect(await generate(lesson)).toBe('ready')
  const writer = h!.calls.filter(isWriter).find(call => titleOf(call) === '基本方程的应用')!
  expect(writer.prompt).toContain('- 微差压差计里扩大室的作用（资料里找不到，不要讲）')
  const text = (await h!.ctx.learnCore.files.read(course.id, lesson.textbookFile!))!.text
  expect(text).toContain('> [!note] 资料里没有讲到：微差压差计里扩大室的作用。')
  expect(h!.ctx.learnTextbook.status(lesson.id)).toMatchObject({ missing: ['微差压差计里扩大室的作用'] })
  expect(said.at(-1)).toContain('习题要用、资料里没有讲到：微差压差计里扩大室的作用')
})
