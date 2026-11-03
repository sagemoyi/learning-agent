// Markdown → HTML for the shared renderer (marked + KaTeX): citation badges, the unverified flag, bare chunk ids.
// Kept apart from the React component so it can be tested without a browser.
// Model replies, parsed books and web pages all reach the page through here, and Marked keeps any HTML they hold, so
// every result is sanitized last (docs/shell/design.md, 前端方案).
import createDOMPurify, { type Config, type DOMPurify } from 'dompurify'
import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'

const UNVERIFIED = 'unverified'

/** Where a link may lead; anything else (`javascript:`, `data:`, a relative path) shows as its text. */
const SAFE_URL = /^(?:https?:|mailto:)/i
/** What browsers skip inside a URL's scheme: spaces, control and invisible format characters. */
const URL_WHITESPACE = /[\s\p{Cc}\p{Cf}]/gu
const URL_ATTRS = new Set(['href', 'xlink:href', 'src', 'action', 'formaction', 'background', 'poster', 'cite', 'codebase'])

/**
 * Scripts, event attributes, frames, forms, styles and images go; KaTeX's MathML keeps its TeX source (what a
 * selection quotes), and its SVG and inline sizes stay. A picture from elsewhere would load without being asked for.
 */
const PURIFY: Config = {
  ADD_TAGS: ['semantics', 'annotation'],
  ADD_ATTR: ['encoding', 'target'],
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'img', 'picture', 'source', 'video', 'audio', 'track', 'image', 'use', 'feImage', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base'],
}

let purifier: DOMPurify | undefined

/** The sanitizer of the page's document; tests outside a browser hand in a DOM DOMPurify supports (jsdom). */
export function useDocumentOf(window: unknown): void {
  purifier = createDOMPurify(window as never)
  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    // DOMPurify's own URL check lets relative paths through, and its allow-list is applied to every attribute value.
    if (URL_ATTRS.has(data.attrName) && !SAFE_URL.test(data.attrValue.replace(URL_WHITESPACE, ''))) data.keepAttr = false
    // An inline style may still fetch (`background: url(…)`); KaTeX's own never do.
    if (data.attrName === 'style' && /url\s*\(|image-set|expression\s*\(|@import/i.test(data.attrValue)) data.keepAttr = false
  })
  purifier.addHook('afterSanitizeAttributes', node => {
    if (node.nodeName !== 'A') return
    if (node.hasAttribute('href')) {
      node.setAttribute('target', '_blank')
      node.setAttribute('rel', 'noreferrer noopener')
    } else {
      node.removeAttribute('target')
    }
  })
}

/** Without a DOM DOMPurify supports, nothing is rendered as HTML: the text shows as it is. */
function sanitize(html: string, source: string): string {
  if (!purifier && typeof window !== 'undefined') useDocumentOf(window)
  if (!purifier?.isSupported) return escapeHtml(source)
  return purifier.sanitize(html, PURIFY) as string
}

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
    /**
     * An Obsidian callout (`> [!quote] 标题`, folded with `[!quote]-`): a textbook's source text copied in,
     * or a note. Other quotes stay quotes.
     */
    blockquote({ text }) {
      const callout = /^\[!(\w+)\]([+-]?)[ \t]*([^\n]*)\n?([\s\S]*)$/.exec(text)
      if (!callout) return false
      const [, type = 'note', fold, title = '', body = ''] = callout
      const head = marked.parseInline(linkBareChunks(title), { async: false })
      const inner = marked.parse(linkBareChunks(body), { async: false })
      const kind = escapeHtml(type.toLowerCase())
      if (fold === '-') return `<details class="la-quote-box is-${kind}"><summary class="la-quote-box-title">${head}</summary><div class="la-quote-box-body">${inner}</div></details>`
      return `<div class="la-quote-box is-${kind}">${head ? `<div class="la-quote-box-title">${head}</div>` : ''}<div class="la-quote-box-body">${inner}</div></div>`
    },
    /** `![图1-3](cite:ck_…)`: a figure cut out of its page, drawn by the page that shows the text; a link until then. */
    image({ href, text }) {
      // A picture from elsewhere opens when the learner asks for it.
      if (!href.startsWith('cite:')) {
        const label = escapeHtml(text ? `图：${text}` : '图')
        return SAFE_URL.test(href) ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${label}</a>` : `<span>${label}</span>`
      }
      const target = escapeHtml(href.slice('cite:'.length))
      return `<span class="la-md-figure" data-figure="${target}"><a class="la-cite" data-cite="${target}" data-la-opens title="${escapeHtml(text)} · 点击查看原图">${escapeHtml(text || '图')}</a></span>`
    },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens)
      if (href.startsWith('cite:')) {
        const target = href.slice('cite:'.length)
        if (target === UNVERIFIED) return `<span class="la-unverified" title="这句话还没有找到资料出处">${label}</span>`
        const badge = citeBadge(label)
        return `<a class="la-cite" data-cite="${escapeHtml(target)}" data-la-opens title="${escapeHtml(`${badge.full} · 点击查看原文`)}">${escapeHtml(badge.short)}</a>`
      }
      if (!SAFE_URL.test(href)) return `<span>${label}</span>`
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${label}</a>`
    },
  },
})

/** A chunk id written bare (`ck_…`) instead of as a citation link still shows as a source badge. */
const BARE_CHUNK = /(?<![\w:/])(ck_[0-9A-HJKMNP-TV-Z]{26})(?![\w)])/g

function linkBareChunks(text: string): string {
  return text.replace(BARE_CHUNK, '[出处](cite:$1)')
}

/** Badges side by side that name the same page of the same book show as one (a handout cites one per paragraph). */
const SAME_BADGES = /(<a class="la-cite" data-cite="[^"]*" data-la-opens title="([^"]*)">[^<]*<\/a>)(?:\s*<a class="la-cite" data-cite="[^"]*" data-la-opens title="\2">[^<]*<\/a>)+/g

export function toHtml(text: string): string {
  const html = marked.parse(linkBareChunks(text), { async: false })
    .replace(SAME_BADGES, '$1')
    // A wide table scrolls inside its own frame instead of widening the column.
    .replace(/<table>/g, '<div class="la-table"><table>').replace(/<\/table>/g, '</table></div>')
  return sanitize(html, text)
}

export function toInlineHtml(text: string): string {
  return sanitize(marked.parseInline(linkBareChunks(text), { async: false }), text)
}
