// textbook unit, browser half: the textbook reader. Blocks are selectable (the side chat and,
// later, annotations attach to them); citation badges open the source chunk in the library.
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, BookCheck, BookOpen, Check, ChevronDown, CircleAlert, CircleCheck, CircleDot, List, LoaderCircle, MessageCircleQuestion, PencilLine, RotateCw, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { Lesson, LessonTextbookStatus, Task } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell, SettingsAccess } from '@learning-agent/contracts/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Callout, ConfirmButton, EmptyState, ErrorText, Menu, Page, PageHeader, Section, SettingRow, Skeleton, Switch, Tag, useAction, useLoad, useSelection } from '@learning-agent/kit/client'

export const name = 'learning-textbook'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'textbook', title: '课程教材', icon: BookOpen, scope: 'course', page: 'textbook.reader', order: 20 }), 'textbook: activity')
  // Annotations are drawn by the annotation unit inside the reader; without it the slot stays empty.
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({
    name: 'learning.page',
    key: 'textbook.reader',
    children: { 'learning.reader-notes': { kind: 'single', scope: 'root' } },
  }, ReaderPage)), 'textbook: reader page')
  ctx.effect(() => ctx.slots.inject('learning.settings.services', () => ctx.slots.register({ name: 'learning.settings.services', id: 'textbook', order: 20 }, TextbookServices)), 'textbook: settings')
}

const SETTINGS = 'learning-textbook'

/** The textbook's block on the settings page: whether the check may search the web. */
function TextbookServices({ access }: { access: SettingsAccess }): ReactNode {
  const values = access.values(SETTINGS)
  const action = useAction()
  if (!values) return <Skeleton lines={2} />
  const web = values.webCheck !== false
  return (
    <Section title="教材核对" icon={ShieldCheck} description="教材发布前逐句核对出处；公式、数值和定义还要找到第二个独立来源。">
      <div className="la-settings-card">
        <SettingRow title="联网补充出处" hint="只有一个来源或找不到依据的句子，每节最多 3 句拿去联网搜索，只发这句话本身；找到的二级以上网页会加入本课资料。">
          <Switch checked={web} busy={action.busy} aria-label="联网补充出处" onChange={checked => action.run(() => access.set(SETTINGS, 'webCheck', checked ? undefined : false))} />
        </SettingRow>
      </div>
    </Section>
  )
}

/** Tags for what the check found, after the 待核实 count; the single-source one marks those paragraphs. */
function CheckTags({ status, marking, onMark }: { status: LessonTextbookStatus; marking: boolean; onMark(): void }): ReactNode {
  const check = status.check
  if (status.state !== 'ready' || !check) return null
  return (
    <>
      {check.state === 'unchecked' && <Tag tone="warn" title={check.notes.join('\n')}>出处没有核对完</Tag>}
      {check.single > 0 && (
        <Tag pressed={marking} onClick={onMark} title={marking ? '取消标出' : '公式、数值或定义只找到一个来源支持、还没有第二个独立来源的段落；点一下在正文里标出来'}>{check.single} 段只有一个来源</Tag>
      )}
      {check.stale > 0 && <Tag title="这些段落在核对之后改过，原来的核对结果不再算数">{check.stale} 段改过未重新核对</Tag>}
    </>
  )
}

/** One paragraph's check, as `textbook.checks` gives it. */
type CheckView = {
  state: 'ok' | 'single' | 'unsupported' | 'stale'
  sentences: { text: string; result: string; tone: 'ok' | 'neutral' | 'warn'; note: string; quotes: { chunkId: string; source: string; quote: string }[] }[]
  revised?: string
}

const CHECK_TITLE: Record<CheckView['state'], { icon: typeof ShieldCheck; tone: string; text: string }> = {
  ok: { icon: ShieldCheck, tone: 'ok', text: '每句都在资料里找到了依据' },
  single: { icon: ShieldCheck, tone: '', text: '公式、数值或定义只找到一个来源' },
  unsupported: { icon: CircleAlert, tone: 'warn', text: '有句子待核实，请对照原文阅读' },
  stale: { icon: PencilLine, tone: '', text: '这段在核对后改过，下面是改之前的核对结果' },
}

/** Under the selected paragraph: what the check found, sentence by sentence, with the supporting quotes. */
function BlockCheckPanel({ check, onSource }: { check: CheckView; onSource(chunkId: string): void }): ReactNode {
  const [all, setAll] = useState(false)
  const title = CHECK_TITLE[check.state]
  // Sentences fully supported fold away unless asked for: the ones to read carefully come first.
  const shown = all ? check.sentences : check.sentences.filter(sentence => sentence.tone !== 'ok')
  const folded = check.sentences.length - shown.length
  // A one-sentence paragraph is the sentence: no need to repeat it.
  const quoteSentence = check.sentences.length > 1
  return (
    <div className="la-block-check" role="note" aria-label="出处核对">
      <div className={`la-block-check-title ${title.tone}`}><title.icon size={14} strokeWidth={1.75} />{title.text}</div>
      {check.revised && <div>这段按要求改过：{check.revised}</div>}
      {shown.length > 0 && (
        <ul>
          {shown.map((sentence, index) => (
            <li key={index}>
              <span className={sentence.tone === 'warn' ? 'la-strong' : undefined}>{sentence.result}</span>
              {sentence.note && <>：<shell.Markdown text={sentence.note} inline /></>}
              {quoteSentence && <span className="la-faint">　「<shell.Markdown text={sentence.text} inline />」</span>}
              {sentence.quotes.map((quote, at) => (
                <blockquote key={at}>
                  <shell.Markdown text={quote.quote.length > 160 && !quote.quote.includes('$') ? `${quote.quote.slice(0, 158)}…` : quote.quote} inline />
                  <button type="button" className="la-cite" title={`${quote.source} · 点击查看原文`} onClick={() => onSource(quote.chunkId)}>{quote.source}</button>
                </blockquote>
              ))}
            </li>
          ))}
        </ul>
      )}
      {folded > 0 && (
        <div><Button size="sm" variant="quiet" onClick={() => setAll(true)}>{shown.length ? `看另外 ${folded} 句的原文依据` : '看原文依据'}</Button></div>
      )}
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
  const [picked, setPicked] = useState<string | undefined>(typeof params.id === 'string' ? params.id : undefined)
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
  return <Reader courseId={courseId} lessonId={lessonId} onLesson={setPicked} renderSlot={renderSlot} />
}

const LESSON_TAG: Record<Lesson['status'], ReactNode> = {
  'not-started': <Tag>未开始</Tag>,
  'in-progress': <Tag tone="accent" icon={CircleDot}>正在学</Tag>,
  done: <Tag tone="ok" icon={CircleCheck}>已完成</Tag>,
}

function Reader({ courseId, lessonId, onLesson, renderSlot }: { courseId: string; lessonId: string; onLesson(id: string): void; renderSlot: PropsRenderSlots<'learning.reader-notes'>['renderSlot'] }): ReactNode {
  // Reloads on every change-feed message, generation progress included.
  const view = useLoad(shell, () => shell.call<LessonView>('textbook', 'lesson', { lessonId }), [lessonId])
  const checks = useLoad(shell, () => shell.call<Record<string, CheckView>>('textbook', 'checks', { lessonId }), [lessonId])
  const [marking, setMarking] = useState(false)
  const tasks = useLoad(shell, () => shell.call<{ tasks: Task[] }>('curriculum', 'overview', { courseId }).then(overview => overview.tasks), [courseId])
  const selection = useSelection(shell)
  const regenerate = useAction()
  const finish = useAction()
  const body = useRef<HTMLDivElement>(null)
  const [askAt, setAskAt] = useState<number>()
  const data = view.data
  const selectedBlock = selection?.page === 'textbook.reader' && selection.selected?.kind === 'block' ? selection.selected.id : undefined

  // The selected paragraph leaves room at its bottom right for "ask about this".
  useLayoutEffect(() => {
    const container = body.current
    if (!container || !selectedBlock) { setAskAt(undefined); return }
    const place = () => {
      const block = container.querySelector<HTMLElement>(`[data-block="${CSS.escape(selectedBlock)}"]`)
      setAskAt(block ? block.offsetTop + block.offsetHeight - 40 : undefined)
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(container)
    return () => observer.disconnect()
  }, [selectedBlock, data?.text])

  // A paragraph selected from elsewhere (a note on the 批注 page) is brought into view.
  useLayoutEffect(() => {
    const block = selectedBlock ? body.current?.querySelector<HTMLElement>(`[data-block="${CSS.escape(selectedBlock)}"]`) : undefined
    const scroller = body.current?.closest('.la-page')
    if (!block || !scroller) return
    const view = scroller.getBoundingClientRect()
    const box = block.getBoundingClientRect()
    if (box.bottom < view.top || box.top > view.bottom) block.scrollIntoView({ block: 'center' })
  }, [selectedBlock, data?.text])

  if (view.error) return <Page width="reading"><ErrorText error={view.error} /></Page>
  if (!data) return <Page width="reading"><Skeleton lines={8} title /></Page>
  const index = data.siblings.findIndex(item => item.id === lessonId)
  const previous = data.siblings[index - 1]
  const next = data.siblings[index + 1]
  const running = data.status.state === 'running'
  const generate = () => void regenerate.run(() => shell.call('textbook', 'generate', { lessonId }))
  const readTask = tasks.data?.find(task => task.status === 'open' && task.kind === 'read' && task.lessonId === lessonId)
  const openSource = (chunkId: string) => shell.openPage('library.sources', { id: chunkId, chunkId }, { title: '出处', split: true })
  const go = (id: string) => {
    setMarking(false)
    onLesson(id)
    body.current?.closest('.la-page')?.scrollTo({ top: 0 })
  }
  return (
    <Page width="reading">
      <PageHeader eyebrow={<><BookOpen size={14} strokeWidth={1.75} />阶段 {data.stage.index} · {data.stage.title}</>}
        title={<>{data.lesson.number}<span style={{ marginLeft: '0.4em' }}>{data.lesson.title}</span></>}
        meta={<>
          {LESSON_TAG[data.lesson.status]}
          {data.status.state === 'ready' && data.status.unverified ? <Tag tone="warn" title="这些段落有句子没有找到资料依据，或和原文不一致，请谨慎参考">{data.status.unverified} 段待核实</Tag> : null}
          <CheckTags status={data.status} marking={marking} onMark={() => setMarking(on => !on)} />
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
        {running && <Callout tone="accent" icon={LoaderCircle} title="教材生成中">{data.status.message || '正在按设计书和资料编写这一节，写好后这里会自动出现。'}</Callout>}
        {data.status.state === 'failed' && (
          <Callout tone="bad" title="这一节没有生成成功" actions={<Button size="sm" icon={RotateCw} loading={regenerate.busy} onClick={generate}>重新生成</Button>}>{data.status.message}</Callout>
        )}
        {!data.text && !running && data.status.state !== 'failed' && (
          <div className="la-card">
            <EmptyState icon={Sparkles} title="这一节的教材还没有生成" description="教材按阶段设计书和资料编写，每段都标注出处。"
              action={<Button variant="primary" icon={Sparkles} loading={regenerate.busy} onClick={generate}>生成本节教材</Button>} />
          </div>
        )}
        <ErrorText error={regenerate.error} />
      </div>
      {data.text && (
        <div ref={body} style={{ position: 'relative', marginTop: 8 }}>
          <shell.Markdown
            text={withoutTitle(data.text, data.lesson)}
            blocks
            {...(selectedBlock ? { selectedBlock } : {})}
            // The quote is the text the learner selected inside the paragraph (none when only clicked).
            onBlock={(blockId, text, quote) => shell.select({
              page: 'textbook.reader',
              courseId: courseId as never,
              selected: { kind: 'block', id: blockId, ...(quote ? { quote } : {}), label: `${data.lesson.number} ${data.lesson.title} · ${text.replace(/\s+/g, ' ').slice(0, 18)}…` },
            })}
            onCite={openSource}
            blockClass={blockId => (marking && checks.data?.[blockId]?.state === 'single' ? 'is-marked' : undefined)}
            afterBlock={blockId => (
              <Fragment key={blockId}>
                {blockId === selectedBlock && checks.data?.[blockId] ? <BlockCheckPanel check={checks.data[blockId]!} onSource={openSource} /> : null}
                {renderSlot('learning.reader-notes', { part: 'notes', courseId, blockId }, { fallback: null })}
              </Fragment>
            )}
          />
          {askAt !== undefined && (
            <div className="la-block-ask" style={{ top: askAt }}>
              <span className="la-confirm" style={{ padding: 3, gap: 2 }}>
                <Button size="sm" variant="quiet" icon={MessageCircleQuestion} onClick={() => shell.showSideChat()}>就这段提问</Button>
                {renderSlot('learning.reader-notes', { part: 'actions', courseId, blockId: selectedBlock! }, { fallback: null })}
                <Button size="sm" variant="quiet" icon={X} aria-label="取消选中" title="取消选中" onClick={() => shell.select(undefined)} />
              </span>
            </div>
          )}
        </div>
      )}
      {data.text && readTask && (
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
            <button type="button" className="la-card interactive" style={{ textAlign: 'left', font: 'inherit', color: 'inherit' }} onClick={() => go(previous.id)}>
              <div className="la-faint la-small la-row" style={{ gap: 4 }}><ArrowLeft size={13} strokeWidth={1.75} />上一节</div>
              <div className="la-strong la-ellipsis" style={{ marginTop: 2 }}>{previous.number} {previous.title}</div>
            </button>
          ) : <span />}
          {next && (
            <button type="button" className="la-card interactive" style={{ textAlign: 'right', font: 'inherit', color: 'inherit' }} onClick={() => go(next.id)}>
              <div className="la-faint la-small la-row" style={{ gap: 4, justifyContent: 'flex-end' }}>下一节<ArrowRight size={13} strokeWidth={1.75} /></div>
              <div className="la-strong la-ellipsis" style={{ marginTop: 2 }}>{next.number} {next.title}</div>
            </button>
          )}
        </nav>
      )}
      {data.text && <p className="la-faint la-small" style={{ marginTop: 24, textAlign: 'center' }}>点一段文字或选中几个字，可以提问或批注；蓝色小标签是出处，点开看原文。</p>}
    </Page>
  )
}
