// textbook unit, browser half: the textbook reader (docs/textbook/design.md, 讲解与原文). Reading is not
// interrupted: selecting text brings a small bar (ask, note, sources and check); a citation badge shows the
// cited text on hover and opens the source on click; source figures are drawn in place. Paragraphs the check
// flagged are marked in the margin. While a lesson is written, the steps move and finished points show.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, BookCheck, BookOpen, Check, ChevronDown, CircleAlert, CircleCheck, CircleDot, ExternalLink, List, LoaderCircle, MessageCircleQuestion, PencilLine, Quote, RotateCw, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { Lesson, LessonTextbookStatus, Task } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell, SettingsAccess, TextPick } from '@learning-agent/contracts/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Callout, ConfirmButton, EmptyState, ErrorText, Menu, Page, PageHeader, Section, SettingRow, Skeleton, Switch, Tag, useAction, useLoad, useSelection } from '@learning-agent/kit/client'

export const name = 'learning-textbook'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'textbook', title: '课程教材', icon: BookOpen, scope: 'course', page: 'textbook.reader', panel: 'curriculum.outline', order: 20 }), 'textbook: activity')
  // Annotations are drawn by the annotation unit inside the reader; without it the slot stays empty.
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({
    name: 'learning.page',
    key: 'textbook.reader',
    children: { 'learning.reader-notes': { kind: 'single', scope: 'root' } },
  }, ReaderPage)), 'textbook: reader page')
  ctx.effect(() => ctx.slots.inject('learning.settings.services', () => ctx.slots.register({ name: 'learning.settings.services', id: 'textbook', order: 20 }, TextbookServices)), 'textbook: settings')
}

const SETTINGS = 'learning-textbook'

/** The textbook's block on the settings page: whether gaps may be looked for on the web. */
function TextbookServices({ access }: { access: SettingsAccess }): ReactNode {
  const values = access.values(SETTINGS)
  const action = useAction()
  if (!values) return <Skeleton lines={2} />
  const web = values.webCheck !== false
  return (
    <Section title="教材" icon={ShieldCheck} description="教材由讲解和资料原文组成：讲解发布前对照资料核对，原文由程序原样引用。">
      <div className="la-settings-card">
        <SettingRow title="联网补充讲解" hint="本节习题要用、资料里却没讲的内容，每节最多 3 项拿去联网搜索，只发要找的内容本身；只用一级、二级网站的网页，不加入资料库，教材里直接给网址。">
          <Switch checked={web} busy={action.busy} aria-label="联网补充讲解" onChange={checked => action.run(() => access.set(SETTINGS, 'webCheck', checked ? undefined : false))} />
        </SettingRow>
      </div>
    </Section>
  )
}

/** A paragraph the reader marks in the margin (`textbook.checks`). */
type Mark = 'flagged' | 'unchecked' | 'stale'

/** One paragraph's sources and check (`textbook.blockInfo`); index.ts keeps the same shape. */
type BlockInfo = {
  kind: 'original' | 'explanation' | 'recall'
  state: 'ok' | Mark | 'none'
  note: string
  sources: { chunkId: string; citation: string; text: string }[]
  web: { url: string; title: string; site: string; passage: string }[]
  revised?: string
}

const STATE_TITLE: Record<BlockInfo['state'], { icon: typeof ShieldCheck; tone: string; text: string }> = {
  ok: { icon: ShieldCheck, tone: 'ok', text: '对照资料核对过，没有发现问题' },
  flagged: { icon: CircleAlert, tone: 'warn', text: '待核实：请对照原文阅读' },
  unchecked: { icon: CircleDot, tone: '', text: '这段还没有核对完' },
  stale: { icon: PencilLine, tone: '', text: '这段在核对后改过，原来的核对结果不再算数' },
  none: { icon: CircleDot, tone: '', text: '这段没有单独核对' },
}

/** Beside the selection: where this paragraph comes from, and what the check found. */
function InfoCard({ courseId, blockId, onSource }: { courseId: string; blockId: string; onSource(chunkId: string): void }): ReactNode {
  const info = useLoad(shell, () => shell.call<BlockInfo | null>('textbook', 'blockInfo', { courseId, blockId }), [courseId, blockId], ['learning/textbook-', 'learning/doc-'])
  if (info.error) return <ErrorText error={info.error} />
  if (!info.data) return info.loading ? <Skeleton lines={3} /> : <div className="la-faint">找不到这一段，可能刚改过，刷新后再试。</div>
  const data = info.data
  const head = data.kind === 'original' ? { icon: Quote, tone: 'ok', text: '资料原文，原样引用，不用核对' }
    : data.kind === 'recall' ? { icon: CircleDot, tone: '', text: '读完就答的小问题，凭记忆回答' }
      : STATE_TITLE[data.state]
  return (
    <div className="la-block-check" role="note" aria-label="出处与核对">
      <div className={`la-block-check-title ${head.tone}`}><head.icon size={14} strokeWidth={1.75} />{head.text}</div>
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
      {data.kind === 'explanation' && data.sources.length === 0 && data.web.length === 0 && <div className="la-faint">这段是过渡或学习建议，没有引用资料。</div>}
    </div>
  )
}

const STEPS: { step: NonNullable<LessonTextbookStatus['progress']>['step']; label: string }[] = [
  { step: 'plan', label: '整理要点' },
  { step: 'write', label: '编写讲解' },
  { step: 'check', label: '对照资料核对' },
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

/** The lesson being written: the steps, the points done, how long it has taken. */
function Generating({ status }: { status: LessonTextbookStatus }): ReactNode {
  const progress = status.progress
  const elapsed = useElapsed(progress?.startedAt)
  const at = progress ? STEPS.findIndex(item => item.step === progress.step) : -1
  const done = progress?.points.filter(point => point.done).length ?? 0
  return (
    <div className="la-callout accent la-generating" role="status" aria-live="polite">
      <LoaderCircle size={16} strokeWidth={1.75} className="la-callout-icon la-spin" />
      <div className="la-callout-body">
        <div className="la-callout-title">教材生成中{elapsed && <span className="la-faint la-small" style={{ fontWeight: 400 }}>　已用 {elapsed}</span>}</div>
        <div className="la-callout-text">{status.message || '正在按设计书和资料编写这一节，写好后这里会自动出现。'}</div>
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

/** The page header already shows `1.2 标题`; drop the file's own first heading when it repeats it. */
function withoutTitle(text: string, lesson: Lesson): string {
  const match = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)?\s*#{1,3}[ \t]+([^\n]*)\r?\n/.exec(text)
  if (!match) return text
  const heading = match[2]!.replace(/\s+/g, '')
  if (!heading.includes(lesson.title.replace(/\s+/g, ''))) return text
  return (match[1] ?? '') + text.slice(match[0].length)
}

type LessonView = {
  lesson: Lesson
  stage: { id: string; index: number; title: string }
  siblings: { id: string; number: string; title: string }[]
  text: string | null
  status: LessonTextbookStatus
}

function ReaderPage({ scope, params, renderSlot }: LearningPageProps & PropsRenderSlots<'learning.reader-notes'>): ReactNode {
  const courseId = scope.kind === 'course' ? scope.courseId : undefined
  const picked = typeof params.id === 'string' ? params.id : undefined
  // Without a lesson to show, follow the course: the current lesson appears once a design is confirmed.
  const current = useLoad(shell, async () => (picked || !courseId ? null : (await shell.call<{ lessonId: string | null }>('textbook', 'current', { courseId })).lessonId), [picked, courseId])
  const lessonId = picked ?? current.data ?? undefined
  if (!courseId) return <Page width="reading"><EmptyState icon={BookOpen} title="进入一门课后阅读它的教材" /></Page>
  if (!lessonId) {
    return (
      <Page width="reading">
        {current.loading ? <Skeleton lines={6} title /> : <EmptyState icon={BookOpen} title="还没有课时" description="阶段设计书确认后，教材会一节一节地生成在这里。" />}
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
  const marks = useLoad(shell, () => shell.call<Record<string, Mark>>('textbook', 'checks', { lessonId }), [lessonId])
  const [marking, setMarking] = useState(false)
  const tasks = useLoad(shell, () => shell.call<{ tasks: Task[] }>('curriculum', 'overview', { courseId }).then(overview => overview.tasks), [courseId])
  const selection = useSelection(shell)
  const regenerate = useAction()
  const finish = useAction()
  const body = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<Bar>()
  const [info, setInfo] = useState(false)
  const data = view.data
  const frame = shell.usePage()
  const named = data ? `${data.lesson.number} ${data.lesson.title}` : undefined
  useEffect(() => { if (named) frame.setTitle(named) }, [named])
  const selectedBlock = selection?.page === 'textbook.reader' && selection.selected?.kind === 'block' ? selection.selected.id : undefined

  // A paragraph selected from elsewhere (a note on the 批注 page) is brought into view.
  useLayoutEffect(() => {
    const block = selectedBlock ? body.current?.querySelector<HTMLElement>(`[data-block="${CSS.escape(selectedBlock)}"]`) : undefined
    const scroller = body.current?.closest('.la-page')
    if (!block || !scroller || place) return
    const view = scroller.getBoundingClientRect()
    const box = block.getBoundingClientRect()
    if (box.bottom < view.top || box.top > view.bottom) block.scrollIntoView({ block: 'center' })
  }, [selectedBlock, data?.text])

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
  const previous = data.siblings[index - 1]
  const next = data.siblings[index + 1]
  const status = data.status
  const running = status.state === 'running'
  const generate = () => void regenerate.run(() => shell.call('textbook', 'generate', { lessonId }))
  const readTask = tasks.data?.find(task => task.status === 'open' && task.kind === 'read' && task.lessonId === lessonId)
  const openSource = (chunkId: string) => shell.openPage('library.sources', { chunkId }, { title: '出处', side: true })
  // Another lesson is another step in the tab's history: back returns to this one where it was.
  const go = (id: string) => {
    const lesson = data.siblings.find(item => item.id === id)
    shell.openPage('textbook.reader', { id }, { title: lesson ? `${lesson.number} ${lesson.title}` : '课程教材' })
  }
  const select = (pick: TextPick | undefined) => {
    setInfo(false)
    const column = body.current?.getBoundingClientRect()
    if (!pick || !column) { setPlace(undefined); return }
    shell.select({
      page: 'textbook.reader',
      courseId: courseId as never,
      selected: { kind: 'block', id: pick.blockId, quote: pick.quote, label: `${data.lesson.number} ${data.lesson.title} · ${pick.quote.exact.replace(/\s+/g, ' ').slice(0, 18)}…` },
    })
    // Above the selection unless that is out of sight, under the tabs.
    const visible = body.current?.closest('.la-page')?.getBoundingClientRect().top ?? column.top
    const above = pick.rect.top - 46 >= Math.max(visible, column.top)
    setPlace({ pick, top: above ? pick.rect.top - column.top - 46 : pick.rect.bottom - column.top + 8, right: Math.max(0, column.right - pick.rect.right - 8) })
  }
  const shown = running && status.draft ? status.draft : data.text
  return (
    <Page width="reading">
      <PageHeader eyebrow={<><BookOpen size={14} strokeWidth={1.75} />阶段 {data.stage.index} · {data.stage.title}</>}
        title={<>{data.lesson.number}<span style={{ marginLeft: '0.4em' }}>{data.lesson.title}</span></>}
        meta={<>
          {LESSON_TAG[data.lesson.status]}
          {status.state === 'ready' && status.unverified ? (
            <Tag tone="warn" pressed={marking} onClick={() => setMarking(on => !on)} title={marking ? '取消标出' : '和资料不一致、或有资料里找不到的说法的段落；点一下在正文里标出来'}>{status.unverified} 段待核实</Tag>
          ) : null}
          {status.check?.state === 'unchecked' && <Tag title={status.check.notes.join('\n')}>讲解没有核对完</Tag>}
          {status.check?.stale ? <Tag title="这些段落在核对之后改过，原来的核对结果不再算数">{status.check.stale} 段改过未重新核对</Tag> : null}
          {status.missing?.length ? <Tag tone="warn" title={`本节习题要用、但资料里没有讲到：${status.missing.join('；')}。可以问主老师，或在资料库里加一份讲它的资料`}>{status.missing.length} 项资料里没讲</Tag> : null}
        </>}
        actions={<>
          {data.siblings.length > 1 && (
            <Menu align="end" width={280} entries={[{ heading: `阶段 ${data.stage.index} 的课时` }, ...data.siblings.map(item => ({
              key: item.id, label: `${item.number} ${item.title}`, checked: item.id === lessonId, onSelect: () => go(item.id),
            }))]} trigger={props => <Button size="sm" variant="quiet" icon={List} {...props}>本阶段<ChevronDown size={14} strokeWidth={1.75} /></Button>} />
          )}
          {data.text && !running && (
            <ConfirmButton size="sm" variant="quiet" icon={RotateCw} loading={regenerate.busy} onConfirm={generate}
              question="按当前设计书重写这一节？旧版本留在变更记录里" confirm="重新生成">重新生成</ConfirmButton>
          )}
        </>} />
      <div className="la-stack" style={{ gap: 16 }}>
        {running && <Generating status={status} />}
        {running && status.draft && <div className="la-faint la-small">下面是已经写好的要点，核对完会换成正式版。</div>}
        {status.state === 'failed' && (
          <Callout tone="bad" title="这一节没有生成成功" actions={<Button size="sm" icon={RotateCw} loading={regenerate.busy} onClick={generate}>重新生成</Button>}>{status.message}</Callout>
        )}
        {!data.text && !running && status.state !== 'failed' && (
          <div className="la-card">
            <EmptyState icon={Sparkles} title="这一节的教材还没有生成" description="教材用适合你的话讲重点，原书的公式、图和例题原样放在讲解旁边。"
              action={<Button variant="primary" icon={Sparkles} loading={regenerate.busy} onClick={generate}>生成本节教材</Button>} />
          </div>
        )}
        <ErrorText error={regenerate.error} />
      </div>
      {shown && (
        <div ref={body} style={{ position: 'relative', marginTop: 8 }}>
          <shell.Markdown
            text={withoutTitle(shown, data.lesson)}
            blocks
            {...(selectedBlock && !place ? { selectedBlock } : {})}
            {...(running && status.draft ? {} : { onSelect: select })}
            onCite={openSource}
            blockClass={blockId => {
              const mark = marks.data?.[blockId]
              return mark === 'flagged' ? `is-flagged${marking ? ' is-marked' : ''}` : undefined
            }}
            afterBlock={blockId => renderSlot('learning.reader-notes', { part: 'notes', courseId, blockId }, { fallback: null })}
          />
          {place && (
            <div ref={bar} className="la-select-bar" style={{ top: place.top, right: place.right }}
              // Keep the selection: a click on the bar must not clear what it acts on.
              onMouseDown={event => { if (!(event.target as HTMLElement).closest('input, textarea')) event.preventDefault() }}>
              <span className="la-confirm" style={{ padding: 3, gap: 2 }}>
                <Button size="sm" variant="quiet" icon={MessageCircleQuestion} onClick={() => { shell.showSideChat(); setPlace(undefined) }}>提问</Button>
                {renderSlot('learning.reader-notes', { part: 'actions', courseId, blockId: place.pick.blockId }, { fallback: null })}
                <Button size="sm" variant={info ? 'default' : 'quiet'} icon={ShieldCheck} aria-pressed={info} onClick={() => setInfo(on => !on)}>出处与核对</Button>
                <Button size="sm" variant="quiet" icon={X} aria-label="关闭" title="关闭" onClick={() => { setPlace(undefined); setInfo(false) }} />
              </span>
              {info && <div className="la-select-info"><InfoCard courseId={courseId} blockId={place.pick.blockId} onSource={openSource} /></div>}
            </div>
          )}
        </div>
      )}
      {data.text && !running && readTask && (
        <div style={{ marginTop: 32 }}>
          <Callout tone="accent" icon={BookCheck} title="读完这一节了吗？"
            actions={<Button variant="primary" icon={Check} loading={finish.busy} onClick={() => void finish.run(() => shell.call('curriculum', 'completeTask', { taskId: readTask.id }))}>读完了</Button>}>
            {readTask.instructions || '告诉老师后，老师会接着安排小测。'}
          </Callout>
          <ErrorText error={finish.error} />
        </div>
      )}
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
      {data.text && <p className="la-faint la-small" style={{ marginTop: 24, textAlign: 'center' }}>选中文字可以提问、批注，或看出处与核对；指着蓝色出处标签能看原文，点开看原书。</p>}
    </Page>
  )
}
