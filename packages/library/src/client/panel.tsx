// The 本课资料 panel (`learning.panel` key `library.course`): the course's sources by role, each with the lessons
// citing it and, for a book, its chapter outline; sources the teacher found wait on top. Adding from the library and
// searching the web open in place, above the list. A source or chapter opens in the current tab.
import { Fragment, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import { BookOpen, ChevronRight, ExternalLink, FileText, Globe, LogOut, Plus, Search as SearchIcon, Upload } from 'lucide-react'
import type { CourseSource, Source } from '@learning-agent/contracts'
import type { LearnShell, ShellScope } from '@learning-agent/contracts/client'
import { ContextMenu, ErrorText, Skeleton, TextField, useAction, useLoad, useLocalState, type MenuEntry } from '@learning-agent/kit/client'
import {
  AUTHORITY_LABEL, isWeb, openSource, printedPage, ROLE_HINT, ROLE_LABEL, ROLES, siteOf, usesText,
  type CourseRow, type LessonUse, type LibraryRow, type Services,
} from './common.ts'
import { outlineTree, type OutlineNode } from './outline.ts'
import { PendingCompact, WebFinderCompact } from './web.tsx'

const ICON = { size: 14, strokeWidth: 1.75 } as const
/** Above this many sources the picker gets a filter field. */
const FILTER_FROM = 6

type Point = { readonly x: number; readonly y: number }

/** The lessons citing each source of a course, by source id; empty without the textbook unit. */
export function useSourceUses(shell: LearnShell, courseId: string | undefined) {
  return useLoad(shell, async () => {
    if (!courseId) return new Map<string, LessonUse[]>()
    const uses = await shell.call<{ sourceId: string; lessons: LessonUse[] }[]>('textbook', 'sourceUses', { courseId }).catch(() => [])
    return new Map(uses.map(use => [use.sourceId, use.lessons]))
  }, [courseId])
}

export function CoursePanel({ scope, shell, openSettings }: { scope: ShellScope; shell: LearnShell; openSettings(): void }): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const rows = useLoad(shell, async () => (courseId ? shell.call<CourseRow[]>('library', 'sources', { courseId }) : []), [courseId])
  const uses = useSourceUses(shell, courseId)
  const active = useSyncExternalStore(listener => shell.onActivePage(listener), () => shell.activePage())
  const showing = active?.page === 'library.sources' && typeof active.params.sourceId === 'string' ? active.params.sourceId : undefined
  const [tool, setTool] = useState<'add' | 'web'>()
  // Keys whose fold differs from the default (a skeleton textbook starts open, everything else closed).
  const [toggled, setToggled] = useLocalState<string[]>(`library:outline:${courseId ?? ''}`, [])
  const [menu, setMenu] = useState<{ row: CourseRow; at: Point }>()
  const action = useAction()
  if (!courseId) return null
  const list = rows.data ?? []
  const toggle = (key: string) => setToggled(toggled.includes(key) ? toggled.filter(item => item !== key) : [...toggled, key])
  const isOpen = (key: string, byDefault: boolean) => toggled.includes(key) !== byDefault
  const change = (work: () => Promise<unknown>) => void action.run(async () => { await work(); rows.reload() })
  const groups = [
    ...ROLES.map(role => ({ key: role, title: ROLE_LABEL[role], rows: list.filter(row => !isWeb(row.source) && row.role === role) })),
    { key: 'web', title: '网上资料', rows: list.filter(row => isWeb(row.source)) },
  ].filter(group => group.rows.length > 0)

  const menuEntries = (row: CourseRow): MenuEntry[] => [
    ...(isWeb(row.source) ? [] : [
      { heading: '在本课中当' } as const,
      ...ROLES.map(role => ({ key: role, label: ROLE_LABEL[role], hint: ROLE_HINT[role], checked: row.role === role,
        onSelect: () => change(() => shell.call('library', 'attach', { courseId, sourceId: row.source.id, role })) })),
      'divider' as const,
    ]),
    { key: 'tab', label: '在新标签打开', icon: ExternalLink, onSelect: () => shell.openPage('library.sources', { sourceId: row.source.id }, { title: row.source.title, newTab: true }) },
    { key: 'detach', label: '移出本课', icon: LogOut, hint: '不删资料，出处照常能打开', onSelect: () => change(() => shell.call('library', 'detach', { courseId, sourceId: row.source.id })) },
  ]

  return (
    <>
      <div className="la-lib-tools" role="toolbar" aria-label="本课资料">
        <button type="button" className="la-lib-tool-btn" aria-pressed={tool === 'add'} onClick={() => setTool(tool === 'add' ? undefined : 'add')}><Plus {...ICON} />从资料库加入</button>
        <button type="button" className="la-lib-tool-btn" aria-pressed={tool === 'web'} onClick={() => setTool(tool === 'web' ? undefined : 'web')}><Globe {...ICON} />联网找</button>
      </div>
      {tool === 'add' && <AddFromLibrary courseId={courseId} shell={shell} onAdded={rows.reload} />}
      {tool === 'web' && <WebTool courseId={courseId} shell={shell} openSettings={openSettings} />}
      <ErrorText error={action.error ?? rows.error} />
      <PendingCompact courseId={courseId} shell={shell} onChange={rows.reload} />
      {!rows.data && rows.loading && <Skeleton lines={3} />}
      {rows.data && list.length === 0 && <div className="la-side-empty">本课还没有资料。点上面的"从资料库加入"，把教材加进来当骨架教材。</div>}
      {groups.map(group => (
        <div key={group.key} className="la-side-section">
          <div className="la-side-heading"><span>{group.title}{group.rows.length > 1 ? ` · ${group.rows.length}` : ''}</span></div>
          <div className="la-tree">
            {group.rows.map(row => {
              const tree = row.outline?.length ? outlineTree(row.outline) : []
              const key = `s:${row.source.id}`
              return (
                <SourceItem key={row.source.id} row={row} tree={tree} lessons={uses.data?.get(row.source.id) ?? []} shell={shell}
                  open={tree.length > 0 && isOpen(key, row.role === 'skeleton')} onToggle={() => toggle(key)} showing={showing === row.source.id}
                  isOpen={(node, byDefault) => isOpen(`${row.source.id}:${node.key}`, byDefault)} onToggleNode={node => toggle(`${row.source.id}:${node.key}`)}
                  onMenu={at => setMenu({ row, at })} />
              )
            })}
          </div>
        </div>
      ))}
      <div className="la-side-foot">
        <button type="button" className="la-link" data-la-opens="" onClick={() => shell.openPage('library.sources', {})}>本课资料全页<ChevronRight size={13} strokeWidth={1.75} /></button>
      </div>
      {menu && <ContextMenu entries={menuEntries(menu.row)} at={menu.at} width={220} onClose={() => setMenu(undefined)} />}
    </>
  )
}

function SourceItem({ row, tree, lessons, shell, open, onToggle, showing, isOpen, onToggleNode, onMenu }: {
  row: CourseRow
  tree: readonly OutlineNode[]
  lessons: readonly LessonUse[]
  shell: LearnShell
  open: boolean
  onToggle(): void
  showing: boolean
  isOpen(node: OutlineNode, byDefault: boolean): boolean
  onToggleNode(node: OutlineNode): void
  onMenu(at: Point): void
}): ReactNode {
  const { source } = row
  const web = isWeb(source)
  const Icon = web ? Globe : row.role === 'skeleton' ? BookOpen : FileText
  const cited = usesText(lessons)
  // A page kept under its address as the title names the kind of page instead of the address again.
  const where = source.title === siteOf(source) ? (source.origin.kind === 'web' && source.origin.format === 'pdf' ? '网上 PDF' : '网页') : siteOf(source)
  const sub = web ? `${AUTHORITY_LABEL[source.authority]} · ${cited || where}` : cited || '教材还没引用'
  const context = (event: MouseEvent) => { event.preventDefault(); onMenu({ x: event.clientX, y: event.clientY }) }
  return (
    <div className="la-tree-group">
      <div className="la-lib-row">
        <Chevron shown={tree.length > 0} open={open} label={source.title} onToggle={onToggle} />
        <button type="button" className={`la-tree-item two-line${showing ? ' is-active' : ''}`} data-la-opens="" data-source={source.id}
          title={`${source.title}${lessons.length ? `\n${lessons.map(lesson => `${lesson.number} ${lesson.title}`).join('\n')}` : ''}\n右键：改当什么、移出本课`}
          onClick={() => openSource(shell, source)} onContextMenu={context}>
          <Icon {...ICON} />
          <span className="la-tree-lines">
            <span className="la-tree-title">{source.title}</span>
            <span className="la-tree-sub">{sub}</span>
          </span>
        </button>
      </div>
      {open && <OutlineItems source={source} nodes={tree} shell={shell} isOpen={isOpen} onToggle={onToggleNode} />}
    </div>
  )
}

/** A level of the outline; a heading that is alone on its level starts open, so a one-chapter book shows its sections. */
function OutlineItems({ source, nodes, shell, isOpen, onToggle }: { source: Source; nodes: readonly OutlineNode[]; shell: LearnShell; isOpen(node: OutlineNode, byDefault: boolean): boolean; onToggle(node: OutlineNode): void }): ReactNode {
  return (
    <div className="la-tree-items la-lib-outline">
      {nodes.map(node => {
        const printed = printedPage(source, node.page)
        const open = node.children.length > 0 && isOpen(node, nodes.length === 1)
        return (
          <Fragment key={node.key}>
            <div className="la-lib-row">
              <Chevron shown={node.children.length > 0} open={open} label={node.title} onToggle={() => onToggle(node)} />
              <button type="button" className="la-tree-item" data-la-opens="" title={`${node.title}${printed ? ` · 书上第 ${printed} 页` : ` · PDF 第 ${node.page} 页`}`}
                onClick={() => openSource(shell, source, node.page)}>
                <span className="la-tree-title">{node.title}</span>
                <span className="la-tree-meta">{printed ? `p.${printed}` : ''}</span>
              </button>
            </div>
            {open && <OutlineItems source={source} nodes={node.children} shell={shell} isOpen={isOpen} onToggle={onToggle} />}
          </Fragment>
        )
      })}
    </div>
  )
}

/** The fold button in front of a row; an empty slot keeps rows without children aligned. */
function Chevron({ shown, open, label, onToggle }: { shown: boolean; open: boolean; label: string; onToggle(): void }): ReactNode {
  if (!shown) return <span className="la-lib-chevron" aria-hidden="true" />
  return (
    <button type="button" className="la-lib-chevron" aria-expanded={open} aria-label={`${open ? '收起' : '展开'}${label}的章节`} title={open ? '收起章节' : '展开章节'} onClick={onToggle}>
      <ChevronRight {...ICON} />
    </button>
  )
}

/** Sources in the library this course does not use yet; picking one asks what it is for in this course. */
function AddFromLibrary({ courseId, shell, onAdded }: { courseId: string; shell: LearnShell; onAdded(): void }): ReactNode {
  const all = useLoad(shell, () => shell.call<LibraryRow[]>('library', 'sources', {}), [])
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState<{ row: LibraryRow; at: Point }>()
  const action = useAction()
  const others = (all.data ?? []).filter(row => !row.courses.some(course => course.id === courseId))
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const shown = others.filter(row => words.every(word => row.source.title.toLowerCase().includes(word)))
  const add = (row: LibraryRow, role: CourseSource['role']) => void action.run(async () => {
    await shell.call('library', 'attach', { courseId, sourceId: row.source.id, role })
    all.reload()
    onAdded()
  })
  const entries = (row: LibraryRow): MenuEntry[] => [
    { heading: '加入本课，当' },
    ...(isWeb(row.source) ? ['reference' as const] : ROLES).map(role => ({ key: role, label: ROLE_LABEL[role], hint: ROLE_HINT[role], onSelect: () => add(row, role) })),
  ]
  return (
    <div className="la-lib-tool">
      {others.length > FILTER_FROM && <TextField icon={SearchIcon} aria-label="按标题筛选资料" value={filter} onChange={setFilter} placeholder="按标题筛选" />}
      {!all.data && all.loading && <Skeleton lines={2} />}
      {all.data && others.length === 0 && <div className="la-side-empty">资料库里的资料都已经在本课了。</div>}
      {others.length > 0 && shown.length === 0 && <div className="la-side-empty">没有标题里有这些字的资料。</div>}
      <div className="la-tree">
        {shown.map(row => {
          const web = isWeb(row.source)
          const Icon = web ? Globe : FileText
          const where = web ? `${AUTHORITY_LABEL[row.source.authority]} · ${siteOf(row.source)}` : row.source.pages ? `${row.source.pages} 页` : '上传的资料'
          return (
            <button key={row.source.id} type="button" className="la-tree-item two-line" aria-haspopup="menu" disabled={action.busy} title={row.source.title}
              onClick={event => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ row, at: { x: box.left + 22, y: box.bottom + 2 } }) }}>
              <Icon {...ICON} />
              <span className="la-tree-lines">
                <span className="la-tree-title">{row.source.title}</span>
                <span className="la-tree-sub">{where}{row.courses.length ? ` · 用在 ${row.courses.length} 门课` : ''}</span>
              </span>
            </button>
          )
        })}
        <button type="button" className="la-tree-item" data-la-opens="" onClick={() => shell.openPage('library.sources', { import: true })}>
          <Upload {...ICON} /><span className="la-tree-title">导入新的 PDF…</span>
        </button>
      </div>
      <ErrorText error={action.error ?? all.error} />
      {menu && <ContextMenu entries={entries(menu.row)} at={menu.at} width={220} onClose={() => setMenu(undefined)} />}
    </div>
  )
}

function WebTool({ courseId, shell, openSettings }: { courseId: string; shell: LearnShell; openSettings(): void }): ReactNode {
  const services = useLoad(shell, () => shell.call<Services>('library', 'services'), [])
  return <WebFinderCompact courseId={courseId} providers={services.data?.webSearch} shell={shell} openSettings={openSettings} />
}
