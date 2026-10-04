import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { CitedChunk, Source } from '@learning-agent/contracts'
import type { LearnShell } from '@learning-agent/contracts/client'
import { ChevronLeft, ChevronRight, ExternalLink, RotateCw } from 'lucide-react'
import { Button, Disclosure, NumberField, Select, useAction, useLoad } from '@learning-agent/kit/client'
import { citationRectangle } from './geometry.ts'

GlobalWorkerOptions.workerSrc = '/api/learning/library.pdfAsset?file=pdf.worker.min.mjs'

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2].map(n => ({ value: String(n), label: `${n * 100}%` }))

export function Reader({ sourceId, chunk, shell }: { sourceId: string; chunk?: CitedChunk; shell: LearnShell }): ReactNode {
  const info = useLoad(shell, () => shell.call<{ source: Source; outline: { section: string[]; chunkId: string }[] }>('library', 'document', { sourceId }), [sourceId])
  const offsetAction = useAction()
  const [printedPage, setPrintedPage] = useState(1)
  const [pdf, setPdf] = useState<PDFDocumentProxy>()
  const [page, setPage] = useState(chunk?.locator.page ?? 1)
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [rectangle, setRectangle] = useState<ReturnType<typeof citationRectangle>>()
  const canvas = useRef<HTMLCanvasElement>(null)
  const url = `/api/learning/library.original?sourceId=${encodeURIComponent(sourceId)}`
  const isPdf = info.data?.source?.origin.kind === 'file' && /\.pdf$/i.test(info.data.source.origin.fileName)

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

  useEffect(() => {
    if (!pdf || !canvas.current) return
    let active = true
    let cancel: (() => void) | undefined
    setBusy(true)
    setRectangle(undefined)
    pdf.getPage(page).then(async entry => {
      if (!active || !canvas.current) return
      const viewport = entry.getViewport({ scale: zoom, rotation: (entry.rotate + rotation) % 360 })
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
        setRectangle(chunk?.locator.page === page ? citationRectangle(chunk.locator, entry.view, rect => {
          const [a, b, c, d, e, f] = viewport.transform as [number, number, number, number, number, number]
          return [a * rect[0]! + c * rect[1]! + e, b * rect[0]! + d * rect[1]! + f, a * rect[2]! + c * rect[3]! + e, b * rect[2]! + d * rect[3]! + f]
        }, entry.rotate) : undefined)
        setError('')
      }
    }).catch(e => { if (active && e.name !== 'RenderingCancelledException') setError(`页面无法显示：${e.message}`) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false; cancel?.() }
  }, [pdf, page, zoom, rotation, chunk?.id])

  const printed = page - (info.data?.source.pageOffset ?? 0)
  if (info.data && !isPdf) return <div className="la-muted">此资料原件不是 PDF，可通过检索查看内容片段。其他格式的原文阅读将在后续支持。</div>
  return <section className="la-card la-stack">
    <div className="la-row"><b>{info.data?.source.title ?? '原文'}</b><a className="la-btn la-btn-sm" href={url} target="_blank" rel="noreferrer"><ExternalLink size={14} strokeWidth={1.75} />打开原 PDF</a></div>
    <div className="la-toolbar">
      <span className="la-toolbar-group">
        <Button icon={ChevronLeft} aria-label="上一页" title="上一页" disabled={!pdf || page <= 1} onClick={() => setPage(p => p - 1)} />
        <NumberField aria-label="PDF 页码" width={104} value={page} min={1} max={pdf?.numPages ?? page} onChange={setPage} />
        <Button icon={ChevronRight} aria-label="下一页" title="下一页" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(p => p + 1)} />
      </span>
      <span className="la-small la-muted">/ {pdf?.numPages ?? '…'}{printed > 0 ? ` · 书上 p.${printed}` : ' · 前言/封面'}</span>
      <span className="la-spacer" />
      <span className="la-toolbar-group">
        <Select aria-label="缩放" width={88} value={String(zoom)} options={ZOOMS} onChange={value => setZoom(Number(value))} />
        <Button icon={RotateCw} aria-label="旋转 90°" title="旋转 90°" onClick={() => setRotation(r => (r + 90) % 360)} />
      </span>
    </div>
    {info.data?.outline.length ? <Select aria-label="章节跳转" width="100%" value={undefined} placeholder="跳到章节…"
      options={info.data.outline.map(entry => ({ value: entry.chunkId, label: entry.section.at(-1) ?? '', hint: entry.section.slice(0, -1).join(' › ') || undefined }))}
      onChange={chunkId => shell.openPage('library.sources', { id: chunkId, chunkId }, { title: '出处', split: true })} /> : null}
    {chunk && (!chunk.locator.pageSize || !chunk.locator.bbox) && <div className="la-muted la-small">此片段缺少坐标或页面尺寸，已定位到原文页；可对照下面的识别文本。</div>}
    <Disclosure summary="校正书上页码">
      <div className="la-row">
        <span>当前 PDF 页对应书上第</span><NumberField aria-label="书上页码" value={printedPage} onChange={setPrintedPage} /><span>页</span>
        <Button size="sm" loading={offsetAction.busy} onClick={() => void offsetAction.run(async () => { await shell.call('library', 'pageOffset', { sourceId, offset: page - printedPage }); info.reload() })}>保存校正</Button>
        <span className="la-small la-muted">固定偏移应用于整份资料，可切换另一页核对。</span>
      </div>
      {offsetAction.error && <div className="la-error">{offsetAction.error}</div>}
    </Disclosure>
    {(error || info.error) && <div className="la-error">{error || info.error}</div>}
    {busy && <span className="la-muted la-small">正在显示原文…</span>}
    <div style={{ overflow: 'auto', maxHeight: '65vh', background: '#e7e7e7', padding: 8 }}>
      <div style={{ position: 'relative', width: 'max-content', lineHeight: 0 }}>
        <canvas ref={canvas} aria-label={`原文 PDF 第 ${page} 页`} />
        {rectangle && <div aria-label="引用原文区域" style={{ position: 'absolute', ...rectangle, border: '2px solid #e6a900', background: 'rgba(255,210,40,.22)', pointerEvents: 'none', boxSizing: 'border-box' }} />}
      </div>
    </div>
  </section>
}
