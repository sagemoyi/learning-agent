// Exact authenticated DSH fetch routes for binary files; never intercept the shared /api gateway.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, mkdirSync, statSync } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { Authority, CourseSource, SourceKind } from '@learning-agent/contracts'
import type { LibraryStore } from './store.ts'
import type { LibraryImports } from './imports.ts'

const LIMIT = 200 * 1024 * 1024
const metadata = z.object({ title: z.string().trim().min(1).max(300), fileName: z.string().min(1).max(255), kind: SourceKind, authority: Authority, pageOffset: z.number().int(), courseId: z.string().optional(), role: CourseSource.shape.role.optional() })

export function registerFiles(ctx: Context, store: LibraryStore, imports: LibraryImports): void {
  const route = (method: string, methods: ('GET' | 'POST')[], requestBody: 'streaming' | 'buffered', handler: (request: Request) => Promise<Response> | Response) => {
    ctx.effect(() => ctx.connection.fetch.register({ path: `/api/learning/library.${method}`, methods, requestBody,
      fetch: async request => {
        try { return await handler(request) } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : '文件操作失败' }, { status: 400 })
        }
      },
    }), `library: ${method}`)
  }
  route('upload', ['POST'], 'streaming', async request => {
    const params = new URL(request.url).searchParams
    const input = metadata.parse(JSON.parse(params.get('metadata') ?? '{}'))
    input.fileName = basename(input.fileName.replace(/\\/g, '/'))
    if (!/\.pdf$/i.test(input.fileName)) throw new Error('请选择 PDF 文件')
    if (input.courseId && !ctx.learnCore.courses.get(input.courseId)) throw new Error('找不到要加入的课程')
    if (!request.body) throw new Error('上传文件为空')
    const directory = join(ctx.learnCore.dataRoot, 'library', 'uploads')
    mkdirSync(directory, { recursive: true })
    const file = join(directory, `${randomUUID()}.part`)
    const handle = await open(file, 'wx')
    const reader = request.body.getReader()
    const hash = createHash('sha256')
    let bytes = 0
    let signature = Buffer.alloc(0)
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.length
        if (bytes > LIMIT) throw new Error('PDF 超过 200 MB，请先拆分')
        if (signature.length < 1024) signature = Buffer.concat([signature, part.value]).subarray(0, 1024)
        hash.update(part.value)
        // FileHandle.write can be partial; writeFile consumes the entire chunk at the current position.
        await handle.writeFile(part.value)
      }
      if (!bytes || !signature.toString('latin1').includes('%PDF-')) throw new Error('文件不是有效的 PDF')
      await handle.sync()
      await handle.close()
      const task = imports.accept(file, { ...input, bytes, fingerprint: hash.digest('hex') })
      return Response.json(task, { status: 202 })
    } finally {
      await reader.cancel().catch(() => {})
      await handle.close().catch(() => {})
      await rm(file, { force: true })
    }
  })
  route('original', ['GET'], 'buffered', request => {
    const sourceId = new URL(request.url).searchParams.get('sourceId') ?? ''
    return serveFile(store.original(sourceId), request, 'application/pdf')
  })
  route('pdfAsset', ['GET'], 'buffered', request => {
    const name = new URL(request.url).searchParams.get('file') ?? ''
    if (!/^(pdf\.worker\.min\.mjs|(cmaps|standard_fonts|wasm)\/[A-Za-z0-9_.-]+)$/.test(name)) throw new Error('找不到阅读器资源')
    const root = resolve(import.meta.dirname, 'pdf-assets')
    const file = resolve(root, name)
    if (!file.startsWith(root + sep)) throw new Error('无效资源位置')
    return serveFile(file, request, extname(file) === '.mjs' ? 'text/javascript' : extname(file) === '.wasm' ? 'application/wasm' : 'application/octet-stream')
  })
}

export function serveFile(file: string, request: Request, type: string): Response {
  const size = statSync(file).size
  const headers = new Headers({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' })
  const range = request.headers.get('range')
  let start = 0, end = size - 1
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    if (!match[1]) start = Math.max(0, size - Number(match[2]))
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])) }
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
  }
  headers.set('Content-Length', String(end - start + 1))
  return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers })
}
