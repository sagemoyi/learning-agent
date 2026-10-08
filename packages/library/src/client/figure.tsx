// A figure chunk cut out of its PDF page (slot `learning.figure`). Only the figure's own area is drawn:
// a textbook prints exercise answers on the same page, so a test must never show the whole page.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { CitedChunk } from '@learning-agent/contracts'
import type { LearnShell } from '@learning-agent/contracts/client'
import { ImageOff } from 'lucide-react'
import { Skeleton, useLoad } from '@learning-agent/kit/client'
import { citationRectangle } from './geometry.ts'

GlobalWorkerOptions.workerSrc = '/api/learning/library.pdfAsset?file=pdf.worker.min.mjs'

/** Open documents, shared by every figure of the same source on a page. */
const documents = new Map<string, Promise<PDFDocumentProxy>>()

function documentOf(sourceId: string): Promise<PDFDocumentProxy> {
  let loading = documents.get(sourceId)
  if (!loading) {
    loading = getDocument({
      url: `/api/learning/library.original?sourceId=${encodeURIComponent(sourceId)}`,
      cMapUrl: '/api/learning/library.pdfAsset?file=cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/api/learning/library.pdfAsset?file=standard_fonts/',
      wasmUrl: '/api/learning/library.pdfAsset?file=wasm/',
    }).promise
    loading.catch(() => documents.delete(sourceId))
    documents.set(sourceId, loading)
  }
  return loading
}

/** CSS width the figure is drawn at, at most, and how far a small figure is enlarged. */
const MAX_WIDTH = 440
const MAX_SCALE = 1.5
const PAD = 4

export function Figure({ chunkId, shell }: { chunkId: string; shell: LearnShell }): ReactNode {
  const chunk = useLoad(shell, () => shell.call<CitedChunk | null>('library', 'chunk', { chunkId }), [chunkId])
  const canvas = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState('')
  const [drawn, setDrawn] = useState(false)
  const data = chunk.data
  const locator = data?.locator

  useEffect(() => {
    if (!data || !locator?.bbox || !locator.pageSize || !canvas.current) return
    let active = true
    let cancel: (() => void) | undefined
    setDrawn(false)
    documentOf(data.sourceId).then(async doc => {
      const page = await doc.getPage(locator.page)
      if (!active || !canvas.current) return
      const unit = page.getViewport({ scale: 1, rotation: page.rotate })
      const toViewport = (viewport: typeof unit) => (rect: number[]) => {
        const [a, b, c, d, e, f] = viewport.transform as [number, number, number, number, number, number]
        return [a * rect[0]! + c * rect[1]! + e, b * rect[0]! + d * rect[1]! + f, a * rect[2]! + c * rect[3]! + e, b * rect[2]! + d * rect[3]! + f]
      }
      const area = citationRectangle(locator, page.view, toViewport(unit), page.rotate)
      if (!area || area.width < 4 || area.height < 4) throw new Error('图的位置不对')
      const width = Math.min(MAX_WIDTH, canvas.current.parentElement?.clientWidth || MAX_WIDTH)
      const scale = Math.min(MAX_SCALE, width / area.width)
      const dpr = window.devicePixelRatio || 1
      const viewport = page.getViewport({ scale: scale * dpr, rotation: page.rotate })
      const whole = document.createElement('canvas')
      whole.width = Math.ceil(viewport.width)
      whole.height = Math.ceil(viewport.height)
      const render = page.render({ canvas: whole, viewport })
      cancel = () => render.cancel()
      await render.promise
      if (!active || !canvas.current) return
      const k = scale * dpr
      const [x, y] = [Math.max(0, (area.left - PAD) * k), Math.max(0, (area.top - PAD) * k)]
      const [w, h] = [Math.min(whole.width - x, (area.width + PAD * 2) * k), Math.min(whole.height - y, (area.height + PAD * 2) * k)]
      const target = canvas.current
      target.width = Math.ceil(w)
      target.height = Math.ceil(h)
      target.style.width = `${Math.round(w / dpr)}px`
      target.style.height = `${Math.round(h / dpr)}px`
      target.getContext('2d')?.drawImage(whole, x, y, w, h, 0, 0, w, h)
      setDrawn(true)
    }).catch(error => {
      if (active && error?.name !== 'RenderingCancelledException') setFailed(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false; cancel?.() }
  }, [data?.id])

  if (chunk.loading && !data) return <Skeleton lines={3} />
  const caption = data?.text && data.text !== '（图）' ? data.text : '附图'
  if (!data || !locator?.bbox || !locator.pageSize || failed) {
    return (
      <figure className="la-figure is-missing">
        <ImageOff size={16} strokeWidth={1.75} aria-hidden />
        <figcaption>{caption}{data ? `：见原书第 ${locator?.page} 页` : ''}{failed ? `（${failed}）` : ''}</figcaption>
      </figure>
    )
  }
  return (
    <figure className="la-figure">
      <canvas ref={canvas} role="img" aria-label={caption} className={drawn ? '' : 'is-loading'} />
      <figcaption>{caption}</figcaption>
    </figure>
  )
}
