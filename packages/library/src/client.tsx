// library unit, browser half: the library page (sources, import, search, one chunk's source view).
import { useState, type ReactNode } from 'react'
import { Library } from 'lucide-react'
import type { CitedChunk, CourseSource, SearchHit, Source, LibraryImport } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell } from '@learning-agent/contracts/client'
import { useAction, useLoad } from '@learning-agent/kit/client'
import { Reader } from './client/reader.tsx'

export const name = 'learning-library'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'library', title: '资料库', icon: Library, scope: 'both', page: 'library.sources', order: 40 }), 'library: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'library.sources' }, LibraryPage)), 'library: page')
}

type SourceRow = { source: Source; chunks: number; role?: CourseSource['role'] }

const ROLE_LABEL: Record<CourseSource['role'], string> = { skeleton: '骨架教材', reference: '参考', 'exam-archive': '考试档案' }
const AUTHORITY_LABEL: Record<Source['authority'], string> = { '1': '一级', '2': '二级', '3': '三级', clue: '仅线索' }

function LibraryPage({ scope, params }: LearningPageProps): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const sources = useLoad(shell, () => shell.call<SourceRow[]>('library', 'sources', { courseId }), [courseId])
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
      <PdfImport courseId={courseId} />
      <ImportTasks />
      <Search courseId={courseId} />
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
      </div>
      <div className="la-muted la-small">{row.source.origin.kind === 'file' ? row.source.origin.fileName : row.source.origin.url} · 页码偏移 {row.source.pageOffset}</div>
      <div className="la-row"><button className="la-btn" onClick={() => shell.openPage('library.sources', { id: row.source.id, sourceId: row.source.id }, { title: row.source.title, split: true })}>阅读原文</button>
        <button className="la-btn" disabled={action.busy} onClick={() => void action.run(async () => { await shell.call('library', 'reparse', { sourceId: row.source.id, courseId }); onChange() })}>重新解析</button>
        {row.source.supersedes && <span className="la-tag">新解析版本</span>}
      </div>
      {courseId && (
        <div className="la-row">
          <button className="la-btn" disabled={action.busy || row.role === 'skeleton'} onClick={() => void attach('skeleton')}>设为本课骨架教材</button>
          <button className="la-btn" disabled={action.busy || row.role === 'reference'} onClick={() => void attach('reference')}>作为本课参考</button>
        </div>
      )}
      {action.error && <div className="la-error">{action.error}</div>}
    </div>
  )
}

function Search({ courseId }: { courseId?: string }): ReactNode {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>()
  const action = useAction()
  const search = () => action.run(async () => setHits(await shell.call<SearchHit[]>('library', 'search', { query, courseId, limit: 12 })))
  return (
    <section className="la-stack">
      <div className="la-row">
        <input className="la-input" style={{ flex: 1 }} placeholder="检索资料，例如：静力学 基本方程" value={query}
          onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void search() }} />
        <button className="la-btn la-btn-primary" disabled={!query.trim() || action.busy} onClick={() => void search()}>检索</button>
      </div>
      {action.error && <div className="la-error">{action.error}</div>}
      {hits?.length === 0 && <div className="la-muted">没有找到。</div>}
      {hits?.map(hit => <ChunkCard key={hit.chunk.id} chunk={hit.chunk} />)}
    </section>
  )
}

function ChunkCard({ chunk, active }: { chunk: CitedChunk; active?: boolean }): ReactNode {
  return (
    <div className={`la-card${active ? ' is-active' : ''}`}>
      <div className="la-row la-small la-muted">
        <span className="la-tag">{chunk.kind}</span>
        <span>{chunk.citation}</span>
        <span>{chunk.section.join(' › ')}</span>
      </div>
      <shell.Markdown text={chunk.text} />
      {(chunk.kind === 'formula' || chunk.text.includes('$')) && <div className="la-muted la-small">公式为识别结果，请对照原 PDF 核对符号和单位。</div>}
      {!active && <button className="la-btn" onClick={() => shell.openPage('library.sources', { id: chunk.id, chunkId: chunk.id }, { title: '出处', split: true })}>查看原文出处</button>}
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
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ title: '', file: '', parsed: '', pageOffset: '0', authority: '1' as Source['authority'], kind: 'textbook' as Source['kind'] })
  const [done, setDone] = useState<string>()
  const action = useAction()
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm(previous => ({ ...previous, [key]: event.target.value }))
  const submit = () => action.run(async () => {
    const source = await shell.call<Source>('library', 'import', {
      title: form.title,
      kind: form.kind,
      authority: form.authority,
      file: form.file.trim(),
      parsed: form.parsed.split('\n').map(line => line.trim()).filter(Boolean),
      pageOffset: Number(form.pageOffset) || 0,
      ...(courseId ? { courseId, role: 'skeleton' } : {}),
    })
    setDone(`已导入《${source.title}》`)
  })
  if (!open) return <div><button className="la-btn" onClick={() => setOpen(true)}>已有解析结果（高级导入）…</button></div>
  return (
    <section className="la-card la-stack">
      <div className="la-h2">导入已有 MinerU 解析结果</div>
      <label className="la-stack" style={{ gap: 2 }}>标题<input className="la-input" value={form.title} onChange={set('title')} placeholder="化工原理（第3版）" /></label>
      <label className="la-stack" style={{ gap: 2 }}>原文件路径<input className="la-input" value={form.file} onChange={set('file')} placeholder="D:\…\化工原理.pdf" /></label>
      <label className="la-stack" style={{ gap: 2 }}>解析结果（MinerU 的 JSON，每行一个）<textarea className="la-textarea" value={form.parsed} onChange={set('parsed')} /></label>
      <div className="la-row">
        <label>页码偏移（PDF 页 − 书上页码）<input className="la-input" style={{ width: 80 }} value={form.pageOffset} onChange={set('pageOffset')} /></label>
        <label>权威级别
          <select className="la-input" style={{ width: 100 }} value={form.authority} onChange={set('authority')}>
            {Object.entries(AUTHORITY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <div className="la-row">
        <button className="la-btn la-btn-primary" disabled={action.busy || !form.title || !form.file || !form.parsed} onClick={() => void submit()}>{action.busy ? '导入中…' : '导入'}</button>
        {courseId && <span className="la-muted la-small">导入后自动设为本课骨架教材</span>}
        {done && <span className="la-tag ok">{done}</span>}
      </div>
      {action.error && <div className="la-error">{action.error}</div>}
    </section>
  )
}

function PdfImport({ courseId }: { courseId?: string }): ReactNode {
  const [file, setFile] = useState<File>()
  const [title, setTitle] = useState('')
  const [authority, setAuthority] = useState<Source['authority']>('1')
  const [offset, setOffset] = useState('0')
  const [role, setRole] = useState<CourseSource['role']>('skeleton')
  const [progress, setProgress] = useState<number>()
  const [done, setDone] = useState('')
  const action = useAction()
  const choose = (picked?: File) => { setFile(picked); setTitle(picked?.name.replace(/\.pdf$/i, '') ?? ''); setDone('') }
  const upload = () => action.run(() => new Promise<void>((resolve, reject) => {
    if (!file) { reject(new Error('请选择 PDF')); return }
    const xhr = new XMLHttpRequest()
    const metadata = { title, fileName: file.name, authority, kind: 'textbook', pageOffset: Number(offset), ...(courseId ? { courseId, role } : {}) }
    xhr.open('POST', `/api/learning/library.upload?metadata=${encodeURIComponent(JSON.stringify(metadata))}`)
    xhr.setRequestHeader('Content-Type', 'application/pdf')
    xhr.upload.onprogress = event => { if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)) }
    xhr.onload = () => {
      setProgress(undefined)
      try {
        const result = JSON.parse(xhr.responseText)
        if (xhr.status >= 400) { reject(new Error(result.error ?? '上传失败')); return }
        setDone(result.status === 'ready' ? '已复用资料库中的相同 PDF' : 'PDF 已保存，可以关闭此页，解析会继续')
        setFile(undefined)
        resolve()
      } catch { reject(new Error('上传未收到有效回复，请查看导入任务后重试')) }
    }
    xhr.onerror = () => { setProgress(undefined); reject(new Error('上传连接中断，请查看导入任务后重试')) }
    xhr.send(file)
  }))
  return <section className="la-card la-stack" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!action.busy) choose(e.dataTransfer.files[0]) }}>
    <div className="la-h2">导入 PDF</div>
    <label className="la-stack">选择文件，也可以拖到这里<input type="file" accept="application/pdf,.pdf" disabled={action.busy} onChange={e => { choose(e.target.files?.[0]); e.target.value = '' }} /></label>
    {file && <>
      <div className="la-small la-muted">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB · 本地解析</div>
      <label>标题<input className="la-input" value={title} onChange={e => setTitle(e.target.value)} /></label>
      <div className="la-row"><label>页码偏移<input className="la-input" type="number" style={{ width: 80 }} value={offset} onChange={e => setOffset(e.target.value)} /></label>
        <label>权威级别<select className="la-input" value={authority} onChange={e => setAuthority(e.target.value as Source['authority'])}>{Object.entries(AUTHORITY_LABEL).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        {courseId && <label>加入本课作为<select className="la-input" value={role} onChange={e => setRole(e.target.value as CourseSource['role'])}>{Object.entries(ROLE_LABEL).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>}
      </div>
      <span className="la-small la-muted">书上页码 = PDF 页码 − 偏移。资料只有完整解析后才交给老师。</span>
      <div><button className="la-btn la-btn-primary" disabled={action.busy || !title.trim() || file.size > 200 * 1024 * 1024} onClick={() => void upload()}>{action.busy ? `上传中 ${progress ?? 0}%` : '上传并解析'}</button></div>
      {file.size > 200 * 1024 * 1024 && <div className="la-error">PDF 超过 200 MB，请先拆分。</div>}
    </>}
    {action.error && <div className="la-error">{action.error}</div>}{done && <div className="la-muted">{done}</div>}
  </section>
}

function ImportTasks(): ReactNode {
  const tasks = useLoad(shell, () => shell.call<LibraryImport[]>('library', 'imports'), [])
  const action = useAction()
  const change = (method: string, id: string) => action.run(async () => { await shell.call('library', method, { id }); tasks.reload() })
  const labels: Record<LibraryImport['status'], string> = { queued: '等待解析', parsing: '解析中', indexing: '建立索引', waiting: '等待恢复', ready: '可用', failed: '失败', canceled: '已取消' }
  if (!tasks.data?.length && !tasks.error) return null
  return <section className="la-stack"><div className="la-h2">导入任务</div>{tasks.error && <div className="la-error">{tasks.error}</div>}{tasks.data?.slice(0, 20).map(task => <div key={task.id} className="la-card la-stack" style={{ gap: 5 }}>
    <div className="la-row"><b>{task.title}</b><span className="la-tag">{labels[task.status]}</span><span className="la-small la-muted">{task.fileName}</span></div>
    <div className={task.status === 'failed' ? 'la-error' : 'la-muted'}>{task.message}</div>
    <div className="la-row">
      {['failed', 'waiting', 'canceled'].includes(task.status) && <button className="la-btn" disabled={action.busy} onClick={() => void change('retry', task.id)}>重试</button>}
      {['queued', 'parsing', 'indexing', 'waiting'].includes(task.status) && <button className="la-btn" disabled={action.busy} onClick={() => void change('cancel', task.id)}>取消</button>}
      {task.sourceId && <button className="la-btn" onClick={() => shell.openPage('library.sources', { id: task.sourceId, sourceId: task.sourceId }, { title: task.title, split: true })}>阅读原文</button>}
    </div>
  </div>)}{action.error && <div className="la-error">{action.error}</div>}</section>
}
