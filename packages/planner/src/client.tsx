// planner unit, browser half: the home page (courses and their next step), the "next step" section at
// the top of the course progress page, the course list in the main sidebar, and the next step in the
// status bar.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, Footprints, GraduationCap, House, Plus, Sparkles } from 'lucide-react'
import type { Course, Lesson, NextStep, Stage } from '@learning-agent/contracts'
import type { ClientContext, LearnShell, ShellScope } from '@learning-agent/contracts/client'
import { Button, EmptyState, ErrorText, Page, PageHeader, Progress, Section, Skeleton, Tag, TextField, useAction, useLoad } from '@learning-agent/kit/client'

export const name = 'learning-planner'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'home', title: '首页', icon: House, scope: 'main', page: 'planner.home', order: 10 }), 'planner: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'planner.home' }, HomePage)), 'planner: home page')
  ctx.effect(() => ctx.slots.inject('learning.course-section', () => ctx.slots.register({ name: 'learning.course-section', id: 'next', order: 5 }, NextSection)), 'planner: next-step section')
  ctx.effect(() => ctx.slots.inject('learning.sidebar', () => ctx.slots.register({ name: 'learning.sidebar', id: 'courses', order: 10 }, CourseList)), 'planner: course list')
  ctx.effect(() => ctx.slots.inject('learning.status', () => ctx.slots.register({ name: 'learning.status', id: 'next', order: 30 }, NextStatus)), 'planner: status')
}

const PAGE_TITLE: Record<string, string> = {
  'tutor.chat': '主老师', 'curriculum.progress': '课程进度', 'library.sources': '资料库', 'assess.test': '测试', 'assess.tests': '测试', 'textbook.reader': '课程教材',
}

function openStep(step: NextStep): void {
  if (step.page) shell.openPage(step.page, { ...(step.params ?? {}) }, { title: PAGE_TITLE[step.page] ?? step.page })
}

/** The step's call to action: where the learner goes, or the conversation when the teacher acts. */
function stepAction(step: NextStep): { label: string; open(): void } {
  if (step.actor === 'learner' && step.page) return { label: `去${PAGE_TITLE[step.page] ?? '完成'}`, open: () => openStep(step) }
  return { label: '去看主老师', open: () => shell.openPage('tutor.chat', {}, { title: '主老师' }) }
}

function NextSection({ courseId }: { courseId: string }): ReactNode {
  const next = useLoad(shell, () => shell.call<NextStep>('planner', 'next', { courseId }), [courseId])
  if (!next.data) return next.loading ? <Skeleton lines={2} /> : null
  const step = next.data
  const learner = step.actor === 'learner'
  const action = stepAction(step)
  const here = learner && step.page === 'curriculum.progress'
  return (
    <section className={`la-next${learner ? ' learner' : ''}`}>
      <span className="la-next-icon">{learner ? <Footprints size={20} strokeWidth={1.75} /> : <GraduationCap size={20} strokeWidth={1.75} />}</span>
      <div className="la-next-body">
        <div className="la-next-kicker">{learner ? '下一步 · 轮到你' : '下一步 · 主老师在做'}</div>
        <div className="la-next-title">{step.title}</div>
        <div className="la-next-detail">{learner ? step.detail : '主老师会接着做这一步，做完会在对话里告诉你。'}{here ? '就在本页下方。' : ''}</div>
      </div>
      {!here && (
        <div className="la-next-actions">
          <Button variant={learner ? 'primary' : 'default'} icon={ArrowRight} onClick={action.open}>{action.label}</Button>
        </div>
      )}
    </section>
  )
}

type HomeRow = { course: Course; next: NextStep | null }
type Overview = { stages: (Stage & { lessons: Lesson[] })[] }

function weekday(): string {
  const date = new Date()
  return `${date.getMonth() + 1}月${date.getDate()}日 · 星期${'日一二三四五六'[date.getDay()]}`
}

function HomePage(): ReactNode {
  const home = useLoad(shell, async () => {
    const rows = await shell.call<HomeRow[]>('planner', 'home')
    const overviews = await Promise.all(rows.map(row => shell.call<Overview>('curriculum', 'overview', { courseId: row.course.id }).catch(() => null)))
    return rows.map((row, index) => ({ ...row, overview: overviews[index] ?? null }))
  }, [])
  const [creating, setCreating] = useState(false)
  const rows = home.data ?? []
  const waiting = rows.find(row => row.next?.actor === 'learner')
  return (
    <Page width="wide">
      <PageHeader eyebrow={weekday()} title="欢迎回来" description="每门课学到哪了、下一步做什么，都在这里。"
        actions={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>新建课程</Button>} />
      <ErrorText error={home.error} />
      {home.loading && !home.data && <Skeleton lines={4} title />}
      {waiting?.next && (
        <section className="la-hero" style={{ marginBottom: 28 }}>
          <span className="la-hero-icon"><Footprints size={22} strokeWidth={1.75} /></span>
          <div className="la-hero-body">
            <div className="la-hero-kicker">继续学习 · {waiting.course.title}</div>
            <div className="la-hero-title">{waiting.next.title}</div>
            <div className="la-hero-detail">{waiting.next.detail}</div>
          </div>
          <Button variant="primary" icon={ArrowRight} onClick={() => { shell.enterCourse(waiting.course.id); const step = waiting.next!; setTimeout(() => openStep(step), 60) }}>继续</Button>
        </section>
      )}
      {home.data && (
        <Section title="我的课程" count={rows.length}>
          {rows.length === 0 && !creating ? (
            <div className="la-card">
              <EmptyState icon={GraduationCap} title="还没有课程" description="一门课对应学习库里的一个文件夹，可以直接用 Obsidian 打开。新建之后，主老师会先和你确认目标。"
                action={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>新建第一门课</Button>} />
            </div>
          ) : (
            <div className="la-course-grid">
              {rows.map(row => <CourseCard key={row.course.id} row={row} />)}
              <NewCourseCard editing={creating} onEditing={setCreating} />
            </div>
          )}
        </Section>
      )}
    </Page>
  )
}

function CourseCard({ row }: { row: HomeRow & { overview: Overview | null } }): ReactNode {
  const { course, next, overview } = row
  const lessons = overview?.stages.flatMap(stage => stage.lessons) ?? []
  const done = lessons.filter(lesson => lesson.status === 'done').length
  const stage = overview?.stages.find(item => item.status !== 'done' && item.status !== 'planned') ?? overview?.stages.find(item => item.status === 'planned')
  return (
    <button type="button" className="la-card interactive la-course-card" onClick={() => shell.enterCourse(course.id)}>
      <div className="la-course-top">
        <span className="la-course-avatar">{Array.from(course.title)[0]}</span>
        <div style={{ minWidth: 0 }}>
          <div className="la-course-title">{course.title}</div>
          <div className="la-course-sub">{stage ? `阶段 ${stage.index} · ${stage.title}` : overview?.stages.length ? '全部阶段已完成' : '还没有课程路线'}</div>
        </div>
      </div>
      {next && (
        <div className="la-course-next">
          <Tag tone={next.actor === 'learner' ? 'accent' : 'neutral'}>{next.actor === 'learner' ? '轮到你' : '主老师'}</Tag>
          <span>{next.title}</span>
        </div>
      )}
      <div className="la-course-foot">
        {lessons.length > 0 ? <><Progress value={(done / lessons.length) * 100} label="已完成的课时" /><span className="la-num">{done}/{lessons.length} 节</span></> : <span>新建于 {new Date(course.createdAt).toLocaleDateString('zh-CN')}</span>}
      </div>
    </button>
  )
}

function NewCourseCard({ editing, onEditing }: { editing: boolean; onEditing(editing: boolean): void }): ReactNode {
  const [title, setTitle] = useState('')
  const create = useAction()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => { if (editing) box.current?.querySelector('input')?.focus() }, [editing])
  const submit = () => {
    if (!title.trim() || create.busy) return
    void create.run(async () => {
      const course = await shell.call<Course>('core', 'createCourse', { title: title.trim() })
      setTitle('')
      onEditing(false)
      shell.enterCourse(course.id)
    })
  }
  if (!editing) {
    return (
      <button type="button" className="la-card interactive la-course-card la-new-course" onClick={() => onEditing(true)}>
        <EmptyState compact icon={Plus} title="新建课程" description="主老师会先和你确认目标" />
      </button>
    )
  }
  return (
    <div className="la-card la-course-card la-new-course is-editing" ref={box} style={{ borderStyle: 'solid', borderColor: 'var(--la-accent-line)' }}>
      <div className="la-strong">新建课程</div>
      <TextField aria-label="课程名" placeholder="课程名，例如：化工原理" value={title} onChange={setTitle} onEnter={submit} />
      <div className="la-faint la-small">一门课对应学习库里的一个文件夹，可以直接用 Obsidian 打开。</div>
      <ErrorText error={create.error} />
      <div className="la-row" style={{ marginTop: 'auto', justifyContent: 'flex-end' }}>
        <Button variant="quiet" onClick={() => { onEditing(false); setTitle('') }}>取消</Button>
        <Button variant="primary" icon={Sparkles} loading={create.busy} disabled={!title.trim()} onClick={submit}>创建并开始</Button>
      </div>
    </div>
  )
}

/** Main sidebar: the courses, one click to enter. */
function CourseList({ scope }: { scope: ShellScope }): ReactNode {
  const home = useLoad(shell, () => (scope.kind === 'main' ? shell.call<HomeRow[]>('planner', 'home') : Promise.resolve([])), [scope.kind], ['learning/course-created'])
  if (scope.kind !== 'main') return null
  const rows = home.data ?? []
  return (
    <div className="la-side-section">
      <div className="la-side-heading"><span>课程</span></div>
      <div className="la-tree">
        {rows.map(({ course, next }) => (
          <button key={course.id} type="button" className="la-tree-item" title={next ? `下一步：${next.title}` : course.title} onClick={() => shell.enterCourse(course.id)}>
            <span className="la-switcher-avatar" style={{ width: 20, height: 20, borderRadius: 6, fontSize: 'var(--la-fs-2xs)' }}>{Array.from(course.title)[0]}</span>
            <span className="la-tree-title">{course.title}</span>
            {next?.actor === 'learner' && <span className="la-dot accent" title="轮到你" />}
          </button>
        ))}
        {home.data && rows.length === 0 && <div className="la-side-empty">还没有课程</div>}
      </div>
    </div>
  )
}

/** Status bar: the course's next step, one click to the page that does it. */
function NextStatus({ scope }: { scope: ShellScope }): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const next = useLoad(shell, async () => (courseId ? shell.call<NextStep>('planner', 'next', { courseId }) : null), [courseId])
  if (!courseId || !next.data) return null
  const step = next.data
  const action = stepAction(step)
  return (
    <button type="button" className={`la-status-item${step.actor === 'learner' ? ' accent' : ''}`} title={`${step.title}（${action.label}）`} onClick={action.open}>
      <Footprints size={13} strokeWidth={1.75} />
      <span className="la-ellipsis" style={{ maxWidth: 320 }}>下一步：{step.title}</span>
    </button>
  )
}
