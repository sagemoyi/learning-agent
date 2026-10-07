// knowledge unit, browser half: the course's knowledge nodes with their mastery state, grouped by
// kind, with validated definitions, relation details and grouped revision history. The sigma graph
// belongs to the next delivery batch.
import { useState, type ReactNode } from 'react'
import { ArrowRight, Blocks, Brain, Clock, Network, Plus, Search, Target, Wrench, BookOpen, Pencil } from 'lucide-react'
import type { Change, CourseGraph, KnowledgeDetail, KnowledgeOperation, LearnKnowledge, MasteryState, NodeState } from '@learning-agent/contracts'
import type { ClientContext, IconComponent, LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import { Button, Callout, ConfirmButton, Disclosure, Dot, EmptyState, ErrorText, Page, PageHeader, Section, Skeleton, Tag, TextField, shortTime, useAction, useLoad, useSelection, type Tone } from '@learning-agent/kit/client'
import { AddBasis, EdgeForm, NodeForm, ReuseForm, STATUS_LABEL, KIND_LABEL, EDGE_LABEL } from './editor.tsx'

export const name = 'learning-knowledge'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'knowledge', title: '知识模型', icon: Network, scope: 'course', page: 'knowledge.graph', order: 50 }), 'knowledge: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'knowledge.graph' }, GraphPage)), 'knowledge: page')
  for (const [key, component] of [['knowledge.detail', DetailPage], ['knowledge.add', AddPage], ['knowledge.history', HistoryPage]] as const) {
    ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key }, component)), `knowledge: ${key}`)
  }
}

const KINDS: { kind: keyof typeof KIND_LABEL; icon: IconComponent }[] = [
  { kind: 'knowledge', icon: Brain }, { kind: 'skill', icon: Wrench }, { kind: 'integrated', icon: Blocks }, { kind: 'task', icon: Target },
]
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
  const [query, setQuery] = useState('')
  const data = useLoad(shell, async () => {
    if (!courseId) return undefined
    const graph = await shell.call<CourseGraph>('knowledge', 'graph', { courseId })
    try {
      const states = await shell.call<NodeState[]>('learner', 'states', { nodeIds: graph.nodes.map(node => node.id) })
      return { graph, states: new Map(states.map(state => [state.nodeId as string, state])), stateError: undefined as string | undefined }
    } catch {
      return { graph, states: new Map<string, NodeState>(), stateError: '掌握状态暂不可用，请稍后刷新；知识节点仍可查看' }
    }
  }, [courseId])
  if (!courseId) return <Page><EmptyState icon={Network} title="进入一门课后查看它的知识模型" /></Page>
  if (data.error && !data.data) return <Page><ErrorText error={data.error} /></Page>
  if (!data.data) return <Page width="wide"><Skeleton lines={6} title /></Page>
  const { graph, states, stateError } = data.data
  const title = (id: string) => graph.nodes.find(node => node.id === id)?.title ?? '未显示的节点'
  const stateOf = (id: string): MasteryState => states.get(id)?.state ?? 'untested'
  const select = (id: string, title: string) => { shell.select({ page: 'knowledge.graph', courseId, selected: { kind: 'node', id, label: `知识节点：${title}` } }); openNode(id, title) }
  const counts = stateError ? [] : STATE_ORDER.map(state => ({ state, count: graph.nodes.filter(node => node.courseCount <= 1 && stateOf(node.id) === state).length })).filter(entry => entry.count > 0)
  const visible = graph.nodes.filter(node => [node.title, ...node.aliases].some(label => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))
  return (
    <Page width="wide">
      <PageHeader eyebrow={<><Network size={14} strokeWidth={1.75} />知识模型</>} title="知识模型"
        description="本课的知识身份、关系与出处。掌握状态只由作答证据决定；点开节点可以查看依据、修改或提问。"
        actions={<><Button icon={Clock} onClick={() => shell.openPage('knowledge.history', {}, { title: '知识变更' })}>变更记录</Button><Button icon={Plus} onClick={() => shell.openPage('knowledge.add', {}, { title: '添加知识' })}>添加节点</Button></>}
        meta={graph.nodes.length > 0 && (
          <div className="la-legend">
            <span><b>{graph.nodes.length}</b> 个节点</span>
            <span><b>{graph.edges.length}</b> 条关系</span>
            {counts.map(({ state, count }) => <span key={state}><Dot tone={STATE_LABEL[state].tone} hollow={state === 'untested'} />{STATE_LABEL[state].text} <b>{count}</b></span>)}
          </div>
        )} />
      <ErrorText error={data.error ?? stateError} />
      {graph.nodes.length > 0 && <div className="la-toolbar"><TextField value={query} onChange={setQuery} icon={Search} placeholder="搜索名称或别名" aria-label="搜索知识节点" /><span className="la-faint la-small">{visible.length} 个结果</span></div>}
      {graph.nodes.length === 0 && <div className="la-card"><EmptyState icon={Network} title="还没有知识节点" description="确认目标后，主老师会根据骨架教材搭出初版知识图。" /></div>}
      {KINDS.map(({ kind, icon }) => {
        const nodes = visible.filter(node => node.kind === kind)
        if (nodes.length === 0) return null
        return (
          <Section key={kind} title={KIND_LABEL[kind]} icon={icon} count={nodes.length}>
            <div className="la-node-grid">
              {nodes.map(node => {
                const state = states.get(node.id)
                const label = STATE_LABEL[stateOf(node.id)]
                const selected = selection?.selected?.kind === 'node' && selection.selected.id === node.id
                return (
                  <div key={node.id} role="button" tabIndex={0} aria-pressed={selected} className={`la-card interactive la-node${selected ? ' is-active' : ''}`}
                    onClick={() => select(node.id, node.title)} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); select(node.id, node.title) } }}>
                    <div className="la-node-head">
                      <span className="la-node-title">{node.title}</span>
                      {node.role === 'related' && <Tag>相关</Tag>}
                      {node.courseCount > 1 && <Tag>跨课共享</Tag>}
                    </div>
                    {node.description && <div className="la-node-desc"><shell.Markdown text={node.description} inline /></div>}
                    <div className="la-node-state">
                      <Dot tone={stateError || node.courseCount > 1 ? 'neutral' : label.tone} hollow={stateOf(node.id) === 'untested'} />{stateError ? '状态暂不可用' : node.courseCount > 1 ? '本课条件待验证' : label.text}
                      {state?.doubtful && <Tag tone="warn">有疑点</Tag>}
                      {state?.needsReview && <Tag>待复查</Tag>}
                    </div>
                    {node.domain && <div className="la-faint la-small">{node.domain}</div>}
                    {node.courseCount <= 1 && state && state.state !== 'untested' && state.explanation && <div className="la-faint la-small"><shell.Markdown text={state.explanation} inline /></div>}
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
                    <Tag tone={edge.status === 'valid' && edge.usable ? 'ok' : 'warn'}>{STATUS_LABEL[edge.status]}</Tag>
                  </span>
                  {edge.rationale && <span className="la-faint la-small"><shell.Markdown text={edge.rationale} inline /></span>}
                  {edge.issue && <span className="la-faint la-small">{edge.issue}</span>}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </Page>
  )
}

function openNode(nodeId: string, title = '知识详情'): void { shell.openPage('knowledge.detail', { nodeId }, { title }) }

function AddPage({ scope }: LearningPageProps): ReactNode {
  if (scope.kind !== 'course') return <Page><EmptyState title="进入一门课后添加知识" /></Page>
  const done = (id?: string) => { if (id) openNode(id); else shell.openPage('knowledge.graph', {}, { title: '知识模型' }) }
  return <Page><PageHeader title="添加知识" description="建立新的知识身份，或核对后复用已有身份" />
    <NodeForm key={scope.courseId} shell={shell} courseId={scope.courseId} onDone={done} onCancel={() => shell.openPage('knowledge.graph', {}, { title: '知识模型' })} />
    <ReuseForm shell={shell} courseId={scope.courseId} onDone={done} />
  </Page>
}

function DetailPage({ scope, params }: LearningPageProps): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined, nodeId = typeof params.nodeId === 'string' ? params.nodeId : undefined
  const [edit, setEdit] = useState(false), [basis, setBasis] = useState(false), [relation, setRelation] = useState<KnowledgeDetail['edges'][number] | 'new'>()
  const action = useAction()
  const data = useLoad(shell, async () => courseId && nodeId ? shell.call<KnowledgeDetail>('knowledge', 'detail', { courseId, nodeId }) : undefined, [courseId, nodeId])
  const states = useLoad(shell, async () => nodeId ? shell.call<NodeState[]>('learner', 'states', { nodeIds: [nodeId] }) : [], [nodeId])
  if (!courseId || !nodeId) return <Page><EmptyState title="请从知识模型页选择节点" /></Page>
  if (data.error && !data.data) return <Page><ErrorText error={data.error} /></Page>
  if (!data.data) return <Page><Skeleton lines={5} title /></Page>
  const detail = data.data, node = detail.node, member = detail.memberships.find(m => m.courseId === courseId)!, shared = detail.memberships.filter(m => m.status === 'active').length > 1
  const state = states.data?.[0], label = STATE_LABEL[state?.state ?? 'untested']
  const done = () => { setEdit(false); setBasis(false); setRelation(undefined); data.reload() }
  return <Page><PageHeader eyebrow={<><Network size={14} strokeWidth={1.75} />{KIND_LABEL[node.kind]}</>} title={node.title}
    description={node.domain || '知识定义与学习依据'} meta={<><Tag>{member.role === 'core' ? '本课核心' : '本课相关'}</Tag>{node.legacy && <Tag>骨架身份</Tag>}{node.status === 'inactive' && <Tag>已停用</Tag>}{member.status === 'inactive' && <Tag>已移出本课</Tag>}</>}
    actions={<><Button onClick={() => { shell.select({ page: 'knowledge.detail', courseId, selected: { kind: 'node', id: nodeId, label: node.title } }); shell.showSideChat() }}>就此提问</Button><Button icon={Pencil} onClick={() => setEdit(true)}>修订定义</Button></>} />
    <ErrorText error={data.error} /><ErrorText error={action.error} />
    {edit && <NodeForm key={nodeId} shell={shell} courseId={courseId} node={node} onDone={done} onCancel={() => setEdit(false)} />}
    <Section title="含义与条件" card><shell.Markdown text={node.description || '说明待补充'} />{node.conditions && <p>{node.conditions}</p>}{node.aliases.length > 0 && <p className="la-faint la-small">别名：{node.aliases.join('、')}</p>}</Section>
    <Section title="掌握证据" card>
      {states.error ? <Callout tone="warn">掌握状态暂不可用，请稍后刷新</Callout> : states.loading && !states.data ? <Skeleton lines={2} /> : <><div className="la-node-state"><Dot tone={shared ? 'neutral' : label.tone} hollow={!state || state.state === 'untested'} />{shared ? `全局记录：${label.text}` : label.text}</div>{state?.explanation && <shell.Markdown text={state.explanation} />}</>}
      {shared && <Callout>这个身份由多门课程共享，本课的任务条件是否适用仍需验证；共享身份不会生成新的掌握证据</Callout>}
    </Section>
    <Section title="知识关系" icon={ArrowRight} count={detail.edges.length} actions={<Button size="sm" icon={Plus} onClick={() => setRelation('new')}>添加关系</Button>}>
      {relation && <EdgeForm key={relation === 'new' ? 'new' : relation.id} shell={shell} courseId={courseId} detail={detail} edge={relation === 'new' ? undefined : relation} onDone={done} onCancel={() => setRelation(undefined)} />}
      <div className="la-rows">{detail.edges.map(edge => <div className="la-row-item" key={edge.id}><div className="la-row-main">
        <span><b>{detail.titles[edge.from]}</b> {EDGE_LABEL[edge.type]} <b>{detail.titles[edge.to]}</b></span>
        <span className="la-toolbar"><Tag tone={edge.status === 'valid' && edge.usable ? 'ok' : 'neutral'}>{STATUS_LABEL[edge.status]}</Tag><Tag>{edge.scope.kind === 'global' ? '所有课程' : edge.scope.kind === 'task' ? '指定任务' : '本课'}</Tag></span>
        {edge.issue && <span className="la-faint la-small">{edge.issue}</span>}
        {edge.rationale && <shell.Markdown text={edge.rationale} inline />}{edge.conditions && <span className="la-faint la-small">条件：{edge.conditions}</span>}
        {edge.sources.map(id => <shell.Markdown key={id} text={`[${detail.citations[id]}](cite:${id})`} inline />)}
      </div><Button size="sm" variant="quiet" onClick={() => setRelation(edge)}>修订关系</Button></div>)}</div>
      {!detail.edges.length && <EmptyState compact title="还没有登记关系" />}
    </Section>
    <Section title="来源" icon={BookOpen} count={detail.links.length} actions={<Button size="sm" onClick={() => setBasis(true)}>添加依据</Button>}>
      {basis && <AddBasis shell={shell} courseId={courseId} nodeId={nodeId} onDone={done} />}
      <div className="la-rows">{detail.links.map((link, i) => <div className="la-row-item" key={i}><div className="la-row-main">{link.citation ? <shell.Markdown text={link.citation} inline /> : <span>{link.label}</span>}<span className="la-faint la-small">{link.relation === 'explains' ? '讲解' : link.relation === 'example' ? '例题' : '考查'}{!link.available ? ' · 当前不可用' : ''}</span></div>
        <ConfirmButton size="sm" question={shared ? '所有课程停用这条连线？' : '停用这条来源连线？'} confirm="停用" loading={action.busy} onConfirm={() => void action.run(async () => { await shell.call('knowledge', 'unlink', { courseId, link }); data.reload() })}>停用连线</ConfirmButton></div>)}</div>
      {!detail.links.length && <EmptyState compact title="来源尚未登记" />}
    </Section>
    <Section title="课程归属" card><p className="la-faint">{detail.memberships.filter(m => m.status === 'active').length} 门课程使用这个身份；移出本课不会删除全局身份或作答记录</p>
      <div className="la-toolbar">{member.status === 'active' ? <ConfirmButton question="将节点移出本课？" confirm="移出本课" loading={action.busy} onConfirm={() => void action.run(async () => { await shell.call('knowledge', 'setMembership', { courseId, nodeId, version: member.version, patch: { status: 'inactive' } }); data.reload() })}>移出本课</ConfirmButton> : <Button loading={action.busy} onClick={() => void action.run(async () => { await shell.call('knowledge', 'setMembership', { courseId, nodeId, version: member.version, patch: { status: 'active' } }); data.reload() })}>恢复本课关联</Button>}
        <Button variant="quiet" icon={Clock} onClick={() => shell.openPage('knowledge.history', {}, { title: '知识变更' })}>查看变更与撤销</Button></div>
    </Section>
  </Page>
}

function snapshot(text: string | null, kind: Change['target']['kind'], titles: Readonly<Record<string, string>>, citations: Readonly<Record<string, string>>): string {
  if (!text) return '尚未登记'
  const record = JSON.parse(text)
  if (kind === 'node') return [record.title, KIND_LABEL[record.kind as keyof typeof KIND_LABEL], record.description, record.domain, record.conditions, record.aliases?.length ? `别名：${record.aliases.join('、')}` : '', record.status === 'inactive' ? '已停用' : '活动身份'].filter(Boolean).join('\n')
  if (kind === 'edge') return [ `${titles[record.from] ?? '知识节点'} ${EDGE_LABEL[record.type as keyof typeof EDGE_LABEL]} ${titles[record.to] ?? '知识节点'}`, STATUS_LABEL[record.status as keyof typeof STATUS_LABEL] ?? '待复核', record.scope?.kind === 'global' ? '所有课程' : record.scope?.kind === 'task' ? '指定任务' : '本课', record.rationale, record.conditions, `依据：${record.sources?.map((id: string) => citations[id] ?? '资料出处当前不可用').join('；') || '未登记'}` ].filter(Boolean).join('\n')
  if (kind === 'course-node') return `${titles[record.nodeId] ?? '知识节点'} · ${record.role === 'core' ? '核心' : '相关'} · ${record.status === 'inactive' ? '已移出课程' : '属于课程'} · ${record.exam === 'in-scope' ? '考试范围内' : record.exam === 'out-of-scope' ? '考试范围外' : '考试范围未设置'}`
  return `${titles[record.nodeId] ?? '知识节点'} · ${record.target?.kind === 'chunk' ? citations[record.target.id] ?? '资料片段' : record.target?.kind === 'block' ? '教材段落' : '题目'} · ${record.relation === 'explains' ? '讲解' : record.relation === 'example' ? '例题' : '考查'} · ${record.status === 'inactive' ? '连线停用' : '连线可用'}`
}

function HistoryPage({ scope, params }: LearningPageProps): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const [picked, setPicked] = useState(typeof params.operationId === 'string' ? params.operationId : undefined), action = useAction()
  const data = useLoad(shell, async () => courseId ? shell.call<KnowledgeOperation[]>('knowledge', 'history', { courseId }) : [], [courseId])
  const detail = useLoad(shell, async () => courseId && picked ? shell.call<ReturnType<LearnKnowledge['operationDetails']>>('knowledge', 'operation', { courseId, operationId: picked }) : undefined, [courseId, picked])
  if (!courseId) return <Page><EmptyState title="进入课程后查看知识变更" /></Page>
  const changes = detail.data
  return <Page><PageHeader title="知识变更" description="最近 100 组结构操作。查看修改前后，再整组撤销；作答证据始终保留" /><ErrorText error={data.error} /><ErrorText error={detail.error} />
    {changes && <Section card title="操作影响" description={changes.operation.reason} actions={<ConfirmButton question="撤销这一整组修改？" confirm="整组撤销" disabled={!!changes.operation.revertedBy || !changes.operation.changeIds.length} loading={action.busy} onConfirm={() => void action.run(async () => { await shell.call('knowledge', 'revert', { courseId, operationId: changes.operation.id }); data.reload(); detail.reload() })}>{changes.operation.revertedBy ? '已撤销' : '撤销这组'}</ConfirmButton>}>
      <ErrorText error={action.error} />
      {changes.changes.map(change => <Disclosure key={change.id} summary={change.target.kind === 'node' ? '节点定义' : change.target.kind === 'edge' ? '关系' : change.target.kind === 'course-node' ? '课程归属' : '来源连线'} defaultOpen>
        <div className="la-knowledge-diff"><div><span className="la-faint la-small">修改前</span><p>{snapshot(change.before, change.target.kind, changes.titles, changes.citations)}</p></div><div><span className="la-faint la-small">修改后</span><p>{snapshot(change.after, change.target.kind, changes.titles, changes.citations)}</p></div></div>
      </Disclosure>)}
    </Section>}
    <Section title="操作记录" icon={Clock}><div className="la-rows">{data.data?.filter(op => op.changeIds.length).map(op => <div className="la-row-item" key={op.id}><div className="la-row-main"><b>{op.reason}</b><span className="la-faint la-small">{shortTime(op.at)} · {op.actor === 'teacher' ? '主老师' : op.actor === 'user' ? '你' : '自动登记'} · {op.changeIds.length} 项{op.revertedBy ? ' · 已撤销' : ''}</span></div><Button size="sm" onClick={() => setPicked(op.id)}>查看变化</Button></div>)}</div>{data.loading && !data.data && <Skeleton lines={5} />}</Section>
  </Page>
}
