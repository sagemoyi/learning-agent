// assess unit, browser half: the tests page (activity bar, with a count of tests waiting for an
// answer), the test page, and the tests section of the progress page.
import { useState, type ReactNode } from 'react'
import { ClipboardCheck, PencilLine } from 'lucide-react'
import type { Lesson, Stage, Test, TestView, Verdict } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import { Button, Checkbox, TextArea, shortTime, useAction, useLoad, useSelection } from '@learning-agent/kit/client'

export const name = 'learning-assess'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'tests', title: '测试', icon: ClipboardCheck, scope: 'course', page: 'assess.tests', order: 25 }), 'assess: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'assess.tests' }, TestsPage)), 'assess: tests page')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'assess.test' }, TestPage)), 'assess: test page')
  // The count of tests waiting for an answer, on the activity-bar button.
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
}

const KIND_LABEL: Record<Test['kind'], string> = { diagnostic: '摸底', quiz: '小测', practice: '练习', stage: '阶段测试', review: '复查', mock: '模拟考' }
const VERDICT: Record<Verdict, { text: string; tone: string }> = {
  correct: { text: '对', tone: 'ok' },
  partial: { text: '部分对', tone: 'warn' },
  incorrect: { text: '错', tone: 'bad' },
  'pending-review': { text: '待复核', tone: 'warn' },
}

export function openTest(testId: string, title: string): void {
  shell.openPage('assess.test', { id: testId }, { title })
}

function conditionsText(test: Test): string {
  const c = test.conditions
  return `${c.book === 'closed' ? '闭卷' : '开卷'} · ${c.calculator ? '可用计算器' : '不用计算器'}${c.formulaSheet ? ' · 可带公式表' : ''}`
}

function TestPage({ scope, params }: LearningPageProps): ReactNode {
  const testId = String(params.id ?? '')
  const view = useLoad(shell, () => shell.call<TestView>('assess', 'view', { testId }), [testId], ['learning/test-finished'])
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const submit = useAction()
  const selection = useSelection(shell)
  const data = view.data
  if (view.error) return <div className="la-pad la-error">{view.error}</div>
  if (!data) return null
  const { test, problems, attempts } = data
  const open = test.status === 'open'
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  return (
    <div className="la-pad la-stack">
      <div>
        <div className="la-h1">{KIND_LABEL[test.kind]}</div>
        <div className="la-muted">{conditionsText(test)} · {problems.length} 题 · 开始于 {shortTime(test.startedAt)}</div>
        {test.kind === 'diagnostic' && open && <div className="la-muted">这是摸底，不算成绩。答不出来很正常，写"不会"也可以。</div>}
      </div>
      {problems.map((problem, index) => {
        const attempt = attempts.find(item => item.problemId === problem.id)
        const verdict = attempt?.grading ? VERDICT[attempt.grading.verdict] : undefined
        const selected = selection?.selected?.kind === 'problem' && selection.selected.id === problem.id
        return (
          <div key={problem.id} className={`la-card la-stack${selected ? ' is-active' : ''}`} style={{ gap: 8 }}
            onClick={() => { if (!open) shell.select({ page: 'assess.test', ...(courseId ? { courseId } : {}), selected: { kind: 'problem', id: problem.id, label: `${KIND_LABEL[test.kind]}第 ${index + 1} 题` } }) }}>
            <div className="la-row">
              <b>第 {index + 1} 题</b>
              {problem.origin.kind === 'chunk' && <span className="la-tag">{problem.origin.label}</span>}
              {verdict && <span className={`la-tag ${verdict.tone}`}>{verdict.text}</span>}
            </div>
            <shell.Markdown text={problem.stem} />
            {open && problem.options && (
              <div className="la-stack" style={{ gap: 4 }}>
                {problem.options.map((option, optionIndex) => {
                  const letter = String.fromCharCode(65 + optionIndex)
                  return (
                    <Checkbox key={letter} card disabled={submit.busy} checked={(answers[problem.id] ?? '').includes(letter)} onChange={checked => setAnswers(previous => {
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
              <TextArea aria-label={`第 ${index + 1} 题作答`} disabled={submit.busy} placeholder="写下答案和关键步骤（数值题请带单位）" value={answers[problem.id] ?? ''}
                onChange={value => setAnswers(previous => ({ ...previous, [problem.id]: value }))} onClick={event => event.stopPropagation()} />
            )}
            {!open && (
              <div className="la-stack" style={{ gap: 4 }}>
                <div><span className="la-muted">你的作答：</span>{attempt?.text || '（空）'}</div>
                {attempt?.grading?.rationale && <div className="la-muted">{attempt.grading.rationale}</div>}
              </div>
            )}
          </div>
        )
      })}
      {open && (
        <div className="la-row">
          <Button variant="primary" loading={submit.busy} onClick={() => void submit.run(async () => {
            await shell.call('assess', 'submit', { testId, answers: problems.map(problem => ({ problemId: problem.id, text: answers[problem.id] ?? '' })) })
            view.reload()
          })}>{submit.busy ? '判分中…' : '交卷'}</Button>
          <span className="la-muted la-small">交卷后数值题由程序判分，其余由模型判分并标注把握程度。</span>
        </div>
      )}
      {!open && <div className="la-muted la-small">点一道题，可以在右侧就它提问。</div>}
      {submit.error && <div className="la-error">{submit.error}</div>}
    </div>
  )
}

type TestRow = { test: Test; correct: number; total: number }
type Overview = { stages: (Stage & { lessons: Lesson[] })[] }

/** "1.1 小测", "摸底": the kind, after the lesson number when the test belongs to a lesson. */
function testTitle(test: Test, lessons: ReadonlyMap<string, string>): string {
  const number = test.lessonId ? lessons.get(test.lessonId) : undefined
  return number ? `${number} ${KIND_LABEL[test.kind]}` : KIND_LABEL[test.kind]
}

function TestList({ courseId, limit }: { courseId: string; limit?: number }): ReactNode {
  const data = useLoad(shell, async () => {
    const [rows, overview] = await Promise.all([
      shell.call<TestRow[]>('assess', 'tests', { courseId }),
      shell.call<Overview>('curriculum', 'overview', { courseId }).catch(() => ({ stages: [] })),
    ])
    const lessons = new Map(overview.stages.flatMap(stage => stage.lessons.map(lesson => [lesson.id as string, lesson.number])))
    return { rows, lessons }
  }, [courseId])
  if (data.error) return <div className="la-error">{data.error}</div>
  if (!data.data) return null
  const { rows, lessons } = data.data
  const open = rows.filter(row => row.test.status === 'open')
  const graded = rows.filter(row => row.test.status !== 'open').reverse().slice(0, limit)
  if (rows.length === 0) return <div className="la-muted">还没有测试。主老师发布摸底或小测后会出现在这里。</div>
  return (
    <div className="la-stack">
      {open.map(({ test }) => (
        <div key={test.id} className="la-row">
          <span className="la-tag accent">待作答</span>
          <b>{testTitle(test, lessons)}</b>
          <span className="la-muted la-small">{test.problemIds.length} 题 · {conditionsText(test)}</span>
          <span className="la-spacer" />
          <Button variant="primary" icon={PencilLine} onClick={() => openTest(test.id, testTitle(test, lessons))}>开始作答</Button>
        </div>
      ))}
      {graded.length > 0 && (
        <ul className="la-list">
          {graded.map(({ test, correct, total }) => (
            <li key={test.id}>
              <span className={`la-tag ${correct === total ? 'ok' : correct === 0 ? 'bad' : 'warn'}`}>对 {correct}/{total}</span>
              <button className="la-link" onClick={() => openTest(test.id, testTitle(test, lessons))}>{testTitle(test, lessons)}</button>
              <span className="la-muted la-small">{shortTime(test.endedAt ?? test.startedAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function TestsPage({ scope }: LearningPageProps): ReactNode {
  if (scope.kind !== 'course') return <div className="la-empty">进入一门课后查看测试。</div>
  return (
    <div className="la-pad la-stack">
      <div>
        <div className="la-h1">测试</div>
        <div className="la-muted">摸底、小测和阶段测试都在这里。交卷后结果会自动告诉主老师。</div>
      </div>
      <TestList courseId={scope.courseId} />
    </div>
  )
}

function TestsSection({ courseId }: { courseId: string }): ReactNode {
  return (
    <section className="la-card la-stack">
      <div className="la-h2">测试</div>
      <TestList courseId={courseId} limit={5} />
    </section>
  )
}
