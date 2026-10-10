// Mastery rules (contracts §4.6). Pure: the same log and the same `now` always give the same state, so
// changing the rules means recomputing everything (decision #1). Evidence is only ever added to the log, so
// what counts is decided here: one grading per attempt (the end of its correction chain), nothing from a
// voided attempt, help only from before the answer was locked.
import type { CourseState, ExcludedEvidence, LogEntry, MasteryState, NodeState, Verdict } from '@learning-agent/contracts'

/** a-1: complete, valid, replayable evidence (docs/learner/review.md). Bumping it recomputes every state at start-up. */
export const RULES_VERSION = 'a-1'

const DAY = 24 * 60 * 60 * 1000
const RETAIN_GAP = 3 * DAY
const REVIEW_AFTER = 14 * DAY
const DOUBT_QUESTIONS = 2
/** A side-chat explanation colours answers on the same node within this window. */
const SIDE_CHAT_WINDOW = DAY

const REASON = {
  superseded: '原判已被改判替代',
  voided: '题目核对后作废，不计入',
  pending: '判分待复核，暂不计入',
  duplicate: '同一次作答重复记录，只算一次',
  brokenCorrection: '更正找不到它要更正的判分，没有生效',
} as const

type LogId = LogEntry['id']
type Graded = LogEntry & { type: 'attempt.graded' }
type Regraded = LogEntry & { type: 'attempt.regraded' }
type Help = LogEntry & { type: 'help.given' }

/** One answer after the correction chain: the grading that counts, and the log entry it came from. */
interface Attempt {
  readonly entry: Graded
  readonly final: Graded | Regraded
  readonly verdict: Verdict
  readonly correct: boolean
  /** Helps given before the answer was locked; none means independent. */
  readonly helpedBy: readonly Help[]
  readonly at: number
}

/**
 * Help counts against an attempt when it was given before the answer was locked, in the same lesson, test or
 * session, on the same problem, or in a side chat shortly before (docs/sidechat/design.md: the answer right after a
 * side-chat explanation counts as assisted). Help given at or after the lock time never does: the answer was already out.
 */
function helpsFor(attempt: Graded, helps: readonly Help[]): Help[] {
  const context = attempt.context
  const lockedAt = Date.parse(attempt.at)
  return helps.filter(help => {
    const given = Date.parse(help.at)
    if (given > lockedAt) return false
    const same = (key: 'lessonId' | 'testId' | 'sessionId') => context?.[key] !== undefined && help.context?.[key] === context[key]
    return same('lessonId') || same('testId') || same('sessionId') || (help.problemId !== undefined && help.problemId === attempt.problemId)
      || (help.via === 'side-chat' && lockedAt - given <= SIDE_CHAT_WINDOW)
  })
}

function day(at: number): string {
  const date = new Date(at)
  return `${date.getMonth() + 1}-${date.getDate()}`
}

type Derived = Omit<CourseState, 'courseId'>

/**
 * Derive one node's state from the log entries that mention it (a merged identity's entries included),
 * and one state per course from that course's answers. Help counts from anywhere, so splitting by course
 * never turns a helped answer into an independent one.
 */
export function deriveState(nodeId: string, entries: readonly LogEntry[], nowMs: number): NodeState {
  // Log ids count up in the order entries were made (ids.ts), so this is the order the log was written in.
  const ordered = [...new Map(entries.map(entry => [entry.id, entry])).values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const courseIds = [...new Set(ordered.flatMap(entry => (entry.type === 'attempt.graded' && entry.courseId ? [entry.courseId] : [])))]
  const courses = courseIds.map(courseId => ({
    courseId,
    ...derive(ordered.filter(entry => entry.type === 'help.given' || entry.courseId === courseId), nowMs),
  }))
  return { nodeId: nodeId as NodeState['nodeId'], ...derive(ordered, nowMs), rulesVersion: RULES_VERSION, computedAt: new Date(nowMs).toISOString(), courses }
}

/**
 * The answers that count, from entries oldest first: one per `attemptId`; the grading at the end of its correction
 * chain (a regrade counts only when it corrects a grading of that same attempt); no answer a later `attempt.voided`
 * covers. Every entry that is read but does not count comes back with the reason.
 */
function attemptsOf(entries: readonly LogEntry[], helps: readonly Help[]): { attempts: Attempt[]; excluded: ExcludedEvidence[]; applied: LogId[] } {
  const excluded: ExcludedEvidence[] = []
  const applied: LogId[] = []
  const firsts = new Map<string, Graded>()
  // log id → attempt id for every grading entry of a kept attempt: what a correction or a void may point at.
  const chains = new Map<string, Set<LogId>>()
  const finals = new Map<string, Graded | Regraded>()
  const voided = new Set<string>()
  for (const entry of entries) {
    if (entry.type === 'attempt.graded') {
      if (firsts.has(entry.attemptId)) { excluded.push({ id: entry.id, reason: REASON.duplicate }); continue }
      firsts.set(entry.attemptId, entry)
      chains.set(entry.attemptId, new Set([entry.id]))
      finals.set(entry.attemptId, entry)
    } else if (entry.type === 'attempt.regraded') {
      const chain = chains.get(entry.attemptId)
      if (!chain?.has(entry.corrects)) { excluded.push({ id: entry.id, reason: REASON.brokenCorrection }); continue }
      chain.add(entry.id)
      finals.set(entry.attemptId, entry)
    } else if (entry.type === 'attempt.voided') {
      if (!chains.get(entry.attemptId)?.has(entry.voids)) { excluded.push({ id: entry.id, reason: REASON.brokenCorrection }); continue }
      voided.add(entry.attemptId)
      applied.push(entry.id)
    }
  }
  const attempts: Attempt[] = []
  for (const [attemptId, entry] of firsts) {
    const final = finals.get(attemptId)!
    if (voided.has(attemptId)) {
      for (const id of chains.get(attemptId)!) excluded.push({ id, reason: REASON.voided })
      continue
    }
    for (const id of chains.get(attemptId)!) if (id !== final.id) excluded.push({ id, reason: REASON.superseded })
    const verdict = final.grading.verdict
    if (verdict === 'pending-review') { excluded.push({ id: final.id, reason: REASON.pending }); continue }
    attempts.push({ entry, final, verdict, correct: verdict === 'correct', helpedBy: helpsFor(entry, helps), at: Date.parse(entry.at) })
  }
  // Same instant: the log order stands (stable sort over entries already oldest first).
  attempts.sort((a, b) => a.at - b.at)
  return { attempts, excluded, applied }
}

function derive(entries: readonly LogEntry[], nowMs: number): Derived {
  const helps = entries.filter((entry): entry is Help => entry.type === 'help.given')
  const { attempts, excluded, applied } = attemptsOf(entries, helps)
  // The same question delivered twice (a replayed event, a summary written twice) is one question; one with neither a `ref` nor a session cannot be told from a second ask.
  const questions = new Set(entries.flatMap(entry => (entry.type === 'signal.question' ? [entry.ref ?? (entry.context.sessionId ? `${entry.context.sessionId}|${entry.text}` : entry.id)] : []))).size
  const independents = attempts.filter(item => item.helpedBy.length === 0)
  const independentCorrect = independents.filter(item => item.correct)
  const assistedCorrect = attempts.filter(item => item.helpedBy.length > 0 && item.correct)
  const wrong = attempts.filter(item => !item.correct)
  const lastIndependent = independents.at(-1)

  let state: MasteryState
  let reason: string
  if (attempts.length === 0) {
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
  const last = attempts.at(-1)
  const lastEvidenceAt = last?.entry.at
  const skipped = [...excluded.reduce((count, item) => count.set(item.reason, (count.get(item.reason) ?? 0) + 1), new Map<string, number>())]
    .map(([why, number]) => `${why} ${number}`).join('、')
  // What the state stands on: the grading at the end of each answer's chain, the helps that coloured an answer, the voids that applied.
  const cited = new Set<LogId>([...attempts.map(item => item.final.id), ...attempts.flatMap(item => item.helpedBy.map(help => help.id)), ...applied])
  return {
    state,
    needsReview: (state === 'independent' || state === 'retained') && last !== undefined && nowMs - last.at > REVIEW_AFTER,
    doubtful: questions >= DOUBT_QUESTIONS,
    ...(lastEvidenceAt ? { lastEvidenceAt } : {}),
    explanation: `${reason}${counts ? `（${counts}${last ? `，最近一次 ${day(last.at)}` : ''}）` : ''}。${questions ? `侧边会话或批注里问到过 ${questions} 次。` : ''}${skipped ? `另有记录没计入：${skipped}。` : ''}`,
    evidence: [...cited],
    excluded,
  }
}
