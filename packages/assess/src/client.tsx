// assess unit, browser half: the test page and the tests section of the progress page.
import { useState, type ReactNode } from 'react'
import type { Test, TestView, Verdict } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import { shortTime, useAction, useLoad, useSelection } from '@learning-agent/kit/client'

export const name = 'learning-assess'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'assess.test' }, TestPage)), 'assess: test page')
  ctx.effect(() => ctx.slots.inject('learning.course-section', () => ctx.slots.register({ name: 'learning.course-section', id: 'assess', order: 40 }, TestsSection)), 'assess: progress section')
}

const KIND_LABEL: Record<Test['kind'], string> = { diagnostic: '摸底', quiz: '小测', practice: '练习', stage: '阶段测试', review: '复查', mock: '模拟考' }
const VERDICT: Record<Verdict, { text: string; tone: string }> = {
  correct: { text: '对', tone: 'ok' },
  partial: { text: '部分对', tone: 'warn' },
  incorrect: { text: '错', tone: 'bad' },
  'pending-review': { text: '待复核', tone: 'warn' },
}

export function openTest(testId: string, kind: Test['kind']): void {
  shell.openPage('assess.test', { id: testId }, { title: KIND_LABEL[kind] })
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
                    <label key={letter} className="la-row">
                      <input type="checkbox" checked={(answers[problem.id] ?? '').includes(letter)} onChange={event => setAnswers(previous => {
                        const current = new Set((previous[problem.id] ?? '').split(''))
                        if (event.target.checked) current.add(letter)
                        else current.delete(letter)
                        return { ...previous, [problem.id]: [...current].filter(Boolean).sort().join('') }
                      })} />
                      {letter}. {option}
                    </label>
                  )
                })}
              </div>
            )}
            {open && !problem.options && (
              <textarea className="la-textarea" placeholder="写下答案和关键步骤（数值题请带单位）" value={answers[problem.id] ?? ''}
                onChange={event => setAnswers(previous => ({ ...previous, [problem.id]: event.target.value }))} />
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
          <button className="la-btn la-btn-primary" disabled={submit.busy} onClick={() => void submit.run(async () => {
            await shell.call('assess', 'submit', { testId, answers: problems.map(problem => ({ problemId: problem.id, text: answers[problem.id] ?? '' })) })
            view.reload()
          })}>{submit.busy ? '判分中…' : '交卷'}</button>
          <span className="la-muted la-small">交卷后数值题由程序判分，其余由模型判分并标注把握程度。</span>
        </div>
      )}
      {!open && <div className="la-muted la-small">点一道题，可以在右侧就它提问。</div>}
      {submit.error && <div className="la-error">{submit.error}</div>}
    </div>
  )
}

type TestRow = { test: Test; correct: number; total: number }

function TestsSection({ courseId }: { courseId: string }): ReactNode {
  const tests = useLoad(shell, () => shell.call<TestRow[]>('assess', 'tests', { courseId }), [courseId], ['learning/test-finished', 'learning/task-published'])
  if (!tests.data?.length) return null
  return (
    <section className="la-card la-stack">
      <div className="la-h2">测试</div>
      <ul className="la-list">
        {tests.data.map(({ test, correct, total }) => (
          <li key={test.id}>
            <span className="la-tag">{KIND_LABEL[test.kind]}</span>
            <button className="la-link" onClick={() => openTest(test.id, test.kind)}>{shortTime(test.startedAt)}</button>
            {test.status === 'graded'
              ? <span className={`la-tag ${correct === total ? 'ok' : correct === 0 ? 'bad' : 'warn'}`}>对 {correct}/{total}</span>
              : <span className="la-tag accent">待作答</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
