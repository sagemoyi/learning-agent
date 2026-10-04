// library unit, browser half: the library page (sources, import, search, one chunk's source view).
import { useState, type ReactNode } from 'react'
import { BookOpen, FileSearch, Import, Library, RefreshCw, RotateCw, Search as SearchIcon, Upload, X } from 'lucide-react'
import type { CitedChunk, CourseSource, IndexState, Retrieval, Source, LibraryImport } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import { Button, Disclosure, Field, FileDrop, NumberField, Progress, Segmented, TextArea, TextField, useAction, useLoad } from '@learning-agent/kit/client'
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

function LibraryPage({ scope, params }: LearningPageProps): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const sources = useLoad(shell, () => shell.call<SourceRow[]>('library', 'sources', { courseId }), [courseId])
  const services = useLoad(shell, () => shell.call<Services>('library', 'services'), [])
  const chunkId = typeof params.chunkId === 'string' ? params.chunkId : undefined
  const sourceId = typeof params.sourceId === 'string' ? params.sourceId : undefined
  return (
    <div className="la-pad la-stack">
      <div>
        <div className="la-h1">资料库</div>
        <div className="la-muted">{courseId ? '本课可以引用的资料。教材、题目和老师的回答都以这里的片段为依据。' : '全部资料。进入课程后可以把资料加入课程。'}</div>
      </div>
      {chunkId && <ChunkView chunkId={chunkId} />}
      {!chunkId && sourceId && <Reader sourceId={sourceId} shell={shell} />}
      <PdfImport courseId={courseId} services={services.data} />
      <ImportTasks />
      <LibrarySearch courseId={courseId} services={services.data} />
      <section className="la-stack">
        <div className="la-h2">资料</div>
        {sources.error && <div className="la-error">{sources.error}</div>}
        {sources.data?.length === 0 && <div className="la-muted">还没有资料。选择或拖入 PDF 开始。</div>}
        {sources.data?.map(row => <SourceCard key={row.source.id} row={row} courseId={courseId} onChange={sources.reload} />)}
      </section>
      <ImportForm courseId={courseId} />
    </div>
  )
}

function SourceCard({ row, courseId, onChange }: { row: SourceRow; courseId?: string; onChange(): void }): ReactNode {
  const action = useAction()
  const attach = (role: CourseSource['role']) => action.run(async () => {
    await shell.call('library', 'attach', { courseId, sourceId: row.source.id, role })
    onChange()
  })
  return (
    <div className="la-card la-stack" style={{ gap: 6 }}>
      <div className="la-row">
        <b>{row.source.title}</b>
        <span className="la-tag">{AUTHORITY_LABEL[row.source.authority]}</span>
        <span className="la-tag">{row.chunks} 个片段</span>
        {row.role && <span className="la-tag accent">{ROLE_LABEL[row.role]}</span>}
        {row.source.parser?.where === 'cloud' && <span className="la-tag">云端解析</span>}
        <IndexTag state={row.index} />
      </div>
      <div className="la-muted la-small">{row.source.origin.kind === 'file' ? row.source.origin.fileName : row.source.origin.url} · 页码偏移 {row.source.pageOffset}</div>
      <div className="la-row"><Button icon={BookOpen} onClick={() => shell.openPage('library.sources', { id: row.source.id, sourceId: row.source.id }, { title: row.source.title, split: true })}>阅读原文</Button>
        {row.source.origin.kind === 'file' && /\.pdf$/i.test(row.source.origin.fileName) && <Button icon={RefreshCw} disabled={action.busy} onClick={() => void action.run(async () => { await shell.call('library', 'reparse', { sourceId: row.source.id, courseId }); onChange() })}>重新解析</Button>}
        {row.source.supersedes && <span className="la-tag">新解析版本</span>}
      </div>
      {row.index?.state === 'failed' && <div className="la-row la-small"><span className="la-error">语义索引失败：{row.index.message}</span>
        <Button size="sm" icon={RotateCw} disabled={action.busy} onClick={() => void action.run(async () => { await shell.call('library', 'reindex', { sourceId: row.source.id }); onChange() })}>重试</Button></div>}
      {courseId && (
        <div className="la-row">
          <Button disabled={action.busy || row.role === 'skeleton'} onClick={() => void attach('skeleton')}>设为本课骨架教材</Button>
          <Button disabled={action.busy || row.role === 'reference'} onClick={() => void attach('reference')}>作为本课参考</Button>
        </div>
      )}
      {action.error && <div className="la-error">{action.error}</div>}
    </div>
  )
}

function IndexTag({ state }: { state?: IndexState }): ReactNode {
  if (!state || state.state === 'off' || state.state === 'failed') return null
  const text = state.state === 'ready' ? '语义索引就绪' : state.state === 'indexing' ? `语义索引 ${state.done}/${state.total}` : '语义索引排队中'
  return <span className="la-tag" title={state.model}>{text}</span>
}

function LibrarySearch({ courseId, services }: { courseId?: string; services?: Services }): ReactNode {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<Retrieval>()
  const action = useAction()
  const search = () => action.run(async () => setResult(await shell.call<Retrieval>('library', 'search', { query, courseId, limit: 12 })))
  const hits = result?.hits
  return (
    <section className="la-stack">
      <div className="la-h2">检索</div>
      <div className="la-row">
        <div style={{ flex: 1, minWidth: 200 }}>
          <TextField icon={SearchIcon} aria-label="检索资料" value={query} onChange={setQuery} onEnter={() => { if (query.trim()) void search() }}
            placeholder={services?.embeddings ? '检索资料，可以直接问，例如：怎样判断层流还是湍流' : '检索资料，例如：静力学 基本方程'} />
        </div>
        <Button variant="primary" loading={action.busy} disabled={!query.trim()} onClick={() => void search()}>检索</Button>
      </div>
      {services?.embeddings && <div className="la-small la-muted">关键词加语义检索：问题和资料片段会发送到 Voyage AI 计算相关度。</div>}
      {action.error && <div className="la-error">{action.error}</div>}
      {result?.note && <div className="la-small la-muted">{result.note}</div>}
      {result?.gap && hits && hits.length > 0 && <div className="la-small la-muted">资料里没有找到能直接回答的内容，下面只是最接近的片段。</div>}
      {hits?.length === 0 && <div className="la-muted">没有找到。</div>}
      {hits?.map(hit => <ChunkCard key={hit.chunk.id} chunk={hit.chunk} relevance={hit.relevance} />)}
    </section>
  )
}

function ChunkCard({ chunk, active, relevance }: { chunk: CitedChunk; active?: boolean; relevance?: number }): ReactNode {
  return (
    <div className={`la-card${active ? ' is-active' : ''}`}>
      <div className="la-row la-small la-muted">
        <span className="la-tag">{chunk.kind}</span>
        <span>{chunk.citation}</span>
        <span>{chunk.section.join(' › ')}</span>
        {relevance !== undefined && <span>相关度 {relevance.toFixed(2)}</span>}
      </div>
      <shell.Markdown text={chunk.text} />
      {(chunk.kind === 'formula' || chunk.text.includes('$')) && <div className="la-muted la-small">公式为识别结果，请对照原 PDF 核对符号和单位。</div>}
      {!active && <div><Button size="sm" icon={FileSearch} onClick={() => shell.openPage('library.sources', { id: chunk.id, chunkId: chunk.id }, { title: '出处', split: true })}>查看原文出处</Button></div>}
    </div>
  )
}

function ChunkView({ chunkId }: { chunkId: string }): ReactNode {
  const chunk = useLoad(shell, () => shell.call<CitedChunk | null>('library', 'chunk', { chunkId }), [chunkId])
  if (chunk.error) return <div className="la-error">{chunk.error}</div>
  if (!chunk.data) return chunk.loading ? null : <div className="la-muted">找不到片段 {chunkId}</div>
  return (
    <section className="la-stack">
      <div className="la-h2">出处</div>
      <Reader sourceId={chunk.data.sourceId} chunk={chunk.data} shell={shell} />
      <ChunkCard chunk={chunk.data} active />
    </section>
  )
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
    <Disclosure summary="已有解析结果（高级导入）">
      <section className="la-card la-stack">
        <div className="la-h2">导入已有 MinerU 解析结果</div>
        <Field label="标题"><TextField aria-label="资料标题" value={form.title} onChange={set('title')} placeholder="化工原理（第3版）" /></Field>
        <Field label="原文件路径"><TextField aria-label="原文件路径" value={form.file} onChange={set('file')} placeholder="D:\…\化工原理.pdf" /></Field>
        <Field label="解析结果" hint="MinerU 的 JSON 文件路径，每行一个"><TextArea aria-label="解析结果路径" value={form.parsed} onChange={set('parsed')} minRows={2} /></Field>
        <div className="la-row" style={{ alignItems: 'flex-start', gap: 16 }}>
          <Field label="页码偏移" hint="PDF 页 − 书上页码"><NumberField aria-label="页码偏移" value={form.pageOffset} onChange={set('pageOffset')} /></Field>
          <Field label="权威级别"><Segmented aria-label="权威级别" value={form.authority} options={AUTHORITY_CHOICES} onChange={set('authority')} /></Field>
        </div>
        <div className="la-row">
          <Button variant="primary" icon={Import} loading={action.busy} disabled={!form.title || !form.file || !form.parsed} onClick={() => void submit()}>导入</Button>
          {courseId && <span className="la-muted la-small">导入后自动设为本课骨架教材</span>}
          {done && <span className="la-tag ok">{done}</span>}
        </div>
        {action.error && <div className="la-error">{action.error}</div>}
      </section>
    </Disclosure>
  )
}

const MAX_PDF = 200 * 1024 * 1024
const AUTHORITY_CHOICES = Object.entries(AUTHORITY_LABEL).map(([value, label]) => ({ value: value as Source['authority'], label }))
const ROLE_CHOICES = Object.entries(ROLE_LABEL).map(([value, label]) => ({ value: value as CourseSource['role'], label }))

function PdfImport({ courseId, services }: { courseId?: string; services?: Services }): ReactNode {
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
        setDone(result.status === 'ready' ? '已复用资料库中的相同 PDF' : result.status === 'waiting' ? result.message : 'PDF 已保存，可以关闭此页，解析会继续')
        setFile(undefined)
        resolve()
      } catch { reject(new Error('上传未收到有效回复，请查看导入任务后重试')) }
    }
    xhr.onerror = () => { setProgress(undefined); reject(new Error('上传连接中断，请查看导入任务后重试')) }
    xhr.send(file)
  }))
  const where = services?.parser === '云端' ? '上传到 MinerU 云端解析，长书自动分段，几分钟完成' : '在本机解析'
  return (
    <section className="la-card la-stack">
      <div className="la-h2">导入 PDF</div>
      <FileDrop file={file} onFile={choose} maxBytes={MAX_PDF} disabled={action.busy} hint={`不超过 200 MB · ${where}`} />
      {file && <>
        <Field label="标题"><TextField aria-label="PDF 标题" value={title} onChange={setTitle} /></Field>
        <div className="la-row" style={{ alignItems: 'flex-start', gap: 16 }}>
          <Field label="页码偏移" hint="书上页码 = PDF 页码 − 偏移"><NumberField aria-label="页码偏移" value={offset} onChange={setOffset} /></Field>
          <Field label="权威级别"><Segmented<Source['authority']> aria-label="权威级别" value={authority} options={AUTHORITY_CHOICES} onChange={setAuthority} /></Field>
          {courseId && <Field label="加入本课作为"><Segmented<CourseSource['role']> aria-label="课程角色" value={role} options={ROLE_CHOICES} onChange={setRole} /></Field>}
        </div>
        {progress !== undefined && <Progress value={progress} label="上传进度" />}
        <div className="la-row">
          <Button variant="primary" icon={Upload} loading={action.busy} disabled={!title.trim() || file.size > MAX_PDF} onClick={() => void upload()}>{action.busy ? `上传中 ${progress ?? 0}%` : '上传并解析'}</Button>
          <span className="la-small la-muted">资料完整解析后才交给老师。</span>
        </div>
      </>}
      {action.error && <div className="la-error">{action.error}</div>}
      {done && <div className="la-muted">{done}</div>}
    </section>
  )
}

function ImportTasks(): ReactNode {
  const tasks = useLoad(shell, () => shell.call<LibraryImport[]>('library', 'imports'), [])
  const action = useAction()
  const change = (method: string, id: string) => action.run(async () => { await shell.call('library', method, { id }); tasks.reload() })
  const [showDone, setShowDone] = useState(false)
  const labels: Record<LibraryImport['status'], string> = { queued: '等待解析', parsing: '解析中', indexing: '建立索引', waiting: '等待恢复', ready: '可用', failed: '失败', canceled: '已取消' }
  if (!tasks.data?.length && !tasks.error) return null
  // Finished imports already appear under "资料"; only unfinished, failed and canceled ones need attention here.
  const done = tasks.data?.filter(task => task.status === 'ready') ?? []
  const shown = (tasks.data ?? []).filter(task => showDone || task.status !== 'ready').slice(0, 20)
  return <section className="la-stack"><div className="la-row"><span className="la-h2">导入任务</span>{done.length > 0 && <button className="la-link la-small" onClick={() => setShowDone(!showDone)}>{showDone ? '隐藏已完成' : `已完成 ${done.length} 个`}</button>}</div>{tasks.error && <div className="la-error">{tasks.error}</div>}{shown.length === 0 && <div className="la-muted la-small">没有进行中的导入。</div>}{shown.map(task => <div key={task.id} className="la-card la-stack" style={{ gap: 5 }}>
    <div className="la-row"><b>{task.title}</b><span className="la-tag">{labels[task.status]}</span><span className="la-small la-muted">{task.fileName}</span></div>
    <div className={task.status === 'failed' ? 'la-error' : 'la-muted'}>{task.message}</div>
    <div className="la-row">
      {['failed', 'waiting', 'canceled'].includes(task.status) && <Button size="sm" icon={RotateCw} disabled={action.busy} onClick={() => void change('retry', task.id)}>重试</Button>}
      {['queued', 'parsing', 'indexing', 'waiting'].includes(task.status) && <Button size="sm" variant="quiet" icon={X} disabled={action.busy} onClick={() => void change('cancel', task.id)}>取消</Button>}
      {task.sourceId && <Button size="sm" icon={BookOpen} onClick={() => shell.openPage('library.sources', { id: task.sourceId, sourceId: task.sourceId }, { title: task.title, split: true })}>阅读原文</Button>}
    </div>
  </div>)}{action.error && <div className="la-error">{action.error}</div>}</section>
}
