// Merge suggestions (knowledge C): pairs that may be one identity, compared side by side. The learner
// picks which node stays, sees what the merge would do, and merges or keeps them apart.
import { useState, type ReactNode } from 'react'
import { GitMerge, Search } from 'lucide-react'
import type { KnowledgeNode, MergePlan, MergeSide, MergeSuggestion, NodeState } from '@learning-agent/contracts'
import type { LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import { Button, Callout, ConfirmButton, Disclosure, EmptyState, ErrorText, Page, PageHeader, Section, Segmented, Skeleton, TextField, useAction, useLoad } from '@learning-agent/kit/client'
import { KIND_LABEL } from './labels.ts'
import { STATE_TEXT } from './graph/model.ts'
import { relationSentence } from './graph/page.tsx'

interface Pair {
  readonly a: string
  readonly b: string
  readonly keep: string
  readonly why?: string
  readonly by?: MergeSuggestion['by']
}

export function MergePage({ shell, scope, params, openNode }: LearningPageProps & { shell: LearnShell; openNode(nodeId: string, title: string, courseId?: string): void }): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const start = typeof params.nodeId === 'string' ? params.nodeId : undefined
  const list = useLoad(shell, () => shell.call<MergeSuggestion[]>('knowledge', 'mergeSuggestions', courseId ? { courseId } : {}), [courseId])
  const [pair, setPair] = useState<Pair>()
  const [merged, setMerged] = useState<{ id: string; title: string; courseId?: string }>()
  const pick = (item: MergeSuggestion) => setPair({ a: item.nodes[0].id, b: item.nodes[1].id, keep: item.keepId, why: item.why, by: item.by })
  return <Page>
    <PageHeader eyebrow={<><GitMerge size={14} strokeWidth={1.75} />{courseId ? '本课' : '全部课程'}</>} title="合并建议"
      description="名称相同不一定是同一项。含义和表现条件都一致再合并；作答记录保留在原来的节点上，按课程分别计算掌握状态" />
    {merged && <Callout tone="ok" actions={<Button size="sm" opens onClick={() => openNode(merged.id, merged.title, merged.courseId)}>打开「{merged.title}」</Button>}>已合并为「{merged.title}」。需要时可以在知识变更里整组撤销</Callout>}
    {start && <PickOther shell={shell} nodeId={start} onPick={other => setPair({ a: start, b: other, keep: start })} />}
    <Section title="待比较" icon={GitMerge} count={list.data?.length}>
      <ErrorText error={list.error} />
      {!list.data ? <Skeleton lines={3} /> : list.data.length === 0 ? <EmptyState compact title="没有待比较的节点" description="名称相同、分属不同课程的节点会列在这里；主老师觉得是同一项时也会提出来" /> : (
        <div className="la-rows">{list.data.map(item => {
          const key = `${item.nodes[0].id}|${item.nodes[1].id}`, active = pair && [pair.a, pair.b].sort().join('|') === [item.nodes[0].id, item.nodes[1].id].sort().join('|')
          return <div className={`la-row-item${active ? ' is-active' : ''}`} key={key}>
            <div className="la-row-main">
              <span><b>{item.nodes[0].title}</b><span className="la-faint">（{item.nodes[0].courseTitles.join('、')}）</span> 和 <b>{item.nodes[1].title}</b><span className="la-faint">（{item.nodes[1].courseTitles.join('、')}）</span></span>
              <span className="la-faint la-small">{KIND_LABEL[item.nodes[0].kind]} · {item.by === 'teacher' ? `主老师：${item.why}` : item.why}</span>
            </div>
            <Button size="sm" variant={active ? 'primary' : 'default'} onClick={() => pick(item)}>比较</Button>
          </div>
        })}</div>
      )}
    </Section>
    {pair && <Compare key={`${pair.a}|${pair.b}`} shell={shell} pair={pair} onClose={() => setPair(undefined)}
      onMerged={(id, title, course) => { setPair(undefined); setMerged({ id, title, ...(course ? { courseId: course } : {}) }); list.reload() }}
      onSeparate={() => { setPair(undefined); list.reload() }} />}
  </Page>
}

/** Started from a node's details: find the other node, of the same kind, in any course. */
function PickOther({ shell, nodeId, onPick }: { shell: LearnShell; nodeId: string; onPick(id: string): void }): ReactNode {
  const node = useLoad(shell, async () => (await shell.call<KnowledgeNode[]>('knowledge', 'candidates', { query: nodeId }))[0], [nodeId])
  const [query, setQuery] = useState(''), [found, setFound] = useState<KnowledgeNode[]>(), search = useAction()
  const find = () => search.run(async () => setFound((await shell.call<KnowledgeNode[]>('knowledge', 'candidates', { query })).filter(other => other.id !== nodeId && other.kind === node.data?.kind)))
  return <Section card title={node.data ? `和「${node.data.title}」合并` : '选择要合并的节点'} description="搜索另一个同类型的节点，两边比较后再决定">
    <div className="la-row nowrap"><div style={{ flex: 1, minWidth: 0 }}><TextField value={query} onChange={setQuery} onEnter={() => { if (query.trim()) void find() }} icon={Search} placeholder="名称或别名" aria-label="查找另一个节点" /></div>
      <Button loading={search.busy} disabled={!query.trim() || !node.data} onClick={() => void find()}>查找</Button></div>
    <ErrorText error={search.error ?? node.error} />
    {found && !found.length && <p className="la-faint la-small">没有找到同类型的其他节点</p>}
    {found && found.length > 0 && <div className="la-rows">{found.map(other => <div className="la-row-item" key={other.id}>
      <div className="la-row-main"><b>{other.title}</b><span className="la-faint la-small">{other.domain || '领域未注明'} · {other.description.slice(0, 80) || '说明待补充'}</span></div>
      <Button size="sm" onClick={() => onPick(other.id)}>比较</Button>
    </div>)}</div>}
  </Section>
}

function Compare({ shell, pair, onClose, onMerged, onSeparate }: {
  shell: LearnShell
  pair: Pair
  onClose(): void
  onMerged(id: string, title: string, courseId?: string): void
  onSeparate(): void
}): ReactNode {
  const [keep, setKeep] = useState(pair.keep)
  const mergeId = keep === pair.a ? pair.b : pair.a
  const plan = useLoad(shell, () => shell.call<MergePlan>('knowledge', 'mergePlan', { keepId: keep, mergeId }), [keep, mergeId])
  const states = useLoad(shell, () => shell.call<NodeState[]>('learner', 'states', { nodeIds: [pair.a, pair.b] }), [pair.a, pair.b])
  const action = useAction()
  if (!plan.data) return <Section card title="比较">{plan.error ? <ErrorText error={plan.error} /> : <Skeleton lines={6} />}</Section>
  const p = plan.data
  // Columns stay in the order the pair was listed, whichever one is kept.
  const [left, right] = p.keep.id === pair.a ? [p.keep, p.merge] : [p.merge, p.keep]
  const stateOf = (side: MergeSide) => {
    const state = states.data?.find(item => item.nodeId === side.id)
    return state ? `${STATE_TEXT[state.state]}${state.evidence.length ? `（${state.evidence.length} 条记录）` : ''}` : states.error ? '暂不可用' : '未探测'
  }
  const rows: { label: string; value(side: MergeSide): ReactNode; text(side: MergeSide): string }[] = [
    { label: '名称', value: side => <b>{side.title}</b>, text: side => side.title },
    { label: '类型', value: side => KIND_LABEL[side.kind], text: side => side.kind },
    { label: '领域', value: side => side.domain || <span className="la-faint">未注明</span>, text: side => side.domain },
    { label: '含义', value: side => side.description ? <shell.Markdown text={side.description} /> : <span className="la-faint">说明待补充</span>, text: side => side.description },
    { label: '表现条件', value: side => side.conditions || <span className="la-faint">未注明</span>, text: side => side.conditions },
    { label: '别名', value: side => side.aliases.join('、') || <span className="la-faint">无</span>, text: side => side.aliases.join('、') },
    { label: '所属课程', value: side => side.courseTitles.join('、'), text: side => side.courseTitles.join('、') },
    { label: '关系与出处', value: side => `${side.edgeCount} 条关系 · ${side.linkCount} 条出处`, text: () => '' },
    { label: '掌握记录', value: stateOf, text: stateOf },
  ]
  // Two nodes of the same name are told apart by their course.
  const named = (side: MergeSide) => (p.keep.title === p.merge.title ? `${side.title}（${side.courseTitles[0] ?? '未归课程'}）` : side.title)
  const kept = named(p.keep), folded = named(p.merge)
  const effects = [
    ...p.joins.map(course => `「${kept}」加入《${course.title}》`),
    p.links ? `${p.links} 条出处移到「${kept}」` : '',
    `「${folded}」停用，旧链接仍能打开并指向「${kept}」；作答记录不改，计入「${kept}」`,
  ].filter(Boolean)
  const title = (id: string) => p.titles[id] ?? '知识节点'
  return <Section card title="比较两边" description={pair.why && (pair.by === 'teacher' ? `主老师的理由：${pair.why}` : `推荐原因：${pair.why}`)} actions={<Button size="sm" variant="quiet" onClick={onClose}>收起</Button>}>
    <div className="la-merge-table" role="table" aria-label="两个节点的比较">
      <div className="la-merge-row la-merge-head" role="row"><span role="columnheader" /><span role="columnheader">{left.courseTitles.join('、') || '左边'}</span><span role="columnheader">{right.courseTitles.join('、') || '右边'}</span></div>
      {rows.map(row => {
        const differs = row.text(left) !== row.text(right)
        return <div key={row.label} className={`la-merge-row${differs ? ' is-diff' : ''}`} role="row">
          <span className="la-faint la-small" role="rowheader">{row.label}</span>
          <div role="cell">{row.value(left)}</div>
          <div role="cell">{row.value(right)}</div>
        </div>
      })}
    </div>
    <p className="la-faint la-small">有底色的行两边不同</p>
    <div className="la-toolbar">
      <span className="la-small">保留</span>
      <Segmented<string> value={keep} onChange={setKeep} aria-label="保留哪一个"
        options={[left, right].map(side => ({ value: side.id, label: left.title === right.title ? `${side.title} · ${side.courseTitles[0] ?? ''}` : side.title }))} />
    </div>
    <div className="la-graph-block">
      <div className="la-graph-label">合并后</div>
      <ul className="la-merge-effects">{effects.map(text => <li key={text}>{text}</li>)}</ul>
      {p.moved.length > 0 && <Disclosure summary={`${p.moved.length} 条关系改连到「${kept}」`}><ul className="la-merge-effects">{p.moved.map(edge => <li key={edge.id}>{relationSentence(edge, title)}</li>)}</ul></Disclosure>}
      {p.folded.length > 0 && <Disclosure summary={`${p.folded.length} 条和「${kept}」已有的关系相同，合成一条，依据合在一起`}><ul className="la-merge-effects">{p.folded.map(edge => <li key={edge.id}>{relationSentence(edge, title)}</li>)}</ul></Disclosure>}
      {p.stopped.length > 0 && <Disclosure summary={`${p.stopped.length} 条是两者之间的关系，合并后停用`}><ul className="la-merge-effects">{p.stopped.map(edge => <li key={edge.id}>{relationSentence(edge, title)}</li>)}</ul></Disclosure>}
    </div>
    {p.blocked && <Callout tone="bad">{p.blocked}</Callout>}
    <ErrorText error={action.error ?? states.error} />
    <div className="la-toolbar">
      <ConfirmButton icon={GitMerge} disabled={!!p.blocked} loading={action.busy} question={`确认「${folded}」和「${kept}」是同一项？`} confirm="合并"
        onConfirm={() => void action.run(async () => {
          await shell.call('knowledge', 'merge', { keepId: p.keep.id, keepVersion: p.keep.version, mergeId: p.merge.id, mergeVersion: p.merge.version })
          onMerged(p.keep.id, p.keep.title, p.keep.courseIds[0])
        })}>合并为「{p.keep.title}」</ConfirmButton>
      <Button disabled={action.busy} onClick={() => void action.run(async () => {
        await shell.call('knowledge', 'keepSeparate', { aId: left.id, aVersion: left.version, bId: right.id, bVersion: right.version })
        onSeparate()
      })}>不是同一项</Button>
      <span className="la-faint la-small">合并后可以在知识变更里整组撤销</span>
    </div>
  </Section>
}
