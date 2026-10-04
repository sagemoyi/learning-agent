// knowledge unit, browser half: the course's knowledge nodes with their mastery state.
// Skeleton: a list; the Obsidian-style graph view (sigma.js) comes when the unit is built out.
import type { ReactNode } from 'react'
import { Network } from 'lucide-react'
import type { MasteryState, NodeState } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import type { CourseGraph } from '@learning-agent/contracts'
import { useLoad, useSelection } from '@learning-agent/kit/client'

export const name = 'learning-knowledge'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'knowledge', title: '知识模型', icon: Network, scope: 'course', page: 'knowledge.graph', order: 50 }), 'knowledge: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'knowledge.graph' }, GraphPage)), 'knowledge: page')
}

const EDGE_LABEL = { 'part-of': '组成', requires: '先修', 'recommended-before': '建议先学', related: '相关' } as const
const KIND_LABEL = { knowledge: '知识', skill: '技能', integrated: '综合能力', task: '完整任务' } as const
const STATE_LABEL: Record<MasteryState, { text: string; tone: string }> = {
  untested: { text: '未探测', tone: '' },
  'not-yet': { text: '尚未掌握', tone: 'bad' },
  assisted: { text: '有帮助完成', tone: 'warn' },
  independent: { text: '已独立完成', tone: 'ok' },
  retained: { text: '已延迟验证', tone: 'ok' },
  conflict: { text: '证据冲突', tone: 'bad' },
}

function GraphPage({ scope }: LearningPageProps): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const selection = useSelection(shell)
  const data = useLoad(shell, async () => {
    if (!courseId) return undefined
    const graph = await shell.call<CourseGraph>('knowledge', 'graph', { courseId })
    const states = await shell.call<NodeState[]>('learner', 'states', { nodeIds: graph.nodes.map(node => node.id) }).catch(() => [])
    return { graph, states: new Map(states.map(state => [state.nodeId as string, state])) }
  }, [courseId])
  if (!courseId) return <div className="la-empty">进入一门课后查看它的知识模型。</div>
  if (data.error) return <div className="la-pad la-error">{data.error}</div>
  if (!data.data) return null
  const { graph, states } = data.data
  const title = (id: string) => graph.nodes.find(node => node.id === id)?.title ?? id
  return (
    <div className="la-pad la-stack">
      <div>
        <div className="la-h1">知识模型</div>
        <div className="la-muted">本课 {graph.nodes.length} 个节点、{graph.edges.length} 条关系。状态只由作答证据决定。点一个节点，可以在右侧就它提问。</div>
      </div>
      {graph.nodes.length === 0 && <div className="la-muted">还没有节点。确认目标后，主老师会搭出初版知识图。</div>}
      <div className="la-stack" style={{ gap: 8 }}>
        {graph.nodes.map(node => {
          const state = states.get(node.id)
          const label = STATE_LABEL[state?.state ?? 'untested']
          const selected = selection?.selected?.kind === 'node' && selection.selected.id === node.id
          return (
            <div key={node.id} className={`la-card${selected ? ' is-active' : ''}`} style={{ cursor: 'pointer' }}
              onClick={() => shell.select({ page: 'knowledge.graph', courseId, selected: { kind: 'node', id: node.id, label: `知识节点：${node.title}` } })}>
              <div className="la-row">
                <b>{node.title}</b>
                <span className="la-tag">{KIND_LABEL[node.kind]}</span>
                <span className={`la-tag ${label.tone}`}>{label.text}</span>
                {state?.doubtful && <span className="la-tag warn">有疑点</span>}
              </div>
              {node.description && <div className="la-muted la-small">{node.description}</div>}
              {state && state.state !== 'untested' && <div className="la-small">{state.explanation}</div>}
            </div>
          )
        })}
      </div>
      {graph.edges.length > 0 && (
        <section className="la-stack">
          <div className="la-h2">关系</div>
          <ul className="la-list">
            {graph.edges.map(edge => (
              <li key={edge.id}>{title(edge.from)} <span className="la-tag">{EDGE_LABEL[edge.type]}</span> {title(edge.to)} <span className="la-muted la-small">{edge.rationale}</span></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
