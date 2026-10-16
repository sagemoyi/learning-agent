// annotation unit, browser half (docs/annotation/design.md). Four places:
// - inside the textbook reader (the `learning.reader-notes` slot): the 批注 menu next to 就这段提问; each note's quote
//   painted in the paragraph (marks.ts), and under the paragraph one line per note that opens into the note;
// - beside a source's recognized text in the library reader (`learning.source-notes`), the same for a chunk;
// - the 批注 page: every note of the course, grouped by where it was made, with the way back there;
// - the 批注 panel in the sidebar: the same notes in short, one click back to where each was made.
// One module-level store keeps the course's notes, so the many paragraphs of a reader share one load.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { BookOpen, Check, ChevronDown, ChevronRight, Highlighter, Library, Lightbulb, MapPin, MessageCircleQuestion, NotebookPen, Pencil, RotateCcw, Trash2, TriangleAlert } from 'lucide-react'
import type { AnnotationType, FeedMessage, TextQuote } from '@learning-agent/contracts'
import type { ClientContext, IconComponent, LearnShell, ReaderNotesProps, ShellScope, SourceNotesProps } from '@learning-agent/contracts/client'
import { Button, Callout, Checkbox, ConfirmButton, EmptyState, ErrorText, Menu, Page, PageHeader, Section, Select, Skeleton, Tag, TextArea, describeError, friendlyTime, useAction, useScope, useSelection } from '@learning-agent/kit/client'
import { sendPrompt, type SessionRemote } from '@learning-agent/kit/chat'
import { paint } from './marks.ts'
import type { NotePlace, NoteView, PlaceCandidate } from './types.ts'

export const name = 'learning-annotation'
export const inject = ['slots', 'learnShell', 'remote', 'remote.session']

let shell: LearnShell
let remote: SessionRemote

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  remote = (ctx as unknown as { remote: { session: SessionRemote } }).remote.session
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'annotation', title: '批注', icon: NotebookPen, scope: 'course', page: 'annotation.notes', panel: 'annotation.list', order: 28 }), 'annotation: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'annotation.notes' }, NotesPage)), 'annotation: notes page')
  ctx.effect(() => ctx.slots.inject('learning.panel', () => ctx.slots.register({ name: 'learning.panel', key: 'annotation.list' }, NotesPanel)), 'annotation: panel')
  ctx.effect(() => ctx.slots.inject('learning.reader-notes', () => ctx.slots.register({ name: 'learning.reader-notes' }, (props: ReaderNotesProps) => <ReaderNotes {...props} />)), 'annotation: reader notes')
  ctx.effect(() => ctx.slots.inject('learning.source-notes', () => ctx.slots.register({ name: 'learning.source-notes' }, (props: SourceNotesProps) => <SourceNotes {...props} />)), 'annotation: source notes')
  // The count of notes whose place needs the learner, on the rail icon.
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
  readonly notes: readonly NoteView[] | undefined
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
/** What can move a note or change what it shows: its own changes, the text, the teacher's decision, a chat ending. */
const RELEVANT = ['learning/annotation-changed', 'learning/doc-changed', 'learning/textbook-ready', 'learning/proposal-created', 'learning/proposal-decided', 'learning/change-applied', 'learning/source-updated', 'learning/sidechat-summarized', 'learning/node-state-changed']

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
    shell.call<NoteView[]>('annotation', 'list', { courseId }),
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

function useCourseNotes(courseId: string): Snapshot {
  // A stable subscribe: a new function each render would unsubscribe and load again on every render.
  const follow = useCallback((listener: () => void) => subscribe(courseId, listener), [courseId])
  return useSyncExternalStore(follow, () => snapshotOf(courseId))
}

const needsYou = (notes: readonly NoteView[] | undefined): NoteView[] =>
  (notes ?? []).filter(note => !note.hiddenAt && !note.resolvedAt && note.location.status !== 'anchored')

/** The paragraph a note is shown under now: where it was found, else the one it was made on. */
const blockOf = (note: NoteView): string | undefined => note.location.blockId ?? (note.anchor.kind === 'block' ? note.anchor.blockId : undefined)

// ── the note being written ───────────────────────────────────────────────────

/** Where a note is written: a textbook paragraph or a source's chunk. */
type Spot = { readonly kind: 'block'; readonly blockId: string } | { readonly kind: 'chunk'; readonly chunkId: string }
const spotId = (spot: Spot) => (spot.kind === 'block' ? spot.blockId : spot.chunkId)

interface Draft {
  readonly courseId: string
  readonly spot: Spot
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

const TYPES: Record<AnnotationType, { label: string; icon: IconComponent; placeholder: string }> = {
  question: { label: '疑问', icon: MessageCircleQuestion, placeholder: '想问什么？写下来，之后可以转到侧边提问' },
  understanding: { label: '我的理解', icon: Lightbulb, placeholder: '用自己的话写下你的理解' },
  highlight: { label: '重点', icon: Highlighter, placeholder: '可以补一句为什么是重点' },
  error: { label: '报错', icon: TriangleAlert, placeholder: '哪里错了？老师会对照资料核对' },
}
const TYPE_ORDER = ['question', 'understanding', 'highlight', 'error'] as const

function TypeIcon({ type }: { type: AnnotationType }): ReactNode {
  const Icon = TYPES[type].icon
  return <Icon size={14} strokeWidth={1.75} className={`la-note-icon is-${type}`} aria-hidden />
}

/** A quote on one line: a display formula is shown inline. */
const oneLine = (text: string) => text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => `$${tex.trim()}$`).replace(/\s+/g, ' ')

// ── inside the reader ────────────────────────────────────────────────────────

function ReaderNotes(props: ReaderNotesProps): ReactNode {
  const spot: Spot = { kind: 'block', blockId: props.blockId }
  return props.part === 'actions' ? <NoteMenu courseId={props.courseId} spot={spot} /> : <SpotNotes courseId={props.courseId} spot={spot} />
}

/** Beside a source's recognized text in the library reader. */
function SourceNotes(props: SourceNotesProps): ReactNode {
  const spot: Spot = { kind: 'chunk', chunkId: props.chunkId }
  return props.part === 'actions' ? <NoteMenu courseId={props.courseId} spot={spot} /> : <SpotNotes courseId={props.courseId} spot={spot} />
}

/** Next to 就这段提问: note the selected text, or the whole paragraph (or source chunk) when it was only clicked. */
function NoteMenu({ courseId, spot }: { courseId: string; spot: Spot }): ReactNode {
  const selection = useSelection(shell)
  const picked = selection?.selected?.kind === spot.kind && selection.selected.id === spotId(spot) ? selection.selected.quote : undefined
  return (
    <Menu align="end" width={176}
      entries={[
        { heading: picked ? '给选中的文字' : spot.kind === 'block' ? '给整段' : '给这段原文' },
        ...TYPE_ORDER.map(type => ({
          key: type, label: TYPES[type].label, icon: TYPES[type].icon,
          onSelect: () => setDraft({ courseId, spot, type, ...(picked ? { quote: picked } : {}), requestId: globalThis.crypto.randomUUID() }),
        })),
      ]}
      trigger={props => <Button size="sm" variant="quiet" icon={NotebookPen} {...props}>批注<ChevronDown size={14} strokeWidth={1.75} /></Button>} />
  )
}

/**
 * The rendered text this slot follows: a reader draws the slot after the paragraph (`data-block`), the library after
 * a chunk's recognized text (`data-chunk`), inside the slot's wrapper.
 */
function textBefore(anchor: Element | null, spot: Spot): Element | undefined {
  const attribute = spot.kind === 'block' ? 'data-block' : 'data-chunk'
  for (let level = anchor; level; level = level.parentElement) {
    for (let at = level.previousElementSibling; at; at = at.previousElementSibling) {
      if (at.getAttribute(attribute) === spotId(spot)) return at
    }
    if (level.classList.contains('la-md') || level.classList.contains('la-cite-card')) return undefined
  }
  return undefined
}

const onSpot = (note: NoteView, spot: Spot) => (spot.kind === 'block' ? blockOf(note) === spot.blockId : note.anchor.kind === 'chunk' && note.anchor.chunkId === spot.chunkId)

/** Under a paragraph or chunk: the box being written here, then one line per note; their quotes are painted in the text. */
function SpotNotes({ courseId, spot }: { courseId: string; spot: Spot }): ReactNode {
  const { notes } = useCourseNotes(courseId)
  const writing = useDraft()
  const owner = useId()
  const anchor = useRef<HTMLDivElement>(null)
  const id = spotId(spot)
  const here = useMemo(() => (notes ?? []).filter(note => !note.hiddenAt && onSpot(note, spot)), [notes, spot.kind, id])
  const marks = useMemo(() => here.flatMap(note => (
    note.anchor.quote && note.location.status === 'anchored' && !note.resolvedAt ? [{ type: note.type, quote: note.anchor.quote }] : []
  )), [here])

  useLayoutEffect(() => {
    const text = textBefore(anchor.current, spot)
    if (!text || marks.length === 0) return
    let erase = paint(owner, text, marks)
    // The text's HTML is replaced when it changes: paint the new one.
    const observer = new MutationObserver(() => { erase(); erase = paint(owner, text, marks) })
    observer.observe(text, { childList: true, subtree: true, characterData: true })
    return () => { observer.disconnect(); erase() }
  }, [owner, spot.kind, id, marks])

  const box = writing && writing.courseId === courseId && writing.spot.kind === spot.kind && spotId(writing.spot) === id ? writing : undefined
  if (!box && here.length === 0) return null
  return (
    <div ref={anchor} className="la-notes" role="region" aria-label="这一段的批注">
      {box && <DraftBox key={box.requestId} draft={box} />}
      {here.map(note => <NoteLine key={note.id} note={note} />)}
    </div>
  )
}

function DraftBox({ draft: box }: { draft: Draft }): ReactNode {
  const [text, setText] = useState('')
  const save = useAction()
  const meta = TYPES[box.type]
  const quick = box.type === 'highlight'
  const submit = () => save.run(async () => {
    await shell.call('annotation', 'create', {
      courseId: box.courseId,
      type: box.type,
      text,
      anchor: { ...box.spot, courseId: box.courseId, ...(box.quote ? { quote: box.quote } : {}) },
      requestId: box.requestId,
    })
    setDraft(undefined)
  })
  // A highlight is saved at once; a note can be added to it later. Sending twice is one note (same request id).
  useEffect(() => { if (quick) void submit() }, [])
  if (quick && !save.error) return null
  return (
    <div className="la-note is-draft" role="group" aria-label={meta.label}>
      <div className="la-note-head">
        <TypeIcon type={box.type} />
        <span className="la-note-kind">{meta.label}</span>
        <span className="la-faint">{box.quote ? '选中的文字' : box.spot.kind === 'block' ? '整段' : '这段原文'}</span>
      </div>
      <div className="la-note-body">
        {box.quote && <Quote quote={box.quote} />}
        {!quick && <TextArea value={text} onChange={setText} minRows={2} maxRows={8} autoFocus aria-label={meta.label} placeholder={meta.placeholder} />}
        <div className="la-note-actions">
          {!quick && <Button size="sm" variant="primary" loading={save.busy} disabled={!text.trim()} onClick={() => void submit()}>保存</Button>}
          {quick && <Button size="sm" loading={save.busy} onClick={() => void submit()}>重试</Button>}
          <Button size="sm" variant="quiet" disabled={save.busy} onClick={() => setDraft(undefined)}>取消</Button>
        </div>
        <ErrorText error={save.error} />
      </div>
    </div>
  )
}

function Quote({ quote }: { quote: TextQuote }): ReactNode {
  return <blockquote className="la-note-quote"><shell.Markdown text={oneLine(quote.exact)} inline /></blockquote>
}

/** One note under its paragraph: a line that opens into the note. */
function NoteLine({ note }: { note: NoteView }): ReactNode {
  const [open, setOpen] = useState(false)
  const quote = note.anchor.quote
  return (
    <div className={`la-note-line${open ? ' is-open' : ''}${note.resolvedAt ? ' is-settled' : ''}`}>
      <button type="button" className="la-note-row" aria-expanded={open} onClick={() => setOpen(on => !on)}>
        <TypeIcon type={note.type} />
        <span className="la-note-row-text">
          {note.text || (quote ? <shell.Markdown text={oneLine(quote.exact)} inline /> : TYPES[note.type].label)}
        </span>
        <NoteState note={note} />
        <ChevronDown size={14} strokeWidth={1.75} className="la-note-chevron" aria-hidden />
      </button>
      {open && <NoteBody note={note} showQuote={note.location.status !== 'anchored'} showText={false} />}
    </div>
  )
}

/** A few words on where the note stands, when there is something to say. */
function NoteState({ note }: { note: NoteView }): ReactNode {
  // The teacher's fix usually rewords the sentence, so its outcome comes before the place.
  if (note.proposal?.status === 'applied') return <Tag tone="ok" icon={Check}>老师已改正</Tag>
  if (note.proposal?.status === 'rejected') return <Tag>老师核对后没改</Tag>
  if (note.location.status !== 'anchored') return <Tag tone="warn" icon={MapPin}>{note.location.status === 'original-only' ? '原句不在了' : '位置待确认'}</Tag>
  if (note.proposal?.status === 'open') return <Tag tone="accent">等老师核对</Tag>
  if (note.resolvedAt && note.type === 'question') return <Tag tone="ok" icon={Check}>已解决</Tag>
  return null
}

// ── one note, opened ─────────────────────────────────────────────────────────

/**
 * `showText`: false where the line above already shows the note in full; `place`: the way to where it was made (the
 * 批注 page), whose card head shows the time instead.
 */
function NoteBody({ note, showQuote, showText = true, place }: { note: NoteView; showQuote: boolean; showText?: boolean; place?: NotePlace }): ReactNode {
  const meta = TYPES[note.type]
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(note.text)
  const edit = useAction()
  const resolve = useAction()
  const remove = useAction()
  const ask = useAction()
  const submit = useAction()
  const quote = note.anchor.quote

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
    <div className="la-note-body">
      {showQuote && quote && <Quote quote={quote} />}
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
      ) : showText && note.text ? <div className="la-note-text">{note.text}</div> : null}
      <LocationFix note={note} />
      <ProposalOutcome note={note} />
      <FollowUp note={note} />
      {!editing && (
        <div className="la-note-actions">
          {note.type === 'question' && !note.resolvedAt && (
            <Button size="sm" icon={MessageCircleQuestion} loading={ask.busy} onClick={askSide}>{note.chatOpen ? '回到侧边提问' : '在侧边提问'}</Button>
          )}
          {note.type === 'understanding' && (
            <Button size="sm" icon={MessageCircleQuestion} loading={ask.busy} title="在侧边提问里请老师对照资料看看这条理解，指出缺的条件" onClick={askSide}>{note.chatOpen ? '回到侧边提问' : '请老师看看'}</Button>
          )}
          {note.type === 'error' && !note.proposalId && note.anchor.kind === 'block' && note.location.status === 'anchored' && (
            <ConfirmButton size="sm" icon={TriangleAlert} loading={submit.busy} question="交给老师核对？" confirm="交给老师"
              onConfirm={() => void submit.run(() => shell.call('annotation', 'submitError', { annotationId: note.id }))}>交给老师核对</ConfirmButton>
          )}
          {note.type === 'error' && note.anchor.kind === 'chunk' && (
            <Button size="sm" icon={Library} onClick={() => note.anchor.kind === 'chunk' && shell.openPage('library.sources', { chunkId: note.anchor.chunkId }, { title: '出处', side: true })}>到资料库处理</Button>
          )}
          {note.type === 'question' && (
            <Button size="sm" variant="quiet" icon={note.resolvedAt ? RotateCcw : Check} loading={resolve.busy}
              onClick={() => void resolve.run(() => shell.call('annotation', 'resolve', { annotationId: note.id, resolved: !note.resolvedAt }))}>{note.resolvedAt ? '重新打开' : '已解决'}</Button>
          )}
          <span className="la-spacer" />
          {!place && <span className="la-faint la-small">{friendlyTime(note.createdAt)}</span>}
          {place && note.location.status !== 'original-only' && (
            <Button size="sm" variant="quiet" icon={place.kind === 'lesson' ? BookOpen : Library} opens onClick={() => openPlace(place, note)}>{place.kind === 'lesson' ? '在教材里看' : '在资料里看'}</Button>
          )}
          <Button size="sm" variant="quiet" icon={Pencil} onClick={() => { setText(note.text); setEditing(true) }}>{note.text ? '编辑' : '写一句'}</Button>
          <ConfirmButton size="sm" variant="quiet" icon={Trash2} loading={remove.busy} question="删除这条批注？" confirm="删除"
            onConfirm={() => void remove.run(() => shell.call('annotation', 'hide', { annotationId: note.id, hidden: true }))}>删除</ConfirmButton>
        </div>
      )}
      <ErrorText error={ask.error ?? submit.error ?? resolve.error ?? remove.error} />
    </div>
  )
}

/** What the side chat about the note concluded, and what later answers say about the misconceptions it recorded. */
function FollowUp({ note }: { note: NoteView }): ReactNode {
  const follow = note.followUp
  if (!follow || (follow.conclusions.length === 0 && follow.misconceptions.length === 0)) return null
  return (
    <div className="la-note-follow">
      {follow.conclusions.length > 0 && <>
        <div className="la-faint la-small">侧边提问的结论</div>
        <ul>{follow.conclusions.map(item => <li key={item}><shell.Markdown text={item} inline /></li>)}</ul>
      </>}
      {follow.misconceptions.length > 0 && <>
        <div className="la-faint la-small">记下的可能误解</div>
        <ul>{follow.misconceptions.map(item => <li key={item}><shell.Markdown text={item} inline /></li>)}</ul>
      </>}
      {follow.checks.map(check => (
        <div key={check.title} className="la-row la-small" style={{ gap: 6, alignItems: 'baseline' }}>
          <Tag tone={check.settled ? 'ok' : 'warn'} icon={check.settled ? Check : undefined}>{check.title}</Tag>
          <span className={check.settled ? '' : 'la-muted'}>{check.text}</span>
        </div>
      ))}
    </div>
  )
}

/** What the teacher did with an error report. */
function ProposalOutcome({ note }: { note: NoteView }): ReactNode {
  const proposal = note.proposal
  if (!proposal) return null
  if (proposal.status === 'applied') return <Callout tone="ok" title="老师核对后改正了">{proposal.note}</Callout>
  if (proposal.status === 'rejected') return <Callout tone="neutral" title="老师核对后没有改">{proposal.note}</Callout>
  if (proposal.status === 'open') return <p className="la-note-hint">已交给老师：对照资料核对后，改正或说明理由，结果会显示在这里。</p>
  return null
}

/** A note whose place is unsure: what is known, and the learner's way to settle it. Nothing is moved by itself. */
function LocationFix({ note }: { note: NoteView }): ReactNode {
  const place = note.location
  const confirm = useAction()
  const pick = useAction()
  const [options, setOptions] = useState<PlaceCandidate[]>()
  // A reported error the teacher decided: the sentence moved because of the fix, nothing to settle.
  if (place.status === 'anchored' || (note.proposal && note.proposal.status !== 'open')) return null
  if (place.status === 'original-only') {
    return <Callout tone="neutral" icon={MapPin} title="教材里找不到这句话了">{place.reason ?? '批注和你划的原句还保留着'}</Callout>
  }
  const settle = (blockId?: string) => void confirm.run(async () => { await shell.call('annotation', 'confirm', { annotationId: note.id, ...(blockId ? { blockId } : {}) }) })
  return (
    <Callout tone="warn" icon={MapPin} title="位置待确认"
      actions={place.blockId
        ? <Button size="sm" loading={confirm.busy} onClick={() => settle()}>就是这里</Button>
        : <Button size="sm" loading={pick.busy} onClick={() => void pick.run(async () => { setOptions(await shell.call<PlaceCandidate[]>('annotation', 'candidates', { annotationId: note.id })) })}>选择所在段落</Button>}>
      {place.reason}
      {place.suggestion && <div className="la-note-suggest">现在相近的文字：<shell.Markdown text={oneLine(place.suggestion)} inline /></div>}
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

function NotesPage(): ReactNode {
  const scope = useScope(shell)
  if (scope.kind !== 'course') {
    return <Page><EmptyState icon={NotebookPen} title="进入一门课后查看批注" description="批注跟着课程走：在教材上选一段文字，点「批注」就能记下疑问、理解、重点或报错。" /></Page>
  }
  return <CourseNotes courseId={scope.courseId} />
}

interface Group {
  readonly key: string
  readonly place: NotePlace | undefined
  readonly notes: NoteView[]
}

/** Notes by where they were made: lessons in order, then sources, then those whose place is gone. */
function groupsOf(notes: readonly NoteView[], places: Readonly<Record<string, NotePlace>>): Group[] {
  const groups = new Map<string, Group>()
  for (const note of notes) {
    const place = places[note.id]
    const key = place ? (place.kind === 'lesson' ? `lesson:${place.lessonId}` : `source:${place.title}`) : 'none'
    const group = groups.get(key) ?? { key, place, notes: [] }
    group.notes.push(note)
    groups.set(key, group)
  }
  const rank = (group: Group) => (group.place?.kind === 'lesson' ? 0 : group.place ? 1 : 2)
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || (a.place?.title ?? '').localeCompare(b.place?.title ?? '', 'zh-CN', { numeric: true }))
}

function openPlace(place: NotePlace, note?: NoteView): void {
  if (place.kind === 'source') {
    shell.openPage('library.sources', { chunkId: place.chunkId }, { title: '出处', side: true })
    return
  }
  shell.openPage('textbook.reader', { id: place.lessonId }, { title: '教材' })
  // Selecting the paragraph scrolls the reader to it.
  const blockId = note && blockOf(note)
  if (note && blockId) {
    shell.select({ page: 'textbook.reader', courseId: note.courseId, selected: { kind: 'block', id: blockId, ...(note.anchor.quote ? { quote: note.anchor.quote } : {}), label: `${place.title} · 批注` } })
  }
}

function CourseNotes({ courseId }: { courseId: string }): ReactNode {
  const { notes, places, error } = useCourseNotes(courseId)
  const [type, setType] = useState<AnnotationType | 'all'>('all')
  const [settled, setSettled] = useState(false)
  const [unsure, setUnsure] = useState(false)
  if (!notes) return <Page>{error ? <ErrorText error={error} /> : <Skeleton lines={6} title />}</Page>
  const kept = notes.filter(note => !note.hiddenAt)
  const unsureCount = needsYou(kept).length
  const shown = kept.filter(note =>
    (type === 'all' || note.type === type)
    && (settled || !(note.type === 'question' && note.resolvedAt))
    && (!unsure || note.location.status !== 'anchored'))
  return (
    <Page>
      <PageHeader eyebrow={<><NotebookPen size={14} strokeWidth={1.75} />课程批注</>} title="批注"
        description="你在教材上划的重点、写的疑问和理解。教材改过之后，对不上位置的批注会在这里等你确认，不会自己挂到别处。"
        meta={unsureCount > 0 ? <Tag tone="warn" icon={MapPin} pressed={unsure} onClick={() => setUnsure(on => !on)} title="原文改过、位置要你确认的批注；点一下只看这些">{unsureCount} 条位置待确认</Tag> : undefined} />
      <div className="la-stack">
        <div className="la-toolbar">
          <Select<AnnotationType | 'all'> value={type} width={132} aria-label="批注类型" onChange={setType}
            options={[{ value: 'all', label: '全部类型' }, ...TYPE_ORDER.map(item => ({ value: item, label: TYPES[item].label }))]} />
          <span className="la-spacer" />
          <Checkbox checked={settled} onChange={setSettled}>显示已解决的疑问</Checkbox>
        </div>
        <ErrorText error={error} />
        {shown.length === 0 ? (
          <div className="la-card">
            <EmptyState compact icon={NotebookPen} title={kept.length === 0 ? '还没有批注' : '没有符合条件的批注'}
              description={kept.length === 0 ? '在教材上选中一段文字，点「批注」，就能记下疑问、理解、重点或报错。' : '换个类型，或者勾上"显示已解决的疑问"。'} />
          </div>
        ) : groupsOf(shown, places).map(group => (
          <Section key={group.key} icon={group.place?.kind === 'source' ? Library : BookOpen} count={group.notes.length}
            title={group.place ? group.place.title : '找不到所在课时'}
            actions={group.place ? <Button size="sm" variant="quiet" opens onClick={() => openPlace(group.place!)}>{group.place.kind === 'lesson' ? '打开教材' : '打开资料'}</Button> : undefined}>
            <div className="la-note-list">
              {group.notes.map(note => <NoteCard key={note.id} note={note} place={group.place} />)}
            </div>
          </Section>
        ))}
      </div>
    </Page>
  )
}

/** The 批注 panel: open notes by where they were made (settled questions left out); a click goes back there. */
function NotesPanel({ scope }: { scope: ShellScope }): ReactNode {
  return scope.kind === 'course' ? <PanelNotes courseId={scope.courseId} /> : null
}

function PanelNotes({ courseId }: { courseId: string }): ReactNode {
  const { notes, places, error } = useCourseNotes(courseId)
  if (!notes) return error ? <ErrorText error={error} /> : <Skeleton lines={3} />
  const kept = notes.filter(note => !note.hiddenAt && !(note.type === 'question' && note.resolvedAt))
  return (
    <>
      {kept.length === 0 && <div className="la-side-empty">在教材上选中一段文字，点「批注」，就能记下疑问、理解、重点或报错。</div>}
      {groupsOf(kept, places).map(group => (
        <div key={group.key} className="la-side-section">
          <div className="la-side-heading"><span>{group.place ? group.place.title : '找不到所在课时'}</span></div>
          <div className="la-tree">
            {group.notes.map(note => (
              <button key={note.id} type="button" className="la-tree-item two-line" data-la-opens="" disabled={!group.place}
                onClick={() => { if (group.place) openPlace(group.place, note) }}>
                <TypeIcon type={note.type} />
                <span className="la-tree-lines">
                  <span className="la-tree-title">{note.text.trim() || oneLine(note.anchor.quote?.exact ?? TYPES[note.type].label)}</span>
                  <span className="la-tree-sub">{TYPES[note.type].label}{note.location.status !== 'anchored' ? ' · 位置待确认' : ''} · {friendlyTime(note.createdAt)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="la-side-foot">
        <button type="button" className="la-link" data-la-opens="" onClick={() => shell.openPage('annotation.notes', {}, { title: '批注' })}>全部批注<ChevronRight size={13} strokeWidth={1.75} /></button>
      </div>
    </>
  )
}

/** A note on the 批注 page: always open, with its quote and the way to where it was made. */
function NoteCard({ note, place }: { note: NoteView; place: NotePlace | undefined }): ReactNode {
  return (
    <div className={`la-note${note.resolvedAt ? ' is-settled' : ''}`} role="group" aria-label={`${TYPES[note.type].label}批注`}>
      <div className="la-note-head">
        <TypeIcon type={note.type} />
        <span className="la-note-kind">{TYPES[note.type].label}</span>
        <NoteState note={note} />
        <span className="la-spacer" />
        <span className="la-faint la-small">{friendlyTime(note.createdAt)}</span>
      </div>
      <NoteBody note={note} showQuote {...(place ? { place } : {})} />
    </div>
  )
}
