// Course reports (docs/curriculum/design.md, 结课): per goal "can do" item, what the final check showed,
// what the mastery states back it with, and what evidence is still missing. Pure; tools.ts gathers the inputs.
import type { CarriedNode, CourseReportFacts, FinalReport, MasteryState, ReportItem, Stage } from '@learning-agent/contracts'
import { STATE_WORD } from './review.ts'

const ON_OWN: readonly MasteryState[] = ['independent', 'retained']

export interface ReportSources {
  readonly items: readonly { readonly key: string; readonly text: string }[]
  readonly stages: readonly Stage[]
  readonly titles: ReadonlyMap<string, string>
  readonly states: ReadonlyMap<string, MasteryState>
  readonly final?: FinalReport
  readonly carried: readonly CarriedNode[]
}

/**
 * done: its final problems all right and each of its nodes done on the learner's own; gaps: right, but some
 * node only with help or never on its own; not-done: wrong or partly right; unchecked: no final problem.
 */
export function reportFacts(sources: ReportSources): CourseReportFacts {
  const items: ReportItem[] = sources.items.map(item => {
    const stages = sources.stages.filter(stage => stage.supports.includes(item.key))
    const nodes = [...new Set(stages.flatMap(stage => stage.nodeIds as string[]))].map(id => ({ title: sources.titles.get(id) ?? id, state: sources.states.get(id) ?? 'untested' as const }))
    const final = sources.final?.items.find(entry => entry.key === item.key)
    const missing = nodes.filter(node => !ON_OWN.includes(node.state)).map(node => node.title)
    const status = !final || final.outcome === 'insufficient' ? 'unchecked'
      : final.outcome === 'pass' ? (missing.length ? 'gaps' : 'done')
        : 'not-done'
    return { key: item.key, text: item.text, status, stages: stages.map(stage => stage.title), nodes, missing, ...(final ? { problems: [...final.problems] } : {}) }
  })
  return {
    items,
    risks: sources.carried.map(item => ({ title: item.title, kind: item.kind, state: sources.states.get(item.nodeId) ?? 'untested' })),
    stages: sources.stages.filter(stage => stage.kind === 'normal').length,
    remedial: sources.stages.filter(stage => stage.kind === 'remedial').length,
  }
}

export const REPORT_STATUS_WORD: Record<ReportItem['status'], string> = { done: '做到了', gaps: '做到了，还缺证据', 'not-done': '还没做到', unchecked: '没测到' }

/** The table at the top of `report.md`: one row per goal item. */
export function reportTable(facts: CourseReportFacts): string {
  const rows = facts.items.map(item => {
    const basis = [
      item.problems?.length ? `结课检验第 ${item.problems.join('、')} 题` : '',
      item.nodes.length ? item.nodes.map(node => `${node.title}${STATE_WORD[node.state]}`).join('，') : '没有对应阶段',
    ].filter(Boolean).join('；')
    return `| ${item.text} | ${REPORT_STATUS_WORD[item.status]} | ${basis} | ${item.missing.length ? `${item.missing.join('、')}还要独立做对` : '—'} |`
  })
  return ['| 能做 | 结果 | 依据 | 还缺 |', '| --- | --- | --- | --- |', ...rows].join('\n')
}

/** The facts for the teacher's brief, in words. */
export function reportFactsText(facts: CourseReportFacts): string {
  return [
    `共 ${facts.stages} 个阶段${facts.remedial ? `，补课 ${facts.remedial} 次` : ''}。按目标的每条"能做"：`,
    ...facts.items.map(item => `- ${item.key} ${item.text}：${REPORT_STATUS_WORD[item.status]}${item.problems?.length ? `（结课检验第 ${item.problems.join('、')} 题）` : ''}。相关知识点：${item.nodes.map(node => `${node.title}（${STATE_WORD[node.state]}）`).join('、') || '没有对应阶段'}`),
    ...(facts.risks.length ? [`以前复盘带过来、还没独立做对的：${facts.risks.map(risk => `${risk.title}（${risk.kind === 'risk' ? '风险' : '待验证'}，${STATE_WORD[risk.state]}）`).join('、')}`] : []),
    '用 save_course_report 写课程报告：程序会把上面的表放在开头；正文写给学习者：学会了什么、还要注意什么、以后怎么复查。写好后课程标为"已结课"。',
  ].join('\n')
}
