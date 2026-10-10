// Markdown → HTML for the shared renderer (marked + KaTeX): citation badges, the unverified flag, bare chunk ids.
// Kept apart from the React component so it can be tested without a browser.
import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'

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

export function toHtml(text: string): string {
  return marked.parse(linkBareChunks(text), { async: false })
}

export function toInlineHtml(text: string): string {
  return marked.parseInline(linkBareChunks(text), { async: false })
}
