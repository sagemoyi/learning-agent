// Browser half of the stage-0 spike.
// V2: occupy DSH's 'root' slot so the whole page is ours, lay it out with dockview,
//     and talk to agent sessions through the session-controller Remote.
// V3: call our own backend endpoint over the authenticated connection.
// V4: open one session per agent preset (teacher / side-chat) and show which tools each sees.
import { useEffect, useRef, useState } from 'react'
import { DockviewReact } from 'dockview'
import dockviewCss from 'dockview/dist/styles/dockview.css'
import appCss from './app.css'

/** Client services this plugin reads. */
export const inject = ['slots', 'connection', 'remote', 'remote.session']

/** @type {any} Client root context, captured at apply time for the React tree. */
let CTX

export function apply(ctx) {
  CTX = ctx
  // Stage-0 debugging handle; removed once the spike is done.
  window.__learningSpike = ctx
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.owner = 'learning-spike'
    style.textContent = `${dockviewCss}\n${appCss}`
    document.head.append(style)
    return () => style.remove()
  }, 'learning-spike: styles')
  ctx.effect(() => ctx.slots.register({ name: 'root' }, App), 'learning-spike: root')
}

/** Render a Remote failure with its code, message, and details. */
function describe(error) {
  if (!error) return 'unknown error'
  return JSON.stringify({ code: error.code, message: error.message, details: error.details })
}

async function rpc(endpoint, payload) {
  const result = await CTX.connection.rpc.call('/api', `learning/${endpoint}`, payload)
  if (!result.ok) throw new Error(describe(result.error))
  return result.value
}

function App() {
  return (
    <div className="ls-app">
      <header className="ls-top">
        <span className="ls-brand">学习工作台</span>
        <span className="ls-crumb">阶段 0 验证 · 整页由 learning-spike 接管</span>
      </header>
      <div className="ls-dock">
        <DockviewReact
          className="dockview-theme-light"
          components={{ chat: ChatPanel, rpc: RpcPanel }}
          onReady={event => {
            event.api.addPanel({ id: 'teacher', component: 'chat', title: '主老师', params: { preset: 'teacher' } })
            event.api.addPanel({ id: 'rpc', component: 'rpc', title: '后端接口', position: { referencePanel: 'teacher', direction: 'within' } })
            event.api.addPanel({ id: 'side', component: 'chat', title: '侧边会话', params: { preset: 'side-chat' }, position: { referencePanel: 'teacher', direction: 'right' } })
            event.api.getPanel('teacher')?.api.setActive()
          }}
        />
      </div>
    </div>
  )
}

function RpcPanel() {
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  return (
    <div className="ls-pane">
      <p>调用后端插件的 <code>learning/hello</code> 接口（DSH 认证通道 /api 上的精确路由）：</p>
      <button onClick={() => rpc('hello', { name: '墨' }).then(setResult, e => setError(String(e)))}>调用</button>
      {result && <pre className="ls-pre">{JSON.stringify(result, null, 2)}</pre>}
      {error && <pre className="ls-pre ls-err">{error}</pre>}
    </div>
  )
}

/** Concatenate the text parts of a content list or message-like object. */
function textOf(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(part => (part?.type === 'text' ? part.text : '')).join('')
  if (value.content) return textOf(value.content)
  if (value.message) return textOf(value.message)
  return ''
}

function ChatPanel({ params }) {
  const preset = params.preset
  const [sessionId, setSessionId] = useState(null)
  const [items, setItems] = useState([])
  const [live, setLive] = useState('')
  const [tools, setTools] = useState(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(null)
  const seen = useRef(new Set())
  const listRef = useRef(null)

  useEffect(() => {
    listRef.current?.scrollTo(0, listRef.current.scrollHeight)
  }, [items, live])

  function onEvent(event) {
    if (event.seq !== undefined) {
      if (seen.current.has(event.seq)) return
      seen.current.add(event.seq)
    }
    const data = event.data ?? {}
    if (event.type === 'request/header') setTools((data.header?.tools ?? []).map(t => t.name))
    else if (event.type === 'user/message') setItems(xs => [...xs, { role: 'user', text: textOf(data) }])
    else if (event.type === 'assistant/message') {
      setLive('')
      const text = textOf(data)
      if (text) setItems(xs => [...xs, { role: 'assistant', text }])
    } else if (event.type === 'tool/call') setItems(xs => [...xs, { role: 'tool', text: `调用工具 ${data.name ?? ''} ${data.arguments ?? ''}` }])
    else if (event.type === 'tool/result') setItems(xs => [...xs, { role: 'tool', text: `工具结果：${textOf(data.result ?? data).slice(0, 300)}` }])
  }

  async function follow(id) {
    const stream = CTX.remote.session.follow({ address: { kind: 'session', sessionId: id }, assistantStream: true })
    for await (const frame of stream) {
      if (frame.type === 'snapshot') frame.records.forEach(record => onEvent(record.event))
      else if (frame.type === 'event') onEvent(frame.event)
      else if (frame.type === 'assistant-stream') {
        const f = frame.frame
        if (f.type === 'start' || f.type === 'end') setLive('')
        else if (f.type === 'chunk' && f.chunk && typeof f.chunk === 'object') {
          const kind = String(f.chunk.type ?? '')
          const piece = typeof f.chunk.text === 'string' ? f.chunk.text : typeof f.chunk.delta === 'string' ? f.chunk.delta : ''
          if (piece && !kind.includes('reason')) setLive(s => s + piece)
        }
      }
    }
  }

  async function start() {
    setError(null)
    try {
      const { cwd } = await rpc('hello', {})
      const created = await CTX.remote.session.create({ agentPreset: preset, cwd })
      if (!created.ok) throw new Error(describe(created.error))
      setSessionId(created.value.sessionId)
      follow(created.value.sessionId).catch(e => setError(`follow: ${e}`))
    } catch (e) {
      setError(String(e))
    }
  }

  async function send() {
    const text = draft.trim()
    if (!text || !sessionId) return
    setDraft('')
    const result = await CTX.remote.session.prompt({
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    })
    if (!result.ok) setError(describe(result.error))
  }

  return (
    <div className="ls-chat">
      <div className="ls-meta">
        预设 <b>{preset}</b>
        {sessionId ? <> · 会话 <code>{sessionId.slice(0, 18)}…</code></> : <button onClick={start}>新建会话</button>}
        {tools && <div className="ls-tools">模型可见的工具（{tools.length}）：{tools.join('、') || '无'}</div>}
      </div>
      <div className="ls-list" ref={listRef}>
        {items.map((item, i) => <div key={i} className={`ls-msg ls-${item.role}`}>{item.text}</div>)}
        {live && <div className="ls-msg ls-assistant ls-live">{live}</div>}
      </div>
      {error && <pre className="ls-pre ls-err">{error}</pre>}
      <div className="ls-input">
        <textarea
          value={draft}
          placeholder={sessionId ? '输入消息，Ctrl+Enter 发送' : '先新建会话'}
          disabled={!sessionId}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send() }}
        />
        <button onClick={send} disabled={!sessionId}>发送</button>
      </div>
    </div>
  )
}
