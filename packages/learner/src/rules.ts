// Mastery rules (docs/learner/design.md). Pure: the same log entries at the same moment always give the same
// state, so changing the rules means recomputing everything (decision #1). No model is asked anything here.
//
// judge() reads each answer once: its last valid regrade, whether the problem was later found wrong, whether
// help came before it was handed in, whether the problem asks about this node only, whether it was new to the
// learner. derive() turns the judged answers of one scope (all courses, or one course) into a state and its
// reasons; help, signals and earlier practice count from every course.
import type { CourseState, Grading, LogEntry, MasteryState, NodeState } from '@learning-agent/contracts'

/**
 * rules-1: the deepened rules (help by problem, test or a day; delayed checks on new problems; telling failures).
 * Any change to what the rules decide needs a new version: stored states are derived again on start only when it differs.
 */
export const RULES_VERSION = 'rules-1'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** A delayed check counts this long after the node was last practised or explained. */
export const RETAIN_GAP = 3 * DAY
/** An independent success older than this asks for a review. */
export const REVIEW_AFTER = 14 * DAY
/** Help on the node counts against the answers handed in within this time after it. */
export const HELP_WINDOW = DAY
const DOUBT_QUESTIONS = 2

type Attempt = LogEntry & { type: 'attempt.graded' }
type Regrade = LogEntry & { type: 'attempt.regraded' }
type Help = LogEntry & { type: 'help.given' }
type Reviewed = LogEntry & { type: 'problem.reviewed' }
type Signal = LogEntry & { type: 'signal.question' | 'signal.misconception' }

export interface Judged {
  readonly entry: Attempt
  /** When the answer was handed in. */
  readonly at: number
  /** The grading that stands: the last valid regrade, else the first grading. */
  readonly grading: Grading
  readonly regrade?: Regrade
  /** `pending`: waiting for review; `void`: the problem was later found wrong. */
  readonly status: 'counted' | 'pending' | 'void'
  readonly voidedBy?: Reviewed
  /** Help given before the answer was handed in: on this problem, during this test, or on the node shortly before. */
  readonly help?: { readonly entry: Help; readonly why: 'problem' | 'test' | 'recent' }
  /** The problem asks about this node only, so a wrong answer says something about it. */
  readonly direct: boolean
  /** The learner had not answered or seen the problem before. */
  readonly fresh: boolean
  readonly correct: boolean
}

const time = (entry: LogEntry) => Date.parse(entry.at)
const order = (a: LogEntry, b: LogEntry) => time(a) - time(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Every answer in `entries` once, oldest first. `current` maps a node to the identity it was merged into, so a
 * problem tagged with two merged nodes still asks about one.
 */
export function judge(entries: readonly LogEntry[], current: (nodeId: string) => string = id => id): Judged[] {
  const sorted = [...entries].sort(order)
  const firsts = new Map<string, Attempt>()
  const corrections = new Map<string, Regrade>()
  const reviews: Reviewed[] = []
  const helps: Help[] = []
  const met = new Map<string, number[]>()
  for (const entry of sorted) {
    if (entry.type === 'attempt.graded' && !firsts.has(entry.attemptId)) firsts.set(entry.attemptId, entry)
    // A later correction of the same entry wins; assess always corrects the latest grading.
    else if (entry.type === 'attempt.regraded') corrections.set(entry.corrects, entry)
    else if (entry.type === 'problem.reviewed' && entry.outcome !== 'keep') reviews.push(entry)
    else if (entry.type === 'help.given') helps.push(entry)
    if ((entry.type === 'attempt.graded' || entry.type === 'problem.seen') && entry.problemId) met.set(entry.problemId, [...(met.get(entry.problemId) ?? []), time(entry)])
  }
  return [...firsts.values()].map(entry => {
    const at = time(entry)
    let regrade: Regrade | undefined
    for (let next = corrections.get(entry.id), steps = 0; next && next.attemptId === entry.attemptId && steps < 100; next = corrections.get(next.id), steps += 1) regrade = next
    const grading = regrade?.grading ?? entry.grading
    const voidedBy = reviews.find(review => review.problemId === entry.problemId && time(review) > at)
    const before = helps.filter(help => time(help) <= at)
    const pick = (why: 'problem' | 'test' | 'recent', test: (help: Help) => boolean) => {
      const help = before.filter(test).at(-1)
      return help ? { entry: help, why } : undefined
    }
    const help = pick('problem', item => item.problemId === entry.problemId)
      ?? pick('test', item => item.context.testId !== undefined && item.context.testId === entry.context.testId)
      ?? pick('recent', item => at - time(item) <= HELP_WINDOW)
    return {
      entry,
      at,
      grading,
      ...(regrade ? { regrade } : {}),
      status: voidedBy ? 'void' : grading.verdict === 'pending-review' ? 'pending' : 'counted',
      ...(voidedBy ? { voidedBy } : {}),
      ...(help ? { help } : {}),
      direct: new Set(entry.nodeIds.map(current)).size === 1,
      fresh: !(met.get(entry.problemId) ?? []).some(seen => seen < at),
      correct: grading.verdict === 'correct',
    } satisfies Judged
  })
}

/** What every scope of a node shares: when it was last practised or explained, and what was asked about it. */
interface Facts {
  /** Times of every answer (any course, any grading) and every help on the node, oldest first. */
  readonly contact: readonly number[]
  readonly signals: readonly Signal[]
}

type Derived = Omit<CourseState, 'courseId'>

/**
 * Derive one node's state from the log entries that mention it (a merged identity's entries included), and one
 * state per course from that course's answers. Help, earlier practice and signals count from anywhere, so
 * splitting by course never turns a helped answer into an independent one.
 */
export function deriveState(nodeId: string, entries: readonly LogEntry[], nowMs: number, current?: (nodeId: string) => string): NodeState {
  const judged = judge(entries, current)
  const facts: Facts = {
    contact: [...judged.map(item => item.at), ...entries.filter(entry => entry.type === 'help.given').map(time)].sort((a, b) => a - b),
    signals: entries.filter((entry): entry is Signal => entry.type === 'signal.question' || entry.type === 'signal.misconception'),
  }
  const courseIds = [...new Set(judged.flatMap(item => (item.entry.courseId ? [item.entry.courseId] : [])))]
  const courses = courseIds.map(courseId => ({ courseId, ...derive(judged.filter(item => item.entry.courseId === courseId), facts, nowMs) }))
  return { nodeId: nodeId as NodeState['nodeId'], ...derive(judged, facts, nowMs), rulesVersion: RULES_VERSION, computedAt: new Date(nowMs).toISOString(), courses }
}

/** 待复查: the latest independent success is old. Worked out when read, as time passing writes nothing. */
export function reviewDue(state: Pick<CourseState, 'state' | 'lastIndependentAt'>, nowMs: number): boolean {
  return (state.state === 'independent' || state.state === 'retained') && state.lastIndependentAt !== undefined && nowMs - Date.parse(state.lastIndependentAt) > REVIEW_AFTER
}

export function dayText(at: number): string {
  const date = new Date(at)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

const HELP_WORDS = { hint: '提示', explanation: '讲解', 'worked-solution': '完整解法', 'answer-revealed': '答案' } as const
const VIA_WORDS = { teacher: '主老师', 'side-chat': '侧边提问', 'test-page': '测试页' } as const

/** Why an answer is not independent, in the learner's words. */
export function helpText(help: NonNullable<Judged['help']>, at: number): string {
  const via = VIA_WORDS[help.entry.via], level = HELP_WORDS[help.entry.level]
  if (help.why === 'problem') return `答题前看过${via}针对这道题的${level}`
  if (help.why === 'test') return `测试进行中得到过${via}的${level}`
  const hours = Math.max(1, Math.ceil((at - time(help.entry)) / HOUR))
  return `答题前 ${hours} 小时内得到过${via}关于这个知识点的${level}`
}

function derive(judged: readonly Judged[], facts: Facts, nowMs: number): Derived {
  const counted = judged.filter(item => item.status === 'counted')
  const pending = judged.filter(item => item.status === 'pending').length
  const voided = judged.filter(item => item.status === 'void').length
  const independent = counted.filter(item => !item.help)
  const successes = independent.filter(item => item.correct)
  // Answers that can contradict a success: successes, and wrong answers to problems on this node only. Answers
  // handed in together are one sitting (the same time): their order within it says nothing.
  const telling = independent.filter(item => item.correct || item.direct)
  const failedAt = telling.filter(item => !item.correct).at(-1)?.at
  const lastContactBefore = (at: number) => facts.contact.filter(contact => contact < at).at(-1)

  let state: MasteryState
  let head: string
  let decisive: readonly Judged[] = []
  if (counted.length === 0) {
    state = 'untested'
    head = judged.length ? '还没有能用的作答' : '还没有作答证据'
  } else if (failedAt !== undefined && failedAt === telling.at(-1)!.at && successes.length) {
    state = 'conflict'
    const success = successes.at(-1)!
    const failure = telling.filter(item => !item.correct && item.at === failedAt).at(-1)!
    decisive = [success, failure]
    const wrong = failure.grading.verdict === 'partial' ? '只做对了一部分' : '做错了'
    head = success.at === failedAt ? `${dayText(failedAt)}同一次作答里，一道题独立答对，一道只考这个点的题${wrong}`
      : dayText(success.at) === dayText(failedAt) ? `${dayText(failedAt)}先独立答对过，之后一道只考这个点的题又独立${wrong}`
        : `${dayText(success.at)}独立答对过，${dayText(failedAt)}一道只考这个点的题又独立${wrong}`
  } else if (successes.length) {
    // The chain since the latest telling failure: recovering proves recovery first, a delayed check comes after.
    const chain = telling.filter(item => failedAt === undefined || item.at > failedAt)
    const recovered = failedAt !== undefined
    let delayed: { item: Judged; gap: number } | undefined
    for (let i = chain.length - 1; i >= 1 && !delayed; i -= 1) {
      const item = chain[i]!
      if (!item.fresh || !chain.some(other => other.at < item.at)) continue
      const gap = item.at - (lastContactBefore(item.at) ?? item.at)
      if (gap >= RETAIN_GAP) delayed = { item, gap }
    }
    state = delayed ? 'retained' : 'independent'
    decisive = chain
    head = delayed ? `隔了 ${Math.floor(delayed.gap / DAY)} 天，${dayText(delayed.item.at)}独立做对了一道没做过的题`
      : recovered ? '做错以后又独立做对了' : '独立答对过'
  } else if (counted.some(item => item.correct)) {
    state = 'assisted'
    decisive = counted.filter(item => item.correct)
    const kinds = [...new Set(decisive.map(item => `${VIA_WORDS[item.help!.entry.via]}的${HELP_WORDS[item.help!.entry.level]}`))]
    head = `答对过，但答题前都得到过帮助（${kinds.join('、')}）`
  } else {
    state = 'not-yet'
    decisive = counted
    head = '答过，还没有答对'
  }

  const lastSuccess = successes.at(-1)
  const assistedCorrect = counted.filter(item => item.help && item.correct).length
  const wrong = counted.filter(item => !item.correct).length
  const last = counted.at(-1)
  const counts = [
    successes.length ? `独立答对 ${successes.length} 次` : '',
    assistedCorrect ? `有帮助答对 ${assistedCorrect} 次` : '',
    wrong ? `答错 ${wrong} 次` : '',
  ].filter(Boolean).join('，')

  const notes: string[] = []
  if (state === 'independent' || state === 'retained') {
    const words = new Set<string>()
    if (decisive.every(item => item.entry.conditions?.book === 'open')) words.add('开卷')
    if (decisive.every(item => item.entry.conditions?.formulaSheet)) words.add('带公式表')
    if (words.size) notes.push(`这些都是${[...words].join('、')}作答。`)
  }
  // A wrong answer to a problem on several nodes cannot say which of them went wrong.
  const mixed = counted.filter(item => !item.correct && !item.direct && !item.help && (!lastSuccess || item.at >= lastSuccess.at))
  if (mixed.length && state !== 'not-yet') notes.push(`${mixed.length === 1 ? `${dayText(mixed[0]!.at)}有一道` : `有 ${mixed.length} 道`}涉及几个知识点的题没做对，不确定问题出在哪一项。`)
  else if (mixed.length && mixed.length === wrong) notes.push('做错的题都涉及几个知识点，不确定问题出在哪一项。')
  if (pending) notes.push(`有 ${pending} 道题的判分等复核，暂不计。`)
  if (voided) notes.push(`有 ${voided} 次作答的题目后来核对出有错，不计。`)

  // 有疑点: asked about again, or a possible misconception, since the latest independent success.
  const since = lastSuccess?.at ?? -Infinity
  const recent = facts.signals.filter(signal => time(signal) > since && time(signal) <= nowMs)
  const misconception = recent.filter(signal => signal.type === 'signal.misconception').at(-1)
  const questions = recent.filter(signal => signal.type === 'signal.question').length
  const doubtful = misconception !== undefined || questions >= DOUBT_QUESTIONS
  if (doubtful) {
    const when = lastSuccess ? '上次独立答对之后' : ''
    notes.push(misconception ? `${when}有一条可能的误解：${clip(misconception.text)}。` : `${when}又问到 ${questions} 次。`)
  }

  const lastContact = facts.contact.at(-1)
  const checkFrom = state === 'independent' && lastContact !== undefined ? lastContact + RETAIN_GAP
    : state === 'retained' && lastSuccess ? lastSuccess.at + REVIEW_AFTER : undefined
  const next = {
    untested: '做一道题看看。',
    'not-yet': '弄懂以后再独立做一道。',
    assisted: '不看提示、不问老师，独立做对一道。',
    independent: checkFrom !== undefined && checkFrom > nowMs ? `${dayText(checkFrom)}以后独立做对一道没做过的题，就算延迟验证。` : '现在独立做对一道没做过的题，就算延迟验证。',
    retained: undefined,
    conflict: '先核对做错的那道题和判分，再独立做一道确认。',
  }[state]

  const lastIndependentAt = lastSuccess?.entry.at
  const helpIds = state === 'assisted' ? decisive.map(item => item.help!.entry.id) : []
  return {
    state,
    needsReview: reviewDue({ state, ...(lastIndependentAt ? { lastIndependentAt } : {}) }, nowMs),
    doubtful,
    ...(last ? { lastEvidenceAt: last.entry.at } : {}),
    ...(lastIndependentAt ? { lastIndependentAt } : {}),
    explanation: `${head}${counts ? `（${counts}，最近一次 ${dayText(last!.at)}）` : ''}。${notes.join('')}`,
    ...(next ? { next } : {}),
    ...(checkFrom !== undefined ? { checkFrom: new Date(checkFrom).toISOString() } : {}),
    evidence: [...new Set([...decisive.map(item => item.entry.id), ...helpIds])] as Derived['evidence'],
  }
}

function clip(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}
