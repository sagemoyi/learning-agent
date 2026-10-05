// MinerU V1 adapter: the local service or the MinerU cloud (same protocol, with an API key).
// The workbench retains the input and identity across server restarts.
import { createReadStream, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { unzipSync } from 'fflate'
import { chunksFromMiddle, fromPdfInfo, type MiddleDocument, type PdfInfoDocument } from './mineru.ts'
import { pageRanges, pdfPageCount } from './pdf.ts'

const MAX_RESULT = 256 * 1024 * 1024
const MAX_EXPANDED = 512 * 1024 * 1024
/** MinerU cloud's per-file page limit when `/v1/usage` does not say otherwise. */
const CLOUD_PAGES_PER_FILE = 200
const CLOUD_URL = 'https://mineru.net/api'
export class ParserUnavailable extends Error {}
export class ParserMissingJob extends Error {}
export interface ParseJob {
  job_id: string
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'canceled'
  files: { status: string; page_range?: string; output_files?: { zip?: { file_id: string } }; error?: { code?: string; message?: string } }[]
}

export class MineruParser {
  readonly url: URL
  /** Shown in task messages: where the PDF is parsed. */
  readonly where: '本机' | '云端'
  /** `pagesPerFile` overrides the cloud's per-file page limit (acceptance tests split small PDFs). */
  constructor(url: string, private readonly apiKey?: string, private readonly pagesPerFile?: number) {
    this.url = new URL(url.endsWith('/') ? url : `${url}/`)
    if (this.url.username || this.url.password) throw new Error('解析服务地址不能包含账号信息')
    if (apiKey) {
      if (this.url.protocol !== 'https:') throw new Error('云端解析必须使用 HTTPS')
      this.where = '云端'
    } else {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(this.url.hostname) || this.url.protocol !== 'http:') throw new Error('没有云端密钥时只允许本机 MinerU 服务')
      this.where = '本机'
    }
  }

  get cloud(): boolean { return !!this.apiKey }

  private endpoint(path: string): URL {
    return new URL(path.replace(/^\//, ''), this.url)
  }

  private async request(path: string | URL, init: RequestInit & { timeoutMs?: number } = {}, signal?: AbortSignal): Promise<Response> {
    const { timeoutMs, ...rest } = init
    const url = path instanceof URL ? path : this.endpoint(path)
    const own = url.origin === this.url.origin
    const headers = new Headers(rest.headers)
    if (own && this.apiKey) headers.set('Authorization', `Bearer ${this.apiKey}`)
    const timeout = AbortSignal.timeout(timeoutMs ?? 120_000)
    let response: Response
    try {
      response = await fetch(url, { ...rest, headers, redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new ParserUnavailable(this.cloud ? '连接 MinerU 云端失败，请检查网络后重试；原 PDF 已保存' : '本地解析服务无法连接，请启动 MinerU 后重试；原 PDF 已保存')
    }
    // Result files may redirect to object storage; follow once, never forwarding the key.
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      const target = new URL(response.headers.get('location')!, url)
      if (target.protocol !== 'https:' && target.origin !== this.url.origin) throw new Error('解析服务给出了不安全的下载地址')
      return this.request(target, { method: 'GET', ...(timeoutMs ? { timeoutMs } : {}) }, signal)
    }
    if (response.status === 404 && url.pathname.includes('/v1/parse/jobs/')) throw new ParserMissingJob('解析器已重启，正在用原件重新提交')
    if (response.status === 401 || response.status === 403) throw new Error('MinerU 云端拒绝了密钥，请在 设置 › 资料服务 里检查 MinerU 密钥')
    if (response.status === 429) throw new ParserUnavailable('MinerU 云端额度或频率已达上限，稍后重试；原 PDF 已保存')
    if (!response.ok) throw new Error(`${this.where}解析服务返回 ${response.status}${await errorDetail(response)}，请稍后重试`)
    return response
  }

  private async json(path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    return (await this.request(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal)).json()
  }

  /** Reach the service without parsing anything: the cloud's quota (which needs a valid key), or the local service's health. */
  async check(signal?: AbortSignal): Promise<void> {
    await this.json(this.cloud ? '/v1/usage' : '/v1/health', undefined, signal)
  }

  /**
   * Cloud page ranges still to parse: pages not covered by parts already saved in `folder`, cut into
   * ranges of at most `maxPages` (the cloud's per-file limit unless a retry asks for smaller ones).
   * `['']` means the whole file in one piece (page count unknown, or the local service).
   */
  async pending(file: string, folder: string, signal: AbortSignal, maxPages?: number): Promise<string[]> {
    if (!this.cloud) return ['']
    const pages = pdfPageCount(readFileSync(file))
    const done = savedParts(folder)
    if (!pages) return done.length ? [] : ['']
    const usage = this.pagesPerFile ? undefined : await this.json('/v1/usage', undefined, signal).catch(() => undefined)
    const limit = Math.min(maxPages ?? Infinity, this.pagesPerFile ?? (Number(usage?.limits?.max_pages_per_file) || CLOUD_PAGES_PER_FILE))
    const ranges: string[] = []
    let start = 1
    for (const part of [...done, { first: pages + 1, last: pages + 1 }]) {
      if (part.first > start) for (const range of pageRanges(part.first - start, limit)) {
        const [a, b] = range.split('-').map(Number) as [number, number]
        ranges.push(`${a + start - 1}-${b + start - 1}`)
      }
      start = Math.max(start, part.last + 1)
    }
    return ranges.length === 1 && ranges[0] === `1-${pages}` && pages <= limit ? [''] : ranges
  }

  /**
   * Save every finished cloud part of the job in `folder/parts` (validated first) and report the
   * ranges that failed, so only those are parsed again.
   */
  async collect(job: ParseJob, folder: string, signal: AbortSignal): Promise<{ range: string; message: string }[]> {
    if (!job.files.length) throw new Error('云端任务没有返回任何页段，原 PDF 已保存，请重试')
    const failed: { range: string; message: string }[] = []
    const original = join(folder, 'original.pdf')
    const pageCount = existsSync(original) ? pdfPageCount(readFileSync(original)) : undefined
    mkdirSync(join(folder, 'parts'), { recursive: true })
    for (const file of job.files) {
      const [first, last] = rangeOf(file.page_range)
      const name = join(folder, 'parts', partName(first, last))
      if (existsSync(name)) continue
      const ref = file.output_files?.zip?.file_id
      if (file.status !== 'completed' || !ref) {
        failed.push({ range: file.page_range?.replace('~', '-') ?? '全部', message: file.error?.message ?? file.error?.code ?? '解析失败' })
        continue
      }
      try {
        const buffer = await this.download(ref, signal)
        const { document } = middleOf(unzipBundle(buffer), first)
        const finalPage = pageCount ? Math.min(last, pageCount) : last < 99_999 ? last : undefined
        const pages = new Set(document.pages.map(page => page.page_idx + 1))
        if (!pages.size || (finalPage !== undefined && (document.pages.length !== finalPage - first + 1 || pages.size !== finalPage - first + 1 || [...pages].some(page => !Number.isInteger(page) || page < first || page > finalPage)))) {
          throw new Error('结果包页码不完整，缺失或重复的页面需要重新解析')
        }
        chunksFromMiddle([document])
        writeFileSync(name, buffer)
      } catch (error) {
        signal.throwIfAborted()
        failed.push({ range: `${first}-${last}`, message: error instanceof Error ? error.message : '结果包无效' })
      }
    }
    return failed
  }

  /** Merge the saved cloud parts into one structured document. */
  assemble(folder: string): { parsed: string; assets: string } {
    const parts = savedParts(folder)
    if (parts.length === 0) throw new Error('没有已完成的解析结果')
    const bundle = join(folder, 'bundle')
    rmSync(bundle, { recursive: true, force: true })
    const loaded = parts.map(part => ({ buffer: readFileSync(join(folder, 'parts', partName(part.first, part.last))), firstPage: part.first }))
    return loaded.length === 1 && loaded[0]!.firstPage === 1 ? unpackResult(loaded[0]!.buffer, bundle) : unpackParts(loaded, bundle)
  }

  async submit(file: string, task: { fileName: string; bytes: number; fingerprint: string }, signal: AbortSignal, ranges: readonly string[] = ['']): Promise<string> {
    const health = await this.json('/v1/health', undefined, signal)
    if (!health.features?.output_formats?.includes('zip') || !health.features?.sources?.includes('file_id')) throw new Error('解析服务缺少完整结果包或文件上传能力')
    const upload = await this.json('/v1/uploads', { filename: task.fileName, bytes: task.bytes, mime_type: 'application/pdf', sha256sum: task.fingerprint, purpose: 'parse' }, signal)
    let fileId: string | undefined = upload.file?.id
    if (upload.status !== 'completed') {
      const uploadUrl = new URL(upload.upload_url, this.url)
      const allowed = uploadUrl.origin === this.url.origin || (this.cloud && uploadUrl.protocol === 'https:')
      if (!allowed || (upload.upload_method ?? 'PUT') !== 'PUT') throw new Error('解析服务给出了不支持的上传位置')
      // Object storage wants a known length, so the cloud upload sends the whole file (≤ 200 MB).
      const body = this.cloud ? readFileSync(file) : createReadStream(file)
      try {
        await this.request(uploadUrl, { method: 'PUT', headers: upload.upload_headers, body: body as unknown as BodyInit, ...(this.cloud ? {} : { duplex: 'half' }), timeoutMs: 120_000 + Math.ceil(task.bytes / 256) } as RequestInit, signal)
      } finally { if (!Buffer.isBuffer(body)) body.destroy() }
      const completed = await this.json(`/v1/uploads/${encodeURIComponent(upload.id)}/complete`, { sha256sum: task.fingerprint }, signal)
      fileId = completed.file?.id
    }
    if (!fileId) throw new Error('解析器没有确认上传完成')
    const files = ranges.map(range => ({ source: { type: 'file_id', file_id: fileId }, ...(range ? { page_range: range } : {}) }))
    const job = await this.json('/v1/parse/jobs', { files, tier: 'standard', ocr_mode: 'auto', output_formats: ['zip'] }, signal)
    if (typeof job.job_id !== 'string') throw new Error('解析器没有返回任务编号')
    return job.job_id
  }

  async status(id: string, signal: AbortSignal): Promise<ParseJob> {
    return this.json(`/v1/parse/jobs/${encodeURIComponent(id)}`, undefined, signal)
  }

  async cancel(id: string): Promise<void> {
    await this.request(`/v1/parse/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async result(job: ParseJob, folder: string, signal: AbortSignal): Promise<{ parsed: string; assets: string }> {
    if (job.status !== 'completed' || job.files.length === 0 || job.files.some(file => file.status !== 'completed')) throw new Error('解析未完整完成，资料尚未入库；请重试')
    const parts: { buffer: Uint8Array; firstPage: number }[] = []
    for (const [i, file] of job.files.entries()) {
      const ref = file.output_files?.zip?.file_id
      if (!ref) throw new Error('解析器没有提供包含图像的完整结果包')
      const buffer = await this.download(ref, signal)
      writeFileSync(join(folder, job.files.length === 1 ? 'result.zip' : `result-${i + 1}.zip`), buffer)
      parts.push({ buffer, firstPage: firstPageOf(file.page_range) })
    }
    return parts.length === 1 && parts[0]!.firstPage === 1 ? unpackResult(parts[0]!.buffer, join(folder, 'bundle')) : unpackParts(parts, join(folder, 'bundle'))
  }

  private async download(ref: string, signal: AbortSignal): Promise<Buffer> {
    const response = await this.request(`/v1/files/${encodeURIComponent(ref)}/content`, { timeoutMs: 600_000 }, signal)
    if (!response.body) throw new Error('解析结果包为空')
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.length
        if (bytes > MAX_RESULT) throw new Error('解析结果包超过本地导入上限')
        parts.push(part.value)
      }
    } finally { await reader.cancel().catch(() => {}) }
    return Buffer.concat(parts)
  }
}

/** The local service; kept as its own name for the tests and the advanced entry. */
export class LocalMineru extends MineruParser {
  constructor(url = 'http://127.0.0.1:16580') { super(url) }
}

/** How the settings say PDFs are parsed (the library unit's `parser` and `localParserUrl` fields). */
export interface ParserChoice {
  readonly parser: 'cloud' | 'local'
  readonly localUrl: string
}

/**
 * The parser the settings choose. Cloud parsing without a MinerU key cannot start: the task waits until a
 * key is saved or the setting switches to the local service.
 */
export function chooseParser(choice: ParserChoice, apiKey: string | undefined): MineruParser {
  if (choice.parser === 'local') return new LocalMineru(choice.localUrl)
  if (!apiKey) throw new ParserUnavailable('云端解析需要 MinerU 密钥：在 设置 › 资料服务 里填写后点重试，或改用本机解析；原 PDF 已保存')
  return new MineruParser(process.env.LEARNING_MINERU_CLOUD_URL ?? CLOUD_URL, apiKey)
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string }; msg?: string; message?: string }
    const text = body.error?.message ?? body.msg ?? body.message
    return text ? `（${String(text).slice(0, 120)}）` : ''
  } catch { return '' }
}

/** First PDF page of a range ("201-400" or the cloud's "201~400"); 1 when the whole file was parsed. */
function firstPageOf(range: string | undefined): number {
  return rangeOf(range)[0]
}

/** [first, last] of a range; a whole-file part counts as starting at page 1 with an open end. */
function rangeOf(range: string | undefined): [number, number] {
  const match = /^\s*(\d+)\s*[-~]\s*(\d+)/.exec(range ?? '')
  return match ? [Number(match[1]), Number(match[2])] : [1, 99_999]
}

const partName = (first: number, last: number) => `${String(first).padStart(5, '0')}-${String(last).padStart(5, '0')}.zip`

/** Cloud parts already saved in `folder/parts`, by first page. */
function savedParts(folder: string): { first: number; last: number }[] {
  const dir = join(folder, 'parts')
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap(name => {
    const match = /^(\d{5})-(\d{5})\.zip$/.exec(name)
    return match ? [{ first: Number(match[1]), last: Number(match[2]) }] : []
  }).sort((a, b) => a.first - b.first)
}

/** A part's original-PDF copy is not needed: the workbench keeps the original itself. */
const SKIP_ENTRY = /_origin\.pdf$/i

function unzipBundle(buffer: Uint8Array): Record<string, Uint8Array> {
  let expanded = 0
  return unzipSync(buffer, { filter: entry => {
    if (!safeBundlePath(entry.name)) throw new Error('解析包包含无效文件路径')
    if (SKIP_ENTRY.test(entry.name) || entry.name.endsWith('/')) return false
    expanded += entry.originalSize
    if (expanded > MAX_EXPANDED || entry.originalSize > 64 * 1024 * 1024) throw new Error('解析结果解压后过大')
    return true
  } })
}

/** The structured pages of one bundle in the `docvortex.middle` shape, whichever MinerU wrote them. */
function middleOf(entries: Record<string, Uint8Array>, firstPage: number): { name: string; document: MiddleDocument } {
  const name = entries['middle_json.json'] ? 'middle_json.json' : entries['layout.json'] ? 'layout.json' : undefined
  if (!name) throw new Error('解析包缺少结构化页面，不能建立出处')
  const raw = JSON.parse(new TextDecoder().decode(entries[name]!)) as MiddleDocument | PdfInfoDocument
  const document = 'pdf_info' in raw ? fromPdfInfo(raw, firstPage) : raw
  checkEmptyFormulas(document)
  for (const image of imagePaths(document)) {
    if (!safeBundlePath(image) || !(entries[image]?.length || entries[`images/${image}`]?.length)) throw new Error('解析包缺少图像资源，请重新解析')
  }
  return { name, document }
}

function writeEntries(entries: Record<string, Uint8Array>, folder: string): void {
  mkdirSync(folder, { recursive: true })
  for (const [name, data] of Object.entries(entries)) {
    const file = join(folder, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, data)
  }
}

/** Validate before publishing any chunks. Raw tables, images and the original ZIP stay on disk. */
export function unpackResult(buffer: Uint8Array, folder: string): { parsed: string; assets: string } {
  const entries = unzipBundle(buffer)
  const { name, document } = middleOf(entries, 1)
  chunksFromMiddle([document])
  writeEntries(entries, folder)
  // A cloud bundle is converted once, so later imports and reparses read one shape.
  const parsed = name === 'middle_json.json' ? join(folder, name) : join(folder, 'middle_json.json')
  if (name !== 'middle_json.json') writeFileSync(parsed, JSON.stringify(document))
  if (!existsSync(parsed) || !readFileSync(parsed).length) throw new Error('结构化结果保存失败')
  return { parsed, assets: folder }
}

/** Several page ranges of one PDF: each part keeps its own folder; the merged pages become one document. */
export function unpackParts(parts: readonly { buffer: Uint8Array; firstPage: number }[], folder: string): { parsed: string; assets: string } {
  const documents: MiddleDocument[] = []
  const bundles = parts.map(({ buffer, firstPage }) => {
    const entries = unzipBundle(buffer)
    documents.push(middleOf(entries, firstPage).document)
    return entries
  })
  chunksFromMiddle(documents) // Throws on overlapping ranges before anything is written.
  bundles.forEach((entries, i) => writeEntries(entries, join(folder, `part-${i + 1}`)))
  const pages = documents.flatMap(document => document.pages)
  const merged: MiddleDocument = { schema: 'docvortex.middle', metadata: { ...documents[0]!.metadata, document: { page_count: pages.length } }, pages }
  const parsed = join(folder, 'middle_json.json')
  writeFileSync(parsed, JSON.stringify(merged))
  return { parsed, assets: folder }
}

function checkEmptyFormulas(value: unknown): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { value.forEach(checkEmptyFormulas); return }
  const record = value as Record<string, unknown>
  if (['equation', 'interline_equation', 'equation_inline'].includes(String(record.type)) && typeof record.content === 'string' && !record.content.trim()) throw new Error('解析结果中有空公式，请检查原文并重新解析')
  Object.values(record).forEach(checkEmptyFormulas)
}

function safeBundlePath(name: string): boolean {
  const parts = name.replace(/\/$/, '').split('/')
  return !!name && !name.startsWith('/') && !/[\\:\x00-\x1f<>|"*?]/.test(name) && parts.every(part =>
    !!part && part !== '..' && part !== '.' && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

function imagePaths(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(imagePaths)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const direct = ['image_path', 'img_path'].flatMap(key => typeof record[key] === 'string' ? [record[key] as string] : [])
  if (['image_body', 'table_body', 'chart_body'].includes(String(record.type)) && typeof record.content === 'string') {
    for (const match of record.content.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      if (!/^(data:|https?:|#)/i.test(match[1]!)) direct.push(decodeURIComponent(match[1]!))
    }
  }
  return [...direct, ...Object.values(record).flatMap(imagePaths)]
}
