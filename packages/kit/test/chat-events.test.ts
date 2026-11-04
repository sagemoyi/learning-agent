// What the chat shows from a session's events: the same events always give the same list (a window read again after a
// reconnect shows nothing twice), and whether a turn is running comes from the events, not from what the page remembers.
import { expect, it } from 'vitest'
import { attemptText, chunkText, itemsOf, runningOf, turnErrorOf, type SessionEvent } from '../src/client/chat-events.ts'

const user = (seq: number, text: string, source?: string): SessionEvent => ({ seq, type: 'user/message', data: { content: [{ type: 'text', text }], ...(source ? { source: { kind: source } } : {}) } })
const assistant = (seq: number, text: string): SessionEvent => ({ seq, type: 'assistant/message', data: { content: [{ type: 'text', text }] } })
const call = (seq: number, name: string, callId?: string, args?: unknown): SessionEvent => ({ seq, type: 'tool/call', data: { name, ...(callId ? { callId } : {}), ...(args ? { arguments: args } : {}) } })
const result = (seq: number, toolCallId: string, isError = false): SessionEvent => ({ seq, type: 'tool/result', data: { message: { toolCallId, isError } } })
const turn = (seq: number, type: 'turn/start' | 'turn/end', reason?: unknown): SessionEvent => ({ seq, type, ...(reason ? { data: { reason } } : {}) })

it('lists messages, folded context, progress notices, runs of tool calls and successful cards', () => {
  const items = itemsOf([
    user(1, '简报内容', 'learning-course-brief'),
    user(2, '什么是压强？'),
    call(3, 'search_library'), call(4, 'read_section'),
    assistant(5, '压强是单位面积上的力。'),
    user(6, '内部说明\n- 学习者交了小测', 'learning-handoff'),
    call(7, 'offer_goal_options', 'c1', '{"options":[]}'), result(8, 'c1'),
    call(9, 'offer_goal_options', 'c2', '{"options":[]}'), result(10, 'c2', true),
    user(11, '其他来源', 'learning-new-source'),
  ])
  expect(items.map(item => item.role)).toEqual(['context', 'user', 'steps', 'assistant', 'notice', 'steps', 'card', 'steps', 'context'])
  expect(items[2]).toMatchObject({ key: '3', steps: ['查资料库', '读资料原文'] })
  expect(items[4]).toMatchObject({ lines: ['学习者交了小测'] })
  expect(items[6]).toMatchObject({ role: 'card', name: 'offer_goal_options', args: { options: [] } })
  expect(items[8]).toMatchObject({ title: '系统信息' })
})

it('takes running and the last turn\'s failure from the events, so a window read again after a break says the truth', () => {
  expect(runningOf([])).toBe(false)
  expect(runningOf([turn(1, 'turn/start'), assistant(2, '写到一半')])).toBe(true)
  expect(runningOf([turn(1, 'turn/start'), turn(2, 'turn/end')])).toBe(false)
  // A window opening in the middle of a finished turn has its end.
  expect(runningOf([assistant(2, '后半段'), turn(3, 'turn/end')])).toBe(false)

  const failed = turn(2, 'turn/end', { kind: 'error', error: { message: '额度用完了' } })
  expect(turnErrorOf([turn(1, 'turn/start'), failed])).toContain('额度用完了')
  expect(turnErrorOf([turn(1, 'turn/start'), turn(2, 'turn/end', { kind: 'stop' })])).toBeUndefined()
  // A new turn clears it.
  expect(turnErrorOf([failed, turn(3, 'turn/start')])).toBeUndefined()
})

it('reads a live chunk and what a reply had said when the connection came back, without its thinking', () => {
  expect(chunkText({ type: 'text-delta', index: 0, text: '压强' })).toBe('压强')
  expect(chunkText({ type: 'reasoning-delta', index: 0, text: '想一想' })).toBe('')
  expect(chunkText({ type: 'tool-call-delta', index: 0, id: 'x', argumentsDelta: '{}' })).toBe('')
  expect(attemptText([
    { type: 'chunk', time: 0, chunk: { type: 'block-start' } },
    { type: 'reasoning-chunks', index: 0, texts: ['想一想'] },
    { type: 'text-chunks', index: 1, texts: ['压强是', '单位面积'] },
    { type: 'text-chunks', index: 1, texts: ['上的力'] },
  ])).toBe('压强是单位面积上的力')
})
