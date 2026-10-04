// Chat view over one DSH session, shared by the teacher page and the side chat.
// Follows the session through DSH's client remote (`ctx.remote.session.follow`, stage-0 V4) and
// sends prompts with `ctx.remote.session.prompt`. Injected context messages (course brief, side-chat
// context) are shown folded, progress notices (`learning/handoff`) as notices, tool calls as one-line notes.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, BellRing, CornerDownRight, LoaderCircle } from 'lucide-react'
import type { LearnShell } from '@learning-agent/contracts/client'
import { Button, Disclosure, TextArea } from './ui.tsx'

interface SessionEvent {
  readonly type: string
  readonly seq?: number
  readonly data?: Record<string, unknown>
}

type Frame =
  | { readonly type: 'snapshot'; readonly records: readonly { readonly event: SessionEvent }[] }
  | { readonly type: 'event'; readonly event: SessionEvent }
  | { readonly type: 'assistant-stream'; readonly frame: { readonly type: string; readonly chunk?: { readonly type?: string; readonly text?: unknown; readonly delta?: unknown } } }
  | { readonly type: string }

/** The part of DSH's browser session remote the chat uses. */
export interface SessionRemote {
  follow(request: { address: { kind: 'session'; sessionId: string }; assistantStream: boolean }, signal?: AbortSignal): AsyncIterable<Frame>
  prompt(request: { requestId: string; sessionId: string; mode: 'queue'; content: { type: 'text'; text: string }[] }): Promise<{ ok: boolean; error?: unknown }>
}

interface Item {
  readonly key: string
  readonly role: 'user' | 'assistant' | 'tool' | 'context' | 'notice'
  readonly text: string
  readonly title?: string
}

/** Concatenate the text parts of a message-like value. */
function textOf(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(part => ((part as { type?: string })?.type === 'text' ? String((part as { text?: unknown }).text ?? '') : '')).join('')
  const record = value as Record<string, unknown>
  if (record.content) return textOf(record.content)
  if (record.message) return textOf(record.message)
  return ''
}

/** Source of the teacher's progress notices; only their "- " lines are for the learner to read. */
const NOTICE_SOURCE = 'learning-handoff'

const CONTEXT_TITLES: Record<string, string> = {
  'learning-course-brief': '课程现状简报',
  'learning-side-chat-context': '本次提问的上下文',
}

const TOOL_TITLES: Record<string, string> = {
  search_library: '查资料库', read_section: '读资料原文', add_knowledge_nodes: '添加知识节点', save_goal_draft: '保存目标说明草稿',
  add_problems: '加入题库', start_test: '发布测试', get_test_result: '查看测试结果', save_roadmap: '保存课程路线',
  save_stage_design: '保存阶段设计书', publish_task: '发布任务', read_lesson_textbook: '读本节教材', regenerate_textbook: '重新生成教材',
  write_lesson_summary: '写课时小结', web_search: '联网搜索',
}

export function Chat({ shell, remote, sessionId, placeholder, footer }: {
  shell: LearnShell
  remote: SessionRemote
  sessionId: string
  placeholder: string
  footer?: ReactNode
}): ReactNode {
  const [items, setItems] = useState<Item[]>([])
  const [live, setLive] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string>()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight)
  }, [items, live])

  useEffect(() => {
    setItems([])
    setLive('')
    setBusy(false)
    const seen = new Set<number>()
    const controller = new AbortController()
    const onEvent = (event: SessionEvent) => {
      if (event.seq !== undefined) {
        if (seen.has(event.seq)) return
        seen.add(event.seq)
      }
      const data = event.data ?? {}
      const key = `${event.seq ?? Math.random()}`
      if (event.type === 'user/message') {
        const source = (data.source as { kind?: string } | undefined)?.kind
        const contextTitle = source ? CONTEXT_TITLES[source] : undefined
        const text = textOf(data)
        if (source === NOTICE_SOURCE) {
          const lines = text.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2))
          setItems(list => [...list, { key, role: 'notice', text: lines.join('\n') }])
        } else {
          setItems(list => [...list, contextTitle ? { key, role: 'context', title: contextTitle, text } : { key, role: 'user', text }])
        }
      } else if (event.type === 'assistant/message') {
        setLive('')
        const text = textOf(data)
        if (text) setItems(list => [...list, { key, role: 'assistant', text }])
      } else if (event.type === 'tool/call') {
        const name = String(data.name ?? '')
        setItems(list => [...list, { key, role: 'tool', text: TOOL_TITLES[name] ?? name }])
      } else if (event.type === 'turn/start') {
        setBusy(true)
        setError(undefined)
      } else if (event.type === 'turn/end') {
        setBusy(false)
        setLive('')
        const reason = data.reason as { kind?: string; error?: { message?: string; code?: string } } | undefined
        if (reason?.kind === 'error') {
          setError(`这次回复没有完成：${reason.error?.message ?? reason.error?.code ?? '模型调用失败'}。可以重新发送消息再试。`)
        }
      }
    }
    void (async () => {
      try {
        for await (const frame of remote.follow({ address: { kind: 'session', sessionId }, assistantStream: true }, controller.signal)) {
          if (controller.signal.aborted) break
          if (frame.type === 'snapshot') for (const record of (frame as Extract<Frame, { type: 'snapshot' }>).records) onEvent(record.event)
          else if (frame.type === 'event') onEvent((frame as Extract<Frame, { type: 'event' }>).event)
          else if (frame.type === 'assistant-stream') {
            const inner = (frame as Extract<Frame, { type: 'assistant-stream' }>).frame
            if (inner.type === 'start' || inner.type === 'end') setLive('')
            else if (inner.type === 'chunk' && inner.chunk) {
              const kind = String(inner.chunk.type ?? '')
              const piece = typeof inner.chunk.text === 'string' ? inner.chunk.text : typeof inner.chunk.delta === 'string' ? inner.chunk.delta : ''
              if (piece && !kind.includes('reason')) setLive(text => text + piece)
            }
          }
        }
      } catch (caught) {
        if (!controller.signal.aborted) setError(`会话连接中断：${String((caught as Error)?.message ?? caught)}`)
      }
    })()
    return () => controller.abort()
  }, [remote, sessionId])

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setError(undefined)
    setBusy(true)
    try {
      const result = await remote.prompt({ requestId: globalThis.crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] })
      if (!result.ok) throw new Error(JSON.stringify(result.error))
    } catch (caught) {
      setBusy(false)
      setDraft(current => current || text)
      setError(`发送失败：${String((caught as Error)?.message ?? caught)}`)
    }
  }

  return (
    <div className="la-chat">
      <div className="la-chat-list" ref={listRef}>
        {items.map(item => {
          if (item.role === 'context') {
            return <Disclosure key={item.key} className="la-msg context" summary={item.title}><shell.Markdown text={item.text} /></Disclosure>
          }
          if (item.role === 'assistant') return <div key={item.key} className="la-msg assistant"><shell.Markdown text={item.text} /></div>
          if (item.role === 'notice') {
            return (
              <div key={item.key} className="la-msg notice" title="进度通知：页面上完成的操作和后台任务的结果会自动告诉老师">
                <BellRing size={14} strokeWidth={1.75} />
                <ul>{item.text.split('\n').map((line, index) => <li key={index}><shell.Markdown text={line} inline /></li>)}</ul>
              </div>
            )
          }
          if (item.role === 'tool') return <div key={item.key} className="la-msg tool"><CornerDownRight size={12} strokeWidth={1.75} />{item.text}</div>
          return <div key={item.key} className={`la-msg ${item.role}`}>{item.text}</div>
        })}
        {live && <div className="la-msg assistant"><shell.Markdown text={live} /></div>}
        {busy && !live && <div className="la-msg tool"><LoaderCircle size={12} strokeWidth={1.75} className="la-spin" />正在思考…</div>}
      </div>
      <div className="la-chat-input">
        {error && <div className="la-error">{error}</div>}
        <TextArea
          minRows={2}
          maxRows={10}
          aria-label="给老师的消息"
          value={draft}
          placeholder={placeholder}
          onChange={setDraft}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        <div className="la-row">
          <span className="la-muted la-small">Enter 发送，Shift+Enter 换行</span>
          <span className="la-spacer" />
          {footer}
          <Button variant="primary" icon={ArrowUp} disabled={!draft.trim()} onClick={() => void send()}>发送</Button>
        </div>
      </div>
    </div>
  )
}
