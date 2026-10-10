// Shared Markdown renderer (marked + KaTeX), offered to every unit through `learnShell.Markdown`.
// Textbook mode follows contracts §3.2: a paragraph ending in ` ^id` (or followed by a line `^id`)
// is one selectable block; `[label](cite:ck_…)` links are source badges; `cite:unverified` is flagged.
import { Fragment, useMemo, type MouseEvent, type ReactNode } from 'react'
import type { MarkdownProps } from '@learning-agent/contracts/client'
import { toHtml, toInlineHtml } from './html.ts'
import { selectedQuote } from './selection.ts'

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

export function Markdown({ text, inline, blocks, selectedBlock, onBlock, onCite, blockClass, afterBlock }: MarkdownProps): ReactNode {
  const pieces = useMemo(() => (blocks ? splitBlocks(text) : undefined), [text, blocks])
  const html = useMemo(() => (blocks ? '' : inline ? toInlineHtml(text) : toHtml(text)), [text, blocks, inline])

  const handleCite = (event: MouseEvent): boolean => {
    const cite = citeTarget(event)
    if (!cite) return false
    event.preventDefault()
    event.stopPropagation()
    onCite?.(cite)
    return true
  }

  if (!pieces) {
    if (inline) return <span className="la-md-inline" onClick={handleCite} dangerouslySetInnerHTML={{ __html: html }} />
    return <div className="la-md" onClick={handleCite} dangerouslySetInnerHTML={{ __html: html }} />
  }
  return (
    <div className="la-md la-textbook">
      {pieces.map((piece, index) => (
        <Fragment key={piece.id ?? `p${index}`}>
          <MarkdownPiece
            piece={piece}
            selected={piece.id !== undefined && piece.id === selectedBlock}
            extra={piece.id ? blockClass?.(piece.id) : undefined}
            onClick={event => {
              if (handleCite(event)) return
              if (!piece.id) return
              const quote = selectedQuote(event.currentTarget, window.getSelection())
              if (quote) onBlock?.(piece.id, piece.source, quote)
              else onBlock?.(piece.id, piece.source)
            }}
          />
          {piece.id && afterBlock?.(piece.id)}
        </Fragment>
      ))}
    </div>
  )
}

function MarkdownPiece({ piece, selected, extra, onClick }: { piece: Piece; selected: boolean; extra: string | undefined; onClick(event: MouseEvent<HTMLDivElement>): void }): ReactNode {
  const html = useMemo(() => toHtml(piece.source), [piece.source])
  const className = piece.id ? `la-block${selected ? ' is-selected' : ''}${extra ? ` ${extra}` : ''}` : 'la-block-plain'
  return <div className={className} data-block={piece.id} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}
