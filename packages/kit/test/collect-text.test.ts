import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { collectText } from '../src/collect-text.ts'

async function* stream(...chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  yield* chunks
}

describe('one-shot model replies', () => {
  it('collects visible text without saving reasoning or duplicating complete blocks', async () => {
    const result = await collectText(stream(
      { type: 'reasoning-delta', index: 0, text: 'private reasoning' },
      { type: 'text-delta', index: 1, text: '{"ok":' },
      { type: 'text-delta', index: 1, text: 'true}' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '{"ok":true}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ))
    expect(result).toBe('{"ok":true}')
  })

  it.each(['error', 'aborted'] as const)('rejects terminal %s even after partial text', async kind => {
    await expect(collectText(stream(
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'finish', reason: { kind, failure: { code: 'TRANSPORT', message: '连接失败' } } },
    ))).rejects.toThrow('连接失败')
  })

  it('rejects output exhausted by reasoning', async () => {
    await expect(collectText(stream(
      { type: 'reasoning-delta', index: 0, text: 'thinking' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ))).rejects.toThrow('长度上限')
  })

  it('rejects a stream lost before its terminal result', async () => {
    await expect(collectText(stream({ type: 'text-delta', index: 0, text: 'partial' }))).rejects.toThrow('提前结束')
  })

  it('rejects an empty successful response', async () => {
    await expect(collectText(stream({ type: 'finish', reason: { kind: 'stop' } }))).rejects.toThrow('没有返回正文')
  })

  it('rejects tool calls from a text-only one-shot', async () => {
    await expect(collectText(stream({ type: 'finish', reason: { kind: 'tool-calls' } }))).rejects.toThrow('未完成正文')
  })
})
