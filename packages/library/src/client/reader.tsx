import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { CitedChunk, Source } from '@learning-agent/contracts'
import type { LearnShell } from '@learning-agent/contracts/client'
import { useAction, useLoad } from '@learning-agent/kit/client'
import { citationRectangle } from './geometry.ts'

GlobalWorkerOptions.workerSrc = '/api/learning/library.pdfAsset?file=pdf.worker.min.mjs'

export function Reader({ sourceId, chunk, shell }: { sourceId: string; chunk?: CitedChunk; shell: LearnShell }): ReactNode {
  const info = useLoad(shell, () => shell.call<{ source: Source; outline: { section: string[]; chunkId: string }[] }>('library', 'document', { sourceId }), [sourceId])
  const offsetAction = useAction()
  const [printedInput, setPrintedInput] = useState('1')
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
    <div className="la-row"><b>{info.data?.source.title ?? '原文'}</b><a className="la-btn" href={url} target="_blank" rel="noreferrer">打开原 PDF</a></div>
    <div className="la-row">
      <button className="la-btn" disabled={!pdf || page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button>
      <label>PDF 页 <input aria-label="PDF 页码" className="la-input" type="number" min={1} max={pdf?.numPages} style={{ width: 70 }} value={page} onChange={e => { const n = Number(e.target.value); if (pdf && Number.isInteger(n) && n >= 1 && n <= pdf.numPages) setPage(n) }} /></label>
      <span className="la-small la-muted">/ {pdf?.numPages ?? '…'}{printed > 0 ? ` · 书上 p.${printed}` : ' · 前言/封面'}</span>
      <button className="la-btn" disabled={!pdf || page >= pdf.numPages} onClick={() => setPage(p => p + 1)}>下一页</button>
      <select className="la-input" aria-label="缩放" style={{ width: 90 }} value={zoom} onChange={e => setZoom(Number(e.target.value))}>{[0.5, 0.75, 1, 1.25, 1.5, 2].map(n => <option key={n} value={n}>{n * 100}%</option>)}</select>
      <button className="la-btn" onClick={() => setRotation(r => (r + 90) % 360)}>旋转 90°</button>
      {info.data?.outline.length ? <select aria-label="章节跳转" className="la-input" style={{ maxWidth: 260 }} value="" onChange={e => shell.openPage('library.sources', { id: e.target.value, chunkId: e.target.value }, { title: '出处', split: true })}><option value="">跳到章节…</option>{info.data.outline.map(entry => <option key={entry.chunkId} value={entry.chunkId}>{entry.section.join(' › ')}</option>)}</select> : null}
    </div>
    {chunk && (!chunk.locator.pageSize || !chunk.locator.bbox) && <div className="la-muted la-small">此片段缺少坐标或页面尺寸，已定位到原文页；可对照下面的识别文本。</div>}
    <details><summary className="la-small la-muted">校正书上页码</summary><div className="la-row" style={{ marginTop: 8 }}><label>当前 PDF 页对应书上第 <input aria-label="书上页码" className="la-input" type="number" style={{ width: 70 }} value={printedInput} onChange={e => setPrintedInput(e.target.value)} /> 页</label><button className="la-btn" disabled={offsetAction.busy || !Number.isInteger(Number(printedInput))} onClick={() => void offsetAction.run(async () => { await shell.call('library', 'pageOffset', { sourceId, offset: page - Number(printedInput) }); info.reload() })}>保存校正</button><span className="la-small la-muted">固定偏移应用于整份资料，可切换另一页核对。</span></div>{offsetAction.error && <div className="la-error">{offsetAction.error}</div>}</details>
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
