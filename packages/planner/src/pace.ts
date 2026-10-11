// "照现在的节奏能不能赶上" (docs/planner/design.md, C): from how long the stages already done took, a range for the
// rest, set against the days left. A rough reading of the learner's own pace, said as such: no chance of passing,
// no exact finishing date, and nothing until a stage is done.
import type { Lesson, Pace, Stage } from '@learning-agent/contracts'

const DAY = 86_400_000

/** "5–9 天", or in weeks once it is three weeks or more. */
function spanText(low: number, high: number): string {
  if (high < 21) return `${Math.max(1, Math.floor(low))}–${Math.max(1, Math.ceil(high))} 天`
  return `${Math.max(1, Math.floor(low / 7))}–${Math.ceil(high / 7)} 周`
}

/**
 * `stages` in order with their lessons; `days` left to the date. A stage runs from the end of the one before
 * (the first: from its design being confirmed) to the learner's decision after its review. One stage done gives a
 * range of three quarters to half again its time; more give the shortest to the longest.
 */
export function paceOf(stages: readonly (Stage & { readonly lessons: readonly Lesson[] })[], days: number): Pace {
  if (stages.length === 0) return { verdict: 'unknown', text: '还没有课程路线，估不了。' }
  const done = stages.filter(stage => stage.status === 'done')
  const start = stages[0]!.designConfirmedAt
  const ends = done.map(stage => stage.review?.decidedAt)
  if (done.length === 0 || !start || ends.some(end => !end)) return { verdict: 'unknown', text: '学完第一个阶段后，才能按你的节奏估算赶不赶得上。' }
  const spans = ends.map((end, i) => (Date.parse(end!) - Date.parse(i === 0 ? start : ends[i - 1]!)) / DAY)
  // The stage under way counts by its lessons left (its test and review as one more); stages not designed yet count whole.
  const left = stages.filter(stage => stage.status !== 'done').reduce((sum, stage) => {
    if (stage.status === 'planned' || stage.lessons.length === 0) return sum + 1
    return sum + 1 - stage.lessons.filter(lesson => lesson.status === 'done').length / (stage.lessons.length + 1)
  }, 0)
  if (left === 0) return { verdict: 'ok', text: '路线上的阶段都学完了，剩结课检验。' }
  const [low, high] = spans.length === 1 ? [spans[0]! * 0.75, spans[0]! * 1.5] : [Math.min(...spans), Math.max(...spans)]
  const basis = spans.length === 1
    ? `按第 1 个阶段用了 ${Math.max(1, Math.round(spans[0]!))} 天、上下浮动粗算`
    : `按前 ${spans.length} 个阶段的用时（每个 ${spanText(low, high)}）粗算`
  const need = spanText(left * low, left * high)
  const verdict = left * high <= days ? 'ok' : left * low > days ? 'late' : 'tight'
  const end = {
    ok: '照这个节奏来得及。',
    tight: '照这个节奏有点紧。',
    late: '照这个节奏赶不上：可以每周多花些时间、缩小目标范围，或者调整后面的路线，跟主老师说。',
  }[verdict]
  return { verdict, text: `${basis}，剩下的大约要 ${need}，${end}` }
}
