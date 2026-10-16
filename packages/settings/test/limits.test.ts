import { describe, expect, it } from 'vitest'
import { currentLimits, effortsOf, formatCapacity, levelsOf, limitOps, parseCapacity, type Where } from '../src/limits.ts'

const FLASH = { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', contextWindow: 1_000_000, inputModalities: ['text', 'image'] }
const PRO = { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000 }

describe('高级设置 of a model', () => {
  it('reads capacities written as a count, K or M, the way DSH\'s own page does', () => {
    expect(parseCapacity('131072')).toBe(131_072)
    expect(parseCapacity(' 128k ')).toBe(128_000)
    expect(parseCapacity('1M')).toBe(1_000_000)
    expect(parseCapacity('1.5M')).toBe(1_500_000)
    expect(parseCapacity('')).toBeUndefined()
    expect(parseCapacity('abc')).toBeNaN()
    expect(parseCapacity('-5')).toBeNaN()
    expect(parseCapacity('0.5')).toBe(0.5)
    for (const value of [1_000_000, 128_000, 131_072, 32_768]) expect(parseCapacity(formatCapacity(value))).toBe(value)
    expect(formatCapacity(256_000)).toBe('256K')
  })

  it('turns ticked thinking levels into DSH\'s reasoningEfforts: names on the wire, 不思考 sends nothing', () => {
    expect(effortsOf(['high', 'off', 'low'])).toEqual({ off: null, low: 'low', high: 'high' })
    expect(Object.keys(effortsOf(['max', 'off', 'medium']) as object)).toEqual(['off', 'medium', 'max'])
    // DSH refuses a list without a level beyond off: that is a model that does not think.
    expect(effortsOf([])).toBe(false)
    expect(effortsOf(['off'])).toBe(false)
    expect(levelsOf({ off: null, high: 'high' })).toEqual(['off', 'high'])
    expect(levelsOf(false)).toEqual([])
  })

  it('writes DeepSeek\'s whole model list, and drops it again once it matches the built-in one', () => {
    const builtIn: Where = { kind: 'deepseek', base: [FLASH, PRO], user: undefined }
    expect(currentLimits(builtIn, 'deepseek-flash')).toEqual({})
    const [set] = limitOps(builtIn, 'deepseek-flash', { contextWindow: 128_000, maxTokens: 32_000 })
    expect(set).toEqual({ op: 'set', path: ['models'], value: [{ ...FLASH, contextWindow: 128_000, maxTokens: 32_000 }, PRO] })

    const edited: Where = { kind: 'deepseek', base: [FLASH, PRO], user: (set as { value: typeof FLASH[] }).value }
    expect(currentLimits(edited, 'deepseek-flash')).toEqual({ contextWindow: 128_000, maxTokens: 32_000 })
    expect(currentLimits(edited, 'deepseek-v4-pro')).toEqual({})
    // A blank context window takes the built-in value back; the other change stays.
    expect(limitOps(edited, 'deepseek-flash', { maxTokens: 32_000 })).toEqual([{ op: 'set', path: ['models'], value: [{ ...FLASH, maxTokens: 32_000 }, PRO] }])
    expect(limitOps(edited, 'deepseek-flash', {})).toEqual([{ op: 'unset', path: ['models'] }])
  })

  it('edits one entry of a declared route\'s list, keeping its other fields and the other models', () => {
    const chat = { id: 'fake-chat', name: 'Fake', input: ['text'], contextWindow: 64_000 }
    const where: Where = { kind: 'list', route: 'my-gateway', models: [chat, { id: 'fake-mini' }] }
    expect(currentLimits(where, 'fake-chat')).toEqual({ contextWindow: 64_000 })
    expect(limitOps(where, 'fake-chat', { contextWindow: 128_000, reasoningEfforts: { high: 'high' } })).toEqual([{
      op: 'set', path: ['providers', 'my-gateway', 'models'],
      value: [{ id: 'fake-chat', name: 'Fake', input: ['text'], contextWindow: 128_000, reasoningEfforts: { high: 'high' } }, { id: 'fake-mini' }],
    }])
    expect(limitOps(where, 'fake-chat', {})).toEqual([{ op: 'set', path: ['providers', 'my-gateway', 'models'], value: [{ id: 'fake-chat', name: 'Fake', input: ['text'] }, { id: 'fake-mini' }] }])
  })

  it('keeps a catalog provider\'s changes as overrides of the one model', () => {
    const where: Where = { kind: 'overrides', route: 'moonshotai-cn', overrides: { 'kimi-k2': { maxTokens: 16_000 } } }
    expect(currentLimits(where, 'kimi-k2')).toEqual({ maxTokens: 16_000 })
    expect(limitOps(where, 'kimi-k2', { maxTokens: 16_000, reasoningEfforts: false })).toEqual([{ op: 'set', path: ['providers', 'moonshotai-cn', 'modelOverrides', 'kimi-k2'], value: { maxTokens: 16_000, reasoningEfforts: false } }])
    expect(limitOps(where, 'kimi-k2', {})).toEqual([{ op: 'unset', path: ['providers', 'moonshotai-cn', 'modelOverrides'] }])
    const two: Where = { ...where, overrides: { 'kimi-k2': { maxTokens: 16_000 }, 'kimi-k1': { contextWindow: 128_000 } } }
    expect(limitOps(two, 'kimi-k2', {})).toEqual([{ op: 'unset', path: ['providers', 'moonshotai-cn', 'modelOverrides', 'kimi-k2'] }])
  })
})
