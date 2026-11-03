// textbook unit, browser half: the handout reader (docs/textbook/design.md, 讲义页). A stage's lessons share one
// handout: opening a lesson shows the whole chapter at its section, and its 读完了 comes at that section's end.
// Reading is not interrupted: selecting text brings a small bar (ask, note, edit, sources); a citation badge shows the
// cited text on hover and opens the source on click; source figures are drawn in place. The learner may change a
// paragraph in place (11-01). Paragraphs the program flagged are marked in the margin. While a handout is written,
// the steps move and finished parts show.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, BookCheck, BookOpen, Check, ChevronDown, CircleAlert, CircleCheck, CircleDot, ExternalLink, Info, List, LoaderCircle, MessageCircleQuestion, PencilLine, Quote, RotateCw, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { Lesson, LessonTextbookStatus, Task } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell, SettingsAccess, TextPick } from '@learning-agent/contracts/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Callout, ConfirmButton, EmptyState, ErrorText, Menu, Page, PageHeader, Section, SettingRow, Skeleton, Switch, Tag, TextArea, useAction, useLoad, useSelection } from '@learning-agent/kit/client'

export const name = 'learning-textbook'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'textbook', title: '课程讲义', icon: BookOpen, scope: 'course', page: 'textbook.reader', panel: 'curriculum.outline', order: 20 }), 'textbook: activity')
  // Annotations are drawn by the annotation unit inside the reader; without it the slot stays empty.
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({
    name: 'learning.page',
    key: 'textbook.reader',
    children: { 'learning.reader-notes': { kind: 'single', scope: 'root' } },
  }, ReaderPage)), 'textbook: reader page')
  ctx.effect(() => ctx.slots.inject('learning.settings.services', () => ctx.slots.register({ name: 'learning.settings.services', id: 'textbook', order: 20 }, TextbookServices)), 'textbook: settings')
}

const SETTINGS = 'learning-textbook'

/** The handout's block on the settings page: whether gaps may be looked for on the web. */
function TextbookServices({ access }: { access: SettingsAccess }): ReactNode {
  const values = access.values(SETTINGS)
  const action = useAction()
  if (!values) return <Skeleton lines={2} />
  const web = values.webCheck !== false
  return (
    <Section title="讲义" icon={ShieldCheck} description="讲义是配合教材读的笔记：讲解由模型写，公式和原图由程序从资料里原样引用，程序检查式子和数值。">
      <div className="la-settings-card">
        <SettingRow title="联网补充讲解" hint="本章习题要用、资料里却没讲的内容，每章最多 3 项拿去联网搜索，只发要找的内容本身；只用一级、二级网站的网页，不加入资料库，讲义里直接给网址。">
          <Switch checked={web} busy={action.busy} aria-label="联网补充讲解" onChange={checked => action.run(() => access.set(SETTINGS, 'webCheck', checked ? undefined : false))} />
        </SettingRow>
      </div>
    </Section>
  )
}

/** One paragraph's sources and state (`textbook.blockInfo`); index.ts keeps the same shape. */
type BlockInfo = {
  kind: 'original' | 'explanation' | 'recall'
  state: 'flagged' | 'edited' | 'none'
  note: string
  sources: { chunkId: string; citation: string; text: string }[]
  web: { url: string; title: string; site: string; passage: string }[]
  revised?: string
}

/** Beside the selection: where this paragraph comes from, and what the program found in it. */
function InfoCard({ courseId, blockId, onSource }: { courseId: string; blockId: string; onSource(chunkId: string): void }): ReactNode {
  const info = useLoad(shell, () => shell.call<BlockInfo | null>('textbook', 'blockInfo', { courseId, blockId }), [courseId, blockId], ['learning/textbook-', 'learning/doc-'])
  if (info.error) return <ErrorText error={info.error} />
  if (!info.data) return info.loading ? <Skeleton lines={3} /> : <div className="la-faint">找不到这一段，可能刚改过，刷新后再试。</div>
  const data = info.data
  const head = data.kind === 'original' ? { icon: Quote, tone: 'ok', text: '资料原文，原样引用' }
    : data.kind === 'recall' ? { icon: CircleDot, tone: '', text: '读完就答的小问题，凭记忆回答' }
      : data.state === 'flagged' ? { icon: CircleAlert, tone: 'warn', text: '待核实：请对照原文阅读' }
        : data.state === 'edited' ? { icon: PencilLine, tone: '', text: '你改过这段' }
          : undefined
  return (
    <div className="la-block-check" role="note" aria-label="出处">
      {head && <div className={`la-block-check-title ${head.tone}`}><head.icon size={14} strokeWidth={1.75} />{head.text}</div>}
      {data.note && <div><shell.Markdown text={data.note} inline /></div>}
      {data.revised && <div className="la-faint">这段按要求改过：{data.revised}</div>}
      {data.sources.length > 0 && data.kind !== 'recall' && (
        <ul>
          {data.sources.map(source => (
            <li key={source.chunkId}>
              <button type="button" className="la-cite" title={`${source.citation} · 点击查看原文`} onClick={() => onSource(source.chunkId)}>{source.citation}</button>
              {data.kind !== 'original' && <blockquote><shell.Markdown text={source.text} inline={!source.text.includes('$$')} /></blockquote>}
            </li>
          ))}
        </ul>
      )}
      {data.web.map(page => (
        <div key={page.url}>
          <a href={page.url} target="_blank" rel="noreferrer" className="la-row" style={{ gap: 4, display: 'inline-flex' }}>{page.title}<ExternalLink size={12} strokeWidth={1.75} /></a>
          <span className="la-faint la-small"> · {page.site}（网页，没有加入资料库）</span>
          {page.passage && <blockquote>{page.passage.length > 220 ? `${page.passage.slice(0, 218)}…` : page.passage}</blockquote>}
        </div>
      ))}
      {data.kind === 'explanation' && data.sources.length === 0 && data.web.length === 0 && <div className="la-faint">这段没有引用资料。</div>}
    </div>
  )
}

/** The paragraph as it was changed elsewhere while the learner was editing it. */
interface Edited { readonly text: string; readonly hash: string }

/**
 * One paragraph in place as the learner edits it: its text with citations as short markers, saved back into the
 * handout. It is read once: a paragraph changed elsewhere meanwhile is not overwritten, the learner picks a version.
 */
function BlockEditor({ courseId, blockId, onDone }: { courseId: string; blockId: string; onDone(): void }): ReactNode {
  const source = useLoad(shell, () => shell.call<{ text: string; hash: string } | { refused: string }>('textbook', 'blockSource', { courseId, blockId }), [courseId, blockId], [])
  const [text, setText] = useState<string>()
  const [base, setBase] = useState<{ text: string; hash: string }>()
  const [edited, setEdited] = useState<Edited>()
  const save = useAction()
  useEffect(() => {
    if (source.data && 'text' in source.data && base === undefined) {
      setText(source.data.text)
      setBase(source.data)
    }
  }, [source.data, base])
  if (source.error) return <div className="la-block-editor"><ErrorText error={source.error} /><div className="la-block-editor-actions"><Button size="sm" variant="quiet" onClick={onDone}>关闭</Button></div></div>
  if (source.data && 'refused' in source.data) return <div className="la-block-editor"><Callout tone="neutral" icon={Info} title="这一段不能改" actions={<Button size="sm" variant="quiet" onClick={onDone}>知道了</Button>}>{source.data.refused}</Callout></div>
  if (text === undefined || base === undefined) return <div className="la-block-editor"><Skeleton lines={3} /></div>
  const store = (over = base) => void save.run(async () => {
    try {
      await shell.call('textbook', 'editBlock', { courseId, blockId, text, base: over.hash })
      onDone()
    } catch (error) {
      const failure = error as { code?: string; details?: Partial<Edited> }
      if (failure.code !== 'learning/textbook/edited' || typeof failure.details?.text !== 'string' || typeof failure.details.hash !== 'string') throw error
      setEdited({ text: failure.details.text, hash: failure.details.hash })
    }
  })
  /** Start again from the paragraph as it is now. */
  const takeTheirs = () => {
    setText(edited!.text)
    setBase(edited)
    setEdited(undefined)
  }
  /** Save the learner's text over the paragraph as it is now. */
  const keepMine = () => {
    const now = edited!
    setBase(now)
    setEdited(undefined)
    store(now)
  }
  return (
    <div className="la-block-editor" onKeyDown={event => { if (event.key === 'Escape') onDone() }}>
      {edited && (
        <Callout tone="warn" title="这一段在你打开后被改过（别的标签页、Obsidian 或重新生成），你的修改还没保存" actions={<><Button size="sm" variant="quiet" onClick={takeTheirs}>用现在的</Button><Button size="sm" onClick={keepMine}>用我的覆盖</Button></>}>
          <div className="la-block-versions">
            <div><span className="la-faint la-small">现在的</span><p>{edited.text || '（这一段已被删掉）'}</p></div>
            <div><span className="la-faint la-small">你打开时的</span><p>{base.text}</p></div>
          </div>
          <span className="la-faint la-small">也可以在下面的输入框里把两份合在一起，再点"用我的覆盖"。</span>
        </Callout>
      )}
      <TextArea value={text} onChange={setText} minRows={3} maxRows={16} autoFocus aria-label="修改这一段" />
      <div className="la-block-editor-actions">
        <span className="la-faint la-small">〔p.12〕这样的标记是出处，删掉标记就去掉这处出处</span>
        <Button size="sm" variant="quiet" onClick={onDone}>取消</Button>
        {edited ? null : text.trim()
          ? <Button size="sm" variant="primary" icon={Check} loading={save.busy} disabled={text === base.text} onClick={() => store()}>保存</Button>
          : <ConfirmButton size="sm" variant="danger" loading={save.busy} onConfirm={() => store()} question="删掉这一段？" confirm="删掉">删掉这段</ConfirmButton>}
      </div>
      <ErrorText error={save.error} />
    </div>
  )
}

const STEPS: { step: NonNullable<LessonTextbookStatus['progress']>['step']; label: string }[] = [
  { step: 'plan', label: '整理提纲' },
  { step: 'write', label: '编写讲义' },
  { step: 'check', label: '检查式子和数值' },
  { step: 'publish', label: '发布' },
]

/** Seconds since `start`, ticking. */
function useElapsed(start: string | undefined): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!start) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [start])
  if (!start) return ''
  const seconds = Math.max(0, Math.round((now - Date.parse(start)) / 1000))
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

/** The handout being written: the steps, the parts done, how long it has taken. */
function Generating({ status }: { status: LessonTextbookStatus }): ReactNode {
  const progress = status.progress
  const elapsed = useElapsed(progress?.startedAt)
  const at = progress ? STEPS.findIndex(item => item.step === progress.step) : -1
  const done = progress?.points.filter(point => point.done).length ?? 0
  return (
    <div className="la-callout accent la-generating" role="status" aria-live="polite">
      <LoaderCircle size={16} strokeWidth={1.75} className="la-callout-icon la-spin" />
      <div className="la-callout-body">
        <div className="la-callout-title">讲义生成中{elapsed && <span className="la-faint la-small" style={{ fontWeight: 400 }}>　已用 {elapsed}</span>}</div>
        <div className="la-callout-text">{status.message || '正在按设计书和资料编写这一章，写好后这里会自动出现。'}</div>
        {progress && (
          <ol className="la-steps">
            {STEPS.map((item, index) => (
              <li key={item.step} className={index < at ? 'is-done' : index === at ? 'is-current' : ''}>
                {index < at ? <Check size={13} strokeWidth={2} /> : index === at ? <LoaderCircle size={13} strokeWidth={2} className="la-spin" /> : <CircleDot size={13} strokeWidth={1.75} />}
                {item.label}{item.step === 'write' && progress.points.length > 0 ? `（${done}/${progress.points.length}）` : ''}
              </li>
            ))}
          </ol>
        )}
        {progress && progress.points.length > 1 && (
          <ul className="la-points">
            {progress.points.map((point, index) => (
              <li key={index} className={point.done ? 'is-done' : ''}>{point.done ? <Check size={12} strokeWidth={2} /> : <CircleDot size={12} strokeWidth={1.75} />}{point.title}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** The page header already shows the title; drop the file's own first heading when it repeats it. */
function withoutTitle(text: string, title: string): string {
  const match = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)?\s*#{1,3}[ \t]+([^\n]*)\r?\n/.exec(text)
  if (!match) return text
  const heading = match[2]!.replace(/\s+/g, '')
  if (!heading.includes(title.replace(/\s+/g, ''))) return text
  return (match[1] ?? '') + text.slice(match[0].length)
}

type LessonView = {
  lesson: Lesson
  stage: { id: string; index: number; title: string }
  siblings: { id: string; number: string; title: string }[]
  text: string | null
  /** The stage's handout, which all its lessons share; false for a lesson's own file of before 11-01. */
  handout: boolean
  /** Where each lesson's section of the handout ends, by lesson id. */
  ends: Record<string, string>
  status: LessonTextbookStatus
}

function ReaderPage({ scope, params, renderSlot }: LearningPageProps & PropsRenderSlots<'learning.reader-notes'>): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const picked = typeof params.id === 'string' ? params.id : undefined
  // Without a lesson to show, follow the course: the current lesson appears once a design is confirmed.
  const current = useLoad(shell, async () => (picked || !courseId ? null : (await shell.call<{ lessonId: string | null }>('textbook', 'current', { courseId })).lessonId), [picked, courseId])
  const lessonId = picked ?? current.data ?? undefined
  if (!courseId) return <Page width="reading"><EmptyState icon={BookOpen} title="进入一门课后阅读它的讲义" /></Page>
  if (!lessonId) {
    return (
      <Page width="reading">
        {current.loading ? <Skeleton lines={6} title /> : <EmptyState icon={BookOpen} title="还没有课时" description="阶段设计书确认后，这一章的讲义会生成在这里。" />}
      </Page>
    )
  }
  return <Reader courseId={courseId} lessonId={lessonId} renderSlot={renderSlot} />
}

const LESSON_TAG: Record<Lesson['status'], ReactNode> = {
  'not-started': <Tag>未开始</Tag>,
  'in-progress': <Tag tone="accent" icon={CircleDot}>正在学</Tag>,
  done: <Tag tone="ok" icon={CircleCheck}>已完成</Tag>,
}

/** Where the selection bar sits in the text column: above the selection's right end, or below it near the top. */
type Bar = { pick: TextPick; top: number; right: number }

function Reader({ courseId, lessonId, renderSlot }: { courseId: string; lessonId: string; renderSlot: PropsRenderSlots<'learning.reader-notes'>['renderSlot'] }): ReactNode {
  // Reloads on every change-feed message, generation progress included.
  const view = useLoad(shell, () => shell.call<LessonView>('textbook', 'lesson', { lessonId }), [lessonId])
  // The paragraphs to read with care, marked in the margin.
  const flagged = useLoad(shell, () => shell.call<string[]>('textbook', 'flagged', { lessonId }), [lessonId])
  // Explanation paragraphs that cite nothing: marked only while their tag is pressed.
  const uncited = useLoad(shell, () => shell.call<string[]>('textbook', 'uncited', { lessonId }), [lessonId])
  const [marking, setMarking] = useState<'flagged' | 'uncited'>()
  // In a conflict: whether the held handout is shown instead of the file.
  const [preview, setPreview] = useState(false)
  const resolve = useAction()
  const tasks = useLoad(shell, () => shell.call<{ tasks: Task[] }>('curriculum', 'overview', { courseId }).then(overview => overview.tasks), [courseId])
  const selection = useSelection(shell)
  const regenerate = useAction()
  const finish = useAction()
  const body = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<Bar>()
  const [info, setInfo] = useState(false)
  const [editing, setEditing] = useState<string>()
  const data = view.data
  const frame = shell.usePage()
  const named = data ? (data.handout ? data.stage.title : `${data.lesson.number} ${data.lesson.title}`) : undefined
  useEffect(() => { if (named) frame.setTitle(named) }, [named])
  // What the learner selected here stays the selection (for 提问) after the bar goes away, but only the text was
  // picked: the paragraph is outlined only when it was picked elsewhere.
  const mine = useRef<object>(undefined)
  const selectedBlock = selection && selection !== mine.current && selection.page === 'textbook.reader' && selection.selected?.kind === 'block' ? selection.selected.id : undefined

  // A paragraph selected from elsewhere (a note on the 批注 page) is outlined and brought into view.
  useLayoutEffect(() => {
    const block = selectedBlock ? body.current?.querySelector<HTMLElement>(`[data-block="${CSS.escape(selectedBlock)}"]`) : undefined
    const scroller = body.current?.closest('.la-page')
    if (!block || !scroller) return
    const view = scroller.getBoundingClientRect()
    const box = block.getBoundingClientRect()
    if (box.bottom < view.top || box.top > view.bottom) block.scrollIntoView({ block: 'center' })
  }, [selectedBlock, data?.text])

  // A handout opens at the lesson's section, once per lesson; the first lesson opens at the top, at 本章速览.
  const opened = useRef<string>(undefined)
  useLayoutEffect(() => {
    if (!data?.handout || !data.text || opened.current === lessonId || selectedBlock) return
    opened.current = lessonId
    if (data.siblings[0]?.id === lessonId) return
    const heading = [...body.current?.querySelectorAll('h3') ?? []].find(item => item.textContent?.trim().startsWith(`${data.lesson.number} `))
    heading?.scrollIntoView({ block: 'start' })
  }, [lessonId, data?.text])

  // The bar, and the card it opens, stay inside the text column: a selection near the left edge moves them right.
  useLayoutEffect(() => {
    const width = bar.current?.offsetWidth
    const room = body.current?.clientWidth
    if (!place || !width || !room) return
    const right = Math.min(place.right, Math.max(0, room - width))
    if (right !== place.right) setPlace({ ...place, right })
  }, [place, info])

  // The bar goes away when the selection does (a click elsewhere), or on Escape.
  useEffect(() => {
    if (!place) return
    const away = (event: Event) => {
      if (bar.current?.contains(event.target as Node)) return
      if (window.getSelection()?.isCollapsed) { setPlace(undefined); setInfo(false) }
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPlace(undefined); setInfo(false) } }
    document.addEventListener('mouseup', away)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mouseup', away); document.removeEventListener('keydown', escape) }
  }, [place])

  if (view.error) return <Page width="reading"><ErrorText error={view.error} /></Page>
  if (!data) return <Page width="reading"><Skeleton lines={8} title /></Page>
  const index = data.siblings.findIndex(item => item.id === lessonId)
  const previous = data.handout ? undefined : data.siblings[index - 1]
  const next = data.handout ? undefined : data.siblings[index + 1]
  const status = data.status
  const running = status.state === 'running'
  const generate = () => void regenerate.run(() => shell.call('textbook', 'generate', { lessonId }))
  const readTask = tasks.data?.find(task => task.status === 'open' && task.kind === 'read' && task.lessonId === lessonId)
  const openSource = (chunkId: string) => shell.openPage('library.sources', { chunkId }, { title: '出处', side: true })
  // Another lesson is another step in the tab's history: back returns to this one where it was.
  const go = (id: string) => {
    const lesson = data.siblings.find(item => item.id === id)
    shell.openPage('textbook.reader', { id }, { title: lesson ? `${lesson.number} ${lesson.title}` : '课程讲义' })
  }
  const select = (pick: TextPick | undefined) => {
    setInfo(false)
    const column = body.current?.getBoundingClientRect()
    if (!pick || !column) { setPlace(undefined); return }
    const picked: Parameters<LearnShell['select']>[0] = {
      page: 'textbook.reader',
      courseId: courseId as never,
      selected: { kind: 'block', id: pick.blockId, quote: pick.quote, label: `${data.handout ? data.stage.title : `${data.lesson.number} ${data.lesson.title}`} · ${pick.quote.exact.replace(/\s+/g, ' ').slice(0, 18)}…` },
    }
    mine.current = picked
    shell.select(picked)
    // Above the selection unless that is out of sight, under the tabs. With a finger, below: the system's copy menu
    // sits above a touch selection.
    const visible = body.current?.closest('.la-page')?.getBoundingClientRect().top ?? column.top
    const above = !window.matchMedia('(pointer: coarse)').matches && pick.rect.top - 46 >= Math.max(visible, column.top)
    setPlace({ pick, top: above ? pick.rect.top - column.top - 46 : pick.rect.bottom - column.top + 8, right: Math.max(0, column.right - pick.rect.right - 8) })
  }
  const conflict = status.state === 'conflict'
  const shown = (running || (conflict && preview)) && status.draft ? status.draft : data.text
  const pick = (choice: 'replace' | 'keep') => void resolve.run(async () => { await shell.call('textbook', 'resolveConflict', { lessonId, choice }); setPreview(false) })
  const title = data.handout ? data.stage.title : `${data.lesson.number} ${data.lesson.title}`
  // Where this lesson's 读完了 goes: the end of its section, or the end of a lesson's own file.
  const end = data.handout ? data.ends[lessonId] : undefined
  const done = readTask && data.text && !running ? (
    <div className="la-read-done">
      <Callout tone="accent" icon={BookCheck} title={`读完 ${data.lesson.number} 了吗？`}
        actions={<Button variant="primary" icon={Check} loading={finish.busy} onClick={() => void finish.run(() => shell.call('curriculum', 'completeTask', { taskId: readTask.id }))}>读完了</Button>}>
        {readTask.instructions || '告诉老师后，老师会接着安排小测。'}
      </Callout>
      <ErrorText error={finish.error} />
    </div>
  ) : null
  const edited = status.edited ?? 0
  return (
    <Page width="reading">
      <PageHeader eyebrow={<><BookOpen size={14} strokeWidth={1.75} />阶段 {data.stage.index}{data.handout ? ' · 讲义' : ` · ${data.stage.title}`}</>}
        title={data.handout ? title : <>{data.lesson.number}<span style={{ marginLeft: '0.4em' }}>{data.lesson.title}</span></>}
        meta={<>
          {data.handout && <Tag>{data.lesson.number} {data.lesson.title}</Tag>}
          {LESSON_TAG[data.lesson.status]}
          {status.state === 'ready' && status.unverified ? (
            <Tag tone="warn" pressed={marking === 'flagged'} onClick={() => setMarking(on => (on === 'flagged' ? undefined : 'flagged'))} title={marking === 'flagged' ? '取消标出' : '式子或数值和资料对不上的段落；点一下在正文里标出来'}>{status.unverified} 段待核实</Tag>
          ) : null}
          {status.state === 'ready' && status.uncited ? (
            <Tag pressed={marking === 'uncited'} onClick={() => setMarking(on => (on === 'uncited' ? undefined : 'uncited'))} title={marking === 'uncited' ? '取消标出' : '讲解里没有引用资料或网页的段落，读的时候多留意；点一下在正文里标出来'}>{status.uncited} 段没引用</Tag>
          ) : null}
          {status.missing?.length ? <Tag tone="warn" title={`本章习题要用、但资料里没有讲到：${status.missing.join('；')}。可以问主老师，或在资料库里加一份讲它的资料`}>{status.missing.length} 项资料里没讲</Tag> : null}
          {status.notes?.length ? <Tag icon={Info} title={status.notes.join('\n')}>生成说明</Tag> : null}
        </>}
        actions={<>
          {data.siblings.length > 1 && (
            <Menu align="end" width={280} entries={[{ heading: `阶段 ${data.stage.index} 的课时` }, ...data.siblings.map(item => ({
              key: item.id, label: `${item.number} ${item.title}`, checked: item.id === lessonId, onSelect: () => go(item.id),
            }))]} trigger={props => <Button size="sm" variant="quiet" icon={List} {...props}>本阶段<ChevronDown size={14} strokeWidth={1.75} /></Button>} />
          )}
          {data.text && !running && (
            <ConfirmButton size="sm" variant="quiet" icon={RotateCw} loading={regenerate.busy} onConfirm={generate}
              question={`重写这一章的讲义？${edited ? `你改过的 ${edited} 段会被新内容替换，` : ''}旧版本留在变更记录里`} confirm="重新生成">重新生成</ConfirmButton>
          )}
        </>} />
      <div className="la-stack" style={{ gap: 16 }}>
        {running && <Generating status={status} />}
        {running && status.draft && <div className="la-faint la-small">下面是已经写好的部分，检查完会换成正式版。</div>}
        {conflict && (
          <Callout tone="warn" title="新讲义没有发布：讲义文件在生成期间（或程序停着时）被改过"
            actions={<>
              {status.draft && <Button size="sm" variant="quiet" onClick={() => setPreview(on => !on)}>{preview ? '看现在的文件' : '看新讲义'}</Button>}
              {data.text && <Button size="sm" loading={resolve.busy} onClick={() => pick('keep')}>保留现在的文件</Button>}
              <ConfirmButton size="sm" loading={resolve.busy} onConfirm={() => pick('replace')} question="用新讲义替换现在的文件？现在的内容留在变更记录里" confirm="替换">用新讲义替换</ConfirmButton>
            </>}>
            为了不覆盖你的修改，新生成的讲义先放着。{preview ? '下面是新讲义。' : '下面是现在的文件。'}
          </Callout>
        )}
        <ErrorText error={resolve.error} />
        {status.state === 'failed' && (
          <Callout tone="bad" title="讲义没有生成成功" actions={<Button size="sm" icon={RotateCw} loading={regenerate.busy} onClick={generate}>重新生成</Button>}>{status.message}</Callout>
        )}
        {!data.text && !running && status.state !== 'failed' && !conflict && (
          <div className="la-card">
            <EmptyState icon={Sparkles} title="这一章的讲义还没有生成" description="讲义配合教材读：开头是名词表和公式表，按小节简短地讲，最后是易混点和题型与方法。"
              action={<Button variant="primary" icon={Sparkles} loading={regenerate.busy} onClick={generate}>生成讲义</Button>} />
          </div>
        )}
        <ErrorText error={regenerate.error} />
      </div>
      {shown && (
        <div ref={body} style={{ position: 'relative', marginTop: 8 }}>
          <shell.Markdown
            text={withoutTitle(shown, title)}
            blocks
            {...(selectedBlock ? { selectedBlock } : {})}
            {...((running || (conflict && preview)) && status.draft ? {} : { onSelect: select })}
            onCite={openSource}
            blockClass={blockId => [
              flagged.data?.includes(blockId) ? `is-flagged${marking === 'flagged' ? ' is-marked' : ''}` : '',
              marking === 'uncited' && uncited.data?.includes(blockId) ? 'is-uncited' : '',
              editing === blockId ? 'is-editing' : '',
            ].filter(Boolean).join(' ') || undefined}
            afterBlock={blockId => <>
              {editing === blockId && <BlockEditor courseId={courseId} blockId={blockId} onDone={() => setEditing(undefined)} />}
              {renderSlot('learning.reader-notes', { part: 'notes', courseId, blockId }, { fallback: null })}
              {blockId === end && done}
            </>}
          />
          {place && (
            <div ref={bar} className="la-select-bar" style={{ top: place.top, right: place.right }}
              // Keep the selection: a click on the bar must not clear what it acts on.
              onMouseDown={event => { if (!(event.target as HTMLElement).closest('input, textarea')) event.preventDefault() }}>
              <span className="la-confirm" style={{ padding: 3, gap: 2 }}>
                <Button size="sm" variant="quiet" icon={MessageCircleQuestion} onClick={() => { shell.showSideChat(); setPlace(undefined) }}>提问</Button>
                {renderSlot('learning.reader-notes', { part: 'actions', courseId, blockId: place.pick.blockId }, { fallback: null })}
                <Button size="sm" variant="quiet" icon={PencilLine} onClick={() => { setEditing(place.pick.blockId); setPlace(undefined); window.getSelection()?.removeAllRanges() }}>修改</Button>
                <Button size="sm" variant={info ? 'default' : 'quiet'} icon={ShieldCheck} aria-pressed={info} onClick={() => setInfo(on => !on)}>出处</Button>
                <Button size="sm" variant="quiet" icon={X} aria-label="关闭" title="关闭" onClick={() => { setPlace(undefined); setInfo(false) }} />
              </span>
              {info && <div className="la-select-info"><InfoCard courseId={courseId} blockId={place.pick.blockId} onSource={openSource} /></div>}
            </div>
          )}
        </div>
      )}
      {!end && done && <div style={{ marginTop: 32 }}>{done}</div>}
      {data.text && (previous || next) && (
        <nav className="la-lesson-nav" aria-label="上一节和下一节" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 32 }}>
          {previous ? (
            <button type="button" className="la-card interactive" style={{ textAlign: 'left', font: 'inherit', color: 'inherit' }} data-la-opens="" onClick={() => go(previous.id)}>
              <div className="la-faint la-small la-row" style={{ gap: 4 }}><ArrowLeft size={13} strokeWidth={1.75} />上一节</div>
              <div className="la-strong la-ellipsis" style={{ marginTop: 2 }}>{previous.number} {previous.title}</div>
            </button>
          ) : <span />}
          {next && (
            <button type="button" className="la-card interactive" style={{ textAlign: 'right', font: 'inherit', color: 'inherit' }} data-la-opens="" onClick={() => go(next.id)}>
              <div className="la-faint la-small la-row" style={{ gap: 4, justifyContent: 'flex-end' }}>下一节<ArrowRight size={13} strokeWidth={1.75} /></div>
              <div className="la-strong la-ellipsis" style={{ marginTop: 2 }}>{next.number} {next.title}</div>
            </button>
          )}
        </nav>
      )}
      {data.text && <p className="la-faint la-small" style={{ marginTop: 24, textAlign: 'center' }}>选中文字可以提问、批注、修改，或看出处；指着蓝色出处标签能看原文，点开看原书。</p>}
    </Page>
  )
}
