// library unit, host half. Provides `ctx.learnLibrary` (contracts §5.1): sources, locatable chunks,
// full-text search with citation labels, durable local PDF imports, original-file reading.
// Hybrid retrieval and web research remain later batches (docs/library/research.md).
import { Service, type Context } from '@deepseek-ai/cordis'
import { Authority, CourseSource, SourceKind, ChunkKind, type LearnLibrary } from '@learning-agent/contracts'
import { z } from 'zod'
import { LibraryStore, libraryMigrations } from './store.ts'
import { LibraryImports } from './imports.ts'
import { registerFiles } from './files.ts'

export const name = 'learning-library'
export const inject = ['learnCore', 'connection', 'jobs']

class LearnLibraryService extends Service implements LearnLibrary {
  readonly store: LibraryStore
  readonly importer: LibraryImports

  constructor(ctx: Context) {
    super(ctx, 'learnLibrary')
    const core = ctx.learnCore
    core.db.migrate('library', libraryMigrations)
    this.store = new LibraryStore(core.db.sqlite, fn => core.db.transaction(fn), core.dataRoot)
    this.importer = new LibraryImports(ctx, this.store)
  }

  imports = () => this.store.imports()
  retryImport = (id: string) => this.importer.retry(id)
  cancelImport = (id: string) => this.importer.cancel(id)
  reparse = (sourceId: string, courseId?: string) => this.importer.reparse(sourceId, courseId)
  setPageOffset = (sourceId: string, offset: number) => {
    const source = this.store.setPageOffset(sourceId, offset)
    this.ctx.emit('learning/source-updated', { sourceId })
    return source
  }

  sources = () => this.store.sources()
  source = (sourceId: string) => this.store.source(sourceId)
  async importParsed(input: Parameters<LearnLibrary['importParsed']>[0]) {
    const source = this.store.importParsed(input)
    this.ctx.emit('learning/source-imported', { sourceId: source.id })
    return source
  }
  attach = (courseId: string, sourceId: string, role: CourseSource['role']) => this.store.attach(courseId, sourceId, role)
  courseSources = (courseId: string) => this.store.courseSources(courseId)
  search: LearnLibrary['search'] = (query, options) => this.store.search(query, options)
  chunk = (chunkId: string) => this.store.chunk(chunkId)
  section = (sourceId: string, section: string) => this.store.section(sourceId, section)
  outline = (sourceId: string) => this.store.outline(sourceId)
}

const ROLE_LABEL: Record<CourseSource['role'], string> = { skeleton: '骨架教材', reference: '参考', 'exam-archive': '考试档案' }

const ROLE_TEXT: Record<CourseSource['role'], string> = { skeleton: '骨架教材', reference: '参考资料', 'exam-archive': '往年试题' }

export function apply(ctx: Context): void {
  // The learner added material to a course on the library page: the teacher can build on it.
  const handoffAttached = (courseId: string, title: string, role: CourseSource['role']) =>
    ctx.emit('learning/handoff', { courseId, unit: 'library', text: `学习者把《${title}》加入了本课，作为${ROLE_TEXT[role]}。` })

  const library = new LearnLibraryService(ctx)
  const endpoint = ctx.learnCore.api.endpoint
  // The library page is the controller for these unowned jobs; our teacher presets omit tool-jobs.
  ctx.jobs?.attachController('learning-library')
  registerFiles(ctx, library.store, library.importer)
  ctx.effect(() => { library.importer.resume(); return () => library.importer.dispose() }, 'library: recover imports')

  ctx.effect(() => endpoint({ unit: 'library', method: 'imports', handle: () => library.imports() }), 'library: imports')
  ctx.effect(() => endpoint({ unit: 'library', method: 'retry', input: z.object({ id: z.string() }), handle: ({ id }) => { library.retryImport(id); return { ok: true } } }), 'library: retry')
  ctx.effect(() => endpoint({ unit: 'library', method: 'cancel', input: z.object({ id: z.string() }), handle: ({ id }) => { library.cancelImport(id); return { ok: true } } }), 'library: cancel')
  ctx.effect(() => endpoint({ unit: 'library', method: 'reparse', input: z.object({ sourceId: z.string(), courseId: z.string().optional() }), handle: ({ sourceId, courseId }) => {
    if (courseId && !ctx.learnCore.courses.get(courseId)) throw new Error('找不到课程')
    return library.reparse(sourceId, courseId)
  } }), 'library: reparse')
  ctx.effect(() => endpoint({ unit: 'library', method: 'document', input: z.object({ sourceId: z.string() }), handle: ({ sourceId }) => ({ source: library.source(sourceId), outline: library.outline(sourceId) }) }), 'library: document')
  ctx.effect(() => endpoint({ unit: 'library', method: 'pageOffset', input: z.object({ sourceId: z.string(), offset: z.number().int() }), handle: ({ sourceId, offset }) => {
    return library.setPageOffset(sourceId, offset)
  } }), 'library: page offset')

  ctx.effect(() => endpoint({
    unit: 'library',
    method: 'sources',
    input: z.object({ courseId: z.string().optional() }),
    handle: ({ courseId }) => {
      const attached = courseId ? new Map(library.courseSources(courseId).map(entry => [entry.sourceId as string, entry.role])) : new Map()
      const visible = new Map(library.sources().map(source => [source.id, source]))
      if (courseId) for (const entry of library.courseSources(courseId)) visible.set(entry.source.id, entry.source)
      return [...visible.values()].map(source => ({ source, chunks: library.store.count(source.id), role: attached.get(source.id) }))
    },
  }), 'library: sources')

  ctx.effect(() => endpoint({
    unit: 'library',
    method: 'import',
    input: z.object({
      title: z.string().trim().min(1),
      kind: SourceKind,
      authority: Authority,
      file: z.string().min(1),
      parsed: z.array(z.string().min(1)).min(1),
      pageOffset: z.number().int().optional(),
      courseId: z.string().optional(),
      role: CourseSource.shape.role.optional(),
    }),
    handle: async input => {
      const source = await library.importParsed(input)
      if (input.courseId) handoffAttached(input.courseId, source.title, input.role ?? 'reference')
      return source
    },
  }), 'library: import')

  ctx.effect(() => endpoint({
    unit: 'library',
    method: 'attach',
    input: z.object({ courseId: z.string(), sourceId: z.string(), role: CourseSource.shape.role }),
    handle: ({ courseId, sourceId, role }) => {
      library.attach(courseId, sourceId, role)
      handoffAttached(courseId, library.source(sourceId)?.title ?? sourceId, role)
      return { ok: true }
    },
  }), 'library: attach')

  ctx.effect(() => endpoint({
    unit: 'library',
    method: 'search',
    input: z.object({ query: z.string(), courseId: z.string().optional(), kinds: z.array(ChunkKind).optional(), limit: z.number().int().positive().max(50).optional() }),
    handle: ({ query, ...options }) => library.search(query, options),
  }), 'library: search')

  ctx.effect(() => endpoint({
    unit: 'library',
    method: 'chunk',
    input: z.object({ chunkId: z.string() }),
    handle: ({ chunkId }) => library.chunk(chunkId) ?? null,
  }), 'library: chunk')

  // The teacher's brief: which material this course rests on.
  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const sources = library.courseSources(request.courseId)
    const text = sources.length
      ? sources.map(entry => `《${entry.source.title}》（${ROLE_LABEL[entry.role]}，资料 ID ${entry.sourceId}）`).join('；')
      : '本课还没有关联资料。'
    return [...sections, { unit: 'library', title: '本课资料', text }]
  })

  ctx.on('learning/describe-selection', async (selection, next) => {
    const lines = await next()
    const picked = selection.selected
    if (picked?.kind === 'chunk' && picked.id) {
      const chunk = library.chunk(picked.id)
      if (chunk) lines.push(`选中的资料片段（${chunk.citation}，${chunk.section.join(' › ')}）：\n${chunk.text}`)
    }
    return lines
  })
}
