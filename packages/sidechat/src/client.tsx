// sidechat unit, browser half: the right sidebar. Opens a side chat bound to what is selected on the
// current page, and ends it with a summary written to the course notes.
import { useState, type ReactNode } from 'react'
import type { SideChatSummary } from '@learning-agent/contracts'
import type { ClientContext, LearnShell, ShellScope } from '@learning-agent/contracts/client'
import { useAction, useLoad, useSelection } from '@learning-agent/kit/client'
import { Chat, type SessionRemote } from '@learning-agent/kit/chat'

export const name = 'learning-sidechat'
export const inject = ['slots', 'learnShell', 'remote', 'remote.session']

let shell: LearnShell
let remote: SessionRemote

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  remote = (ctx as unknown as { remote: { session: SessionRemote } }).remote.session
  ctx.effect(() => ctx.slots.inject('learning.side-chat', () => ctx.slots.register({ name: 'learning.side-chat' }, SidePanel)), 'sidechat: sidebar')
}

function SidePanel({ scope }: { scope: ShellScope }): ReactNode {
  if (scope.kind !== 'course') {
    return <div className="la-pad la-muted">进入一门课后，可以在这里针对任何页面上选中的内容提问。（主界面的侧边会话之后再做。）</div>
  }
  return <CourseSideChat courseId={scope.courseId} />
}

function CourseSideChat({ courseId }: { courseId: string }): ReactNode {
  const selection = useSelection(shell)
  const active = useLoad(shell, () => shell.call<{ sessionId: string; label: string } | null>('sidechat', 'active', { courseId }), [courseId], ['learning/sidechat-summarized'])
  const [summary, setSummary] = useState<SideChatSummary>()
  const action = useAction()
  const session = active.data

  const open = () => action.run(async () => {
    setSummary(undefined)
    await shell.call('sidechat', 'open', { selection: selection ?? { page: 'course', courseId } })
    active.reload()
  })
  const close = () => action.run(async () => {
    if (!session) return
    setSummary(await shell.call<SideChatSummary>('sidechat', 'close', { sessionId: session.sessionId }))
    active.reload()
  })

  if (session) {
    return (
      <div className="la-chat">
        <div className="la-row la-small" style={{ padding: '8px 12px', borderBottom: '1px solid var(--la-border)' }}>
          <span className="la-muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>侧边会话 · {session.label}</span>
          <button className="la-btn" disabled={action.busy} onClick={() => void close()}>{action.busy ? '整理中…' : '结束并写总结'}</button>
        </div>
        {action.error && <div className="la-error" style={{ padding: '0 12px' }}>{action.error}</div>}
        <div style={{ flex: 1, minHeight: 0 }}>
          <Chat key={session.sessionId} shell={shell} remote={remote} sessionId={session.sessionId} placeholder="问吧，这里的对话不会打断主老师" />
        </div>
      </div>
    )
  }
  return (
    <div className="la-pad la-stack">
      <div className="la-h2">侧边会话</div>
      <div className="la-muted">和主老师的会话分开，不打断课程。结束时会自动写一条总结到课程笔记。</div>
      <div className="la-card la-small">
        {selection?.selected ? <>将针对：<b>{selection.selected.label}</b></> : <span className="la-muted">在教材、知识模型或测试页上点一下内容，就能针对它提问；不选也可以直接问。</span>}
      </div>
      <div><button className="la-btn la-btn-primary" disabled={action.busy} onClick={() => void open()}>{action.busy ? '打开中…' : '开始提问'}</button></div>
      {action.error && <div className="la-error">{action.error}</div>}
      {summary && (
        <div className="la-card la-stack la-small" style={{ gap: 4 }}>
          <b>上一次会话的总结</b>
          <SummaryList title="问了" items={summary.questions} />
          <SummaryList title="结论" items={summary.conclusions} />
          {summary.misconceptions.length > 0 && <SummaryList title="可能的误解" items={summary.misconceptions} />}
          <div className="la-muted">已写入 notes/side-chats.md</div>
        </div>
      )}
    </div>
  )
}

function SummaryList({ title, items }: { title: string; items: readonly string[] }): ReactNode {
  return (
    <div>
      <div className="la-muted">{title}</div>
      {items.length === 0 ? '—' : <ul style={{ margin: '2px 0', paddingLeft: 18 }}>{items.map(item => <li key={item}><shell.Markdown text={item} inline /></li>)}</ul>}
    </div>
  )
}
