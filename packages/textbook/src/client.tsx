// textbook unit, browser half: the textbook reader. Blocks are selectable (the side chat and,
// later, annotations attach to them); citation badges open the source chunk in the library.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, BookCheck, BookOpen, Check, ChevronDown, CircleCheck, CircleDot, List, LoaderCircle, MessageCircleQuestion, RotateCw, ShieldCheck, Sparkles, X } from 'lucide-react'
import type { Lesson, LessonTextbookStatus, Task } from '@learning-agent/contracts'
import type { ClientContext, LearningPageProps, LearnShell, SettingsAccess } from '@learning-agent/contracts/client'
import { Button, Callout, ConfirmButton, EmptyState, ErrorText, Menu, Page, PageHeader, Section, SettingRow, Skeleton, Switch, Tag, useAction, useLoad, useSelection } from '@learning-agent/kit/client'

export const name = 'learning-textbook'
export const inject = ['slots', 'learnShell']

let shell: LearnShell

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'textbook', title: '课程教材', icon: BookOpen, scope: 'course', page: 'textbook.reader', order: 20 }), 'textbook: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({ name: 'learning.page', key: 'textbook.reader' }, ReaderPage)), 'textbook: reader page')
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

/** Tags for what the check found, after the 待核实 count. */
function CheckTags({ status }: { status: LessonTextbookStatus }): ReactNode {
  const check = status.check
  if (status.state !== 'ready' || !check) return null
  return (
    <>
      {check.state === 'unchecked' && <Tag tone="warn" title={check.notes.join('\n')}>出处没有核对完</Tag>}
      {check.single > 0 && <Tag title="这些段落的公式、数值或定义只找到一个来源支持，还没有第二个独立来源">{check.single} 段只有一个来源</Tag>}
      {check.stale > 0 && <Tag title="这些段落在核对之后改过，原来的核对结果不再算数">{check.stale} 段改过未重新核对</Tag>}
    </>
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

function ReaderPage({ scope, params }: LearningPageProps): ReactNode {
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
  return <Reader courseId={courseId} lessonId={lessonId} onLesson={setPicked} />
}

const LESSON_TAG: Record<Lesson['status'], ReactNode> = {
  'not-started': <Tag>未开始</Tag>,
  'in-progress': <Tag tone="accent" icon={CircleDot}>正在学</Tag>,
  done: <Tag tone="ok" icon={CircleCheck}>已完成</Tag>,
}

function Reader({ courseId, lessonId, onLesson }: { courseId: string; lessonId: string; onLesson(id: string): void }): ReactNode {
  // Reloads on every change-feed message, generation progress included.
  const view = useLoad(shell, () => shell.call<LessonView>('textbook', 'lesson', { lessonId }), [lessonId])
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

  if (view.error) return <Page width="reading"><ErrorText error={view.error} /></Page>
  if (!data) return <Page width="reading"><Skeleton lines={8} title /></Page>
  const index = data.siblings.findIndex(item => item.id === lessonId)
  const previous = data.siblings[index - 1]
  const next = data.siblings[index + 1]
  const running = data.status.state === 'running'
  const generate = () => void regenerate.run(() => shell.call('textbook', 'generate', { lessonId }))
  const readTask = tasks.data?.find(task => task.status === 'open' && task.kind === 'read' && task.lessonId === lessonId)
  const go = (id: string) => {
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
          <CheckTags status={data.status} />
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
            onBlock={(blockId, text) => shell.select({
              page: 'textbook.reader',
              courseId: courseId as never,
              selected: { kind: 'block', id: blockId, quote: { exact: text.slice(0, 200), prefix: '', suffix: '' }, label: `${data.lesson.number} ${data.lesson.title} · ${text.replace(/\s+/g, ' ').slice(0, 18)}…` },
            })}
            onCite={chunkId => shell.openPage('library.sources', { id: chunkId, chunkId }, { title: '出处', split: true })}
          />
          {askAt !== undefined && (
            <div className="la-block-ask" style={{ top: askAt }}>
              <span className="la-confirm" style={{ padding: 3, gap: 2 }}>
                <Button size="sm" variant="quiet" icon={MessageCircleQuestion} onClick={() => shell.showSideChat()}>就这段提问</Button>
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
      {data.text && <p className="la-faint la-small" style={{ marginTop: 24, textAlign: 'center' }}>点一段文字，可以针对它提问；蓝色小标签是出处，点开看原文。</p>}
    </Page>
  )
}
