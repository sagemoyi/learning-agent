// Chat view over one DSH session, shared by the teacher page and the side chat. DSH's SessionEventStream holds the
// connection: it reconnects by itself, gives a complete window again afterwards, and pages back through older messages.
// Prompts go through `ctx.remote.session.prompt`. What is shown comes from the events (chat-events.ts); whether the
// connection holds and whether the teacher is answering are two separate things.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, BellRing, Sparkles } from 'lucide-react'
import { SessionEventStream } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ChatCardProps, IconComponent, LearnShell } from '@learning-agent/contracts/client'
import { promptError } from '../prompt-error.ts'
import { attemptText, chunkText, itemsOf, runningOf, turnErrorOf, type SessionEvent } from './chat-events.ts'
import { Button, Callout, Disclosure, Skeleton } from './ui.tsx'

/** DSH's browser remote: what its session stream needs, and what sends a message. */
export type ChatRemote = ConstructorParameters<typeof SessionEventStream>[0]

/** A page of older messages, as DSH's own client asks for them. */
const PAGE = { maxMessages: 500, turnWindow: { minMessages: 50, minTurns: 2 } } as const

/** Send one text message into a session. */
export async function sendPrompt(remote: ChatRemote, sessionId: string, text: string): Promise<void> {
  const prompt = remote.session.prompt as unknown as (request: { requestId: string; sessionId: string; mode: 'queue'; content: { type: 'text'; text: string }[] }) => Promise<{ ok: boolean; error?: unknown }>
  const result = await prompt({ requestId: globalThis.crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  if (!result.ok) throw new Error(promptError(result.error))
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

export function Chat({ shell, remote, sessionId, placeholder, compact, intro, suggestions, renderCard, initialDraft, initialError, onDraft }: {
  shell: LearnShell
  remote: ChatRemote
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
  /** Told what is in the message box, for keeping it when the chat goes away. */
  onDraft?: (text: string) => void
}): ReactNode {
  const [events, setEvents] = useState<readonly SessionEvent[]>([])
  const [loaded, setLoaded] = useState(false)
  const [live, setLive] = useState('')
  /** A message was sent and its turn has not been seen yet. */
  const [waiting, setWaiting] = useState(false)
  const [broken, setBroken] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [older, setOlder] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [draft, setDraft] = useState(initialDraft ?? '')
  const [error, setError] = useState<string | undefined>(initialError)
  /** Counts the times the learner asked to open a stream DSH gave up on. */
  const [opening, setOpening] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  /** Follow new messages only while the learner is at the bottom (not reading back). */
  const stick = useRef(true)
  /** Where the scroller stood before older messages were put above: they must not move what is being read. */
  const before = useRef<{ height: number; top: number }>(undefined)
  const stream = useRef<SessionEventStream>(undefined)
  const items = useMemo(() => itemsOf(events), [events])
  const busy = waiting || runningOf(events)
  const failedTurn = useMemo(() => turnErrorOf(events), [events])

  useLayoutEffect(() => {
    const element = scroller.current
    if (element && before.current) {
      element.scrollTop = before.current.top + element.scrollHeight - before.current.height
      before.current = undefined
    } else if (stick.current) element?.scrollTo(0, element.scrollHeight)
  }, [items, live, busy])

  useEffect(() => { onDraft?.(draft) }, [draft])

  useEffect(() => {
    setEvents([])
    setLoaded(false)
    setLive('')
    setWaiting(false)
    setBroken(false)
    setHasMore(false)
    setOlder('idle')
    stick.current = true
    /** The reply being written, followed from where this connection saw it start (or joined it). */
    let attempt: { id: unknown; next: number } | undefined
    const events = new SessionEventStream(remote, { kind: 'session', sessionId } as never, {
      publish: change => {
        if (change.type === 'replace') {
          // A complete window: first, or again after a reconnect. Nothing is merged, so nothing shows twice.
          setEvents(change.entries.map(entry => entry.event as unknown as SessionEvent))
          setHasMore(change.hasMore)
          setBroken(false)
          setWaiting(false)
          setLoaded(true)
          const writing = change.page.assistantStream?.activeAttempt
          attempt = writing ? { id: writing.attemptId, next: writing.nextIndex } : undefined
          setLive(writing ? attemptText(writing.stream) : '')
        } else if (change.type === 'prepend') {
          const element = scroller.current
          before.current = element ? { height: element.scrollHeight, top: element.scrollTop } : undefined
          setEvents(list => [...change.entries.map(entry => entry.event as unknown as SessionEvent), ...list])
          setHasMore(change.hasMore)
        } else if (change.type === 'append') {
          const event = change.entry.event as unknown as SessionEvent
          setEvents(list => [...list, event])
          if (event.type === 'turn/start') {
            setWaiting(false)
            setError(undefined)
          } else if (event.type === 'assistant/message' || event.type === 'turn/end') setLive('')
        } else if (change.type === 'assistant-stream') {
          const frame = change.frame
          if (frame.type === 'start') {
            attempt = { id: frame.attemptId, next: 0 }
            setLive('')
          } else if (frame.type === 'end') {
            attempt = undefined
            setLive('')
          } else if (attempt && attempt.id === frame.attemptId) {
            // A chunk went missing: open again for a complete baseline.
            if (frame.index !== attempt.next) queueMicrotask(() => events.restart())
            else {
              attempt.next += 1
              const piece = chunkText(frame.chunk)
              if (piece) setLive(text => text + piece)
            }
          }
        }
      },
      carrierFailed: () => setBroken(true),
      failed: caught => {
        setBroken(false)
        setWaiting(false)
        setError(`会话连接中断：${String((caught as Error)?.message ?? caught)}`)
      },
    })
    stream.current = events
    events.open(PAGE).catch((caught: unknown) => {
      if (events.signal.aborted) return
      setError(`会话打不开：${String((caught as Error)?.message ?? caught)}`)
      setLoaded(true)
    })
    return () => { void events.dispose() }
  }, [remote, sessionId, opening])

  async function send(value = draft): Promise<void> {
    const text = value.trim()
    if (!text) return
    setDraft('')
    setError(undefined)
    setWaiting(true)
    stick.current = true
    try {
      await sendPrompt(remote, sessionId, text)
    } catch (caught) {
      setWaiting(false)
      setDraft(current => current || text)
      setError(`发送失败：${String((caught as Error)?.message ?? caught)}`)
    }
  }

  async function loadOlder(): Promise<void> {
    const first = events[0]?.seq
    if (first === undefined || older === 'loading') return
    setOlder('loading')
    try {
      await stream.current?.prepend({ beforeSeq: first, ...PAGE })
      setOlder('idle')
    } catch {
      setOlder('failed')
    }
  }

  const showError = error ?? (waiting ? undefined : failedTurn)
  const conversation = items.some(item => item.role === 'user' || item.role === 'assistant' || item.role === 'notice')
  return (
    <div className={`la-chat${compact ? ' compact' : ''}`}>
      <div className="la-chat-scroll" ref={scroller} onScroll={event => {
        const element = event.currentTarget
        stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
      }}>
        <div className="la-chat-list" aria-live="polite">
          {!loaded && <Skeleton lines={3} />}
          {hasMore && (
            <div className="la-chat-older">
              <Button size="sm" variant="quiet" loading={older === 'loading'} onClick={() => void loadOlder()}>{older === 'failed' ? '没有加载出来，再试一次' : '加载更早的消息'}</Button>
            </div>
          )}
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
        {showError && <div className="la-composer-error"><Callout tone="bad" actions={error?.startsWith('会话') ? <Button size="sm" onClick={() => { setError(undefined); setOpening(count => count + 1) }}>重新连接</Button> : undefined}>{showError}</Callout></div>}
        <Composer value={draft} onChange={setDraft} onSend={() => void send()} placeholder={placeholder} maxRows={compact ? 8 : 12}
          {...(broken ? { hint: <span className="la-composer-broken" role="status">连接断了，正在重连；恢复后消息会补上</span> } : {})} />
      </div>
    </div>
  )
}
