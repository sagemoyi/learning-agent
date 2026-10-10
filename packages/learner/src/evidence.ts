// Evidence log entries about one node, in words for the node details. Reads the log, never writes it.
import { REPORT_REASON_LABEL, TEST_KIND_LABEL, type EvidenceRecord, type LogEntry, type TestConditions } from '@learning-agent/contracts'

const VERDICT = {
  correct: { result: '答对', tone: 'ok' },
  partial: { result: '部分正确', tone: 'warn' },
  incorrect: { result: '答错', tone: 'bad' },
  'pending-review': { result: '判分待复核', tone: 'neutral' },
} as const
const HELP = { hint: '提示', explanation: '讲解', 'worked-solution': '完整解法', 'answer-revealed': '答案' } as const
const VIA = { teacher: '主老师', 'side-chat': '侧边提问', 'test-page': '测试页' } as const
const SEEN = { homework: '作业里', practice: '练习里', test: '测试里', textbook: '教材里' } as const

export function conditionsText(conditions: TestConditions): string {
  return [
    conditions.book === 'closed' ? '闭卷' : '开卷',
    conditions.calculator ? '可用计算器' : '不用计算器',
    conditions.formulaSheet ? '有公式表' : '',
    conditions.timeLimit ? `限时 ${conditions.timeLimit} 分钟` : '',
  ].filter(Boolean).join(' · ')
}

function clip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

const VOID_REASON = { 'problem-fixed': '题目改正了', 'problem-retired': '题目停用了', other: '核对后发现有问题' } as const

/** `note` says why an entry the state read does not count (see `ExcludedEvidence`). */
export function describeEvidence(entry: LogEntry, counted: boolean, note?: string): EvidenceRecord {
  const base = { id: entry.id, at: entry.at, courseId: entry.courseId, counted, ...(note ? { note } : {}), ...(entry.context.testId ? { testId: entry.context.testId } : {}) }
  switch (entry.type) {
    case 'attempt.graded':
      return { ...base, what: `${entry.testKind ? TEST_KIND_LABEL[entry.testKind] : '练习'}作答`, ...VERDICT[entry.grading.verdict], ...(entry.conditions ? { conditions: conditionsText(entry.conditions) } : {}) }
    case 'attempt.regraded':
      return { ...base, what: '更正判分', ...VERDICT[entry.grading.verdict], ...(entry.reason ? { conditions: clip(entry.reason) } : {}) }
    case 'attempt.voided':
      return { ...base, what: `作答作废：${VOID_REASON[entry.reason]}`, tone: 'warn', ...(entry.note ? { conditions: clip(entry.note) } : {}) }
    case 'help.given':
      return { ...base, what: `${VIA[entry.via]}给了${HELP[entry.level]}`, tone: 'neutral' }
    case 'signal.question':
      return { ...base, what: `提问：${clip(entry.text)}`, tone: 'neutral' }
    case 'signal.misconception':
      return { ...base, what: `误解：${clip(entry.text)}`, tone: 'warn' }
    case 'signal.self-report':
      return { ...base, what: entry.claim === 'known' ? '自己说会了' : '自己说不会', tone: 'neutral' }
    case 'problem.seen':
      return { ...base, what: `在${SEEN[entry.way]}见过这道题`, tone: 'neutral' }
    case 'problem.reported':
      return { ...base, what: `反馈题目：${REPORT_REASON_LABEL[entry.reason]}`, tone: 'neutral' }
  }
}
