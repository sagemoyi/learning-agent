// Time left to the exam or the deadline, in words; shared by the brief and the pages.
import type { Countdown } from '@learning-agent/contracts'

/** 距考试（2027-01-15）还有 14 周，路线 3 个阶段已完成 1 个 */
export function countdownText(countdown: Countdown): string {
  const { label, date, days } = countdown
  const left = days < 0 ? '已过' : days === 0 ? '就是今天' : days < 14 ? `还有 ${days} 天` : `还有 ${Math.floor(days / 7)} 周`
  const roadmap = countdown.stagesTotal ? `，路线 ${countdown.stagesTotal} 个阶段已完成 ${countdown.stagesDone} 个` : '，还没有课程路线'
  return `距${label}（${date}）${left}${roadmap}`
}
