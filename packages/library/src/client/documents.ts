// Loaded PDFs, shared: tabs left in the background stay mounted, and the same book may be open in a tab and in the
// right sidebar at once. One load per address; it is released half a minute after the last reader lets go.
import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'

const RELEASE_AFTER_MS = 30_000
const ASSETS = '/api/learning/library.pdfAsset?file='
/** Pages drawn at once: a long handout's figures take their turn instead of all drawing a whole page together. */
const MAX_DRAWING = 3

/** The address of a source's original PDF: one name for the same book, wherever it is opened from. */
export function originalUrl(sourceId: string): string {
  return `/api/learning/library.original?sourceId=${encodeURIComponent(sourceId)}`
}

let drawing = 0
const waiting: (() => void)[] = []

/** Run `draw` when fewer than `MAX_DRAWING` are running. */
export async function inTurn<T>(draw: () => Promise<T>): Promise<T> {
  if (drawing >= MAX_DRAWING) await new Promise<void>(resolve => { waiting.push(resolve) })
  drawing++
  try {
    return await draw()
  } finally {
    drawing--
    waiting.shift()?.()
  }
}

interface Loaded { readonly task: PDFDocumentLoadingTask; users: number; timer?: ReturnType<typeof setTimeout> }
const loaded = new Map<string, Loaded>()

export function borrowDocument(url: string): { readonly promise: Promise<PDFDocumentProxy>; release(): void } {
  let entry = loaded.get(url)
  if (!entry) {
    const task = getDocument({ url, cMapUrl: `${ASSETS}cmaps/`, cMapPacked: true, standardFontDataUrl: `${ASSETS}standard_fonts/`, wasmUrl: `${ASSETS}wasm/` })
    const created: Loaded = { task, users: 0 }
    // A failed load is not kept: the next reader tries again.
    task.promise.catch(() => { if (loaded.get(url) === created) loaded.delete(url) })
    loaded.set(url, created)
    entry = created
  }
  const borrowed = entry
  clearTimeout(borrowed.timer)
  borrowed.users++
  let returned = false
  return {
    promise: borrowed.task.promise,
    release() {
      if (returned) return
      returned = true
      if (--borrowed.users > 0) return
      borrowed.timer = setTimeout(() => {
        if (loaded.get(url) === borrowed) loaded.delete(url)
        void borrowed.task.destroy()
      }, RELEASE_AFTER_MS)
    },
  }
}
