// goal unit, browser half: the goal section of the course progress page.
import type { ReactNode } from 'react'
import type { GoalDoc } from '@learning-agent/contracts'
import type { ClientContext, LearnShell } from '@learning-agent/contracts/client'
import { useAction, useLoad } from '@learning-agent/kit/client'

export const name = 'learning-goal'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.slots.inject('learning.course-section', () => ctx.slots.register({ name: 'learning.course-section', id: 'goal', order: 10 }, GoalSection)), 'goal: progress section')
}

function GoalSection({ courseId }: { courseId: string }): ReactNode {
  const doc = useLoad(shell, () => shell.call<GoalDoc | null>('goal', 'get', { courseId }), [courseId], ['learning/doc-changed', 'learning/goal-confirmed'])
  const action = useAction()
  const goal = doc.data?.goal
  return (
    <section className="la-card la-stack">
      <div className="la-row">
        <span className="la-h2">目标说明</span>
        {goal && <span className={`la-tag ${goal.status === 'confirmed' ? 'ok' : 'warn'}`}>{goal.status === 'confirmed' ? '已确认' : '草稿'}</span>}
      </div>
      {doc.error && <div className="la-error">{doc.error}</div>}
      {!goal && !doc.loading && !doc.error && <div className="la-muted">还没有目标说明。打开"主老师"，说说你想学到什么程度。</div>}
      {goal && (
        <>
          <dl className="la-stack" style={{ gap: 4, margin: 0 }}>
            <Field label="目的"><Inline text={goal.purpose} /></Field>
            <Field label="场景"><Inline text={goal.scenario} /></Field>
            <Field label="学成后能做">{goal.canDo.map(item => <div key={item}>· <Inline text={item} /></div>)}</Field>
            <Field label="程度"><Inline text={goal.level} /></Field>
            <Field label="验证方式"><Inline text={goal.verification} /></Field>
            <Field label="不学">{goal.boundaries.exclude.length ? <Inline text={goal.boundaries.exclude.join('、')} /> : '—'}</Field>
            <Field label="测试条件">
              {goal.boundaries.defaultConditions.book === 'closed' ? '闭卷' : '开卷'}，
              {goal.boundaries.defaultConditions.calculator ? '可用计算器' : '不用计算器'}，
              {goal.boundaries.defaultConditions.formulaSheet ? '可带公式表' : '不带公式表'}
            </Field>
            {goal.boundaries.timeBudget && <Field label="时间投入">{goal.boundaries.timeBudget}</Field>}
            {goal.deadline && <Field label="最后期限">{goal.deadline}</Field>}
          </dl>
          {doc.data?.body.trim() && <details><summary className="la-muted">说明</summary><shell.Markdown text={doc.data.body} /></details>}
          {goal.status === 'draft' && (
            <div className="la-row">
              <button className="la-btn la-btn-primary" disabled={action.busy} onClick={() => void action.run(() => shell.call('goal', 'confirm', { courseId }))}>确认目标</button>
              <span className="la-muted la-small">有要改的地方，直接告诉主老师。</span>
            </div>
          )}
          {action.error && <div className="la-error">{action.error}</div>}
        </>
      )}
    </section>
  )
}

/** Goal fields are short Markdown (formulas as $…$). */
function Inline({ text }: { text: string }): ReactNode {
  return <shell.Markdown text={text} inline />
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: 8 }}>
      <dt className="la-muted">{label}</dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </div>
  )
}
