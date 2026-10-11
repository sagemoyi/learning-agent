// annotation B and C (docs/annotation/design.md): notes on a source's recognized text, picked on the page in the
// reader; "我的理解" checked in a side chat on request, whose possible misconceptions, in the learner's own words,
// become signals; the note then shows what the chat concluded and what later answers say about each misconception.
// Synthetic data; fake model and sessions.
import { afterEach, expect, it, vi } from 'vitest'
import type { Annotation, CitedChunk } from '@learning-agent/contracts'
import type { NoteView } from '../packages/annotation/src/types.ts'
import { createHarness, type Harness, type ModelCall } from './harness.ts'
import { lessonCourse, lessonText } from './lesson-setup.ts'

let h: Harness | undefined
afterEach(() => { h?.dispose(); h = undefined; vi.useRealTimers() })

/** What the side chat's record model answers next. */
let record: (call: ModelCall) => unknown = () => ({})

function reply(call: ModelCall): string {
  const text = lessonText(call)
  if (text) return text
  if (call.purpose === 'learning-sidechat-summary') return JSON.stringify({ questions: [], conclusions: [], help: [], misconceptions: [], ...record(call) as object })
  if (call.purpose === 'learning-tutor-ledger') return JSON.stringify({ help: [] })
  throw new Error(`unexpected model call: ${call.purpose}`)
}

const n = (call: ModelCall, title: string) => `N${[...call.prompt.matchAll(/\[N(\d+)\] (.+)/g)].find(match => match[2] === title)?.[1] ?? '?'}`

it('lists a page’s parsed chunks for the reader, and takes a note on a source chunk to a side chat with the source text', async () => {
  h = createHarness(reply)
  const { ctx, endpoint, call } = h
  const { courseId } = await lessonCourse(h, '批注 B 资料上的批注（合成资料）')
  const source = ctx.learnLibrary.courseSources(courseId)[0]!
  const chunk = ctx.learnLibrary.section(source.sourceId, '1.1').find(item => item.kind === 'text')!

  // The reader picks a chunk by where it is on the page.
  const onPage = await endpoint<CitedChunk[]>('library', 'pageChunks', { sourceId: source.sourceId, page: chunk.locator.page })
  expect(onPage.map(item => item.id)).toContain(chunk.id)
  expect(onPage.every(item => item.locator.page === chunk.locator.page)).toBe(true)
  expect(onPage[0]!.citation).toMatch(/^《合成验收资料》p\./)

  const exact = chunk.text.replace(/\s+/g, ' ').trim().slice(0, 6)
  const note = await endpoint<Annotation>('annotation', 'create', { courseId, type: 'question', text: '这句话里的压强是表压还是绝对压强？', requestId: 'q-src', anchor: { kind: 'chunk', chunkId: chunk.id, quote: { exact, prefix: '', suffix: '' } } })
  const opened = await endpoint<{ sessionId: string; reused: boolean; question: string }>('annotation', 'ask', { annotationId: note.id })
  expect(opened.question).toBe('这句话里的压强是表压还是绝对压强？')
  const context = (await h.preStep(opened.sessionId)).map(message => message.text).join('\n')
  expect(context).toContain('所在资料片段（《合成验收资料》p.')
  expect(context).toContain(exact)
  expect(context).not.toContain('请你看看这条理解')

  // A highlight is not taken to a side chat.
  const highlight = await endpoint<Annotation>('annotation', 'create', { courseId, type: 'highlight', anchor: { kind: 'chunk', chunkId: chunk.id } })
  expect((await call('annotation', 'ask', { annotationId: highlight.id })).error?.code).toBe('learning/annotation/not-askable')
})

it('checks "my understanding" in a side chat on request, and the note follows the misconception it recorded until an answer settles it', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const T0 = new Date(2026, 9, 6, 9, 0).getTime()
  vi.setSystemTime(T0)
  h = createHarness(reply)
  const { ctx, endpoint } = h
  const { courseId, nodeId, lesson, problems } = await lessonCourse(h, '批注 C 我的理解（合成资料）')
  const file = (await ctx.learnCore.files.read(courseId, lesson.textbookFile!))!.text
  const blockId = /计算。.*\^([0-9a-z]{6})/.exec(file)![1]!
  const note = await endpoint<Annotation>('annotation', 'create', {
    courseId, type: 'understanding', text: '水越深压强越大，所以压强只和深度有关，和液体是什么无关。', requestId: 'u-1',
    anchor: { kind: 'block', courseId, blockId, quote: { exact: '静水压强按', prefix: '', suffix: '' } },
  })
  // Writing an understanding is no evidence of anything.
  expect(ctx.learnCore.log.query({ courseId, types: ['signal.misconception', 'signal.question', 'help.given'] })).toEqual([])

  // An hour later, 请老师看看: a side chat whose first message is the learner's understanding, with the feedback rules in its context.
  vi.setSystemTime(T0 + 3_600_000)
  const opened = await endpoint<{ sessionId: string; reused: boolean; question: string }>('annotation', 'ask', { annotationId: note.id })
  expect(opened.question).toBe('我的理解：水越深压强越大，所以压强只和深度有关，和液体是什么无关。\n请帮我看看对不对，还缺什么。')
  const context = (await h.preStep(opened.sessionId)).map(message => message.text).join('\n')
  expect(context).toContain('学习者的批注（我的理解）')
  expect(context).toContain('请你看看这条理解')
  expect(context).toContain('不要打分')
  expect((await endpoint<NoteView[]>('annotation', 'list', { courseId })).find(item => item.id === note.id)).toMatchObject({ chatOpen: true })

  await ctx.sessionController.prompt({ sessionId: opened.sessionId, content: [{ type: 'text', text: opened.question }] } as never, new AbortController().signal)
  record = call => ({
    conclusions: [{ text: '静水压强 p = ρgh，还和液体密度有关', from: 2 }],
    help: [{ reply: 2, level: 'hint', nodes: [n(call, '静水压强计算')] }],
    misconceptions: [{ quote: '和液体是什么无关', text: '以为静水压强和液体密度无关', nodes: [n(call, '静水压强计算')] }],
  })
  ;(ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('agent/status', { agent: { session: { id: opened.sessionId } }, status: 'idle' })
  await h.settle(60)
  const signals = ctx.learnCore.log.query({ courseId, types: ['signal.misconception'] })
  expect(signals).toMatchObject([{ nodeIds: [nodeId], text: '以为静水压强和液体密度无关（原话："和液体是什么无关"）', context: { sessionId: opened.sessionId } }])
  await ctx.learnSidechat.close(opened.sessionId)
  await h.settle()

  const shown = (await endpoint<NoteView[]>('annotation', 'list', { courseId })).find(item => item.id === note.id)!
  expect(shown.chatOpen).toBeUndefined()
  expect(shown.followUp).toMatchObject({ conclusions: ['静水压强 p = ρgh，还和液体密度有关'], misconceptions: ['以为静水压强和液体密度无关'] })
  expect(shown.followUp!.checks).toEqual([{ title: '静水压强计算', settled: false, text: expect.stringContaining('还没确认') }])

  // Two days later the learner answers a new problem alone and right: the note says the misconception is settled.
  vi.setSystemTime(T0 + 2 * 86_400_000)
  const practice = ctx.learnAssess.startTest({ courseId, kind: 'practice', problemIds: [problems[2]!.id] })
  await endpoint('assess', 'submit', { testId: practice.id, answers: [{ problemId: problems[2]!.id, text: '30000 Pa' }] })
  await h.settle()
  const settled = (await endpoint<NoteView[]>('annotation', 'list', { courseId })).find(item => item.id === note.id)!
  expect(settled.followUp!.checks).toEqual([{ title: '静水压强计算', settled: true, text: '10月8日之后独立做对了一道题，这个误解已经弄清了。' }])
})
