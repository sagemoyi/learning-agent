// The goal in words: fact labels and values, what counts as a choice, and the differences between
// two versions. Shared by the service, the brief and the checks; the page gets the results.
import { conditionWords, GoalFact, type FactBasis, type GoalChange, type GoalFrontmatter } from '@learning-agent/contracts'

export const FACT_LABEL: Record<GoalFact, string> = {
  conditions: '测试条件',
  hours: '每周投入',
  deadline: '最后期限',
  'exam.date': '考试日期',
  'exam.scope': '考试范围',
  'exam.format': '题型和分值',
  'exam.grading': '成绩构成',
  'exam.conditions': '考试条件',
}

/** Facts the learner may set on the page (docs/goal/design.md); the rest they can only confirm. */
export const EDITABLE: ReadonlySet<GoalFact> = new Set<GoalFact>(['conditions', 'hours', 'deadline', 'exam.date', 'exam.conditions'])

export const FOCUS_LABEL: Record<NonNullable<GoalFrontmatter['exam']>['focus'], string> = {
  pass: '只求通过',
  balanced: '兼顾分数和理解',
  understanding: '以理解为主',
}

export function hoursText(boundaries: GoalFrontmatter['boundaries']): string | undefined {
  const hours = boundaries.hoursPerWeek
  if (boundaries.timeBudget) return boundaries.timeBudget
  if (!hours) return undefined
  return hours.min === hours.max ? `每周 ${hours.min} 小时` : `每周 ${hours.min}–${hours.max} 小时`
}

/** "每周 4–6 小时" → 4..6, so a time budget given only in words still serves the deadline check. */
export function parseHours(text: string | undefined): { min: number; max: number } | undefined {
  const match = text ? /每周[^\d]{0,6}(\d+(?:\.\d+)?)\s*(?:(?:[–\-~～到至])\s*(\d+(?:\.\d+)?))?\s*(?:个)?小时/.exec(text) : null
  if (!match) return undefined
  const min = Number(match[1]), max = Number(match[2] ?? match[1])
  return min > 0 && max >= min ? { min, max } : undefined
}

export function formatText(format: NonNullable<GoalFrontmatter['exam']>['format']): string {
  return format.map(item => `${item.type}${item.count === undefined ? '' : ` ${item.count} 道`}${item.points === undefined ? '' : ` ${item.points} 分`}${item.note ? `（${item.note}）` : ''}`).join('；')
}

export function factValue(goal: GoalFrontmatter, fact: GoalFact): string | undefined {
  const exam = goal.exam
  switch (fact) {
    case 'conditions': return conditionWords(goal.boundaries.defaultConditions).join('、')
    case 'hours': return hoursText(goal.boundaries)
    case 'deadline': return goal.deadline
    case 'exam.date': return exam?.date
    case 'exam.scope': return exam ? [exam.scope, exam.sections.length ? `小节 ${exam.sections.join('、')}` : ''].filter(Boolean).join('；') || '（未写）' : undefined
    case 'exam.format': return exam?.format.length ? formatText(exam.format) : undefined
    case 'exam.grading': return exam?.grading || undefined
    case 'exam.conditions': return exam ? conditionWords(exam.conditions).join('、') : undefined
  }
}

export function presentFacts(goal: GoalFrontmatter): GoalFact[] {
  return GoalFact.options.filter(fact => factValue(goal, fact) !== undefined)
}

export function basisOf(goal: GoalFrontmatter, fact: GoalFact): FactBasis {
  return goal.facts[fact]?.basis ?? 'assumed'
}

/** Facts still the teacher's guess. */
export function pendingFacts(goal: GoalFrontmatter): GoalFact[] {
  return presentFacts(goal).filter(fact => basisOf(goal, fact) === 'assumed')
}

/** The learner's choices: changing one of these on a confirmed goal needs the learner to confirm again. */
export function choiceKey(goal: GoalFrontmatter, body: string): string {
  return JSON.stringify([goal.purpose, goal.scenario, goal.canDo, goal.level, goal.verification, goal.boundaries.exclude, goal.exam ? goal.exam.focus : null, body.trim()])
}

const ROUTE = '课程路线和阶段设计可能要跟着调整，老师会检查'
const TESTS = '之后的测试按新的条件和题型出'
const TIME = '进度和期限的判断按新的时间'
const SCOPE = '知识图和课程内容的范围会跟着调整'

type Field = readonly [label: string, value: (goal: GoalFrontmatter) => string | undefined, impact?: string]

const HEAD: readonly Field[] = [
  ['目的', goal => goal.purpose, ROUTE],
  ['场景', goal => goal.scenario],
]

const TAIL: readonly Field[] = [
  ['程度', goal => goal.level, ROUTE],
  ['验证方式', goal => goal.verification, ROUTE],
  ['不学', goal => goal.boundaries.exclude.join('、') || undefined, SCOPE],
  ['测试条件', goal => factValue(goal, 'conditions'), TESTS],
  ['每周投入', goal => factValue(goal, 'hours'), TIME],
  ['最后期限', goal => goal.deadline, TIME],
  ['考试', goal => (goal.exam ? '有考试档案' : undefined), ROUTE],
  ['考试日期', goal => factValue(goal, 'exam.date'), TIME],
  ['考试范围', goal => factValue(goal, 'exam.scope'), SCOPE],
  ['题型和分值', goal => factValue(goal, 'exam.format'), TESTS],
  ['成绩构成', goal => factValue(goal, 'exam.grading')],
  ['考试条件', goal => factValue(goal, 'exam.conditions'), TESTS],
  ['往年题', goal => (goal.exam?.pastPaperSourceIds.length ? `${goal.exam.pastPaperSourceIds.length} 份` : undefined), TESTS],
  ['侧重', goal => (goal.exam ? FOCUS_LABEL[goal.exam.focus] : undefined), ROUTE],
  ['资料清单', goal => goal.sources.map(need => `${need.what}${need.sourceId ? '（已有）' : need.missing ? '（没有）' : ''}`).join('、') || undefined],
]

/** Field-level differences from `before` to `after`, and what they affect. */
export function compare(before: { goal: GoalFrontmatter; body: string }, after: { goal: GoalFrontmatter; body: string }): { changes: GoalChange[]; impacts: string[] } {
  const changes: GoalChange[] = []
  const impacts = new Set<string>()
  const add = (label: string, from: string | undefined, to: string | undefined, impact?: string) => {
    if (from === to) return
    changes.push({ label, ...(from === undefined ? {} : { before: from }), ...(to === undefined ? {} : { after: to }) })
    if (impact) impacts.add(impact)
  }
  for (const [label, value, impact] of HEAD) add(label, value(before.goal), value(after.goal), impact)
  // "Can do" items pair up by key, so a reworded item reads as one change.
  const old = new Map(before.goal.canDo.map(item => [item.key, item]))
  const text = (item?: GoalFrontmatter['canDo'][number]) => (item ? `${item.text}${item.evidence ? `（验证：${item.evidence}）` : ''}` : undefined)
  for (const item of after.goal.canDo) add('学成后能做', text(old.get(item.key)), text(item), ROUTE)
  for (const item of before.goal.canDo) if (!after.goal.canDo.some(next => next.key === item.key)) add('学成后能做', text(item), undefined, ROUTE)
  for (const [label, value, impact] of TAIL) add(label, value(before.goal), value(after.goal), impact)
  if (before.body.trim() !== after.body.trim()) changes.push({ label: '完整说明', after: '有改动' })
  return { changes, impacts: [...impacts] }
}
