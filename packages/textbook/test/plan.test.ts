import { describe, expect, it } from 'vitest'
import type { CitedChunk } from '@learning-agent/contracts'
import { copiesStem, fallbackPoints, outlineOf, readPlan } from '../src/plan.ts'

let n = 0
const chunk = (kind: CitedChunk['kind'], text: string): CitedChunk => ({ id: `ck_01K6PQZRB8M3A4T5V6W7X8Y${String(n++).padStart(3, '0')}`, sourceId: 'src_x', kind, text, section: ['1.2 节'], locator: { page: 1, block: 0 }, citation: '《示例》p.1' }) as CitedChunk

// 1–3: 1.2.1; 4–9: 1.2.2 with a worked example (6) and its solution (7, 8); 10–11: 1.2.3.
const material = [
  chunk('heading', '1.2.1 压强'), chunk('text', '压强指单位面积上的垂直作用力。'), chunk('text', '静止流体中压强各向相同，这一点作为已知结论使用。'),
  chunk('heading', '1.2.2 基本方程'), chunk('formula', '$$p_2 = p_1 + \\rho g h$$'), chunk('example', '例 1-1 水深 2 m，求槽底表压。'),
  chunk('text', '解 槽底比液面低 2 m。'), chunk('formula', '$$p = 20\\,kPa$$'), chunk('text', '基本方程成立需要三个条件：流体静止；两点之间由同一种流体连通；流体密度不随位置变化，缺一不可。'),
  chunk('heading', '1.2.3 等压面'), chunk('text', '同一水平面上压强相等的面叫等压面，列方程时最常用。'),
]
const stems = ['1-6 敞口水槽中水深 3 m，取大气压 100 kPa，求槽底的表压强。']
const ranges = (points: ReturnType<typeof readPlan>) => points!.map(point => [point.title, material.indexOf(point.chunks[0]!) + 1, material.indexOf(point.chunks.at(-1)!) + 1])

describe('the points of a lesson', () => {
  it('outlines the material by number, kind and first words', () => {
    expect(outlineOf(material.slice(0, 2))).toBe('[1] 小标题 · 1.2.1 压强\n[2] 正文 · 压强指单位面积上的垂直作用力。')
  })

  it('covers the material in order: holes go to the point before, overlaps are cut', () => {
    const plan = { points: [{ title: '等压面', from: 10, to: 11 }, { title: '压强', from: 2, to: 3 }, { title: '基本方程', from: 3, to: 5 }] }
    expect(ranges(readPlan(plan, material, stems))).toEqual([['压强', 1, 3], ['基本方程', 4, 9], ['等压面', 10, 11]])
  })

  it('keeps a worked example with its solution, joining a point the solution swallows', () => {
    const plan = { points: [{ title: '压强', from: 1, to: 3 }, { title: '方程和例题', from: 4, to: 6 }, { title: '解答', from: 7, to: 8 }, { title: '条件与等压面', from: 9, to: 11 }] }
    expect(ranges(readPlan(plan, material, stems))).toEqual([['压强', 1, 3], ['方程和例题', 4, 8], ['条件与等压面', 9, 11]])
  })

  it('keeps what the exercises need with the point it belongs to, without words copied from an exercise', () => {
    const plan = {
      points: [{ title: '压强', from: 1, to: 3 }, { title: '基本方程', from: 4, to: 11 }],
      needs: [
        { text: '表压和绝压的换算', point: 2, covered: true },
        { text: '扩大室的作用', point: 2, covered: false },
        { text: '敞口水槽中水深 3 m，取大气压时的表压', point: 2, covered: true },
        { text: '', point: 1 },
      ],
    }
    const points = readPlan(plan, material, stems)!
    expect(points.map(point => point.needs)).toEqual([[], [{ text: '表压和绝压的换算', covered: true }, { text: '扩大室的作用', covered: false }]])
    expect(copiesStem('水深 3 m，取大气压 100 kPa 时', stems)).toBe(true)
    expect(copiesStem('静力学基本方程的适用条件', stems)).toBe(false)
  })

  it('merges the smallest neighbours past 8 points, and splits a point too long for one reply', () => {
    const sizes = [50, 5, 5, 50, 50, 5, 5, 50, 50, 50]
    const short = sizes.map(size => chunk('text', '甲'.repeat(size)))
    const many = readPlan({ points: short.map((_, index) => ({ title: `第${index + 1}点`, from: index + 1, to: index + 1 })) }, short, [])!
    expect(many.map(point => point.title)).toEqual(['第1点', '第2点', '第4点', '第5点', '第6点', '第8点', '第9点', '第10点'])
    expect(many.flatMap(point => point.chunks)).toEqual(short)

    const long = [chunk('heading', '1.2.1 甲'), chunk('text', '甲'.repeat(4000)), chunk('text', '乙'.repeat(4000)), chunk('heading', '1.2.2 乙'), chunk('text', '丙'.repeat(4000)), chunk('text', '丁'.repeat(4000))]
    const parts = readPlan({ points: [{ title: '全节', from: 1, to: 6 }] }, long, [])!
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.map(point => point.title)).toEqual(['全节', ...parts.slice(1).map(() => '全节（续）')])
    expect(parts.flatMap(point => point.chunks)).toEqual(long)
    for (const point of parts) expect(point.chunks.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(12_000)
  })

  it('gives up on a reply without points, and writes by subsection instead', () => {
    expect(readPlan({ points: [] }, material, stems)).toBeUndefined()
    expect(readPlan({ points: [{ title: '', from: 1, to: 3 }] }, material, stems)).toBeUndefined()
    const points = fallbackPoints(material, '1.2 静止流体', 700)
    expect(points.map(point => point.title)).toEqual(['1.2.1 压强', '1.2.2 基本方程', '1.2.3 等压面'])
    expect(points.flatMap(point => point.chunks)).toEqual(material)
  })
})
