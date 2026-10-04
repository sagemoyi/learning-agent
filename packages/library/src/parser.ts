// Local MinerU V1 adapter. The workbench retains the input and identity across server restarts.
import { createReadStream, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { unzipSync } from 'fflate'
import { chunksFromMiddle, type MiddleDocument } from './mineru.ts'

const MAX_RESULT = 256 * 1024 * 1024
const MAX_EXPANDED = 512 * 1024 * 1024
export class ParserUnavailable extends Error {}
export class ParserMissingJob extends Error {}
export interface ParseJob {
  job_id: string
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'canceled'
  files: { status: string; output_files?: { zip?: { file_id: string } }; error?: { code?: string } }[]
}

export class LocalMineru {
  readonly url: URL
  constructor(url = process.env.LEARNING_MINERU_URL ?? 'http://127.0.0.1:16580') {
    this.url = new URL(url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(this.url.hostname) || this.url.protocol !== 'http:' || this.url.username || this.url.password) {
      throw new Error('本轮解析只允许本机 MinerU 服务')
    }
  }

  private async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      response = await fetch(new URL(path, this.url), { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new ParserUnavailable('本地解析服务无法连接，请启动 MinerU 后重试；原 PDF 已保存')
    }
    if (response.status === 404 && path.startsWith('/v1/parse/jobs/')) throw new ParserMissingJob('解析器已重启，正在用原件重新提交')
    if (!response.ok) throw new Error(`本地解析服务返回 ${response.status}，请检查服务后重试`)
    return response
  }

  private async json(path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    return (await this.request(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, signal)).json()
  }

  async submit(file: string, task: { fileName: string; bytes: number; fingerprint: string }, signal: AbortSignal): Promise<string> {
    const health = await this.json('/v1/health', undefined, signal)
    if (!health.features?.output_formats?.includes('zip') || !health.features?.sources?.includes('file_id')) throw new Error('本地解析器缺少完整结果包或文件上传能力')
    const upload = await this.json('/v1/uploads', { filename: task.fileName, bytes: task.bytes, mime_type: 'application/pdf', sha256sum: task.fingerprint, purpose: 'parse' }, signal)
    let fileId: string | undefined = upload.file?.id
    if (upload.status !== 'completed') {
      const uploadUrl = new URL(upload.upload_url, this.url)
      if (uploadUrl.origin !== this.url.origin || upload.upload_method !== 'PUT') throw new Error('本地解析器给出了不支持的上传位置')
      const body = createReadStream(file)
      try {
        await this.request(uploadUrl.pathname, { method: 'PUT', headers: upload.upload_headers, body: body as unknown as BodyInit, duplex: 'half' } as RequestInit, signal)
      } finally { body.destroy() }
      const completed = await this.json(`/v1/uploads/${encodeURIComponent(upload.id)}/complete`, { sha256sum: task.fingerprint }, signal)
      fileId = completed.file?.id
    }
    if (!fileId) throw new Error('解析器没有确认上传完成')
    const job = await this.json('/v1/parse/jobs', { files: [{ source: { type: 'file_id', file_id: fileId } }], tier: 'standard', ocr_mode: 'auto', output_formats: ['zip'] }, signal)
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
    const file = job.files[0]
    if (job.status !== 'completed' || job.files.length !== 1 || file?.status !== 'completed') throw new Error('解析未完整完成，资料尚未入库；请重试')
    const ref = file.output_files?.zip?.file_id
    if (!ref) throw new Error('解析器没有提供包含图像的完整结果包')
    const response = await this.request(`/v1/files/${encodeURIComponent(ref)}/content`, {}, signal)
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
    const buffer = Buffer.concat(parts)
    writeFileSync(join(folder, 'result.zip'), buffer)
    return unpackResult(buffer, join(folder, 'bundle'))
  }
}

/** Validate before publishing any chunks. Raw tables, images and the original ZIP stay on disk. */
export function unpackResult(buffer: Uint8Array, folder: string): { parsed: string; assets: string } {
  let expanded = 0
  const entries = unzipSync(buffer, { filter: entry => {
    expanded += entry.originalSize
    if (expanded > MAX_EXPANDED || entry.originalSize > 64 * 1024 * 1024) throw new Error('解析结果解压后过大')
    if (!safeBundlePath(entry.name)) throw new Error('解析包包含无效文件路径')
    return !entry.name.endsWith('/')
  } })
  const middle = entries['middle_json.json'] ? 'middle_json.json' : entries['layout.json'] ? 'layout.json' : undefined
  if (!middle) throw new Error('解析包缺少结构化页面，不能建立出处')
  const document = JSON.parse(new TextDecoder().decode(entries[middle]!)) as MiddleDocument
  checkEmptyFormulas(document)
  chunksFromMiddle([document])
  for (const image of imagePaths(document)) {
    if (!safeBundlePath(image) || !(entries[image]?.length || entries[`images/${image}`]?.length)) throw new Error('解析包缺少图像资源，请重新解析')
  }
  mkdirSync(folder, { recursive: true })
  for (const [name, data] of Object.entries(entries)) {
    const file = join(folder, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, data)
  }
  const parsed = join(folder, middle)
  if (!existsSync(parsed) || !readFileSync(parsed).length) throw new Error('结构化结果保存失败')
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
