import { describe, expect, it, vi } from 'vitest'

// kit's index imports DSH runtime helpers that these tests do not need.
vi.mock('@deepseek-ai/dsh-tools', () => ({ defineTool: (definition: unknown) => definition }))
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: (message: unknown) => message }))

const { parseJsonReply } = await import('../src/index.ts')

describe('JSON in model replies', () => {
  it('reads fenced JSON', () => {
    expect(parseJsonReply('好的：\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('keeps LaTeX written with or without doubled backslashes', () => {
    const doubled = String.raw`{"text":"$p=\\rho g h$, $\\mathrm{Pa}$"}`
    const single = String.raw`{"text":"$p=\rho g h$, $\mathrm{Pa}$, $\underline{x}$"}`
    expect(parseJsonReply(doubled)).toEqual({ text: String.raw`$p=\rho g h$, $\mathrm{Pa}$` })
    expect(parseJsonReply(single)).toEqual({ text: String.raw`$p=\rho g h$, $\mathrm{Pa}$, $\underline{x}$` })
  })

  it('keeps real escapes', () => {
    expect(parseJsonReply(String.raw`{"text":"第一行\n第二行 \"引号\" 中"}`)).toEqual({ text: '第一行\n第二行 "引号" 中' })
  })
})
