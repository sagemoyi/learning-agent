// Suggested checks (docs/planner/design.md, B). learner says from when a new problem answered alone adds evidence
// (`checkFrom` of the course's state); the planner picks which of those to suggest now, a few a day across all
// courses, the longest-waiting first. A suggestion is only words until the learner starts it, or asks the teacher
// to: it creates nothing, and time passing writes nothing.
import type { Context } from '@deepseek-ai/cordis'
import type { CourseState, ReviewSuggestion } from '@learning-agent/contracts'

const PURPOSE = { independent: 'delayed', retained: 'review', assisted: 'unaided' } as const

/** Local midnight of the day `at` falls in: "today" is the learner's calendar day. */
export function dayStart(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function dayText(at: number): string {
  const date = new Date(at)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

function reasonOf(state: CourseState, purpose: ReviewSuggestion['purpose']): string {
  const last = state.lastIndependentAt ? dayText(Date.parse(state.lastIndependentAt)) : ''
  if (purpose === 'delayed') return `${last}独立做对过，隔了几天：现在独立做对一道没做过的题，就算延迟验证。`
  if (purpose === 'review') return `已经延迟验证过，最近一次独立做对是${last}：做一道没做过的题，看看还会不会。`
  return '答对过，但答题前得到过帮助：这次不看提示、不问老师，独立做对一道。'
}

export interface Plan {
  /** One suggestion per course at most, within the day's number. */
  readonly picks: ReadonlyMap<string, ReviewSuggestion>
  /** Per course, points whose time has come but that have no problem the learner has not met. */
  readonly missing: ReadonlyMap<string, readonly string[]>
}

/**
 * `limit`: checks a day across all courses (started ones count, whoever started them; dropping one gives nothing
 * back). `deferred`: the course said "今天先不做" until then.
 */
export function plan(ctx: Context, limit: number, deferred: (courseId: string) => number | undefined, now: number): Plan {
  const { learnCore, learnKnowledge, learnLearner, learnAssess } = ctx
  const courses = learnCore.courses.list().filter(course => course.status !== 'archived')
  const today = dayStart(now)
  const todays = courses.flatMap(course => learnAssess.tests(course.id, { kind: 'review' }).filter(test => Date.parse(test.startedAt) >= today))
  const used = todays.length
  // A point checked today in one course is not asked again today in another; its evidence there still counts apart.
  const checked = new Set(todays.flatMap(test => (test.check ? [test.check.nodeId as string] : [])))
  const picks: ReviewSuggestion[] = []
  const missing = new Map<string, string[]>()
  if (limit <= 0) return { picks: new Map(), missing }
  for (const course of courses) {
    if ((deferred(course.id) ?? 0) > now) continue
    // Nothing on top of a test left open: that one comes first, and the teacher may not discuss it meanwhile.
    if (learnAssess.tests(course.id).some(test => test.status === 'open')) continue
    const nodes = learnKnowledge.graph(course.id).nodes
    const states = new Map(learnLearner.states(nodes.map(node => node.id)).map(state => [state.nodeId as string, state]))
    const due = nodes.flatMap(node => {
      // This course's own answers decide: another course's success does not check this one.
      const state = states.get(node.id)?.courses.find(item => item.courseId === course.id)
      const purpose = state && PURPOSE[state.state as keyof typeof PURPOSE]
      const from = state?.checkFrom ? Date.parse(state.checkFrom) : undefined
      return purpose && from !== undefined && from <= now && !checked.has(node.id) ? [{ node, state, purpose, from }] : []
    }).sort((a, b) => a.from - b.from || (a.node.id < b.node.id ? -1 : 1))
    if (due.length === 0) continue
    const ready = new Set(learnAssess.checkable(course.id, due.map(item => item.node.id)))
    const first = due.find(item => ready.has(item.node.id))
    if (first) picks.push({ courseId: course.id, nodeId: first.node.id, title: first.node.title, purpose: first.purpose, reason: reasonOf(first.state, first.purpose), due: new Date(first.from).toISOString(), used, limit })
    const none = due.filter(item => !ready.has(item.node.id)).map(item => item.node.title)
    if (none.length) missing.set(course.id, none)
  }
  // The longest-waiting first, one question per point a day even when courses share it.
  const chosen = new Map<string, ReviewSuggestion>()
  const asked = new Set<string>()
  for (const pick of picks.sort((a, b) => a.due.localeCompare(b.due) || a.courseId.localeCompare(b.courseId))) {
    if (chosen.size >= limit - used || asked.has(pick.nodeId)) continue
    asked.add(pick.nodeId)
    chosen.set(pick.courseId, pick)
  }
  return { picks: chosen, missing }
}
