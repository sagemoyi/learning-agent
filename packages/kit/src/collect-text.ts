import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { LearningApiError } from '@learning-agent/contracts'

/** A failed or truncated one-shot must never become a saved textbook or grading result. */
export async function collectText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let text = ''
  let finished = false
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type !== 'finish') continue
    finished = true
    const reason = chunk.reason
    if (reason.kind === 'error' || reason.kind === 'aborted') {
      throw new LearningApiError('learning/model/failed', `模型调用失败：${reason.failure.message}`)
    }
    if (reason.kind === 'max-tokens') {
      throw new LearningApiError('learning/model/truncated', '模型输出达到长度上限，回复不完整，请重试或增加输出额度')
    }
    if (reason.kind !== 'stop') {
      throw new LearningApiError('learning/model/incomplete', '模型未完成正文回复，请重试')
    }
  }
  if (!finished) throw new LearningApiError('learning/model/incomplete', '模型连接提前结束，请重试')
  if (!text.trim()) throw new LearningApiError('learning/model/empty', '模型没有返回正文，请重试')
  return text
}
