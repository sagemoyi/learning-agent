// planner unit, browser half: the home page (courses and their next step) and the "next step"
// section at the top of the course progress page.
import { useState, type ReactNode } from 'react'
import type { Course, NextStep } from '@learning-agent/contracts'
import type { ClientContext, LearnShell } from '@learning-agent/contracts/client'
import { useAction, useLoad } from '@learning-agent/kit/client'

export const name = 'learning-planner'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'home', title: '首页', glyph: '首', scope: 'main', page: 'planner.home', order: 10 }), 'planner: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'planner.home' }, HomePage)), 'planner: home page')
  ctx.effect(() => ctx.slots.inject('learning.course-section', () => ctx.slots.register({ name: 'learning.course-section', id: 'next', order: 5 }, NextSection)), 'planner: next-step section')
}

const PAGE_TITLE: Record<string, string> = {
  'tutor.chat': '主老师', 'curriculum.progress': '课程进度', 'library.sources': '资料库', 'assess.test': '测试', 'textbook.reader': '课程教材',
}

function openStep(step: NextStep): void {
  if (step.page) shell.openPage(step.page, { ...(step.params ?? {}) }, { title: PAGE_TITLE[step.page] ?? step.page })
}

function StepLine({ step }: { step: NextStep }): ReactNode {
  return (
    <div className="la-row">
      <span className={`la-tag ${step.actor === 'learner' ? 'accent' : ''}`}>{step.actor === 'learner' ? '轮到你' : '主老师'}</span>
      <b>{step.title}</b>
      {step.page && <button className="la-link" onClick={() => openStep(step)}>去{PAGE_TITLE[step.page] ?? '看看'}</button>}
    </div>
  )
}

function NextSection({ courseId }: { courseId: string }): ReactNode {
  const next = useLoad(shell, () => shell.call<NextStep>('planner', 'next', { courseId }), [courseId])
  if (!next.data) return null
  return (
    <section className="la-card la-stack is-active" style={{ gap: 4 }}>
      <div className="la-h2">下一步</div>
      <StepLine step={next.data} />
      <div className="la-muted">{next.data.actor === 'learner' ? next.data.detail : '在"主老师"里跟老师说一声"继续"就好。'}</div>
    </section>
  )
}

function HomePage(): ReactNode {
  const home = useLoad(shell, () => shell.call<{ course: Course; next: NextStep | null }[]>('planner', 'home'), [])
  const [title, setTitle] = useState('')
  const create = useAction()
  return (
    <div className="la-pad la-stack">
      <div>
        <div className="la-h1">首页</div>
        <div className="la-muted">你的课程和每门课的下一步。</div>
      </div>
      {home.error && <div className="la-error">{home.error}</div>}
      {home.data?.length === 0 && <div className="la-muted">还没有课程。在下面新建一门。</div>}
      {home.data?.map(({ course, next }) => (
        <div key={course.id} className="la-card la-stack" style={{ gap: 6 }}>
          <div className="la-row">
            <b style={{ fontSize: 15 }}>{course.title}</b>
            <span className="la-spacer" />
            <button className="la-btn la-btn-primary" onClick={() => shell.enterCourse(course.id)}>进入课程</button>
          </div>
          {next && <div className="la-row la-small"><span className={`la-tag ${next.actor === 'learner' ? 'accent' : ''}`}>{next.actor === 'learner' ? '轮到你' : '主老师'}</span>{next.title}</div>}
        </div>
      ))}
      <div className="la-card la-stack">
        <div className="la-h2">新建课程</div>
        <div className="la-row">
          <input className="la-input" style={{ flex: 1 }} placeholder="课程名，例如：化工原理" value={title} onChange={event => setTitle(event.target.value)} />
          <button className="la-btn la-btn-primary" disabled={!title.trim() || create.busy} onClick={() => void create.run(async () => {
            const course = await shell.call<Course>('core', 'createCourse', { title: title.trim() })
            setTitle('')
            shell.enterCourse(course.id)
          })}>新建</button>
        </div>
        <div className="la-muted la-small">一门课对应学习库里的一个文件夹，可以直接用 Obsidian 打开。</div>
        {create.error && <div className="la-error">{create.error}</div>}
      </div>
    </div>
  )
}
