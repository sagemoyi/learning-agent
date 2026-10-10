// annotation unit, browser half (docs/annotation/design.md). Two places:
// - inside the textbook reader (the `learning.reader-notes` slot): the 批注 menu next to 就这段提问, the box to write a
//   note, and the notes under each paragraph;
// - the 批注 page: every note of the course, filtered, with the way back to where it was made.
// One module-level store keeps the course's notes, so the many paragraphs of a reader share one load.
import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react'
import { BookOpen, ChevronDown, Ellipsis, Eye, EyeOff, Highlighter, Library, Lightbulb, MapPin, MessageCircleQuestion, NotebookPen, Pencil, Check, TriangleAlert, Undo2 } from 'lucide-react'
import type { Annotation, AnnotationType, FeedMessage, TextQuote } from '@learning-agent/contracts'
import type { ClientContext, IconComponent, LearnShell, ReaderNotesProps } from '@learning-agent/contracts/client'
import { Button, Callout, Checkbox, ConfirmButton, EmptyState, ErrorText, Menu, Page, PageHeader, Segmented, Select, Skeleton, Tag, TextArea, describeError, friendlyTime, useAction, useScope, useSelection, type Tone } from '@learning-agent/kit/client'
import { sendPrompt, type SessionRemote } from '@learning-agent/kit/chat'
import type { NotePlace, PlaceCandidate } from './types.ts'

export const name = 'learning-annotation'
export const inject = ['slots', 'learnShell', 'remote', 'remote.session']

let shell: LearnShell
let remote: SessionRemote

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  remote = (ctx as unknown as { remote: { session: SessionRemote } }).remote.session
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'annotation', title: '批注', icon: NotebookPen, scope: 'course', page: 'annotation.notes', order: 28 }), 'annotation: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'annotation.notes' }, NotesPage)), 'annotation: notes page')
  ctx.effect(() => ctx.slots.inject('learning.reader-notes', () => ctx.slots.register({ name: 'learning.reader-notes' }, (props: ReaderNotesProps) => <ReaderNotes {...props} />)), 'annotation: reader notes')
  // The count of notes whose place needs the learner, on the sidebar button.
  ctx.effect(() => {
    let release: (() => void) | undefined
    const follow = () => {
      release?.()
      release = undefined
      const scope = shell.scope()
      if (scope.kind !== 'course') { shell.setBadge('annotation', 0); return }
      release = subscribe(scope.courseId, () => shell.setBadge('annotation', needsYou(snapshotOf(scope.courseId).notes).length))
    }
    follow()
    const off = shell.onScope(follow)
    return () => { off(); release?.() }
  }, 'annotation: badge')
}

// ── the course's notes, loaded once and kept current ─────────────────────────

interface Snapshot {
  readonly notes: readonly Annotation[] | undefined
  readonly places: Readonly<Record<string, NotePlace>>
  readonly error: string | undefined
}

interface Store {
  snapshot: Snapshot
  readonly listeners: Set<() => void>
  generation: number
  off?: () => void
  timer?: ReturnType<typeof setTimeout>
}

const stores = new Map<string, Store>()
const EMPTY: Snapshot = { notes: undefined, places: {}, error: undefined }
/** What can move a note: its own changes, the text, what the learner did with proposals and sources. */
const RELEVANT = ['learning/annotation-changed', 'learning/doc-changed', 'learning/textbook-ready', 'learning/proposal-created', 'learning/change-applied', 'learning/source-updated']

const storeOf = (courseId: string): Store => {
  let store = stores.get(courseId)
  if (!store) stores.set(courseId, store = { snapshot: EMPTY, listeners: new Set(), generation: 0 })
  return store
}
const snapshotOf = (courseId: string): Snapshot => storeOf(courseId).snapshot

function load(courseId: string): void {
  const store = storeOf(courseId)
  const mine = ++store.generation
  const publish = (snapshot: Snapshot) => {
    if (mine !== store.generation) return
    store.snapshot = snapshot
    for (const listener of store.listeners) listener()
  }
  Promise.all([
    shell.call<Annotation[]>('annotation', 'list', { courseId, includeHidden: true }),
    shell.call<Record<string, NotePlace>>('annotation', 'places', { courseId }),
  ]).then(
    ([notes, places]) => publish({ notes, places, error: undefined }),
    (error: unknown) => publish({ ...store.snapshot, error: describeError(error) }),
  )
}

function subscribe(courseId: string, listener: () => void): () => void {
  const store = storeOf(courseId)
  store.listeners.add(listener)
  if (store.listeners.size === 1) {
    store.off = shell.onFeed((message: FeedMessage) => {
      if (!RELEVANT.includes(message.type)) return
      clearTimeout(store.timer)
      store.timer = setTimeout(() => load(courseId), 250)
    })
    load(courseId)
  }
  return () => {
    store.listeners.delete(listener)
    if (store.listeners.size > 0) return
    store.off?.()
    clearTimeout(store.timer)
    store.generation += 1
  }
}

function useCourseNotes(courseId: string): Snapshot & { reload(): void } {
  // A stable subscribe: a new function each render would unsubscribe and load again on every render.
  const follow = useCallback((listener: () => void) => subscribe(courseId, listener), [courseId])
  const snapshot = useSyncExternalStore(follow, () => snapshotOf(courseId))
  return { ...snapshot, reload: () => load(courseId) }
}

const needsYou = (notes: readonly Annotation[] | undefined): Annotation[] =>
  (notes ?? []).filter(note => !note.hiddenAt && !note.resolvedAt && note.location.status !== 'anchored')

/** The paragraph a note is shown under now: where it was found, else the one it was made on. */
const blockOf = (note: Annotation): string | undefined => note.location.blockId ?? (note.anchor.kind === 'block' ? note.anchor.blockId : undefined)

// ── the note being written ───────────────────────────────────────────────────

interface Draft {
  readonly courseId: string
  readonly blockId: string
  readonly type: AnnotationType
  readonly quote?: TextQuote
  /** One per box: pressing 保存 twice is one note. */
  readonly requestId: string
}

let draft: Draft | undefined
const draftListeners = new Set<() => void>()
const setDraft = (next: Draft | undefined) => {
  draft = next
  for (const listener of draftListeners) listener()
}
const followDraft = (listener: () => void): (() => void) => {
  draftListeners.add(listener)
  return () => { draftListeners.delete(listener) }
}
const useDraft = (): Draft | undefined => useSyncExternalStore(followDraft, () => draft)

const TYPES: Record<AnnotationType, { label: string; icon: IconComponent; tone: Tone; placeholder: string }> = {
  question: { label: '疑问', icon: MessageCircleQuestion, tone: 'accent', placeholder: '想问什么？写下来，之后可以一键转到侧边提问' },
  understanding: { label: '我的理解', icon: Lightbulb, tone: 'neutral', placeholder: '用自己的话写下你的理解' },
  highlight: { label: '重点', icon: Highlighter, tone: 'neutral', placeholder: '可以不写字，只划重点' },
  error: { label: '报错', icon: TriangleAlert, tone: 'bad', placeholder: '哪里有错？位置确定后会生成修改提案' },
}
const TYPE_ORDER = ['question', 'understanding', 'highlight', 'error'] as const

// ── inside the reader ────────────────────────────────────────────────────────

function ReaderNotes(props: ReaderNotesProps): ReactNode {
  return props.part === 'actions' ? <NoteMenu courseId={props.courseId} blockId={props.blockId} /> : <BlockNotes courseId={props.courseId} blockId={props.blockId} />
}

/** Next to 就这段提问: write a note on the selected text, or on the whole paragraph when only a click selected it. */
function NoteMenu({ courseId, blockId }: { courseId: string; blockId: string }): ReactNode {
  const selection = useSelection(shell)
  const picked = selection?.selected?.kind === 'block' && selection.selected.id === blockId ? selection.selected.quote : undefined
  return (
    <Menu align="end" width={188}
      entries={[
        { heading: picked ? '给选中的文字批注' : '给整段批注' },
        ...TYPE_ORDER.map(type => ({
          key: type, label: TYPES[type].label, icon: TYPES[type].icon,
          onSelect: () => setDraft({ courseId, blockId, type, ...(picked ? { quote: picked } : {}), requestId: globalThis.crypto.randomUUID() }),
        })),
      ]}
      trigger={props => <Button size="sm" variant="quiet" icon={NotebookPen} {...props}>批注<ChevronDown size={14} strokeWidth={1.75} /></Button>} />
  )
}

/** Under a paragraph: the box to write a note when one is being written here, then the notes already on it. */
function BlockNotes({ courseId, blockId }: { courseId: string; blockId: string }): ReactNode {
  const { notes } = useCourseNotes(courseId)
  const writing = useDraft()
  const here = (notes ?? []).filter(note => !note.hiddenAt && blockOf(note) === blockId)
  const box = writing && writing.courseId === courseId && writing.blockId === blockId ? writing : undefined
  if (!box && here.length === 0) return null
  return (
    <div className="la-notes" role="region" aria-label="这一段的批注">
      {box && <DraftBox key={box.requestId} draft={box} />}
      {here.map(note => <NoteCard key={note.id} note={note} />)}
    </div>
  )
}

function DraftBox({ draft: box }: { draft: Draft }): ReactNode {
  const [text, setText] = useState('')
  const save = useAction()
  const meta = TYPES[box.type]
  const submit = () => save.run(async () => {
    await shell.call('annotation', 'create', {
      courseId: box.courseId,
      type: box.type,
      text,
      anchor: { kind: 'block', courseId: box.courseId, blockId: box.blockId, ...(box.quote ? { quote: box.quote } : {}) },
      requestId: box.requestId,
    })
    setDraft(undefined)
  })
  return (
    <div className="la-note" role="group" aria-label={`写${meta.label}`}>
      <div className="la-note-head">
        <Tag tone={meta.tone} icon={meta.icon}>{meta.label}</Tag>
        <span className="la-faint la-small">{box.quote ? '针对选中的文字' : '针对整段'}</span>
      </div>
      {box.quote && <Quote quote={box.quote} />}
      <TextArea value={text} onChange={setText} minRows={2} maxRows={8} autoFocus aria-label={meta.label} placeholder={meta.placeholder} />
      <div className="la-note-actions">
        <Button size="sm" variant="primary" loading={save.busy} disabled={box.type !== 'highlight' && !text.trim()} onClick={() => void submit()}>保存</Button>
        <Button size="sm" variant="quiet" disabled={save.busy} onClick={() => setDraft(undefined)}>取消</Button>
      </div>
      <ErrorText error={save.error} />
    </div>
  )
}

function Quote({ quote }: { quote: TextQuote }): ReactNode {
  return <blockquote className="la-note-quote"><shell.Markdown text={quote.exact} inline /></blockquote>
}

// ── one note ─────────────────────────────────────────────────────────────────

function NoteCard({ note, place }: { note: Annotation; place?: NotePlace }): ReactNode {
  const meta = TYPES[note.type]
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(note.text)
  const edit = useAction()
  const resolve = useAction()
  const hide = useAction()
  const ask = useAction()
  const submit = useAction()
  const quote = note.anchor.quote

  const toggleHidden = () => void hide.run(() => shell.call('annotation', 'hide', { annotationId: note.id, hidden: !note.hiddenAt }))
  const askSide = () => void ask.run(async () => {
    const opened = await shell.call<{ sessionId: string; reused: boolean; question: string }>('annotation', 'ask', { annotationId: note.id })
    shell.showSideChat()
    // A chat that is still open goes on as it was; a new one starts with the learner's own question.
    if (opened.reused || !opened.question) return
    try {
      await sendPrompt(remote, opened.sessionId, opened.question)
    } catch (error) {
      throw new Error(`侧边提问已经打开，但问题没有发出去：${describeError(error)}`)
    }
  })

  return (
    <div className="la-note" role="group" aria-label={`${meta.label}批注`}>
      <div className="la-note-head">
        <Tag tone={meta.tone} icon={meta.icon}>{meta.label}</Tag>
        {note.resolvedAt && <Tag tone="ok" icon={Check}>已处理</Tag>}
        {note.proposalId && <Tag tone="ok" title="教材里的这处错误已经交给老师改">已提交修改提案</Tag>}
        {note.hiddenAt && <Tag>已隐藏</Tag>}
        <span className="la-spacer" />
        <span className="la-faint la-small">{friendlyTime(note.createdAt)}</span>
        <Menu align="end" width={160}
          entries={[
            { key: 'edit', label: '编辑', icon: Pencil, onSelect: () => { setText(note.text); setEditing(true) } },
            { key: 'hide', label: note.hiddenAt ? '取消隐藏' : '隐藏', icon: note.hiddenAt ? Eye : EyeOff, onSelect: toggleHidden },
          ]}
          trigger={props => <Button size="sm" variant="quiet" icon={Ellipsis} aria-label="更多操作" title="更多操作" {...props} />} />
      </div>
      {quote && <Quote quote={quote} />}
      {editing ? (
        <>
          <TextArea value={text} onChange={setText} minRows={2} maxRows={8} autoFocus aria-label="批注内容" placeholder={meta.placeholder} />
          <div className="la-note-actions">
            <Button size="sm" variant="primary" loading={edit.busy} disabled={note.type !== 'highlight' && !text.trim()}
              onClick={() => void edit.run(async () => { await shell.call('annotation', 'edit', { annotationId: note.id, text }); setEditing(false) })}>保存</Button>
            <Button size="sm" variant="quiet" disabled={edit.busy} onClick={() => setEditing(false)}>取消</Button>
          </div>
          <ErrorText error={edit.error} />
        </>
      ) : note.text ? <div className="la-note-text">{note.text}</div> : null}
      <LocationFix note={note} />
      <div className="la-note-actions">
        {note.type === 'question' && (
          <Button size="sm" icon={MessageCircleQuestion} loading={ask.busy} onClick={askSide}>{note.sideChatSessionId ? '回到侧边提问' : '在侧边提问'}</Button>
        )}
        {note.type === 'error' && !note.proposalId && note.anchor.kind === 'block' && note.location.status === 'anchored' && (
          <ConfirmButton size="sm" icon={TriangleAlert} loading={submit.busy} question="把这处错误交给老师改？" confirm="提交"
            onConfirm={() => void submit.run(() => shell.call('annotation', 'submitError', { annotationId: note.id }))}>提交修改提案</ConfirmButton>
        )}
        {note.type === 'error' && note.anchor.kind === 'chunk' && (
          <Button size="sm" icon={Library} onClick={() => shell.openPage('library.sources', { id: note.anchor.kind === 'chunk' ? note.anchor.chunkId : '', chunkId: note.anchor.kind === 'chunk' ? note.anchor.chunkId : '' }, { title: '出处', split: true })}>到资料库处理</Button>
        )}
        <Button size="sm" variant="quiet" icon={note.resolvedAt ? Undo2 : Check} loading={resolve.busy}
          onClick={() => void resolve.run(() => shell.call('annotation', 'resolve', { annotationId: note.id, resolved: !note.resolvedAt }))}>{note.resolvedAt ? '恢复为待处理' : '标为已处理'}</Button>
        {place && <PlaceLink place={place} />}
      </div>
      <ErrorText error={ask.error ?? submit.error ?? resolve.error ?? hide.error} />
    </div>
  )
}

function PlaceLink({ place }: { place: NotePlace }): ReactNode {
  return place.kind === 'lesson'
    ? <Button size="sm" variant="quiet" icon={BookOpen} onClick={() => shell.openPage('textbook.reader', { id: place.lessonId }, { title: '教材' })}>在教材 {place.title} 查看</Button>
    : <Button size="sm" variant="quiet" icon={Library} onClick={() => shell.openPage('library.sources', { id: place.chunkId, chunkId: place.chunkId }, { title: '出处', split: true })}>在资料 {place.title} 查看</Button>
}

/** A note whose place is unsure: what is known, and the learner's way to settle it. Nothing is moved by itself. */
function LocationFix({ note }: { note: Annotation }): ReactNode {
  const place = note.location
  const confirm = useAction()
  const pick = useAction()
  const [options, setOptions] = useState<PlaceCandidate[]>()
  if (place.status === 'anchored') return null
  if (place.status === 'original-only') {
    return <Callout tone="neutral" icon={MapPin} title="在教材里找不到这句话了">{place.reason ?? '批注和你划的原句还保留着'}</Callout>
  }
  const settle = (blockId?: string) => void confirm.run(async () => { await shell.call('annotation', 'confirm', { annotationId: note.id, ...(blockId ? { blockId } : {}) }) })
  return (
    <Callout tone="warn" icon={MapPin} title="位置待确认"
      actions={place.blockId
        ? <Button size="sm" loading={confirm.busy} onClick={() => settle()}>就是这里</Button>
        : <Button size="sm" loading={pick.busy} onClick={() => void pick.run(async () => { setOptions(await shell.call<PlaceCandidate[]>('annotation', 'candidates', { annotationId: note.id })) })}>选择所在段落</Button>}>
      {place.reason}
      {place.suggestion && <div className="la-note-suggest">现在相近的文字：「{place.suggestion}」</div>}
      {options && (
        <div className="la-note-options">
          {options.map(option => (
            <div key={option.blockId} className="la-note-option">
              <span className="la-note-option-text">{option.preview}</span>
              <Button size="sm" loading={confirm.busy} onClick={() => settle(option.blockId)}>就是这段</Button>
            </div>
          ))}
        </div>
      )}
      <ErrorText error={confirm.error ?? pick.error} />
    </Callout>
  )
}

// ── the 批注 page ─────────────────────────────────────────────────────────────

type StateFilter = 'open' | 'done' | 'all'

function NotesPage(): ReactNode {
  const scope = useScope(shell)
  if (scope.kind !== 'course') {
    return <Page><EmptyState icon={NotebookPen} title="进入一门课后查看批注" description="批注跟着课程走：在教材上选一段文字，点「批注」就能记下疑问、理解、重点或报错。" /></Page>
  }
  return <CourseNotes courseId={scope.courseId} />
}

function CourseNotes({ courseId }: { courseId: string }): ReactNode {
  const { notes, places, error } = useCourseNotes(courseId)
  const [type, setType] = useState<AnnotationType | 'all'>('all')
  const [state, setState] = useState<StateFilter>('open')
  const [unsure, setUnsure] = useState(false)
  const [hidden, setHidden] = useState(false)
  if (!notes) return <Page>{error ? <ErrorText error={error} /> : <Skeleton lines={6} title />}</Page>
  const unsureCount = needsYou(notes).length
  const shown = notes.filter(note =>
    (hidden || !note.hiddenAt)
    && (type === 'all' || note.type === type)
    && (state === 'all' || Boolean(note.resolvedAt) === (state === 'done'))
    && (!unsure || note.location.status !== 'anchored'))
  return (
    <Page>
      <PageHeader eyebrow={<><NotebookPen size={14} strokeWidth={1.75} />课程批注</>} title="批注"
        description="你在教材和资料上划的线、写的话。教材改过之后，位置对不上的批注会在这里等你确认，不会自己挂到别处。"
        meta={unsureCount > 0 ? <Tag tone="warn" pressed={unsure} onClick={() => setUnsure(on => !on)} title="原文改过、位置要你确认的批注；点一下只看这些">{unsureCount} 条位置待确认</Tag> : undefined} />
      <div className="la-stack">
        <div className="la-toolbar">
          <Select<AnnotationType | 'all'> value={type} width={132} aria-label="批注类型" onChange={setType}
            options={[{ value: 'all', label: '全部类型' }, ...TYPE_ORDER.map(item => ({ value: item, label: TYPES[item].label }))]} />
          <Segmented<StateFilter> value={state} onChange={setState} aria-label="处理状态" options={[{ value: 'open', label: '待处理' }, { value: 'done', label: '已处理' }, { value: 'all', label: '全部' }]} />
          <span className="la-spacer" />
          <Checkbox checked={hidden} onChange={setHidden}>显示已隐藏的</Checkbox>
        </div>
        <ErrorText error={error} />
        {shown.length === 0 ? (
          <div className="la-card">
            <EmptyState compact icon={NotebookPen} title={notes.length === 0 ? '还没有批注' : '没有符合条件的批注'}
              description={notes.length === 0 ? '在教材上选一段文字，点「批注」，就能记下疑问、理解、重点或报错。' : '换个类型或状态看看。'} />
          </div>
        ) : shown.map(note => <NoteCard key={note.id} note={note} {...(places[note.id] ? { place: places[note.id]! } : {})} />)}
      </div>
    </Page>
  )
}
