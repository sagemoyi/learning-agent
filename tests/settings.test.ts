// Role-model settings across units (docs/settings/research.md): sessions start on their role's model
// and move when that setting, or the default model the role follows, changes; one-shot calls go to
// their role's model.
import { afterEach, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-settings'
import { createHarness, type Harness } from './harness.ts'

let h: Harness | undefined
afterEach(() => h?.dispose())

async function course(harness: Harness): Promise<string> {
  const created = await harness.endpoint<{ id: string }>('core', 'createCourse', { title: '模型设置（合成资料）' })
  await harness.settle()
  return created.id
}

it('starts teacher and side-chat sessions on their role models', async () => {
  h = createHarness(() => '好', { tutor: { model: 'fixture-b/teacher' }, sidechat: { model: 'fixture-b/side' } })
  const courseId = await course(h)
  const { sessionId } = await h.endpoint<{ sessionId: string }>('tutor', 'session', { courseId })
  const side = await h.ctx.learnSidechat.open({ courseId, page: 'home' } as never)
  expect(h.selections).toContainEqual({ sessionId, provider: 'fixture-b', model: 'teacher' })
  expect(h.selections).toContainEqual({ sessionId: side.sessionId, provider: 'fixture-b', model: 'side' })
})

it('leaves sessions of roles that follow the default to DSH, and moves them when the default changes', async () => {
  h = createHarness(() => '好')
  const courseId = await course(h)
  const { sessionId } = await h.endpoint<{ sessionId: string }>('tutor', 'session', { courseId })
  const side = await h.ctx.learnSidechat.open({ courseId, page: 'home' } as never)
  expect(h.selections).toEqual([])

  h.ctx.emit('settings/document-updated', 'llm-pi-ai' as never, 2)
  await h.settle()
  expect(h.selections).toEqual([])

  h.ctx.emit('settings/document-updated', 'agent-default-model' as never, 3)
  await h.settle()
  expect(h.selections).toContainEqual({ sessionId, provider: 'fixture', model: 'fixture' })
  expect(h.selections).toContainEqual({ sessionId: side.sessionId, provider: 'fixture', model: 'fixture' })
})

it('moves the course\'s current teacher session when the 主老师 setting changes', async () => {
  h = createHarness(() => '好', { tutor: { model: 'fixture-b/teacher' } })
  const courseId = await course(h)
  const { sessionId } = await h.endpoint<{ sessionId: string }>('tutor', 'session', { courseId })
  h.selections.length = 0
  h.ctx.emit('settings/document-updated', 'learning-tutor' as never, 4)
  await h.settle()
  expect(h.selections).toEqual([{ sessionId, provider: 'fixture-b', model: 'teacher' }])
})

it('routes the side-chat summary to its own role model', async () => {
  h = createHarness(call => (call.purpose === 'learning-sidechat-summary'
    ? '{"questions":["静水压强怎么算"],"conclusions":[],"nodeIds":[],"misconceptions":[],"help":[]}'
    : '好'), { sidechat: { summaryModel: 'fixture-b/summary' } })
  const courseId = await course(h)
  const side = await h.ctx.learnSidechat.open({ courseId, page: 'home' } as never)
  await h.ctx.sessionController.prompt({ sessionId: side.sessionId, content: [{ type: 'text', text: '静水压强怎么算？' }] } as never, new AbortController().signal)
  await h.ctx.learnSidechat.close(side.sessionId, new AbortController().signal)
  expect(h.calls.find(call => call.purpose === 'learning-sidechat-summary')?.model).toBe('fixture-b/summary')
})
