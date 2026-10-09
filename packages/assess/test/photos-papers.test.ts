// assess C's pure parts (docs/assess/design.md, C): comparing two readings of a photo answer, reading a
// past paper by its sections and numbers, and assembling and scoring a mock exam by question type.
import { describe, expect, it } from 'vitest'
import type { CitedChunk, Grading, MockPaper, Problem, ProbeNode } from '@learning-agent/contracts'
import { assembleMock, mockReport, mockReportText, typeMatches } from '../src/mock.ts'
import { choiceKey, paperQuestionsOf, paperRefs } from '../src/papers.ts'
import { compareReadings, differencesOf, photoType, plainOf, readingOf } from '../src/reading.ts'

describe('two readings of a photo answer', () => {
  it('marks where the readings differ, with a little context from the first', () => {
    // V9's random error: one reading drops a digit.
    const differences = differencesOf('管路上有 14 只标准 90° 弯头，$h_f = 5.0$ m', '管路上有 1 只标准 90° 弯头，$h_f = 5.0$ m')
    // Shown in plain text: full-width punctuation and `$` are normalised.
    expect(differences).toEqual([{ first: '14', second: '1', before: '管路上有 ', after: ' 只标准 90° 弯头,' }])
    expect(differencesOf('$u = 2$ m/s', '$u=2$ m/s')).toEqual([])
    // Text only in one reading still shows.
    expect(differencesOf('p = 101 kPa', 'p = 101 kPa（表压）').map(item => [item.first, item.second])).toEqual([['', '(表压)']])
  })

  it('compares what the readings say, not how they write it', () => {
    // Two real readings of one synthetic photo wrote units and delimiters differently (3182, 10-09).
    const first = String.raw`解：$d = 50\ \text{mm} = 0.05\ \text{m}$，$u = 2\ \text{m/s}$ $$q_V = (\pi/4)\ d^2\ u$$ $$= 3.39\ \ 3.93 \times 10^{-3}\ \text{m}^3/\text{s}$$`
    const second = String.raw`解：$d = 50\ \mathrm{mm} = 0.05\ \mathrm{m}$, $u = 2\ \mathrm{m/s}$ $q_v = (\pi/4) d^2 u$ $= 3.93 \times 10^{-3}\ \mathrm{m^3/s}$`
    expect(differencesOf(first, second).map(item => [item.first, item.second])).toEqual([['V', 'v'], ['3.39', '']])
    expect(compareReadings({ working: '', finals: ['14.1 m³/h'], doubts: [] }, { working: '', finals: [String.raw`$14.1\ \text{m}^{3}/\text{h}$`], doubts: [] })).toEqual([])
    expect(plainOf(String.raw`$q_V = \frac{\pi}{4} d^2 u = \dfrac{0.1}{\rho g}$`)).toBe('q_V = π/4 d^2 u = 0.1/(ρ g)')
  })

  it('compares the answer boxes too, and shapes the reply to the boxes', () => {
    const first = readingOf({ working: 'u = 2 m/s', finals: ['14.1 m³/h'], doubts: [' 第 2 行的 4 也可能是 9 '] }, 2)
    expect(first).toEqual({ working: 'u = 2 m/s', finals: ['14.1 m³/h', ''], doubts: ['第 2 行的 4 也可能是 9'] })
    const second = readingOf({ working: 'u = 2 m/s', finals: ['19.1 m³/h', ''] }, 2)
    expect(compareReadings(first, second)).toEqual([{ box: 0, first: '14.1 m³/h', second: '19.1 m³/h', before: '', after: '' }])
  })

  it('takes JPG, PNG and WebP by their first bytes, nothing else', () => {
    expect(photoType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(photoType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png')
    expect(photoType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(photoType(new TextEncoder().encode('%PDF-1.7'))).toBeUndefined()
  })
})

const chunk = (index: number, text: string, kind: CitedChunk['kind'] = 'text') => ({ id: `ch_${index}`, sourceId: 'sr_paper', kind, text, section: [], locator: { kind: 'pdf', page: 1 }, citation: '《合成试卷》p.1' }) as unknown as CitedChunk

describe('past papers', () => {
  const paper = [
    '化工原理（合成）期末试卷', '一、填空题（每空 2 分，共 4 分）', '1. 层流时管中心流速是平均流速的____倍。', '2. 离心泵启动前要先____。',
    '二、选择题（每题 3 分）', '1. 层流的雷诺数范围是（ ）。 A. Re<2000 B. Re>4000 C. 2000~4000', '2. 黏度的单位是（ ）。\nA. Pa\nB. Pa·s',
    '三、计算题（共 30 分）', '1.（15 分）水的流速为 2 m/s，管径 50 mm，求体积流量。', '已知条件同上。',
    '参考答案', '一、填空题', '1. 2  2. 灌泵', '二、选择题', '1. A 2. B', '三、计算题', '1. 14.1 m³/h',
  ].map((text, index) => chunk(index, text, index === 1 || index === 4 || index === 7 || index === 10 ? 'heading' : 'text'))

  it('numbers questions by section, with the type, points, options and the key', () => {
    const questions = paperQuestionsOf(paper)
    expect(questions.map(question => question.ref)).toEqual(['一-1', '一-2', '二-1', '二-2', '三-1'])
    expect(questions.map(question => [question.type, question.points ?? null])).toEqual([['填空题', null], ['填空题', null], ['选择题', 3], ['选择题', 3], ['计算题', 15]])
    expect(questions[2]).toMatchObject({ choiceStem: '层流的雷诺数范围是（ ）。', options: ['Re<2000', 'Re>4000', '2000~4000'], printed: 'A' })
    expect(questions[3]!.options).toEqual(['Pa', 'Pa·s'])
    // A continuation line belongs to its question; the key's answers come by the same numbers.
    expect(questions[4]).toMatchObject({ stem: '水的流速为 2 m/s，管径 50 mm，求体积流量。\n已知条件同上。', printed: '14.1 m³/h' })
    expect(questions[1]!.printed).toBe('灌泵')
    expect(paperRefs(questions)).toBe('一-1~一-2、二-1~二-2、三-1')
  })

  it('reads a choice key as option indexes, only when every letter names an option', () => {
    expect(choiceKey('B', ['a', 'b'])).toEqual([1])
    expect(choiceKey('A、C', ['a', 'b', 'c'])).toEqual([0, 2])
    expect(choiceKey('D', ['a', 'b'])).toBeUndefined()
    expect(choiceKey('层流', ['a', 'b'])).toBeUndefined()
  })
})

describe('mock exams', () => {
  const node = (id: string) => ({ id, title: id.replace('kn_', ''), requires: [], also: [] }) as unknown as ProbeNode
  const nodes = [node('kn_静力学'), node('kn_伯努利'), node('kn_管路')]
  let next = 0
  const problem = (nodeIds: string[], extra: Partial<Problem> = {}) => ({
    id: `pb_${String(++next).padStart(2, '0')}`, stem: '（合成）', nodeIds, answer: { kind: 'numeric', value: 1, unit: 'm', tolerance: { relative: 0.02 } }, ...extra,
  }) as unknown as Problem
  const choice: Problem['answer'] = { kind: 'choice', options: ['a', 'b'], correct: [0] }

  it('matches question types by name, or by the answer when a problem has none', () => {
    expect(typeMatches(problem([], { type: '计算题' }), '计算')).toBe(true)
    expect(typeMatches(problem([], { type: '填空题' }), '计算题')).toBe(false)
    expect(typeMatches(problem([]), '计算题')).toBe(true)
    expect(typeMatches(problem([], { answer: choice }), '单项选择题')).toBe(true)
    expect(typeMatches(problem([], { answer: { kind: 'open', rubric: '…' } }), '简答题')).toBe(true)
    // 填空 needs a type of its own.
    expect(typeMatches(problem([], { answer: { kind: 'open', rubric: '…' } }), '填空题')).toBe(false)
  })

  it('fills each section with problems reaching new nodes first, past papers first, and says what is short', () => {
    next = 0
    const fresh = [
      problem(['kn_静力学']), problem(['kn_静力学'], { paper: '合成试卷' }), problem(['kn_伯努利']), problem(['kn_其他']),
      problem(['kn_管路'], { answer: choice, type: '选择题' }),
    ]
    const sections = assembleMock([{ type: '计算题', count: 2, points: 40 }, { type: '选择题', count: 2, points: 10 }], nodes, fresh)
    // The past paper on 静力学 first, then 伯努利 (a new node); the problem outside the exam scope never.
    expect(sections[0]!.problemIds).toEqual(['pb_02', 'pb_03'])
    expect(sections[1]!.problemIds).toEqual(['pb_05'])
  })

  it('scores by section like the real exam, keeps pending ones out of the points and lists the nodes to work on', () => {
    const paper: MockPaper = { nodes, sections: [{ type: '计算题', count: 2, points: 40, problemIds: ['pb_a', 'pb_b'] as never }, { type: '选择题', count: 2, points: 10, problemIds: ['pb_c'] as never }] }
    const problems: Record<string, Problem> = { pb_a: problem(['kn_静力学']), pb_b: problem(['kn_伯努利']), pb_c: problem(['kn_管路']) }
    const gradings: Record<string, Grading> = {
      pb_a: { verdict: 'partial', score: 0.5, method: 'rule', rationale: '' },
      pb_b: { verdict: 'pending-review', score: 0, method: 'llm', rationale: '' },
      pb_c: { verdict: 'correct', score: 1, method: 'rule', rationale: '' },
    }
    const report = mockReport(paper, ['pb_a', 'pb_b', 'pb_c'], id => problems[id], id => gradings[id], 95)
    expect(report.sections).toEqual([
      { type: '计算题', points: 40, earned: 10, problems: [1, 2], pending: 1, short: 0 },
      { type: '选择题', points: 5, earned: 5, problems: [3], pending: 0, short: 1 },
    ])
    expect(report.total).toEqual({ points: 45, earned: 15 })
    expect(report.weak).toEqual([{ nodeId: 'kn_静力学', title: '静力学', problems: [1] }])
    expect(mockReportText(report)).toBe('总分 15/45（计算题 10/40（1 道待复核），选择题 5/5（缺 1 道））；答错或部分对的知识点：静力学（第 1 题）；用时 95 分钟')
  })
})
