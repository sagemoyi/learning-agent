// library unit, browser half. In the main interface the library page is the warehouse every course draws on
// (import, parse, search, which courses use what); in a course the rail opens the 本课资料 panel (client/panel.tsx)
// and the page shows that course's sources by role. In its own tab: the original-PDF reader for one source, a page
// of it or one cited chunk, and figures cut out of a page (`learning.figure`).
import { useEffect, useState, type ReactNode } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { BookOpen, Ellipsis, ExternalLink, FileSearch, FileText, Globe, Import, Library, LogOut, Plus, RefreshCw, RotateCw, Search as SearchIcon, SearchX, Settings, Sparkles, Trash2, Upload, X } from 'lucide-react'
import type { ChunkKind, CitedChunk, CourseSource, IndexState, Retrieval, SiteRule, Source, LibraryImport } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell, SettingsAccess } from '@learning-agent/contracts/client'
import {
  Button, Callout, Disclosure, EmptyState, ErrorText, Field, FileDrop, Menu, NumberField, Page, PageHeader, Progress, SecretField, Section, Segmented, Select, SettingRow, Skeleton,
  Switch, Tag, TestButton, TextArea, TextField, useAction, useLoad, useSecrets, type MenuEntry,
} from '@learning-agent/kit/client'
import {
  AUTHORITY_LABEL, isWeb, openLesson, openSource, ROLE_HINT, ROLE_LABEL, ROLES, siteOf,
  type CourseRow, type LessonUse, type LibraryRow, type Services,
} from './client/common.ts'
import { Figure } from './client/figure.tsx'
import { CoursePanel, useSourceUses } from './client/panel.tsx'
import { Reader } from './client/reader.tsx'
import { PendingWeb, WebFinder } from './client/web.tsx'

export const name = 'learning-library'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  // The same button in both interfaces: the warehouse page in the main one, the 本课资料 panel in a course.
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'library', title: '资料库', icon: Library, scope: 'main', page: 'library.sources', order: 40 }), 'library: activity')
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'library', title: '本课资料', icon: Library, scope: 'course', page: 'library.sources', panel: 'library.course', order: 40 }), 'library: course activity')
  // Notes on a source's recognized text are drawn by the annotation unit in the reader; without it the slot stays empty.
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({
    name: 'learning.page',
    key: 'library.sources',
    children: { 'learning.source-notes': { kind: 'single', scope: 'root' } },
  }, LibraryPage)), 'library: page')
  ctx.effect(() => ctx.slots.inject('learning.panel', () => ctx.slots.register({ name: 'learning.panel', key: 'library.course' }, ({ scope }) => <CoursePanel scope={scope} shell={shell} openSettings={openSettings} />)), 'library: panel')
  ctx.effect(() => ctx.slots.inject('learning.settings.services', () => ctx.slots.register({ name: 'learning.settings.services', id: 'library', order: 10 }, LibraryServices)), 'library: settings')
  ctx.effect(() => ctx.slots.inject('learning.figure', () => ctx.slots.register({ name: 'learning.figure' }, ({ chunkId }: { chunkId: string }) => <Figure chunkId={chunkId} shell={shell} />)), 'library: figure')
}

/** The library's settings namespace (its profile entry id) and the secrets it reads. */
const SETTINGS = 'learning-library'
const MINERU_KEY = 'MINERU_API_KEY'
const VOYAGE_KEY = 'VOYAGEAI_API_KEY'
type SearchService = 'exa' | 'bocha' | 'tavily'
const SEARCH_SERVICES: { id: SearchService; name: string; key: string; hint: string }[] = [
  { id: 'exa', name: 'Exa', key: 'EXA_API_KEY', hint: '在 exa.ai 申请。实测找到的高校资料最多；每次搜索约 0.007 美元。' },
  { id: 'bocha', name: '博查', key: 'BOCHA_API_KEY', hint: '在 open.bochaai.com 申请。国内直连，中文网页多；每次 0.036 元。' },
  { id: 'tavily', name: 'Tavily', key: 'TAVILY_API_KEY', hint: '在 tavily.com 申请。每月 1000 次免费，结果偏百科和企业网站。' },
]
const LOCAL_PARSER_URL = 'http://127.0.0.1:16580'
/** Above this many sources the warehouse list gets a filter field. */
const FILTER_FROM = 8

function openSettings(): void {
  shell.openPage('settings.home', { section: 'services' }, { title: '设置' })
}

const CHUNK_KIND: Record<ChunkKind, string> = { heading: '标题', text: '正文', formula: '公式', table: '表格', figure: '图', example: '例题', exercise: '习题', answer: '答案' }

function openChunk(chunkId: string): void {
  shell.openPage('library.sources', { chunkId }, { title: '出处', side: true })
}

type SourceNotes = PropsRenderSlots<'learning.source-notes'>['renderSlot']

function LibraryPage({ scope, params, renderSlot }: LearningPageProps & PropsRenderSlots<'learning.source-notes'>): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const chunkId = typeof params.chunkId === 'string' ? params.chunkId : undefined
  const sourceId = typeof params.sourceId === 'string' ? params.sourceId : undefined
  const at = typeof params.page === 'number' ? params.page : undefined
  if (chunkId) return <ChunkView chunkId={chunkId} courseId={courseId} renderSlot={renderSlot} />
  if (sourceId) return <Reader sourceId={sourceId} at={at} shell={shell} courseId={courseId} renderSlot={renderSlot} />
  return courseId ? <CourseSources courseId={courseId} importing={params.import === true} /> : <Warehouse />
}

/** Sources whose title has every word of the filter. */
function matching<T extends { source: Source }>(rows: readonly T[], filter: string): T[] {
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter(row => words.every(word => row.source.title.toLowerCase().includes(word)))
}

/** The main interface's library: every source, where it is used, import and search across all of them. */
function Warehouse(): ReactNode {
  const sources = useLoad(shell, () => shell.call<LibraryRow[]>('library', 'sources', {}), [])
  const services = useLoad(shell, () => shell.call<Services>('library', 'services'), [])
  const [importing, setImporting] = useState(false)
  const [history, setHistory] = useState(false)
  const [filter, setFilter] = useState('')
  const rows = sources.data ?? []
  const empty = sources.data !== undefined && rows.length === 0
  const shown = matching(rows, filter)
  const uploaded = shown.filter(row => !isWeb(row.source))
  const web = shown.filter(row => isWeb(row.source))
  const card = (row: LibraryRow) => (
    <SourceCard key={row.source.id} row={row} onChange={sources.reload}>
      <div className="la-source-uses">
        {row.courses.length
          ? <><span>用在：</span>{row.courses.map(course => <span key={course.id}>{course.title}<span className="la-faint"> · {ROLE_LABEL[course.role]}</span></span>)}</>
          : <span className="la-faint">还没有课程用到</span>}
      </div>
    </SourceCard>
  )
  return (
    <Page>
      <PageHeader eyebrow={<><Library size={14} strokeWidth={1.75} />资料库</>} title="资料库"
        description="所有课程共用的资料，每份只存一份。在课程的“本课资料”里把它加入课程，当骨架教材或参考资料。"
        actions={!empty && <Button variant={importing ? 'default' : 'primary'} icon={importing ? X : Upload} onClick={() => setImporting(!importing)}>{importing ? '收起导入' : '导入 PDF'}</Button>} />
      <div className="la-stack" style={{ gap: 28 }}>
        {(importing || empty) && <PdfImport services={services.data} onDone={() => setImporting(false)} />}
        <ImportTasks history={history} />
        {!empty && <LibrarySearch services={services.data} />}
        <Section title="上传的资料" icon={BookOpen} count={sources.data ? uploaded.length : undefined}
          actions={!empty && <>
            {rows.length > FILTER_FROM && <TextField icon={SearchIcon} width={180} aria-label="按标题筛选资料" value={filter} onChange={setFilter} placeholder="按标题筛选" />}
            <Button size="sm" variant="quiet" onClick={() => setHistory(!history)}>{history ? '收起导入记录' : '导入记录'}</Button>
          </>}>
          <ErrorText error={sources.error} />
          {!sources.data && sources.loading && <Skeleton lines={3} />}
          {empty && <span className="la-faint">还没有资料。导入一本 PDF 教材开始。</span>}
          {!empty && sources.data && uploaded.length === 0 && <span className="la-faint">{filter ? '没有标题里有这些字的资料。' : '还没有上传的资料。'}</span>}
          <div className="la-stack" style={{ gap: 10 }}>{uploaded.map(card)}</div>
        </Section>
        {web.length > 0 && (
          <Section title="网上找到的资料" icon={Globe} count={web.length} description="老师或你在课程里联网找到、加入的网页和 PDF，存的是当时保存下来的正文。">
            <div className="la-stack" style={{ gap: 10 }}>{web.map(card)}</div>
          </Section>
        )}
        <ImportForm />
      </div>
    </Page>
  )
}

/** A course's sources by role, with what they are cited in; adding from the library replaces an import form. */
function CourseSources({ courseId, importing: importFirst }: { courseId: string; importing: boolean }): ReactNode {
  const sources = useLoad(shell, () => shell.call<CourseRow[]>('library', 'sources', { courseId }), [courseId])
  const services = useLoad(shell, () => shell.call<Services>('library', 'services'), [])
  const uses = useSourceUses(shell, courseId)
  const [adding, setAdding] = useState(importFirst)
  const rows = sources.data ?? []
  const empty = sources.data !== undefined && rows.length === 0
  const groups = [
    ...ROLES.map(role => ({ key: role, title: ROLE_LABEL[role], icon: role === 'skeleton' ? BookOpen : FileText, rows: rows.filter(row => !isWeb(row.source) && row.role === role) })),
    { key: 'web', title: '网上资料', icon: Globe, rows: rows.filter(row => isWeb(row.source)) },
  ].filter(group => group.rows.length > 0)
  return (
    <Page>
      <PageHeader eyebrow={<><Library size={14} strokeWidth={1.75} />本课资料</>} title="本课资料"
        description="这门课用到的资料：教材、题目和老师的回答都以它们为依据。资料存在资料库里，从这里移出不会删掉，已有的出处仍能打开。"
        actions={<Button variant={adding ? 'default' : 'primary'} icon={adding ? X : Plus} onClick={() => setAdding(!adding)}>{adding ? '收起' : '从资料库加入'}</Button>} />
      <div className="la-stack" style={{ gap: 28 }}>
        {adding && <AddSources courseId={courseId} services={services.data} importFirst={importFirst} onAdded={sources.reload} />}
        <PendingWeb courseId={courseId} shell={shell} />
        <ImportTasks courseId={courseId} history={false} />
        {!empty && <LibrarySearch courseId={courseId} services={services.data} />}
        <ErrorText error={sources.error} />
        {!sources.data && sources.loading && <Skeleton lines={3} />}
        {empty && !adding && (
          <div className="la-card"><EmptyState icon={BookOpen} title="本课还没有资料" description="从资料库加入一本教材当骨架教材，主老师就能按它排课、写教材。"
            action={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>从资料库加入</Button>} /></div>
        )}
        {groups.map(group => (
          <Section key={group.key} title={group.title} icon={group.icon} count={group.rows.length}>
            <div className="la-stack" style={{ gap: 10 }}>
              {group.rows.map(row => (
                <SourceCard key={row.source.id} row={row} courseId={courseId} onChange={sources.reload} entries={courseEntries(courseId, row, sources.reload)}>
                  <LessonLinks lessons={uses.data?.get(row.source.id) ?? []} />
                </SourceCard>
              ))}
            </div>
          </Section>
        ))}
        <WebFinder courseId={courseId} providers={services.data?.webSearch} shell={shell} openSettings={openSettings} />
      </div>
    </Page>
  )
}

/** What a course's card menu adds: the role in this course (not for web material) and taking it out of the course. */
function courseEntries(courseId: string, row: CourseRow, onChange: () => void): (run: (work: () => Promise<unknown>) => void) => MenuEntry[] {
  return run => [
    ...(isWeb(row.source) ? [] : [
      { heading: '在本课中当' } as const,
      ...ROLES.map(role => ({ key: role, label: ROLE_LABEL[role], hint: ROLE_HINT[role], checked: row.role === role, onSelect: () => run(() => shell.call('library', 'attach', { courseId, sourceId: row.source.id, role })) })),
    ]),
    { key: 'detach', label: '移出本课', icon: LogOut, hint: '不删资料，出处照常能打开', onSelect: () => run(async () => { await shell.call('library', 'detach', { courseId, sourceId: row.source.id }); onChange() }) },
    'divider',
  ]
}

const LESSON_LINKS = 8

function LessonLinks({ lessons }: { lessons: readonly LessonUse[] }): ReactNode {
  if (lessons.length === 0) return <div className="la-source-uses la-faint">教材还没有引用它</div>
  return (
    <div className="la-source-uses">
      <span>引用它的课时：</span>
      {lessons.slice(0, LESSON_LINKS).map(lesson => (
        <button key={lesson.id} type="button" className="la-link" data-la-opens="" onClick={() => openLesson(shell, lesson)}>{lesson.number} {lesson.title}</button>
      ))}
      {lessons.length > LESSON_LINKS && <span className="la-faint">等 {lessons.length} 节</span>}
    </div>
  )
}

/** The library's sources this course does not use yet, each added in a role; a new PDF is imported straight in. */
function AddSources({ courseId, services, importFirst, onAdded }: { courseId: string; services?: Services; importFirst: boolean; onAdded(): void }): ReactNode {
  const all = useLoad(shell, () => shell.call<LibraryRow[]>('library', 'sources', {}), [])
  const [filter, setFilter] = useState('')
  const [importing, setImporting] = useState(importFirst)
  const action = useAction()
  const others = (all.data ?? []).filter(row => !row.courses.some(course => course.id === courseId))
  const shown = matching(others, filter)
  const add = (row: LibraryRow, role: CourseSource['role']) => void action.run(async () => {
    await shell.call('library', 'attach', { courseId, sourceId: row.source.id, role })
    all.reload()
    onAdded()
  })
  return (
    <>
      <Section title="从资料库加入" icon={Library} card description="资料库里还没加入本课的资料。加入时选它在本课当什么；主老师会收到通知。"
        actions={others.length > FILTER_FROM && <TextField icon={SearchIcon} width={180} aria-label="按标题筛选资料" value={filter} onChange={setFilter} placeholder="按标题筛选" />}>
        {!all.data && all.loading && <Skeleton lines={2} />}
        {all.data && others.length === 0 && <p className="la-faint" style={{ margin: 0 }}>资料库里的资料都已经在本课了。</p>}
        <div className="la-rows">
          {shown.map(row => {
            const web = isWeb(row.source)
            const Icon = web ? Globe : FileText
            return (
              <div key={row.source.id} className="la-row-item">
                <span className="la-row-icon accent"><Icon size={16} strokeWidth={1.75} /></span>
                <div className="la-row-main">
                  <span className="la-row-title">{row.source.title}</span>
                  <span className="la-row-sub">
                    {web ? `${AUTHORITY_LABEL[row.source.authority]} · ${siteOf(row.source)}` : row.source.pages ? `${row.source.pages} 页` : '上传的资料'}
                    {row.courses.length ? ` · 用在${row.courses.map(course => `“${course.title}”`).join('、')}` : ''}
                  </span>
                </div>
                <div className="la-row-end">
                  <Menu align="end" width={230} entries={(web ? ['reference' as const] : ROLES).map(role => ({ key: role, label: `当${ROLE_LABEL[role]}`, hint: ROLE_HINT[role], onSelect: () => add(row, role) }))}
                    trigger={props => <Button size="sm" icon={Plus} disabled={action.busy} {...props}>加入本课</Button>} />
                </div>
              </div>
            )
          })}
          {others.length > 0 && shown.length === 0 && <p className="la-faint" style={{ margin: 0 }}>没有标题里有这些字的资料。</p>}
        </div>
        <div className="la-row" style={{ marginTop: 12 }}>
          <Button size="sm" variant={importing ? 'default' : 'quiet'} icon={importing ? X : Upload} onClick={() => setImporting(!importing)}>{importing ? '收起导入' : '资料库里没有？导入新的 PDF'}</Button>
        </div>
        <ErrorText error={action.error ?? all.error} />
      </Section>
      {importing && <PdfImport courseId={courseId} services={services} onDone={() => setImporting(false)} />}
    </>
  )
}

/**
 * One source as a card: what it is, its parse and index state, `children` (where it is used), and a menu that holds
 * `entries` (the course's role and removal) before re-parsing and re-indexing.
 */
function SourceCard({ row, courseId, onChange, entries, children }: {
  row: { source: Source; chunks: number; index?: IndexState }
  courseId?: string
  onChange(): void
  entries?: (run: (work: () => Promise<unknown>) => void) => MenuEntry[]
  children?: ReactNode
}): ReactNode {
  const action = useAction()
  const [confirming, setConfirming] = useState(false)
  const { source } = row
  const web = source.origin.kind === 'web' ? source.origin : undefined
  const isPdf = web ? web.format === 'pdf' : source.origin.kind === 'file' && /\.pdf$/i.test(source.origin.fileName)
  const run = (work: () => Promise<unknown>) => action.run(async () => { await work(); onChange() })
  const menu: MenuEntry[] = [
    ...(entries?.(work => void run(work)) ?? []),
    ...(isPdf ? [{ key: 'reparse', label: '重新解析…', icon: RefreshCw, hint: '生成新版本，原出处保留', onSelect: () => setConfirming(true) }] : []),
    ...(row.index?.state === 'failed' ? [{ key: 'reindex', label: '重建语义索引', icon: RotateCw, onSelect: () => void run(() => shell.call('library', 'reindex', { sourceId: source.id })) }] : []),
  ]
  while (menu.at(-1) === 'divider') menu.pop()
  return (
    <div className="la-card la-source">
      <span className="la-row-icon accent la-source-icon">{web ? <Globe size={18} strokeWidth={1.75} /> : <FileText size={18} strokeWidth={1.75} />}</span>
      <div className="la-source-body">
        <div className="la-source-title">{source.title}</div>
        <div className="la-source-meta">
          <Tag>{AUTHORITY_LABEL[source.authority]}</Tag>
          <span className="la-num">{row.chunks} 个片段</span>
          {!web && source.pages ? <span className="la-num">· {source.pages} 页</span> : null}
          <IndexInfo state={row.index} />
          {web && <span>· 网上{web.format === 'pdf' ? ' PDF' : '网页'}，保存于 {web.fetchedAt.slice(0, 10)}</span>}
          {source.parser?.name === 'exa-contents' && <span>· 正文来自 Exa 的副本</span>}
          {!web && source.parser?.where === 'cloud' && <span>· 云端解析</span>}
          {source.supersedes && <span>· 新解析版本</span>}
        </div>
        <div className="la-faint la-small la-ellipsis">
          {web ? <a className="la-web-link" href={web.url} target="_blank" rel="noreferrer noopener">{web.url}<ExternalLink size={12} strokeWidth={1.75} /></a> : source.origin.kind === 'file' && source.origin.fileName}
          {source.pageOffset ? ` · 页码偏移 ${source.pageOffset}` : ''}
        </div>
        {children}
        {row.index?.state === 'failed' && <Callout tone="bad">语义索引失败：{row.index.message}</Callout>}
        {confirming && (
          <Callout tone="warn" title="重新解析这份资料？" actions={<>
            <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>取消</Button>
            <Button size="sm" variant="primary" icon={RefreshCw} loading={action.busy} onClick={() => { setConfirming(false); void run(() => shell.call('library', 'reparse', { sourceId: source.id, courseId })) }}>重新解析</Button>
          </>}>会生成新的解析版本，用到它的课程都改用新版本；原来的出处和原件仍可打开。</Callout>
        )}
        <ErrorText error={action.error} />
      </div>
      <div className="la-source-actions">
        <Button size="sm" icon={BookOpen} opens onClick={() => openSource(shell, source)}>阅读原文</Button>
        {/* Cards without a menu keep its slot, so "阅读原文" lines up down the list. */}
        {menu.length > 0
          ? <Menu align="end" width={230} entries={menu} trigger={props => <Button size="sm" variant="quiet" icon={Ellipsis} aria-label="更多操作" title="更多操作" disabled={action.busy} {...props} />} />
          : <span className="la-icon-slot" aria-hidden="true" />}
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
    <Section title={courseId ? '检索本课资料' : '检索'} icon={SearchIcon}>
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
        <Button size="sm" icon={FileSearch} opens onClick={() => openChunk(chunk.id)}>查看原文</Button>
        {(chunk.kind === 'formula' || chunk.text.includes('$')) && <span className="la-faint la-small">公式为识别结果，请对照原 PDF 核对符号和单位。</span>}
      </div>
    </div>
  )
}

function ChunkView({ chunkId, courseId, renderSlot }: { chunkId: string; courseId?: string; renderSlot: SourceNotes }): ReactNode {
  const chunk = useLoad(shell, () => shell.call<CitedChunk | null>('library', 'chunk', { chunkId }), [chunkId])
  if (chunk.error) return <Page><ErrorText error={chunk.error} /></Page>
  if (!chunk.data) return <Page>{chunk.loading ? <Skeleton lines={4} /> : <EmptyState icon={SearchX} title="找不到这个出处" description="资料可能已经重新解析或被移除。" />}</Page>
  return <Reader sourceId={chunk.data.sourceId} chunk={chunk.data} shell={shell} courseId={courseId} renderSlot={renderSlot} />
}

/** Sources parsed elsewhere (MinerU output on disk), in the warehouse only. */
function ImportForm(): ReactNode {
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
          {done && <Tag tone="ok">{done}</Tag>}
        </div>
        <ErrorText error={action.error} />
      </div>
    </Disclosure>
  )
}

const MAX_PDF = 200 * 1024 * 1024
const AUTHORITY_CHOICES = Object.entries(AUTHORITY_LABEL).map(([value, label]) => ({ value: value as Source['authority'], label }))
const ROLE_CHOICES = ROLES.map(role => ({ value: role, label: ROLE_LABEL[role] }))

/** Upload a PDF to the library; in a course it joins the course in the chosen role. */
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
        {services && !services.parserReady && (
          <Callout tone="warn" title="云端解析还缺 MinerU 密钥" actions={<Button size="sm" icon={Settings} onClick={openSettings}>去设置</Button>}>
            现在上传的 PDF 会先保存下来，填好密钥后在导入任务里点重试；也可以在设置里改用本机解析。
          </Callout>
        )}
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

/** Imports that need attention (running, waiting, failed); with `history`, finished ones too; with `courseId`, that course's. */
function ImportTasks({ history, courseId }: { history: boolean; courseId?: string }): ReactNode {
  const tasks = useLoad(shell, () => shell.call<LibraryImport[]>('library', 'imports'), [])
  const action = useAction()
  const change = (method: string, id: string) => action.run(async () => { await shell.call('library', method, { id }); tasks.reload() })
  // Finished imports already appear under "资料"; only unfinished, failed and canceled ones need attention here.
  const shown = (tasks.data ?? []).filter(task => (history || task.status !== 'ready') && (!courseId || task.courseId === courseId)).slice(0, 20)
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
                {task.sourceId && <Button size="sm" variant="quiet" icon={BookOpen} opens onClick={() => shell.openPage('library.sources', { sourceId: task.sourceId }, { title: task.title })}>阅读</Button>}
              </div>
            </div>
          )
        })}
      </div>
      <ErrorText error={action.error} />
    </Section>
  )
}

/** A service check for 测试连接, which shows the time it took. */
function testService(service: 'parser' | 'embeddings' | SearchService) {
  return async () => (await shell.call<{ ms: number }>('library', 'testService', { service })).ms
}

/**
 * The library's block on the settings page (资料服务): how PDFs are parsed and whether retrieval is
 * semantic, with the keys each needs. Defaults are saved as "no setting", so later default changes apply.
 */
function LibraryServices({ access }: { access: SettingsAccess }): ReactNode {
  const values = access.values(SETTINGS)
  const secrets = useSecrets(access, [MINERU_KEY, VOYAGE_KEY, ...SEARCH_SERVICES.map(service => service.key)])
  const action = useAction()
  const savedUrl = typeof values?.localParserUrl === 'string' ? values.localParserUrl : LOCAL_PARSER_URL
  const [url, setUrl] = useState(savedUrl)
  useEffect(() => setUrl(savedUrl), [savedUrl])
  if (!values) return <Skeleton lines={4} />
  const cloud = values.parser !== 'local'
  const semantic = values.semanticSearch !== false
  const set = (key: string, value: unknown, fallback: unknown) => action.run(() => access.set(SETTINGS, key, value === fallback ? undefined : value))
  return (
    <>
      <Section title="资料解析" icon={FileText} description="导入 PDF 时，把它读成能检索、能引用到页的文字。改了之后下一次导入就用新的方式。">
        <div className="la-settings-card">
          <SettingRow title="解析方式" hint={cloud ? 'PDF 会上传到 MinerU 云端，几百页的书几分钟完成。' : 'PDF 不离开这台电脑；要先在本机启动 MinerU 服务，整本书要几十分钟。'}>
            <Segmented value={cloud ? 'cloud' : 'local'} aria-label="解析方式" disabled={action.busy}
              options={[{ value: 'cloud', label: 'MinerU 云端' }, { value: 'local', label: '本机' }]} onChange={value => set('parser', value, 'cloud')} />
          </SettingRow>
          {cloud ? (
            <SettingRow title="MinerU 密钥" hint="在 mineru.net 的 API 管理页申请。">
              <SecretField state={secrets?.[MINERU_KEY]} onSave={value => access.saveSecret(MINERU_KEY, value)} onClear={() => access.clearSecret(MINERU_KEY)} />
              <TestButton run={testService('parser')} disabled={!secrets?.[MINERU_KEY]?.configured} />
            </SettingRow>
          ) : (
            <SettingRow title="本机服务地址" hint="只接受这台电脑上的地址。">
              <div className="la-row nowrap">
                <TextField value={url} onChange={setUrl} width={240} aria-label="本机服务地址" />
                <Button size="sm" variant="primary" disabled={url.trim() === savedUrl || !url.trim()} loading={action.busy} onClick={() => set('localParserUrl', url.trim(), LOCAL_PARSER_URL)}>保存</Button>
              </div>
              <TestButton run={testService('parser')} />
            </SettingRow>
          )}
        </div>
      </Section>
      <Section title="语义检索" icon={Sparkles} description="按意思找资料：换一种说法也能找到，资料里没有时会明确说没有。关掉后只按关键词检索。">
        <div className="la-settings-card">
          <SettingRow title="按意思检索" hint="资料片段和检索时输入的问题会发送到 Voyage AI。">
            <Switch checked={semantic} busy={action.busy} aria-label="按意思检索" onChange={checked => set('semanticSearch', checked, true)} />
          </SettingRow>
          {semantic && (
            <SettingRow title="Voyage 密钥" hint="在 voyageai.com 申请。保存后已导入的资料会在后台补建语义索引。">
              <SecretField state={secrets?.[VOYAGE_KEY]} onSave={value => access.saveSecret(VOYAGE_KEY, value)} onClear={() => access.clearSecret(VOYAGE_KEY)} />
              <TestButton run={testService('embeddings')} disabled={!secrets?.[VOYAGE_KEY]?.configured} />
            </SettingRow>
          )}
        </div>
      </Section>
      <Section title="联网搜索" icon={Globe} description="资料库不够时，老师（或你在资料库页）到网上找权威资料。只把要找的主题发给搜索服务，不发你的资料和学习记录。">
        <div className="la-settings-card">
          <SettingRow title="首选搜索服务" hint="先用它搜；它出错或没有密钥时，自动换下一家（Exa、博查、Tavily 的顺序）。">
            <Select<SearchService> aria-label="首选搜索服务" width={160} disabled={action.busy} value={(values.searchProvider as SearchService | undefined) ?? 'exa'}
              options={SEARCH_SERVICES.map(service => ({ value: service.id, label: service.name }))} onChange={value => set('searchProvider', value, 'exa')} />
          </SettingRow>
          {SEARCH_SERVICES.map(service => (
            <SettingRow key={service.id} title={`${service.name}${/^[A-Za-z]/.test(service.name) ? ' ' : ''}密钥`} hint={service.hint}>
              <SecretField state={secrets?.[service.key]} onSave={value => access.saveSecret(service.key, value)} onClear={() => access.clearSecret(service.key)} />
              <TestButton run={testService(service.id)} disabled={!secrets?.[service.key]?.configured} />
            </SettingRow>
          ))}
        </div>
      </Section>
      <SiteRules />
      <ErrorText error={action.error} />
    </>
  )
}

const RULE_CHOICES: { value: SiteRule['authority']; label: string }[] = [
  { value: '1', label: '一级' }, { value: '2', label: '二级' }, { value: '3', label: '三级' }, { value: 'clue', label: '只当线索' }, { value: 'blocked', label: '排除' },
]
const RULE_LABEL = Object.fromEntries(RULE_CHOICES.map(choice => [choice.value, choice.label])) as Record<SiteRule['authority'], string>

/** The learner's own site levels, which override the built-in ones. */
function SiteRules(): ReactNode {
  const rules = useLoad(shell, () => shell.call<SiteRule[]>('library', 'siteRules'), [])
  const [host, setHost] = useState('')
  const [level, setLevel] = useState<SiteRule['authority']>('2')
  const action = useAction()
  const save = (site: string, authority?: SiteRule['authority']) => action.run(async () => { await shell.call('library', 'setSiteRule', { host: site, authority }); setHost(''); rules.reload() })
  return (
    <Section title="网站级别" icon={Globe} description="网上资料的级别按网站判断：国内高校（edu.cn）、政府和标准、出版社、国家级课程平台是二级；国外高校、开放课程和论文是三级；百科、文库、问答，以及不在清单里的网站只当线索。你在这里设的优先。">
      <div className="la-settings-card">
        {(rules.data ?? []).map(rule => (
          <SettingRow key={rule.host} title={rule.host}>
            <Tag tone={rule.authority === 'blocked' ? 'bad' : rule.authority === 'clue' ? 'neutral' : 'accent'}>{RULE_LABEL[rule.authority]}</Tag>
            <Button size="sm" variant="quiet" icon={Trash2} aria-label={`删除 ${rule.host} 的规则`} title="删除这条规则" disabled={action.busy} onClick={() => void save(rule.host)} />
          </SettingRow>
        ))}
        <SettingRow title="添加网站" hint="写域名，例如你们学校的 xxx.edu.cn 设为一级；子域名一起生效。">
          <div className="la-row">
            <TextField aria-label="网站域名" width={200} value={host} onChange={setHost} placeholder="例如 hg.kmust.edu.cn" onEnter={() => { if (host.trim()) void save(host.trim(), level) }} />
            <Select<SiteRule['authority']> aria-label="网站级别" width={110} value={level} options={RULE_CHOICES} onChange={setLevel} />
            <Button size="sm" variant="primary" disabled={!host.trim()} loading={action.busy} onClick={() => void save(host.trim(), level)}>添加</Button>
          </div>
        </SettingRow>
      </div>
      <ErrorText error={rules.error ?? action.error} />
    </Section>
  )
}
