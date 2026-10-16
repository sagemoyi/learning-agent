import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { complete, defaultModel, routeOf, secret } from '../src/index.ts'
import { roleModel, Schema } from '../src/settings.ts'

/** A context with a fake model that records where each call was routed. */
function withModel(): { ctx: Context; routed: string[] } {
  const ctx = new Context()
  const routed: string[] = []
  ctx.provide('sessionController', { modelCatalog: async () => ({ default: { provider: 'catalog', model: 'default' } }) })
  ctx.provide('llm', {
    async *stream(options: { provider: string; model: string }) {
      routed.push(`${options.provider}/${options.model}`)
      yield { type: 'text-delta', index: 0, text: '好' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  return { ctx, routed }
}

const ask = (ctx: Context, model?: string) => complete(ctx, { system: 's', prompt: 'p', purpose: 'test', ...(model === undefined ? {} : { model }) })

describe('role models', () => {
  afterEach(() => { delete process.env.LEARNING_TEST_KEY })

  it('reads a role setting as provider/model, keeping slashes in the model id', () => {
    expect(routeOf('deepseek-official/deepseek-flash')).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(routeOf('openrouter/anthropic/claude-sonnet-4.5')).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' })
    for (const unusable of [undefined, '', 'no-slash', '/model', 'provider/']) expect(routeOf(unusable)).toBeUndefined()
  })

  it('routes a call to the role model, and a role without one to the default', async () => {
    const { ctx, routed } = withModel()
    await ask(ctx, 'fixture-b/writer')
    await ask(ctx)
    await ask(ctx, 'malformed')
    expect(routed).toEqual(['fixture-b/writer', 'catalog/default', 'catalog/default'])
  })

  it('reads the default model on every call, preferring DSH\'s default-model setting', async () => {
    const { ctx, routed } = withModel()
    let current = { provider: 'deepseek-official', model: 'deepseek-flash' }
    ctx.provide('agentDefaultModel', { currentSelection: () => current })
    await ask(ctx)
    current = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
    await ask(ctx)
    expect(routed).toEqual(['deepseek-official/deepseek-flash', 'deepseek-official/deepseek-v4-pro'])
    expect(await defaultModel(ctx)).toEqual(current)
  })

  it('names the model when a call fails, so the learner knows which setting to change', async () => {
    const ctx = new Context()
    ctx.provide('llm', {
      async *stream(): AsyncIterable<never> { throw new Error('UNKNOWN_MODEL') },
    })
    await expect(ask(ctx, 'gone/model-x')).rejects.toThrow(/UNKNOWN_MODEL.*模型 model-x.*设置 › 模型/)
  })

  it('tries again when the connection to the model drops, but not when the model refuses', async () => {
    const attempts: string[] = []
    const ctx = new Context()
    ctx.provide('llm', {
      async *stream(options: { model: string }) {
        attempts.push(options.model)
        // A relay that drops the stream once (DSH's LlmError carries the class in `code`).
        if (options.model === 'flaky' && attempts.length === 1) throw Object.assign(new Error('DeepSeek Messages transport failed'), { code: 'TRANSPORT' })
        if (options.model === 'refuses') throw Object.assign(new Error('context too long'), { code: 'CONTEXT_WINDOW_EXCEEDED' })
        yield { type: 'text-delta', index: 0, text: '好' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    await expect(ask(ctx, 'relay/flaky')).resolves.toBe('好')
    expect(attempts).toEqual(['flaky', 'flaky'])
    attempts.length = 0
    await expect(ask(ctx, 'relay/refuses')).rejects.toThrow(/context too long/)
    expect(attempts).toEqual(['refuses'])
  }, 10_000)

  it('reads secrets from DSH\'s credential store when it is there, else from the environment', async () => {
    process.env.LEARNING_TEST_KEY = 'from-env'
    const ctx = new Context()
    expect(await secret(ctx, 'LEARNING_TEST_KEY')).toBe('from-env')
    const stored = new Map([['LEARNING_TEST_KEY', 'from-store']])
    ctx.provide('credentials', { resolve: async (name: string) => (stored.has(name) ? { value: stored.get(name)!, source: 'store' } : undefined) })
    expect(await secret(ctx, 'LEARNING_TEST_KEY')).toBe('from-store')
    stored.clear()
    expect(await secret(ctx, 'LEARNING_TEST_KEY')).toBeUndefined()
  })

  it('declares an optional, live role field that a unit without the setting still loads', () => {
    const Config = Schema.object({ model: roleModel('写教材') })
    expect(Config({}).model.get()).toBeUndefined()
    expect(Config({ model: 'deepseek-official/deepseek-v4-pro' }).model.get()).toBe('deepseek-official/deepseek-v4-pro')
    expect(Config.dict!.model!.meta).toMatchObject({ role: 'learning-model', description: '写教材', volatile: true })
  })
})
