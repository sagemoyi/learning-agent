import { describe, expect, it } from 'vitest'
import { withFrontmatter } from '@learning-agent/contracts'
import { finalize, halve, indexBlocks, materialSize, planParts, splitPieces, teachingPartOf } from '../src/format.ts'

const KNOWN = 'ck_01K6PQZRB8M3A4T5V6W7X8Y9Z0'
const UNKNOWN = 'ck_01K6PQZRB8M3A4T5V6W7X8Y9ZZ'

describe('textbook format', () => {
  it('keeps display math whole when splitting', () => {
    expect(splitPieces('a\n\n$$\nx = 1\n\ny = 2\n$$\n\nb')).toEqual(['a', '$$\nx = 1\n\ny = 2\n$$', 'b'])
  })

  it('assigns block ids, checks citations, and flags unsourced prose', () => {
    let n = 0
    const ids = ['aaaaa1', 'bbbbb2', 'ccccc3', 'ddddd4']
    const draft = [
      '```markdown',
      '## 2.1 静止的水',
      '',
      `压强随深度增加。[《示例》p.9](cite:${KNOWN}) ^zzzzzz`,
      '',
      '$$',
      'p = p_0 + \\rho g h',
      '$$',
      '',
      `上式中 h 是深度。[《示例》p.9](cite:${UNKNOWN})`,
      '',
      '这一段没有出处。',
      '```',
    ].join('\n')
    const { body, blocks, dropped } = finalize(draft, { knownChunk: id => id === KNOWN, newBlockId: () => ids[n++]! })
    expect(dropped).toEqual([UNKNOWN])
    expect(body).toBe([
      '## 2.1 静止的水',
      `压强随深度增加。[《示例》p.9](cite:${KNOWN}) ^aaaaa1`,
      '$$\np = p_0 + \\rho g h\n$$\n^bbbbb2',
      '上式中 h 是深度。[待核实](cite:unverified) ^ccccc3',
      '这一段没有出处。 [待核实](cite:unverified) ^ddddd4',
    ].join('\n\n') + '\n')
    expect(blocks.map(block => [block.id, block.citations, block.unverified])).toEqual([
      ['aaaaa1', [KNOWN], false],
      ['bbbbb2', [], false],
      ['ccccc3', [], true],
      ['ddddd4', [], true],
    ])
  })

  it('does not flag recall questions or formula lead-ins as unsourced', () => {
    let n = 0
    const draft = `## 1.1 标题\n\n按下式计算：\n\n$$\np = \\rho g h\n$$\n\n式中 h 是水深。[x](cite:${KNOWN})\n\n### 读完就答\n\n1. 水深加倍会怎样？`
    const { blocks } = finalize(draft, { knownChunk: id => id === KNOWN, newBlockId: () => `qqqqq${n++}` })
    expect(blocks.map(block => block.unverified)).toEqual([false, false, false, false])
    // A lead-in that is not followed by a formula still needs a source.
    expect(finalize('另有一点：', { knownChunk: () => false, newBlockId: () => 'zzzzz9' }).blocks[0]!.unverified).toBe(true)
  })

  it('separates text written right under a heading', () => {
    let n = 0
    const { body, blocks } = finalize('### 读完就答\n1. 甲？\n2. 乙？', { knownChunk: () => false, newBlockId: () => `hhhhh${n++}` })
    expect(body).toBe('### 读完就答\n\n1. 甲？\n2. 乙？ ^hhhhh0\n')
    expect(blocks.map(block => block.unverified)).toEqual([false])
  })

  it('attaches a citation-only line to the list before it', () => {
    let n = 0
    const { body, blocks } = finalize(`- 甲\n- 乙\n\n[x](cite:${KNOWN})。`, { knownChunk: id => id === KNOWN, newBlockId: () => `lllll${n++}` })
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.unverified).toBe(false)
    expect(body).toBe(`- 甲\n- 乙 [x](cite:${KNOWN})。 ^lllll0\n`)
  })

  it('indexes and checks prose under consecutive headings without blank lines', () => {
    const { body, blocks } = finalize('## 1.1 标题\n### 概念\n这一段没有出处。', {
      knownChunk: () => false, newBlockId: () => 'hhhhhh',
    })
    expect(body).toBe('## 1.1 标题\n\n### 概念\n\n这一段没有出处。 [待核实](cite:unverified) ^hhhhhh\n')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.unverified).toBe(true)
  })

  it('splits long material into parts at headings, within the limit', () => {
    const heading = (text: string) => ({ kind: 'heading', text })
    const text = (n: number) => ({ kind: 'text', text: 'x'.repeat(n) })
    // Heading-led runs costing 305, 407, 257 and 87 (each chunk costs its text + 80).
    const chunks = [heading('1.2 节'), text(140), heading('1.2.1 甲'), text(240), heading('1.2.2 乙'), text(90), heading('1.2.3 丙')]
    expect(planParts(chunks, 10_000)).toHaveLength(1)
    const parts = planParts(chunks, 700)
    expect(parts.map(part => part[0]!.text)).toEqual(['1.2 节', '1.2.1 甲', '1.2.3 丙'])
    expect(parts.flat()).toEqual(chunks)
    for (const part of parts) expect(part.reduce((sum, chunk) => sum + materialSize(chunk), 0)).toBeLessThanOrEqual(700)
    // A run larger than the limit is cut between its chunks.
    const long = [heading('1.2 节'), text(300), text(300), text(300)]
    expect(planParts(long, 500).map(part => part.length)).toEqual([2, 1, 1])
  })

  it('halves a part at the heading nearest the middle', () => {
    const part = ['heading', 'text', 'text', 'heading', 'text', 'text', 'text'].map(kind => ({ kind }))
    expect(halve(part).map(half => half.length)).toEqual([3, 4])
    expect(halve([{ kind: 'text' }, { kind: 'text' }]).map(half => half.length)).toEqual([1, 1])
  })

  it('hides the assessment parts of a stage design from the writer', () => {
    const design = [
      '# 阶段设计书',
      '## 1. 阶段验收',
      '能算静水压强。',
      '## 3. 测试蓝图',
      '- 题 1：水深 4 m',
      '### 题型',
      '数值题',
      '## 4. 节点清单',
      '公式、单位。',
    ].join('\n')
    expect(teachingPartOf(design)).toBe('# 阶段设计书\n## 1. 阶段验收\n能算静水压强。\n## 4. 节点清单\n公式、单位。')
  })

  it('indexes a file with frontmatter, including an id line after a table', () => {
    const file = withFrontmatter({ lesson: 'ls_x', version: 1 }, `## 标题\n\n段落 [x](cite:${KNOWN}) ^abc123\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n^def456\n`)
    expect(indexBlocks(file).map(block => block.id)).toEqual(['abc123', 'def456'])
    expect(indexBlocks(file)[1]!.text).toContain('| 1 | 2 |')
  })
})
