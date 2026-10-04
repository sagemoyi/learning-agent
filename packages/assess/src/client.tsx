// assess unit, browser half: the tests page (sidebar entry with a count of tests waiting for an
// answer), the test page, the tests section of the progress page and the open-test count in the status bar.
import { useState, type ReactNode } from 'react'
import { ArrowRight, ChevronRight, ClipboardCheck, ClipboardList, MessageCircleQuestion, PencilLine, Send } from 'lucide-react'
import type { Lesson, Stage, Test, TestView, Verdict } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell, ShellScope } from '@learning-agent/contracts/client'
import {
  Button, Callout, Checkbox, EmptyState, ErrorText, Page, PageHeader, Progress, Section, Skeleton, Tag, TextArea, friendlyTime, useAction, useLoad, useSelection, type Tone,
} from '@learning-agent/kit/client'

export const name = 'learning-assess'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'tests', title: '测试', icon: ClipboardCheck, scope: 'course', page: 'assess.tests', order: 25 }), 'assess: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'assess.tests' }, TestsPage)), 'assess: tests page')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'assess.test' }, TestPage)), 'assess: test page')
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

const KIND_LABEL: Record<Test['kind'], string> = { diagnostic: '摸底', quiz: '小测', practice: '练习', stage: '阶段测试', review: '复查', mock: '模拟考' }
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
  const c = test.conditions
  return [c.book === 'closed' ? '闭卷' : '开卷', c.calculator ? '可用计算器' : '不用计算器', ...(c.formulaSheet ? ['可带公式表'] : [])]
}

function scoreTone(correct: number, total: number): Tone {
  return correct === total ? 'ok' : correct === 0 ? 'bad' : 'warn'
}

type TestRow = { test: Test; correct: number; total: number }
type Overview = { stages: (Stage & { lessons: Lesson[] })[] }

/** "1.1 小测", "摸底": the kind, after the lesson number when the test belongs to a lesson. */
function testTitle(test: Test, lessons: ReadonlyMap<string, string>): string {
  const number = test.lessonId ? lessons.get(test.lessonId) : undefined
  return number ? `${number} ${KIND_LABEL[test.kind]}` : KIND_LABEL[test.kind]
}

async function lessonNumbers(courseId: string | undefined): Promise<Map<string, string>> {
  if (!courseId) return new Map()
  const overview = await shell.call<Overview>('curriculum', 'overview', { courseId }).catch(() => ({ stages: [] }))
  return new Map(overview.stages.flatMap(stage => stage.lessons.map(lesson => [lesson.id as string, lesson.number])))
}

function TestPage({ scope, params }: LearningPageProps): ReactNode {
  const testId = String(params.id ?? '')
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const view = useLoad(shell, async () => {
    const [data, lessons] = await Promise.all([shell.call<TestView>('assess', 'view', { testId }), lessonNumbers(courseId)])
    return { ...data, lessons }
  }, [testId, courseId], ['learning/test-finished'])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const submit = useAction()
  const selection = useSelection(shell)
  if (view.error) return <Page width="reading"><ErrorText error={view.error} /></Page>
  if (!view.data) return <Page width="reading"><Skeleton lines={5} title /></Page>
  const { test, problems, attempts, lessons } = view.data
  const open = test.status === 'open'
  const answered = problems.filter(problem => (answers[problem.id] ?? '').trim()).length
  const graded = attempts.filter(attempt => attempt.grading)
  const correct = graded.filter(attempt => attempt.grading?.verdict === 'correct').length
  const select = (problemId: string, label: string) => shell.select({ page: 'assess.test', ...(courseId ? { courseId: courseId as never } : {}), selected: { kind: 'problem', id: problemId, label } })
  return (
    <Page width="reading">
      <PageHeader eyebrow={<><ClipboardCheck size={14} strokeWidth={1.75} />测试 · {KIND_LABEL[test.kind]}</>} title={testTitle(test, lessons)}
        meta={<>
          {conditionsOf(test).map(item => <Tag key={item}>{item}</Tag>)}
          <Tag>{problems.length} 题</Tag>
          <span className="la-faint la-small">开始于 {friendlyTime(test.startedAt)}</span>
        </>} />
      <div className="la-stack" style={{ gap: 14 }}>
        {test.kind === 'diagnostic' && open && <Callout tone="accent" title="这是摸底，不算成绩">答不出来很正常，写"不会"也可以。老师据此判断从哪里开始教。</Callout>}
        {!open && (
          <div className="la-result-banner">
            <span className="la-result-score">{correct}<small>/{problems.length}</small></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="la-strong">{correct === problems.length ? '全部答对' : correct === 0 ? '这次都没答对，没关系' : '答对了一部分'}</div>
              <div className="la-muted la-small">结果已经告诉主老师。点一道题，可以在右侧就它提问。</div>
            </div>
            <Tag tone={scoreTone(correct, problems.length)}>{test.endedAt ? `交卷于 ${friendlyTime(test.endedAt)}` : '已判分'}</Tag>
          </div>
        )}
        {problems.map((problem, index) => {
          const attempt = attempts.find(item => item.problemId === problem.id)
          const verdict = attempt?.grading ? VERDICT[attempt.grading.verdict] : undefined
          const selected = selection?.selected?.kind === 'problem' && selection.selected.id === problem.id
          const label = `${KIND_LABEL[test.kind]}第 ${index + 1} 题`
          const value = answers[problem.id] ?? ''
          return (
            <div key={problem.id} className={`la-card la-problem${selected ? ' is-active' : ''}${value.trim() ? ' is-answered' : ''}${open ? '' : ' selectable'}`}
              onClick={() => { if (!open) select(problem.id, label) }}>
              <div className="la-problem-head">
                <span className="la-problem-num">{index + 1}</span>
                {problem.origin.kind === 'chunk' && <Tag>{problem.origin.label}</Tag>}
                <span className="la-spacer" />
                {verdict && <Tag tone={verdict.tone}>{verdict.text}</Tag>}
              </div>
              <div className="la-problem-stem"><shell.Markdown text={problem.stem} /></div>
              {open && problem.options && (
                <div className="la-stack tight">
                  {problem.options.map((option, optionIndex) => {
                    const letter = String.fromCharCode(65 + optionIndex)
                    return (
                      <Checkbox key={letter} card disabled={submit.busy} checked={value.includes(letter)} onChange={checked => setAnswers(previous => {
                        const current = new Set((previous[problem.id] ?? '').split(''))
                        if (checked) current.add(letter)
                        else current.delete(letter)
                        return { ...previous, [problem.id]: [...current].filter(Boolean).sort().join('') }
                      })}>
                        <b>{letter}.</b> <shell.Markdown text={option} inline />
                      </Checkbox>
                    )
                  })}
                </div>
              )}
              {open && !problem.options && (
                <TextArea aria-label={`第 ${index + 1} 题作答`} disabled={submit.busy} placeholder="写下答案和关键步骤（数值题请带单位）" value={value} minRows={3}
                  onChange={next => setAnswers(previous => ({ ...previous, [problem.id]: next }))} onClick={event => event.stopPropagation()} />
              )}
              {!open && (
                <>
                  <div className="la-answer">
                    <div className="la-answer-label">你的作答</div>
                    <div className="la-answer-text">{attempt?.text || <span className="la-faint">（空）</span>}</div>
                  </div>
                  {attempt?.grading?.rationale && <div className="la-rationale"><shell.Markdown text={attempt.grading.rationale} /></div>}
                  <div className="la-row">
                    <Button size="sm" variant="quiet" icon={MessageCircleQuestion} onClick={event => { event.stopPropagation(); select(problem.id, label); shell.showSideChat() }}>就这题提问</Button>
                  </div>
                </>
              )}
            </div>
          )
        })}
        {open && (
          <div className="la-submit-bar">
            <div className="la-submit-progress">
              <span>已作答 <b className="la-num">{answered}</b> / {problems.length} 题{answered < problems.length ? '，没写的题按空白交' : ''}</span>
              <Progress value={problems.length ? (answered / problems.length) * 100 : 0} label="作答进度" />
            </div>
            <Button variant="primary" icon={Send} loading={submit.busy} onClick={() => void submit.run(async () => {
              await shell.call('assess', 'submit', { testId, answers: problems.map(problem => ({ problemId: problem.id, text: answers[problem.id] ?? '' })) })
              view.reload()
            })}>{submit.busy ? '判分中…' : '交卷'}</Button>
          </div>
        )}
        {open && <div className="la-faint la-small" style={{ textAlign: 'center' }}>交卷后数值题由程序判分，其余由模型按评分标准判分并标注把握程度。</div>}
        <ErrorText error={submit.error} />
      </div>
    </Page>
  )
}

function useTests(courseId: string) {
  return useLoad(shell, async () => {
    if (!courseId) return { rows: [] as TestRow[], lessons: new Map<string, string>() }
    const [rows, lessons] = await Promise.all([shell.call<TestRow[]>('assess', 'tests', { courseId }), lessonNumbers(courseId)])
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
            <span className="la-row-sub">{test.problemIds.length} 题 · {conditionsOf(test).join(' · ')}</span>
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
    </Page>
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
