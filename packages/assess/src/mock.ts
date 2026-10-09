// Mock exams (docs/assess/design.md, C): assembled from new reserved problems by the exam's question
// types, scored like the real exam, section by section. Pure functions: the store feeds them problems.
import type { Grading, MockPaper, MockReport, MockSection, Problem, ProbeNode } from '@learning-agent/contracts'
import { answerParts } from './grading.ts'
import { covers } from './stage.ts'

const normal = (type: string) => type.replace(/\s+/g, '').replace(/题$/, '')

/** Problems without a type of their own count as the types their answers suggest. */
const BY_ANSWER: readonly [RegExp, (problem: Pick<Problem, 'answer'>) => boolean][] = [
  [/选择/, problem => problem.answer.kind === 'choice'],
  [/计算|综合|应用/, problem => answerParts(problem.answer).some(part => part.answer.kind === 'numeric')],
  [/简答|问答|论述|分析|说明|名词解释/, problem => problem.answer.kind === 'open'],
]

/** Whether a problem can stand for a question type of the exam. */
export function typeMatches(problem: Pick<Problem, 'answer' | 'type'>, type: string): boolean {
  if (problem.type) return normal(problem.type) === normal(type)
  return BY_ANSWER.some(([pattern, fits]) => pattern.test(type) && fits(problem))
}

/**
 * Each section's problems: of its type, in the exam's scope (any node when the scope is empty), the one
 * reaching most scope nodes not yet covered first, then past-paper problems, then those typed as such.
 */
export function assembleMock(sections: readonly MockSection[], nodes: readonly ProbeNode[], fresh: readonly Problem[]): MockPaper['sections'] {
  const used = new Set<string>()
  const covered = new Set<string>()
  const inScope = (problem: Problem) => nodes.length === 0 || nodes.some(node => covers(problem, node))
  const gain = (problem: Problem) => nodes.filter(node => !covered.has(node.id) && covers(problem, node)).length
  return sections.map(section => {
    const picked: string[] = []
    while (picked.length < section.count) {
      const best = fresh.filter(problem => !used.has(problem.id) && inScope(problem) && typeMatches(problem, section.type))
        .sort((a, b) => gain(b) - gain(a) || Number(Boolean(b.paper)) - Number(Boolean(a.paper)) || Number(Boolean(b.type)) - Number(Boolean(a.type)) || a.id.localeCompare(b.id))[0]
      if (!best) break
      used.add(best.id)
      for (const node of nodes) if (covers(best, node)) covered.add(node.id)
      picked.push(best.id)
    }
    return { type: section.type, ...(section.points !== undefined ? { points: section.points } : {}), count: section.count, problemIds: picked as MockPaper['sections'][number]['problemIds'] }
  })
}

const round = (value: number) => Math.round(value * 10) / 10

/** Points per section and in total (pending gradings not yet counted), the nodes answered wrong, the time used. */
export function mockReport(paper: MockPaper, problemIds: readonly string[], problemOf: (id: string) => Problem | undefined, gradingOf: (id: string) => Grading | undefined, minutes?: number): MockReport {
  const weak = new Map<string, number[]>()
  const sections = paper.sections.map(section => {
    const each = section.points !== undefined ? section.points / section.count : 1
    let earned = 0
    let pending = 0
    const numbers: number[] = []
    for (const id of section.problemIds) {
      const number = problemIds.indexOf(id) + 1
      if (number === 0) continue
      numbers.push(number)
      const grading = gradingOf(id)
      if (!grading || grading.verdict === 'pending-review') {
        pending += 1
        continue
      }
      earned += each * (grading.score ?? (grading.verdict === 'correct' ? 1 : 0))
      if (grading.verdict !== 'correct') {
        const problem = problemOf(id)
        for (const node of paper.nodes) if (problem && covers(problem, node)) weak.set(node.id, [...(weak.get(node.id) ?? []), number])
      }
    }
    return { type: section.type, points: round(each * numbers.length), earned: round(earned), problems: numbers, pending, short: section.count - section.problemIds.length }
  })
  return {
    sections,
    total: { points: round(sections.reduce((sum, section) => sum + section.points, 0)), earned: round(sections.reduce((sum, section) => sum + section.earned, 0)) },
    weak: paper.nodes.filter(node => weak.has(node.id)).map(node => ({ nodeId: node.id, title: node.title, problems: weak.get(node.id)!.sort((a, b) => a - b) })),
    ...(minutes !== undefined ? { minutes } : {}),
  }
}

/** The result in words, for the teacher. */
export function mockReportText(report: MockReport): string {
  const sections = report.sections.map(section => `${section.type} ${section.earned}/${section.points}${section.pending ? `（${section.pending} 道待复核）` : ''}${section.short ? `（缺 ${section.short} 道）` : ''}`)
  const weak = report.weak.length ? `；答错或部分对的知识点：${report.weak.map(node => `${node.title}（第 ${node.problems.join('、')} 题）`).join('、')}` : ''
  return `总分 ${report.total.earned}/${report.total.points}（${sections.join('，')}）${weak}${report.minutes !== undefined ? `；用时 ${report.minutes} 分钟` : ''}`
}
