// When the learner last studied a course, and what that was (docs/planner/design.md, C): answers, what the
// learner said in the conversation, tasks done. Background jobs, the teacher's notices, help the teacher gave
// (a teacher woken by a notice may explain to nobody) and opening a page are not studying. Read from the
// evidence log and the tasks; nothing is stored.
import type { Context } from '@deepseek-ai/cordis'
import { TEST_KIND_LABEL, type LogEntryType } from '@learning-agent/contracts'

const STUDY: readonly LogEntryType[] = ['attempt.graded', 'signal.question', 'signal.misconception', 'signal.self-report']

export interface Activity {
  readonly at: number
  /** What it was, e.g. "做了 1.2 的小测". */
  readonly what: string
}

export function lastActivity(ctx: Context, courseId: string): Activity | undefined {
  const { learnCore, learnCurriculum, learnKnowledge } = ctx
  const entry = learnCore.log.query({ courseId, types: STUDY, newest: true, limit: 1 })[0]
  const task = learnCurriculum.tasks(courseId, { status: 'done' }).filter(item => item.doneAt).sort((a, b) => b.doneAt!.localeCompare(a.doneAt!))[0]
  const fromLog = entry && Date.parse(entry.at)
  if (task && (fromLog === undefined || Date.parse(task.doneAt!) >= fromLog)) return { at: Date.parse(task.doneAt!), what: `完成了「${task.title}」` }
  if (!entry) return undefined
  if (entry.type === 'attempt.graded') {
    const lesson = entry.context.lessonId ? learnCurriculum.lesson(entry.context.lessonId) : undefined
    return { at: fromLog!, what: `做了${lesson ? ` ${lesson.number} 的` : ''}${entry.testKind ? TEST_KIND_LABEL[entry.testKind] : '练习'}` }
  }
  const title = learnKnowledge.node(entry.nodeIds[0] ?? '')?.title
  return { at: fromLog!, what: title ? `问了「${title}」` : '和老师聊了这门课' }
}
