// library unit, browser half: the library page (sources, PDF import, search) and, in its own tab, the
// original-PDF reader for one source or one cited chunk.
import { useState, type ReactNode } from 'react'
import { BookOpen, Ellipsis, FileSearch, FileText, Import, Library, RefreshCw, RotateCw, Search as SearchIcon, SearchX, Upload, X } from 'lucide-react'
import type { ChunkKind, CitedChunk, CourseSource, IndexState, Retrieval, Source, LibraryImport } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import {
  Button, Callout, Disclosure, EmptyState, ErrorText, Field, FileDrop, Menu, NumberField, Page, PageHeader, Progress, Section, Segmented, Skeleton, Tag, TextArea, TextField,
  useAction, useLoad, type MenuEntry,
} from '@learning-agent/kit/client'
import { Reader } from './client/reader.tsx'

export const name = 'learning-library'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'library', title: '资料库', icon: Library, scope: 'both', page: 'library.sources', order: 40 }), 'library: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'library.sources' }, LibraryPage)), 'library: page')
}

type SourceRow = { source: Source; chunks: number; role?: CourseSource['role']; index?: IndexState }
/** Where PDFs are parsed and which service embeds them (from the host's environment). */
type Services = { parser: '本机' | '云端'; embeddings?: string }

const ROLE_LABEL: Record<CourseSource['role'], string> = { skeleton: '骨架教材', reference: '参考', 'exam-archive': '考试档案' }
const AUTHORITY_LABEL: Record<Source['authority'], string> = { '1': '一级', '2': '二级', '3': '三级', clue: '仅线索' }
const CHUNK_KIND: Record<ChunkKind, string> = { heading: '标题', text: '正文', formula: '公式', table: '表格', figure: '图', example: '例题', exercise: '习题', answer: '答案' }

function openSource(sourceId: string, title: string): void {
  shell.openPage('library.sources', { id: sourceId, sourceId }, { title, split: true })
}

function openChunk(chunkId: string): void {
  shell.openPage('library.sources', { id: chunkId, chunkId }, { title: '出处', split: true })
}

function LibraryPage({ scope, params }: LearningPageProps): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const chunkId = typeof params.chunkId === 'string' ? params.chunkId : undefined
  const sourceId = typeof params.sourceId === 'string' ? params.sourceId : undefined
  if (chunkId) return <ChunkView chunkId={chunkId} />
  if (sourceId) return <Reader sourceId={sourceId} shell={shell} />
  return <LibraryHome courseId={courseId} />
}

function LibraryHome({ courseId }: { courseId?: string }): ReactNode {
  const sources = useLoad(shell, () => shell.call<SourceRow[]>('library', 'sources', { courseId }), [courseId])
  const services = useLoad(shell, () => shell.call<Services>('library', 'services'), [])
  const [importing, setImporting] = useState(false)
  const [history, setHistory] = useState(false)
  const rows = sources.data ?? []
  const empty = sources.data !== undefined && rows.length === 0
  return (
    <Page>
      <PageHeader eyebrow={<><Library size={14} strokeWidth={1.75} />资料库</>} title={courseId ? '本课资料' : '资料库'}
        description={courseId ? '教材、题目和老师的回答都以这里的资料片段为依据，每句话都能点开看到原文。' : '全部资料。进入课程后，可以把资料加入课程作为骨架教材或参考。'}
        actions={!empty && <Button variant={importing ? 'default' : 'primary'} icon={importing ? X : Upload} onClick={() => setImporting(!importing)}>{importing ? '收起导入' : '导入 PDF'}</Button>} />
      <div className="la-stack" style={{ gap: 28 }}>
        {(importing || empty) && <PdfImport courseId={courseId} services={services.data} onDone={() => setImporting(false)} />}
        <ImportTasks history={history} />
        {!empty && <LibrarySearch courseId={courseId} services={services.data} />}
        <Section title="资料" icon={BookOpen} count={sources.data ? rows.length : undefined}
          actions={!empty && <Button size="sm" variant="quiet" onClick={() => setHistory(!history)}>{history ? '收起导入记录' : '导入记录'}</Button>}>
          <ErrorText error={sources.error} />
          {!sources.data && sources.loading && <Skeleton lines={3} />}
          {empty && <span className="la-faint">还没有资料。导入一本 PDF 教材开始。</span>}
          <div className="la-stack" style={{ gap: 10 }}>
            {rows.map(row => <SourceCard key={row.source.id} row={row} courseId={courseId} onChange={sources.reload} />)}
          </div>
        </Section>
        <ImportForm courseId={courseId} />
      </div>
    </Page>
  )
}

function SourceCard({ row, courseId, onChange }: { row: SourceRow; courseId?: string; onChange(): void }): ReactNode {
  const action = useAction()
  const [confirming, setConfirming] = useState(false)
  const { source } = row
  const isPdf = source.origin.kind === 'file' && /\.pdf$/i.test(source.origin.fileName)
  const run = (work: () => Promise<unknown>) => action.run(async () => { await work(); onChange() })
  const menu: MenuEntry[] = [
    ...(courseId ? [
      { heading: '在本课中' } as const,
      { key: 'skeleton', label: '作为骨架教材', hint: '教材按它的结构编写', checked: row.role === 'skeleton', onSelect: () => void run(() => shell.call('library', 'attach', { courseId, sourceId: source.id, role: 'skeleton' })) },
      { key: 'reference', label: '作为参考资料', checked: row.role === 'reference', onSelect: () => void run(() => shell.call('library', 'attach', { courseId, sourceId: source.id, role: 'reference' })) },
      'divider' as const,
    ] : []),
    ...(isPdf ? [{ key: 'reparse', label: '重新解析…', icon: RefreshCw, hint: '生成新版本，原出处保留', onSelect: () => setConfirming(true) }] : []),
    ...(row.index?.state === 'failed' ? [{ key: 'reindex', label: '重建语义索引', icon: RotateCw, onSelect: () => void run(() => shell.call('library', 'reindex', { sourceId: source.id })) }] : []),
  ]
  return (
    <div className="la-card la-source">
      <span className="la-row-icon accent la-source-icon"><FileText size={18} strokeWidth={1.75} /></span>
      <div className="la-source-body">
        <div className="la-source-title">{source.title}</div>
        <div className="la-source-meta">
          {row.role && <Tag tone="accent">{ROLE_LABEL[row.role]}</Tag>}
          <Tag>{AUTHORITY_LABEL[source.authority]}</Tag>
          <span className="la-num">{row.chunks} 个片段</span>
          <IndexInfo state={row.index} />
          {source.parser?.where === 'cloud' && <span>· 云端解析</span>}
          {source.supersedes && <span>· 新解析版本</span>}
        </div>
        <div className="la-faint la-small la-ellipsis">{source.origin.kind === 'file' ? source.origin.fileName : source.origin.url}{source.pageOffset ? ` · 页码偏移 ${source.pageOffset}` : ''}</div>
        {row.index?.state === 'failed' && <Callout tone="bad">语义索引失败：{row.index.message}</Callout>}
        {confirming && (
          <Callout tone="warn" title="重新解析这份资料？" actions={<>
            <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>取消</Button>
            <Button size="sm" variant="primary" icon={RefreshCw} loading={action.busy} onClick={() => { setConfirming(false); void run(() => shell.call('library', 'reparse', { sourceId: source.id, courseId })) }}>重新解析</Button>
          </>}>会生成新的解析版本{courseId ? '，本课改用新版本' : ''}；原来的出处和原件仍可打开。</Callout>
        )}
        <ErrorText error={action.error} />
      </div>
      <div className="la-source-actions">
        <Button size="sm" icon={BookOpen} onClick={() => openSource(source.id, source.title)}>阅读原文</Button>
        {menu.length > 0 && (
          <Menu align="end" width={230} entries={menu} trigger={props => <Button size="sm" variant="quiet" icon={Ellipsis} aria-label="更多操作" title="更多操作" disabled={action.busy} {...props} />} />
        )}
      </div>
    </div>
  )
}

function IndexInfo({ state }: { state?: IndexState }): ReactNode {
  if (!state || state.state === 'off' || state.state === 'failed') return null
  const text = state.state === 'ready' ? '· 语义索引就绪' : state.state === 'indexing' ? `· 语义索引 ${state.done}/${state.total}` : '· 语义索引排队中'
  return <span title={state.model}>{text}</span>
}

function LibrarySearch({ courseId, services }: { courseId?: string; services?: Services }): ReactNode {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<Retrieval>()
  const action = useAction()
  const search = () => { if (query.trim()) void action.run(async () => setResult(await shell.call<Retrieval>('library', 'search', { query, courseId, limit: 12 }))) }
  const hits = result?.hits
  return (
    <Section title="检索" icon={SearchIcon}>
      <div className="la-row nowrap">
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextField size="lg" icon={SearchIcon} aria-label="检索资料" value={query} onChange={setQuery} onEnter={search}
            placeholder={services?.embeddings ? '直接问，例如：怎样判断层流还是湍流' : '输入关键词，例如：静力学 基本方程'} />
        </div>
        <Button variant="primary" loading={action.busy} disabled={!query.trim()} onClick={search} style={{ height: 42, padding: '0 18px', borderRadius: 11 }}>检索</Button>
      </div>
      {services?.embeddings && <p className="la-faint la-small" style={{ margin: '8px 0 0' }}>关键词加语义检索：问题和资料片段会发送到 Voyage AI 计算相关度。</p>}
      <div className="la-stack" style={{ gap: 10, marginTop: result || action.error ? 14 : 0 }}>
        <ErrorText error={action.error} />
        {result?.note && <Callout>{result.note}</Callout>}
        {result?.gap && hits && hits.length > 0 && <Callout tone="warn" title="资料里没有找到能直接回答的内容">下面只是最接近的片段，不能当作答案的出处。</Callout>}
        {hits?.length === 0 && <div className="la-card"><EmptyState compact icon={SearchX} title="没有找到" description="换个说法，或者检查资料是否已经导入并解析完成。" /></div>}
        {hits?.map(hit => <ChunkCard key={hit.chunk.id} chunk={hit.chunk} relevance={hit.relevance} />)}
      </div>
    </Section>
  )
}

function ChunkCard({ chunk, relevance }: { chunk: CitedChunk; relevance?: number }): ReactNode {
  return (
    <div className="la-card la-hit">
      <div className="la-hit-head">
        <Tag>{CHUNK_KIND[chunk.kind] ?? chunk.kind}</Tag>
        <span className="la-strong" style={{ color: 'var(--la-text-2)' }}>{chunk.citation}</span>
        <span className="la-ellipsis" style={{ flex: 1 }}>{chunk.section.join(' › ')}</span>
        {relevance !== undefined && <span className="la-relevance" title="重排模型给出的相关度">相关度 <span className="la-relevance-bar"><i style={{ width: `${Math.round(relevance * 100)}%` }} /></span><span className="la-num">{relevance.toFixed(2)}</span></span>}
      </div>
      <div className="la-hit-body"><shell.Markdown text={chunk.text} /></div>
      <div className="la-row" style={{ marginTop: 10 }}>
        <Button size="sm" icon={FileSearch} onClick={() => openChunk(chunk.id)}>查看原文</Button>
        {(chunk.kind === 'formula' || chunk.text.includes('$')) && <span className="la-faint la-small">公式为识别结果，请对照原 PDF 核对符号和单位。</span>}
      </div>
    </div>
  )
}

function ChunkView({ chunkId }: { chunkId: string }): ReactNode {
  const chunk = useLoad(shell, () => shell.call<CitedChunk | null>('library', 'chunk', { chunkId }), [chunkId])
  if (chunk.error) return <Page><ErrorText error={chunk.error} /></Page>
  if (!chunk.data) return <Page>{chunk.loading ? <Skeleton lines={4} /> : <EmptyState icon={SearchX} title="找不到这个出处" description="资料可能已经重新解析或被移除。" />}</Page>
  return <Reader sourceId={chunk.data.sourceId} chunk={chunk.data} shell={shell} />
}

function ImportForm({ courseId }: { courseId?: string }): ReactNode {
  const [form, setForm] = useState({ title: '', file: '', parsed: '', pageOffset: 0, authority: '1' as Source['authority'], kind: 'textbook' as Source['kind'] })
  const [done, setDone] = useState<string>()
  const action = useAction()
  const set = <K extends keyof typeof form>(key: K) => (value: (typeof form)[K]) => setForm(previous => ({ ...previous, [key]: value }))
  const submit = () => action.run(async () => {
    const source = await shell.call<Source>('library', 'import', {
      title: form.title,
      kind: form.kind,
      authority: form.authority,
      file: form.file.trim(),
      parsed: form.parsed.split('\n').map(line => line.trim()).filter(Boolean),
      pageOffset: form.pageOffset,
      ...(courseId ? { courseId, role: 'skeleton' } : {}),
    })
    setDone(`已导入《${source.title}》`)
  })
  return (
    <Disclosure summary="已有 MinerU 解析结果？高级导入">
      <div className="la-card la-stack" style={{ gap: 14 }}>
        <Field label="标题"><TextField aria-label="资料标题" value={form.title} onChange={set('title')} placeholder="化工原理（第3版）" /></Field>
        <Field label="原文件路径"><TextField aria-label="原文件路径" value={form.file} onChange={set('file')} placeholder="D:\…\化工原理.pdf" /></Field>
        <Field label="解析结果" hint="MinerU 的 JSON 文件路径，每行一个"><TextArea aria-label="解析结果路径" value={form.parsed} onChange={set('parsed')} minRows={2} /></Field>
        <div className="la-row" style={{ alignItems: 'flex-start', gap: 20 }}>
          <Field label="页码偏移" hint="PDF 页 − 书上页码"><NumberField aria-label="页码偏移" value={form.pageOffset} onChange={set('pageOffset')} /></Field>
          <Field label="权威级别"><Segmented aria-label="权威级别" value={form.authority} options={AUTHORITY_CHOICES} onChange={set('authority')} /></Field>
        </div>
        <div className="la-row">
          <Button variant="primary" icon={Import} loading={action.busy} disabled={!form.title || !form.file || !form.parsed} onClick={() => void submit()}>导入</Button>
          {courseId && <span className="la-faint la-small">导入后自动设为本课骨架教材</span>}
          {done && <Tag tone="ok">{done}</Tag>}
        </div>
        <ErrorText error={action.error} />
      </div>
    </Disclosure>
  )
}

const MAX_PDF = 200 * 1024 * 1024
const AUTHORITY_CHOICES = Object.entries(AUTHORITY_LABEL).map(([value, label]) => ({ value: value as Source['authority'], label }))
const ROLE_CHOICES = Object.entries(ROLE_LABEL).map(([value, label]) => ({ value: value as CourseSource['role'], label }))

function PdfImport({ courseId, services, onDone }: { courseId?: string; services?: Services; onDone(): void }): ReactNode {
  const [file, setFile] = useState<File>()
  const [title, setTitle] = useState('')
  const [authority, setAuthority] = useState<Source['authority']>('1')
  const [offset, setOffset] = useState(0)
  const [role, setRole] = useState<CourseSource['role']>('skeleton')
  const [progress, setProgress] = useState<number>()
  const [done, setDone] = useState('')
  const action = useAction()
  const choose = (picked?: File) => { setFile(picked); setTitle(picked?.name.replace(/\.pdf$/i, '') ?? ''); setDone('') }
  const upload = () => action.run(() => new Promise<void>((resolve, reject) => {
    if (!file) { reject(new Error('请选择 PDF')); return }
    const xhr = new XMLHttpRequest()
    const metadata = { title, fileName: file.name, authority, kind: 'textbook', pageOffset: offset, ...(courseId ? { courseId, role } : {}) }
    xhr.open('POST', `/api/learning/library.upload?metadata=${encodeURIComponent(JSON.stringify(metadata))}`)
    xhr.setRequestHeader('Content-Type', 'application/pdf')
    setProgress(0)
    xhr.upload.onprogress = event => { if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)) }
    xhr.onload = () => {
      setProgress(undefined)
      try {
        const result = JSON.parse(xhr.responseText)
        if (xhr.status >= 400) { reject(new Error(result.error ?? '上传失败')); return }
        setDone(result.status === 'ready' ? '已复用资料库中的相同 PDF' : result.status === 'waiting' ? result.message : 'PDF 已保存，解析会在后台继续，可以关闭此页')
        setFile(undefined)
        resolve()
      } catch { reject(new Error('上传未收到有效回复，请查看导入任务后重试')) }
    }
    xhr.onerror = () => { setProgress(undefined); reject(new Error('上传连接中断，请查看导入任务后重试')) }
    xhr.send(file)
  }))
  const where = services?.parser === '云端' ? '上传到 MinerU 云端解析，长书自动分段，几分钟完成' : '在本机解析'
  return (
    <Section title="导入 PDF" icon={Upload} card actions={done && <Button size="sm" variant="quiet" onClick={onDone}>完成</Button>}>
      <div className="la-stack" style={{ gap: 14 }}>
        <FileDrop file={file} onFile={choose} maxBytes={MAX_PDF} disabled={action.busy} hint={`不超过 200 MB · ${where}`} />
        {file && <>
          <Field label="标题"><TextField aria-label="PDF 标题" value={title} onChange={setTitle} /></Field>
          <div className="la-row" style={{ alignItems: 'flex-start', gap: 20 }}>
            <Field label="页码偏移" hint="书上页码 = PDF 页码 − 偏移"><NumberField aria-label="页码偏移" value={offset} onChange={setOffset} /></Field>
            <Field label="权威级别"><Segmented<Source['authority']> aria-label="权威级别" value={authority} options={AUTHORITY_CHOICES} onChange={setAuthority} /></Field>
            {courseId && <Field label="加入本课作为"><Segmented<CourseSource['role']> aria-label="课程角色" value={role} options={ROLE_CHOICES} onChange={setRole} /></Field>}
          </div>
          {progress !== undefined && <Progress value={progress} label="上传进度" />}
          <div className="la-row">
            <Button variant="primary" icon={Upload} loading={action.busy} disabled={!title.trim() || file.size > MAX_PDF} onClick={() => void upload()}>{action.busy ? `上传中 ${progress ?? 0}%` : '上传并解析'}</Button>
            <span className="la-faint la-small">资料完整解析后才交给老师。</span>
          </div>
        </>}
        <ErrorText error={action.error} />
        {done && <Callout tone="ok">{done}</Callout>}
      </div>
    </Section>
  )
}

const IMPORT_LABEL: Record<LibraryImport['status'], string> = { queued: '等待解析', parsing: '解析中', indexing: '建立索引', waiting: '等待恢复', ready: '可用', failed: '失败', canceled: '已取消' }

/** Imports that need attention (running, waiting, failed); with `history`, finished ones too. */
function ImportTasks({ history }: { history: boolean }): ReactNode {
  const tasks = useLoad(shell, () => shell.call<LibraryImport[]>('library', 'imports'), [])
  const action = useAction()
  const change = (method: string, id: string) => action.run(async () => { await shell.call('library', method, { id }); tasks.reload() })
  // Finished imports already appear under "资料"; only unfinished, failed and canceled ones need attention here.
  const shown = (tasks.data ?? []).filter(task => history || task.status !== 'ready').slice(0, 20)
  if (shown.length === 0 && !tasks.error) return history && tasks.data ? <Section title="导入记录" icon={Upload}><span className="la-faint">还没有导入过 PDF。</span></Section> : null
  return (
    <Section title={history ? '导入记录' : '导入任务'} icon={Upload} count={shown.length}>
      <ErrorText error={tasks.error} />
      <div className="la-rows">
        {shown.map(task => {
          const tone = task.status === 'failed' ? 'bad' : task.status === 'ready' ? 'ok' : task.status === 'canceled' ? 'neutral' : 'accent'
          return (
            <div key={task.id} className="la-row-item" style={{ alignItems: 'flex-start' }}>
              <span className={`la-row-icon ${tone}`}><FileText size={16} strokeWidth={1.75} /></span>
              <div className="la-row-main" style={{ gap: 3 }}>
                <span className="la-row" style={{ gap: 8 }}><span className="la-strong">{task.title}</span><Tag tone={tone}>{IMPORT_LABEL[task.status]}</Tag></span>
                <span className="la-faint la-small">{task.fileName}</span>
                {task.message && <span className={task.status === 'failed' ? 'la-error la-small' : 'la-muted la-small'}>{task.message}</span>}
              </div>
              <div className="la-row-end">
                {['failed', 'waiting', 'canceled'].includes(task.status) && <Button size="sm" icon={RotateCw} disabled={action.busy} onClick={() => void change('retry', task.id)}>重试</Button>}
                {['queued', 'parsing', 'indexing', 'waiting'].includes(task.status) && <Button size="sm" variant="quiet" icon={X} disabled={action.busy} onClick={() => void change('cancel', task.id)}>取消</Button>}
                {task.sourceId && <Button size="sm" variant="quiet" icon={BookOpen} onClick={() => openSource(task.sourceId!, task.title)}>阅读</Button>}
              </div>
            </div>
          )
        })}
      </div>
      <ErrorText error={action.error} />
    </Section>
  )
}
