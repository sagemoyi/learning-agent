// Shared Markdown renderer (marked + KaTeX), offered to every unit through `learnShell.Markdown`.
// Textbook mode follows contracts §3.2: a paragraph ending in ` ^id` (or followed by a line `^id`)
// is one selectable block; `[label](cite:ck_…)` links are source badges; `cite:unverified` is flagged.
import { useMemo, type MouseEvent, type ReactNode } from 'react'
import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import type { MarkdownProps } from '@learning-agent/contracts/client'

const UNVERIFIED = 'unverified'

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

/**
 * A citation reads `《书名》p.12`; inline it shows only `p.12` (the book is in the tooltip), so a
 * paragraph with several sources stays readable. Other labels are kept, shortened if long.
 */
function citeBadge(label: string): { short: string; full: string } {
  const full = label.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]!).trim()
  const page = /《[^》]+》\s*((?:p|P)\.?\s*[\d\-–~、,，]+.*)$/.exec(full)
  if (page) return { short: page[1]!.replace(/\s+/g, ''), full }
  return { short: Array.from(full).length > 10 ? `${Array.from(full).slice(0, 9).join('')}…` : full || '出处', full }
}

const marked = new Marked({ gfm: true, breaks: false })
marked.use(markedKatex({ throwOnError: false, nonStandard: true }))
marked.use({
  renderer: {
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens)
      if (href.startsWith('cite:')) {
        const target = href.slice('cite:'.length)
        if (target === UNVERIFIED) return `<span class="la-unverified" title="这句话还没有找到资料出处">${label}</span>`
        const badge = citeBadge(label)
        return `<a class="la-cite" data-cite="${escapeHtml(target)}" title="${escapeHtml(`${badge.full} · 点击查看原文`)}">${escapeHtml(badge.short)}</a>`
      }
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}</a>`
    },
  },
})

/** A chunk id written bare (`ck_…`) instead of as a citation link still shows as a source badge. */
const BARE_CHUNK = /(?<![\w:/])(ck_[0-9A-HJKMNP-TV-Z]{26})(?![\w)])/g

function linkBareChunks(text: string): string {
  return text.replace(BARE_CHUNK, '[出处](cite:$1)')
}

function toHtml(text: string): string {
  return marked.parse(linkBareChunks(text), { async: false })
}

function toInlineHtml(text: string): string {
  return marked.parseInline(linkBareChunks(text), { async: false })
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

export function Markdown({ text, inline, blocks, selectedBlock, onBlock, onCite }: MarkdownProps): ReactNode {
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
        <MarkdownPiece
          key={piece.id ?? `p${index}`}
          piece={piece}
          selected={piece.id !== undefined && piece.id === selectedBlock}
          onClick={event => {
            if (handleCite(event)) return
            if (piece.id) onBlock?.(piece.id, piece.source)
          }}
        />
      ))}
    </div>
  )
}

function MarkdownPiece({ piece, selected, onClick }: { piece: Piece; selected: boolean; onClick(event: MouseEvent): void }): ReactNode {
  const html = useMemo(() => toHtml(piece.source), [piece.source])
  const className = piece.id ? `la-block${selected ? ' is-selected' : ''}` : 'la-block-plain'
  return <div className={className} data-block={piece.id} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
}
