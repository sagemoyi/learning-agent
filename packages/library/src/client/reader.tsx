// Original-PDF reader: one source, optionally opened at a cited chunk with its area marked. Fills its
// tab: a toolbar, the page on a grey stage, and an aside with the cited text, chapter jump and
// page-number correction.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { CitedChunk, Source } from '@learning-agent/contracts'
import type { LearnShell } from '@learning-agent/contracts/client'
import { ChevronLeft, ChevronRight, ExternalLink, FileText, LoaderCircle, RotateCw, ZoomIn, ZoomOut } from 'lucide-react'
import { Button, Callout, Disclosure, EmptyState, ErrorText, NumberField, Page, PageHeader, Select, Skeleton, Tag, useAction, useLoad } from '@learning-agent/kit/client'
import { citationRectangle } from './geometry.ts'
import { WebPageView } from './web.tsx'

GlobalWorkerOptions.workerSrc = '/api/learning/library.pdfAsset?file=pdf.worker.min.mjs'

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2]
/** `auto` fits the page to the pane, between 40% and 125%, so a split pane shows the whole width. */
type Zoom = number | 'auto'
const CHUNK_KIND: Record<string, string> = { heading: '标题', text: '正文', formula: '公式', table: '表格', figure: '图', example: '例题', exercise: '习题', answer: '答案' }

export function Reader({ sourceId, chunk, shell }: { sourceId: string; chunk?: CitedChunk; shell: LearnShell }): ReactNode {
  const info = useLoad(shell, () => shell.call<{ source: Source; outline: { section: string[]; chunkId: string }[]; chunks?: CitedChunk[] }>('library', 'document', { sourceId }), [sourceId])
  const offsetAction = useAction()
  const [printedPage, setPrintedPage] = useState(1)
  const [pdf, setPdf] = useState<PDFDocumentProxy>()
  const [page, setPage] = useState(chunk?.locator.page ?? 1)
  const [zoom, setZoom] = useState<Zoom>('auto')
  const [scale, setScale] = useState(1)
  const [stageWidth, setStageWidth] = useState(0)
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null)
  const [rotation, setRotation] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [rectangle, setRectangle] = useState<ReturnType<typeof citationRectangle>>()
  const canvas = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement | null>(null)
  const url = `/api/learning/library.original?sourceId=${encodeURIComponent(sourceId)}`
  const source = info.data?.source
  const isPdf = source?.origin.kind === 'file' ? /\.pdf$/i.test(source.origin.fileName) : source?.origin.format === 'pdf'

  useEffect(() => {
    setPage(chunk?.locator.page ?? 1)
    setPdf(undefined)
    setError('')
    if (!isPdf) return
    const loading = getDocument({ url, cMapUrl: '/api/learning/library.pdfAsset?file=cmaps/', cMapPacked: true, standardFontDataUrl: '/api/learning/library.pdfAsset?file=standard_fonts/', wasmUrl: '/api/learning/library.pdfAsset?file=wasm/' })
    let active = true
    loading.promise.then(doc => { if (active) setPdf(doc) }).catch(e => { if (active) setError(`原 PDF 无法打开：${e.message}`) })
    return () => { active = false; void loading.destroy() }
  }, [sourceId, url, isPdf])

  useEffect(() => { if (chunk) setPage(chunk.locator.page) }, [chunk?.id])

  // The pane's width, for automatic zoom (settled, so dragging a split does not re-render every pixel).
  useEffect(() => {
    if (!stageElement) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(entries => {
      clearTimeout(timer)
      timer = setTimeout(() => setStageWidth(Math.round(entries[0]!.contentRect.width)), 120)
    })
    observer.observe(stageElement)
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [stageElement])
  const fitWidth = zoom === 'auto' ? stageWidth : 0

  useEffect(() => {
    if (!pdf || !canvas.current) return
    let active = true
    let cancel: (() => void) | undefined
    setBusy(true)
    setRectangle(undefined)
    pdf.getPage(page).then(async entry => {
      if (!active || !canvas.current) return
      const turn = (entry.rotate + rotation) % 360
      const natural = entry.getViewport({ scale: 1, rotation: turn }).width
      const effective = zoom !== 'auto' ? zoom : fitWidth > 0 ? Math.min(1.25, Math.max(0.4, fitWidth / natural)) : 1
      setScale(effective)
      const viewport = entry.getViewport({ scale: effective, rotation: turn })
      const target = canvas.current
      const dpr = window.devicePixelRatio || 1
      target.width = Math.ceil(viewport.width * dpr)
      target.height = Math.ceil(viewport.height * dpr)
      target.style.width = `${viewport.width}px`
      target.style.height = `${viewport.height}px`
      const render = entry.render({ canvas: target, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] })
      cancel = () => render.cancel()
      await render.promise
      if (active) {
        const marked = chunk?.locator.page === page ? citationRectangle(chunk.locator, entry.view, rect => {
          const [a, b, c, d, e, f] = viewport.transform as [number, number, number, number, number, number]
          return [a * rect[0]! + c * rect[1]! + e, b * rect[0]! + d * rect[1]! + f, a * rect[2]! + c * rect[3]! + e, b * rect[2]! + d * rect[3]! + f]
        }, entry.rotate) : undefined
        setRectangle(marked)
        setError('')
        // Bring the cited area into view.
        if (marked && stage.current) stage.current.scrollTo({ top: Math.max(0, marked.top - 80), behavior: 'smooth' })
      }
    }).catch(e => { if (active && e.name !== 'RenderingCancelledException') setError(`页面无法显示：${e.message}`) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false; cancel?.() }
  }, [pdf, page, zoom, fitWidth, rotation, chunk?.id])

  if (info.error) return <Page><ErrorText error={info.error} /></Page>
  if (!info.data) return <Page><Skeleton lines={4} title /></Page>
  if (source?.origin.kind === 'web' && !isPdf) return <WebPageView source={source} chunks={info.data.chunks ?? []} chunk={chunk} shell={shell} />
  if (!isPdf) {
    return (
      <Page width="reading">
        <PageHeader eyebrow={<><FileText size={14} strokeWidth={1.75} />原文</>} title={source?.title ?? '原文'}
          description="这份资料的原件不是 PDF，下面是解析出的文字。其他格式的原文阅读之后支持。" />
        {chunk ? <div className="la-card"><CiteCard chunk={chunk} shell={shell} /></div> : <EmptyState icon={FileText} title="没有可显示的原件" description="可以在资料库里检索这份资料的内容片段。" />}
      </Page>
    )
  }

  const printed = page - (source?.pageOffset ?? 0)
  const smaller = [...ZOOMS].reverse().find(n => n < scale - 0.01)
  const larger = ZOOMS.find(n => n > scale + 0.01)
  const zoomChoices = [{ value: 'auto', label: `自动 ${Math.round(scale * 100)}%`, hint: '按窗格宽度缩放' }, ...ZOOMS.map(n => ({ value: String(n), label: `${n * 100}%` }))]
  const outline = info.data.outline
  return (
    <div className="la-reader">
      <div className="la-reader-bar">
        <span className="la-reader-title" title={source?.title}><FileText size={16} strokeWidth={1.75} /><span>{source?.title ?? '原文'}</span></span>
        <span className="la-toolbar">
          <span className="la-toolbar-group">
            <Button size="sm" variant="quiet" icon={ChevronLeft} aria-label="上一页" title="上一页" disabled={!pdf || page <= 1} onClick={() => setPage(p => p - 1)} />
            <NumberField aria-label="PDF 页码" width={88} value={page} min={1} max={pdf?.numPages ?? page} onChange={setPage} />
            <Button size="sm" variant="quiet" icon={ChevronRight} aria-label="下一页" title="下一页" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(p => p + 1)} />
            <span className="la-reader-pages">/ {pdf?.numPages ?? '…'}{printed > 0 ? ` · 书上 p.${printed}` : ' · 前言/封面'}</span>
          </span>
          <span className="la-toolbar-sep la-wide-only" />
          <span className="la-toolbar-group">
            <Button size="sm" variant="quiet" className="la-wide-only" icon={ZoomOut} aria-label="缩小" title="缩小" disabled={smaller === undefined} onClick={() => { if (smaller !== undefined) setZoom(smaller) }} />
            <Select aria-label="缩放" width={zoom === 'auto' ? 112 : 84} value={String(zoom)} options={zoomChoices} onChange={value => setZoom(value === 'auto' ? 'auto' : Number(value))} />
            <Button size="sm" variant="quiet" className="la-wide-only" icon={ZoomIn} aria-label="放大" title="放大" disabled={larger === undefined} onClick={() => { if (larger !== undefined) setZoom(larger) }} />
            <Button size="sm" variant="quiet" icon={RotateCw} aria-label="旋转 90°" title="旋转 90°" onClick={() => setRotation(r => (r + 90) % 360)} />
            <a className="la-btn la-btn-sm la-btn-quiet la-btn-icon" href={url} target="_blank" rel="noreferrer" aria-label="在新窗口打开原 PDF" title="在新窗口打开原 PDF"><ExternalLink size={14} strokeWidth={1.75} /></a>
          </span>
        </span>
      </div>
      <div className="la-reader-body">
        <div className="la-reader-stage" ref={element => { stage.current = element; setStageElement(element) }}>
          {busy && <span className="la-reader-loading"><Tag icon={LoaderCircle}>正在显示原文</Tag></span>}
          {error && <div style={{ maxWidth: 520, margin: '0 auto 16px' }}><Callout tone="bad">{error}</Callout></div>}
          <div className="la-reader-sheet">
            <canvas ref={canvas} aria-label={`原文 PDF 第 ${page} 页`} />
            {rectangle && <div className="la-reader-mark" aria-label="引用原文区域" style={{ ...rectangle }} />}
          </div>
        </div>
        <aside className="la-reader-aside">
          {chunk && (
            <CiteCard chunk={chunk} shell={shell}>
              {(!chunk.locator.pageSize || !chunk.locator.bbox) && <span className="la-faint la-small">这个片段没有坐标，已定位到原文页，请对照上面的识别文本。</span>}
              {chunk.locator.page !== page && <Button size="sm" onClick={() => setPage(chunk.locator.page)}>回到引用所在页</Button>}
            </CiteCard>
          )}
          {outline.length > 0 && (
            <section>
              <h3 className="la-aside-title">章节</h3>
              <Select aria-label="跳到章节" width="100%" value={undefined} placeholder="跳到章节…"
                options={outline.map(entry => ({ value: entry.chunkId, label: entry.section.at(-1) ?? '', hint: entry.section.slice(0, -1).join(' › ') || undefined }))}
                onChange={chunkId => shell.openPage('library.sources', { id: chunkId, chunkId }, { title: '出处', split: true })} />
            </section>
          )}
          <section>
            <Disclosure summary="书上页码对不上？校正页码">
              <div className="la-stack tight">
                <span className="la-small la-muted">当前 PDF 第 {page} 页，对应书上第</span>
                <div className="la-row">
                  <NumberField aria-label="书上页码" width={110} value={printedPage} onChange={setPrintedPage} />
                  <span className="la-small">页</span>
                  <Button size="sm" loading={offsetAction.busy} onClick={() => void offsetAction.run(async () => { await shell.call('library', 'pageOffset', { sourceId, offset: page - printedPage }); info.reload() })}>保存</Button>
                </div>
                <span className="la-faint la-small">偏移应用于整份资料，可以换一页核对。</span>
                <ErrorText error={offsetAction.error} />
              </div>
            </Disclosure>
          </section>
        </aside>
      </div>
    </div>
  )
}

/** The cited chunk's recognized text, with where it sits in the source. */
function CiteCard({ chunk, shell, children }: { chunk: CitedChunk; shell: LearnShell; children?: ReactNode }): ReactNode {
  return (
    <section className="la-cite-card">
      <h3 className="la-aside-title">引用的原文</h3>
      <div className="la-row" style={{ gap: 6 }}>
        <Tag tone="accent">{chunk.citation}</Tag>
        <Tag>{CHUNK_KIND[chunk.kind] ?? chunk.kind}</Tag>
      </div>
      {chunk.section.length > 0 && <div className="la-cite-path">{chunk.section.join(' › ')}</div>}
      <div className="la-cite-text"><shell.Markdown text={chunk.text} /></div>
      {(chunk.kind === 'formula' || chunk.text.includes('$')) && <span className="la-faint la-small">公式是识别结果，请对照原文核对符号和单位。</span>}
      {children}
    </section>
  )
}
