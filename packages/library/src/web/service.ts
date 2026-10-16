// Material found online, from search to source (docs/library/design.md "联网找权威资料"). Authority comes
// from site rules: 1–2 is fetched and citable at once, 3 waits for the learner when the teacher found it,
// clues and blocked sites never become sources. Pages are kept as Markdown; PDFs go through the same
// import and parsing as an upload, so their citations reach the page and area.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Authority, Source, WebAdded, WebPending, WebReading, WebSearch } from '@learning-agent/contracts'
import type { LibraryStore } from '../store.ts'
import type { LibraryImports } from '../imports.ts'
import { download, DownloadError, type DownloadOptions } from './fetch.ts'
import { chunksFromMarkdown, decodeHtml, readPage, type PageChunk } from './page.ts'
import { bochaProvider, exaContents, exaProvider, PROVIDER_KEY, PROVIDER_ORDER, searchWeb, tavilyProvider, type ProviderId, type SearchProvider } from './search.ts'
import { AUTHORITY_TEXT, formatOf, normalizeUrl, organization, rate, siteOf } from './sites.ts'

const MAX_BYTES = 100 * 1024 * 1024
/** Less main text than this means the page needs a browser to show its content (or is a stub). */
const MIN_TEXT = 100

const FACTORY: Record<ProviderId, (key: string, base?: string) => SearchProvider> = { exa: exaProvider, bocha: bochaProvider, tavily: tavilyProvider }

/** What a fetch of one address gave: a page's main text, a PDF to import, or why neither. */
type WebPage =
  | { readonly kind: 'page'; readonly title: string; readonly markdown: string; readonly chunks: PageChunk[]; readonly html?: string; readonly via: 'local' | 'exa'; readonly why?: string }
  | { readonly kind: 'pdf'; readonly finalUrl: string; readonly body: Buffer }
  | { readonly kind: 'failed'; readonly message: string }

export interface WebSettings {
  /** The learner's preferred search service; the others follow in the measured order. */
  provider(): ProviderId
  key(name: string): Promise<string | undefined>
}

export interface WebOptions {
  /** Test servers stand in for the search services and the web. */
  readonly bases?: Partial<Record<ProviderId, string>>
  readonly allowAddress?: DownloadOptions['allowAddress']
}

export class LibraryWeb {
  constructor(
    private readonly ctx: Context,
    private readonly store: LibraryStore,
    private readonly importer: LibraryImports,
    private readonly settings: WebSettings,
    private readonly options: WebOptions = {},
  ) {}

  /** Services with a key, preferred first. */
  async providers(): Promise<SearchProvider[]> {
    const preferred = this.settings.provider()
    const order = [preferred, ...PROVIDER_ORDER.filter(id => id !== preferred)]
    const out: SearchProvider[] = []
    for (const id of order) {
      const key = await this.settings.key(PROVIDER_KEY[id])
      if (key) out.push(FACTORY[id](key, this.options.bases?.[id]))
    }
    return out
  }

  /** One service by name, for the settings page's connection test. */
  async provider(id: ProviderId): Promise<SearchProvider | undefined> {
    const key = await this.settings.key(PROVIDER_KEY[id])
    return key ? FACTORY[id](key, this.options.bases?.[id]) : undefined
  }

  async search(questions: readonly string[], signal?: AbortSignal): Promise<WebSearch> {
    return searchWeb(questions, await this.providers(), this.store.siteRules(), signal)
  }

  add(courseId: string, items: readonly { url: string; title?: string; reason?: string }[], by: 'teacher' | 'learner', signal?: AbortSignal): Promise<WebAdded[]> {
    return Promise.all(items.map(item => this.addOne(courseId, item, by, signal)))
  }

  private async addOne(courseId: string, item: { url: string; title?: string; reason?: string }, by: 'teacher' | 'learner', signal?: AbortSignal): Promise<WebAdded> {
    let url: string
    try {
      url = normalizeUrl(item.url.trim())
      if (!/^https?:$/.test(new URL(url).protocol)) throw new Error()
    } catch {
      return { url: item.url, status: 'rejected', message: '不是有效的网址' }
    }
    const rating = rate(url, this.store.siteRules())
    if (rating.authority === 'blocked') return { url, status: 'rejected', message: `${rating.rule}，不能加入` }
    if (rating.authority === 'clue') return { url, status: 'rejected', message: `只当线索（${rating.rule}），不能当出处；学习者可以在资料库页把这个网站设为可信` }
    const known = this.store.webEntry(url)
    if (known?.sourceId) {
      this.store.attach(courseId, known.sourceId, 'reference')
      return { url, status: 'added', sourceId: known.sourceId, message: `已在资料库里，已加入本课：${this.title(known.sourceId)}` }
    }
    if (known?.importId) {
      const task = this.store.importTask(known.importId)
      if (task.status === 'ready' && task.sourceId) {
        this.store.attach(courseId, task.sourceId, 'reference')
        return { url, status: 'added', sourceId: task.sourceId, message: `已在资料库里，已加入本课：《${task.title}》` }
      }
      if (!['failed', 'canceled'].includes(task.status)) return { url, status: 'importing', message: `《${task.title}》正在解析：${task.message}` }
    }
    if (rating.authority === '3' && by === 'teacher') {
      const pending = this.store.proposeWeb({
        id: randomUUID(), courseId, url, title: item.title?.trim() || siteOf(url), snippet: '', site: siteOf(url), organization: organization(siteOf(url)),
        authority: rating.authority, rule: rating.rule, format: formatOf(url), provider: '', reason: item.reason?.trim() ?? '', proposedAt: new Date().toISOString(),
      })
      this.ctx.emit('learning/web-changed', { courseId })
      return { url, status: 'pending', message: `三级来源（${rating.rule}），等学习者在资料库页确认后才能引用：${pending.title}` }
    }
    return this.fetchInto(courseId, url, item.title, rating.authority, rating.rule, signal)
  }

  pending(courseId?: string): WebPending[] {
    return this.store.pendingWeb(courseId)
  }

  /** The learner confirms a proposal: fetch it now; it stays proposed if the fetch fails. */
  async confirm(id: string, signal?: AbortSignal): Promise<WebAdded> {
    const item = this.store.pendingItem(id)
    const rating = rate(item.url, this.store.siteRules())
    const result = rating.authority === 'clue' || rating.authority === 'blocked'
      ? { url: item.url, status: 'rejected' as const, message: `这个网站已设为${rating.authority === 'clue' ? '只当线索' : '排除'}，不能加入` }
      : await this.fetchInto(item.courseId, item.url, item.title, rating.authority, rating.rule, signal)
    if (result.status !== 'failed') this.store.dropPending(id)
    this.ctx.emit('learning/web-changed', { courseId: item.courseId })
    return result
  }

  dismiss(id: string): void {
    const item = this.store.pendingItem(id)
    this.store.dropPending(id)
    this.ctx.emit('learning/web-changed', { courseId: item.courseId })
  }

  private title(sourceId: string): string {
    return `《${this.store.source(sourceId)?.title ?? sourceId}》`
  }

  private async fetchInto(courseId: string, url: string, title: string | undefined, authority: Authority, rule: string, signal?: AbortSignal): Promise<WebAdded> {
    const level = `${AUTHORITY_TEXT[authority]}，${rule}`
    const page = await this.page(url, title, signal)
    if (page.kind === 'failed') return { url, status: 'failed', message: page.message }
    if (page.kind === 'pdf') return this.importPdf(courseId, url, page.finalUrl, page.body, title, authority, rule)
    const source = this.store.importWebPage({ title: title?.trim() || page.title || siteOf(url), url, authority, markdown: page.markdown, chunks: page.chunks, ...(page.html ? { html: page.html } : {}), via: page.via, courseId })
    this.ctx.emit('learning/source-imported', { sourceId: source.id })
    const how = page.via === 'exa' ? `网页；${page.why}，正文来自 Exa 的副本` : '网页'
    return { url, status: 'added', sourceId: source.id, message: `已加入本课（${level}，${how}）：《${source.title}》` }
  }

  /** One page's main text for a single use: nothing is stored, the caller quotes it by its address. */
  async read(address: string, signal?: AbortSignal): Promise<WebReading> {
    let url: string
    try {
      url = normalizeUrl(address.trim())
      if (!/^https?:$/.test(new URL(url).protocol)) throw new Error()
    } catch {
      return { url: address, status: 'rejected', message: '不是有效的网址' }
    }
    const rating = rate(url, this.store.siteRules())
    if (rating.authority === 'blocked' || rating.authority === 'clue') return { url, status: 'rejected', message: rating.authority === 'clue' ? `只当线索（${rating.rule}）` : rating.rule }
    const page = await this.page(url, undefined, signal)
    if (page.kind === 'pdf') return { url, status: 'failed', message: '这是 PDF，要解析后才能读' }
    if (page.kind === 'failed') return { url, status: 'failed', message: page.message }
    const passages = page.chunks.filter(chunk => chunk.kind !== 'heading' && chunk.text.trim()).map(chunk => chunk.text)
    return { status: 'read', url, title: page.title.trim() || siteOf(url), site: siteOf(url), authority: rating.authority, rule: rating.rule, passages }
  }

  /** A page's main text: read here, else Exa's copy (never for a PDF, whose formulas come out scrambled). A PDF is handed back as it is. */
  private async page(url: string, title: string | undefined, signal?: AbortSignal): Promise<WebPage> {
    let fetched
    try {
      fetched = await download(url, { maxBytes: MAX_BYTES, timeoutMs: 30_000, signal, allowAddress: this.options.allowAddress })
      if (fetched.status >= 400) throw new DownloadError(`网站返回 ${fetched.status}`)
    } catch (error) {
      signal?.throwIfAborted()
      const reason = error instanceof Error ? error.message : String(error)
      if (formatOf(url) === 'pdf') return { kind: 'failed', message: `这台电脑下载不了这个 PDF（${reason}）` }
      return this.exaCopy(url, title, `这台电脑打不开原网页（${reason}）`, signal)
    }
    const isPdf = /application\/pdf/i.test(fetched.contentType) || fetched.body.subarray(0, 1024).toString('latin1').includes('%PDF-')
    if (isPdf) return { kind: 'pdf', finalUrl: fetched.url, body: fetched.body }
    const type = fetched.contentType.split(';')[0]!.trim().toLowerCase()
    // A server that names no type usually serves a page.
    if (type && type !== 'text/html' && type !== 'application/xhtml+xml' && type !== 'text/plain') return { kind: 'failed', message: `暂时只能加入网页和 PDF（这是 ${type}）` }
    const html = decodeHtml(fetched.body, fetched.contentType)
    const read = type === 'text/plain' ? { title: '', markdown: html } : readPage(html)
    const chunks = chunksFromMarkdown(read.markdown)
    if (textLength(chunks) < MIN_TEXT) return this.exaCopy(url, title ?? read.title, '网页里几乎没有正文（可能要在浏览器里才能显示）', signal)
    return { kind: 'page', title: read.title, markdown: read.markdown, chunks, html, via: 'local' }
  }

  /** Exa's copy of a page this computer cannot open or read. */
  private async exaCopy(url: string, title: string | undefined, why: string, signal?: AbortSignal): Promise<WebPage> {
    const key = await this.settings.key(PROVIDER_KEY.exa)
    if (!key) return { kind: 'failed', message: `${why}，没有 Exa 密钥可以取备用副本` }
    let copy
    try { copy = await exaContents(key, url, signal, this.options.bases?.exa) } catch (error) {
      signal?.throwIfAborted()
      return { kind: 'failed', message: `${why}，Exa 的副本也取不到（${error instanceof Error ? error.message : String(error)}）` }
    }
    const chunks = copy ? chunksFromMarkdown(copy.text) : []
    if (!copy || textLength(chunks) < MIN_TEXT) return { kind: 'failed', message: `${why}，Exa 也没有它的正文` }
    return { kind: 'page', title: title?.trim() || copy.title?.trim() || '', markdown: copy.text, chunks, via: 'exa', why }
  }

  private importPdf(courseId: string, url: string, finalUrl: string, body: Buffer, title: string | undefined, authority: Authority, rule: string): WebAdded {
    const directory = this.store.uploads()
    mkdirSync(directory, { recursive: true })
    const file = join(directory, `${randomUUID()}.part`)
    writeFileSync(file, body)
    const fileName = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || 'web.pdf').replace(/[\\/:*?"<>|]/g, '_')
    const kind: Source['kind'] = rule === '学术出版' ? 'paper' : /标准/.test(rule) ? 'standard' : 'other'
    const task = this.importer.accept(file, {
      title: title?.trim() || fileName.replace(/\.pdf$/i, '') || siteOf(url), fileName: /\.pdf$/i.test(fileName) ? fileName : `${fileName}.pdf`,
      bytes: body.length, fingerprint: createHash('sha256').update(body).digest('hex'), kind, authority, pageOffset: 0, courseId, role: 'reference', url,
    })
    this.store.rememberWeb(url, task.status === 'ready' && task.sourceId ? { sourceId: task.sourceId } : { importId: task.id })
    if (task.status === 'ready' && task.sourceId) {
      this.store.attach(courseId, task.sourceId, 'reference')
      return { url, status: 'added', sourceId: task.sourceId, message: `已在资料库里，已加入本课：《${task.title}》` }
    }
    return { url, status: 'importing', message: `《${task.title}》（${AUTHORITY_TEXT[authority]}，${rule}，PDF）已下载，正在后台解析，完成后可以引用` }
  }
}

function textLength(chunks: readonly { kind: string; text: string }[]): number {
  return chunks.filter(chunk => chunk.kind !== 'heading').reduce((sum, chunk) => sum + chunk.text.replace(/\s+/g, '').length, 0)
}
