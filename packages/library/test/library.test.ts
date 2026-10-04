import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@learning-agent/contracts'
import { Database } from '../../core/src/db.ts'
import { chunksFromMiddle, flatten, type MiddleDocument } from '../src/mineru.ts'
import { LibraryStore, libraryMigrations } from '../src/store.ts'

// A made-up two-page parse in MinerU's `docvortex.middle` shape (not textbook text).
const text = (content: string) => [{ type: 'text', content }]
const middle: MiddleDocument = {
  schema: 'docvortex.middle',
  metadata: { producer: { name: 'mineru', version: '4.0.10' }, document: { page_count: 40 } },
  pages: [
    {
      page_idx: 20,
      blocks: [
        { type: 'header', index: 0, content: text('第2章 示例') },
        { type: 'page_number', index: 1, content: text('9') },
        { type: 'paragraph_title', index: 2, content: text('第2章 示例') },
        { type: 'paragraph_title', index: 3, content: text('2.1 静止的水') },
        { type: 'text', index: 4, bbox: [0.1, 0.2, 0.9, 0.3], content: [{ type: 'text', content: '水深越大压强越大，' }, { type: 'equation_inline', content: 'p = \\rho g h' }, { type: 'text', content: '。' }] },
        { type: 'equation', index: 5, content: 'p = p_0 + \\rho g h \\tag{2-1}' },
        { type: 'text', index: 6, content: text('[例 2-1] 求水下 2 m 处的表压。') },
      ],
    },
    {
      page_idx: 21,
      blocks: [
        { type: 'paragraph_title', index: 0, content: text('2.1.1 黏度') },
        { type: 'text', index: 1, content: text('黏度描述流体内摩擦。') },
        { type: 'table', index: 2, content: [{ type: 'table_caption', content: [{ type: 'text', content: '表 2-1 数值' }] }, { type: 'table_body', content: '<table><tr><td>a</td><td>b</td></tr></table>' }] },
        { type: 'paragraph_title', index: 3, content: text('习题') },
        { type: 'text', index: 4, content: text('2-1 一个水池深 3 m，求池底表压。') },
        { type: 'text', index: 5, content: text('[29.4kPa]') },
      ],
    },
  ],
}

describe('MinerU chunking', () => {
  it('drops page furniture, builds section paths, and labels chunk kinds', () => {
    const chunks = chunksFromMiddle([middle])
    expect(chunks.map(chunk => chunk.kind)).toEqual(['heading', 'heading', 'text', 'formula', 'example', 'heading', 'text', 'table', 'heading', 'exercise', 'answer'])
    expect(chunks[2]!.text).toBe('水深越大压强越大，$p = \\rho g h$。')
    expect(chunks[2]!.locator).toEqual({ page: 21, block: 4, bbox: [0.1, 0.2, 0.9, 0.3] })
    expect(chunks[6]!.section).toEqual(['第2章 示例', '2.1 静止的水', '2.1.1 黏度'])
    expect(chunks[9]!.section).toEqual(['第2章 示例', '习题'])
    expect(chunks[3]!.text).toBe('$$\np = p_0 + \\rho g h \\tag{2-1}\n$$')
  })

  it('turns tables into rows', () => {
    expect(flatten({ type: 'table_body', content: '<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>' })).toBe('a | b\n1 | 2')
  })

  it('merges page ranges parsed separately', () => {
    const [first, second] = middle.pages
    const chunks = chunksFromMiddle([{ ...middle, pages: [second!] }, { ...middle, pages: [first!] }])
    expect(chunks[0]!.locator.page).toBe(21)
  })
})

describe('library store', () => {
  let root: string
  let db: Database
  let store: LibraryStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'learning-library-'))
    db = new Database(join(root, '.learning', 'learning.db'))
    db.migrate('library', libraryMigrations)
    store = new LibraryStore(db.sqlite, fn => db.transaction(fn), root)
    writeFileSync(join(root, 'book.pdf'), 'pdf')
    writeFileSync(join(root, 'parsed.json'), JSON.stringify(middle))
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('imports, cites printed pages, searches short and long terms, and reads sections', () => {
    const courseId = newId('course')
    const source = store.importParsed({ title: '示例教材', kind: 'textbook', authority: '1', file: join(root, 'book.pdf'), parsed: [join(root, 'parsed.json')], pageOffset: 12, courseId, role: 'skeleton' })
    expect(store.courseSources(courseId).map(entry => entry.role)).toEqual(['skeleton'])

    const short = store.search('黏度', { courseId })
    expect(short[0]!.chunk.text).toBe('黏度描述流体内摩擦。')
    expect(short[0]!.chunk.citation).toBe('《示例教材》p.10')

    const long = store.search('求池底表压', { courseId, kinds: ['exercise'] })
    expect(long.map(hit => hit.chunk.kind)).toEqual(['exercise'])
    expect(store.search('黏度', { courseId: newId('course') })).toEqual([])

    expect(store.section(source.id, '2.1').map(chunk => chunk.kind)).toEqual(['heading', 'text', 'formula', 'example', 'heading', 'text', 'table'])
    expect(store.section(source.id, '习题')).toHaveLength(3)
    expect(store.outline(source.id).map(entry => entry.section.at(-1))).toEqual(['第2章 示例', '2.1 静止的水', '2.1.1 黏度', '习题'])
  })
})
