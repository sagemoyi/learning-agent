// textbook B (docs/textbook/design.md, 逐句核对): before a lesson is published every sentence is checked
// against its sources; a judgment counts only with a real quote and the sentence's numbers in the cited
// text; key facts need two independent sources (the course's other material, then the web); a sentence
// copied from a worked example needs one; a failed check publishes the lesson as not checked. Synthetic
// material; fake model, fake web search (a synthetic page stands in for what was found).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Lesson, WebCandidate } from '@learning-agent/contracts'
import { FIXTURES, createHarness, headingsOf, textbookSettled, type Harness, type ModelCall } from './harness.ts'

const meta = { actor: 'teacher' as const, reason: '教材 B 测试（合成）' }
const QUESTIONS = '### 读完就答\n\n1. 等压面要满足哪些条件？\n2. 表压和绝压怎么换算？'
const WEB_TITLE = '流体静力学讲义（合成网页）'

let h: Harness | undefined
afterEach(() => h?.dispose())

const isWriter = (call: ModelCall) => call.system.startsWith('你是教材编写者')
const isQuestions = (call: ModelCall) => call.system.startsWith('你为一节教材写')
const isCheck = (call: ModelCall) => call.purpose === 'learning-textbook-check'
const isFirst = (call: ModelCall) => call.prompt.includes('这是第一部分')

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
    if (text!.includes('压强是指')) return { id, verdict: 'supported', evidence: [...quote('压强指单位面积上受到的垂直作用力'), ...quote('压强是指单位面积上受到的垂直作用力')] }
    if (text!.includes('998')) return { id, verdict: 'supported', evidence: quote('水的密度取 1000 kg/m³') }
    if (text!.includes('一定相等')) return { id, verdict: 'contradicted', evidence: quote('即使在同一高度也不能认为压强相等'), note: '原文说隔着另一种液体时同一高度也不能认为压强相等' }
    if (text!.includes('逐条检查')) return { id, verdict: 'supported', evidence: quote('判断等压面时要逐条检查条件') }
    if (text!.includes('称为等压面')) return { id, verdict: 'supported', evidence: [...quote('压强相等的面叫等压面'), ...quote('判断等压面要满足三个条件：静止、连通、同一种液体')] }
    if (text!.includes('例 1-1')) return { id, verdict: 'supported', key: true, evidence: quote('敞口水槽中水深 2 m') }
    if (text!.startsWith('$$p_2')) return { id, verdict: 'supported', evidence: [...quote(String.raw`p_2 = p_1 + \rho g h`), ...quote('两点压强差等于 ρgh')] }
    return { id, verdict: 'supported', evidence: first ? [{ chunk: first[0], quote: first[1].slice(0, 6) }] : [] }
  })
  return JSON.stringify({ results })
}

function writer(cite: Record<string, string>) {
  return (call: ModelCall): string => {
    if (isQuestions(call)) return QUESTIONS
    if (isCheck(call)) return check(call)
    if (!isFirst(call)) return `### 小结\n\n这一部分讲的内容。[合成资料 p.3](cite:${/\[(ck_[0-9A-Z]{26})\]/.exec(call.prompt)![1]})\n\n${headingsOf(call)}`
    return [
      '## 1.2 静止流体的压强（合成长小节）', '### 压强',
      `压强是指单位面积上受到的垂直作用力。[合成资料 p.1](cite:${cite.pressure})`,
      `压强常用液柱高度表示，水的密度取 998 kg/m³。[合成资料 p.1](cite:${cite.column})`,
      '### 等压面',
      `同一高度上的两点压强一定相等。[合成资料 p.2](cite:${cite.check})`,
      '判断等压面时要逐条检查条件。',
      `满足静止、连通、同一种液体三个条件的同一水平面称为等压面。[合成资料 p.2](cite:${cite.equal})`,
      `例 1-1（合成） 敞口水槽中水深 2 m，槽底表压为 20 kPa。[合成资料 p.3](cite:${cite.example})`,
      String.raw`$$p_2 = p_1 + \rho g h$$`,
      `式中 ρ 是液体密度，g 是重力加速度。[合成资料 p.2](cite:${cite.symbols})`, headingsOf(call),
    ].join('\n\n')
  }
}

async function setUp(webCheck: boolean, reply: (cite: Record<string, string>) => (call: ModelCall) => string | { finish: 'max-tokens' }) {
  const cite: Record<string, string> = {}
  h = createHarness(call => reply(cite)(call), { textbook: { webCheck } })
  const { ctx, endpoint } = h
  const course = await endpoint('core', 'createCourse', { title: '教材 B（合成资料）' })
  const fixture = (name: string) => ({ file: join(FIXTURES, name, 'source.md'), parsed: [join(FIXTURES, name, 'middle.json')] })
  const skeleton = await endpoint('library', 'import', { title: '合成长小节', kind: 'textbook', authority: '1', courseId: course.id, role: 'skeleton', ...fixture('synthetic-long-section') })
  await endpoint('library', 'import', { title: '合成参考书', kind: 'textbook', authority: '1', courseId: course.id, role: 'reference', ...fixture('synthetic-reference') })
  const chunks = ctx.learnLibrary.section(skeleton.id, '1.2')
  const find = (text: string) => chunks.find(chunk => chunk.text.includes(text))!.id
  Object.assign(cite, {
    pressure: find('压强指单位面积上受到的垂直作用力'), column: find('水的密度取 1000 kg/m³'), check: find('即使在同一高度也不能认为压强相等'),
    equal: find('压强相等的面叫等压面'), example: find('敞口水槽中水深 2 m'), symbols: find('式中 ρ 是液体密度'),
    formula: chunks.find(chunk => chunk.kind === 'formula' && chunk.text.includes('p_2 = p_1'))!.id,
  })
  // The web: one candidate per question on a university site; adding it imports a synthetic page.
  const searched: string[][] = []
  const added: { by: string; urls: string[] }[] = []
  ctx.learnLibrary.searchWeb = async questions => {
    searched.push([...questions])
    const candidates = questions.map((question, index): WebCandidate => ({
      url: `https://hg.example.edu.cn/notes/${index}`, title: WEB_TITLE, snippet: '', site: 'hg.example.edu.cn', organization: 'example.edu.cn',
      authority: '2', rule: '国内高校', format: 'html', provider: 'Exa', question,
    }))
    return { candidates, clues: [], notes: [] }
  }
  ctx.learnLibrary.addWeb = async (courseId, items, by) => {
    added.push({ by, urls: items.map(item => item.url) })
    const source = await ctx.learnLibrary.importParsed({ title: WEB_TITLE, kind: 'web', authority: '2', courseId, role: 'reference', ...fixture('synthetic-web') })
    return [{ url: items[0]!.url, status: 'added' as const, message: '已加入', sourceId: source.id }]
  }
  const { stages: [stage] } = await ctx.learnCurriculum.saveRoadmap(course.id, [{ title: '静止流体', objective: '会用静力学基本方程' }], meta)
  const { lessons } = await ctx.learnCurriculum.saveDesign(stage!.id, { markdown: '# 阶段设计\n\n1.2 静止流体的压强。', lessons: [{ number: '1.2', title: '静止流体的压强' }] }, meta)
  return { course, cite, searched, added, lesson: lessons[0]! as Lesson }
}

async function generate(lesson: Lesson) {
  const settled = textbookSettled(h!.ctx, lesson.id)
  await h!.endpoint('curriculum', 'confirmDesign', { stageId: lesson.stageId })
  return settled
}

const paragraph = (text: string, start: string) => text.split('\n\n').find(piece => piece.startsWith(start))!

it('checks every sentence, finds second sources, and marks what is not supported', async () => {
  const { course, cite, searched, added, lesson } = await setUp(true, writer)
  const handoffs: string[] = []
  h!.ctx.on('learning/handoff', event => { if (event.unit === 'textbook') handoffs.push(event.text) })
  expect(await generate(lesson)).toBe('ready')
  const text = (await h!.ctx.learnCore.files.read(course.id, lesson.textbookFile!))!.text

  // Supported by the skeleton and, as a key fact, by the reference book too: both cited.
  expect(paragraph(text, '压强是指')).toMatch(/\(cite:ck_\w+\)\[《合成参考书》p\.\d+\]\(cite:ck_\w+\) \^/)
  expect(paragraph(text, '压强是指')).not.toContain('待核实')
  // The model said supported, but 998 is not in the quoted chunk; the other one is contradicted.
  expect(paragraph(text, '压强常用液柱高度表示')).toContain('[待核实](cite:unverified)')
  expect(paragraph(text, '同一高度上的两点压强一定相等')).toContain('[待核实](cite:unverified)')
  // A sentence that cited nothing gets the chunk that supports it, and loses its 待核实.
  expect(paragraph(text, '判断等压面时要逐条检查条件')).toContain(`(cite:${cite.check})`)
  expect(paragraph(text, '判断等压面时要逐条检查条件')).not.toContain('待核实')
  // One key fact had no second source in the course: the web found one.
  expect(searched).toEqual([['满足静止、连通、同一种液体三个条件的同一水平面称为等压面。']])
  expect(added).toEqual([{ by: 'teacher', urls: ['https://hg.example.edu.cn/notes/0'] }])
  expect(paragraph(text, '满足静止、连通')).toContain(`[《${WEB_TITLE}》`)
  // A display formula cannot cite: it is checked against the material's formula chunk, cited after it.
  expect(paragraph(text, '式中 ρ 是液体密度')).toContain(`(cite:${cite.formula})`)

  const status = h!.ctx.learnTextbook.status(lesson.id)
  expect(status).toMatchObject({ state: 'ready', unverified: 2, check: { state: 'checked', single: 0, stale: 0, notes: [`联网补充加入了《${WEB_TITLE}》`] } })
  const checks = (h!.ctx.learnTextbook as unknown as { checks(courseId: string, file: string): Map<string, { sentences: { text: string; groups: string[]; copy: boolean; note: string }[] }> }).checks(course.id, lesson.textbookFile!)
  const sentence = (start: string) => [...checks.values()].flatMap(item => item.sentences).find(item => item.text.startsWith(start))!
  expect(sentence('压强是指').groups).toEqual(['work:合成长小节', 'work:合成参考书'])
  expect(sentence('压强常用液柱高度表示').note).toBe('数值 998 在所引原文里找不到')
  // Found by the paragraph that explains it, in the other book.
  expect(sentence('$$p_2').groups).toEqual(['work:合成长小节', 'work:合成参考书'])
  // Copied from a worked example: one source is enough, though it states numbers.
  expect(sentence('例 1-1')).toMatchObject({ copy: true, groups: ['work:合成长小节'] })
  expect(handoffs.at(-1)).toContain(`2 段待核实；联网补充加入了《${WEB_TITLE}》`)

  // An edit outside the app voids the check of the paragraph it touches.
  const path = join(h!.ctx.learnCore.courses.folder(course.id), lesson.textbookFile!)
  writeFileSync(path, text.replace('压强是指单位面积上受到的垂直作用力。', '压强是指单位面积上受到的力。'), 'utf8')
  await h!.ctx.learnCore.files.read(course.id, lesson.textbookFile!)
  await h!.settle()
  expect(h!.ctx.learnTextbook.status(lesson.id)).toMatchObject({ check: { stale: 1 } })
})

it('shows a key fact with one source as such, without 待核实, when the web supplement is off', async () => {
  const { course, searched, lesson } = await setUp(false, writer)
  expect(await generate(lesson)).toBe('ready')
  expect(searched).toEqual([])
  const text = (await h!.ctx.learnCore.files.read(course.id, lesson.textbookFile!))!.text
  expect(paragraph(text, '满足静止、连通')).not.toContain('待核实')
  expect(h!.ctx.learnTextbook.status(lesson.id)).toMatchObject({ unverified: 2, check: { state: 'checked', single: 1, notes: [] } })
})

it('publishes a lesson whose check failed as not checked, without marking it', async () => {
  const { course, lesson } = await setUp(false, cite => call => {
    if (isCheck(call)) throw new Error('核对模型暂时不可用')
    return writer(cite)(call)
  })
  const handoffs: string[] = []
  h!.ctx.on('learning/handoff', event => { if (event.unit === 'textbook') handoffs.push(event.text) })
  expect(await generate(lesson)).toBe('ready')
  // Each batch was asked twice.
  expect(h!.calls.filter(isCheck).length).toBeGreaterThanOrEqual(2)
  expect(h!.calls.filter(isCheck).length % 2).toBe(0)
  const text = (await h!.ctx.learnCore.files.read(course.id, lesson.textbookFile!))!.text
  expect(paragraph(text, '压强常用液柱高度表示')).not.toContain('待核实')
  expect(paragraph(text, '判断等压面时要逐条检查条件')).toContain('待核实')
  const status = h!.ctx.learnTextbook.status(lesson.id)
  expect(status).toMatchObject({ state: 'ready', check: { state: 'unchecked' } })
  expect(status.check!.notes[0]).toMatch(/出处没有核对完：.*核对模型暂时不可用/)
  expect(handoffs.at(-1)).toContain('出处没有核对完')
  expect(h!.calls.filter(isWriter)).toHaveLength(2)
})

it('halves a check batch whose reply is cut off at the output limit', async () => {
  const { lesson } = await setUp(false, cite => call => {
    // More than three sentences do not fit the (fake) output budget.
    if (isCheck(call) && call.system.startsWith('你核对一节教材') && [...call.prompt.matchAll(/^\[\d+\.\d+\] /gm)].length > 3) return { finish: 'max-tokens' }
    return writer(cite)(call)
  })
  expect(await generate(lesson)).toBe('ready')
  expect(h!.ctx.learnTextbook.status(lesson.id)).toMatchObject({ check: { state: 'checked', notes: [] } })
  const firsts = h!.calls.filter(call => isCheck(call) && call.system.startsWith('你核对一节教材'))
  expect(firsts.length).toBeGreaterThan(2)
})
