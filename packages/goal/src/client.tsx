// goal unit, browser half: the goal section of the course progress page. A draft is shown in full
// with its confirm action; a confirmed goal folds to its purpose and test conditions.
import type { ReactNode } from 'react'
import { Check, ChevronDown, ChevronUp, Target } from 'lucide-react'
import type { GoalDoc } from '@learning-agent/contracts'
import type { ClientContext, LearnShell } from '@learning-agent/contracts/client'
import { Button, Callout, Disclosure, ErrorText, Section, Skeleton, Tag, useAction, useLoad, useLocalState } from '@learning-agent/kit/client'

export const name = 'learning-goal'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.slots.inject('learning.course-section', () => ctx.slots.register({ name: 'learning.course-section', id: 'goal', order: 10 }, GoalSection)), 'goal: progress section')
}

type Goal = NonNullable<GoalDoc['goal']>

function conditions(goal: Goal): string[] {
  const c = goal.boundaries.defaultConditions
  return [c.book === 'closed' ? '闭卷' : '开卷', c.calculator ? '可用计算器' : '不用计算器', c.formulaSheet ? '可带公式表' : '不带公式表']
}

function GoalSection({ courseId }: { courseId: string }): ReactNode {
  const doc = useLoad(shell, () => shell.call<GoalDoc | null>('goal', 'get', { courseId }), [courseId], ['learning/doc-changed', 'learning/goal-confirmed'])
  const action = useAction()
  const [expanded, setExpanded] = useLocalState(`goal:expanded:${courseId}`, false)
  const goal = doc.data?.goal
  if (doc.loading && !doc.data) return <Skeleton lines={2} />
  if (!goal) {
    return (
      <Section title="目标说明" icon={Target} card>
        <ErrorText error={doc.error} />
        {!doc.error && <div className="la-muted">还没有目标说明。打开"主老师"，说说你想学到什么程度，老师会给出几个候选终点让你挑。</div>}
      </Section>
    )
  }
  const draft = goal.status === 'draft'
  const open = draft || expanded
  return (
    <Section title="目标说明" icon={Target} card
      actions={<>
        <Tag tone={draft ? 'warn' : 'ok'} icon={draft ? undefined : Check}>{draft ? '草稿，等你确认' : '已确认'}</Tag>
        {!draft && <Button size="sm" variant="quiet" icon={expanded ? ChevronUp : ChevronDown} onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开'}</Button>}
      </>}>
      {!open && (
        <div className="la-stack tight">
          <div className="la-muted"><Inline text={goal.purpose} /></div>
          <div className="la-row" style={{ gap: 6 }}>
            {conditions(goal).map(item => <Tag key={item}>{item}</Tag>)}
            {goal.deadline && <Tag tone="accent">期限 {goal.deadline}</Tag>}
          </div>
        </div>
      )}
      {open && (
        <div className="la-stack" style={{ gap: 14 }}>
          <dl className="la-facts">
            <dt>目的</dt><dd><Inline text={goal.purpose} /></dd>
            <dt>场景</dt><dd><Inline text={goal.scenario} /></dd>
            <dt>学成后能做</dt><dd><ul>{goal.canDo.map(item => <li key={item}><Inline text={item} /></li>)}</ul></dd>
            <dt>程度</dt><dd><Inline text={goal.level} /></dd>
            <dt>验证方式</dt><dd><Inline text={goal.verification} /></dd>
            <dt>不学</dt><dd>{goal.boundaries.exclude.length ? <Inline text={goal.boundaries.exclude.join('、')} /> : <span className="la-faint">—</span>}</dd>
            <dt>测试条件</dt><dd><span className="la-row" style={{ gap: 6 }}>{conditions(goal).map(item => <Tag key={item}>{item}</Tag>)}</span></dd>
            {goal.boundaries.timeBudget && <><dt>时间投入</dt><dd>{goal.boundaries.timeBudget}</dd></>}
            {goal.deadline && <><dt>最后期限</dt><dd>{goal.deadline}</dd></>}
          </dl>
          {doc.data?.body.trim() && <Disclosure summary="完整说明"><shell.Markdown text={doc.data.body} /></Disclosure>}
          {draft && (
            <Callout tone="accent" icon={Target} title="目标商定好了吗？"
              actions={<Button variant="primary" icon={Check} loading={action.busy} onClick={() => void action.run(() => shell.call('goal', 'confirm', { courseId }))}>确认目标</Button>}>
              确认后老师会开始摸底。有要改的地方，直接告诉主老师。
            </Callout>
          )}
          <ErrorText error={action.error} />
        </div>
      )}
    </Section>
  )
}

/** Goal fields are short Markdown (formulas as $…$). */
function Inline({ text }: { text: string }): ReactNode {
  return <shell.Markdown text={text} inline />
}
