// sidechat B (docs/sidechat/design.md, 可靠的学习记录): after each reply the record logs the help, questions and
// possible misconceptions at once, dated by their messages, keeping only what the program can check; a stretch that
// fails is sorted again later and skipped after repeated failures; closing builds the summary from the record (nothing
// sorted twice), cut at the last message, refused while a reply is being written, and safe to repeat; the note in the
// course folder reads without internal ids.
// Real units on the harness; the model, the DSH sessions and their record are fakes.
import { afterEach, expect, it, vi } from 'vitest'
import type { Id } from '@learning-agent/contracts'
import { createHarness, type Harness, type ModelCall } from './harness.ts'

let h: Harness | undefined
afterEach(() => { vi.restoreAllMocks(); h?.dispose(); h = undefined })

const teacher = { actor: 'teacher' as const, reason: '侧边会话 B 测试（合成）' }
const NOTES = 'notes/side-chats.md'

/** What the fake record model answers: an object (node and problem titles are turned into the prompt's numbers), or an error. */
let answer: ((call: ModelCall) => unknown) | Error = () => ({})
const records = () => h!.calls.filter(call => call.purpose === 'learning-sidechat-summary')

function reply(call: ModelCall): string {
  if (call.purpose !== 'learning-sidechat-summary') throw new Error(`unexpected model call: ${call.purpose}`)
  if (answer instanceof Error) throw answer
  return JSON.stringify({ questions: [], conclusions: [], help: [], misconceptions: [], ...answer(call) as object })
}

/** The number the prompt gave a knowledge point, e.g. `N2`. */
const n = (call: ModelCall, title: string) => `N${[...call.prompt.matchAll(/\[N(\d+)\] (.+)/g)].find(match => match[2] === title)?.[1] ?? '?'}`

interface World { readonly courseId: string; readonly pressure: string; readonly buoyancy: string }

async function start(settings: Parameters<typeof createHarness>[1] = {}): Promise<World> {
  answer = () => ({})
  h = createHarness(reply, settings)
  const courseId = (await h.endpoint('core', 'createCourse', { title: '侧边会话 B（合成资料）' })).id as string
  const graph = await h.ctx.learnKnowledge.add(courseId, { nodes: [{ title: '静水压强', kind: 'skill' }, { title: '浮力', kind: 'skill' }] }, teacher)
  return { courseId, pressure: graph.nodes.find(node => node.title === '静水压强')!.id, buoyancy: graph.nodes.find(node => node.title === '浮力')!.id }
}

const open = (courseId: string, selection: Record<string, unknown> = {}) => h!.ctx.learnSidechat.open({ courseId, page: 'textbook.reader', ...selection } as never)

let clock = 0
/** Log one message in the fake session, now (and after the previous one); returns its time. */
function say(sessionId: string, who: 'learner' | 'assistant', text: string): number {
  const events = h!.sessions.get(sessionId)!.events as unknown[]
  clock = Math.max(clock + 1000, Date.now() - 10 * 60_000)
  const content = [{ type: 'text', text }]
  events.push(who === 'assistant'
    ? { type: 'assistant/message', seq: events.length, time: clock, data: { message: { content } } }
    : { type: 'user/message', seq: events.length, time: clock, data: { content, source: { kind: 'user' } } })
  return clock
}

const emit = (name: string, payload: unknown) => (h!.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit(name, payload)
/** The side chat's reply is being written. */
const replying = (sessionId: string) => emit('agent/status', { agent: { session: { id: sessionId } }, status: 'running' })
/** Its reply is done: the agent goes idle. */
async function endTurn(sessionId: string): Promise<void> {
  emit('agent/status', { agent: { session: { id: sessionId } }, status: 'idle' })
  await h!.settle(60)
}

const logged = (courseId: string, type: string) => h!.ctx.learnCore.log.query({ courseId, types: [type as never] }) as unknown as { at: string; nodeIds: string[]; text?: string; level?: string; problemId?: string; context: Record<string, string> }[]
const notes = async (courseId: string) => (await h!.ctx.learnCore.files.read(courseId, NOTES))?.text ?? ''
const count = (text: string, part: string) => text.split(part).length - 1
const summaries = () => (h!.ctx.learnCore.db.sqlite.prepare('SELECT COUNT(*) AS n FROM sidechat_summaries').get() as { n: number }).n

it('logs the help of a reply when the turn ends, so an answer right after counts as helped without closing the chat', async () => {
  const { courseId, pressure } = await start()
  const side = await open(courseId)
  say(side.sessionId, 'learner', '水深加倍，静水压强会怎样？')
  const explained = say(side.sessionId, 'assistant', '静水压强 p = ρgh 和深度成正比：水深加倍，压强也加倍。')
  answer = call => ({
    questions: [{ quote: '水深加倍，静水压强会怎样', text: '水深加倍时静水压强怎样变', nodes: [n(call, '静水压强')] }],
    conclusions: [{ text: '静水压强和深度成正比', from: 2 }],
    help: [{ reply: 2, level: 'explanation', nodes: [n(call, '静水压强')] }],
  })
  await endTurn(side.sessionId)

  expect(logged(courseId, 'help.given')).toMatchObject([{ level: 'explanation', nodeIds: [pressure], at: new Date(explained).toISOString(), context: { sessionId: side.sessionId } }])
  expect(logged(courseId, 'signal.question')).toHaveLength(1)

  // The learner goes straight to a quiz and answers right: helped, though the chat is still open.
  const [problem] = h!.ctx.learnAssess.addProblems([{
    stem: '（合成）水深 2 m，求槽底表压强。', answer: { kind: 'numeric', value: 19.6, unit: 'kPa', tolerance: { absolute: 0.2 } }, answerSource: 'unverified', tier: 4,
    origin: { kind: 'agent' }, nodeIds: [pressure as Id<'node'>], pool: 'practice',
  } as never])
  const quiz = h!.ctx.learnAssess.startTest({ courseId, kind: 'quiz', problemIds: [problem!.id] })
  await h!.ctx.learnAssess.submit(quiz.id, [{ problemId: problem!.id, text: '19.6 kPa' }] as never)
  await h!.settle()
  expect(h!.ctx.learnLearner.states([pressure])[0]?.state).toBe('assisted')
  expect(h!.ctx.learnCore.sessions.get(side.sessionId)?.closedAt).toBeUndefined()

  // Closing finds nothing new to sort and builds the summary from the record.
  const summary = await h!.ctx.learnSidechat.close(side.sessionId)
  expect(records()).toHaveLength(1)
  expect(summary).toMatchObject({ questions: ['水深加倍时静水压强怎样变'], conclusions: ['静水压强和深度成正比'], nodeIds: [pressure], helpGiven: [{ nodeIds: [pressure], level: 'explanation' }], upTo: 1 })
  expect(logged(courseId, 'help.given')).toHaveLength(1)
})

it('keeps only what it can check, and gives a knowledge point one question signal per chat', async () => {
  const { courseId, pressure, buoyancy } = await start()
  const side = await open(courseId)
  const asked = say(side.sessionId, 'learner', '我觉得 浮力 只跟物体的重量有关，和深度无关？')
  say(side.sessionId, 'assistant', '你说过“压强与面积成正比”吗？其实不是。浮力等于排开液体的重量，和物体自身的重量无关。')
  say(side.sessionId, 'learner', '那浮力和深度有关系吗？')
  say(side.sessionId, 'assistant', '完全浸没以后，浮力和深度无关，只看排开液体的体积和密度。')
  answer = call => ({
    questions: [
      { quote: '浮力只跟物体的重量有关，和深度无关', text: '浮力由什么决定', nodes: [n(call, '浮力')] },
      { quote: '那浮力和深度有关系吗', text: '浮力和深度有没有关系', nodes: [n(call, '浮力')] },
      { quote: '压强和密度没有关系吗', text: '压强和密度的关系', nodes: [n(call, '静水压强')] }, // nobody said it
    ],
    conclusions: [{ text: '浮力等于排开液体的重量', from: 2 }, { text: '这条没有出处', from: 9 }],
    help: [
      { reply: 2, level: 'explanation', nodes: [n(call, '浮力')] },
      { reply: 1, level: 'hint', nodes: [n(call, '浮力')] }, // the learner's message, not a reply
      { reply: 4, level: 'hint', nodes: ['N9'] }, // no such knowledge point
    ],
    misconceptions: [
      { quote: '浮力只跟物体的重量有关,和深度无关'.replace(',', '，'), text: '以为浮力只由重量决定', nodes: [n(call, '浮力')] },
      { quote: '压强与面积成正比', text: '以为压强与面积成正比', nodes: [n(call, '静水压强')] }, // the assistant's words
      { quote: '', text: '可能没分清压力和压强', nodes: [n(call, '静水压强')] },
    ],
  })
  await endTurn(side.sessionId)

  expect(logged(courseId, 'help.given').map(entry => [entry.level, entry.nodeIds])).toEqual([['explanation', [buoyancy]]])
  const questions = logged(courseId, 'signal.question')
  expect(questions).toHaveLength(1)
  expect(questions[0]).toMatchObject({ nodeIds: [buoyancy], at: new Date(asked).toISOString() })
  const misconceptions = logged(courseId, 'signal.misconception')
  expect(misconceptions).toHaveLength(1)
  expect(misconceptions[0]).toMatchObject({ nodeIds: [buoyancy], text: '以为浮力只由重量决定（原话："浮力只跟物体的重量有关，和深度无关"）', at: new Date(asked).toISOString() })

  // A later turn asking about the same point again adds no second question signal.
  say(side.sessionId, 'learner', '浮力的方向一定向上吗？')
  say(side.sessionId, 'assistant', '浮力总是竖直向上，因为它来自液体对物体上下表面的压强差。')
  answer = call => ({ questions: [{ quote: '浮力的方向一定向上吗', text: '浮力的方向', nodes: [n(call, '浮力'), n(call, '静水压强')] }] })
  await endTurn(side.sessionId)
  expect(logged(courseId, 'signal.question').map(entry => entry.nodeIds)).toEqual([[buoyancy], [pressure]])

  const summary = await h!.ctx.learnSidechat.close(side.sessionId)
  expect(summary.questions).toEqual(['浮力由什么决定', '浮力和深度有没有关系', '浮力的方向'])
  expect(summary.conclusions).toEqual(['浮力等于排开液体的重量'])
  // A misconception without the learner's words stays in the note as a reference, never as evidence.
  expect(summary.misconceptions).toEqual(['以为浮力只由重量决定', '以为压强与面积成正比', '可能没分清压力和压强'])
  const note = await notes(courseId)
  expect(note).toContain('以为浮力只由重量决定（原话："浮力只跟物体的重量有关，和深度无关"）')
  expect(note).toContain('可能没分清压力和压强（没有找到原话，只作参考）')
})

it('sorts a failed stretch again with the next turn, and after three failures skips it so the chat can still be closed', async () => {
  const { courseId, pressure } = await start()
  const side = await open(courseId)
  say(side.sessionId, 'learner', '静水压强和容器形状有关吗？')
  say(side.sessionId, 'assistant', '无关：同一深度的静水压强只和液体密度、深度有关，和容器的形状无关。')
  answer = new Error('模型不可用')
  await endTurn(side.sessionId)
  expect(logged(courseId, 'signal.question')).toHaveLength(0)

  say(side.sessionId, 'learner', '那连通器里两边液面为什么一样高？')
  say(side.sessionId, 'assistant', '同一种液体静止时，同一水平面上压强相等，所以两边液面一样高。')
  answer = call => ({ questions: [{ quote: '静水压强和容器形状有关吗', text: '和容器形状的关系', nodes: [n(call, '静水压强')] }, { quote: '两边液面为什么一样高', text: '连通器液面', nodes: [] }] })
  await endTurn(side.sessionId)
  expect(records().at(-1)!.prompt).toContain('静水压强和容器形状有关吗')
  expect(records().at(-1)!.prompt).toContain('两边液面为什么一样高')
  expect(logged(courseId, 'signal.question').map(entry => entry.nodeIds)).toEqual([[pressure]])

  // A stretch the model never manages: the turns keep it, closing gives up after the third failure.
  say(side.sessionId, 'learner', '压强的单位是什么？')
  say(side.sessionId, 'assistant', '压强的单位是帕斯卡（Pa），1 Pa = 1 N/m²。')
  answer = new Error('模型不可用')
  await endTurn(side.sessionId)
  await expect(h!.ctx.learnSidechat.close(side.sessionId)).rejects.toThrow('模型不可用')
  expect(h!.ctx.learnCore.sessions.get(side.sessionId)?.closedAt).toBeUndefined()
  const summary = await h!.ctx.learnSidechat.close(side.sessionId)
  expect(summary.questions).toEqual(['和容器形状的关系', '连通器液面'])
  expect(await notes(courseId)).toContain('有一段对话多次整理失败')
  expect(h!.ctx.learnCore.sessions.get(side.sessionId)?.closedAt).toBeTruthy()
})

it('closes once however often it is called, cut at the last message, with a note that shows no internal ids', async () => {
  const { courseId, pressure } = await start()
  const side = await open(courseId, { selected: { kind: 'block', id: 'blk_x', label: '1.1 静水压强 · 第 2 段' } })
  say(side.sessionId, 'learner', '水深加倍压强会怎样？')
  say(side.sessionId, 'assistant', '静水压强和深度成正比，所以也加倍。')
  answer = call => ({
    questions: [{ quote: '水深加倍压强会怎样', text: '水深加倍时压强怎样变', nodes: [n(call, '静水压强')] }],
    conclusions: [{ text: '压强随深度加倍', from: 2 }],
    help: [{ reply: 2, level: 'hint', nodes: [n(call, '静水压强')] }],
  })
  // Never closed between turns: closing sorts the whole chat itself.
  const [first, second] = await Promise.all([h!.ctx.learnSidechat.close(side.sessionId), h!.ctx.learnSidechat.close(side.sessionId)])
  const third = await h!.ctx.learnSidechat.close(side.sessionId)
  expect(second.id).toBe(first.id)
  expect(third.id).toBe(first.id)
  expect(records()).toHaveLength(1)
  expect(summaries()).toBe(1)
  expect(logged(courseId, 'help.given')).toHaveLength(1)
  expect(first.upTo).toBe(1)

  // A reply the agent added after the cut is recorded (help is never lost), but the summary stays as it was.
  say(side.sessionId, 'assistant', '补充一句：表压强不含大气压，绝对压强要在表压强上加上当地的大气压，两者不要混用。')
  answer = call => ({ help: [{ reply: 1, level: 'explanation', nodes: [n(call, '静水压强')] }] })
  await endTurn(side.sessionId)
  expect(logged(courseId, 'help.given')).toHaveLength(2)
  expect((await h!.ctx.learnSidechat.close(side.sessionId)).upTo).toBe(1)

  const note = await notes(courseId)
  expect(count(note, `<!-- side-chat:${side.sessionId} -->`)).toBe(1)
  expect(note).toContain('## ')
  expect(note).toContain('· 1.1 静水压强 · 第 2 段')
  expect(note).toContain('  - 水深加倍时压强怎样变')
  expect(note).toContain('- 得到的帮助：提示（静水压强）')
  // No internal id outside the hidden marker.
  const shown = note.replace(/<!--[\s\S]*?-->/g, '')
  expect(shown).not.toContain(side.sessionId)
  expect(shown).not.toContain(pressure)
  expect(shown).not.toMatch(/blk_|node_|kn_/)
})

it('refuses to close while a reply is being written, and closes once it is done', async () => {
  const { courseId } = await start()
  const side = await open(courseId)
  say(side.sessionId, 'learner', '静水压强是什么？')
  replying(side.sessionId)
  const refused = await h!.call('sidechat', 'close', { sessionId: side.sessionId })
  expect(refused.error?.code).toBe('learning/sidechat/still-answering')
  expect(h!.ctx.learnCore.sessions.get(side.sessionId)?.closedAt).toBeUndefined()

  say(side.sessionId, 'assistant', '静止液体内部的压强，随深度增加。')
  await endTurn(side.sessionId)
  await h!.endpoint('sidechat', 'close', { sessionId: side.sessionId })
  expect(h!.ctx.learnCore.sessions.get(side.sessionId)?.closedAt).toBeTruthy()
})

it('finishes a closing that stopped after the summary was stored, and stores nothing twice when logging failed', async () => {
  const { courseId, pressure } = await start()
  const side = await open(courseId)
  say(side.sessionId, 'learner', '什么是静水压强？')
  say(side.sessionId, 'assistant', '是静止液体内部的压强，大小是 ρgh。')
  answer = call => ({ questions: [{ quote: '什么是静水压强', text: '静水压强是什么', nodes: [n(call, '静水压强')] }], help: [{ reply: 2, level: 'explanation', nodes: [n(call, '静水压强')] }] })
  const heard: string[] = []
  h!.ctx.on('learning/sidechat-summarized', event => { heard.push(event.sessionId) })

  // The evidence of the last stretch cannot be written: nothing of it is kept, and the session stays open.
  vi.spyOn(h!.ctx.learnCore.log, 'append').mockImplementationOnce(() => { throw new Error('日志写入失败') })
  await expect(h!.ctx.learnSidechat.close(side.sessionId)).rejects.toThrow('日志写入失败')
  expect(logged(courseId, 'signal.question')).toHaveLength(0)
  expect(summaries()).toBe(0)

  // Then the session cannot be marked closed.
  vi.spyOn(h!.ctx.learnCore.sessions, 'close').mockImplementationOnce(() => { throw new Error('磁盘暂时不可写') })
  await expect(h!.ctx.learnSidechat.close(side.sessionId)).rejects.toThrow('磁盘暂时不可写')
  expect(heard).toEqual([])

  await h!.ctx.learnSidechat.close(side.sessionId)
  expect(heard).toEqual([side.sessionId])
  expect(h!.ctx.learnCore.sessions.get(side.sessionId)?.closedAt).toBeTruthy()
  expect(summaries()).toBe(1)
  expect(count(await notes(courseId), `<!-- side-chat:${side.sessionId} -->`)).toBe(1)
  expect(logged(courseId, 'signal.question').map(entry => entry.nodeIds)).toEqual([[pressure]])
  expect(logged(courseId, 'help.given')).toHaveLength(1)
  expect(await h!.endpoint('sidechat', 'active', { courseId })).toBeNull()
})

it('does not write a note again whose old marker is already in the file, and writes none for a chat without questions', async () => {
  const { courseId } = await start()
  const side = await open(courseId)
  say(side.sessionId, 'learner', '什么是静水压强？')
  await h!.ctx.learnCore.files.append(courseId, NOTES, `# 侧边会话总结\n\n## 早先的一次\n\n- 会话：${side.sessionId}\n`, teacher)
  const before = await notes(courseId)
  await h!.ctx.learnSidechat.close(side.sessionId)
  expect(await notes(courseId)).toBe(before)

  const quiet = await open(courseId)
  const closed = await h!.ctx.learnSidechat.close(quiet.sessionId)
  expect(closed.questions).toEqual([])
  expect(await notes(courseId)).toBe(before)
  expect(h!.ctx.learnCore.sessions.get(quiet.sessionId)?.closedAt).toBeTruthy()
})

it('lists the selection’s knowledge points first and dates help on an open test’s point against that test', async () => {
  const { courseId, pressure, buoyancy } = await start({ sidechat: { restrictDuringTests: false } })
  const [problem] = h!.ctx.learnAssess.addProblems([{
    stem: '（合成）物体浸没在水中，求浮力。', answer: { kind: 'numeric', value: 9.8, unit: 'N', tolerance: { absolute: 0.1 } }, answerSource: 'unverified', tier: 4,
    origin: { kind: 'agent' }, nodeIds: [buoyancy as Id<'node'>], pool: 'practice',
  } as never])
  const quiz = h!.ctx.learnAssess.startTest({ courseId, kind: 'quiz', problemIds: [problem!.id] })
  const side = await open(courseId, { page: 'knowledge.graph', selected: { kind: 'node', id: buoyancy, label: '浮力' } })
  say(side.sessionId, 'learner', '浮力怎么算？')
  say(side.sessionId, 'assistant', '浮力等于排开液体的重量：F = ρ g V排。')
  answer = call => ({ help: [{ reply: 2, level: 'explanation', nodes: [n(call, '浮力')] }] })
  await endTurn(side.sessionId)

  const prompt = records()[0]!.prompt
  expect(prompt).toContain('学习者从「浮力」打开了这次提问')
  expect(prompt).toContain('[N1] 浮力')
  expect(prompt).toContain('[N2] 静水压强')
  expect(prompt).toContain('[P1] 小测 第 1 题（未交卷）')
  expect(logged(courseId, 'help.given')[0]).toMatchObject({ nodeIds: [buoyancy], context: { sessionId: side.sessionId, testId: quiz.id } })
  expect(pressure).toBeTruthy()
})

it('tells the learner to hand the test in before discussing it, as there is no leaving a test half way', async () => {
  const { courseId, pressure } = await start()
  const side = await open(courseId)
  const [problem] = h!.ctx.learnAssess.addProblems([{
    stem: '（合成）水深 2 m，求槽底表压强。', answer: { kind: 'numeric', value: 19.6, unit: 'kPa', tolerance: { absolute: 0.2 } }, answerSource: 'unverified', tier: 4,
    origin: { kind: 'agent' }, nodeIds: [pressure as Id<'node'>], pool: 'practice',
  } as never])
  h!.ctx.learnAssess.startTest({ courseId, kind: 'quiz', problemIds: [problem!.id] })
  const reason = h!.ctx.learnSidechat.checkTool(side.sessionId, 'search_library').reason ?? ''
  expect(reason).toContain('先交卷')
  expect(reason).not.toContain('离开测试')
  const texts = (await h!.preStep(side.sessionId)).map(message => message.text).join('\n')
  expect(texts).toContain('先交卷')
  expect(texts).not.toContain('离开测试')
})
