// tutor unit, browser half: the teacher conversation page. Follows the course's current teacher
// session and switches when a new stage opens its own session.
import { useMemo, type ReactNode } from 'react'
import { GraduationCap } from 'lucide-react'
import type { ClientContext, LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { EmptyState, ErrorText, Page, Skeleton, useLoad } from '@learning-agent/kit/client'
import { Chat, type SessionRemote } from '@learning-agent/kit/chat'

export const name = 'learning-tutor'
export const inject = ['slots', 'learnShell', 'remote', 'remote.session']

let shell: LearnShell
let remote: SessionRemote

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  remote = (ctx as unknown as { remote: { session: SessionRemote } }).remote.session
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'teacher', title: '主老师', icon: GraduationCap, scope: 'course', page: 'tutor.chat', order: 30 }), 'tutor: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({
    name: 'learning.page',
    key: 'tutor.chat',
    children: { 'learning.chat-card': { kind: 'keyed', scope: 'root' } },
  }, TeacherPage)), 'tutor: chat page')
}

const SUGGESTIONS = ['我想学到能做课后习题的程度', '先帮我看看我已经会了哪些', '这门课大概分几个阶段？']

function TeacherPage({ scope, renderSlot }: LearningPageProps & PropsRenderSlots<'learning.chat-card'>): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const session = useLoad(shell, async () => (courseId ? shell.call<{ sessionId: string; stageId: string | null }>('tutor', 'session', { courseId }) : undefined), [courseId], ['learning/stage-changed'])
  const sessionId = session.data?.sessionId
  const chatRemote = useMemo(() => remote, [])
  if (!courseId) return <Page><EmptyState icon={GraduationCap} title="进入一门课后和主老师对话" /></Page>
  if (session.error) return <Page><ErrorText error={session.error} /></Page>
  if (!sessionId) return <Page width="reading"><Skeleton lines={4} /></Page>
  return (
    <Chat key={sessionId} shell={shell} remote={chatRemote} sessionId={sessionId}
      placeholder="和主老师说话…"
      intro={{ icon: GraduationCap, title: '主老师', description: '说说你想学到什么程度。老师会带你确认目标、摸底、排路线，一节一节地往下学。' }}
      suggestions={SUGGESTIONS}
      renderCard={(name, props) => renderSlot('learning.chat-card', props, { entryKey: name, fallback: null })} />
  )
}
