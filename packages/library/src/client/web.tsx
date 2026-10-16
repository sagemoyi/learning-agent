// Material found online, on the 本课资料 page and in its panel: search on the learner's behalf, the third-level
// sources the teacher proposed, and a kept web page read in place. Site levels come from the host's rules.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ExternalLink, Globe, LoaderCircle, Plus, Search as SearchIcon, SearchX, Settings, ShieldCheck, X } from 'lucide-react'
import type { CitedChunk, SiteRule, Source, WebAdded, WebCandidate, WebPending, WebSearch } from '@learning-agent/contracts'
import type { LearnShell } from '@learning-agent/contracts/client'
import { Button, Callout, Disclosure, EmptyState, ErrorText, Menu, Page, PageHeader, Section, Skeleton, Tag, TextField, useAction, useLoad, type MenuEntry } from '@learning-agent/kit/client'

export const AUTHORITY_TEXT: Record<Source['authority'], string> = { '1': '一级', '2': '二级', '3': '三级', clue: '只当线索' }
const ADDED_TONE: Record<WebAdded['status'], 'ok' | 'accent' | 'warn' | 'bad'> = { added: 'ok', importing: 'accent', pending: 'accent', rejected: 'warn', failed: 'bad' }

function host(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function day(iso?: string): string | undefined {
  return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined
}

/** The address as a link that opens outside the workbench. */
function Outbound({ url, children }: { url: string; children: ReactNode }): ReactNode {
  return <a className="la-web-link" href={url} target="_blank" rel="noreferrer noopener">{children}</a>
}

/** A web search for one course: the query, its result, and what was added from it. */
function useWebSearch(courseId: string, shell: LearnShell) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<WebSearch>()
  const [added, setAdded] = useState<Record<string, WebAdded>>({})
  const search = useAction()
  const run = () => { if (query.trim()) void search.run(async () => { setAdded({}); setResult(await shell.call<WebSearch>('library', 'webSearch', { query })) }) }
  const add = async (candidate: WebCandidate) => {
    const done = await shell.call<WebAdded>('library', 'addWeb', { courseId, url: candidate.url, title: candidate.title })
    setAdded(previous => ({ ...previous, [candidate.url]: done }))
  }
  return { query, setQuery, result, added, search, run, add }
}

/** The learner searches the web for this course; 1–3 can be added, clues only open in the browser. */
export function WebFinder({ courseId, providers, shell, openSettings }: { courseId: string; providers?: readonly string[]; shell: LearnShell; openSettings(): void }): ReactNode {
  const { query, setQuery, result, added, search, run, add } = useWebSearch(courseId, shell)
  const ready = providers === undefined || providers.length > 0
  return (
    <Section title="联网找资料" icon={Globe} description="资料库里没有的内容，可以到网上找权威资料。网站的级别按规则判断：一级、二级、三级可以加入本课，百科、文库、问答这类只当线索。">
      {!ready && (
        <Callout tone="warn" title="还没有可用的搜索服务" actions={<Button size="sm" icon={Settings} onClick={openSettings}>去设置</Button>}>
          在设置页"资料服务"里填写 Exa、博查或 Tavily 的密钥。
        </Callout>
      )}
      {ready && (
        <div className="la-row nowrap">
          <div style={{ flex: 1, minWidth: 0 }}>
            <TextField size="lg" icon={SearchIcon} aria-label="联网搜索" value={query} onChange={setQuery} onEnter={run} placeholder="要找的主题，例如：离心泵 汽蚀余量 计算" />
          </div>
          <Button variant="primary" loading={search.busy} disabled={!query.trim()} onClick={run} style={{ height: 42, padding: '0 18px', borderRadius: 11 }}>搜索</Button>
        </div>
      )}
      {ready && <p className="la-faint la-small" style={{ margin: '8px 0 0' }}>只把要找的主题发给搜索服务；你的资料和学习记录不会发出去。网上的 PDF 加入后会送到 MinerU 解析。</p>}
      <div className="la-stack" style={{ gap: 10, marginTop: result || search.error ? 14 : 0 }}>
        <ErrorText error={search.error} />
        {result?.notes.map(note => <Callout key={note} tone="warn">{note}</Callout>)}
        {result && result.candidates.length === 0 && <div className="la-card"><EmptyState compact icon={SearchX} title="没有找到权威来源" description="换个说法，或者看看下面的线索里有没有可信的网站。" /></div>}
        {result?.candidates.map(candidate => (
          <CandidateCard key={candidate.url} candidate={candidate} result={added[candidate.url]} shell={shell} onAdd={() => add(candidate)} />
        ))}
        {result && result.clues.length > 0 && <Clues clues={result.clues} shell={shell} onTrusted={run} />}
      </div>
    </Section>
  )
}

function CandidateCard({ candidate, result, onAdd }: { candidate: WebCandidate; result?: WebAdded; shell: LearnShell; onAdd(): Promise<void> }): ReactNode {
  const action = useAction()
  return (
    <div className="la-card la-hit">
      <div className="la-hit-head">
        <Tag tone={candidate.authority === '3' ? 'neutral' : 'accent'} title={candidate.rule}>{AUTHORITY_TEXT[candidate.authority]} · {candidate.rule}</Tag>
        {candidate.format === 'pdf' && <Tag>PDF</Tag>}
        <span className="la-ellipsis">{candidate.site}</span>
        {day(candidate.publishedAt) && <span className="la-num">{day(candidate.publishedAt)}</span>}
      </div>
      <div className="la-strong" style={{ marginBottom: 4 }}><Outbound url={candidate.url}>{candidate.title}</Outbound></div>
      {candidate.snippet && <div className="la-muted la-small">{candidate.snippet}</div>}
      <div className="la-row" style={{ marginTop: 10 }}>
        {result
          ? <Tag tone={ADDED_TONE[result.status]} icon={result.status === 'added' ? Check : undefined}>{result.message}</Tag>
          : <Button size="sm" icon={Plus} loading={action.busy} onClick={() => void action.run(onAdd)}>加入本课</Button>}
        <ErrorText error={action.error} />
      </div>
    </div>
  )
}

/** Clues open in the browser; trusting a site re-rates the next search. */
function Clues({ clues, shell, onTrusted }: { clues: readonly WebCandidate[]; shell: LearnShell; onTrusted(): void }): ReactNode {
  const action = useAction()
  const trust = (site: string, authority: SiteRule['authority']) => action.run(async () => { await shell.call('library', 'setSiteRule', { host: site, authority }); onTrusted() })
  return (
    <Disclosure summary={`只当线索 ${clues.length} 条（不能引用）`}>
      <div className="la-rows">
        {clues.map(clue => {
          const entries: MenuEntry[] = [
            { heading: `信任 ${clue.site}` },
            { key: '2', label: '设为二级', hint: '国内高校、标准、出版社一类', onSelect: () => void trust(clue.site, '2') },
            { key: '3', label: '设为三级', hint: '加入时要你确认', onSelect: () => void trust(clue.site, '3') },
            { key: '1', label: '设为一级', hint: '你自己学校的网站', onSelect: () => void trust(clue.site, '1') },
          ]
          return (
            <div key={clue.url} className="la-row-item">
              <div className="la-row-main" style={{ gap: 2 }}>
                <span className="la-ellipsis"><Outbound url={clue.url}>{clue.title}</Outbound></span>
                <span className="la-faint la-small">{clue.site} · {clue.rule}</span>
              </div>
              <div className="la-row-end">
                <Menu align="end" width={220} entries={entries} trigger={props => <Button size="sm" variant="quiet" icon={ShieldCheck} disabled={action.busy} {...props}>信任这个网站</Button>} />
              </div>
            </div>
          )
        })}
      </div>
      <ErrorText error={action.error} />
    </Disclosure>
  )
}

/** The web search in the 本课资料 panel: one line per result (title, level, site), "+" adds it to the course. */
export function WebFinderCompact({ courseId, providers, shell, openSettings }: { courseId: string; providers?: readonly string[]; shell: LearnShell; openSettings(): void }): ReactNode {
  const { query, setQuery, result, added, search, run, add } = useWebSearch(courseId, shell)
  if (providers && providers.length === 0) {
    return <div className="la-side-empty">还没有可用的搜索服务。<button type="button" className="la-link" onClick={openSettings}>去设置填密钥</button></div>
  }
  return (
    <div className="la-lib-tool">
      <TextField icon={SearchIcon} aria-label="联网搜索" value={query} onChange={setQuery} onEnter={run} placeholder="要找的主题，回车搜索" />
      <div className="la-side-empty">只把主题发给搜索服务；网上的 PDF 加入后送 MinerU 解析。</div>
      {search.busy && <div className="la-side-empty la-row" style={{ gap: 6 }}><LoaderCircle size={13} strokeWidth={1.75} className="la-spin" />正在搜索…</div>}
      <ErrorText error={search.error} />
      {result?.notes.map(note => <div key={note} className="la-side-empty">{note}</div>)}
      {result && result.candidates.length === 0 && <div className="la-side-empty">没有找到权威来源，换个说法试试。</div>}
      {result && result.candidates.length > 0 && (
        <div className="la-tree">
          {result.candidates.map(candidate => <CompactCandidate key={candidate.url} candidate={candidate} result={added[candidate.url]} onAdd={() => add(candidate)} />)}
        </div>
      )}
      {result && result.clues.length > 0 && (
        <Disclosure summary={`只当线索 ${result.clues.length} 条（不能引用）`}>
          <div className="la-tree">
            {result.clues.map(clue => (
              <a key={clue.url} className="la-tree-item two-line" href={clue.url} target="_blank" rel="noreferrer noopener" title={clue.title}>
                <ExternalLink size={14} strokeWidth={1.75} />
                <span className="la-tree-lines"><span className="la-tree-title">{clue.title}</span><span className="la-tree-sub">{clue.site} · {clue.rule}</span></span>
              </a>
            ))}
          </div>
        </Disclosure>
      )}
    </div>
  )
}

/** One result in the panel: the title opens the page in the browser; "+" adds it. */
function CompactCandidate({ candidate, result, onAdd }: { candidate: WebCandidate; result?: WebAdded; onAdd(): Promise<void> }): ReactNode {
  const action = useAction()
  return (
    <div className="la-lib-row">
      <a className="la-tree-item two-line" href={candidate.url} target="_blank" rel="noreferrer noopener" title={candidate.snippet || candidate.title}>
        <Globe size={14} strokeWidth={1.75} />
        <span className="la-tree-lines">
          <span className="la-tree-title">{candidate.title}</span>
          <span className="la-tree-sub">{AUTHORITY_TEXT[candidate.authority]} · {candidate.site}{candidate.format === 'pdf' ? ' · PDF' : ''}</span>
          {result && <span className={`la-tree-sub la-lib-note ${ADDED_TONE[result.status]}`}>{result.message}</span>}
          {action.error && <span className="la-tree-sub la-lib-note bad">{action.error}</span>}
        </span>
      </a>
      {!result && <Button size="sm" variant="quiet" icon={Plus} loading={action.busy} aria-label="加入本课" title="加入本课" onClick={() => void action.run(onAdd)} />}
    </div>
  )
}

/** In the panel: third-level sources the teacher proposed, each confirmed or turned down in place. */
export function PendingCompact({ courseId, shell, onChange }: { courseId: string; shell: LearnShell; onChange(): void }): ReactNode {
  const pending = useLoad(shell, () => shell.call<WebPending[]>('library', 'webPending', { courseId }), [courseId])
  const [failed, setFailed] = useState<WebAdded[]>([])
  const action = useAction()
  const items = pending.data ?? []
  if (items.length === 0 && failed.length === 0) return null
  const settle = (work: () => Promise<WebAdded | void>) => action.run(async () => {
    const result = await work()
    if (result && result.status === 'failed') setFailed(previous => [...previous, result])
    pending.reload()
    onChange()
  })
  return (
    <div className="la-side-section">
      <div className="la-side-heading"><span>待你确认 · {items.length}</span></div>
      {failed.map(result => <div key={result.url} className="la-side-empty la-lib-note bad">{result.message}</div>)}
      <div className="la-tree">
        {items.map(item => (
          <div key={item.id} className="la-lib-row">
            <a className="la-tree-item two-line" href={item.url} target="_blank" rel="noreferrer noopener" title={item.reason ? `老师说：${item.reason}` : item.title}>
              <Globe size={14} strokeWidth={1.75} />
              <span className="la-tree-lines">
                <span className="la-tree-title">{item.title}</span>
                <span className="la-tree-sub">{AUTHORITY_TEXT[item.authority]} · {item.site}{item.format === 'pdf' ? ' · PDF' : ''}</span>
              </span>
            </a>
            <Button size="sm" variant="quiet" icon={Check} aria-label="确认加入" title="确认加入（下载后可以引用）" disabled={action.busy}
              onClick={() => void settle(() => shell.call<WebAdded>('library', 'confirmWeb', { id: item.id }))} />
            <Button size="sm" variant="quiet" icon={X} aria-label="不要" title="不要" disabled={action.busy}
              onClick={() => void settle(async () => { await shell.call('library', 'dismissWeb', { id: item.id }) })} />
          </div>
        ))}
      </div>
      <ErrorText error={action.error ?? pending.error} />
    </div>
  )
}

/** Third-level sources the teacher proposed; nothing is fetched until the learner confirms. */
export function PendingWeb({ courseId, shell }: { courseId: string; shell: LearnShell }): ReactNode {
  const pending = useLoad(shell, () => shell.call<WebPending[]>('library', 'webPending', { courseId }), [courseId])
  const [results, setResults] = useState<Record<string, WebAdded>>({})
  const action = useAction()
  const items = pending.data ?? []
  const failed = Object.values(results).filter(result => result.status === 'failed')
  if (items.length === 0 && failed.length === 0) return pending.error ? <ErrorText error={pending.error} /> : null
  return (
    <Section title="待你确认的网上资料" icon={Globe} count={items.length} description="老师找到的三级来源（国外开放课程、论文等）。确认后才会下载并加入本课，之后可以引用。">
      <div className="la-stack" style={{ gap: 10 }}>
        {failed.map(result => <Callout key={result.url} tone="bad">{result.message}</Callout>)}
        {items.map(item => (
          <div key={item.id} className="la-card la-hit">
            <div className="la-hit-head">
              <Tag title={item.rule}>{AUTHORITY_TEXT[item.authority]} · {item.rule}</Tag>
              {item.format === 'pdf' && <Tag>PDF</Tag>}
              <span className="la-ellipsis">{item.site}</span>
            </div>
            <div className="la-strong" style={{ marginBottom: 4 }}><Outbound url={item.url}>{item.title}</Outbound></div>
            {item.reason && <div className="la-muted la-small">老师说：{item.reason}</div>}
            <div className="la-row" style={{ marginTop: 10 }}>
              <Button size="sm" variant="primary" icon={Check} loading={action.busy} onClick={() => void action.run(async () => {
                const result = await shell.call<WebAdded>('library', 'confirmWeb', { id: item.id })
                setResults(previous => ({ ...previous, [item.id]: result }))
                pending.reload()
              })}>确认加入</Button>
              <Button size="sm" variant="quiet" icon={X} disabled={action.busy} onClick={() => void action.run(async () => { await shell.call('library', 'dismissWeb', { id: item.id }); pending.reload() })}>不要</Button>
            </div>
          </div>
        ))}
        <ErrorText error={action.error} />
      </div>
    </Section>
  )
}

/** A kept web page, read as its chunks; the cited one is marked and scrolled into view. */
export function WebPageView({ source, chunks, chunk, shell }: { source: Source; chunks: readonly CitedChunk[]; chunk?: CitedChunk; shell: LearnShell }): ReactNode {
  const marked = useRef<HTMLDivElement>(null)
  useEffect(() => { marked.current?.scrollIntoView({ block: 'center' }) }, [chunk?.id])
  if (source.origin.kind !== 'web') return null
  const fromExa = source.parser?.name === 'exa-contents'
  return (
    <Page width="reading">
      <PageHeader eyebrow={<><Globe size={14} strokeWidth={1.75} />网页</>} title={source.title}
        description={<>保存于 {day(source.origin.fetchedAt)}{fromExa ? '，这台电脑打不开原网页，正文来自 Exa 保存的副本' : ''}。网页之后可能改动，以这里保存的为出处。</>}
        meta={<><Tag tone={source.authority === '3' ? 'neutral' : 'accent'}>{AUTHORITY_TEXT[source.authority]}</Tag><span className="la-faint">{host(source.origin.url)}</span></>}
        actions={<a className="la-btn la-btn-sm" href={source.origin.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} strokeWidth={1.75} />原网页</a>} />
      <article className="la-web-page">
        {chunks.length === 0 && <Skeleton lines={4} />}
        {chunks.map(entry => {
          const current = entry.id === chunk?.id
          const text = entry.kind === 'heading' ? `${'#'.repeat(Math.min(4, entry.section.length + 1))} ${entry.text}` : entry.text
          return <div key={entry.id} ref={current ? marked : undefined} className={current ? 'la-web-block la-web-cited' : 'la-web-block'}><shell.Markdown text={text} /></div>
        })}
      </article>
    </Page>
  )
}
