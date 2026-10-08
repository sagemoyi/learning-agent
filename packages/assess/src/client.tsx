// assess unit, browser half: the tests page (sidebar entry with a count of tests waiting for an
// answer; the bank overview and homework marks), the test page, the tests section of the progress page
// and the open-test count in the status bar.
import { useState, type ReactNode } from 'react'
import { ArrowRight, BookCheck, ChevronRight, ClipboardCheck, ClipboardList, Flag, Layers, MessageCircleQuestion, PencilLine, Scale, Send } from 'lucide-react'
import {
  REPORT_REASON_LABEL, TEST_KIND_LABEL, conditionWords,
  type AnswerInput, type BankOverview, type CourseGraph, type Diagnosis, type HomeworkMark, type Lesson, type NodeOutcome, type ProbeState, type ReportReason, type Stage, type StageReport, type Test, type TestView, type Verdict,
} from '@learning-agent/contracts'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext, LearningPageProps, LearnShell, ShellScope } from '@learning-agent/contracts/client'
import {
  Button, Callout, Checkbox, ConfirmButton, Disclosure, EmptyState, ErrorText, Page, PageHeader, Progress, Section, Select, Skeleton, Tag, TextArea, TextField, friendlyTime, useAction, useLoad, useSelection, type Tone,
} from '@learning-agent/kit/client'

export const name = 'learning-assess'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'tests', title: '测试', icon: ClipboardCheck, scope: 'course', page: 'assess.tests', order: 25 }), 'assess: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'assess.tests' }, TestsPage)), 'assess: tests page')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({
    name: 'learning.page',
    key: 'assess.test',
    children: { 'learning.figure': { kind: 'single', scope: 'root' } },
  }, TestPage)), 'assess: test page')
  // The count of tests waiting for an answer, on the sidebar button.
  ctx.effect(() => {
    let generation = 0
    const refresh = async () => {
      const mine = ++generation
      const scope = shell.scope()
      if (scope.kind !== 'course') return
      const rows = await shell.call<TestRow[]>('assess', 'tests', { courseId: scope.courseId }).catch(() => [])
      if (mine === generation) shell.setBadge('tests', rows.filter(row => row.test.status === 'open').length)
    }
    void refresh()
    const offScope = shell.onScope(() => void refresh())
    const offFeed = shell.onFeed(message => { if (message.type === 'learning/test-finished' || message.type === 'learning/task-published') void refresh() })
    return () => {
      offScope()
      offFeed()
    }
  }, 'assess: open-test badge')
  ctx.effect(() => ctx.slots.inject('learning.course-section', () => ctx.slots.register({ name: 'learning.course-section', id: 'assess', order: 40 }, TestsSection)), 'assess: progress section')
  ctx.effect(() => ctx.slots.inject('learning.status', () => ctx.slots.register({ name: 'learning.status', id: 'tests', order: 20 }, OpenTestsStatus)), 'assess: status')
}

const KIND_LABEL = TEST_KIND_LABEL
const VERDICT: Record<Verdict, { text: string; tone: Tone }> = {
  correct: { text: '对', tone: 'ok' },
  partial: { text: '部分对', tone: 'warn' },
  incorrect: { text: '错', tone: 'bad' },
  'pending-review': { text: '待复核', tone: 'warn' },
}

export function openTest(testId: string, title: string): void {
  shell.openPage('assess.test', { id: testId }, { title })
}

function conditionsOf(test: Test): string[] {
  return conditionWords(test.conditions)
}

function scoreTone(correct: number, total: number): Tone {
  return correct === total ? 'ok' : correct === 0 ? 'bad' : 'warn'
}

type TestRow = { test: Test; correct: number; total: number }
type Overview = { stages: (Stage & { lessons: Lesson[] })[] }

/** "1.1 小测", "阶段 2 前测", "摸底": the kind, after the lesson number or the stage. */
function testTitle(test: Test, titles: ReadonlyMap<string, string>): string {
  const number = test.lessonId ? titles.get(test.lessonId) : undefined
  if (number) return `${number} ${KIND_LABEL[test.kind]}`
  const stage = test.stageId ? titles.get(test.stageId) : undefined
  if (stage && test.kind === 'pretest') return `${stage} 前测`
  if (stage && test.kind === 'stage') return `${stage} 测试`
  return KIND_LABEL[test.kind]
}

/** Lesson numbers by lesson id and "阶段 N" by stage id, for test titles. */
async function courseTitles(courseId: string | undefined): Promise<Map<string, string>> {
  if (!courseId) return new Map()
  const overview = await shell.call<Overview>('curriculum', 'overview', { courseId }).catch(() => ({ stages: [] }))
  return new Map(overview.stages.flatMap(stage => [[stage.id as string, `阶段 ${stage.index}`] as const, ...stage.lessons.map(lesson => [lesson.id as string, lesson.number] as const)]))
}

type Draft = { finals: string[]; text: string; gaveUp?: boolean }
type ViewProblem = TestView['problems'][number]
type ViewAttempt = TestView['attempts'][number]

const PLACEHOLDER: Record<AnswerInput['kind'], string> = {
  numeric: '数值和单位，如 1.44 kg/m³',
  expression: '表达式，如 u_1*(d_1/d_2)^2',
  open: '写出你的回答',
  choice: '',
}

const PROBE: Record<ProbeState, { text: string; tone: Tone; hint: string }> = {
  known: { text: '已会', tone: 'ok', hint: '直接答对' },
  boundary: { text: '边界', tone: 'accent', hint: '先修会了，从这里开始学' },
  'not-yet': { text: '还不会', tone: 'bad', hint: '答错了，它的先修也还没确认' },
  inferred: { text: '推测已会', tone: 'neutral', hint: '没有直接测，依赖它的知识点答对了；只用来排路线，不算掌握' },
  unprobed: { text: '未探测', tone: 'neutral', hint: '这次没有问到' },
}

const OUTCOME: Record<NodeOutcome, { text: string; tone: Tone }> = {
  pass: { text: '通过', tone: 'ok' },
  fail: { text: '没过', tone: 'bad' },
  mixed: { text: '对错不一', tone: 'warn' },
  pending: { text: '待复核', tone: 'warn' },
  insufficient: { text: '证据不够', tone: 'neutral' },
}

const REASONS = (Object.keys(REPORT_REASON_LABEL) as ReportReason[]).map(value => ({ value, label: REPORT_REASON_LABEL[value] }))

/** "习题 1-25", "改编自习题 1-25…", or the source label of other problems. */
function originTags(problem: ViewProblem): ReactNode {
  return (
    <>
      {problem.ref && <Tag>习题 {problem.ref}</Tag>}
      {problem.tier === 3 && <Tag tone="accent" title={problem.origin.kind === 'chunk' ? problem.origin.label : undefined}>改编</Tag>}
      {problem.tier === 4 && <Tag title="老师出的题，只用于练习">原创</Tag>}
      {problem.origin.kind === 'chunk' && problem.tier !== 3 && <Tag>{problem.origin.label}</Tag>}
    </>
  )
}

const filled = (draft: Draft) => Boolean(draft.gaveUp) || draft.finals.some(final => final.trim())

/** Answer boxes while the test is open: one per part, plus the working for calculations. */
function AnswerBoxes({ problem, index, draft, busy, canGiveUp, onChange }: { problem: ViewProblem; index: number; draft: Draft; busy: boolean; canGiveUp?: boolean; onChange(next: Draft): void }): ReactNode {
  const setFinal = (at: number, value: string) => onChange({ ...draft, finals: problem.inputs.map((_, i) => (i === at ? value : draft.finals[i] ?? '')) })
  const working = problem.inputs.some(input => input.kind === 'numeric' || input.kind === 'expression')
  const disabled = busy || Boolean(draft.gaveUp)
  return (
    <div className="la-answer-boxes" onClick={event => event.stopPropagation()}>
      {problem.inputs.map((input, at) => {
        const label = input.label || '答案'
        const value = draft.finals[at] ?? ''
        const name = `第 ${index + 1} 题${input.label ? ` ${input.label}` : ''}`
        return (
          <div key={at} className={`la-answer-box kind-${input.kind}`}>
            <span className="la-answer-box-label">{label}</span>
            {input.kind === 'choice' && (
              <div className="la-stack tight">
                {(input.options ?? []).map((option, optionIndex) => {
                  const letter = String.fromCharCode(65 + optionIndex)
                  return (
                    <Checkbox key={letter} card disabled={disabled} checked={value.includes(letter)} onChange={checked => {
                      const current = new Set(value.split(''))
                      if (checked) current.add(letter)
                      else current.delete(letter)
                      setFinal(at, [...current].filter(Boolean).sort().join(''))
                    }}>
                      <b>{letter}.</b> <shell.Markdown text={option} inline />
                    </Checkbox>
                  )
                })}
              </div>
            )}
            {input.kind === 'open' && <TextArea aria-label={`${name}作答`} disabled={disabled} placeholder={PLACEHOLDER.open} value={value} minRows={3} onChange={next => setFinal(at, next)} />}
            {(input.kind === 'numeric' || input.kind === 'expression') && (
              <TextField aria-label={`${name}答案`} disabled={disabled} placeholder={PLACEHOLDER[input.kind]} value={value} onChange={next => setFinal(at, next)} />
            )}
          </div>
        )
      })}
      {working && !draft.gaveUp && (
        <TextArea aria-label={`第 ${index + 1} 题解题过程`} className="la-working" disabled={busy} placeholder="解题过程（可选）：老师看得到，判分只看上面的答案栏" value={draft.text} minRows={2}
          onChange={next => onChange({ ...draft, text: next })} />
      )}
      {canGiveUp && <Checkbox disabled={busy} checked={Boolean(draft.gaveUp)} onChange={checked => onChange({ ...draft, gaveUp: checked })}>这题不会</Checkbox>}
    </div>
  )
}

/** After grading: what was written in each box, with each part's verdict. */
function GradedAnswer({ problem, attempt }: { problem: ViewProblem; attempt: ViewAttempt | undefined }): ReactNode {
  const parts = attempt?.grading?.parts
  const finals = attempt?.finals ?? []
  const boxes = !attempt?.gaveUp && (problem.inputs.length > 1 || finals.some(Boolean))
  return (
    <div className="la-answer">
      <div className="la-answer-label">你的作答</div>
      {attempt?.gaveUp && <div className="la-answer-text la-muted">选了"不会"</div>}
      {boxes ? (
        <div className="la-answer-parts">
          {problem.inputs.map((input, at) => {
            const verdict = parts?.[at] ? VERDICT[parts[at]!.verdict] : undefined
            return (
              <div key={at} className="la-answer-part">
                {input.label && <span className="la-answer-box-label">{input.label}</span>}
                <span className="la-answer-text">{finals[at] || <span className="la-faint">（空）</span>}</span>
                {verdict && problem.inputs.length > 1 && <Tag tone={verdict.tone}>{verdict.text}</Tag>}
              </div>
            )
          })}
        </div>
      ) : null}
      {attempt?.text ? <div className="la-answer-text la-answer-working">{attempt.text}</div> : !boxes && !attempt?.gaveUp && <div className="la-answer-text"><span className="la-faint">（空）</span></div>}
    </div>
  )
}

/** "这题有问题": the reason and a note; the problem is not scored and is swapped or skipped. */
function ReportPanel({ testId, problemId, adaptive, onDone, onCancel }: { testId: string; problemId: string; adaptive: boolean; onDone(): void; onCancel(): void }): ReactNode {
  const [reason, setReason] = useState<ReportReason>()
  const [note, setNote] = useState('')
  const send = useAction()
  return (
    <div className="la-report-panel" onClick={event => event.stopPropagation()}>
      <div className="la-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Select<ReportReason> aria-label="问题的原因" value={reason} placeholder="选一个原因" options={REASONS} onChange={setReason} width={168} />
        <TextField aria-label="补充说明" placeholder="补一句说明（可选）" value={note} onChange={setNote} width={280} />
      </div>
      <div className="la-muted la-small">这道题不计分，{adaptive ? '直接出下一题' : '有同类的题就换一道'}。除了"这题我做过"，老师都会核对这道题，核对结果会显示在这里。</div>
      <div className="la-row" style={{ gap: 8 }}>
        <Button size="sm" variant="primary" disabled={!reason} loading={send.busy} onClick={() => void send.run(async () => {
          await shell.call('assess', 'report', { testId, problemId, reason, note })
          onDone()
        })}>报告</Button>
        <Button size="sm" variant="quiet" disabled={send.busy} onClick={onCancel}>取消</Button>
      </div>
      <ErrorText error={send.error} />
    </div>
  )
}

/** Problems flagged in this test: swapped or skipped, and what the teacher found. */
function Reports({ reports }: { reports: TestView['reports'] }): ReactNode {
  if (reports.length === 0) return null
  return (
    <div className="la-card la-reports">
      <div className="la-strong">你报告的题</div>
      {reports.map(report => (
        <div key={report.id} className="la-report">
          <div className="la-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <span>{report.ref ? `习题 ${report.ref}` : `"${report.stem.slice(0, 24)}…"`}</span>
            <Tag>{REPORT_REASON_LABEL[report.reason]}</Tag>
            <span className="la-muted la-small">{report.replacedBy ? '已换成另一道题' : '已跳过，不判分'}</span>
          </div>
          {report.note && <div className="la-muted la-small">你的说明：{report.note}</div>}
          <div className="la-small">
            {report.outcome ? <>老师核对：{report.outcome.note}</> : report.reason === 'done-before' ? <span className="la-muted">已记为做过，以后不当新题。</span> : <span className="la-muted">等老师核对。</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

/** A graded problem's appeal: the button, or the appeal and the teacher's answer. */
function AppealArea({ attempt, appeals, onDone }: { attempt: ViewAttempt; appeals: TestView['appeals']; onDone(): void }): ReactNode {
  const [writing, setWriting] = useState(false)
  const [text, setText] = useState('')
  const send = useAction()
  const latest = appeals.filter(appeal => appeal.attemptId === attempt.id).at(-1)
  // One appeal per answer: the teacher's review is the answer to it.
  const canAppeal = Boolean(attempt.grading) && !latest
  return (
    <>
      {canAppeal && !writing && <Button size="sm" variant="quiet" icon={Scale} onClick={event => { event.stopPropagation(); setWriting(true) }}>申诉</Button>}
      {(latest || writing) && (
        <div className="la-appeal" onClick={event => event.stopPropagation()}>
          {latest && (
            <div className="la-small">
              <span className="la-muted">你的申诉：{latest.text}</span>
              <div>{latest.outcome ? `老师复核（${latest.outcome.changed ? `改判为${VERDICT[latest.outcome.verdict].text}` : `维持${VERDICT[latest.outcome.verdict].text}`}）：${latest.outcome.note}` : <span className="la-muted">等老师复核。</span>}</div>
            </div>
          )}
          {writing && (
            <div className="la-stack tight">
              <TextArea aria-label="申诉理由" placeholder="说说为什么觉得判得不对，例如：单位换算后和答案一致" value={text} minRows={2} onChange={setText} />
              <div className="la-row" style={{ gap: 8 }}>
                <Button size="sm" variant="primary" disabled={!text.trim()} loading={send.busy} onClick={() => void send.run(async () => {
                  await shell.call('assess', 'appeal', { attemptId: attempt.id, text })
                  setWriting(false)
                  setText('')
                  onDone()
                })}>提交申诉</Button>
                <Button size="sm" variant="quiet" disabled={send.busy} onClick={() => setWriting(false)}>取消</Button>
              </div>
              <ErrorText error={send.error} />
            </div>
          )}
        </div>
      )}
    </>
  )
}

/** Diagnostics: where each probed node stands. */
function DiagnosisCard({ diagnosis }: { diagnosis: Diagnosis }): ReactNode {
  return (
    <div className="la-card la-outcomes">
      <div className="la-strong">按知识点看</div>
      {(Object.keys(PROBE) as ProbeState[]).map(state => {
        const nodes = diagnosis.nodes.filter(node => node.state === state)
        if (nodes.length === 0) return null
        return (
          <div key={state} className="la-outcome">
            <Tag tone={PROBE[state].tone}>{PROBE[state].text}</Tag>
            <div className="la-outcome-main">
              <span>{nodes.map(node => node.title).join('、')}</span>
              <span className="la-faint la-small">{PROBE[state].hint}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Stage tests: each core node's outcome, the complete task and the earlier stages' problems. */
function StageReportCard({ report }: { report: StageReport }): ReactNode {
  return (
    <div className="la-card la-outcomes">
      <div className="la-strong">按知识点看</div>
      {report.nodes.map(node => (
        <div key={node.nodeId} className="la-outcome">
          <Tag tone={OUTCOME[node.outcome].tone}>{OUTCOME[node.outcome].text}</Tag>
          <div className="la-outcome-main">
            <span>{node.title}</span>
            <span className="la-faint la-small">{node.problems.length ? `第 ${node.problems.join('、')} 题` : '这次没有新题考到'}</span>
          </div>
        </div>
      ))}
      {report.task && (
        <div className="la-outcome">
          <Tag tone={VERDICT[report.task.verdict ?? 'pending-review'].tone}>{VERDICT[report.task.verdict ?? 'pending-review'].text}</Tag>
          <div className="la-outcome-main">
            <span>完整任务题（第 {report.task.number} 题）</span>
            {report.goals.length > 0 && <span className="la-faint la-small">对应目标：{report.goals.map(goal => goal.text).join('；')}</span>}
          </div>
        </div>
      )}
      {report.earlier.map(item => (
        <div key={item.number} className="la-outcome">
          <Tag tone={VERDICT[item.verdict ?? 'pending-review'].tone}>{VERDICT[item.verdict ?? 'pending-review'].text}</Tag>
          <div className="la-outcome-main">
            <span>{item.title}</span>
            <span className="la-faint la-small">前面阶段的题（第 {item.number} 题），看隔一段时间还会不会</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function ResultBanner({ view }: { view: TestView }): ReactNode {
  const { test, problems, attempts } = view
  const ended = <Tag>{test.endedAt ? `${test.status === 'abandoned' ? '结束于' : test.scope?.adaptive ? '完成于' : '交卷于'} ${friendlyTime(test.endedAt)}` : '已判分'}</Tag>
  if (test.status === 'abandoned') {
    return <div className="la-result-banner"><div style={{ flex: 1, minWidth: 0 }}><div className="la-strong">没有作答就结束了</div><div className="la-muted la-small">需要时可以请老师重新发布。</div></div>{ended}</div>
  }
  if (view.diagnosis) {
    const count = (state: ProbeState) => view.diagnosis!.nodes.filter(node => node.state === state).length
    return (
      <div className="la-result-banner">
        <span className="la-result-score">{attempts.length}<small> 题</small></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="la-strong">{KIND_LABEL[test.kind]}完成：已会 {count('known')} 个知识点，边界 {count('boundary')} 个</div>
          <div className="la-muted la-small">不算成绩。结果已经告诉主老师，用来决定从哪里开始教。</div>
        </div>
        {ended}
      </div>
    )
  }
  if (view.stageReport) {
    const passed = view.stageReport.nodes.filter(node => node.outcome === 'pass').length
    const total = view.stageReport.nodes.length
    return (
      <div className="la-result-banner">
        <span className="la-result-score">{passed}<small>/{total}</small></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="la-strong">{passed === total ? '核心知识点都通过了' : `通过 ${passed} 个核心知识点`}</div>
          <div className="la-muted la-small">按知识点逐个看，不设总分线。没过的安排补课，证据不够的以后补一道题。</div>
        </div>
        {ended}
      </div>
    )
  }
  const correct = attempts.filter(attempt => attempt.grading?.verdict === 'correct').length
  return (
    <div className="la-result-banner">
      <span className="la-result-score">{correct}<small>/{problems.length}</small></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="la-strong">{correct === problems.length ? '全部答对' : correct === 0 ? '这次都没答对，没关系' : '答对了一部分'}</div>
        <div className="la-muted la-small">结果已经告诉主老师。点一道题，可以在右侧就它提问；觉得判得不对可以申诉。</div>
      </div>
      <Tag tone={scoreTone(correct, problems.length)}>{test.endedAt ? `交卷于 ${friendlyTime(test.endedAt)}` : '已判分'}</Tag>
    </div>
  )
}

function TestPage({ scope, params, renderSlot }: LearningPageProps & PropsRenderSlots<'learning.figure'>): ReactNode {
  const testId = String(params.id ?? '')
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const view = useLoad(shell, async () => {
    const [data, titles] = await Promise.all([shell.call<TestView>('assess', 'view', { testId }), courseTitles(courseId)])
    return { ...data, titles }
  }, [testId, courseId], ['learning/test-finished', 'learning/logged', 'learning/handoff'])
  const [answers, setAnswers] = useState<Record<string, Draft>>({})
  const [reporting, setReporting] = useState<string>()
  const submit = useAction()
  const selection = useSelection(shell)
  if (view.error) return <Page width="reading"><ErrorText error={view.error} /></Page>
  if (!view.data) return <Page width="reading"><Skeleton lines={5} title /></Page>
  const { test, problems, attempts, titles } = view.data
  const open = test.status === 'open'
  const adaptive = Boolean(test.scope?.adaptive)
  const probing = test.kind === 'diagnostic' || test.kind === 'pretest'
  const draftOf = (problemId: string): Draft => answers[problemId] ?? { finals: [], text: '' }
  const answerOf = (problem: ViewProblem) => ({ problemId: problem.id, text: draftOf(problem.id).text, finals: problem.inputs.map((_, at) => draftOf(problem.id).finals[at] ?? ''), ...(draftOf(problem.id).gaveUp ? { gaveUp: true } : {}) })
  const answered = problems.filter(problem => filled(draftOf(problem.id))).length
  const select = (problemId: string, label: string) => shell.select({ page: 'assess.test', ...(courseId ? { courseId: courseId as never } : {}), selected: { kind: 'problem', id: problemId, label } })
  const reportButton = (problem: ViewProblem) => (
    <Button size="sm" variant="quiet" icon={Flag} aria-expanded={reporting === problem.id} onClick={event => { event.stopPropagation(); setReporting(reporting === problem.id ? undefined : problem.id) }}>这题有问题</Button>
  )
  const reportPanel = (problem: ViewProblem) => reporting === problem.id && (
    <ReportPanel testId={testId} problemId={problem.id} adaptive={adaptive} onCancel={() => setReporting(undefined)} onDone={() => { setReporting(undefined); view.reload() }} />
  )
  const card = (problem: ViewProblem, index: number, body: ReactNode, head?: ReactNode) => {
    const attempt = attempts.find(item => item.problemId === problem.id)
    const verdict = !open && attempt?.grading ? VERDICT[attempt.grading.verdict] : undefined
    const selected = selection?.selected?.kind === 'problem' && selection.selected.id === problem.id
    return (
      <div key={problem.id} className={`la-card la-problem${selected ? ' is-active' : ''}${open && filled(draftOf(problem.id)) ? ' is-answered' : ''}${open ? '' : ' selectable'}`}
        onClick={() => { if (!open) select(problem.id, `${KIND_LABEL[test.kind]}第 ${index + 1} 题`) }}>
        <div className="la-problem-head">
          <span className="la-problem-num">{index + 1}</span>
          {originTags(problem)}
          <span className="la-spacer" />
          {head}
          {attempt?.grading?.method === 'teacher' && !open && <Tag>老师复核</Tag>}
          {verdict && <Tag tone={verdict.tone}>{verdict.text}</Tag>}
        </div>
        <div className="la-problem-stem"><shell.Markdown text={problem.stem} /></div>
        {problem.figures.map(chunkId => <div key={chunkId}>{renderSlot('learning.figure', { chunkId }, { fallback: null })}</div>)}
        {body}
      </div>
    )
  }

  // An adaptive test shows only the problem it waits on.
  const current = open && adaptive ? problems.find(problem => !attempts.some(attempt => attempt.problemId === problem.id)) : undefined
  const currentIndex = current ? problems.indexOf(current) : -1
  const max = test.scope?.max ?? problems.length
  return (
    <Page width="reading">
      <PageHeader eyebrow={<><ClipboardCheck size={14} strokeWidth={1.75} />测试 · {KIND_LABEL[test.kind]}</>} title={testTitle(test, titles)}
        meta={<>
          {conditionsOf(test).map(item => <Tag key={item}>{item}</Tag>)}
          <Tag>{adaptive && open ? `最多 ${max} 题` : `${problems.length} 题`}</Tag>
          <span className="la-faint la-small">开始于 {friendlyTime(test.startedAt)}</span>
        </>} />
      <div className="la-stack" style={{ gap: 14 }}>
        {probing && open && (
          <Callout tone="accent" title={`这是${KIND_LABEL[test.kind]}，不算成绩`}>
            {adaptive ? `一次一题，下一题按你的作答来出，最多 ${max} 题。` : ''}答不出来很正常，不会就{adaptive ? '点"不会"' : '勾"这题不会"'}。老师据此判断从哪里开始教。
          </Callout>
        )}
        {!open && <ResultBanner view={view.data} />}
        {!open && view.data.diagnosis && <DiagnosisCard diagnosis={view.data.diagnosis} />}
        {!open && view.data.stageReport && <StageReportCard report={view.data.stageReport} />}

        {adaptive && open && current && (
          <>
            <div className="la-probe-progress">
              <span>第 <b className="la-num">{currentIndex + 1}</b> 题 · 最多 {max} 题</span>
              <Progress value={(attempts.length / max) * 100} label="摸底进度" />
            </div>
            {card(current, currentIndex, (
              <>
                {reportPanel(current)}
                <AnswerBoxes problem={current} index={currentIndex} draft={draftOf(current.id)} busy={submit.busy} onChange={next => setAnswers(previous => ({ ...previous, [current.id]: next }))} />
                <div className="la-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Button variant="primary" icon={Send} loading={submit.busy} disabled={!draftOf(current.id).finals.some(final => final.trim())} onClick={() => void submit.run(async () => {
                    await shell.call('assess', 'answer', { testId, answer: answerOf(current) })
                    view.reload()
                  })}>提交这题</Button>
                  <Button disabled={submit.busy} onClick={() => void submit.run(async () => {
                    await shell.call('assess', 'answer', { testId, answer: { problemId: current.id, text: '', finals: [], gaveUp: true } })
                    view.reload()
                  })}>不会</Button>
                </div>
              </>
            ), reportButton(current))}
            <div className="la-row" style={{ justifyContent: 'center' }}>
              <ConfirmButton size="sm" variant="quiet" question="按已经答的题给出结果？" confirm="结束" loading={submit.busy} onConfirm={() => void submit.run(async () => {
                await shell.call('assess', 'finish', { testId })
                view.reload()
              })}>结束{KIND_LABEL[test.kind]}</ConfirmButton>
            </div>
          </>
        )}

        {!(adaptive && open) && problems.map((problem, index) => {
          const attempt = attempts.find(item => item.problemId === problem.id)
          return card(problem, index, open ? (
            <>
              {reportPanel(problem)}
              <AnswerBoxes problem={problem} index={index} draft={draftOf(problem.id)} busy={submit.busy} canGiveUp={probing} onChange={next => setAnswers(previous => ({ ...previous, [problem.id]: next }))} />
            </>
          ) : (
            <>
              <GradedAnswer problem={problem} attempt={attempt} />
              {attempt?.grading?.parts?.length
                ? <div className="la-rationale">{attempt.grading.parts.map(part => <div key={part.label}><shell.Markdown text={`${part.label} ${part.rationale}`} /></div>)}</div>
                : attempt?.grading?.rationale && !attempt.gaveUp && <div className="la-rationale"><shell.Markdown text={attempt.grading.rationale} /></div>}
              <div className="la-row" style={{ gap: 4, flexWrap: 'wrap' }}>
                <Button size="sm" variant="quiet" icon={MessageCircleQuestion} onClick={event => { event.stopPropagation(); select(problem.id, `${KIND_LABEL[test.kind]}第 ${index + 1} 题`); shell.showSideChat() }}>就这题提问</Button>
                {attempt && !attempt.gaveUp && <AppealArea attempt={attempt} appeals={view.data!.appeals} onDone={view.reload} />}
              </div>
            </>
          ), open ? reportButton(problem) : undefined)
        })}

        <Reports reports={view.data.reports} />

        {open && !adaptive && (
          <div className="la-submit-bar">
            <div className="la-submit-progress">
              <span>已作答 <b className="la-num">{answered}</b> / {problems.length} 题{answered < problems.length ? '，没写的题按空白交' : ''}</span>
              <Progress value={problems.length ? (answered / problems.length) * 100 : 0} label="作答进度" />
            </div>
            <Button variant="primary" icon={Send} loading={submit.busy} onClick={() => void submit.run(async () => {
              await shell.call('assess', 'submit', { testId, answers: problems.map(answerOf) })
              view.reload()
            })}>{submit.busy ? '判分中…' : '交卷'}</Button>
          </div>
        )}
        {open && <div className="la-faint la-small" style={{ textAlign: 'center' }}>{adaptive ? '作答时不显示对错，结束后一起给出结果。' : '交卷后数值题按答案栏由程序判分（单位会换算，没写单位算部分对），其余由模型按评分标准判分并标注把握程度。'}</div>}
        <ErrorText error={submit.error} />
      </div>
    </Page>
  )
}

function useTests(courseId: string) {
  return useLoad(shell, async () => {
    if (!courseId) return { rows: [] as TestRow[], lessons: new Map<string, string>() }
    const [rows, lessons] = await Promise.all([shell.call<TestRow[]>('assess', 'tests', { courseId }), courseTitles(courseId)])
    return { rows, lessons }
  }, [courseId])
}

function OpenTests({ rows, lessons }: { rows: TestRow[]; lessons: ReadonlyMap<string, string> }): ReactNode {
  return (
    <div className="la-rows">
      {rows.map(({ test }) => (
        <div key={test.id} className="la-row-item">
          <span className="la-row-icon accent"><PencilLine size={16} strokeWidth={1.75} /></span>
          <div className="la-row-main">
            <span className="la-row-title">{testTitle(test, lessons)}</span>
            <span className="la-row-sub">{test.scope?.adaptive ? `一次一题，最多 ${test.scope.max} 题` : `${test.problemIds.length} 题`} · {conditionsOf(test).join(' · ')}</span>
          </div>
          <Button variant="primary" size="sm" icon={ArrowRight} onClick={() => openTest(test.id, testTitle(test, lessons))}>开始作答</Button>
        </div>
      ))}
    </div>
  )
}

function GradedTests({ rows, lessons }: { rows: TestRow[]; lessons: ReadonlyMap<string, string> }): ReactNode {
  return (
    <div className="la-rows">
      {rows.map(({ test, correct, total }) => (
        <button key={test.id} type="button" className="la-row-item interactive" onClick={() => openTest(test.id, testTitle(test, lessons))}>
          <span className={`la-row-icon ${scoreTone(correct, total)}`}><ClipboardCheck size={16} strokeWidth={1.75} /></span>
          <div className="la-row-main">
            <span className="la-row-title">{testTitle(test, lessons)}</span>
            <span className="la-row-sub">{friendlyTime(test.endedAt ?? test.startedAt)} · {conditionsOf(test).join(' · ')}</span>
          </div>
          <span className="la-row-end"><Tag tone={scoreTone(correct, total)}>对 {correct}/{total}</Tag><ChevronRight size={16} strokeWidth={1.75} /></span>
        </button>
      ))}
    </div>
  )
}

function TestsPage({ scope }: LearningPageProps): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : ''
  const data = useTests(courseId)
  if (!courseId) return <Page><EmptyState icon={ClipboardCheck} title="进入一门课后查看测试" /></Page>
  const rows = data.data?.rows ?? []
  const open = rows.filter(row => row.test.status === 'open')
  const graded = rows.filter(row => row.test.status !== 'open').reverse()
  return (
    <Page>
      <PageHeader eyebrow={<><ClipboardCheck size={14} strokeWidth={1.75} />测试</>} title="测试" description="摸底、小测和阶段测试都在这里。交卷后结果会自动告诉主老师。" />
      <ErrorText error={data.error} />
      {!data.data && data.loading && <Skeleton lines={4} />}
      {data.data && rows.length === 0 && <div className="la-card"><EmptyState icon={ClipboardList} title="还没有测试" description="主老师发布摸底或小测后，会出现在这里。" /></div>}
      {open.length > 0 && <Section title="待作答" icon={PencilLine} count={open.length}><OpenTests rows={open} lessons={data.data!.lessons} /></Section>}
      {graded.length > 0 && <Section title="已完成" icon={ClipboardCheck} count={graded.length}><GradedTests rows={graded} lessons={data.data!.lessons} /></Section>}
      <BankSection courseId={courseId} />
    </Page>
  )
}

/** `1-1、1-2、1-3、2-5` → `1-1~1-3、2-5`. */
function compactRefs(marks: readonly HomeworkMark[]): string {
  const sorted = marks.map(mark => mark.ref.split('-').map(Number) as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const runs: string[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1]![0] === sorted[i]![0] && sorted[j + 1]![1] === sorted[j]![1] + 1) j++
    runs.push(j > i ? `${sorted[i]!.join('-')}~${sorted[j]!.join('-')}` : sorted[i]!.join('-'))
    i = j + 1
  }
  return runs.join('、')
}

/** The bank by knowledge node (counts only: reserved stems never reach the page) and the homework marks. */
function BankSection({ courseId }: { courseId: string }): ReactNode {
  const data = useLoad(shell, async () => {
    const graph = await shell.call<CourseGraph>('knowledge', 'graph', { courseId }).catch(() => ({ nodes: [] as CourseGraph['nodes'] }))
    const bank = await shell.call<BankOverview>('assess', 'bank', { courseId, nodeIds: graph.nodes.map(node => node.id) })
    return { bank, titles: new Map(graph.nodes.map(node => [node.id as string, node.title])) }
  }, [courseId])
  const [refs, setRefs] = useState('')
  const mark = useAction()
  if (!data.data) return data.loading ? <Skeleton lines={2} /> : <ErrorText error={data.error} />
  const { bank, titles } = data.data
  const run = (done: boolean) => void mark.run(async () => {
    await shell.call('assess', 'markHomework', { courseId, refs, done })
    setRefs('')
    data.reload()
  })
  return (
    <Section title="题库" icon={Layers} description="题目优先取自教材习题。测试预留题留给阶段测试，这里只显示数量。">
      <div className="la-stack" style={{ gap: 12 }}>
        <div className="la-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Tag>练习题 {bank.practice} 道</Tag>
          <Tag>测试预留题 {bank.reserved} 道</Tag>
          {bank.homework.length > 0 && <Tag icon={BookCheck}>作业做过 {bank.homework.length} 道</Tag>}
          {bank.doubtful.length > 0 && <Tag tone="warn">待核对 {bank.doubtful.length} 道</Tag>}
        </div>
        {bank.nodes.length > 0 && (
          <Disclosure summary={`按知识节点看（${bank.nodes.length} 个）`}>
            <div className="la-bank-nodes">
              {bank.nodes.map(node => (
                <div key={node.nodeId} className="la-bank-node">
                  <span className="la-bank-node-title">{titles.get(node.nodeId) ?? '（已不在本课的节点）'}</span>
                  <span className="la-muted la-small">练习 {node.practice} · 预留 {node.reserved}{node.seen ? ` · 见过 ${node.seen}` : ''}{node.doubtful ? ` · 待核对 ${node.doubtful}` : ''}</span>
                </div>
              ))}
            </div>
          </Disclosure>
        )}
        {bank.doubtful.length > 0 && (
          <Callout tone="warn" title="待核对的题暂停使用">
            {bank.doubtful.map(item => `${item.ref ? `习题 ${item.ref}` : '一道题'}（${item.reason}）`).join('；')}。老师核对后会改正、恢复或停用。
          </Callout>
        )}
        <div className="la-homework">
          <div className="la-strong">作业做过的题</div>
          <div className="la-muted la-small">按教材题号填写，如 1-1~1-10, 2-3。做过的题以后不算新题，不会出在阶段测试里当新题。</div>
          {bank.homework.length > 0 && <div className="la-homework-refs">{compactRefs(bank.homework)}</div>}
          <div className="la-row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <TextField aria-label="作业题号" placeholder="1-1~1-10, 2-3" value={refs} onChange={setRefs} onEnter={() => { if (refs.trim()) run(true) }} width={240} />
            <Button size="sm" variant="primary" icon={BookCheck} disabled={!refs.trim()} loading={mark.busy} onClick={() => run(true)}>标记做过</Button>
            <Button size="sm" variant="quiet" disabled={!refs.trim() || mark.busy} onClick={() => run(false)}>取消标记</Button>
          </div>
          <ErrorText error={mark.error} />
        </div>
      </div>
    </Section>
  )
}

function TestsSection({ courseId }: { courseId: string }): ReactNode {
  const data = useTests(courseId)
  if (!data.data) return data.loading ? <Skeleton lines={2} /> : <ErrorText error={data.error} />
  const { rows, lessons } = data.data
  const open = rows.filter(row => row.test.status === 'open')
  const graded = rows.filter(row => row.test.status !== 'open').reverse().slice(0, 3)
  return (
    <Section title="测试" icon={ClipboardCheck} count={rows.length || undefined}
      actions={rows.length > 0 && <Button size="sm" variant="quiet" onClick={() => shell.openPage('assess.tests', {}, { title: '测试' })}>全部测试<ChevronRight size={14} strokeWidth={1.75} /></Button>}>
      {rows.length === 0 && <div className="la-card"><EmptyState compact icon={ClipboardList} title="还没有测试" description="主老师发布摸底或小测后会出现在这里。" /></div>}
      <div className="la-stack" style={{ gap: 10 }}>
        {open.length > 0 && <OpenTests rows={open} lessons={lessons} />}
        {graded.length > 0 && <GradedTests rows={graded} lessons={lessons} />}
      </div>
    </Section>
  )
}

/** Status bar: tests waiting for an answer. */
function OpenTestsStatus({ scope }: { scope: ShellScope }): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const rows = useLoad(shell, async () => (courseId ? shell.call<TestRow[]>('assess', 'tests', { courseId }) : []), [courseId], ['learning/test-finished', 'learning/task-published'])
  const open = (rows.data ?? []).filter(row => row.test.status === 'open').length
  if (!courseId || open === 0) return null
  return (
    <button type="button" className="la-status-item accent" title="打开测试" onClick={() => shell.openPage('assess.tests', {}, { title: '测试' })}>
      <PencilLine size={13} strokeWidth={1.75} />{open} 个测试待作答
    </button>
  )
}
