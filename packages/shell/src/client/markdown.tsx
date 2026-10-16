// Shared Markdown renderer (marked + KaTeX), offered to every unit through `learnShell.Markdown`.
// Textbook mode follows contracts §3.2: a paragraph ending in ` ^id` (or followed by a line `^id`)
// is one block; `[label](cite:ck_…)` links are source badges, previewed on hover; `cite:unverified` is
// flagged; `![caption](cite:ck_…)` is a figure the page draws; `> [!quote]` boxes hold source text.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import ReactDOM from 'react-dom'
import type { MarkdownProps } from '@learning-agent/contracts/client'
import { toHtml, toInlineHtml } from './html.ts'
import { selectedQuote } from './selection.ts'

/** What a citation badge shows on hover. */
export interface ChunkPreview {
  readonly citation: string
  readonly text: string
  readonly kind: string
}

type Props = MarkdownProps & {
  /** The cited text for a badge's hover card; the shell passes it, units do not. */
  readonly preview?: (chunkId: string) => Promise<ChunkPreview | undefined>
}

/** Drop a leading YAML frontmatter block. */
function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

interface Piece {
  readonly id?: string
  readonly source: string
}

const TRAILING_ID = /\s\^([0-9a-z]{6})\s*$/
const LONE_ID = /^\^([0-9a-z]{6})\s*$/

/** Split a textbook file into blocks: paragraphs, display math kept whole, ids attached. */
export function splitBlocks(text: string): Piece[] {
  const lines = stripFrontmatter(text).split(/\r?\n/)
  const raw: string[] = []
  let current: string[] = []
  let inMath = false
  const flush = () => {
    if (current.some(line => line.trim())) raw.push(current.join('\n'))
    current = []
  }
  for (const line of lines) {
    const fence = line.trim() === '$$'
    if (!inMath && line.trim() === '') {
      flush()
      continue
    }
    current.push(line)
    if (fence) inMath = !inMath
  }
  flush()

  const pieces: Piece[] = []
  for (const chunk of raw) {
    const lone = LONE_ID.exec(chunk.trim())
    if (lone) {
      const previous = pieces.pop()
      if (previous) pieces.push({ id: lone[1]!, source: previous.source })
      continue
    }
    // An id line right after display math in the same chunk.
    const lastLine = chunk.split('\n').at(-1)!.trim()
    const loneTail = LONE_ID.exec(lastLine)
    if (loneTail && chunk.includes('\n')) {
      pieces.push({ id: loneTail[1]!, source: chunk.split('\n').slice(0, -1).join('\n') })
      continue
    }
    const trailing = TRAILING_ID.exec(chunk)
    if (trailing) pieces.push({ id: trailing[1]!, source: chunk.slice(0, trailing.index) })
    else pieces.push({ source: chunk })
  }
  return pieces
}

function citeTarget(event: MouseEvent): string | undefined {
  const element = (event.target as HTMLElement).closest('[data-cite]')
  return element?.getAttribute('data-cite') ?? undefined
}

export function Markdown({ text, inline, blocks, selectedBlock, onBlock, onCite, onQuote, onSelect, figure, blockClass, afterBlock, preview }: Props): ReactNode {
  const pieces = useMemo(() => (blocks ? splitBlocks(text) : undefined), [text, blocks])
  const html = useMemo(() => (blocks ? '' : inline ? toInlineHtml(text) : toHtml(text)), [text, blocks, inline])
  const hover = useCitePreview(preview)

  const handleCite = (event: MouseEvent): boolean => {
    const cite = citeTarget(event)
    if (!cite) return false
    event.preventDefault()
    event.stopPropagation()
    hover.close()
    onCite?.(cite)
    return true
  }

  if (!pieces) {
    if (inline) return <><span className="la-md-inline" onClick={handleCite} {...hover.handlers} dangerouslySetInnerHTML={{ __html: html }} />{hover.card}</>
    // The learner let go of the mouse (or the keys that extend a selection): what is selected here now, if anything.
    const quoted = onQuote ? (event: { currentTarget: HTMLDivElement }) => onQuote(selectedQuote(event.currentTarget, window.getSelection())) : undefined
    return <><Html key={html} html={html} figure={figure} className="la-md" onClick={handleCite} onMouseUp={quoted} onKeyUp={quoted} {...hover.handlers} />{hover.card}</>
  }

  // Textbook mode with `onSelect`: a selection inside one block is reported with its place on the screen.
  const report = (event: { currentTarget: HTMLDivElement }) => {
    if (!onSelect) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) { onSelect(undefined); return }
    const range = selection.getRangeAt(0)
    const start = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement
    const block = start?.closest('[data-block]')
    if (!block || !event.currentTarget.contains(block)) { onSelect(undefined); return }
    const quote = selectedQuote(block, selection)
    const id = block.getAttribute('data-block')!
    const piece = pieces.find(item => item.id === id)
    if (!quote || !piece) { onSelect(undefined); return }
    const box = range.getBoundingClientRect()
    onSelect({ blockId: id, text: piece.source, quote, rect: { top: box.top, left: box.left, right: box.right, bottom: box.bottom } })
  }
  return (
    <div className="la-md la-textbook" onMouseUp={onSelect ? report : undefined} onKeyUp={onSelect ? report : undefined} {...hover.handlers}>
      {pieces.map((piece, index) => (
        <Fragment key={piece.id ?? `p${index}`}>
          <MarkdownPiece
            piece={piece}
            selected={piece.id !== undefined && piece.id === selectedBlock}
            extra={piece.id ? blockClass?.(piece.id) : undefined}
            figure={figure}
            onClick={event => {
              if (handleCite(event)) return
              if (!piece.id || onSelect) return
              const quote = selectedQuote(event.currentTarget, window.getSelection())
              if (quote) onBlock?.(piece.id, piece.source, quote)
              else onBlock?.(piece.id, piece.source)
            }}
          />
          {piece.id && afterBlock?.(piece.id)}
        </Fragment>
      ))}
      {hover.card}
    </div>
  )
}

function MarkdownPiece({ piece, selected, extra, figure, onClick }: { piece: Piece; selected: boolean; extra: string | undefined; figure: Props['figure']; onClick(event: MouseEvent<HTMLDivElement>): void }): ReactNode {
  const html = useMemo(() => toHtml(piece.source), [piece.source])
  const className = piece.id ? `la-block${selected ? ' is-selected' : ''}${extra ? ` ${extra}` : ''}` : 'la-block-plain'
  return <Html key={html} html={html} figure={figure} className={className} data-block={piece.id} onClick={onClick} />
}

/**
 * Rendered HTML whose figures (`[data-figure]`) the page draws inside it. Keyed by its HTML: new text is a new
 * element, so the figures drawn into the old one go with it.
 */
function Html({ html, figure, ...rest }: { html: string; figure: Props['figure'] } & HTMLAttributes<HTMLDivElement> & { 'data-block'?: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [spots, setSpots] = useState<{ element: Element; chunkId: string }[]>([])
  const drawing = Boolean(figure)
  useLayoutEffect(() => {
    if (!drawing || !ref.current) return
    const found = [...ref.current.querySelectorAll('[data-figure]')].map(element => ({ element, chunkId: element.getAttribute('data-figure')! }))
    for (const spot of found) spot.element.classList.add('is-drawn')
    setSpots(found)
  }, [drawing])
  return (
    <>
      <div ref={ref} {...rest} dangerouslySetInnerHTML={{ __html: html }} />
      {figure && spots.map((spot, index) => ReactDOM.createPortal(figure(spot.chunkId), spot.element, `${spot.chunkId}:${index}`))}
    </>
  )
}

/** Hover a citation badge for a moment to read the cited text; the card stays while the pointer is on it. */
function useCitePreview(preview: Props['preview']) {
  const [shown, setShown] = useState<{ chunkId: string; rect: DOMRect; data?: ChunkPreview | null }>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const cache = useRef(new Map<string, Promise<ChunkPreview | undefined>>())
  useEffect(() => () => clearTimeout(timer.current), [])
  const close = () => { clearTimeout(timer.current); setShown(undefined) }
  const later = (run: () => void, ms: number) => { clearTimeout(timer.current); timer.current = setTimeout(run, ms) }
  if (!preview) return { handlers: {}, card: null, close }
  const load = (chunkId: string) => {
    let pending = cache.current.get(chunkId)
    if (!pending) { pending = preview(chunkId).catch(() => undefined); cache.current.set(chunkId, pending) }
    return pending
  }
  const handlers = {
    onMouseOver: (event: MouseEvent) => {
      const badge = (event.target as HTMLElement).closest('a.la-cite[data-cite]')
      if (!badge) return
      const chunkId = badge.getAttribute('data-cite')!
      if (!chunkId.startsWith('ck_')) return
      later(() => {
        setShown({ chunkId, rect: badge.getBoundingClientRect() })
        void load(chunkId).then(data => setShown(current => (current?.chunkId === chunkId ? { ...current, data: data ?? null } : current)))
      }, 350)
    },
    onMouseOut: (event: MouseEvent) => {
      if ((event.target as HTMLElement).closest('a.la-cite[data-cite]')) later(() => setShown(undefined), 220)
    },
  }
  const card = shown ? ReactDOM.createPortal(
    <div className="la-cite-preview" role="tooltip" style={placeCard(shown.rect)}
      onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={() => later(() => setShown(undefined), 160)}>
      {shown.data === undefined ? <div className="la-faint">正在读取原文…</div>
        : shown.data === null ? <div className="la-faint">读不到这段原文</div>
          : <>
            <div className="la-cite-preview-source">{shown.data.citation}</div>
            {shown.data.kind === 'figure'
              ? <div className="la-faint">图：{shown.data.text.split('\n')[0] || '附图'}（点出处标签看原图）</div>
              : <div className="la-cite-preview-text la-md" dangerouslySetInnerHTML={{ __html: toHtml(shown.data.text) }} />}
          </>}
    </div>,
    document.body,
  ) : null
  return { handlers, card, close }
}

/** Below the badge, or above it near the bottom of the window; kept inside the window. */
function placeCard(rect: DOMRect): { top?: number; bottom?: number; left: number } {
  const width = Math.min(380, window.innerWidth - 24)
  const left = Math.max(12, Math.min(rect.left - 12, window.innerWidth - width - 12))
  return rect.bottom + 260 > window.innerHeight ? { bottom: window.innerHeight - rect.top + 6, left } : { top: rect.bottom + 6, left }
}
