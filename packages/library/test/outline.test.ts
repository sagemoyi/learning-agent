import { describe, expect, it } from 'vitest'
import { outlineTree } from '../src/client/outline.ts'

const entry = (page: number, ...section: string[]) => ({ section, page, chunkId: `ck_${section.join('/')}` })
const shape = (nodes: ReturnType<typeof outlineTree>): unknown[] => nodes.map(node => (node.children.length ? [node.title, node.page, shape(node.children)] : [node.title, node.page]))

describe('chapter outline', () => {
  it('nests headings by their section paths in reading order', () => {
    const tree = outlineTree([
      entry(1, '第1章 静止流体'),
      entry(1, '第1章 静止流体', '1.2 静止流体的压强'),
      entry(2, '第1章 静止流体', '1.2 静止流体的压强', '1.2.3 静力学基本方程'),
      entry(5, '第1章 静止流体', '习题'),
      entry(6, '第2章 流体流动'),
    ])
    expect(shape(tree)).toEqual([
      ['第1章 静止流体', 1, [['1.2 静止流体的压强', 1, [['1.2.3 静力学基本方程', 2]]], ['习题', 5]]],
      ['第2章 流体流动', 6],
    ])
  })

  it('skips a missing level, keeps the first of the same path, and drops empty headings', () => {
    const tree = outlineTree([
      entry(1, '第1章 静止流体'),
      entry(3, '第1章 静止流体', '1.2 压强', '1.2.3 基本方程'),
      entry(4, '第1章 静止流体', '1.2 压强', '1.2.3 基本方程'),
      entry(4, '第1章 静止流体', '  '),
      entry(7, '附录'),
    ])
    expect(shape(tree)).toEqual([['第1章 静止流体', 1, [['1.2.3 基本方程', 3]]], ['附录', 7]])
  })
})
