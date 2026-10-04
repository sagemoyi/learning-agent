// curriculum unit, browser half: the course progress page (the course's start page). It declares
// the `learning.course-section` slot; goal, assess and curriculum itself contribute sections.
import { useState, type ReactNode } from 'react'
import type { Lesson, Stage, Task } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { shortTime, useAction, useLoad } from '@learning-agent/kit/client'

export const name = 'learning-curriculum'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'progress', title: '课程进度', glyph: '进', scope: 'course', page: 'curriculum.progress', order: 10 }), 'curriculum: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({
    name: 'learning.page',
    key: 'curriculum.progress',
    children: { 'learning.course-section': { kind: 'list', scope: 'root' } },
  }, ProgressPage)), 'curriculum: progress page')
  ctx.effect(() => ctx.slots.inject('learning.course-section', () => ctx.slots.register({ name: 'learning.course-section', id: 'tasks', order: 20 }, TasksSection)), 'curriculum: tasks section')
  ctx.effect(() => ctx.slots.inject('learning.course-section', () => ctx.slots.register({ name: 'learning.course-section', id: 'stages', order: 30 }, StagesSection)), 'curriculum: stages section')
}

const STAGE_STATUS: Record<Stage['status'], { text: string; tone: string }> = {
  planned: { text: '计划中', tone: '' },
  designing: { text: '设计中', tone: 'warn' },
  ready: { text: '待学习', tone: 'accent' },
  learning: { text: '学习中', tone: 'accent' },
  testing: { text: '测试中', tone: 'warn' },
  reviewing: { text: '复盘中', tone: 'warn' },
  done: { text: '已完成', tone: 'ok' },
}
const LESSON_STATUS: Record<Lesson['status'], { text: string; tone: string }> = {
  'not-started': { text: '未开始', tone: '' },
  'in-progress': { text: '进行中', tone: 'accent' },
  done: { text: '已完成', tone: 'ok' },
}
const TASK_KIND: Record<Task['kind'], string> = {
  predict: '预测', read: '阅读', quiz: '小测', practice: '练习', report: '汇报', 'stage-test': '阶段测试', review: '复查', other: '其他',
}

type Overview = { stages: (Stage & { lessons: Lesson[] })[]; tasks: Task[] }

function useOverview(courseId: string) {
  return useLoad(shell, () => shell.call<Overview>('curriculum', 'overview', { courseId }), [courseId],
    ['learning/stage-changed', 'learning/task-', 'learning/textbook-ready', 'learning/doc-changed'])
}

function ProgressPage({ scope, renderSlot }: LearningPageProps & PropsRenderSlots<'learning.course-section'>): ReactNode {
  if (scope.kind !== 'course') return <div className="la-empty">进入一门课后查看进度。</div>
  return (
    <div className="la-pad la-stack">
      <div className="la-h1">课程进度</div>
      {renderSlot('learning.course-section', { courseId: scope.courseId }, {})}
    </div>
  )
}

/** Open the page that does a task: its test, or the lesson's textbook. */
function openTask(task: Task, lessons: readonly Lesson[]): void {
  if (task.result?.kind === 'test') {
    shell.openPage('assess.test', { id: task.result.id }, { title: task.title })
    return
  }
  const lesson = lessons.find(item => item.id === task.lessonId)
  if (lesson) shell.openPage('textbook.reader', { id: lesson.id }, { title: `教材 ${lesson.number}` })
}

function TasksSection({ courseId }: { courseId: string }): ReactNode {
  const overview = useOverview(courseId)
  const action = useAction()
  const [showDone, setShowDone] = useState(false)
  const lessons = overview.data?.stages.flatMap(stage => stage.lessons) ?? []
  const tasks = overview.data?.tasks ?? []
  const open = tasks.filter(task => task.status === 'open')
  const done = tasks.filter(task => task.status !== 'open')
  return (
    <section className="la-card la-stack">
      <div className="la-row">
        <span className="la-h2">当前任务</span>
        {done.length > 0 && <button className="la-link la-small" onClick={() => setShowDone(!showDone)}>{showDone ? '隐藏已完成' : `已完成 ${done.length} 个`}</button>}
      </div>
      {open.length === 0 && <div className="la-muted">没有待做的任务。主老师会在对话里发布任务。</div>}
      {[...open, ...(showDone ? done : [])].map(task => (
        <div key={task.id} className="la-stack" style={{ gap: 2 }}>
          <div className="la-row">
            <span className="la-tag accent">{TASK_KIND[task.kind]}</span>
            <b style={{ opacity: task.status === 'open' ? 1 : 0.6 }}>{task.title}</b>
            {task.status === 'done' && <span className="la-tag ok">完成于 {shortTime(task.doneAt)}</span>}
            <span className="la-spacer" />
            {task.status === 'open' && (task.result?.kind === 'test' || task.lessonId) && <button className="la-btn" onClick={() => openTask(task, lessons)}>去做</button>}
            {task.status === 'open' && task.result?.kind !== 'test' && (
              <button className="la-btn" disabled={action.busy} onClick={() => void action.run(() => shell.call('curriculum', 'completeTask', { taskId: task.id }))}>完成</button>
            )}
          </div>
          {task.status === 'open' && <div className="la-muted">{task.instructions}</div>}
        </div>
      ))}
      {action.error && <div className="la-error">{action.error}</div>}
    </section>
  )
}

function StagesSection({ courseId }: { courseId: string }): ReactNode {
  const overview = useOverview(courseId)
  if (overview.error) return <div className="la-error">{overview.error}</div>
  const stages = overview.data?.stages ?? []
  return (
    <section className="la-card la-stack">
      <div className="la-h2">课程路线</div>
      {stages.length === 0 && <div className="la-muted">目标确认、摸底之后，主老师会排出路线。</div>}
      {stages.map(stage => <StageBlock key={stage.id} stage={stage} />)}
    </section>
  )
}

function StageBlock({ stage }: { stage: Stage & { lessons: Lesson[] } }): ReactNode {
  const status = STAGE_STATUS[stage.status]
  const action = useAction()
  const awaitingConfirm = stage.status === 'designing' && !stage.designConfirmedAt
  const [showDesign, setShowDesign] = useState(awaitingConfirm)
  const design = useLoad(shell, async () => (showDesign ? shell.call<string | null>('curriculum', 'design', { stageId: stage.id }) : null), [stage.id, showDesign], ['learning/doc-changed'])
  const current = stage.status !== 'planned' && stage.status !== 'done'
  return (
    <div className={`la-stack${current ? ' la-card is-active' : ''}`} style={{ gap: 6 }}>
      <div className="la-row">
        <b>阶段 {stage.index}：{stage.title}</b>
        <span className={`la-tag ${status.tone}`}>{status.text}</span>
        {stage.status === 'designing' && stage.designConfirmedAt && <span className="la-tag warn">教材生成中</span>}
        {stage.status !== 'planned' && <button className="la-link la-small" onClick={() => setShowDesign(!showDesign)}>{showDesign ? '收起设计书' : '设计书'}</button>}
      </div>
      <div className="la-muted"><shell.Markdown text={stage.objective} inline /></div>
      {showDesign && design.data && <div className="la-card"><shell.Markdown text={design.data} /></div>}
      {awaitingConfirm && (
        <div className="la-row">
          <button className="la-btn la-btn-primary" disabled={action.busy} onClick={() => void action.run(() => shell.call('curriculum', 'confirmDesign', { stageId: stage.id }))}>确认设计，生成教材</button>
          <span className="la-muted la-small">想改哪里，直接告诉主老师。</span>
        </div>
      )}
      {action.error && <div className="la-error">{action.error}</div>}
      {stage.lessons.length > 0 && (
        <ul className="la-list">
          {stage.lessons.map(lesson => (
            <li key={lesson.id}>
              <span className={`la-tag ${LESSON_STATUS[lesson.status].tone}`}>{LESSON_STATUS[lesson.status].text}</span>
              <button className="la-link" onClick={() => shell.openPage('textbook.reader', { id: lesson.id }, { title: `教材 ${lesson.number}` })}>{lesson.number} {lesson.title}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
