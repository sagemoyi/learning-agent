// textbook (docs/textbook/design.md): a section names source text to copy in, which the program copies word for
// word (never a worked example, at most three in a section); the handout is checked by the program alone — a
// formula unlike the source, a number the material lacks, an exercise named, a paragraph copied — and what it finds
// is rewritten once, what is still wrong marked in the index, not in the text. What the exercises need and the
// material lacks is looked for in the course's other material, then on the web (a page quoted by its address,
// never added to the library), and said to be missing otherwise. Synthetic material; fake model, fake web search.
import { afterEach, expect, it } from 'vitest'
import * as textbookTools from '../../packages/textbook/src/tools.ts'
import type { ModelCall } from '../harness.ts'
import {
  WEB, blockOf, confirm, handoutCourse, handoutText, isOverview, isPlan, isReviser, isSection, materialOf, overviewReply, planReply,
  reviseReply, sectionOf, sectionReply, usual, type HandoutCourse,
} from './fakes.ts'

let course: HandoutCourse | undefined
afterEach(() => course?.h.dispose())

type Info = { kind: string; state: string; note: string; sources: { chunkId: string; citation: string; text: string }[]; web: { url: string; title: string; passage: string }[] }

const THREE = [{ number: '1.2.2', title: '压强的几种表示' }, { number: '1.2.3', title: '静力学基本方程' }, { number: '1.2.4', title: '基本方程的应用' }]
const firstText = (call: ModelCall) => materialOf(call).find(chunk => chunk.kind === '正文')!.id

it('copies the source text a section names word for word, never a worked example, and at most three', async () => {
  course = await handoutCourse(call => {
    if (!isSection(call)) return usual(call)
    const material = materialOf(call)
    const formulas = material.filter(chunk => chunk.kind === '公式')
    return [
      `两点的压强差只看高度差。[合成资料 p.2](cite:${firstText(call)})`,
      `![[${formulas[0]!.id}]]`,
      // A worked example is cited, not copied in; an id not in the material; a quote box the writer made up.
      `![[${material.find(chunk => chunk.kind === '例题')!.id}]]`,
      '![[ck_01K6PQZRB8M3A4T5V6W7X8Y9ZZ]]',
      '> [!quote] 原文 · 这段是写作模型自己编的。',
      // The fourth formula is one too many.
      ...formulas.slice(1).map(formula => `![[${formula.id}]]`),
    ].join('\n\n')
  })
  const { h, courseId, chunks, lessons } = course
  expect(await confirm(course)).toBe('ready')
  const text = await handoutText(course)
  const formulas = chunks.filter(chunk => chunk.kind === 'formula')
  expect(formulas).toHaveLength(4)
  for (const formula of formulas.slice(0, 3)) expect(text).toContain(`> [!quote] 原文 · [${formula.citation}](cite:${formula.id})\n${formula.text.split('\n').map(line => `> ${line}`).join('\n')}`)
  expect(text).not.toContain(`> [!quote] 原文 · [${formulas[3]!.citation}](cite:${formulas[3]!.id})`)
  expect(text).not.toContain('例 1-1（合成）')
  expect(text).not.toContain('ck_01K6PQZRB8M3A4T5V6W7X8Y9ZZ')
  // The made-up box is explanation like any other.
  expect((await blockOf(course, '原文 · 这段是写作模型自己编的。')).original).toBe(false)
  expect(h.ctx.learnTextbook.blocks(courseId).filter(block => block.original)).toHaveLength(3)
  expect(h.ctx.learnTextbook.status(lessons[0]!.id)).toMatchObject({ state: 'ready', unverified: 0, notes: expect.arrayContaining(['3 处出处或嵌入无效，已去掉']) })
})

it('rewrites once what the program finds, leaves the rest alone, and flags in the index what is still wrong', async () => {
  let formula = ''
  course = await handoutCourse(call => {
    // A term's sentence with a number the material lacks: the table is flagged by its row.
    if (isOverview(call)) return overviewReply(call, '单位面积上受到 998 N 的力')
    if (isReviser(call)) {
      return reviseReply(call, text => {
        if (text.includes('移项')) return `点 1 的压强可以由基本方程倒过来求，式子仍按原文：\n\n![[${formula}]]`
        if (text.includes('三个条件')) return '三个条件缺一不可：静止、同一种流体连通、密度处处一样。'
        if (text.includes('习题')) return '（删除）'
        return text
      })
    }
    if (!isSection(call)) return usual(call)
    formula = course!.chunks.find(chunk => chunk.kind === 'formula' && chunk.text.includes('p_2 = p_1'))!.id
    const cite = firstText(call)
    return [
      // Rearranged: not the formula the source writes.
      `把基本方程移项，得到 $p_1 = p_2 - \\rho g h$。[合成资料 p.2](cite:${cite})`,
      // A number the material does not have.
      `液柱表示压强时，水的密度取 998 kg/m³。[合成资料 p.1](cite:${cite})`,
      // Copied from the source word for word.
      `基本方程成立需要三个条件：流体静止；两点之间由同一种流体连通；流体密度不随位置变化。[合成资料 p.2](cite:${cite})`,
      // An exercise named.
      `这和习题 1-6 的算法一样。[合成资料 p.2](cite:${cite})`,
      // As the source writes it, in other words: left alone.
      `深度每增加一段，压强按 $p_2 = p_1 + \\rho g h$ 跟着增加。[合成资料 p.2](cite:${cite})`,
    ].join('\n\n')
  })
  const { h, courseId, lessons } = course
  const [lesson] = lessons
  expect(await confirm(course)).toBe('ready')
  const [reviser, ...more] = h.calls.filter(isReviser)
  expect(more).toEqual([])
  expect(reviser!.prompt).toContain('式子 $p_1 = p_2 - \\rho g h$ 和资料里的写法不一致，公式要和原文一样')
  expect(reviser!.prompt).toContain('数值 998 在资料里找不到')
  expect(reviser!.prompt).toContain('提到了习题的题号')
  expect(reviser!.prompt).toContain('几乎照抄了资料原文：「基本方程成立需要三个条件')
  // Only as context next to a target, not to rewrite; the program's tables never.
  const targets = reviser!.prompt.split('# 要改的段落')[1]!.split('# 前后文')[0]!
  expect(targets).not.toContain('深度每增加一段')
  expect(targets).not.toContain('| 名词 |')

  const text = await handoutText(course)
  // The formula the reviser named comes in as the source writes it.
  const source = course.chunks.find(chunk => chunk.id === formula)!
  expect(text).toContain(`倒过来求，式子仍按原文： ^`)
  expect(text).toContain(`> [!quote] 原文 · [${source.citation}](cite:${source.id})`)
  expect(text).not.toContain('p_1 = p_2 -')
  expect(text).not.toContain('基本方程成立需要三个条件')
  expect(text).not.toContain('习题 1-6')
  expect(text).toContain('三个条件缺一不可')
  expect(text).toContain('深度每增加一段')
  // Still wrong after the one rewrite: in the index and the reader's margin, never in the text.
  expect(text).not.toContain('待核实')
  const number = await blockOf(course, '液柱表示压强时')
  const table = await blockOf(course, '| 名词 |')
  expect(h.ctx.learnTextbook.status(lesson!.id)).toMatchObject({ state: 'ready', unverified: 2 })
  expect(new Set(await h.endpoint<string[]>('textbook', 'flagged', { lessonId: lesson!.id }))).toEqual(new Set([number.id, table.id]))
  expect(await h.endpoint<Info>('textbook', 'blockInfo', { courseId, blockId: number.id })).toMatchObject({ state: 'flagged', note: '数值 998 在资料里找不到' })
  expect(await h.endpoint<Info>('textbook', 'blockInfo', { courseId, blockId: table.id })).toMatchObject({ state: 'flagged', note: '「压强」这一行：数值 998 在资料里找不到' })

  // The teacher reads the section with the flagged paragraphs listed at the end.
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  ;(h.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  textbookTools.apply(h.ctx as never)
  const exec = { agent: { session: { id: await h.ctx.learnTutor.session(courseId) } } }
  const read = await tools.get('read_lesson_textbook')!.execute({ lessonId: lesson!.id }, exec)
  expect(read).toMatch(/^### 1\.2 静止流体的压强/)
  expect(read).not.toContain('### 本章速览')
  expect(read.split('\n').at(-1)).toBe(`（待核实的段落：^${number.id}。它们的式子或数值和资料对不上，可以用 revise_textbook 按原文改。）`)
  const whole = await tools.get('read_lesson_textbook')!.execute({ lessonId: lesson!.id, whole: true }, exec)
  expect(whole).toContain('### 本章速览')
  expect(whole.split('\n').at(-1)).toContain(`^${table.id}`)
})

it('plans from the chapter\'s exercises without showing them to the writer, and finds what the material lacks in the course\'s other material', async () => {
  course = await handoutCourse(call => {
    if (isPlan(call)) {
      return planReply(call, {
        needs: [
          { text: '记录压强时注明表压还是绝压', section: 1, covered: true },
          { text: '深度相差两点压强', section: 2, covered: false },
          // Copies the exercise: never reaches the writer.
          { text: '敞口水槽中水深 3 m，求槽底的表压强', section: 2, covered: true },
        ],
      })
    }
    return usual(call)
  }, { lessons: THREE, reference: true })
  const { h, courseId, lessons } = course
  expect(await confirm(course)).toBe('ready')
  for (const call of h.calls.filter(isSection)) {
    expect(call.prompt).not.toContain('敞口水槽中水深 3 m')
    expect(call.prompt).not.toContain('1-6')
  }
  const sections = h.calls.filter(isSection)
  const equation = sections.find(call => sectionOf(call) === '1.2.3 静力学基本方程')!
  expect(equation.prompt).toContain('# 做练习要会的（只讲道理，不出题、不提习题）\n- 深度相差两点压强（本节资料没讲，见补充资料）')
  // The other book's passage is given as supplementary material the writer may cite and copy in.
  expect(equation.prompt.split('# 补充资料')[1]).toContain('深度相差 h 的两点压强差等于 ρgh')
  expect(sections.find(call => sectionOf(call) === '1.2.2 压强的几种表示')!.prompt).toContain('- 记录压强时注明表压还是绝压\n')
  expect(sections.find(call => sectionOf(call) === '1.2.4 基本方程的应用')!.prompt).not.toContain('# 做练习要会的')
  expect(h.ctx.learnTextbook.status(lessons[0]!.id)).not.toHaveProperty('missing')
  expect(h.ctx.learnLibrary.courseSources(courseId)).toHaveLength(2)
})

it('quotes a web page by its address for what no material explains, without adding it to the library', async () => {
  course = await handoutCourse(call => {
    if (isPlan(call)) return planReply(call, { needs: [{ text: '倾斜液柱压差计为什么能放大读数', section: 1, covered: false }] })
    if (isSection(call) && call.prompt.includes('# 网页摘录')) return `${sectionReply(call)}\n\n倾斜放置让读数变大，适合测很小的压差。[${WEB.title}](${WEB.url})`
    return usual(call)
  }, { web: true })
  const { h, courseId, lessons, searched } = course
  expect(await confirm(course)).toBe('ready')
  expect(searched).toEqual([['倾斜液柱压差计为什么能放大读数']])
  const writer = h.calls.find(isSection)!
  // The passages that say something about what is needed; a scrap of navigation is left out.
  expect(writer.prompt.split('# 网页摘录')[1]).toContain('倾斜液柱压差计把 U 形管的一支斜放')
  expect(writer.prompt).not.toContain('课程介绍与考核方式')
  expect(await handoutText(course)).toContain(`[${WEB.title}](${WEB.url})`)
  expect(h.ctx.learnLibrary.courseSources(courseId)).toHaveLength(1)
  expect(h.ctx.learnTextbook.status(lessons[0]!.id)).toMatchObject({ notes: expect.arrayContaining([`联网补充：《${WEB.title}》（${WEB.url}）`]) })
  const paragraph = await blockOf(course, '倾斜放置让读数变大')
  expect(await h.endpoint<Info>('textbook', 'blockInfo', { courseId, blockId: paragraph.id })).toMatchObject({ web: [{ url: WEB.url, title: WEB.title, passage: expect.stringContaining('倾斜液柱压差计') }] })
  // A web page is a source: the paragraph is not counted as citing nothing.
  expect(paragraph.uncited).toBe(false)
})

it('counts, by rule, the explanation paragraphs that cite nothing, apart from the learner\'s own', async () => {
  course = await handoutCourse(call => {
    if (!isSection(call)) return usual(call)
    return [
      `两点的压强差只看高度差。[合成资料 p.2](cite:${firstText(call)})`,
      '同一水平面上各点的压强相等，这一段没有引用。',
      '压强随深度线性增加，这一段也没有引用。',
      '好的。',
      '| 名词 | 含义 |\n|---|---|\n| 表压 | 相对大气压的压强 |',
    ].join('\n\n')
  })
  const { h, courseId, lessons } = course
  expect(await confirm(course)).toBe('ready')
  const calls = h.calls.length
  const [cited, first, second] = await Promise.all(['两点的压强差', '同一水平面上', '压强随深度'].map(start => blockOf(course!, start)))
  const uncited = () => h.endpoint<string[]>('textbook', 'uncited', { lessonId: lessons[0]!.id })
  const listed = await uncited()
  expect(listed).toEqual(expect.arrayContaining([first!.id, second!.id]))
  expect(listed).not.toContain(cited!.id)
  // A word or two and a table are not explanation.
  const others = h.ctx.learnTextbook.blocks(courseId).filter(block => block.uncited).map(block => block.id)
  expect(others).toEqual(listed)
  expect(h.ctx.learnTextbook.status(lessons[0]!.id)).toMatchObject({ uncited: listed.length })
  // The learner's own words are theirs to source.
  const opened = await h.endpoint<{ text: string; hash: string }>('textbook', 'blockSource', { courseId, blockId: second!.id })
  await h.endpoint('textbook', 'editBlock', { courseId, blockId: second!.id, text: '我自己的理解：越深压强越大。', base: opened.hash })
  expect(await uncited()).toEqual(listed.filter(id => id !== second!.id))
  expect(h.ctx.learnTextbook.status(lessons[0]!.id)).toMatchObject({ uncited: listed.length - 1 })
  // No model was asked.
  expect(h.calls.length).toBe(calls)
})

it('explains a term the material lacks from the course\'s other material, and names one found nowhere', async () => {
  course = await handoutCourse(call => {
    if (isPlan(call)) return planReply(call, { terms: [{ name: '两点压强差', chunk: 0 }, { name: '扩大室', chunk: 0 }, { name: '国际单位', chunk: 0 }] })
    if (isOverview(call)) {
      const other = /# 补充资料[^\n]*\n\[(ck_[0-9A-Z]{26})\]/.exec(call.prompt)![1]
      // The second has no source it was given: it goes, and is named as not explained.
      return JSON.stringify({ terms: [{ name: '两点压强差', text: '高度差为 h 的两点之间的压强差', cite: other }, { name: '国际单位', text: '帕斯卡', cite: 'ck_01K6PQZRB8M3A4T5V6W7X8Y9ZZ' }], formulas: [] })
    }
    return usual(call)
  }, { reference: true })
  const { h, lessons } = course
  expect(await confirm(course)).toBe('ready')
  const overview = h.calls.find(isOverview)!
  expect(overview.prompt).toContain('# 要解释的名词（按这个顺序）\n1. 两点压强差（本章资料没讲，见补充资料或网页摘录）\n2. 国际单位（本章资料没讲，见补充资料或网页摘录）\n')
  expect(overview.prompt).not.toContain('扩大室')
  expect(overview.prompt.split('# 补充资料')[1]).toContain('深度相差 h 的两点压强差等于 ρgh')
  const text = await handoutText(course)
  expect(text).toMatch(/\| \*\*两点压强差\*\* \| 高度差为 h 的两点之间的压强差 \| \[《合成参考书》p\.\d+\]\(cite:ck_\w+\) \|/)
  expect(text).not.toContain('**国际单位**')
  expect(text).toContain('> [!note] 资料里没有讲到：扩大室；国际单位。')
  expect(h.ctx.learnTextbook.status(lessons[0]!.id)).toMatchObject({ missing: ['扩大室', '国际单位'], unverified: 0 })
})

it('says where the material lacks what the exercises need, and tells the teacher', async () => {
  const said: string[] = []
  course = await handoutCourse(call => (isPlan(call) ? planReply(call, { needs: [{ text: '微差压差计里扩大室的作用', section: 1, covered: false }] }) : usual(call)))
  const { h, lessons } = course
  h.ctx.on('learning/handoff', event => { if (event.unit === 'textbook') said.push(event.text) })
  expect(await confirm(course)).toBe('ready')
  expect(h.calls.find(isSection)!.prompt).toContain('- 微差压差计里扩大室的作用（资料里找不到，不要讲）')
  const text = await handoutText(course)
  expect(text.split('### 题型与方法')[0]).toContain('> [!note] 资料里没有讲到：微差压差计里扩大室的作用。')
  expect(h.ctx.learnTextbook.status(lessons[0]!.id)).toMatchObject({ missing: ['微差压差计里扩大室的作用'] })
  expect(said.at(-1)).toContain('习题要用、资料里没有讲到：微差压差计里扩大室的作用')
})
