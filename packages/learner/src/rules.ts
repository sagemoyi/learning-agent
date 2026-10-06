// Skeleton mastery rules (contracts §4.6). Pure: the same log always gives the same state, so
// changing the rules means recomputing everything (decision #1). Replaced when learner is built out.
import type { LogEntry, MasteryState, NodeState } from '@learning-agent/contracts'

export const RULES_VERSION = 'skeleton-2'

const DAY = 24 * 60 * 60 * 1000
const RETAIN_GAP = 3 * DAY
const REVIEW_AFTER = 14 * DAY
const DOUBT_QUESTIONS = 2
/** A side-chat explanation colours answers on the same node within this window. */
const SIDE_CHAT_WINDOW = DAY

interface Graded {
  readonly entry: LogEntry & { type: 'attempt.graded' }
  readonly correct: boolean
  readonly independent: boolean
  readonly at: number
}

type Help = LogEntry & { type: 'help.given' }

/**
 * Help counts against an attempt when it was given in the same lesson, test or session, or in a side
 * chat shortly before (docs/sidechat/design.md: the answer right after a side-chat explanation counts as assisted).
 */
function helped(attempt: LogEntry & { type: 'attempt.graded' }, helps: readonly Help[]): boolean {
  const context = attempt.context
  return helps.some(help => {
    if (Date.parse(help.at) > Date.parse(attempt.at)) return false
    const same = (key: 'lessonId' | 'testId' | 'sessionId') => context?.[key] !== undefined && help.context?.[key] === context[key]
    const gap = Date.parse(attempt.at) - Date.parse(help.at)
    return same('lessonId') || same('testId') || same('sessionId') || (help.problemId !== undefined && help.problemId === attempt.problemId)
      || (help.via === 'side-chat' && gap <= SIDE_CHAT_WINDOW)
  })
}

function day(at: number): string {
  const date = new Date(at)
  return `${date.getMonth() + 1}-${date.getDate()}`
}

/** Derive one node's state from the log entries that mention it. */
export function deriveState(nodeId: string, entries: readonly LogEntry[], nowMs: number): NodeState {
  const regrades = new Map<string, LogEntry & { type: 'attempt.regraded' }>()
  for (const entry of entries) if (entry.type === 'attempt.regraded') regrades.set(entry.attemptId, entry)
  const helps = entries.filter((entry): entry is Help => entry.type === 'help.given')
  const graded: Graded[] = entries
    .filter((entry): entry is LogEntry & { type: 'attempt.graded' } => entry.type === 'attempt.graded')
    .map(entry => {
      const grading = regrades.get(entry.attemptId)?.grading ?? entry.grading
      return { entry, correct: grading.verdict === 'correct', independent: !helped(entry, helps), at: Date.parse(entry.at), pending: grading.verdict === 'pending-review' }
    })
    .filter(item => !item.pending)
    .sort((a, b) => a.at - b.at)
  const questions = entries.filter(entry => entry.type === 'signal.question').length
  const independents = graded.filter(item => item.independent)
  const independentCorrect = independents.filter(item => item.correct)
  const assistedCorrect = graded.filter(item => !item.independent && item.correct)
  const wrong = graded.filter(item => !item.correct)
  const lastIndependent = independents.at(-1)

  let state: MasteryState
  let reason: string
  if (graded.length === 0) {
    state = 'untested'
    reason = '还没有作答证据'
  } else if (lastIndependent && !lastIndependent.correct && independentCorrect.length > 0) {
    // Right then wrong is a conflict; wrong then right is learning, judged by the latest answer below.
    state = 'conflict'
    reason = '独立答对过，最近一次独立作答又错了，需要再检查一次'
  } else if (independentCorrect.length > 0) {
    const first = independentCorrect[0]!
    const later = independentCorrect.find(item => item.at - first.at >= RETAIN_GAP)
    state = later ? 'retained' : 'independent'
    reason = later ? `隔了 ${Math.round((later.at - first.at) / DAY)} 天仍能独立答对` : '独立答对过'
  } else if (assistedCorrect.length > 0) {
    state = 'assisted'
    reason = '答对时得到过帮助，还需要一次独立完成'
  } else {
    state = 'not-yet'
    reason = '答过但还没答对'
  }

  const counts = [
    independentCorrect.length ? `独立答对 ${independentCorrect.length} 次` : '',
    assistedCorrect.length ? `有帮助答对 ${assistedCorrect.length} 次` : '',
    wrong.length ? `答错 ${wrong.length} 次` : '',
  ].filter(Boolean).join('，')
  const last = graded.at(-1)
  const lastEvidenceAt = last?.entry.at
  return {
    nodeId: nodeId as NodeState['nodeId'],
    state,
    needsReview: (state === 'independent' || state === 'retained') && last !== undefined && nowMs - last.at > REVIEW_AFTER,
    doubtful: questions >= DOUBT_QUESTIONS,
    ...(lastEvidenceAt ? { lastEvidenceAt } : {}),
    explanation: `${reason}${counts ? `（${counts}${last ? `，最近一次 ${day(last.at)}` : ''}）` : ''}。${questions ? `侧边会话或批注里问到过 ${questions} 次。` : ''}`,
    evidence: [...graded.map(item => item.entry.id), ...helps.map(help => help.id)],
    rulesVersion: RULES_VERSION,
    computedAt: new Date(nowMs).toISOString(),
  }
}
