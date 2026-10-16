// planner unit, browser half: the home page (courses and their next step), the "next step" section at
// the top of the course progress page, "continue learning" at the top of a new tab, and the next step in
// the status bar.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, ArrowRight, CalendarClock, CircleAlert, ClipboardList, Flag, Footprints, GraduationCap, History, Hourglass, House, Plus, Sparkles, Undo2, type LucideIcon } from 'lucide-react'
import type { Course, Lesson, NextStep, ReviewSuggestion, Stage, Test } from '@learning-agent/contracts'
import type { ClientContext, LearnShell, SettingsAccess, ShellScope } from '@learning-agent/contracts/client'
import { Button, EmptyState, ErrorText, Page, PageHeader, Progress, Section, Segmented, SettingRow, Skeleton, Tag, TextField, useAction, useLoad } from '@learning-agent/kit/client'
import { countdownText } from './countdown.ts'

export const name = 'learning-planner'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'home', title: '首页', icon: House, scope: 'main', page: 'planner.home', order: 10 }), 'planner: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'planner.home' }, HomePage)), 'planner: home page')
  ctx.effect(() => ctx.slots.inject('learning.course-section', () => ctx.slots.register({ name: 'learning.course-section', id: 'next', order: 5 }, NextSection)), 'planner: next-step section')
  ctx.effect(() => ctx.slots.inject('learning.new-tab', () => ctx.slots.register({ name: 'learning.new-tab', id: 'continue', order: 10 }, ContinueSection)), 'planner: new tab')
  ctx.effect(() => ctx.slots.inject('learning.status', () => ctx.slots.register({ name: 'learning.status', id: 'next', order: 30 }, NextStatus)), 'planner: status')
  ctx.effect(() => ctx.slots.inject('learning.settings.services', () => ctx.slots.register({ name: 'learning.settings.services', id: 'planner', order: 40 }, PlannerSettings)), 'planner: settings')
}

const SETTINGS = 'learning-planner'
const DAILY_CHECKS = 3

/** How many checks a day the planner suggests, across all courses. */
function PlannerSettings({ access }: { access: SettingsAccess }): ReactNode {
  const values = access.values(SETTINGS)
  const action = useAction()
  if (!values) return <Skeleton lines={2} />
  const daily = typeof values.dailyChecks === 'number' ? values.dailyChecks : DAILY_CHECKS
  return (
    <Section title="复查提醒" icon={History} description="在课时之间，按你的作答记录建议做一道没做过的题，看看隔了几天还会不会。只是建议，可以不做。">
      <div className="la-settings-card">
        <SettingRow title="每天建议的复查题" hint="所有课程合计；你自己点的“考我一下”也算在内。选“不建议”就不再提示。">
          <Segmented value={String(daily)} aria-label="每天建议的复查题" disabled={action.busy}
            options={[{ value: '0', label: '不建议' }, { value: '1', label: '1 道' }, { value: '3', label: '3 道' }, { value: '5', label: '5 道' }]}
            onChange={value => void action.run(() => access.set(SETTINGS, 'dailyChecks', Number(value) === DAILY_CHECKS ? undefined : Number(value)))} />
        </SettingRow>
      </div>
      <ErrorText error={action.error} />
    </Section>
  )
}

const PAGE_TITLE: Record<string, string> = {
  'tutor.chat': '主老师', 'curriculum.progress': '课程进度', 'library.sources': '资料库', 'assess.test': '测试', 'assess.tests': '测试', 'textbook.reader': '课程教材',
}

function openStep(step: NextStep): void {
  if (step.page) shell.openPage(step.page, { ...(step.params ?? {}) }, { title: PAGE_TITLE[step.page] ?? step.page })
}

/** The step's call to action: where the learner goes, the conversation when the teacher acts, nothing while nobody needs to. */
function stepAction(step: NextStep): { label: string; open(): void } | undefined {
  if (step.actor === 'teacher') return { label: '去看主老师', open: () => shell.openPage('tutor.chat', {}, { title: '主老师' }) }
  if (step.page) return { label: `去${PAGE_TITLE[step.page] ?? '看看'}`, open: () => openStep(step) }
  return undefined
}

/** Nobody acts: waiting on a background job, or the course is finished, archived, or cannot be read. */
const WAITING_ICON: Record<string, LucideIcon> = { 'course.finished': Flag, 'course.archived': Archive, 'goal.unreadable': CircleAlert }

function stepIcon(step: NextStep): LucideIcon {
  if (step.actor === 'learner') return Footprints
  if (step.actor === 'teacher') return GraduationCap
  return WAITING_ICON[step.key] ?? Hourglass
}

/** 隔了 9 天回来。上次（10月2日）做了 1.2 的小测。 */
function backText(back: NonNullable<NextStep['back']>): string {
  const date = new Date(back.at)
  return `隔了 ${back.days} 天回来。上次（${date.getMonth() + 1}月${date.getDate()}日）${back.last}。`
}

function openTest(testId: string): void {
  shell.openPage('assess.test', { id: testId }, { title: '测试' })
}

/** The check suggested beside the step: take it now, or not today. */
function ReviewRow({ review, onChanged }: { review: ReviewSuggestion; onChanged(): void }): ReactNode {
  const start = useAction(), later = useAction()
  return (
    <div className="la-next-extra">
      <History size={16} strokeWidth={1.75} />
      <div className="la-next-extra-body">
        <div className="la-next-extra-title">可以复查：{review.title}</div>
        <div className="la-next-extra-sub">{review.reason}</div>
        <ErrorText error={start.error ?? later.error} />
      </div>
      <Button size="sm" variant="quiet" loading={later.busy} onClick={() => void later.run(async () => {
        await shell.call('planner', 'defer', { courseId: review.courseId })
        onChanged()
      })}>今天先不做</Button>
      <Button size="sm" loading={start.busy} title="出一道你没做过的题，独立做完交卷" onClick={() => void start.run(async () => {
        const test = await shell.call<Test>('planner', 'check', { courseId: review.courseId, nodeId: review.nodeId })
        openTest(test.id)
      })}>做一道</Button>
    </div>
  )
}

/** The course's next step; `away` when shown somewhere other than the progress page (a new tab), so it always links there. */
function NextSection({ courseId, away }: { courseId: string; away?: boolean }): ReactNode {
  const next = useLoad(shell, () => shell.call<NextStep>('planner', 'next', { courseId }), [courseId])
  if (!next.data) return next.loading ? <Skeleton lines={2} /> : null
  const step = next.data
  const learner = step.actor === 'learner'
  const action = stepAction(step)
  const here = !away && step.page === 'curriculum.progress' && step.actor !== 'teacher'
  const Icon = stepIcon(step)
  return (
    <div>
      <section className={`la-next${learner ? ' learner' : ''}`}>
        <span className="la-next-icon"><Icon size={20} strokeWidth={1.75} /></span>
        <div className="la-next-body">
          <div className="la-next-kicker">{learner ? '下一步 · 轮到你' : step.actor === 'teacher' ? '下一步 · 主老师在做' : '下一步'}</div>
          <div className="la-next-title">{step.title}</div>
          <div className="la-next-detail">{step.actor === 'teacher' ? '主老师会接着做这一步，做完会在对话里告诉你。' : step.detail}{here && learner ? '就在本页下方。' : ''}</div>
          {step.back && <div className="la-next-countdown"><Undo2 size={14} strokeWidth={1.75} />{backText(step.back)}</div>}
          {step.countdown && <div className="la-next-countdown"><CalendarClock size={14} strokeWidth={1.75} />{countdownText(step.countdown)}</div>}
          {step.countdown?.pace && <div className={`la-next-pace ${step.countdown.pace.verdict}`}>{step.countdown.pace.text}</div>}
        </div>
        {action && !here && (
          <div className="la-next-actions">
            <Button variant={learner ? 'primary' : 'default'} icon={ArrowRight} onClick={action.open}>{action.label}</Button>
          </div>
        )}
      </section>
      {step.unfinished?.length ? (
        <div className="la-next-extras">
          {step.unfinished.map(test => (
            <div key={test.testId} className="la-next-extra">
              <ClipboardList size={16} strokeWidth={1.75} />
              <div className="la-next-extra-body">
                <div className="la-next-extra-title">{test.title}</div>
                <div className="la-next-extra-sub">还没做完 · {new Date(test.startedAt).toLocaleDateString('zh-CN')} 发布</div>
              </div>
              {test.running && <Tag tone="warn">计时中</Tag>}
              <Button size="sm" opens onClick={() => openTest(test.testId)}>继续</Button>
            </div>
          ))}
        </div>
      ) : null}
      {step.review && <div className="la-next-extras"><ReviewRow review={step.review} onChanged={next.reload} /></div>}
    </div>
  )
}

type HomeRow = { course: Course; next: NextStep | null; error?: string; activeAt?: string }
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
  // A test with its clock running first: the time is passing.
  // A test whose clock runs first; then the course studied most recently.
  const recent = [...rows].sort((a, b) => (b.activeAt ?? b.course.createdAt).localeCompare(a.activeAt ?? a.course.createdAt))
  const waiting = recent.find(row => row.next?.key.startsWith('test.timed:')) ?? recent.find(row => row.next?.actor === 'learner')
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
            <div className="la-hero-detail">{waiting.next.back ? `${backText(waiting.next.back)}` : ''}{waiting.next.detail}</div>
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
  const { course, next, overview, error } = row
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
          {next.actor !== 'none' && <Tag tone={next.actor === 'learner' ? 'accent' : 'neutral'}>{next.actor === 'learner' ? '轮到你' : '主老师'}</Tag>}
          <span>{next.title}</span>
          {next.countdown && next.countdown.days >= 0 && <span className="la-course-countdown">距{next.countdown.label} {next.countdown.days < 14 ? `${next.countdown.days} 天` : `${Math.floor(next.countdown.days / 7)} 周`}</span>}
          {next.countdown?.pace?.verdict === 'late' && <Tag tone="warn">照节奏赶不上</Tag>}
        </div>
      )}
      {next?.unfinished?.length ? <div className="la-course-note"><ClipboardList size={14} strokeWidth={1.75} /><span>还有 {next.unfinished.length} 份测试没做完</span></div> : null}
      {next?.review && <div className="la-course-note"><History size={14} strokeWidth={1.75} /><span>可以复查：{next.review.title}</span></div>}
      {!next && error && <ErrorText error={`读不出下一步：${error}`} />}
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
/** The top of a new tab: in a course, its next step; on the main interface, each course's. */
function ContinueSection({ scope }: { scope: ShellScope }): ReactNode {
  const home = useLoad(shell, () => (scope.kind === 'main' ? shell.call<HomeRow[]>('planner', 'home') : Promise.resolve([])), [scope.kind])
  if (scope.kind === 'course') return <Section title="继续学习" icon={Footprints}><NextSection courseId={scope.courseId} away /></Section>
  if (!home.data) return home.loading ? <Skeleton lines={2} /> : null
  const rows = home.data
  return (
    <Section title="继续学习" icon={Footprints}>
      {rows.length === 0 ? <EmptyState compact icon={GraduationCap} title="还没有课程" description="在首页新建一门课。" /> : (
        <div className="la-rows">
          {rows.map(({ course, next }) => (
            <button key={course.id} type="button" className="la-row-item interactive" onClick={() => shell.enterCourse(course.id)}>
              <span className="la-row-icon accent la-strong">{Array.from(course.title)[0]}</span>
              <span className="la-row-main">
                <span className="la-row-title">{course.title}</span>
                {next && <span className="la-row-sub">下一步：{next.title}</span>}
              </span>
              {next?.actor === 'learner' && <Tag tone="accent">轮到你</Tag>}
            </button>
          ))}
        </div>
      )}
    </Section>
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
    <button type="button" className={`la-status-item${step.actor === 'learner' ? ' accent' : ''}`} title={action ? `${step.title}（${action.label}）` : step.title} data-la-opens="" onClick={action?.open}>
      <Footprints size={13} strokeWidth={1.75} />
      <span className="la-ellipsis" style={{ maxWidth: 320 }}>下一步：{step.title}</span>
    </button>
  )
}
