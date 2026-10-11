// sidechat A (docs/sidechat/design.md): limits on the tools (read-only, and only how-to questions while a test is
// open), the open chat's name, creating a chat that fails, and the first-turn context from the persisted record. The
// record, the summary and closing (B) are in sidechat-b.test.ts.
// Real units on the harness; the model, the DSH sessions and their record are fakes.
import { afterEach, expect, it, vi } from 'vitest'
import type { Id } from '@learning-agent/contracts'
import { allowTool } from '../packages/kit/src/index.ts'
import { createHarness, type Harness } from './harness.ts'

let h: Harness | undefined
afterEach(() => { vi.restoreAllMocks(); h?.dispose(); h = undefined })

const teacher = { actor: 'teacher' as const, reason: '侧边会话测试（合成）' }
const T0 = Date.UTC(2026, 9, 9, 2, 0, 0)

const reply = () => JSON.stringify({ questions: [], conclusions: [], help: [], misconceptions: [] })

interface World { readonly courseId: string; readonly pressure: string; readonly buoyancy: string }

async function start(settings: Parameters<typeof createHarness>[1] = {}, options: Parameters<typeof createHarness>[2] = {}): Promise<World> {
  h = createHarness(reply, settings, options)
  const courseId = (await h.endpoint('core', 'createCourse', { title: '侧边会话（合成资料）' })).id as string
  const graph = await h.ctx.learnKnowledge.add(courseId, { nodes: [{ title: '静水压强', kind: 'skill' }, { title: '浮力', kind: 'skill' }] }, teacher)
  return { courseId, pressure: graph.nodes.find(node => node.title === '静水压强')!.id, buoyancy: graph.nodes.find(node => node.title === '浮力')!.id }
}

/** What DSH keeps of a session: its events with their own order and time. */
function record(sessionId: string, turns: readonly { who: 'learner' | 'assistant' | 'context'; text: string; seq: number; minute: number }[]): void {
  const events = h!.sessions.get(sessionId)!.events as unknown[]
  for (const turn of turns) {
    events.push(turn.who === 'assistant'
      ? { type: 'assistant/message', seq: turn.seq, time: T0 + turn.minute * 60_000, data: { message: { content: [{ type: 'text', text: turn.text }] } } }
      : { type: 'user/message', seq: turn.seq, time: T0 + turn.minute * 60_000, data: { content: [{ type: 'text', text: turn.text }], source: { kind: turn.who === 'context' ? 'learning-side-chat-context' : 'user' } } })
  }
}

const open = (courseId: string, selection: Record<string, unknown> = {}) => h!.ctx.learnSidechat.open({ courseId, page: 'textbook.reader', ...selection } as never)

/** A quiz of the course left open, as assess would have it. */
function openTest(courseId: string, nodeId: string) {
  const [problem] = h!.ctx.learnAssess.addProblems([{
    stem: '（合成）水深 2 m，求槽底表压强。', answer: { kind: 'numeric', value: 20, unit: 'kPa', tolerance: { absolute: 0.1 } }, answerSource: 'unverified', tier: 4,
    origin: { kind: 'agent' }, nodeIds: [nodeId as Id<'node'>], pool: 'practice',
  } as never])
  return h!.ctx.learnAssess.startTest({ courseId, kind: 'quiz', problemIds: [problem!.id] })
}

/** The pre-step the agent loop runs before a side chat's first request. */
async function preStep(sessionId: string, step = 1) {
  const decision = await (h!.ctx as unknown as { waterfall(name: string, payload: unknown, last: () => Promise<unknown>): Promise<{ kind: string; messages?: { content: { text: string }[]; source?: { kind: string } }[] }> })
    .waterfall('agent/pre-step', { agent: { session: { id: sessionId } }, messages: [], turn: 1, step, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }))
  return decision.messages ?? []
}

it('names the open chat by what it was opened from, and not by an internal page name when nothing was selected', async () => {
  const { courseId } = await start()
  expect(await h!.endpoint('sidechat', 'active', { courseId })).toBeNull()
  await open(courseId)
  expect(await h!.endpoint('sidechat', 'active', { courseId })).toMatchObject({ label: '' })
  h!.ctx.learnCore.sessions.close((await h!.endpoint<{ sessionId: string }>('sidechat', 'active', { courseId })).sessionId)
  await open(courseId, { selected: { kind: 'block', id: 'aaa111', label: '1.1 静水压强的一段' } })
  expect(await h!.endpoint('sidechat', 'active', { courseId })).toMatchObject({ label: '1.1 静水压强的一段' })
})

it('leaves no chat to go back to when the session could not be created', async () => {
  const { courseId } = await start()
  vi.spyOn(h!.ctx.sessionController, 'create').mockRejectedValueOnce(new Error('DSH 暂时不可用'))
  await expect(open(courseId)).rejects.toThrow('DSH 暂时不可用')
  expect(await h!.endpoint('sidechat', 'active', { courseId })).toBeNull()
  expect(h!.ctx.learnCore.sessions.list({ courseId, role: 'side-chat' }).filter(link => !link.closedAt)).toEqual([])
})

it('holds the tools of a side chat to reading the course library', async () => {
  const { courseId } = await start()
  const side = await open(courseId)
  const main = await h!.ctx.learnTutor.session(courseId)
  const check = (sessionId: string, tool: string) => h!.ctx.learnSidechat.checkTool(sessionId, tool)

  expect(check(side.sessionId, 'search_library').allowed).toBe(true)
  expect(check(side.sessionId, 'read_section').allowed).toBe(true)
  for (const tool of ['search_web', 'add_web_sources', 'import_exercises']) {
    const verdict = check(side.sessionId, tool)
    expect(verdict.allowed, tool).toBe(false)
    expect(verdict.reason).toContain('侧边会话只能查本课资料库')
  }
  // The teacher, and a session nobody registered, are not held.
  expect(check(main, 'add_web_sources').allowed).toBe(true)
  expect(check('not-a-session', 'add_web_sources').allowed).toBe(true)
  // A tool that runs reads the verdict: the reason reaches the model as the tool's error.
  expect(() => allowTool(h!.ctx as never, { agent: { session: { id: side.sessionId } } } as never, 'add_web_sources')).toThrow('侧边会话只能查本课资料库')
  expect(() => allowTool(h!.ctx as never, { agent: { session: { id: main } } } as never, 'add_web_sources')).not.toThrow()
})

it('limits a side chat to how the test works while a test of the course is open', async () => {
  const { courseId, pressure } = await start()
  const side = await open(courseId)
  const other = (await h!.endpoint('core', 'createCourse', { title: '另一门课（合成资料）' })).id as string
  const otherSide = await open(other)
  const main = await h!.ctx.learnTutor.session(courseId)

  const test = openTest(courseId, pressure)
  const verdict = h!.ctx.learnSidechat.checkTool(side.sessionId, 'search_library')
  expect(verdict.allowed).toBe(false)
  expect(verdict.reason).toContain('测试正在进行')
  expect(h!.ctx.learnSidechat.checkTool(side.sessionId, 'read_section').allowed).toBe(false)
  expect(() => allowTool(h!.ctx as never, { agent: { session: { id: side.sessionId } } } as never, 'search_library')).toThrow('测试正在进行')
  // Only this course's chats are held; the teacher is not.
  expect(h!.ctx.learnSidechat.checkTool(otherSide.sessionId, 'search_library').allowed).toBe(true)
  expect(h!.ctx.learnSidechat.checkTool(main, 'search_library').allowed).toBe(true)

  // The chat's first request carries the reminder, and nothing of the problems goes into its context.
  const messages = await preStep(side.sessionId)
  const texts = messages.map(message => message.content.map(part => part.text).join(''))
  expect(texts.some(text => text.includes('【测试进行中】'))).toBe(true)
  expect(texts.join('\n')).not.toContain('表压强')

  // Once the test is handed in the limit is gone.
  await h!.ctx.learnAssess.submit(test.id, [{ problemId: test.problemIds[0]!, text: '20 kPa' }] as never)
  expect(h!.ctx.learnSidechat.checkTool(side.sessionId, 'search_library').allowed).toBe(true)
  expect(h!.ctx.learnSidechat.checkTool(side.sessionId, 'search_web').allowed).toBe(false)
})

it('does not limit the tools during a test when restrictDuringTests is off', async () => {
  const { courseId, pressure } = await start({ sidechat: { restrictDuringTests: false } })
  const side = await open(courseId)
  openTest(courseId, pressure)
  expect(h!.ctx.learnSidechat.checkTool(side.sessionId, 'search_library').allowed).toBe(true)
  const texts = (await preStep(side.sessionId)).map(message => message.content.map(part => part.text).join(''))
  expect(texts.some(text => text.includes('【测试进行中】'))).toBe(false)
  // Read-only still holds.
  expect(h!.ctx.learnSidechat.checkTool(side.sessionId, 'add_web_sources').allowed).toBe(false)
})

it('puts the selection’s context into the first request once, and again only when the record has none', async () => {
  const { courseId } = await start()
  h!.ctx.on('learning/describe-selection', async (selection, next) => [...await next(), ...(selection.page === 'textbook.reader' ? ['【教材】静水压强随深度线性增加。'] : [])])
  const side = await open(courseId, { selected: { kind: 'block', id: 'blk_x', label: '静水压强' } })
  const textsOf = (messages: Awaited<ReturnType<typeof preStep>>) => messages.map(message => message.content.map(part => part.text).join(''))

  const first = await preStep(side.sessionId)
  expect(first.map(message => message.source?.kind)).toEqual(['learning-side-chat-context'])
  expect(textsOf(first)[0]).toContain('静水压强随深度线性增加')
  // Only a turn's first step is touched, and the second turn finds the context already given.
  expect(await preStep(side.sessionId, 2)).toEqual([])
  expect(await preStep(side.sessionId)).toEqual([])
})

it('tries the context again on the next turn when it could not be assembled', async () => {
  const { courseId } = await start()
  let failures = 1
  h!.ctx.on('learning/describe-selection', async (_selection, next) => {
    if (failures-- > 0) throw new Error('教材暂时读不出')
    return [...await next(), '【教材】静水压强随深度线性增加。']
  })
  const side = await open(courseId, { selected: { kind: 'block', id: 'blk_x', label: '静水压强' } })

  // The turn goes on without the context rather than failing the learner's question.
  expect(await preStep(side.sessionId)).toEqual([])
  const again = await preStep(side.sessionId)
  expect(again).toHaveLength(1)
  expect(again[0]!.content[0]!.text).toContain('静水压强随深度线性增加')
})

it('does not give the context again after a restart, because the record already holds it', async () => {
  const { courseId } = await start()
  const side = await open(courseId, { selected: { kind: 'block', id: 'blk_x', label: '静水压强' } })
  expect(await preStep(side.sessionId)).toHaveLength(1)
  const root = h!.root
  h!.dispose(true)

  // A new process on the same data; DSH has the session's record, with the context in it.
  h = createHarness(reply, {}, { root })
  h.sessions.set(side.sessionId, { events: [] })
  record(side.sessionId, [{ who: 'context', text: '【侧边会话上下文】学习者在「静水压强」页面打开了这次提问。', seq: 1, minute: 0 }])
  expect(await preStep(side.sessionId)).toEqual([])

  // A record without it (the first request never completed before the restart) gets the context.
  const bare = await open(courseId, { selected: { kind: 'block', id: 'blk_y', label: '浮力' } })
  const root2 = h.root
  h.dispose(true)
  h = createHarness(reply, {}, { root: root2 })
  h.sessions.set(bare.sessionId, { events: [] })
  expect(await preStep(bare.sessionId)).toHaveLength(1)
})
