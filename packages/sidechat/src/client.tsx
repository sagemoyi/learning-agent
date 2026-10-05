// sidechat unit, browser half: the side-chat panel. Opens a side chat bound to what is selected on the
// current page (the first question opens it), and ends it with a summary written to the course notes.
import { useState, type ReactNode } from 'react'
import { BookOpen, ClipboardCheck, MessageCircleQuestion, MousePointerClick, Network, NotebookPen, X } from 'lucide-react'
import type { SideChatSummary } from '@learning-agent/contracts'
import type { ClientContext, IconComponent, LearnShell, ShellScope } from '@learning-agent/contracts/client'
import { Button, Callout, EmptyState, Skeleton, useAction, useLoad, useSelection } from '@learning-agent/kit/client'
import { Chat, Composer, sendPrompt, type SessionRemote } from '@learning-agent/kit/chat'

export const name = 'learning-sidechat'
export const inject = ['slots', 'learnShell', 'remote', 'remote.session']

let shell: LearnShell
let remote: SessionRemote

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  remote = (ctx as unknown as { remote: { session: SessionRemote } }).remote.session
  ctx.effect(() => ctx.slots.inject('learning.side-chat', () => ctx.slots.register({ name: 'learning.side-chat' }, SidePanel)), 'sidechat: sidebar')
}

const KIND_ICON: Record<string, IconComponent> = { block: BookOpen, node: Network, problem: ClipboardCheck, attempt: ClipboardCheck }

function SidePanel({ scope }: { scope: ShellScope }): ReactNode {
  if (scope.kind !== 'course') {
    return <EmptyState icon={MessageCircleQuestion} title="进入一门课后可以提问" description="在教材、知识模型或测试页上点一下内容，就能针对它提问。" />
  }
  return <CourseSideChat courseId={scope.courseId} />
}

function CourseSideChat({ courseId }: { courseId: string }): ReactNode {
  const selection = useSelection(shell)
  const active = useLoad(shell, () => shell.call<{ sessionId: string; label: string } | null>('sidechat', 'active', { courseId }), [courseId], ['learning/sidechat-summarized'])
  const [summary, setSummary] = useState<SideChatSummary>()
  const [draft, setDraft] = useState('')
  const action = useAction()
  const session = active.data

  const ask = () => {
    const text = draft.trim()
    if (!text || action.busy) return
    void action.run(async () => {
      setSummary(undefined)
      const opened = await shell.call<{ sessionId: string }>('sidechat', 'open', { selection: selection?.courseId === courseId ? selection : { page: 'course', courseId } })
      await sendPrompt(remote, opened.sessionId, text)
      setDraft('')
      active.reload()
    })
  }
  const close = () => action.run(async () => {
    if (!session) return
    setSummary(await shell.call<SideChatSummary>('sidechat', 'close', { sessionId: session.sessionId }))
    active.reload()
  })

  if (active.loading && active.data === undefined) return <div style={{ padding: 16 }}><Skeleton lines={3} /></div>
  if (session) {
    return (
      <div className="la-chat" style={{ minHeight: 0, flex: 1 }}>
        <div className="la-row nowrap" style={{ padding: '10px 12px 10px 16px', borderBottom: '1px solid var(--la-line)' }}>
          <span className="la-small la-faint la-ellipsis" style={{ flex: 1 }} title={session.label}>针对：{session.label || '整门课'}</span>
          <Button size="sm" icon={NotebookPen} loading={action.busy} title="结束这次提问，自动把总结写进课程笔记" onClick={() => void close()}>{action.busy ? '整理中…' : '结束并总结'}</Button>
        </div>
        {action.error && <div style={{ padding: '8px 12px 0' }}><Callout tone="bad">{action.error}</Callout></div>}
        <div style={{ flex: 1, minHeight: 0 }}>
          <Chat key={session.sessionId} compact shell={shell} remote={remote} sessionId={session.sessionId} placeholder="接着问，这里不会打断主老师" />
        </div>
      </div>
    )
  }

  const target = selection?.courseId === courseId ? selection.selected : undefined
  const TargetIcon = target ? KIND_ICON[target.kind] ?? MousePointerClick : MousePointerClick
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '16px 14px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', alignContent: 'start', gap: 14 }}>
      <div className="la-stack tight">
        <span className="la-small la-faint">要问的内容</span>
        {target ? (
          <div className="la-callout accent" style={{ alignItems: 'center' }}>
            <TargetIcon size={16} strokeWidth={1.75} className="la-callout-icon" style={{ marginTop: 0 }} />
            <div className="la-callout-body la-ellipsis" title={target.label}>{target.label}</div>
            <button type="button" className="la-icon-btn" aria-label="不针对这段内容" title="不针对这段内容，问整门课" onClick={() => shell.select(undefined)}><X size={14} strokeWidth={1.75} /></button>
          </div>
        ) : (
          <div className="la-callout">
            <MousePointerClick size={16} strokeWidth={1.75} className="la-callout-icon" />
            <div className="la-callout-body la-callout-text">没有选中内容，会针对整门课回答。在教材、知识模型或测试页上点一下内容，就能针对它提问。</div>
          </div>
        )}
      </div>
      <Composer value={draft} onChange={setDraft} onSend={ask} placeholder="想问什么？" sendLabel="开始提问" disabled={action.busy} minRows={4} maxRows={10}
        hint="和主老师的对话分开，结束时自动写总结" />
      {action.busy && <div className="la-thinking"><span className="la-thinking-dots"><i /><i /><i /></span>正在打开</div>}
      {action.error && <Callout tone="bad">{action.error}</Callout>}
      {summary && (
        <div className="la-card la-stack tight" style={{ fontSize: 'var(--la-fs-sm)' }}>
          <div className="la-row"><NotebookPen size={15} strokeWidth={1.75} style={{ color: 'var(--la-ok)' }} /><b>上一次提问的总结</b></div>
          <SummaryList title="问了" items={summary.questions} />
          <SummaryList title="结论" items={summary.conclusions} />
          {summary.misconceptions.length > 0 && <SummaryList title="可能的误解" items={summary.misconceptions} />}
          <div className="la-faint la-small">已写入课程笔记 notes/side-chats.md</div>
        </div>
      )}
    </div>
  )
}

function SummaryList({ title, items }: { title: string; items: readonly string[] }): ReactNode {
  return (
    <div>
      <div className="la-faint la-small">{title}</div>
      {items.length === 0 ? <span className="la-faint">—</span> : <ul style={{ margin: '2px 0', paddingLeft: 18 }}>{items.map(item => <li key={item}><shell.Markdown text={item} inline /></li>)}</ul>}
    </div>
  )
}
