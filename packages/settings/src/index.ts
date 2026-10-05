// settings unit, host half. The settings page reads and writes through DSH's own settings, credential,
// model and plugin services (docs/settings/research.md); this half only adds what those lack: where the
// learning library lives, and a connection test for a model.
import type { Context } from '@deepseek-ai/cordis'
import { LearningApiError } from '@learning-agent/contracts'
import { complete } from '@learning-agent/kit'
import { z } from 'zod'

export const name = 'learning-settings'
export const inject = ['learnCore', 'llm', 'sessionController']

/** Replies that prove the model answered even though they are not usable text. */
const ANSWERED = ['learning/model/truncated', 'learning/model/empty', 'learning/model/incomplete']

export function apply(ctx: Context): void {
  const endpoint = ctx.learnCore.api.endpoint
  ctx.effect(() => endpoint({ unit: 'settings', method: 'about', handle: () => ({ dataRoot: ctx.learnCore.dataRoot }) }), 'settings: about')

  // 测试连接 for a model service: one short request, a few tokens of the learner's quota.
  ctx.effect(() => endpoint({
    unit: 'settings',
    method: 'testModel',
    input: z.object({ model: z.string().optional() }),
    handle: async ({ model }, signal) => {
      const started = Date.now()
      try {
        await complete(ctx, { system: '只回复一个字：好', prompt: '连接测试', purpose: 'learning-settings-test', model, maxTokens: 1000, signal })
      } catch (error) {
        if (!(LearningApiError.is(error) && ANSWERED.includes(error.code))) throw error
      }
      return { ms: Date.now() - started }
    },
  }), 'settings: test model')
}
