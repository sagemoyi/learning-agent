import { describe, expect, it } from 'vitest'
import type { CitedChunk } from '@learning-agent/contracts'
import { expandEmbed, isOriginal } from '../src/embed.ts'

let n = 0
const id = () => `ck_01K6PQZRB8M3A4T5V6W7X8Y${String(n++).padStart(3, '0')}`
const chunk = (kind: CitedChunk['kind'], text: string, page = 9): CitedChunk => ({ id: id(), sourceId: 'src_x', kind, text, section: ['1.2 节'], locator: { page, block: 0 }, citation: `《示例》p.${page}` }) as CitedChunk

const heading = chunk('heading', '1.2.1 甲')
const intro = chunk('text', '压强随深度增加。')
const formula = chunk('formula', '$$\np _ {2} = p _ {1} + \\rho g h \\tag{1-8}\n$$')
const figure = chunk('figure', '图1-3 [例1-3]附图')
const example = chunk('example', '[例 1-1] 水深 2 m，求槽底表压。')
const solution = chunk('text', '解 槽底比液面低 2 m。', 10)
const step = chunk('formula', '$$\np = 20 \\mathrm{kPa}\n$$', 10)
const next = chunk('heading', '1.2.2 乙')
const after = chunk('text', '另一小节的话。')
const order = [heading, intro, formula, figure, example, solution, step, next, after]

describe('source text copied in', () => {
  it('quotes a chunk as it is, headed by its citation', () => {
    expect(expandEmbed(formula.id, undefined, { order, extra: [] })).toEqual({
      boxes: [`> [!quote] 原文 · [《示例》p.9](cite:${formula.id})\n> $$\n> p _ {2} = p _ {1} + \\rho g h \\tag{1-8}\n> $$`],
    })
    expect(isOriginal(`> [!quote] 原文 · x\n> y`)).toBe(true)
    expect(isOriginal('> 普通引用')).toBe(false)
  })

  it('draws a figure from its page and keeps its caption', () => {
    expect(expandEmbed(figure.id, undefined, { order, extra: [] })).toEqual({ boxes: [`> [!quote] 原图 · [《示例》p.9](cite:${figure.id})\n> ![图1-3 ［例1-3］附图](cite:${figure.id})`] })
  })

  it('splits a worked example from its solution, which comes folded, citing both pages', () => {
    const result = expandEmbed(example.id, step.id, { order, extra: [] })
    expect(result).toEqual({
      boxes: [
        `> [!quote] 原题 · [《示例》p.9](cite:${example.id})\n> [例 1-1] 水深 2 m，求槽底表压。`,
        `> [!quote]- 原书解答 · [《示例》p.10](cite:${solution.id})\n> 解 槽底比液面低 2 m。\n>\n> $$\n> p = 20 \\mathrm{kPa}\n> $$`,
      ],
    })
    // A solution named on its own is folded too.
    expect(expandEmbed(solution.id, undefined, { order, extra: [] })).toMatchObject({ boxes: [expect.stringMatching(/^> \[!quote\]- 原书解答/)] })
  })

  it('does not copy in prose the explanation retells, except a worked solution', () => {
    expect(expandEmbed(intro.id, undefined, { order, extra: [] })).toEqual({ error: `${intro.id} 是正文段落，讲解里讲过就不再放原文（出处标签能看原文）` })
    expect(expandEmbed(intro.id, formula.id, { order, extra: [] })).toMatchObject({ boxes: [expect.stringContaining('压强随深度增加。')] })
  })

  it('refuses what is not the lesson\'s, a range across a heading, a reversed or too long range', () => {
    const extra = chunk('text', '参考书里的一句。')
    expect(expandEmbed(extra.id, undefined, { order, extra: [extra] })).toMatchObject({ boxes: [expect.stringContaining('参考书里的一句。')] })
    expect(expandEmbed(extra.id, undefined, { order, extra: [] })).toEqual({ error: `${extra.id} 不在本节资料里` })
    expect(expandEmbed(step.id, after.id, { order, extra: [] })).toEqual({ error: `${step.id}..${after.id} 跨了小标题` })
    expect(expandEmbed(step.id, intro.id, { order, extra: [] })).toEqual({ error: `${step.id}..${intro.id} 的顺序反了` })
    const long = Array.from({ length: 14 }, () => chunk('text', '一句。'))
    expect(expandEmbed(long[0]!.id, long.at(-1)!.id, { order: long, extra: [] })).toMatchObject({ error: expect.stringContaining('超过 12 段') })
  })
})
