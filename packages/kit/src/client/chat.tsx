// Chat view over one DSH session, shared by the teacher page and the side chat.
// Follows the session through DSH's client remote (`ctx.remote.session.follow`, stage-0 V4) and
// sends prompts with `ctx.remote.session.prompt`. Injected context messages (course brief, side-chat
// context) are shown folded, progress notices (`learning/handoff`) as notices, a run of tool calls
// as one line of steps, and a successful call of a card tool as the card its unit draws.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, BellRing, Sparkles } from 'lucide-react'
import type { ChatCardProps, IconComponent, LearnShell } from '@learning-agent/contracts/client'
import { repairLatexDeep } from '../latex-escapes.ts'
import { promptError } from '../prompt-error.ts'
import { Callout, Disclosure, Skeleton } from './ui.tsx'

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

/** Send one text message into a session. */
export async function sendPrompt(remote: SessionRemote, sessionId: string, text: string): Promise<void> {
  const result = await remote.prompt({ requestId: globalThis.crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  if (!result.ok) throw new Error(promptError(result.error))
}

type Item =
  | { readonly key: string; readonly role: 'user' | 'assistant'; readonly text: string }
  | { readonly key: string; readonly role: 'context'; readonly title: string; readonly text: string }
  | { readonly key: string; readonly role: 'notice'; readonly lines: readonly string[] }
  | { readonly key: string; readonly role: 'steps'; readonly steps: readonly string[] }
  | { readonly key: string; readonly role: 'card'; readonly name: string; readonly args: Readonly<Record<string, unknown>> }

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

/** Context the system adds to a conversation, shown folded; other sources than the learner show as 系统信息. */
const CONTEXT_TITLES: Record<string, string> = {
  'learning-course-brief': '课程现状简报',
  'learning-next-step': '下一步更新',
  'learning-side-chat-context': '本次提问的上下文',
  'learning-side-chat-policy': '测试进行中',
}

const TOOL_TITLES: Record<string, string> = {
  search_library: '查资料库', read_section: '读资料原文', add_knowledge_nodes: '添加知识节点', save_goal_draft: '保存目标说明草稿', revise_goal: '修订目标说明',
  add_problems: '加入题库', start_test: '发布测试', get_test_result: '查看测试结果', save_roadmap: '保存课程路线', save_stage_review: '保存阶段复盘', save_course_report: '保存课程报告',
  save_stage_design: '保存阶段设计书', publish_task: '发布任务', read_lesson_textbook: '读本节教材', regenerate_textbook: '重新生成教材', revise_textbook: '修改教材段落', decide_proposal: '处理修改提案',
  write_lesson_summary: '写课时小结', web_search: '联网搜索', offer_goal_options: '给出候选终点', mark_exam_scope: '标记考试范围',
  import_exercises: '导入习题', calculate: '计算', mark_homework: '记下作业做过的题', review_problem: '核对题目', regrade: '复核判分', withdraw_test: '撤回测试',
}

/** Tools whose successful call shows a card (drawn by the unit through the `learning.chat-card` slot). */
const CARD_TOOLS: ReadonlySet<string> = new Set(['offer_goal_options'])

/** Tool arguments as the model sent them, with LaTeX backslashes repaired as the tool itself saw them. */
function argsOf(raw: unknown): Readonly<Record<string, unknown>> {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw
    return value && typeof value === 'object' ? repairLatexDeep(value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Grow a text area with its content between two heights. */
function useAutosize(ref: { current: HTMLTextAreaElement | null }, value: string, minRows: number, maxRows: number): void {
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const style = getComputedStyle(element)
    const line = parseFloat(style.lineHeight) || 22
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    element.style.height = 'auto'
    element.style.height = `${Math.min(Math.max(element.scrollHeight, line * minRows + padding), line * maxRows + padding)}px`
  }, [ref, value, minRows, maxRows])
}

/** Message box with a send button: Enter sends, Shift+Enter breaks the line, the box grows with the text. */
export function Composer({ value, onChange, onSend, placeholder, hint = 'Enter 发送 · Shift + Enter 换行', sendLabel = '发送', disabled, minRows = 2, maxRows = 12 }: {
  value: string
  onChange(value: string): void
  onSend(): void
  placeholder: string
  hint?: ReactNode
  sendLabel?: string
  disabled?: boolean
  minRows?: number
  maxRows?: number
}): ReactNode {
  const area = useRef<HTMLTextAreaElement>(null)
  useAutosize(area, value, minRows, maxRows)
  return (
    <div className="la-composer">
      <textarea ref={area} rows={minRows} aria-label={placeholder} value={value} placeholder={placeholder} disabled={disabled}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            if (value.trim() && !disabled) onSend()
          }
        }} />
      <div className="la-composer-bar">
        <span className="la-composer-hint">{hint}</span>
        <button type="button" className="la-send" aria-label={sendLabel} title={sendLabel} disabled={!value.trim() || disabled} onClick={onSend}>
          <ArrowUp size={17} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

export function Chat({ shell, remote, sessionId, placeholder, compact, intro, suggestions, renderCard, initialDraft, initialError }: {
  shell: LearnShell
  remote: SessionRemote
  sessionId: string
  placeholder: string
  /** Narrow layout for the side panel. */
  compact?: boolean
  /** Shown above an empty conversation. */
  intro?: { icon: IconComponent; title: ReactNode; description?: ReactNode }
  /** One-click first messages for an empty conversation. */
  suggestions?: readonly string[]
  /** Draws a card tool's card; without it the call shows as a step only. */
  renderCard?: (name: string, props: ChatCardProps) => ReactNode
  /** Text already in the message box when the chat appears (a question whose sending failed before the chat opened). */
  initialDraft?: string
  /** An error already showing when the chat appears; the next send or turn clears it. */
  initialError?: string
}): ReactNode {
  const [items, setItems] = useState<Item[]>([])
  const [loaded, setLoaded] = useState(false)
  const [live, setLive] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(initialDraft ?? '')
  const [error, setError] = useState<string | undefined>(initialError)
  const scroller = useRef<HTMLDivElement>(null)
  /** Follow new messages only while the learner is at the bottom (not reading back). */
  const stick = useRef(true)

  useLayoutEffect(() => {
    if (stick.current) scroller.current?.scrollTo(0, scroller.current.scrollHeight)
  }, [items, live, busy])

  useEffect(() => {
    setItems([])
    setLoaded(false)
    setLive('')
    setBusy(false)
    stick.current = true
    const seen = new Set<number>()
    // Card tool calls wait for their result: a refused call shows no card.
    const cards = new Map<string, { name: string; args: Readonly<Record<string, unknown>> }>()
    const controller = new AbortController()
    const push = (item: Item) => setItems(list => [...list, item])
    const onEvent = (event: SessionEvent) => {
      if (event.seq !== undefined) {
        if (seen.has(event.seq)) return
        seen.add(event.seq)
      }
      const data = event.data ?? {}
      const key = `${event.seq ?? Math.random()}`
      if (event.type === 'user/message') {
        const source = (data.source as { kind?: string } | undefined)?.kind
        const text = textOf(data)
        if (source === NOTICE_SOURCE) push({ key, role: 'notice', lines: text.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2)) })
        else if (!source || source === 'user') push({ key, role: 'user', text })
        else push({ key, role: 'context', title: CONTEXT_TITLES[source] ?? '系统信息', text })
      } else if (event.type === 'assistant/message') {
        setLive('')
        const text = textOf(data)
        if (text) push({ key, role: 'assistant', text })
      } else if (event.type === 'tool/result') {
        const message = data.message as { toolCallId?: string; isError?: boolean } | undefined
        const card = message?.toolCallId ? cards.get(message.toolCallId) : undefined
        if (card && !message!.isError) push({ key, role: 'card', ...card })
      } else if (event.type === 'tool/call') {
        const name = String(data.name ?? '')
        if (CARD_TOOLS.has(name) && data.callId) cards.set(String(data.callId), { name, args: argsOf(data.arguments) })
        const step = TOOL_TITLES[name] ?? name
        setItems(list => {
          const last = list.at(-1)
          if (last?.role === 'steps') return [...list.slice(0, -1), { ...last, steps: [...last.steps, step] }]
          return [...list, { key, role: 'steps', steps: [step] }]
        })
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
          if (frame.type === 'snapshot') {
            for (const record of (frame as Extract<Frame, { type: 'snapshot' }>).records) onEvent(record.event)
            setLoaded(true)
          } else if (frame.type === 'event') onEvent((frame as Extract<Frame, { type: 'event' }>).event)
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
      } finally {
        setLoaded(true)
      }
    })()
    return () => controller.abort()
  }, [remote, sessionId])

  async function send(value = draft): Promise<void> {
    const text = value.trim()
    if (!text) return
    setDraft('')
    setError(undefined)
    setBusy(true)
    stick.current = true
    try {
      await sendPrompt(remote, sessionId, text)
    } catch (caught) {
      setBusy(false)
      setDraft(current => current || text)
      setError(`发送失败：${String((caught as Error)?.message ?? caught)}`)
    }
  }

  const conversation = items.some(item => item.role === 'user' || item.role === 'assistant' || item.role === 'notice')
  return (
    <div className={`la-chat${compact ? ' compact' : ''}`}>
      <div className="la-chat-scroll" ref={scroller} onScroll={event => {
        const element = event.currentTarget
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
      }}>
        <div className="la-chat-list" aria-live="polite">
          {!loaded && <Skeleton lines={3} />}
          {loaded && !conversation && !busy && intro && (
            <div className="la-chat-start">
              <span className="la-empty-icon"><intro.icon size={22} strokeWidth={1.75} /></span>
              <div className="la-empty-title">{intro.title}</div>
              {intro.description && <div className="la-empty-desc">{intro.description}</div>}
              {suggestions && suggestions.length > 0 && (
                <div className="la-suggestions">
                  {suggestions.map(text => <button key={text} type="button" className="la-suggestion" onClick={() => void send(text)}>{text}</button>)}
                </div>
              )}
            </div>
          )}
          {items.map((item, index) => {
            if (item.role === 'card') {
              const reply = items.slice(index + 1).find(next => next.role === 'user')
              return renderCard ? <div key={item.key} className="la-msg card">{renderCard(item.name, {
                args: item.args,
                ...(reply?.role === 'user' ? { reply: reply.text } : {}),
                send: text => void send(text),
                fill: setDraft,
              })}</div> : null
            }
            if (item.role === 'context') {
              return <Disclosure key={item.key} className="la-msg context" summary={item.title}><shell.Markdown text={item.text} /></Disclosure>
            }
            if (item.role === 'assistant') return <div key={item.key} className="la-msg assistant"><shell.Markdown text={item.text} /></div>
            if (item.role === 'notice') {
              return (
                <div key={item.key} className="la-msg notice" title="进度通知：页面上完成的操作和后台任务的结果会自动告诉老师">
                  <BellRing size={14} strokeWidth={1.75} />
                  <ul>{item.lines.map((line, index) => <li key={index}><shell.Markdown text={line} inline /></li>)}</ul>
                </div>
              )
            }
            if (item.role === 'steps') {
              return (
                <div key={item.key} className="la-msg steps" aria-label="老师用到的工具">
                  <Sparkles size={13} strokeWidth={1.75} />
                  {item.steps.map((step, index) => <span key={index} className="la-step">{step}</span>)}
                </div>
              )
            }
            return <div key={item.key} className="la-msg user">{item.text}</div>
          })}
          {live && <div className="la-msg assistant"><shell.Markdown text={live} /></div>}
          {busy && !live && <div className="la-thinking"><span className="la-thinking-dots"><i /><i /><i /></span>正在思考</div>}
        </div>
      </div>
      <div className="la-composer-wrap">
        {error && <div className="la-composer-error"><Callout tone="bad">{error}</Callout></div>}
        <Composer value={draft} onChange={setDraft} onSend={() => void send()} placeholder={placeholder} maxRows={compact ? 8 : 12} />
      </div>
    </div>
  )
}
