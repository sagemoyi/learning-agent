// Proposals (docs/tutor/design.md, C): a change the learner asked for somewhere else than the teacher chat: an error
// reported on the textbook (annotation), or a change drafted in a side chat and submitted by the learner (sidechat).
// core keeps them; the teacher sees the open ones in the brief, checks them against the sources and decides. "Applied" needs a change to the target made after the proposal, so a
// proposal is never marked done when the edit failed or was never made; "rejected" needs the reason the learner reads.
import type { Context } from '@deepseek-ai/cordis'
import { COURSE_LAYOUT, LearningApiError, type ChangeTarget, type Proposal } from '@learning-agent/contracts'
import { must } from '@learning-agent/kit'

const SOURCE: Record<Proposal['source'], string> = { annotation: '教材批注里的报错', 'side-chat': '侧边提问里的修改建议', user: '学习者', review: '阶段复盘', teacher: '主老师' }

/** A target in the teacher's words: a textbook file is its lesson, the course files are named. */
function targetName(ctx: Context, courseId: string, target: ChangeTarget): string {
  if (target.kind === 'node') {
    const node = ctx.learnKnowledge.graph(courseId).nodes.find(item => item.id === target.id)
    return node ? `知识点「${node.title}」（${node.id}）` : `知识点 ${target.id}`
  }
  if (target.kind !== 'file') return `${target.kind} ${target.id}`
  if (target.path === COURSE_LAYOUT.goal) return '目标说明（goal.md）'
  if (target.path === COURSE_LAYOUT.roadmap) return '课程路线（roadmap.md）'
  for (const stage of ctx.learnCurriculum.stages(courseId)) {
    if (target.path === `${stage.folder}/design.md`) return `阶段 ${stage.index} ${stage.title} 的设计书（${stage.id}）`
    const lesson = ctx.learnCurriculum.lessons(stage.id).find(item => item.textbookFile === target.path)
    if (lesson) return `教材 ${lesson.number} ${lesson.title}（${lesson.id}）`
  }
  return target.path
}

/** The open proposals of a course, for the brief; empty when there are none. */
export function proposalLines(ctx: Context, courseId: string): string[] {
  const open = ctx.learnCore.proposals.list({ courseId, status: 'open' })
  if (open.length === 0) return []
  const sources = new Set(open.map(proposal => proposal.source))
  return [
    ...open.map(proposal => `- ${proposal.id}（${SOURCE[proposal.source]}，${proposal.targets.map(target => targetName(ctx, courseId, target)).join('、')}）：${proposal.summary}\n  ${proposal.rationale.replace(/\n/g, '\n  ')}`),
    [
      '处理：先对照资料（search_library、read_section）核对，拿不准就问学习者。',
      sources.has('annotation') ? '教材报错：先读那一段（read_lesson_textbook），确实有错就用 revise_textbook 改那几段。' : '',
      sources.has('side-chat') ? '侧边提问里的修改建议：先问清学习者的想法再决定；教材的讲法用 revise_textbook 改，课程路线、阶段设计、目标说明和知识点用对应的工具改，要学习者确认的修改等学习者确认以后再记录。' : '',
      '改好以后 decide_proposal 记为 applied，并用一句话告诉学习者改了什么；核对后不改，decide_proposal 记为 rejected，note 写清理由（学习者会看到）。学习者正在做测试或阅读时不打断，等这一轮该你说话时再处理。',
    ].filter(Boolean).join(''),
  ]
}

/**
 * Decide an open proposal of the course. `applied` collects the changes made to its targets since it was created
 * and refuses when there are none; `rejected` needs a note.
 */
export function decideProposal(ctx: Context, courseId: string, proposalId: string, decision: 'applied' | 'rejected', note: string | undefined): Proposal {
  const core = ctx.learnCore
  const proposal = must(core.proposals.get(proposalId), 'tutor', '提案', proposalId)
  if (proposal.courseId !== courseId) throw new LearningApiError('learning/tutor/other-course', '这个提案不属于这门课', { proposalId })
  if (proposal.status !== 'open') throw new LearningApiError('learning/tutor/proposal-decided', `这个提案已经处理过了（${proposal.status}）`, { proposalId })
  const text = note?.trim()
  if (decision === 'rejected') {
    if (!text) throw new LearningApiError('learning/tutor/needs-note', '不改的话，要在 note 里写清理由，学习者会看到', { proposalId })
    return core.proposals.decide(proposalId, 'rejected', [], text)
  }
  const changes = proposal.targets
    .flatMap(target => core.changes.list({ target }))
    .filter(change => change.at >= proposal.createdAt && !change.revertOf)
  if (changes.length === 0) {
    throw new LearningApiError('learning/tutor/not-changed', '提案涉及的内容在提案之后还没有改动：先用对应的工具改好（教材用 revise_textbook），再记为 applied', { proposalId })
  }
  return core.proposals.decide(proposalId, 'applied', changes.map(change => change.id), text)
}
