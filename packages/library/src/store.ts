// Library tables and queries. Owner of `library_*` tables and the `library/` folder (contracts §4.5).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  DATA_LAYOUT,
  LearningApiError,
  Source,
  newId,
  safeFileName,
  withFrontmatter,
  type ChunkKind,
  type CitedChunk,
  type CourseSource,
  type ImportParsedInput,
  type Migration,
  type SearchHit,
} from '@learning-agent/contracts'
import { chunksFromMiddle, type MiddleDocument } from './mineru.ts'

export const libraryMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE library_sources (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE library_chunks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        page INTEGER NOT NULL,
        block INTEGER NOT NULL,
        kind TEXT NOT NULL,
        section TEXT NOT NULL,
        text TEXT NOT NULL,
        bbox TEXT
      );
      CREATE INDEX library_chunks_source ON library_chunks (source_id, seq);
      -- Chinese full-text search: trigram tokens (stage-0 V7). Terms shorter than 3 characters fall back to LIKE.
      CREATE VIRTUAL TABLE library_chunks_fts USING fts5 (text, section, content = 'library_chunks', tokenize = 'trigram');
      CREATE TRIGGER library_chunks_ai AFTER INSERT ON library_chunks BEGIN
        INSERT INTO library_chunks_fts (rowid, text, section) VALUES (new.rowid, new.text, new.section);
      END;
      CREATE TRIGGER library_chunks_ad AFTER DELETE ON library_chunks BEGIN
        INSERT INTO library_chunks_fts (library_chunks_fts, rowid, text, section) VALUES ('delete', old.rowid, old.text, old.section);
      END;
      CREATE TABLE library_course_sources (
        course_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (course_id, source_id)
      );
    `,
  },
]

interface ChunkRow {
  id: string
  source_id: string
  page: number
  block: number
  kind: string
  section: string
  text: string
  bbox: string | null
}

const SECTION_SEPARATOR = ' › '

export class LibraryStore {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly transaction: <T>(fn: () => T) => T,
    private readonly dataRoot: string,
  ) {}

  sources(): Source[] {
    return (this.sqlite.prepare('SELECT data FROM library_sources ORDER BY imported_at').all() as { data: string }[])
      .map(row => Source.parse(JSON.parse(row.data)))
  }

  source(sourceId: string): Source | undefined {
    const row = this.sqlite.prepare('SELECT data FROM library_sources WHERE id = ?').get(sourceId) as { data: string } | undefined
    return row ? Source.parse(JSON.parse(row.data)) : undefined
  }

  /** Copy the original and the parser output into `library/<id>-<title>/`, then index every chunk. */
  importParsed(input: ImportParsedInput): Source {
    if (input.parsed.length === 0) throw new LearningApiError('learning/library/invalid-input', '没有给出解析结果文件')
    const documents = input.parsed.map(file => JSON.parse(readFileSync(file, 'utf8')) as MiddleDocument)
    const chunks = chunksFromMiddle(documents)
    if (chunks.length === 0) throw new LearningApiError('learning/library/empty', '解析结果里没有可用的内容块')

    const id = newId('source')
    const folder = `${DATA_LAYOUT.library}/${id}-${safeFileName(input.title)}`
    const absolute = join(this.dataRoot, folder)
    mkdirSync(join(absolute, 'parsed'), { recursive: true })
    copyFileSync(input.file, join(absolute, `original${input.file.slice(input.file.lastIndexOf('.')) || ''}`))
    input.parsed.forEach((file, index) => copyFileSync(file, join(absolute, 'parsed', `${String(index + 1).padStart(2, '0')}-${basename(file)}`)))

    const producer = documents[0]?.metadata?.producer
    const source = Source.parse({
      id,
      title: input.title,
      kind: input.kind,
      authority: input.authority,
      origin: { kind: 'file', fileName: basename(input.file) },
      folder,
      parser: { name: producer?.name ?? 'mineru', ...(producer?.version ? { version: producer.version } : {}), where: 'local' },
      pages: documents[0]?.metadata?.document?.page_count,
      pageOffset: input.pageOffset ?? 0,
      status: 'ready',
      importedAt: new Date().toISOString(),
    })
    writeFileSync(join(absolute, 'source.md'), withFrontmatter(
      { source: id, title: source.title, kind: source.kind, authority: source.authority, file: basename(input.file), pageOffset: source.pageOffset },
      `# ${source.title}\n\n导入于 ${source.importedAt}，共 ${chunks.length} 个片段。\n`,
    ), 'utf8')

    this.transaction(() => {
      this.sqlite.prepare('INSERT INTO library_sources (id, data, imported_at) VALUES (?, ?, ?)').run(id, JSON.stringify(source), source.importedAt)
      const insert = this.sqlite.prepare('INSERT INTO library_chunks (id, source_id, seq, page, block, kind, section, text, bbox) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      chunks.forEach((chunk, seq) => {
        insert.run(newId('chunk'), id, seq, chunk.locator.page, chunk.locator.block, chunk.kind, chunk.section.join(SECTION_SEPARATOR), chunk.text, chunk.locator.bbox ? JSON.stringify(chunk.locator.bbox) : null)
      })
      if (input.courseId) this.attach(input.courseId, id, input.role ?? 'reference')
    })
    return source
  }

  attach(courseId: string, sourceId: string, role: CourseSource['role']): void {
    if (!this.source(sourceId)) throw new LearningApiError('learning/library/not-found', `找不到资料：${sourceId}`)
    this.sqlite.prepare(`INSERT INTO library_course_sources (course_id, source_id, role) VALUES (?, ?, ?)
      ON CONFLICT (course_id, source_id) DO UPDATE SET role = excluded.role`).run(courseId, sourceId, role)
  }

  courseSources(courseId: string): (CourseSource & { source: Source })[] {
    const rows = this.sqlite.prepare('SELECT source_id, role FROM library_course_sources WHERE course_id = ?').all(courseId) as { source_id: string; role: CourseSource['role'] }[]
    return rows.flatMap(row => {
      const source = this.source(row.source_id)
      return source ? [{ courseId: courseId as CourseSource['courseId'], sourceId: source.id, role: row.role, source }] : []
    })
  }

  private cite(row: ChunkRow, sources: Map<string, Source | undefined>): CitedChunk {
    if (!sources.has(row.source_id)) sources.set(row.source_id, this.source(row.source_id))
    const source = sources.get(row.source_id)
    const printed = row.page - (source?.pageOffset ?? 0)
    return {
      id: row.id as CitedChunk['id'],
      sourceId: row.source_id as CitedChunk['sourceId'],
      locator: { page: row.page, block: row.block, ...(row.bbox ? { bbox: JSON.parse(row.bbox) as [number, number, number, number] } : {}) },
      kind: row.kind as ChunkKind,
      section: row.section ? row.section.split(SECTION_SEPARATOR) : [],
      text: row.text,
      citation: `《${source?.title ?? '未知资料'}》p.${printed > 0 ? printed : row.page}`,
    }
  }

  chunk(chunkId: string): CitedChunk | undefined {
    const row = this.sqlite.prepare('SELECT * FROM library_chunks WHERE id = ?').get(chunkId) as ChunkRow | undefined
    return row ? this.cite(row, new Map()) : undefined
  }

  /**
   * Search chunks. Terms of 3+ characters use the trigram index; shorter ones (common in Chinese,
   * e.g. 黏度) use LIKE. Results rank by how many terms they contain, then by bm25.
   */
  search(query: string, options: { courseId?: string; kinds?: readonly ChunkKind[]; limit?: number } = {}): SearchHit[] {
    const terms = [...new Set(query.split(/[\s,，、;；。？?！!:："“”'"()（）]+/).map(term => term.trim()).filter(Boolean))].slice(0, 8)
    if (terms.length === 0) return []
    const limit = options.limit ?? 10
    const filters: string[] = []
    const params: (string | number)[] = []
    if (options.courseId) {
      filters.push('c.source_id IN (SELECT source_id FROM library_course_sources WHERE course_id = ?)')
      params.push(options.courseId)
    }
    if (options.kinds?.length) {
      filters.push(`c.kind IN (${options.kinds.map(() => '?').join(', ')})`)
      params.push(...options.kinds)
    }
    const where = filters.length ? `AND ${filters.join(' AND ')}` : ''

    const candidates = new Map<string, { row: ChunkRow; rank: number }>()
    const long = terms.filter(term => [...term].length >= 3)
    const short = terms.filter(term => [...term].length < 3)
    if (long.length) {
      const match = long.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ')
      const rows = this.sqlite.prepare(`SELECT c.*, bm25(library_chunks_fts) AS rank FROM library_chunks_fts f
        JOIN library_chunks c ON c.rowid = f.rowid WHERE library_chunks_fts MATCH ? ${where} ORDER BY rank LIMIT 200`)
        .all(match, ...params) as unknown as (ChunkRow & { rank: number })[]
      for (const row of rows) candidates.set(row.id, { row, rank: row.rank })
    }
    for (const term of short) {
      const rows = this.sqlite.prepare(`SELECT c.* FROM library_chunks c WHERE (c.text LIKE ? OR c.section LIKE ?) ${where} LIMIT 200`)
        .all(`%${term}%`, `%${term}%`, ...params) as unknown as ChunkRow[]
      for (const row of rows) if (!candidates.has(row.id)) candidates.set(row.id, { row, rank: 0 })
    }
    // A term found in the text counts double a term found only in the section path; a bare heading
    // ranks below the passage under it.
    const hits = [...candidates.values()].map(({ row, rank }) => {
      const inText = terms.filter(term => row.text.includes(term)).length
      const inSection = terms.filter(term => row.section.includes(term)).length
      return { row, rank, matched: inText * 2 + inSection - (row.kind === 'heading' ? 1 : 0) }
    })
    hits.sort((a, b) => b.matched - a.matched || a.rank - b.rank)
    const sources = new Map<string, Source | undefined>()
    return hits.slice(0, limit).map(hit => ({ chunk: this.cite(hit.row, sources), rank: hit.rank - hit.matched }))
  }

  private rows(sourceId: string): ChunkRow[] {
    return this.sqlite.prepare('SELECT * FROM library_chunks WHERE source_id = ? ORDER BY seq').all(sourceId) as unknown as ChunkRow[]
  }

  /** Every chunk under a numbered section (`1.2` includes `1.2.3`), in reading order. */
  section(sourceId: string, section: string): CitedChunk[] {
    const prefix = section.trim()
    const sources = new Map<string, Source | undefined>()
    return this.rows(sourceId)
      .filter(row => row.section.split(SECTION_SEPARATOR).some(part => part === prefix || part.startsWith(`${prefix} `) || part.startsWith(`${prefix}.`)))
      .map(row => this.cite(row, sources))
  }

  outline(sourceId: string): { section: string[]; chunkId: string }[] {
    return this.rows(sourceId)
      .filter(row => row.kind === 'heading')
      .map(row => ({ section: row.section.split(SECTION_SEPARATOR), chunkId: row.id }))
  }

  count(sourceId: string): number {
    return (this.sqlite.prepare('SELECT count(*) AS n FROM library_chunks WHERE source_id = ?').get(sourceId) as { n: number }).n
  }
}
