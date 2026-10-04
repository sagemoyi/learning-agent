import { deflateSync } from 'node:zlib'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { pageRanges, pdfPageCount } from '../src/pdf.ts'
import { chunksFromMiddle, fromPdfInfo, type PdfInfoDocument } from '../src/mineru.ts'
import { MineruParser, parserFromEnv } from '../src/parser.ts'
import { Context } from '@deepseek-ai/cordis'
import { Database } from '../../core/src/db.ts'
import { LibraryStore, libraryMigrations } from '../src/store.ts'
import { LibraryImports } from '../src/imports.ts'

const text = (content: string) => ({ lines: [{ spans: [{ type: 'text', content }] }] })

/** A synthetic cloud page: title, text with inline math, formula, table, figure, list. */
function cloudPage(pageIdx: number, title: string): PdfInfoDocument['pdf_info'][number] {
  return {
    page_idx: pageIdx, page_size: [600, 800],
    para_blocks: [
      { type: 'title', index: 0, bbox: [10, 10, 300, 40], ...text(title) },
      { type: 'text', index: 1, bbox: [10, 50, 500, 100], lines: [{ spans: [{ type: 'text', content: '合成正文，压强 ' }, { type: 'inline_equation', content: 'p' }, { type: 'text', content: ' 随深度增加。' }] }] },
      { type: 'interline_equation', index: 2, bbox: [100, 110, 400, 140], lines: [{ spans: [{ type: 'interline_equation', content: 'p = \\rho g h', image_path: 'eq.jpg' }] }] },
      { type: 'table', index: 3, bbox: [10, 150, 500, 250], blocks: [
        { type: 'table_body', lines: [{ spans: [{ type: 'table', html: '<table><tr><td>h</td><td>p</td></tr></table>', image_path: 'tb.jpg' }] }] },
        { type: 'table_caption', ...text('表 1 合成数据') },
      ] },
      { type: 'image', index: 4, bbox: [10, 260, 300, 400], blocks: [
        { type: 'image_body', lines: [{ spans: [{ type: 'image', image_path: 'fig.jpg' }] }] },
        { type: 'image_caption', ...text('图 1 合成水池') },
      ] },
      { type: 'list', index: 5, bbox: [10, 410, 500, 460], blocks: [{ type: 'text', ...text('(1) 第一条') }, { type: 'text', ...text('(2) 第二条') }] },
    ],
  }
}

function cloudBundle(pages: PdfInfoDocument['pdf_info']): Uint8Array<ArrayBuffer> {
  const images = Object.fromEntries(['eq.jpg', 'tb.jpg', 'fig.jpg'].map(name => [`images/${name}`, new Uint8Array([1, 2, 3])]))
  return new Uint8Array(zipSync({ 'layout.json': strToU8(JSON.stringify({ pdf_info: pages, _version_name: '3.4.4' })), 'full.md': strToU8('合成'), 'abc_origin.pdf': new Uint8Array(10), ...images }))
}

/** Minimal PDF whose page tree says `count` pages; `packed` puts the tree root in a compressed object stream. */
function syntheticPdf(count: number, packed = false): Buffer {
  if (!packed) return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count ${count} >>\nendobj\n3 0 obj\n<< /Type /Pages /Parent 2 0 R /Kids [] /Count 1 >>\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1')
  const objects = `<< /Type /Pages /Kids [] /Count ${count} >>`
  const data = deflateSync(Buffer.from(`2 0 ${objects}`, 'latin1'))
  return Buffer.concat([
    Buffer.from(`%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n5 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ])
}

describe('PDF page count and ranges', () => {
  it('reads the page-tree root, also from a compressed object stream', () => {
    expect(pdfPageCount(syntheticPdf(5))).toBe(5)
    expect(pdfPageCount(syntheticPdf(488, true))).toBe(488)
    expect(pdfPageCount(Buffer.from('not a pdf'))).toBeUndefined()
  })
  it('splits pages into consecutive ranges', () => {
    expect(pageRanges(488, 200)).toEqual(['1-200', '201-400', '401-488'])
    expect(pageRanges(200, 200)).toEqual(['1-200'])
  })
})

describe('cloud middle JSON', () => {
  it('converts pdf_info pages into locatable chunks at their original page numbers', () => {
    const document = fromPdfInfo({ pdf_info: [cloudPage(0, '1.1 合成小节')] }, 201)
    const chunks = chunksFromMiddle([document])
    expect(chunks.map(chunk => chunk.kind)).toEqual(['heading', 'text', 'formula', 'table', 'figure', 'text'])
    expect(chunks.every(chunk => chunk.locator.page === 201)).toBe(true)
    expect(chunks[1]).toMatchObject({ section: ['1.1 合成小节'], text: '合成正文，压强 $p$ 随深度增加。', locator: { bbox: [10, 50, 500, 100], pageSize: [600, 800] } })
    expect(chunks[2]!.text).toBe('$$\np = \\rho g h\n$$')
    expect(chunks[3]!.text).toContain('h | p')
    expect(chunks[4]!.text).toBe('图 1 合成水池')
    expect(chunks[5]!.text).toBe('(1) 第一条\n(2) 第二条')
  })
})

describe('MinerU cloud adapter', () => {
  let root: string
  afterEach(() => { vi.unstubAllGlobals(); if (root) rmSync(root, { recursive: true, force: true }) })

  /**
   * Fake MinerU cloud: two pages per file; each range's result has one heading per page named after
   * that page. Ranges listed in `failOnce` fail the first time they are parsed.
   */
  function fakeCloud(failOnce: string[] = [], maxPages = 2, shortOnce: string[] = []) {
    const calls: { url: string; auth: string | null }[] = []
    const jobs: string[][] = []
    vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(input), auth = new Headers(init?.headers).get('authorization')
      calls.push({ url: url.href, auth })
      if (url.host === 'oss.example') {
        if (url.pathname.startsWith('/upload')) return new Response(null, { status: 200 })
        const [first, last] = url.pathname.split('/').at(-1)!.split('-').map(Number) as [number, number]
        const short = shortOnce.includes(`${first}-${last}`)
        if (short) shortOnce.splice(shortOnce.indexOf(`${first}-${last}`), 1)
        return new Response(cloudBundle(Array.from({ length: last - first + 1 - (short ? 1 : 0) }, (_, i) => cloudPage(i, `${first + i}.1 合成小节`))))
      }
      const path = url.pathname.replace(/^\/api/, '')
      if (path === '/v1/health') return Response.json({ features: { output_formats: ['zip'], sources: ['file_id'] } })
      if (path === '/v1/usage') return Response.json({ limits: { max_pages_per_file: maxPages } })
      if (path === '/v1/uploads') return Response.json({ id: 'u1', status: 'pending', upload_url: 'https://oss.example/upload/u1', upload_method: 'PUT', upload_headers: { 'Content-Type': '' } })
      if (path === '/v1/uploads/u1/complete') return Response.json({ file: { id: 'f1' } })
      if (path === '/v1/parse/jobs') {
        jobs.push((JSON.parse(String(init?.body)) as { files: { page_range?: string }[] }).files.map(file => file.page_range ?? ''))
        return Response.json({ job_id: `j${jobs.length}` })
      }
      const job = /^\/v1\/parse\/jobs\/j(\d+)$/.exec(path)
      if (job) {
        const files = jobs[Number(job[1]) - 1]!.map(range => {
          const fails = failOnce.includes(range)
          if (fails) failOnce.splice(failOnce.indexOf(range), 1)
          return fails ? { status: 'failed', page_range: range.replace('-', '~'), error: { code: 'parsing_failed', message: 'parsing failed, please try again later' } }
            : { status: 'completed', page_range: range.replace('-', '~'), output_files: { zip: { file_id: `r${range}` } } }
        })
        return Response.json({ job_id: `j${job[1]}`, status: files.some(file => file.status === 'failed') ? 'partial' : 'completed', files })
      }
      if (path.startsWith('/v1/files/r')) return new Response(null, { status: 302, headers: { location: `https://oss.example/result/${path.split('/')[3]!.slice(1)}` } })
      throw new Error(`unexpected ${url.href}`)
    }))
    return { calls, jobs }
  }

  it('uploads once, parses a long PDF in ranges, never sends the key elsewhere, and merges the parts', async () => {
    root = mkdtempSync(join(tmpdir(), 'learning-cloud-'))
    const pdf = join(root, 'book.pdf'); writeFileSync(pdf, syntheticPdf(5))
    const { calls, jobs } = fakeCloud()
    const parser = new MineruParser('https://mineru.example/api', 'synthetic-key')
    const signal = new AbortController().signal
    const ranges = await parser.pending(pdf, root, signal)
    expect(ranges).toEqual(['1-2', '3-4', '5-5'])
    const id = await parser.submit(pdf, { fileName: 'book.pdf', bytes: 100, fingerprint: 'f'.repeat(64) }, signal, ranges)
    expect(jobs[0]).toEqual(['1-2', '3-4', '5-5'])
    expect(await parser.collect(await parser.status(id, signal), root, signal)).toEqual([])
    expect(await parser.pending(pdf, root, signal)).toEqual([])
    const result = parser.assemble(root)
    const chunks = chunksFromMiddle([JSON.parse(readFileSync(result.parsed, 'utf8'))])
    expect([...new Set(chunks.map(chunk => chunk.locator.page))]).toEqual([1, 2, 3, 4, 5])
    expect(chunks.find(chunk => chunk.locator.page === 3)?.section).toEqual(['3.1 合成小节'])
    expect(calls.filter(call => call.url.startsWith('https://oss.example')).every(call => call.auth === null)).toBe(true)
    expect(calls.filter(call => call.url.startsWith('https://mineru.example')).every(call => call.auth === 'Bearer synthetic-key')).toBe(true)
    expect(() => readFileSync(join(result.assets, 'part-1', 'abc_origin.pdf'))).toThrow()
  })

  it('keeps finished ranges and parses only the failed one again until the book is complete', async () => {
    root = mkdtempSync(join(tmpdir(), 'learning-cloud-'))
    const db = new Database(join(root, 'learning.db')); db.migrate('library', libraryMigrations)
    const store = new LibraryStore(db.sqlite, fn => db.transaction(fn), root)
    const { jobs } = fakeCloud(['3-4'])
    const imports = new LibraryImports(new Context(), store, new MineruParser('https://mineru.example/api', 'synthetic-key'), 1, 1)
    const file = join(root, 'upload.pdf'); writeFileSync(file, syntheticPdf(5))
    const task = imports.accept(file, { title: '合成长书', fileName: 'book.pdf', bytes: 100, fingerprint: 'e'.repeat(64), kind: 'textbook', authority: '1', pageOffset: 0 })
    await vi.waitFor(() => expect(store.importTask(task.id).status).toBe('ready'), { timeout: 2000 })
    expect(jobs).toEqual([['1-2', '3-4', '5-5'], ['3-4']])
    const sourceId = store.importTask(task.id).sourceId!
    expect(store.outline(sourceId).map(entry => entry.section.at(-1))).toEqual(['1.1 合成小节', '2.1 合成小节', '3.1 合成小节', '4.1 合成小节', '5.1 合成小节'])
    expect(store.source(sourceId)?.parser?.where).toBe('cloud')
    imports.dispose(); db.close()
  })

  it('gives up after smaller retries, naming the pages, and keeps what finished', async () => {
    root = mkdtempSync(join(tmpdir(), 'learning-cloud-'))
    const db = new Database(join(root, 'learning.db')); db.migrate('library', libraryMigrations)
    const store = new LibraryStore(db.sqlite, fn => db.transaction(fn), root)
    fakeCloud(['5-5', '5-5', '5-5', '5-5'])
    const imports = new LibraryImports(new Context(), store, new MineruParser('https://mineru.example/api', 'synthetic-key'), 1, 1)
    const file = join(root, 'upload.pdf'); writeFileSync(file, syntheticPdf(5))
    const task = imports.accept(file, { title: '合成长书', fileName: 'book.pdf', bytes: 100, fingerprint: 'd'.repeat(64), kind: 'textbook', authority: '1', pageOffset: 0 })
    await vi.waitFor(() => expect(store.importTask(task.id).status).toBe('failed'), { timeout: 2000 })
    expect(store.importTask(task.id).message).toContain('第 5-5 页')
    expect(store.sources()).toHaveLength(0)
    expect(existsSync(join(store.importFolder(task.id), 'parts', '00001-00002.zip'))).toBe(true)
    imports.dispose(); db.close()
  })

  it('explains a rejected key, and chooses the parser from the environment', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    const parser = new MineruParser('https://mineru.example/api', 'bad')
    await expect(parser.status('j1', new AbortController().signal)).rejects.toThrow('MINERU_API_KEY')
    expect(parserFromEnv({ MINERU_API_KEY: 'k' }).where).toBe('云端')
    expect(parserFromEnv({ MINERU_API_KEY: 'k', LEARNING_PARSER: 'local' }).where).toBe('本机')
    expect(parserFromEnv({}).where).toBe('本机')
    expect(() => new MineruParser('http://mineru.example/api', 'k')).toThrow('HTTPS')
  })

  it('rejects an empty cloud job instead of submitting the PDF endlessly', async () => {
    root = mkdtempSync(join(tmpdir(), 'learning-cloud-'))
    const parser = new MineruParser('https://mineru.example/api', 'synthetic-key')
    await expect(parser.collect({ job_id: 'empty', status: 'completed', files: [] }, root, new AbortController().signal)).rejects.toThrow('没有返回任何页段')
  })

  it('does not accept a completed range whose result is missing pages', async () => {
    root = mkdtempSync(join(tmpdir(), 'learning-cloud-'))
    const db = new Database(join(root, 'learning.db')); db.migrate('library', libraryMigrations)
    const store = new LibraryStore(db.sqlite, fn => db.transaction(fn), root)
    const { jobs } = fakeCloud([], 2, ['3-4'])
    const imports = new LibraryImports(new Context(), store, new MineruParser('https://mineru.example/api', 'synthetic-key'), 1, 1)
    const file = join(root, 'upload.pdf'); writeFileSync(file, syntheticPdf(5))
    const task = imports.accept(file, { title: '合成缺页结果', fileName: 'book.pdf', bytes: 100, fingerprint: 'a'.repeat(64), kind: 'textbook', authority: '1', pageOffset: 0 })
    await vi.waitFor(() => expect(store.importTask(task.id).status).toBe('ready'))
    expect(jobs).toEqual([['1-2', '3-4', '5-5'], ['3-4']])
    expect(store.outline(store.importTask(task.id).sourceId!)).toHaveLength(5)
    imports.dispose(); db.close()
  })

  it('splits failed ranges into smaller parts and retains saved parts when manually retried', async () => {
    root = mkdtempSync(join(tmpdir(), 'learning-cloud-'))
    const db = new Database(join(root, 'learning.db')); db.migrate('library', libraryMigrations)
    const store = new LibraryStore(db.sqlite, fn => db.transaction(fn), root)
    const { jobs } = fakeCloud(['201-350', '201-300', '201-250', '201-225'])
    // Use the real service cap here, so the four rounds exercise 200 → 100 → 50 → 25 pages.
    const imports = new LibraryImports(new Context(), store, new MineruParser('https://mineru.example/api', 'synthetic-key', 200), 1, 1)
    const file = join(root, 'upload.pdf'); writeFileSync(file, syntheticPdf(350))
    const task = imports.accept(file, { title: '合成补跑长书', fileName: 'book.pdf', bytes: 100, fingerprint: 'b'.repeat(64), kind: 'textbook', authority: '1', pageOffset: 0 })
    await vi.waitFor(() => expect(store.importTask(task.id).status).toBe('failed'), { timeout: 3000 })
    expect(store.sources()).toHaveLength(0)
    imports.retry(task.id)
    await vi.waitFor(() => expect(store.importTask(task.id).status).toBe('ready'), { timeout: 3000 })
    expect(jobs).toEqual([
      ['1-200', '201-350'], ['201-300', '301-350'], ['201-250', '251-300'],
      ['201-225', '226-250'], ['201-225'],
    ])
    expect(store.outline(store.importTask(task.id).sourceId!)).toHaveLength(350)
    imports.dispose(); db.close()
  })
})
