import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { Context } from '@deepseek-ai/cordis'
import { Database } from '../../core/src/db.ts'
import { LibraryStore, libraryMigrations } from '../src/store.ts'
import { LibraryImports } from '../src/imports.ts'
import { LocalMineru, unpackResult } from '../src/parser.ts'
import { serveFile } from '../src/files.ts'
import { citationRectangle } from '../src/client/geometry.ts'
import { chunksFromMiddle } from '../src/mineru.ts'

const document = {
  schema: 'docvortex.middle', schema_version: '2.0',
  metadata: { document: { page_count: 2 }, producer: { name: 'mineru', version: '4.0.10' } },
  extensions: { docvortex_layout: { version: 1, pages: [{ page_idx: 1, width_pt: 600, height_pt: 800 }] } },
  pages: [{ page_idx: 1, blocks: [
    { index: 0, type: 'paragraph_title', content: '1.1 合成标题', bbox: [10/600, 10/800, 300/600, 50/800] },
    { index: 1, type: 'text', content: '合成压强正文。', bbox: [20/600, 60/800, 400/600, 120/800] },
    { index: 2, type: 'equation', content: 'p = \\rho g h', bbox: [20/600, 140/800, 300/600, 190/800] },
    { index: 3, type: 'image', content: [{ type: 'image_body', content: '<img src="images/figure.png">' }], bbox: [40/600, 200/800, 300/600, 400/800] },
    { index: 4, type: 'table', content: [{ type: 'table_body', content: '<table><tr><td>1</td><td>10</td></tr></table>' }], bbox: [40/600, 410/800, 300/600, 500/800] },
  ] }],
}
const bundle = () => zipSync({ 'middle_json.json': strToU8(JSON.stringify(document)), 'images/figure.png': new Uint8Array([1, 2, 3]), 'output.md': strToU8('合成') })
const input = { title: '合成资料', fileName: 'source.pdf', bytes: 20, fingerprint: 'a'.repeat(64), kind: 'textbook' as const, authority: '1' as const, pageOffset: 1, courseId: 'course-a', role: 'skeleton' as const }

describe('durable PDF imports', () => {
  let root: string, db: Database, store: LibraryStore, ctx: Context, manager: LibraryImports
  let status: string, submissions: number, remoteIds: string[], handoffs: unknown[]
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'learning-import-'))
    db = new Database(join(root, 'learning.db')); db.migrate('library', libraryMigrations)
    store = new LibraryStore(db.sqlite, fn => db.transaction(fn), root)
    ctx = new Context(); status = 'completed'; submissions = 0; remoteIds = []; handoffs = []
    ctx.on('learning/handoff', event => { handoffs.push(event) })
    vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init?: RequestInit) => {
      const path = new URL(url).pathname
      if (path === '/v1/health') return Response.json({ features: { output_formats: ['zip'], sources: ['file_id'] } })
      if (path === '/v1/uploads') return Response.json({ status: 'completed', file: { id: 'f' } })
      if (path === '/v1/parse/jobs' && init?.method === 'POST') { submissions++; return Response.json({ job_id: `j${submissions}` }) }
      if (path.startsWith('/v1/parse/jobs/')) {
        remoteIds.push(path)
        if (status === 'missing') { status = 'completed'; return Response.json({}, { status: 404 }) }
        return Response.json({ job_id: 'j1', status, files: [{ status, output_files: { zip: { file_id: 'result' } } }] })
      }
      if (path === '/v1/files/result/content') return new Response(bundle())
      throw new Error('unexpected fixture route')
    }))
    manager = new LibraryImports(ctx, store, new LocalMineru(), 5)
  })
  afterEach(async () => {
    manager.dispose(); await new Promise(resolve => setTimeout(resolve, 15))
    vi.unstubAllGlobals(); db.close(); rmSync(root, { recursive: true, force: true })
  })
  const upload = () => { const file = join(root, 'upload.pdf'); writeFileSync(file, '%PDF-synthetic'); return file }
  const wait = async (id: string, wanted: string) => {
    for (let i = 0; i < 100; i++) { if (store.importTask(id).status === wanted) return; await new Promise(resolve => setTimeout(resolve, 5)) }
    throw new Error(`task did not reach ${wanted}: ${store.importTask(id).message}`)
  }

  it('publishes only after preserving original, formulas, images, tables and geometry', async () => {
    const task = manager.accept(upload(), input)
    await wait(task.id, 'ready')
    const ready = store.importTask(task.id)
    const source = store.source(ready.sourceId!)!
    const chunks = store.section(source.id, '1.1')
    expect(chunks[1]!.citation).toBe('《合成资料》p.1')
    expect(chunks[1]!.locator).toEqual({ page: 2, block: 1, bbox: [20, 60, 400, 120], pageSize: [600, 800] })
    expect(chunks.find(chunk => chunk.kind === 'formula')?.text).toContain('\\rho')
    expect(existsSync(join(root, source.folder, 'parsed/bundle/images/figure.png'))).toBe(true)
    expect(readFileSync(join(root, source.folder, 'parsed/bundle/middle_json.json'), 'utf8')).toContain('<table>')
    expect(readFileSync(store.original(source.id), 'utf8')).toBe('%PDF-synthetic')
    expect(handoffs).toHaveLength(1)
    expect(store.courseSources('course-a')[0]?.sourceId).toBe(source.id)
  })

  it('reuses the source and its old citations when attached to another course', async () => {
    const first = manager.accept(upload(), input); await wait(first.id, 'ready')
    const sourceId = store.importTask(first.id).sourceId!
    const chunkIds = store.section(sourceId, '1.1').map(chunk => chunk.id)
    const again = manager.accept(upload(), input)
    expect(again.id).toBe(first.id)
    const other = manager.accept(upload(), { ...input, courseId: 'course-b' }); await wait(other.id, 'ready')
    expect(store.sources()).toHaveLength(1); expect(submissions).toBe(1)
    expect(store.courseSources('course-b')[0]?.sourceId).toBe(sourceId)
    expect(store.section(sourceId, '1.1').map(chunk => chunk.id)).toEqual(chunkIds)
  })

  it('reparses into a new snapshot without invalidating old citations', async () => {
    const first = manager.accept(upload(), input); await wait(first.id, 'ready')
    const oldId = store.importTask(first.id).sourceId!
    const old = store.section(oldId, '1.1')[1]!
    const second = manager.reparse(oldId, 'course-a'); await wait(second.id, 'ready')
    const newId = store.importTask(second.id).sourceId!
    expect(newId).not.toBe(oldId)
    expect(store.source(newId)?.supersedes).toBe(oldId)
    expect(store.chunk(old.id)).toEqual(old)
    expect(readFileSync(store.original(oldId), 'utf8')).toBe('%PDF-synthetic')
    expect(store.sources()).toHaveLength(1)
    expect(store.byFingerprint(input.fingerprint)?.id).toBe(newId)
    expect(store.courseSources('course-a').map(entry => entry.sourceId)).toEqual([newId])
    expect(submissions).toBe(2)
  })
  it('moves every course to a reparse started in the library, and counts old chunks for the new parse', async () => {
    const first = manager.accept(upload(), input); await wait(first.id, 'ready')
    const oldId = store.importTask(first.id).sourceId!
    store.attach('course-b', oldId, 'reference')
    const old = store.section(oldId, '1.1')[1]!
    const task = manager.reparse(oldId); await wait(task.id, 'ready')
    const newId = store.importTask(task.id).sourceId!
    expect(store.courseSources('course-a').map(entry => [entry.sourceId, entry.role])).toEqual([[newId, 'skeleton']])
    expect(store.courseSources('course-b').map(entry => [entry.sourceId, entry.role])).toEqual([[newId, 'reference']])
    expect(store.uses().get(newId)).toEqual([{ courseId: 'course-a', role: 'skeleton' }, { courseId: 'course-b', role: 'reference' }])
    expect(store.uses().has(oldId)).toBe(false)
    expect(store.chunkSources([old.id, 'ck_unknown'])).toEqual({ [old.id]: newId })
    const [heading] = store.outline(newId)
    expect(heading).toMatchObject({ section: ['1.1 合成标题'], page: store.chunk(heading!.chunkId)!.locator.page })
  })
  it('reparses a PDF from the advanced entry in its course role', async () => {
    const pdf = join(root, 'advanced.pdf'); writeFileSync(pdf, '%PDF-advanced')
    const parsed = join(root, 'advanced-middle.json'); writeFileSync(parsed, JSON.stringify(document))
    const old = store.importParsed({ title: '高级入口合成资料', kind: 'textbook', authority: '1', file: pdf, parsed: [parsed], courseId: 'course-a', role: 'skeleton' })
    expect(store.imports()).toHaveLength(0)
    const task = manager.reparse(old.id, 'course-a'); await wait(task.id, 'ready')
    const newId = store.importTask(task.id).sourceId!
    expect(store.source(newId)?.supersedes).toBe(old.id)
    expect(store.courseSources('course-a').map(entry => [entry.sourceId, entry.role])).toEqual([[newId, 'skeleton']])
    expect(store.importTask(task.id)).toMatchObject({ fileName: 'advanced.pdf', bytes: '%PDF-advanced'.length })
  })
  it('corrects printed page labels while preserving the PDF locator and citation id', async () => {
    const task = manager.accept(upload(), input); await wait(task.id, 'ready')
    const sourceId = store.importTask(task.id).sourceId!, chunk = store.section(sourceId, '1.1')[1]!
    store.setPageOffset(sourceId, 0)
    expect(store.chunk(chunk.id)?.citation).toBe('《合成资料》p.2')
    expect(store.chunk(chunk.id)?.locator).toEqual(chunk.locator)
  })

  it('resumes the durable remote task after workbench restart', async () => {
    status = 'running'
    const task = manager.accept(upload(), input)
    await vi.waitFor(() => expect(store.importTask(task.id).remoteId).toBe('j1'))
    manager.dispose(); await new Promise(resolve => setTimeout(resolve, 15))
    db.close(); db = new Database(join(root, 'learning.db'))
    store = new LibraryStore(db.sqlite, fn => db.transaction(fn), root)
    status = 'completed'; manager = new LibraryImports(ctx, store, new LocalMineru(), 5)
    manager.resume(); await wait(task.id, 'ready')
    expect(submissions).toBe(1)
  })

  it('resubmits the saved original if the parser lost its job after restart', async () => {
    status = 'missing'; const task = manager.accept(upload(), input); await wait(task.id, 'ready')
    expect(submissions).toBe(2); expect(remoteIds).toContain('/v1/parse/jobs/j2')
  })

  it('keeps partial output unpublished and allows retry', async () => {
    status = 'partial'; const task = manager.accept(upload(), input); await wait(task.id, 'failed')
    expect(store.sources()).toHaveLength(0); expect(handoffs).toHaveLength(0)
    status = 'completed'; manager.retry(task.id); await wait(task.id, 'ready')
    expect(submissions).toBe(2)
  })

  it('cancels without publishing or losing the input', async () => {
    status = 'running'; const task = manager.accept(upload(), input)
    await vi.waitFor(() => expect(store.importTask(task.id).remoteId).toBe('j1'))
    manager.cancel(task.id); await new Promise(resolve => setTimeout(resolve, 15))
    expect(store.importTask(task.id).status).toBe('canceled'); expect(store.sources()).toHaveLength(0)
    expect(existsSync(join(store.importFolder(task.id), 'original.pdf'))).toBe(true)
    status = 'completed'; manager.retry(task.id); await wait(task.id, 'ready')
  })

  it('shows service unavailability without losing the task, then recovers on retry', async () => {
    const mock = vi.mocked(fetch); mock.mockRejectedValueOnce(new Error('offline'))
    const task = manager.accept(upload(), input); await wait(task.id, 'waiting')
    expect(store.importTask(task.id).message).toContain('原 PDF 已保存')
    const again = manager.accept(upload(), input)
    expect(again.id).toBe(task.id)
    await wait(task.id, 'ready')
  })
})

describe('result validation and file ranges', () => {
  it('rejects missing referenced images and unsafe paths before extracting', () => {
    expect(() => unpackResult(zipSync({ 'middle_json.json': strToU8(JSON.stringify(document)) }), 'unused')).toThrow('缺少图像')
    expect(() => unpackResult(zipSync({ '../escape': strToU8('x') }), 'unused')).toThrow('无效文件路径')
    expect(() => unpackResult(zipSync({ '.. /escape': strToU8('x') }), 'unused')).toThrow('无效文件路径')
    expect(() => unpackResult(zipSync({ 'CON.txt': strToU8('x') }), 'unused')).toThrow('无效文件路径')
  })
  it('rejects empty formulas instead of publishing a successful import', () => {
    const empty = structuredClone(document); empty.pages[0]!.blocks[2]!.content = ''
    expect(() => unpackResult(zipSync({ 'middle_json.json': strToU8(JSON.stringify(empty)) }), 'unused')).toThrow('空公式')
  })
  it('links cross-page exercises and answers even if the parser labels the exercise heading as text', () => {
    const chunks = chunksFromMiddle([{ pages: [
      { page_idx: 0, blocks: [{ index: 0, type: 'text', content: '习题' }, { index: 1, type: 'text', content: '1-1 合成题干第一部分' }] },
      { page_idx: 1, blocks: [{ index: 0, type: 'text', content: '题干续页' }, { index: 1, type: 'equation', content: 'p=100' }, { index: 2, type: 'text', content: '[100 Pa]' }, { index: 3, type: 'text', content: '合成解答续行' }] },
    ] }])
    expect(chunks.map(chunk => chunk.kind)).toEqual(['heading', 'exercise', 'exercise', 'formula', 'answer', 'answer'])
    expect(chunks.slice(1).every(chunk => chunk.problemGroup === '1-1')).toBe(true)
  })
  it('serves bounded PDF ranges and rejects ranges outside the file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pdf-range-')); const file = join(root, 'original.pdf')
    writeFileSync(file, '%PDF-synthetic')
    try {
      const response = serveFile(file, new Request('http://localhost', { headers: { range: 'bytes=0-3' } }), 'application/pdf')
      expect(response.status).toBe(206); expect(await response.text()).toBe('%PDF')
      expect(response.headers.get('content-range')).toBe('bytes 0-3/14')
      expect(serveFile(file, new Request('http://localhost', { headers: { range: 'bytes=99-' } }), 'application/pdf').status).toBe(416)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('citation geometry', () => {
  it.each([0, 90, 180, 270])('aligns visible parser coordinates at intrinsic rotation %i and zoom', rotation => {
    const W = rotation % 180 ? 800 : 600, H = rotation % 180 ? 600 : 800
    const transform = (rect: number[]) => {
      const point = (x: number, y: number) => rotation === 90 ? [2*y,2*x] : rotation === 180 ? [2*(600-x),2*y] : rotation === 270 ? [2*(800-y),2*(600-x)] : [2*x,2*(800-y)]
      return [...point(rect[0]!,rect[1]!),...point(rect[2]!,rect[3]!)]
    }
    expect(citationRectangle({ page: 1, block: 0, bbox: [20, 30, 100, 80], pageSize: [W, H] }, [0, 0, 600, 800], transform, rotation)).toEqual({ left: 40, top: 60, width: 160, height: 100 })
  })
  it('uses page-only fallback for unknown dimensions or invalid boxes', () => {
    expect(citationRectangle({ page: 1, block: 0, bbox: [1, 2, 3, 4] }, [0, 0, 600, 800], r => r)).toBeUndefined()
    expect(citationRectangle({ page: 1, block: 0, bbox: [20, 2, 3, 4], pageSize: [600, 800] }, [0, 0, 600, 800], r => r)).toBeUndefined()
  })
})
