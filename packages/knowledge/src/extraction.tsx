// Section extraction (knowledge C): the course source's outline with each section's latest job. The
// learner starts, cancels or retries a section; a finished one links to its change group.
import { useState, type ReactNode } from 'react'
import { FileSearch, Search } from 'lucide-react'
import type { ExtractionOverview, ExtractionSection, ExtractionStart } from '@learning-agent/contracts'
import type { LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import { Button, Callout, EmptyState, ErrorText, Page, PageHeader, Section, Select, Skeleton, Tag, TextField, useAction, useLoad, type Tone } from '@learning-agent/kit/client'

const ROLE: Record<ExtractionOverview['sources'][number]['role'], string> = { skeleton: '骨架教材', reference: '参考资料', 'exam-archive': '历年试题' }

function status(section: ExtractionSection): { text: string; tone: Tone } | undefined {
  const job = section.job
  if (!job) return undefined
  if (section.stale) return { text: '资料已更新', tone: 'warn' }
  if (job.status === 'done') return { text: '已加入', tone: 'ok' }
  if (job.status === 'failed') return { text: '失败', tone: 'bad' }
  if (job.status === 'canceled') return { text: '已取消', tone: 'neutral' }
  return { text: job.status === 'running' ? '抽取中' : '排队中', tone: 'accent' }
}

export function ExtractPage({ shell, scope }: LearningPageProps & { shell: LearnShell }): ReactNode {
  if (scope.kind !== 'course') return <Page><EmptyState title="进入一门课后按小节抽取" /></Page>
  return <Extract shell={shell} courseId={scope.courseId} />
}

function Extract({ shell, courseId }: { shell: LearnShell; courseId: string }): ReactNode {
  const [sourceId, setSourceId] = useState<string>()
  const data = useLoad(shell, () => shell.call<ExtractionOverview>('knowledge', 'extractions', { courseId, ...(sourceId ? { sourceId } : {}) }), [courseId, sourceId])
  const [query, setQuery] = useState('')
  const [notes, setNotes] = useState<ExtractionStart[]>([])
  const action = useAction()
  const start = (section: string) => action.run(async () => {
    const results = await shell.call<ExtractionStart[]>('knowledge', 'extract', { courseId, sections: [section], ...(data.data?.sourceId ? { sourceId: data.data.sourceId } : {}) })
    setNotes(results.filter(result => result.outcome !== 'started'))
    data.reload()
  })
  const cancel = (id: string) => action.run(async () => { await shell.call('knowledge', 'cancelExtraction', { courseId, id }); data.reload() })
  const overview = data.data
  const wanted = query.trim().toLocaleLowerCase()
  const sections = overview?.sections.filter(section => !wanted || section.heading.toLocaleLowerCase().includes(wanted)) ?? []
  const busy = overview?.sections.filter(section => section.job && (section.job.status === 'queued' || section.job.status === 'running')).length ?? 0
  return <Page>
    <PageHeader eyebrow={<><FileSearch size={14} strokeWidth={1.75} />本课</>} title="按小节抽取"
      description="让模型读一个小节的原文，起草知识节点和关系。节点带出处，关系一律是草案，核对原文后再改为有效；每节的结果可以在知识变更里整组撤销" />
    <ErrorText error={data.error ?? action.error} />
    {notes.map(note => <Callout key={note.section} tone={note.outcome === 'too-long' || note.outcome === 'not-found' ? 'warn' : 'neutral'}>{note.message}</Callout>)}
    {!overview ? <Skeleton lines={8} /> : !overview.sources.length ? (
      <div className="la-card"><EmptyState icon={FileSearch} title="本课还没有可以引用的资料" description="先在资料库把教材加入本课，解析完成后就能按小节抽取。"
        action={<Button onClick={() => shell.openPage('library.sources', {}, { title: '资料库' })}>去资料库</Button>} /></div>
    ) : <>
      <div className="la-toolbar">
        {overview.sources.length > 1 && <Select<string> value={overview.sourceId ?? ''} onChange={setSourceId} aria-label="资料"
          options={overview.sources.map(source => ({ value: source.id, label: `${source.title} · ${ROLE[source.role]}` }))} />}
        <div style={{ flex: 1, minWidth: 180 }}><TextField value={query} onChange={setQuery} icon={Search} placeholder="筛选小节" aria-label="筛选小节" /></div>
        {busy > 0 && <span className="la-faint la-small">{busy} 节正在抽取或排队，同时最多两节</span>}
      </div>
      <Section title={overview.sources.find(source => source.id === overview.sourceId)?.title ?? '目录'} count={sections.length}>
        {sections.length === 0 ? <EmptyState compact title="没有匹配的小节" /> : <div className="la-rows">{sections.map(section => {
          const tag = status(section), job = section.job
          const running = job?.status === 'queued' || job?.status === 'running'
          return <div className="la-row-item la-extract-row" key={section.section} style={{ ['--depth' as string]: Math.max(0, section.depth - 1) }}>
            <div className="la-row-main">
              <span className="la-extract-heading">{section.heading}{tag && <Tag tone={tag.tone}>{tag.text}</Tag>}</span>
              {job && job.status !== 'queued' && <span className={`la-small${job.status === 'failed' ? '' : ' la-faint'}`}>{section.stale ? '资料重新解析后这一节的原文变了，可以再抽一次（只补新内容）' : job.message}</span>}
              {job?.status === 'done' && (job.result?.skipped.length ?? 0) > 0 && <span className="la-faint la-small">跳过：{job.result!.skipped.slice(0, 3).join('；')}{job.result!.skipped.length > 3 ? ` 等 ${job.result!.skipped.length} 项` : ''}</span>}
            </div>
            <span className="la-toolbar">
              {job?.status === 'done' && job.operationId && <Button size="sm" variant="quiet" onClick={() => shell.openPage('knowledge.history', { operationId: job.operationId }, { title: '知识变更' })}>查看变化</Button>}
              {running ? <Button size="sm" disabled={action.busy} onClick={() => void cancel(job!.id)}>取消</Button>
                : (!job || job.status !== 'done' || section.stale) && <Button size="sm" disabled={action.busy} onClick={() => void start(section.section)}>{!job ? '抽取' : section.stale ? '再抽一次' : '重试'}</Button>}
            </span>
          </div>
        })}</div>}
      </Section>
    </>}
  </Page>
}
