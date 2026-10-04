// tutor unit, browser half: the teacher conversation page. Follows the course's current teacher
// session and switches when a new stage opens its own session.
import { useMemo, type ReactNode } from 'react'
import type { ClientContext, LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import { useLoad } from '@learning-agent/kit/client'
import { Chat, type SessionRemote } from '@learning-agent/kit/chat'

export const name = 'learning-tutor'
export const inject = ['slots', 'learnShell', 'remote', 'remote.session']

let shell: LearnShell
let remote: SessionRemote

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  remote = (ctx as unknown as { remote: { session: SessionRemote } }).remote.session
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'teacher', title: '主老师', glyph: '师', scope: 'course', page: 'tutor.chat', order: 30 }), 'tutor: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'tutor.chat' }, TeacherPage)), 'tutor: chat page')
}

function TeacherPage({ scope }: LearningPageProps): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const session = useLoad(shell, async () => (courseId ? shell.call<{ sessionId: string; stageId: string | null }>('tutor', 'session', { courseId }) : undefined), [courseId], ['learning/stage-changed'])
  const sessionId = session.data?.sessionId
  const chatRemote = useMemo(() => remote, [])
  if (!courseId) return <div className="la-empty">进入一门课后和主老师对话。</div>
  if (session.error) return <div className="la-pad la-error">{session.error}</div>
  if (!sessionId) return <div className="la-empty">正在准备主老师…</div>
  return <Chat key={sessionId} shell={shell} remote={chatRemote} sessionId={sessionId} placeholder="和主老师说话，例如：我想学到能做课后习题的程度" />
}
