// textbook unit, browser half: the textbook reader. Blocks are selectable (the side chat and,
// later, annotations attach to them); citation badges open the source chunk in the library.
import { useEffect, useState, type ReactNode } from 'react'
import type { FeedMessage, Lesson } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import { useAction, useLoad, useSelection } from '@learning-agent/kit/client'

export const name = 'learning-textbook'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'textbook', title: '课程教材', glyph: '教', scope: 'course', page: 'textbook.reader', order: 20 }), 'textbook: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'textbook.reader' }, ReaderPage)), 'textbook: reader page')
}

type LessonView = {
  lesson: Lesson
  stage: { id: string; index: number; title: string }
  siblings: { id: string; number: string; title: string }[]
  text: string | null
  running: boolean
}

function ReaderPage({ scope, params }: LearningPageProps): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const [lessonId, setLessonId] = useState<string | undefined>(typeof params.id === 'string' ? params.id : undefined)
  useEffect(() => {
    if (lessonId || !courseId) return
    void shell.call<{ lessonId: string | null }>('textbook', 'current', { courseId }).then(result => setLessonId(result.lessonId ?? undefined))
  }, [lessonId, courseId])
  if (!courseId) return <div className="la-empty">进入一门课后阅读它的教材。</div>
  if (!lessonId) return <div className="la-empty">还没有课时。阶段设计确认后会生成教材。</div>
  return <Reader courseId={courseId} lessonId={lessonId} onLesson={setLessonId} />
}

function Reader({ courseId, lessonId, onLesson }: { courseId: string; lessonId: string; onLesson(id: string): void }): ReactNode {
  const view = useLoad(shell, () => shell.call<LessonView>('textbook', 'lesson', { lessonId }), [lessonId], ['learning/doc-changed', 'textbook/progress'])
  const [progress, setProgress] = useState<string>()
  const selection = useSelection(shell)
  const regenerate = useAction()
  useEffect(() => shell.onFeed((message: FeedMessage) => {
    const data = message.data as { lessonId?: string; state?: string; message?: string }
    if (message.type === 'textbook/progress' && data.lessonId === lessonId) setProgress(data.state === 'running' ? data.message : data.state === 'failed' ? `生成失败：${data.message}` : undefined)
  }), [lessonId])
  const data = view.data
  if (view.error) return <div className="la-pad la-error">{view.error}</div>
  if (!data) return null
  const selectedBlock = selection?.selected?.kind === 'block' ? selection.selected.id : undefined
  const index = data.siblings.findIndex(item => item.id === lessonId)
  const previous = data.siblings[index - 1]
  const next = data.siblings[index + 1]
  return (
    <div className="la-pad la-stack">
      <div className="la-row la-small la-muted">
        <span>阶段 {data.stage.index} {data.stage.title}</span>
        <span className="la-spacer" />
        {data.text && !data.running && (
          <button className="la-link" disabled={regenerate.busy} onClick={() => {
            if (window.confirm('按当前的阶段设计书重新生成这一节？旧版本会保留在变更记录里。')) void regenerate.run(() => shell.call('textbook', 'generate', { lessonId }))
          }}>重新生成本节</button>
        )}
        {previous && <button className="la-link" onClick={() => onLesson(previous.id)}>‹ {previous.number}</button>}
        {next && <button className="la-link" onClick={() => onLesson(next.id)}>{next.number} ›</button>}
      </div>
      {(data.running || progress) && <div className="la-tag warn">{progress ?? '教材生成中…'}</div>}
      {!data.text && !data.running && (
        <div className="la-card la-stack">
          <div>{data.lesson.number} {data.lesson.title} 的教材还没有生成。</div>
          <div><button className="la-btn" disabled={regenerate.busy} onClick={() => void regenerate.run(() => shell.call('textbook', 'generate', { lessonId }))}>生成本节教材</button></div>
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
