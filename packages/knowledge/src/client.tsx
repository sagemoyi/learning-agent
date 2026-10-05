// knowledge unit, browser half: the course's knowledge nodes with their mastery state, grouped by
// kind, and the relations between them. Skeleton: the Obsidian-style graph view (sigma.js) comes when
// the unit is built out.
import type { ReactNode } from 'react'
import { ArrowRight, Blocks, Brain, Network, Target, Wrench } from 'lucide-react'
import type { CourseGraph, MasteryState, NodeState } from '@learning-agent/contracts'
import type { ClientContext, IconComponent, LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import { Dot, EmptyState, ErrorText, Page, PageHeader, Section, Skeleton, Tag, useLoad, useSelection, type Tone } from '@learning-agent/kit/client'

export const name = 'learning-knowledge'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'knowledge', title: '知识模型', icon: Network, scope: 'course', page: 'knowledge.graph', order: 50 }), 'knowledge: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'knowledge.graph' }, GraphPage)), 'knowledge: page')
}

const EDGE_LABEL = { 'part-of': '组成', requires: '先修', 'recommended-before': '建议先学', related: '相关' } as const
const KINDS: { kind: keyof typeof KIND_LABEL; icon: IconComponent }[] = [
  { kind: 'knowledge', icon: Brain }, { kind: 'skill', icon: Wrench }, { kind: 'integrated', icon: Blocks }, { kind: 'task', icon: Target },
]
const KIND_LABEL = { knowledge: '知识', skill: '技能', integrated: '综合能力', task: '完整任务' } as const
const STATE_LABEL: Record<MasteryState, { text: string; tone: Tone }> = {
  untested: { text: '未探测', tone: 'neutral' },
  'not-yet': { text: '还没答对', tone: 'warn' },
  assisted: { text: '有帮助完成', tone: 'accent' },
  independent: { text: '已独立完成', tone: 'ok' },
  retained: { text: '已延迟验证', tone: 'ok' },
  conflict: { text: '证据冲突', tone: 'bad' },
}
const STATE_ORDER: MasteryState[] = ['untested', 'not-yet', 'assisted', 'independent', 'retained', 'conflict']

function GraphPage({ scope }: LearningPageProps): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const selection = useSelection(shell)
  const data = useLoad(shell, async () => {
    if (!courseId) return undefined
    const graph = await shell.call<CourseGraph>('knowledge', 'graph', { courseId })
    const states = await shell.call<NodeState[]>('learner', 'states', { nodeIds: graph.nodes.map(node => node.id) }).catch(() => [])
    return { graph, states: new Map(states.map(state => [state.nodeId as string, state])) }
  }, [courseId])
  if (!courseId) return <Page><EmptyState icon={Network} title="进入一门课后查看它的知识模型" /></Page>
  if (data.error) return <Page><ErrorText error={data.error} /></Page>
  if (!data.data) return <Page width="wide"><Skeleton lines={6} title /></Page>
  const { graph, states } = data.data
  const title = (id: string) => graph.nodes.find(node => node.id === id)?.title ?? id
  const stateOf = (id: string): MasteryState => states.get(id)?.state ?? 'untested'
  const select = (id: string, title: string) => shell.select({ page: 'knowledge.graph', courseId, selected: { kind: 'node', id, label: `知识节点：${title}` } })
  const counts = STATE_ORDER.map(state => ({ state, count: graph.nodes.filter(node => stateOf(node.id) === state).length })).filter(entry => entry.count > 0)
  return (
    <Page width="wide">
      <PageHeader eyebrow={<><Network size={14} strokeWidth={1.75} />知识模型</>} title="知识模型"
        description="本课的知识点和它们之间的关系。掌握状态只由作答证据决定，阅读和聊天不算。点一个节点，可以就它提问。"
        meta={graph.nodes.length > 0 && (
          <div className="la-legend">
            <span><b>{graph.nodes.length}</b> 个节点</span>
            <span><b>{graph.edges.length}</b> 条关系</span>
            {counts.map(({ state, count }) => <span key={state}><Dot tone={STATE_LABEL[state].tone} hollow={state === 'untested'} />{STATE_LABEL[state].text} <b>{count}</b></span>)}
          </div>
        )} />
      {graph.nodes.length === 0 && <div className="la-card"><EmptyState icon={Network} title="还没有知识节点" description="确认目标后，主老师会根据骨架教材搭出初版知识图。" /></div>}
      {KINDS.map(({ kind, icon }) => {
        const nodes = graph.nodes.filter(node => node.kind === kind)
        if (nodes.length === 0) return null
        return (
          <Section key={kind} title={KIND_LABEL[kind]} icon={icon} count={nodes.length}>
            <div className="la-node-grid">
              {nodes.map(node => {
                const state = states.get(node.id)
                const label = STATE_LABEL[stateOf(node.id)]
                const selected = selection?.selected?.kind === 'node' && selection.selected.id === node.id
                return (
                  <div key={node.id} role="button" tabIndex={0} aria-pressed={selected} className={`la-card interactive la-node${selected ? ' is-active' : ''}`} style={node.role === 'related' ? { opacity: 0.72 } : undefined}
                    onClick={() => select(node.id, node.title)} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(node.id, node.title) } }}>
                    <div className="la-node-head">
                      <span className="la-node-title">{node.title}</span>
                      {node.role === 'related' && <Tag>相关</Tag>}
                    </div>
                    {node.description && <div className="la-node-desc"><shell.Markdown text={node.description} inline /></div>}
                    <div className="la-node-state">
                      <Dot tone={label.tone} hollow={stateOf(node.id) === 'untested'} />{label.text}
                      {state?.doubtful && <Tag tone="warn">有疑点</Tag>}
                      {state?.needsReview && <Tag>待复查</Tag>}
                    </div>
                    {state && state.state !== 'untested' && state.explanation && <div className="la-faint la-small"><shell.Markdown text={state.explanation} inline /></div>}
                  </div>
                )
              })}
            </div>
          </Section>
        )
      })}
      {graph.edges.length > 0 && (
        <Section title="关系" icon={ArrowRight} count={graph.edges.length}>
          <div className="la-rows">
            {graph.edges.map(edge => (
              <div key={edge.id} className="la-row-item" style={{ alignItems: 'flex-start' }}>
                <div className="la-row-main" style={{ gap: 4 }}>
                  <span className="la-edge">
                    <b>{title(edge.from)}</b>
                    <Tag tone={edge.type === 'requires' ? 'accent' : 'neutral'}>{EDGE_LABEL[edge.type]}</Tag>
                    <ArrowRight size={14} strokeWidth={1.75} className="la-edge-arrow" />
                    <b>{title(edge.to)}</b>
                  </span>
                  {edge.rationale && <span className="la-faint la-small"><shell.Markdown text={edge.rationale} inline /></span>}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </Page>
  )
}
