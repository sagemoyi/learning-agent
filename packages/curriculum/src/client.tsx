// curriculum unit, browser half: the course progress page (the course's start page), which declares
// the `learning.course-section` slot (goal, planner, assess and curriculum itself contribute sections);
// the course outline in the left sidebar; the stage progress in the status bar.
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  ArrowRight, BookOpen, Check, ChevronRight, Circle, CircleCheck, CircleDashed, CircleDot, ClipboardCheck, ClipboardList, FileText, GraduationCap,
  History, Lightbulb, ListChecks, ListTodo, LoaderCircle, MessageSquareText, PencilLine, Route, TriangleAlert,
} from 'lucide-react'
import type { Course, Lesson, LessonTextbookStatus, Stage, Task } from '@learning-agent/contracts'
import type { ClientContext, IconComponent, LearningPageProps, LearnShell, ShellScope } from '@learning-agent/contracts/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Callout, EmptyState, ErrorText, Page, PageHeader, Section, Skeleton, Tag, friendlyTime, useAction, useLoad, useLocalState, type Tone } from '@learning-agent/kit/client'

export const name = 'learning-curriculum'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'progress', title: '课程进度', icon: ListChecks, scope: 'course', page: 'curriculum.progress', order: 10 }), 'curriculum: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({
    name: 'learning.page',
    key: 'curriculum.progress',
    children: { 'learning.course-section': { kind: 'list', scope: 'root' } },
  }, ProgressPage)), 'curriculum: progress page')
  ctx.effect(() => ctx.slots.inject('learning.course-section', () => ctx.slots.register({ name: 'learning.course-section', id: 'tasks', order: 20 }, TasksSection)), 'curriculum: tasks section')
  ctx.effect(() => ctx.slots.inject('learning.course-section', () => ctx.slots.register({ name: 'learning.course-section', id: 'stages', order: 30 }, StagesSection)), 'curriculum: stages section')
  ctx.effect(() => ctx.slots.inject('learning.sidebar', () => ctx.slots.register({ name: 'learning.sidebar', id: 'outline', order: 10 }, CourseOutline)), 'curriculum: outline')
  ctx.effect(() => ctx.slots.inject('learning.status', () => ctx.slots.register({ name: 'learning.status', id: 'stage', order: 10 }, StageStatus)), 'curriculum: status')
}

const STAGE_STATUS: Record<Stage['status'], { text: string; tone: Tone }> = {
  planned: { text: '计划中', tone: 'neutral' },
  designing: { text: '设计中', tone: 'warn' },
  ready: { text: '待学习', tone: 'accent' },
  learning: { text: '学习中', tone: 'accent' },
  testing: { text: '测试中', tone: 'warn' },
  reviewing: { text: '复盘中', tone: 'warn' },
  done: { text: '已完成', tone: 'ok' },
}
const LESSON_STATUS: Record<Lesson['status'], { text: string; icon: IconComponent; className: string }> = {
  'not-started': { text: '未开始', icon: Circle, className: '' },
  'in-progress': { text: '进行中', icon: CircleDot, className: 'current' },
  done: { text: '已完成', icon: CircleCheck, className: 'done' },
}
const TASK_KIND: Record<Task['kind'], { text: string; icon: IconComponent }> = {
  predict: { text: '预测', icon: Lightbulb },
  read: { text: '阅读', icon: BookOpen },
  quiz: { text: '小测', icon: ClipboardCheck },
  practice: { text: '练习', icon: PencilLine },
  report: { text: '汇报', icon: MessageSquareText },
  'stage-test': { text: '阶段测试', icon: ClipboardList },
  review: { text: '复查', icon: History },
  other: { text: '任务', icon: ListTodo },
}

type Overview = { stages: (Stage & { lessons: Lesson[] })[]; tasks: Task[] }

function useOverview(courseId: string | undefined) {
  return useLoad(shell, async () => (courseId ? shell.call<Overview>('curriculum', 'overview', { courseId }) : undefined), [courseId])
}

function openLesson(lesson: Pick<Lesson, 'id' | 'number'>): void {
  shell.openPage('textbook.reader', { id: lesson.id }, { title: `教材 ${lesson.number}` })
}

function ProgressPage({ scope, renderSlot }: LearningPageProps & PropsRenderSlots<'learning.course-section'>): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const course = useLoad(shell, async () => (courseId ? (await shell.call<Course[]>('core', 'courses')).find(item => item.id === courseId) : undefined), [courseId], ['learning/course-created'])
  if (!courseId) return <Page><EmptyState icon={ListChecks} title="进入一门课后查看进度" /></Page>
  return (
    <Page>
      <PageHeader eyebrow={<><ListChecks size={14} strokeWidth={1.75} />课程进度</>} title={course.data?.title ?? ' '} description="学到哪了，接下来学什么。"
        actions={<Button icon={GraduationCap} onClick={() => shell.openPage('tutor.chat', {}, { title: '主老师' })}>问主老师</Button>} />
      <div className="la-stack" style={{ gap: 30 }}>
        {renderSlot('learning.course-section', { courseId }, {})}
      </div>
    </Page>
  )
}

/** Open the page that does a task: its test, or the lesson's textbook. */
function openTask(task: Task, lessons: readonly Lesson[]): void {
  if (task.result?.kind === 'test') {
    shell.openPage('assess.test', { id: task.result.id }, { title: task.title })
    return
  }
  const lesson = lessons.find(item => item.id === task.lessonId)
  if (lesson) openLesson(lesson)
}

function TasksSection({ courseId }: { courseId: string }): ReactNode {
  const overview = useOverview(courseId)
  const action = useAction()
  const [showDone, setShowDone] = useState(false)
  if (!overview.data) return overview.loading ? <Skeleton lines={2} /> : <ErrorText error={overview.error} />
  const lessons = overview.data.stages.flatMap(stage => stage.lessons)
  const tasks = overview.data.tasks
  const open = tasks.filter(task => task.status === 'open')
  const done = tasks.filter(task => task.status !== 'open').reverse()
  const shown = [...open, ...(showDone ? done : [])]
  return (
    <Section title="当前任务" icon={ListTodo} count={open.length}
      actions={done.length > 0 && <Button size="sm" variant="quiet" onClick={() => setShowDone(!showDone)}>{showDone ? '收起已完成' : `已完成 ${done.length} 个`}</Button>}>
      {open.length === 0 && !showDone && (
        <div className="la-card"><EmptyState compact icon={CircleCheck} title="没有待做的任务" description="主老师会在对话里发布阅读、小测等任务，也会出现在这里。" /></div>
      )}
      {shown.length > 0 && (
        <div className="la-rows">
          {shown.map(task => {
            const kind = TASK_KIND[task.kind]
            const isOpen = task.status === 'open'
            const target = isOpen && (task.result?.kind === 'test' || task.lessonId)
            return (
              <div key={task.id} className={`la-task${isOpen ? '' : ' is-done'}`}>
                <span className={`la-row-icon${isOpen ? ' accent' : ''}`}><kind.icon size={16} strokeWidth={1.75} /></span>
                <div className="la-task-body">
                  <div className="la-row" style={{ gap: 8 }}>
                    <span className="la-task-title">{task.title}</span>
                    {!isOpen && <span className="la-faint la-small">{task.status === 'done' ? `完成于 ${friendlyTime(task.doneAt)}` : '已跳过'}</span>}
                  </div>
                  {isOpen && <div className="la-task-text">{task.instructions}</div>}
                </div>
                {isOpen && (
                  <div className="la-task-actions">
                    {task.result?.kind !== 'test' && (
                      <Button size="sm" variant={target ? 'quiet' : 'default'} icon={Check} disabled={action.busy} title="完成后会自动告诉主老师"
                        onClick={() => void action.run(() => shell.call('curriculum', 'completeTask', { taskId: task.id }))}>完成</Button>
                    )}
                    {target && <Button size="sm" variant="primary" icon={ArrowRight} onClick={() => openTask(task, lessons)}>去做</Button>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <ErrorText error={action.error} />
    </Section>
  )
}

function StagesSection({ courseId }: { courseId: string }): ReactNode {
  const overview = useOverview(courseId)
  if (!overview.data) return overview.loading ? <Skeleton lines={3} /> : <ErrorText error={overview.error} />
  const stages = overview.data.stages
  return (
    <Section title="课程路线" icon={Route} count={stages.length || undefined}>
      {stages.length === 0 ? (
        <div className="la-card"><EmptyState compact icon={Route} title="还没有课程路线" description="确认目标、做完摸底之后，主老师会把课程分成几个阶段。" /></div>
      ) : (
        <div className="la-timeline">{stages.map(stage => <StageItem key={stage.id} stage={stage} />)}</div>
      )}
    </Section>
  )
}

const TEXTBOOK_TAG: Record<LessonTextbookStatus['state'], { text: string; tone: Tone } | undefined> = {
  missing: { text: '教材未生成', tone: 'neutral' },
  running: { text: '教材生成中', tone: 'warn' },
  ready: undefined,
  failed: { text: '教材生成失败', tone: 'bad' },
}

function TextbookTag({ status }: { status: LessonTextbookStatus | undefined }): ReactNode {
  const tag = status ? TEXTBOOK_TAG[status.state] : undefined
  if (!tag) return null
  const text = status?.state === 'running' && status.message === '排队等待生成' ? '教材排队中' : tag.text
  return <Tag tone={tag.tone} icon={status?.state === 'running' ? LoaderCircle : status?.state === 'failed' ? TriangleAlert : undefined} title={status?.message}>{text}</Tag>
}

function StageItem({ stage }: { stage: Stage & { lessons: Lesson[] } }): ReactNode {
  const status = STAGE_STATUS[stage.status]
  const action = useAction()
  const awaitingConfirm = stage.status === 'designing' && !stage.designConfirmedAt
  const [showDesign, setShowDesign] = useState(false)
  const design = useLoad(shell, async () => (showDesign ? shell.call<string | null>('curriculum', 'design', { stageId: stage.id }) : null), [stage.id, showDesign], ['learning/doc-changed'])
  const current = stage.status !== 'planned' && stage.status !== 'done'
  const textbooks = useLoad(shell, async (): Promise<Record<string, LessonTextbookStatus>> => (current && stage.designConfirmedAt ? shell.call<Record<string, LessonTextbookStatus>>('textbook', 'statuses', { stageId: stage.id }) : {}), [stage.id, current, stage.designConfirmedAt])
  const place = stage.status === 'done' ? 'done' : current ? 'current' : 'planned'
  return (
    <div className={`la-tl-item ${place}`}>
      <span className="la-tl-marker">{stage.status === 'done' ? <Check size={15} strokeWidth={2.25} /> : stage.index}</span>
      <div className="la-tl-body">
        <div className="la-tl-head">
          <span className="la-tl-title">阶段 {stage.index} · {stage.title}</span>
          <Tag tone={status.tone}>{status.text}</Tag>
          {stage.kind === 'remedial' && <Tag tone="warn">补课</Tag>}
          <span className="la-spacer" />
          {stage.status !== 'planned' && !awaitingConfirm && (
            <Button size="sm" variant="quiet" icon={FileText} aria-expanded={showDesign} onClick={() => setShowDesign(!showDesign)}>{showDesign ? '收起设计书' : '设计书'}</Button>
          )}
        </div>
        <div className="la-tl-objective"><shell.Markdown text={stage.objective} inline /></div>
        {(awaitingConfirm || showDesign || action.error) && (
          <div className="la-tl-panel">
            {awaitingConfirm && (
              <Callout tone="accent" icon={FileText} title="阶段设计书写好了，等你确认"
                actions={<>
                  <Button size="sm" variant="quiet" onClick={() => setShowDesign(!showDesign)}>{showDesign ? '收起' : '先看看'}</Button>
                  <Button size="sm" variant="primary" loading={action.busy} onClick={() => void action.run(() => shell.call('curriculum', 'confirmDesign', { stageId: stage.id }))}>确认，生成教材</Button>
                </>}>
                确认后开始生成本阶段的教材。想改哪里，直接告诉主老师。
              </Callout>
            )}
            {showDesign && (design.data ? <div className="la-doc"><shell.Markdown text={design.data} /></div> : design.loading ? <Skeleton lines={4} /> : <span className="la-faint">设计书还没有写。</span>)}
            <ErrorText error={action.error} />
          </div>
        )}
        {stage.lessons.length > 0 && stage.status !== 'planned' && (
          <div className="la-rows la-lessons">
            {stage.lessons.map(lesson => {
              const state = LESSON_STATUS[lesson.status]
              return (
                <button key={lesson.id} type="button" className="la-row-item interactive la-lesson" onClick={() => openLesson(lesson)}>
                  <span className={`la-lesson-state ${state.className}`} title={state.text}><state.icon size={17} strokeWidth={1.75} /></span>
                  <span className="la-lesson-num">{lesson.number}</span>
                  <span className="la-lesson-title">{lesson.title}</span>
                  <TextbookTag status={textbooks.data?.[lesson.id]} />
                  <ChevronRight size={16} strokeWidth={1.75} className="la-chevron" />
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function useActivePage() {
  return useSyncExternalStore(listener => shell.onActivePage(listener), () => shell.activePage())
}

/** Left sidebar in a course: stages and their lessons; a lesson opens its textbook. */
function CourseOutline({ scope }: { scope: ShellScope }): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const overview = useOverview(courseId)
  const active = useActivePage()
  const [folded, setFolded] = useLocalState<string[]>(`outline:folded:${courseId ?? ''}`, [])
  if (!courseId) return null
  const stages = overview.data?.stages ?? []
  const activeLesson = active?.page === 'textbook.reader' && typeof active.params.id === 'string' ? active.params.id : undefined
  return (
    <div className="la-side-section">
      <div className="la-side-heading"><span>课程目录</span></div>
      {overview.data && stages.length === 0 && <div className="la-side-empty">主老师排出路线后，阶段和课时会列在这里。</div>}
      <div className="la-tree">
        {stages.map(stage => {
          const open = !folded.includes(stage.id) && stage.lessons.length > 0
          const StageIcon = stage.status === 'done' ? CircleCheck : stage.status === 'planned' ? CircleDashed : CircleDot
          return (
            <div key={stage.id} className="la-tree-group">
              <button type="button" className="la-tree-stage" aria-expanded={open} title={stage.title}
                onClick={() => setFolded(open ? [...folded, stage.id] : folded.filter(id => id !== stage.id))}>
                <ChevronRight size={14} strokeWidth={1.75} className="la-tree-chevron" style={{ visibility: stage.lessons.length ? 'visible' : 'hidden' }} />
                <span className="la-tree-stage-title">阶段 {stage.index} · {stage.title}</span>
                <span className={`la-tree-state${stage.status === 'done' ? ' done' : stage.status === 'planned' ? '' : ' current'}`} title={STAGE_STATUS[stage.status].text}><StageIcon size={14} strokeWidth={1.75} /></span>
              </button>
              {open && (
                <div className="la-tree-items">
                  {stage.lessons.map(lesson => {
                    const state = LESSON_STATUS[lesson.status]
                    return (
                      <button key={lesson.id} type="button" title={`${lesson.number} ${lesson.title} · ${state.text}`}
                        className={`la-tree-item${activeLesson === lesson.id ? ' is-active' : ''}${lesson.status === 'in-progress' ? ' is-current' : ''}`} onClick={() => openLesson(lesson)}>
                        <span className="la-tree-num">{lesson.number}</span>
                        <span className="la-tree-title">{lesson.title}</span>
                        <span className={`la-tree-state ${state.className}`}><state.icon size={13} strokeWidth={1.75} /></span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Status bar: which stage and lesson the course is at. */
function StageStatus({ scope }: { scope: ShellScope }): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const overview = useOverview(courseId)
  if (!courseId || !overview.data?.stages.length) return null
  const stages = overview.data.stages
  const current = stages.find(stage => stage.status !== 'done' && stage.status !== 'planned') ?? stages.find(stage => stage.status === 'planned') ?? stages.at(-1)!
  const lesson = current.lessons.find(item => item.status === 'in-progress') ?? current.lessons.find(item => item.status === 'not-started')
  return (
    <button type="button" className="la-status-item" title="打开课程进度" onClick={() => shell.openPage('curriculum.progress', {}, { title: '课程进度' })}>
      <Route size={13} strokeWidth={1.75} />
      <span className="la-num">阶段 {current.index}/{stages.length}</span>
      {lesson && <span className="la-ellipsis" style={{ maxWidth: 200 }}>· {lesson.number} {lesson.title}</span>}
    </button>
  )
}
