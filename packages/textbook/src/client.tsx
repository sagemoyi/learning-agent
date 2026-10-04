// textbook unit, browser half: the textbook reader. Blocks are selectable (the side chat and,
// later, annotations attach to them); citation badges open the source chunk in the library.
import { useState, type ReactNode } from 'react'
import { BookOpen, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, RotateCw } from 'lucide-react'
import type { Lesson, LessonTextbookStatus } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import { Button, ConfirmButton, useAction, useLoad, useSelection } from '@learning-agent/kit/client'

export const name = 'learning-textbook'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'textbook', title: '课程教材', icon: BookOpen, scope: 'course', page: 'textbook.reader', order: 20 }), 'textbook: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'textbook.reader' }, ReaderPage)), 'textbook: reader page')
}

type LessonView = {
  lesson: Lesson
  stage: { id: string; index: number; title: string }
  siblings: { id: string; number: string; title: string }[]
  text: string | null
  status: LessonTextbookStatus
}

function ReaderPage({ scope, params }: LearningPageProps): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const [picked, setPicked] = useState<string | undefined>(typeof params.id === 'string' ? params.id : undefined)
  // Without a lesson to show, follow the course: the current lesson appears once a design is confirmed.
  const current = useLoad(shell, async () => (picked || !courseId ? null : (await shell.call<{ lessonId: string | null }>('textbook', 'current', { courseId })).lessonId), [picked, courseId])
  const lessonId = picked ?? current.data ?? undefined
  if (!courseId) return <div className="la-empty">进入一门课后阅读它的教材。</div>
  if (!lessonId) return <div className="la-empty">{current.loading ? '' : '还没有课时。阶段设计确认后会生成教材。'}</div>
  return <Reader courseId={courseId} lessonId={lessonId} onLesson={setPicked} />
}

function StatusLine({ status }: { status: LessonTextbookStatus }): ReactNode {
  if (status.state === 'running') return <div className="la-tag warn la-row" style={{ display: 'inline-flex', gap: 6 }}><LoaderCircle size={12} className="la-spin" />{status.message || '教材生成中…'}</div>
  if (status.state === 'failed') return <div className="la-error la-row"><CircleAlert size={14} strokeWidth={1.75} />生成失败：{status.message}</div>
  return null
}

function Reader({ courseId, lessonId, onLesson }: { courseId: string; lessonId: string; onLesson(id: string): void }): ReactNode {
  // Reloads on every change-feed message, generation progress included.
  const view = useLoad(shell, () => shell.call<LessonView>('textbook', 'lesson', { lessonId }), [lessonId])
  const selection = useSelection(shell)
  const regenerate = useAction()
  const data = view.data
  if (view.error) return <div className="la-pad la-error">{view.error}</div>
  if (!data) return null
  const selectedBlock = selection?.selected?.kind === 'block' ? selection.selected.id : undefined
  const index = data.siblings.findIndex(item => item.id === lessonId)
  const previous = data.siblings[index - 1]
  const next = data.siblings[index + 1]
  const running = data.status.state === 'running'
  const generate = () => void regenerate.run(() => shell.call('textbook', 'generate', { lessonId }))
  return (
    <div className="la-pad la-stack">
      <div className="la-row la-small la-muted">
        <span>阶段 {data.stage.index} {data.stage.title}</span>
        <span className="la-spacer" />
        {data.text && !running && (
          <ConfirmButton size="sm" variant="quiet" icon={RotateCw} loading={regenerate.busy} onConfirm={generate}
            question="按当前设计书重写这一节？旧版本留在变更记录里" confirm="重新生成">重新生成本节</ConfirmButton>
        )}
        {previous && <Button size="sm" variant="quiet" icon={ChevronLeft} title="上一节" onClick={() => onLesson(previous.id)}>{previous.number}</Button>}
        {next && <Button size="sm" variant="quiet" title="下一节" onClick={() => onLesson(next.id)}>{next.number}<ChevronRight size={14} strokeWidth={1.75} /></Button>}
      </div>
      <StatusLine status={data.status} />
      {!data.text && !running && (
        <div className="la-card la-stack">
          <div>{data.lesson.number} {data.lesson.title} 的教材还没有生成。</div>
          <div><Button variant="primary" icon={RotateCw} loading={regenerate.busy} onClick={generate}>{data.status.state === 'failed' ? '重新生成' : '生成本节教材'}</Button></div>
        </div>
      )}
      {data.text && (
        <shell.Markdown
          text={data.text}
          blocks
          {...(selectedBlock ? { selectedBlock } : {})}
          onBlock={(blockId, text) => shell.select({
            page: 'textbook.reader',
            courseId: courseId as never,
            selected: { kind: 'block', id: blockId, quote: { exact: text.slice(0, 200), prefix: '', suffix: '' }, label: `${data.lesson.number} ${data.lesson.title} · 块 ${blockId}` },
          })}
          onCite={chunkId => shell.openPage('library.sources', { id: chunkId, chunkId }, { title: '出处', split: true })}
        />
      )}
      {data.text && <div className="la-muted la-small">点一段文字，就可以在右侧针对这一段提问。灰色小标签是出处，点开看原文。</div>}
      {regenerate.error && <div className="la-error">{regenerate.error}</div>}
    </div>
  )
}
