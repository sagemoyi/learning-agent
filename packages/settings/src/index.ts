// settings unit, host half. The settings page reads and writes through DSH's own settings, credential,
// model and plugin services (docs/settings/research.md); this half only adds what those lack: where the
// learning library lives, a connection test for a model, and the limits a model works under now.
import type { Context } from '@deepseek-ai/cordis'
import { LearningApiError } from '@learning-agent/contracts'
import { complete, defaultModel, routeOf } from '@learning-agent/kit'
import { z } from 'zod'

export const name = 'learning-settings'
export const inject = ['learnCore', 'llm', 'sessionController']

/** Replies that prove the model answered even though they are not usable text. */
const ANSWERED = ['learning/model/truncated', 'learning/model/empty', 'learning/model/incomplete']

export function apply(ctx: Context): void {
  const endpoint = ctx.learnCore.api.endpoint
  ctx.effect(() => endpoint({ unit: 'settings', method: 'about', handle: () => ({ dataRoot: ctx.learnCore.dataRoot }) }), 'settings: about')

  // 测试连接 for a model service: one short request, a few tokens of the learner's quota. Testing the default model
  // sends what its real requests send, thinking effort included.
  ctx.effect(() => endpoint({
    unit: 'settings',
    method: 'testModel',
    input: z.object({ model: z.string().optional() }),
    handle: async ({ model }, signal) => {
      const started = Date.now()
      const asked = routeOf(model)
      const current = await defaultModel(ctx)
      const route = asked && !(asked.provider === current.provider && asked.model === current.model) ? asked : current
      try {
        await complete(ctx, { system: '只回复一个字：好', prompt: '连接测试', purpose: 'learning-settings-test', model: route, maxTokens: 1000, signal })
      } catch (error) {
        if (!(LearningApiError.is(error) && ANSWERED.includes(error.code))) throw error
      }
      return { ms: Date.now() - started }
    },
  }), 'settings: test model')

  // 高级设置 shows what a blank field falls back to: the context window in force, and the output cap when one is
  // configured (DSH's catalog does not carry either to the page).
  ctx.effect(() => endpoint({
    unit: 'settings',
    method: 'modelLimits',
    input: z.object({ provider: z.string(), model: z.string() }),
    handle: async ({ provider, model }) => {
      const info = await ctx.llm.resolveModelInfo?.(provider, model).catch(() => undefined)
      return { contextWindow: info?.context?.contextWindow ?? null, maxTokens: info?.defaultMaxTokens ?? null }
    },
  }), 'settings: model limits')
}
