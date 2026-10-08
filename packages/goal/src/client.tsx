// goal unit, browser half: the goal section of the course progress page and the candidate-endpoint
// card in the teacher chat. A draft is shown in full with what changed since the learner last
// confirmed it; a confirmed goal folds to its purpose and conditions. Facts the teacher only guessed
// are marked; the learner confirms or sets facts and answers the source checklist in place
// (docs/goal/design.md).
import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronUp, History, Library, PenLine, Target } from 'lucide-react'
import { conditionWords, type CitedChunk, type GoalFact, type GoalView, type Stage, type TestConditions } from '@learning-agent/contracts'
import type { ChatCardProps, ClientContext, LearnShell } from '@learning-agent/contracts/client'
import { Button, Callout, DateField, Disclosure, ErrorText, NumberField, Section, Segmented, Select, Skeleton, Tag, friendlyTime, useAction, useLoad, useLocalState } from '@learning-agent/kit/client'

export const name = 'learning-goal'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.slots.inject('learning.course-section', () => ctx.slots.register({ name: 'learning.course-section', id: 'goal', order: 10 }, GoalSection)), 'goal: progress section')
  ctx.effect(() => ctx.slots.inject('learning.chat-card', () => ctx.slots.register({ name: 'learning.chat-card', key: 'offer_goal_options' }, OptionsCard)), 'goal: candidate endpoints card')
}

type Goal = GoalView['doc']['goal']
type Fact = GoalView['facts'][number]

const FOCUS: Record<NonNullable<Goal['exam']>['focus'], string> = { pass: '只求通过', balanced: '兼顾分数和理解', understanding: '以理解为主' }
const ACTOR: Record<GoalView['history'][number]['actor'], string> = { teacher: '老师', user: '你', system: '系统' }
const ROLE: Record<GoalView['sources'][number]['role'], string> = { skeleton: '骨架教材', reference: '参考', 'exam-archive': '往年题' }

function hoursText(goal: Goal): string | undefined {
  const hours = goal.boundaries.hoursPerWeek
  return goal.boundaries.timeBudget ?? (hours && (hours.min === hours.max ? `每周 ${hours.min} 小时` : `每周 ${hours.min}–${hours.max} 小时`))
}

function GoalSection({ courseId }: { courseId: string }): ReactNode {
  const view = useLoad(shell, () => shell.call<GoalView | null>('goal', 'view', { courseId }), [courseId])
  const overview = useLoad(shell, () => shell.call<{ stages: Stage[] }>('curriculum', 'overview', { courseId }).catch(() => ({ stages: [] })), [courseId])
  const stages = overview.data?.stages ?? []
  const action = useAction()
  const [expanded, setExpanded] = useLocalState(`goal:expanded:${courseId}`, false)
  const [editing, setEditing] = useState<GoalFact | null>(null)
  const data = view.data
  const goal = data?.doc.goal
  if (view.loading && !data) return <Skeleton lines={2} />
  if (!data || !goal) {
    return (
      <Section title="目标说明" icon={Target} card>
        <ErrorText error={view.error} />
        {!view.error && <div className="la-muted">还没有目标说明。打开"主老师"，说说你想学到什么程度，老师会给出几个候选终点让你挑。</div>}
      </Section>
    )
  }
  const draft = goal.status === 'draft'
  const open = draft || expanded
  const pending = data.facts.filter(fact => fact.basis === 'assumed')
  const wanted = data.sources.filter(need => need.state === 'wanted')
  const factOf = (key: GoalFact) => data.facts.find(fact => fact.fact === key)
  const setFacts = (edit: Record<string, unknown>) => action.run(async () => {
    await shell.call('goal', 'setFacts', { courseId, version: goal.version, ...edit })
    setEditing(null)
  })
  const row = (key: GoalFact, label: string, value: ReactNode, editor?: ReactNode) => (
    <FactRow key={key} label={label} fact={factOf(key)} value={value} editing={editing === key} editor={editor}
      editable={editor !== undefined} busy={action.busy}
      onEdit={() => setEditing(key)} onConfirm={() => void setFacts({ confirm: [key] })} />
  )
  const exam = goal.exam
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
            {conditionWords(goal.boundaries.defaultConditions).map(item => <Tag key={item}>{item}</Tag>)}
            {exam?.date && <Tag tone="accent">考试 {exam.date}</Tag>}
            {goal.deadline && <Tag tone="accent">期限 {goal.deadline}</Tag>}
            {pending.length > 0 && <Tag tone="warn">{pending.length} 项待确认</Tag>}
            {wanted.length > 0 && <Tag tone="warn">{wanted.length} 份资料等你提供</Tag>}
            {data.changes.length > 0 && <Tag tone="accent">老师改过 {data.changes.length} 处</Tag>}
          </div>
        </div>
      )}
      {open && (
        <div className="la-stack" style={{ gap: 16 }}>
          <dl className="la-facts la-goal-facts">
            <dt>目的</dt><dd><Inline text={goal.purpose} /></dd>
            <dt>场景</dt><dd><Inline text={goal.scenario} /></dd>
            <dt>学成后能做</dt>
            <dd><ul>{goal.canDo.map(item => {
              const covered = stages.filter(stage => stage.supports.includes(item.key))
              return (
                <li key={item.key}><Inline text={item.text} />
                  {item.evidence && <div className="la-faint la-small">验证：<Inline text={item.evidence} /></div>}
                  {stages.length > 0 && <div className="la-small">{covered.length ? <span className="la-muted">{covered.map(stage => `第 ${stage.index} 阶段`).join('、')}</span> : <span className="la-goal-uncovered">还没有阶段对应</span>}</div>}
                </li>
              )
            })}</ul></dd>
            <dt>程度</dt><dd><Inline text={goal.level} /></dd>
            <dt>验证方式</dt><dd><Inline text={goal.verification} /></dd>
            <dt>不学</dt><dd>{goal.boundaries.exclude.length ? <Inline text={goal.boundaries.exclude.join('、')} /> : <span className="la-faint">—</span>}</dd>
            {row('conditions', '测试条件', <ConditionTags value={goal.boundaries.defaultConditions} />,
              <ConditionsEditor value={goal.boundaries.defaultConditions} busy={action.busy} onSave={value => void setFacts({ conditions: value })} onCancel={() => setEditing(null)} />)}
            {row('hours', '每周投入', hoursText(goal) ?? <span className="la-faint">—</span>,
              <HoursEditor value={goal.boundaries.hoursPerWeek} busy={action.busy} onSave={value => void setFacts({ hours: value })} onCancel={() => setEditing(null)} />)}
            {row('deadline', '最后期限', goal.deadline ?? <span className="la-faint">—</span>,
              <DateEditor value={goal.deadline} label="最后期限" busy={action.busy} onSave={value => void setFacts({ deadline: value })} onCancel={() => setEditing(null)} />)}
          </dl>
          {exam && (
            <div className="la-stack tight">
              <div className="la-goal-subhead">考试</div>
              <dl className="la-facts la-goal-facts">
                {row('exam.date', '考试日期', exam.date ?? <span className="la-faint">—</span>,
                  <DateEditor value={exam.date} label="考试日期" busy={action.busy} onSave={value => void setFacts({ examDate: value })} onCancel={() => setEditing(null)} />)}
                {row('exam.scope', '考试范围', <><Inline text={exam.scope || '（未写）'} />{exam.sections.length > 0 && <div className="la-faint la-small">小节 {exam.sections.join('、')}</div>}</>)}
                {exam.format.length > 0 && row('exam.format', '题型和分值', <ul>{exam.format.map((item, i) => <li key={i}>{item.type}{item.points === undefined ? '' : ` ${item.points} 分`}{item.note && <span className="la-faint">（{item.note}）</span>}</li>)}</ul>)}
                {exam.grading && row('exam.grading', '成绩构成', <Inline text={exam.grading} />)}
                {row('exam.conditions', '考试条件', <ConditionTags value={exam.conditions} />,
                  <ConditionsEditor value={exam.conditions} timed busy={action.busy} onSave={value => void setFacts({ examConditions: value })} onCancel={() => setEditing(null)} />)}
                <dt>往年题</dt><dd>{data.pastPapers.length ? data.pastPapers.map(paper => paper.title).join('、') : <span className="la-faint">还没有</span>}</dd>
                <dt>侧重</dt><dd>{FOCUS[exam.focus]}</dd>
              </dl>
            </div>
          )}
          {(data.sources.length > 0 || data.courseSources.length > 0) && <Checklist courseId={courseId} view={data} />}
          {data.doc.body.trim() && <Disclosure summary="完整说明"><shell.Markdown text={data.doc.body} /></Disclosure>}
          {!draft && data.changes.length > 0 && (
            <Callout tone="accent" icon={History} title={`你确认后老师改过 ${data.changes.length} 处`}
              actions={<Button loading={action.busy} onClick={() => void action.run(() => shell.call('goal', 'acknowledge', { courseId, version: goal.version }))}>知道了</Button>}>
              <Changes view={data} />
            </Callout>
          )}
          {draft && (
            <Callout tone="accent" icon={Target} title={data.changes.length ? '目标改过了，再确认一次？' : '目标商定好了吗？'}
              actions={<Button variant="primary" icon={Check} loading={action.busy} onClick={() => void action.run(() => shell.call('goal', 'confirm', { courseId }))}>确认目标</Button>}>
              <div className="la-stack tight">
                {data.changes.length > 0 && <Changes view={data} />}
                <div>{data.changes.length ? '确认后老师按新的目标继续。' : '确认后老师会开始摸底。'}有要改的地方，直接告诉主老师。</div>
                {pending.length > 0 && <div className="la-muted">其中{pending.map(fact => `「${fact.label}」`).join('')}是老师的推测，确认目标后也可以随时在这里改。</div>}
                {wanted.length > 0 && <div className="la-muted">资料清单里还有 {wanted.length} 份等你提供，确认目标后再补也可以。</div>}
              </div>
            </Callout>
          )}
          <ErrorText error={action.error} />
          {data.history.length > 1 && (
            <Disclosure summary={`版本记录（${data.history.length}）`}>
              <div className="la-rows">
                {data.history.map(version => (
                  <div className="la-row-item" key={`${version.version}-${version.at}`}>
                    <div className="la-row-main">
                      <span>第 {version.version} 版 · {ACTOR[version.actor]} · {friendlyTime(version.at)}</span>
                      <span className="la-row-sub">{version.reason}</span>
                    </div>
                    {version.status === 'confirmed' && <Tag tone="ok">已确认</Tag>}
                  </div>
                ))}
              </div>
            </Disclosure>
          )}
        </div>
      )}
    </Section>
  )
}

/** The source checklist: what the course already has, and what it still needs from the learner or the teacher. */
function Checklist({ courseId, view }: { courseId: string; view: GoalView }): ReactNode {
  const action = useAction()
  const version = view.doc.goal.version
  const used = new Set<string>(view.sources.flatMap(need => (need.sourceId ? [need.sourceId] : [])))
  const answer = (key: string, value: { sourceId?: string | null; missing?: boolean }) => void action.run(() => shell.call('goal', 'setSource', { courseId, version, key, ...value }))
  return (
    <div className="la-stack tight">
      <div className="la-goal-subhead">资料清单</div>
      {view.courseSources.length > 0 && <div className="la-muted la-small">本课已有：{view.courseSources.map(source => `《${source.title}》（${ROLE[source.role]}）`).join('、')}</div>}
      {view.sources.length > 0 && (
        <div className="la-rows">
          {view.sources.map(need => {
            const choices = view.courseSources.filter(source => !used.has(source.id))
            return (
              <div className="la-row-item" key={need.key}>
                <div className="la-row-main">
                  <span>{need.what}<span className="la-faint la-small">（{ROLE[need.role]}）</span></span>
                  {need.why && <span className="la-row-sub"><Inline text={need.why} /></span>}
                </div>
                <div className="la-goal-need-actions">
                  {need.state === 'have' && <><Tag tone="ok" icon={Check}>已有《{need.title}》</Tag><Button size="sm" variant="quiet" disabled={action.busy} onClick={() => answer(need.key, { sourceId: null })}>不是这份</Button></>}
                  {need.state === 'missing' && <><Tag>你说没有</Tag><Button size="sm" variant="quiet" disabled={action.busy} onClick={() => answer(need.key, { missing: false })}>其实有</Button></>}
                  {need.state === 'teacher' && <Tag>老师会联网找</Tag>}
                  {need.state === 'wanted' && <Tag tone="warn">等你提供</Tag>}
                  {need.state !== 'have' && need.state !== 'missing' && <>
                    {choices.length > 0 && <Select<string> value="" placeholder="就是这份…" width={150} aria-label={`本课资料里哪一份是${need.what}`} options={choices.map(source => ({ value: source.id, label: source.title }))} onChange={sourceId => answer(need.key, { sourceId })} disabled={action.busy} />}
                    {need.state === 'wanted' && <Button size="sm" variant="quiet" icon={Library} onClick={() => shell.openPage('library.sources', {}, { title: '资料库' })}>去资料库加入</Button>}
                    {need.state === 'wanted' && <Button size="sm" variant="quiet" disabled={action.busy} onClick={() => answer(need.key, { missing: true })}>没有这份</Button>}
                  </>}
                </div>
              </div>
            )
          })}
        </div>
      )}
      <ErrorText error={action.error} />
    </div>
  )
}

interface Option {
  readonly title: string
  readonly canDo?: readonly string[]
  readonly sample?: { readonly chunkId: string; readonly stem: string; readonly reach: string }
  readonly cost?: string
  readonly feel?: string
}

/** The teacher's candidate endpoints as cards; a pick is a message, so the conversation stays the record. */
function OptionsCard({ args, reply, send, fill }: ChatCardProps): ReactNode {
  const options = (Array.isArray(args.options) ? args.options : []) as Option[]
  const chunkIds = options.flatMap(option => (option.sample?.chunkId ? [option.sample.chunkId] : []))
  const citations = useLoad(shell, async () => Object.fromEntries(await Promise.all(chunkIds.map(async id => [id, (await shell.call<CitedChunk | null>('library', 'chunk', { chunkId: id }).catch(() => null))?.citation ?? '出处'] as const))), [chunkIds.join(',')], [])
  const chosen = reply ? options.find(option => reply.includes(`「${option.title}」`)) : undefined
  return (
    <div className="la-stack tight">
      {typeof args.intro === 'string' && args.intro && <div><Inline text={args.intro} /></div>}
      <div className="la-goal-options">
        {options.map(option => {
          const picked = chosen === option
          return (
            <div key={option.title} className={`la-goal-option${picked ? ' is-chosen' : reply ? ' is-dim' : ''}`}>
              <div className="la-goal-option-head">
                <span className="la-goal-option-title">{option.title}</span>
                {option.title === args.recommended && !reply && <Tag tone="accent">推荐</Tag>}
                {picked && <Tag tone="ok" icon={Check}>你选了这个</Tag>}
              </div>
              {option.canDo && option.canDo.length > 0 && <ul className="la-goal-option-list">{option.canDo.map((item, i) => <li key={i}><Inline text={item} /></li>)}</ul>}
              {option.sample && (
                <div className="la-goal-option-sample">
                  <div className="la-faint la-small">样题 <Inline text={`[${citations.data?.[option.sample.chunkId] ?? '出处'}](cite:${option.sample.chunkId})`} /></div>
                  <div><Inline text={option.sample.stem} /></div>
                  <div className="la-muted la-small">学成后：<Inline text={option.sample.reach} /></div>
                </div>
              )}
              {option.cost && <div className="la-muted la-small">取舍：<Inline text={option.cost} /></div>}
              {option.feel && <div className="la-faint la-small"><Inline text={option.feel} /></div>}
              {!reply && (
                <div className="la-goal-option-actions">
                  <Button size="sm" variant="primary" icon={Check} onClick={() => send(`我选「${option.title}」。`)}>选这个</Button>
                  <Button size="sm" variant="quiet" icon={PenLine} onClick={() => fill(`我选「${option.title}」，不过`)}>改一改</Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {reply && !chosen && <div className="la-faint la-small">你已经回复了老师。</div>}
    </div>
  )
}

/** One fact in the definition list: value, where it came from, and the learner's actions. */
function FactRow({ label, fact, value, editing, editor, editable, busy, onEdit, onConfirm }: {
  label: string; fact?: Fact; value: ReactNode; editing: boolean; editor?: ReactNode; editable: boolean; busy: boolean
  onEdit(): void; onConfirm(): void
}): ReactNode {
  const assumed = fact?.basis === 'assumed'
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {editing ? editor : (
          <div className="la-goal-fact">
            <div className="la-goal-fact-value">
              {value}
              {fact?.basis === 'official' && fact.citation && <div className="la-faint la-small">依据{/《[^》]+》/.exec(fact.citation)?.[0] ?? ''} <Inline text={`[${fact.citation}](cite:${fact.chunkId})`} /></div>}
            </div>
            <div className="la-goal-fact-actions">
              {assumed && <Tag tone="warn" title="老师推测的，还没经你确认">待确认</Tag>}
              {assumed && <Button size="sm" variant="quiet" icon={Check} disabled={busy} onClick={onConfirm} title="就是这样">对</Button>}
              {editable && <Button size="sm" variant="quiet" icon={PenLine} disabled={busy} onClick={onEdit} title={`修改${label}`}>{fact ? '改' : '设置'}</Button>}
            </div>
          </div>
        )}
      </dd>
    </>
  )
}

function Changes({ view }: { view: GoalView }): ReactNode {
  return (
    <div className="la-stack tight">
      <ul className="la-goal-changes">
        {view.changes.map((change, i) => (
          <li key={i}>
            <span className="la-goal-change-label">{change.label}</span>
            {change.before === undefined ? <span>新增：<Inline text={change.after ?? ''} /></span>
              : change.after === undefined ? <span className="la-muted">去掉：<Inline text={change.before} /></span>
              : change.label === '完整说明' ? <span>有改动</span>
              : <span><span className="la-muted"><Inline text={change.before} /></span> → <Inline text={change.after} /></span>}
          </li>
        ))}
      </ul>
      {view.impacts.length > 0 && <div className="la-muted la-small">会影响：{view.impacts.join('；')}。</div>}
    </div>
  )
}

function ConditionTags({ value }: { value: TestConditions }): ReactNode {
  return <span className="la-row" style={{ gap: 6 }}>{conditionWords(value).map(item => <Tag key={item}>{item}</Tag>)}</span>
}

function EditorActions({ busy, disabled, onSave, onCancel, extra }: { busy: boolean; disabled?: boolean; onSave(): void; onCancel(): void; extra?: ReactNode }): ReactNode {
  return (
    <div className="la-row" style={{ gap: 8 }}>
      <Button size="sm" variant="primary" loading={busy} disabled={disabled} onClick={onSave}>保存</Button>
      <Button size="sm" variant="quiet" disabled={busy} onClick={onCancel}>取消</Button>
      {extra}
    </div>
  )
}

function ConditionsEditor({ value, timed, busy, onSave, onCancel }: { value: TestConditions; timed?: boolean; busy: boolean; onSave(value: TestConditions): void; onCancel(): void }): ReactNode {
  const [next, setNext] = useState(value)
  return (
    <div className="la-goal-editor">
      <div className="la-row" style={{ gap: 8 }}>
        <Segmented aria-label="开卷还是闭卷" value={next.book} options={[{ value: 'closed', label: '闭卷' }, { value: 'open', label: '开卷' }]} onChange={book => setNext({ ...next, book })} />
        <Segmented aria-label="计算器" value={next.calculator ? 'yes' : 'no'} options={[{ value: 'yes', label: '可用计算器' }, { value: 'no', label: '不用计算器' }]} onChange={choice => setNext({ ...next, calculator: choice === 'yes' })} />
        <Segmented aria-label="公式表" value={next.formulaSheet ? 'yes' : 'no'} options={[{ value: 'no', label: '不带公式表' }, { value: 'yes', label: '可带公式表' }]} onChange={choice => setNext({ ...next, formulaSheet: choice === 'yes' })} />
      </div>
      {timed && (
        <div className="la-row" style={{ gap: 8 }}>
          <span className="la-muted la-small">考试时长</span>
          <NumberField aria-label="考试时长（分钟）" value={next.timeLimit ?? 0} min={0} max={600} step={10} onChange={minutes => setNext({ ...next, timeLimit: minutes || undefined })} />
          <span className="la-muted la-small">分钟（0 表示不限时）</span>
        </div>
      )}
      <EditorActions busy={busy} onSave={() => onSave(next)} onCancel={onCancel} />
    </div>
  )
}

function HoursEditor({ value, busy, onSave, onCancel }: { value?: { min: number; max: number }; busy: boolean; onSave(value: { min: number; max: number } | null): void; onCancel(): void }): ReactNode {
  const [next, setNext] = useState(value ?? { min: 4, max: 6 })
  return (
    <div className="la-goal-editor">
      <div className="la-row" style={{ gap: 8 }}>
        <span className="la-muted la-small">每周</span>
        <NumberField aria-label="每周最少小时数" value={next.min} min={1} max={80} onChange={min => setNext({ min, max: Math.max(min, next.max) })} />
        <span className="la-muted la-small">到</span>
        <NumberField aria-label="每周最多小时数" value={next.max} min={1} max={80} onChange={max => setNext({ min: Math.min(next.min, max), max })} />
        <span className="la-muted la-small">小时</span>
      </div>
      <EditorActions busy={busy} onSave={() => onSave(next)} onCancel={onCancel} extra={value && <Button size="sm" variant="quiet" disabled={busy} onClick={() => onSave(null)}>不设</Button>} />
    </div>
  )
}

function DateEditor({ value, label, busy, onSave, onCancel }: { value?: string; label: string; busy: boolean; onSave(value: string | null): void; onCancel(): void }): ReactNode {
  const [next, setNext] = useState(value ?? '')
  return (
    <div className="la-goal-editor">
      <DateField aria-label={label} value={next} autoFocus onChange={setNext} onEnter={() => { if (next) onSave(next) }} />
      <EditorActions busy={busy} disabled={!next} onSave={() => onSave(next)} onCancel={onCancel} extra={value && <Button size="sm" variant="quiet" disabled={busy} onClick={() => onSave(null)}>去掉</Button>} />
    </div>
  )
}

/** Goal fields are short Markdown (formulas as $…$). */
function Inline({ text }: { text: string }): ReactNode {
  return <shell.Markdown text={text} inline />
}
