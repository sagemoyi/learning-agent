// Knowledge forms retain the revision read when editing began; feed refreshes must not overwrite drafts.
import { useState, type ReactNode } from 'react'
import { BookOpen, Search } from 'lucide-react'
import type { CourseGraph, KnowledgeDetail, KnowledgeNode, NodeKind, RelationStatus, Retrieval } from '@learning-agent/contracts'
import type { LearnShell } from '@learning-agent/contracts/client'
import { Button, Callout, Checkbox, ConfirmButton, ErrorText, Field, Section, Select, TextArea, TextField, useAction, useLoad } from '@learning-agent/kit/client'

import { KIND_LABEL, EDGE_LABEL, STATUS_LABEL } from './labels.ts'
export { KIND_LABEL, EDGE_LABEL, STATUS_LABEL } from './labels.ts'

export function SourcePicker({ shell, courseId, value, onChange }: { shell: LearnShell; courseId: string; value: string[]; onChange(value: string[]): void }): ReactNode {
  const [query, setQuery] = useState(''), [hits, setHits] = useState<Retrieval['hits']>([])
  const search = useAction()
  const find = () => search.run(async () => {
    const result = await shell.call<Retrieval>('library', 'search', { courseId, query, limit: 8 })
    setHits(result.hits)
  })
  return <Section title="资料依据" icon={BookOpen} description="搜索本课资料，选择支持这项定义或关系的原文">
    <div className="la-row nowrap"><div style={{ flex: 1, minWidth: 0 }}><TextField value={query} onChange={setQuery} onEnter={() => { if (query.trim()) void find() }} placeholder="概念、动作或条件" aria-label="搜索依据原文" icon={Search} /></div>
      <Button loading={search.busy} disabled={!query.trim()} onClick={() => void find()}>搜索</Button></div>
    <ErrorText error={search.error} />
    {value.length > 0 && <p className="la-faint la-small">已选择 {value.length} 个片段</p>}
    {hits.length > 0 && <div className="la-rows">{hits.map(hit => <Checkbox key={hit.chunk.id} card checked={value.includes(hit.chunk.id)} onChange={checked => onChange(checked ? [...value, hit.chunk.id] : value.filter(id => id !== hit.chunk.id))}>
      <div><shell.Markdown text={`[${hit.chunk.citation}](cite:${hit.chunk.id})`} inline /></div>
      <div className="la-faint la-small">{hit.chunk.text.slice(0, 240)}</div>
    </Checkbox>)}</div>}
  </Section>
}

export function NodeForm({ shell, courseId, node, onDone, onCancel }: { shell: LearnShell; courseId: string; node?: KnowledgeNode; onDone(nodeId?: string): void; onCancel(): void }): ReactNode {
  const [version] = useState(node?.version)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [title, setTitle] = useState(node?.title ?? ''), [kind, setKind] = useState<NodeKind>(node?.kind ?? 'knowledge')
  const [description, setDescription] = useState(node?.description ?? ''), [aliases, setAliases] = useState(node?.aliases.join('，') ?? '')
  const [domain, setDomain] = useState(node?.domain ?? ''), [conditions, setConditions] = useState(node?.conditions ?? ''), [sources, setSources] = useState<string[]>([])
  const save = useAction()
  const submit = () => save.run(async () => {
    const fields = { title, description, aliases: aliases.split(/[,，\n]/).map(s => s.trim()).filter(Boolean), domain, conditions }
    if (node) {
      await shell.call('knowledge', 'editNode', { courseId, nodeId: node.id, version, patch: fields })
      onDone(node.id)
    } else {
      const graph = await shell.call<CourseGraph>('knowledge', 'add', { courseId, input: { requestId, nodes: [{ ...fields, kind, sources }] } })
      const operation = graph.operationId ? await shell.call<{ changes: { before: string | null; target: { kind: string; id: string } }[] }>('knowledge', 'operation', { courseId, operationId: graph.operationId }) : undefined
      const created = operation?.changes.find(change => change.target.kind === 'node' && change.before === null)?.target.id
      setTitle(''); setDescription(''); setAliases(''); setDomain(''); setConditions(''); setSources([]); setRequestId(crypto.randomUUID())
      onDone(created)
    }
  })
  return <Section card title={node ? '修订定义' : '新建知识身份'} description={node ? '这里修改所有课程共用的定义；改变能力含义或类型时应新建身份' : '标题相同也会保留不同身份，注明领域与表现条件便于区分'}>
    <div className="la-knowledge-form">
      <div className="la-toolbar"><Field grow label="名称"><TextField value={title} onChange={setTitle} aria-label="节点名称" /></Field>
        <Field label="类型">{node ? <span className="la-setting-value">{KIND_LABEL[node.kind]}</span> : <Select<NodeKind> value={kind} options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value: value as NodeKind, label }))} onChange={setKind} aria-label="节点类型" />}</Field></div>
      <Field label="含义与边界"><TextArea value={description} onChange={setDescription} aria-label="节点说明" /></Field>
      <div className="la-toolbar"><Field grow label="领域"><TextField value={domain} onChange={setDomain} aria-label="适用领域" placeholder="例如化工原理" /></Field>
        <Field grow label="别名" hint="用逗号分开"><TextField value={aliases} onChange={setAliases} aria-label="节点别名" /></Field></div>
      <Field label="表现条件"><TextArea value={conditions} onChange={setConditions} minRows={2} aria-label="表现条件" placeholder="在什么条件下解释或完成什么" /></Field>
      {!node && <SourcePicker shell={shell} courseId={courseId} value={sources} onChange={setSources} />}
      <div className="la-toolbar"><Button variant="primary" loading={save.busy} disabled={!title.trim()} onClick={() => void submit()}>{node ? '保存修订' : '新建节点'}</Button><Button variant="quiet" disabled={save.busy} onClick={onCancel}>取消</Button></div>
      <ErrorText error={save.error} />
    </div>
  </Section>
}

export function ReuseForm({ shell, courseId, onDone }: { shell: LearnShell; courseId: string; onDone(nodeId: string): void }): ReactNode {
  const [query, setQuery] = useState(''), [nodes, setNodes] = useState<KnowledgeNode[]>([]), [searched, setSearched] = useState(false)
  const search = useAction(), save = useAction()
  const find = () => search.run(async () => { setNodes(await shell.call('knowledge', 'candidates', { query })); setSearched(true) })
  return <Section card title="复用已有身份" description="先核对领域、含义与条件。确认是同一项能力才共享；本课适用的掌握证据仍需验证">
    <div className="la-row nowrap"><div style={{ flex: 1, minWidth: 0 }}><TextField value={query} onChange={setQuery} onEnter={() => { if (query.trim()) void find() }} icon={Search} placeholder="名称或别名" aria-label="查找已有知识身份" /></div>
      <Button loading={search.busy} disabled={!query.trim()} onClick={() => void find()}>查找</Button></div>
    <ErrorText error={search.error} /><ErrorText error={save.error} />
    {searched && !nodes.length && <p className="la-faint la-small">没有找到这个名称的身份</p>}
    {nodes.length > 0 && <div className="la-rows">{nodes.map(node => <div className="la-row-item" key={node.id}>
      <div className="la-row-main"><b>{node.title}</b><span className="la-faint la-small">{KIND_LABEL[node.kind]} · {node.domain || '领域未注明'}</span><span>{node.description}</span><span className="la-faint la-small">{node.conditions || '表现条件未注明'}</span></div>
      <ConfirmButton question="确认是同一能力和条件？" confirm="复用身份" loading={save.busy} onConfirm={() => void save.run(async () => {
        await shell.call('knowledge', 'add', { courseId, input: { requestId: crypto.randomUUID(), nodes: [{ title: node.title, kind: node.kind, reuseId: node.id }] } })
        onDone(node.id)
      })}>复用</ConfirmButton>
    </div>)}</div>}
  </Section>
}

export function AddBasis({ shell, courseId, nodeId, onDone }: { shell: LearnShell; courseId: string; nodeId: string; onDone(): void }): ReactNode {
  const [sources, setSources] = useState<string[]>([]), save = useAction()
  return <Section card title="添加节点依据"><SourcePicker shell={shell} courseId={courseId} value={sources} onChange={setSources} />
    <div className="la-toolbar"><Button variant="primary" disabled={!sources.length} loading={save.busy} onClick={() => void save.run(async () => { await shell.call('knowledge', 'link', { courseId, nodeId, chunks: sources }); onDone() })}>登记依据</Button><Button variant="quiet" onClick={onDone}>取消</Button></div><ErrorText error={save.error} /></Section>
}

export function EdgeForm({ shell, courseId, detail, edge, onDone, onCancel }: { shell: LearnShell; courseId: string; detail: KnowledgeDetail; edge?: KnowledgeDetail['edges'][number]; onDone(): void; onCancel(): void }): ReactNode {
  const [version] = useState(edge?.version), [requestId] = useState(() => crypto.randomUUID())
  const graph = useLoad(shell, () => shell.call<CourseGraph>('knowledge', 'graph', { courseId }), [courseId])
  const [to, setTo] = useState(''), [type, setType] = useState<KnowledgeDetail['edges'][number]['type']>('related')
  const [status, setStatus] = useState<Exclude<RelationStatus, 'legacy'>>(edge?.status === 'legacy' ? 'draft' : edge?.status ?? 'draft')
  const [scope, setScope] = useState(edge?.scope.kind ?? 'course'), [conditions, setConditions] = useState(edge?.conditions ?? '')
  const [rationale, setRationale] = useState(edge?.rationale ?? ''), [sources, setSources] = useState<string[]>(edge?.sources ?? [])
  const save = useAction()
  const submit = () => save.run(async () => {
    const relationScope = scope === 'task' ? edge!.scope : scope === 'global' ? { kind: 'global' } : { kind: 'course', courseId }
    const fields = { status, rationale, conditions, sources, scope: relationScope }
    if (edge) await shell.call('knowledge', 'editEdge', { courseId, edgeId: edge.id, version, patch: fields })
    else await shell.call('knowledge', 'add', { courseId, input: { requestId, nodes: [], edges: [{ ...fields, from: detail.node.id, to, type }] } })
    onDone()
  })
  return <Section card title={edge ? '修订关系' : '添加关系'} description="有效关系需要理由和原文依据；章节顺序只支持建议先学">
    <div className="la-knowledge-form">
      {edge ? <p>{detail.titles[edge.from]} {EDGE_LABEL[edge.type]} {detail.titles[edge.to]}</p> : <div className="la-toolbar"><span>{detail.node.title}</span><Select<typeof type> value={type} options={Object.entries(EDGE_LABEL).map(([value, label]) => ({ value: value as typeof type, label }))} onChange={setType} aria-label="关系类型" /><Select value={to} options={(graph.data?.nodes ?? []).filter(node => node.id !== detail.node.id).map(node => ({ value: node.id as string, label: `${node.title}${node.domain ? ` · ${node.domain}` : ''}` }))} onChange={setTo} aria-label="关系目标" /></div>}
      <div className="la-toolbar"><Field label="状态"><Select<typeof status> value={status} options={(['draft', 'valid', 'disputed', ...(edge ? ['inactive'] : [])] as typeof status[]).map(value => ({ value, label: STATUS_LABEL[value] }))} onChange={setStatus} aria-label="关系状态" /></Field>
        <Field label="适用范围"><Select<typeof scope> value={scope} options={[{ value: 'course', label: '本课' }, { value: 'global', label: '所有课程' }, ...(edge?.scope.kind === 'task' ? [{ value: 'task' as const, label: '保留指定任务' }] : [])]} onChange={setScope} aria-label="关系适用范围" /></Field></div>
      <Field label="理由"><TextArea value={rationale} onChange={setRationale} minRows={2} aria-label="关系理由" /></Field>
      <Field label="适用条件"><TextArea value={conditions} onChange={setConditions} minRows={2} aria-label="关系条件" /></Field>
      {edge && edge.sources.length > 0 && <div className="la-rows">{edge.sources.map(id => <Checkbox key={id} checked={sources.includes(id)} onChange={checked => setSources(checked ? [...sources, id] : sources.filter(other => other !== id))}><shell.Markdown text={`[${detail.citations[id]}](cite:${id})`} inline /></Checkbox>)}</div>}
      <SourcePicker shell={shell} courseId={courseId} value={sources} onChange={setSources} />
      <Callout>程序检查出处能否定位；原文是否支持这条关系，需要你和老师核对</Callout>
      <div className="la-toolbar"><Button variant="primary" loading={save.busy} disabled={!edge && !to} onClick={() => void submit()}>保存关系</Button><Button variant="quiet" disabled={save.busy} onClick={onCancel}>取消</Button></div><ErrorText error={save.error} /><ErrorText error={graph.error} />
    </div>
  </Section>
}
