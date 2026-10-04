import { describe, expect, it } from 'vitest'
import { repairLatexDeep, repairLatexEscapes } from '../src/latex-escapes.ts'

describe('LaTeX escapes in tool arguments', () => {
  it('restores commands that JSON turned into control characters', () => {
    // What a tool receives when the model wrote `$p=\rho g h$` etc. without doubling the backslash.
    const received = '$p=\rho g h$, $\frac{a}{b}$, $a\times b$, $\beta$'
    expect(received).toContain('\r')
    expect(repairLatexEscapes(received)).toBe(String.raw`$p=\rho g h$, $\frac{a}{b}$, $a\times b$, $\beta$`)
  })

  it('treats a line feed as \\n only inside inline math', () => {
    expect(repairLatexEscapes('运动黏度 $\nu=\\mu/\rho$')).toBe(String.raw`运动黏度 $\nu=\mu/\rho$`)
    expect(repairLatexEscapes('第一行\nnext line')).toBe('第一行\nnext line')
  })

  it('leaves correct text alone and walks nested values', () => {
    expect(repairLatexEscapes(String.raw`$p=\rho g h$`)).toBe(String.raw`$p=\rho g h$`)
    expect(repairLatexDeep({ items: ['$\rho$', 3], note: { text: '$\tau$' } })).toEqual({ items: [String.raw`$\rho$`, 3], note: { text: String.raw`$\tau$` } })
  })
})
