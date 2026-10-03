// Stage-0 step-3 probe, browser half. Registers a page into the shell's `learning.page` slot (2)
// and an activity-bar button, listens to the change feed (1), and runs the host probes.
import { useEffect, useState, type ReactNode } from 'react'
import { API_CHANNEL, FEED_PATH, endpointName, type FeedMessage } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps } from '@learning-agent/contracts/client'

export const name = 'learning-probe'
export const inject = ['slots', 'connection', 'learnShell']

let CTX: ClientContext

export function apply(ctx: ClientContext): void {
  CTX = ctx
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'probe', title: '阶段 0 验证', glyph: '验', scope: 'both', page: 'probe.panel' }), 'probe: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'probe.panel' }, ProbePage)), 'probe: page')
  ctx.learnShell.openPage('probe.panel', {}, { title: '阶段 0 验证' })
}

async function call(method: string, payload: unknown = {}): Promise<unknown> {
  const result = await CTX.connection.rpc.call(API_CHANNEL, endpointName('probe', method), payload)
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.value
}

type Row = { label: string; status: 'idle' | 'running' | 'ok' | 'fail'; output?: string }

function ProbePage({ scope }: LearningPageProps): ReactNode {
  const [feed, setFeed] = useState<string[]>([])
  const [feedState, setFeedState] = useState('连接中')
  const [sessionId, setSessionId] = useState<string>()
  const [rows, setRows] = useState<Record<string, Row>>({})

  useEffect(() => {
    const source = new EventSource(FEED_PATH)
    source.addEventListener('ready', () => setFeedState('已连接'))
    source.addEventListener('message', event => {
      const message = JSON.parse((event as MessageEvent).data) as FeedMessage
      setFeed(items => [...items, `${message.at.slice(11, 19)} ${message.type} ${JSON.stringify(message.data)}`])
    })
    source.onerror = () => setFeedState(`出错（readyState=${source.readyState}）`)
    return () => source.close()
  }, [])

  async function run(key: string, label: string, method: string, payload?: unknown): Promise<unknown> {
    setRows(r => ({ ...r, [key]: { label, status: 'running' } }))
    try {
      const value = await call(method, payload)
      setRows(r => ({ ...r, [key]: { label, status: 'ok', output: JSON.stringify(value, null, 2) } }))
      return value
    } catch (error) {
      setRows(r => ({ ...r, [key]: { label, status: 'fail', output: String(error) } }))
      return undefined
    }
  }

  return (
    <div style={{ padding: 16, display: 'grid', gap: 12, maxWidth: 900 }}>
      <div>（2）这个页面由探针插件注册进外壳的 <code>learning.page</code> 插槽；当前范围：{scope.kind}</div>
      <section>
        <b>（1）变更推送</b>：{feedState}{' '}
        <button onClick={() => void run('feed', '推送', 'feed')}>让后端推一条</button>
        <pre>{feed.join('\n') || '（暂无）'}</pre>
      </section>
      <section>
        <button onClick={async () => {
          const value = await run('course', '（3）建工作区 + 指定 ID 建会话', 'course') as { sessionId?: string } | undefined
          if (value?.sessionId) setSessionId(value.sessionId)
        }}>（3）建工作区和会话</button>{' '}
        <button disabled={!sessionId} onClick={() => void run('brief', '（4）课程简报注入', 'brief', { sessionId })}>（4）问暗号</button>{' '}
        <button disabled={!sessionId} onClick={() => void run('inspect', '（5）读取会话记录', 'inspect', { sessionId })}>（5）读记录</button>{' '}
        <button onClick={() => void run('llm', '（6）不开会话直接调模型', 'llm')}>（6）直接调模型</button>
      </section>
      {Object.entries(rows).map(([key, row]) => (
        <section key={key}>
          <b>{row.label}</b>：{{ idle: '未运行', running: '运行中…', ok: '成功', fail: '失败' }[row.status]}
          {row.output && <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f7f9', padding: 8 }}>{row.output}</pre>}
        </section>
      ))}
    </div>
  )
}
