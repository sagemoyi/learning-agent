// Checks on the teacher's goal writes (docs/goal/design.md "A 批"). Errors stop the save and go back
// to the teacher as one list to fix; warnings ride along with a successful save. Fact sources are
// checked by the service, which can see the library.
import { CITATION_PATTERN, type GoalFrontmatter } from '@learning-agent/contracts'

/** Words that name a state of mind, not something the learner can be seen doing. */
const VAGUE = /^(?:能够?|会)?\s*(?:理解|了解|熟悉|掌握|知道|明白|认识|懂得?|学会)/
const INTERNAL_ID = /\b[a-z]{2,3}_[0-9A-HJKMNP-TV-Z]{26}\b/
const EXAM_WORDS = /考试|期末|期中|考研|测验|证书|资格考/
const PERCENT = /\d+(?:\.\d+)?\s*[%％]/
const PERCENT_REASON = /及格|大纲|考试要求|学习者要求|依据|按照学校/

export interface GoalCheck {
  readonly errors: string[]
  readonly warnings: string[]
}

/** Text the learner reads, with citations taken out (their passage ids are allowed). */
function learnerText(goal: GoalFrontmatter, body: string): string {
  const exam = goal.exam
  return [
    goal.purpose, goal.scenario, goal.level, goal.verification, goal.boundaries.timeBudget ?? '',
    ...goal.canDo.flatMap(item => [item.text, item.evidence ?? '']),
    ...goal.boundaries.exclude,
    ...(exam ? [exam.scope, exam.grading ?? '', ...exam.format.flatMap(item => [item.type, item.note ?? ''])] : []),
    body,
  ].join('\n').replace(CITATION_PATTERN, '$1')
}

/** Whether learner-facing text carries an internal id (citation links excepted). */
export function hasInternalId(text: string): boolean {
  return INTERNAL_ID.test(text.replace(CITATION_PATTERN, '$1'))
}

export function checkGoal(goal: GoalFrontmatter, body: string): GoalCheck {
  const errors: string[] = []
  const warnings: string[] = []
  if (!goal.canDo.length) errors.push('至少写一条"学成后能做"。')
  for (const item of goal.canDo) {
    if (VAGUE.test(item.text.trim())) errors.push(`「${item.text}」不是能检查的动作：改写成学成后能做的事，例如"能用……算出……""能解释……为什么……"。`)
  }
  if (!goal.verification.trim()) errors.push('写明怎么验证学会了，例如阶段测试、模拟卷或一个完整任务。')
  const hours = goal.boundaries.hoursPerWeek
  if (hours && hours.min > hours.max) errors.push('每周投入的最少小时数不能大于最多小时数。')
  if (INTERNAL_ID.test(learnerText(goal, body))) errors.push('目标说明会原样给学习者看，不写内部编号（kn_、ck_ 等），用名称；出处写成 [《书名》p.页码](cite:片段ID)。')

  if (!goal.exam && EXAM_WORDS.test([goal.purpose, goal.scenario, goal.level, goal.verification].join('\n'))) {
    warnings.push('目标提到了考试，但没有考试档案。有考试就补上考试档案（范围、题型、条件、日期）；学习者说不清的先照推测写，页面会请学习者确认。')
  }
  const thresholds = [goal.verification, ...goal.canDo.map(item => item.evidence ?? '')].filter(text => PERCENT.test(text) && !PERCENT_REASON.test(text))
  if (thresholds.length) warnings.push('验证方式里的百分比门槛没有写依据（例如考试的及格线、学习者自己的要求）。没有依据就改成"独立完成并答对"这类能检查的说法。')
  return { errors, warnings }
}
