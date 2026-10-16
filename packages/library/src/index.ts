// library unit, host half. Provides `ctx.learnLibrary` (contracts §5.1): sources, locatable chunks,
// full-text and hybrid retrieval with citation labels, durable PDF imports (local MinerU or MinerU
// cloud), original-file reading, and material found online, rated by site rules (web/).
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import { Authority, CourseSource, SourceKind, ChunkKind, LearningApiError, type LearnLibrary, type Source, type WebAdded } from '@learning-agent/contracts'
import { secret } from '@learning-agent/kit'
import { Schema } from '@learning-agent/kit/settings'
import { z } from 'zod'
import { LibraryStore, libraryMigrations } from './store.ts'
import { LibraryImports } from './imports.ts'
import { LibraryIndex } from './retrieval.ts'
import { chooseEmbedder } from './embeddings.ts'
import { chooseParser, type MineruParser } from './parser.ts'
import { registerFiles } from './files.ts'
import { LibraryWeb } from './web/service.ts'
import { PROVIDER_ORDER, type ProviderId } from './web/search.ts'
import { organization, siteOf } from './web/sites.ts'

export const name = 'learning-library'
export const inject = ['learnCore', 'connection', 'jobs']

/** Edited on the settings page (资料服务); each import and query reads the current values. */
export const Config = Schema.object({
  parser: Schema.union([
    Schema.const('cloud').description('MinerU 云端'),
    Schema.const('local').description('本机 MinerU'),
  ]).default('cloud').description('资料解析方式').volatile(),
  localParserUrl: Schema.string().default('http://127.0.0.1:16580').description('本机 MinerU 服务地址').volatile(),
  semanticSearch: Schema.boolean().default(true).description('语义检索').volatile(),
  searchProvider: Schema.union([
    Schema.const('exa').description('Exa'),
    Schema.const('bocha').description('博查'),
    Schema.const('tavily').description('Tavily'),
  ]).default('exa').description('首选搜索服务').volatile(),
})
export type Config = ReturnType<typeof Config>

const MINERU_KEY = 'MINERU_API_KEY'
const VOYAGE_KEY = 'VOYAGEAI_API_KEY'

class LearnLibraryService extends Service implements LearnLibrary {
  readonly store: LibraryStore
  readonly importer: LibraryImports
  readonly index: LibraryIndex
  /** The parser the settings choose now; each import run and connection test resolves it afresh. */
  readonly parser: () => Promise<MineruParser>
  readonly web: LibraryWeb

  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'learnLibrary')
    const core = ctx.learnCore
    core.db.migrate('library', libraryMigrations)
    this.store = new LibraryStore(core.db.sqlite, fn => core.db.transaction(fn), core.dataRoot)
    this.parser = async () => {
      const choice = { parser: config.parser.get(), localUrl: config.localParserUrl.get() }
      return chooseParser(choice, choice.parser === 'cloud' ? await secret(ctx, MINERU_KEY) : undefined)
    }
    this.importer = new LibraryImports(ctx, this.store, this.parser)
    this.index = new LibraryIndex(ctx, this.store, core.db.sqlite, fn => core.db.transaction(fn), async () =>
      chooseEmbedder(config.semanticSearch.get(), config.semanticSearch.get() ? await secret(ctx, VOYAGE_KEY) : undefined))
    this.web = new LibraryWeb(ctx, this.store, this.importer, { provider: () => config.searchProvider.get() as ProviderId, key: name => secret(ctx, name) })
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
  retrieve: LearnLibrary['retrieve'] = (query, options) => this.index.retrieve(query, options)
  indexState = (sourceId: string) => this.index.state(sourceId)
  chunk = (chunkId: string) => this.store.chunk(chunkId)
  section = (sourceId: string, section: string) => this.store.section(sourceId, section)
  chunks = (sourceId: string) => this.store.chunks(sourceId)
  outline = (sourceId: string) => this.store.outline(sourceId)
  chunkSources = (chunkIds: readonly string[]) => this.store.chunkSources(chunkIds)
  sourceGroup: LearnLibrary['sourceGroup'] = sourceId => {
    const source = this.store.source(sourceId)
    if (!source) return `source:${sourceId}`
    return source.origin.kind === 'web' ? `site:${organization(siteOf(source.origin.url))}` : `work:${workTitle(source.title)}`
  }
  searchWeb: LearnLibrary['searchWeb'] = (questions, options) => this.web.search(questions, options?.signal)
  addWeb: LearnLibrary['addWeb'] = (courseId, items, by, signal) => this.web.add(courseId, items, by, signal)
  readWeb: LearnLibrary['readWeb'] = (url, signal) => this.web.read(url, signal)
}

/** The title of the work itself: edition marks, brackets, punctuation and spaces dropped. */
export function workTitle(title: string): string {
  return title.toLowerCase()
    .replace(/[（(]?\s*第?\s*[0-9一二三四五六七八九十]+\s*版\s*[)）]?/g, '')
    .replace(/\b\d+(?:st|nd|rd|th)\s+ed(?:ition|\.)?/g, '')
    .replace(/[\s《》<>「」『』“”"'（）()[\]【】:：·,，.。_\-—]+/g, '')
}

const ROLE_LABEL: Record<CourseSource['role'], string> = { skeleton: '骨架教材', reference: '参考', 'exam-archive': '考试档案' }

const ROLE_TEXT: Record<CourseSource['role'], string> = { skeleton: '骨架教材', reference: '参考资料', 'exam-archive': '往年试题' }

export function apply(ctx: Context, config: Config): void {
  // The learner added material to a course on the library page: the teacher can build on it.
  const handoffAttached = (courseId: string, title: string, role: CourseSource['role']) =>
    ctx.emit('learning/handoff', { courseId, unit: 'library', text: `学习者把《${title}》加入了本课，作为${ROLE_TEXT[role]}。` })

  const library = new LearnLibraryService(ctx, config)
  const endpoint = ctx.learnCore.api.endpoint
  const course = (courseId: string) => { if (!ctx.learnCore.courses.get(courseId)) throw new LearningApiError('learning/library/not-found', '找不到课程') }
  // The learner added material found online on the library page; a PDF hands off when its parse finishes.
  const handoffWeb = (courseId: string, results: readonly WebAdded[], confirmed = false) => {
    const added = results.filter(result => result.status === 'added' && result.sourceId).map(result => `《${library.source(result.sourceId!)?.title ?? siteOf(result.url)}》`)
    if (added.length) ctx.emit('learning/handoff', { courseId, unit: 'library', text: `学习者${confirmed ? '确认' : '从网上'}加入了${added.join('、')}，作为本课参考资料，现在可以引用。` })
  }
  // The library page is the controller for these unowned jobs; our teacher presets omit tool-jobs.
  ctx.jobs?.attachController('learning-library')
  registerFiles(ctx, library.store, library.importer)
  ctx.effect(() => { library.importer.resume(); return () => library.importer.dispose() }, 'library: recover imports')
  ctx.effect(() => { void library.index.refresh(); return () => library.index.dispose() }, 'library: semantic index')
  // Switching semantic search on, or saving a Voyage key, starts indexing without a restart.
  ctx.on('settings/document-updated', () => { void library.index.refresh() })
  ctx.on('credentials/reference-updated', ref => { if (ref === VOYAGE_KEY) void library.index.refresh() })
  ctx.on('learning/source-imported', ({ sourceId }) => library.index.schedule(sourceId))
  ctx.effect(() => endpoint({ unit: 'library', method: 'reindex', input: z.object({ sourceId: z.string() }), handle: ({ sourceId }) => { library.index.schedule(sourceId); return library.indexState(sourceId) } }), 'library: reindex')

  ctx.effect(() => endpoint({ unit: 'library', method: 'imports', handle: () => library.imports() }), 'library: imports')
  ctx.effect(() => endpoint({ unit: 'library', method: 'services', handle: async () => {
    const cloud = config.parser.get() === 'cloud'
    return {
      parser: cloud ? '云端' : '本机',
      // Cloud parsing waits without a MinerU key; the page points to the settings.
      parserReady: !cloud || !!await secret(ctx, MINERU_KEY),
      semanticSearch: config.semanticSearch.get(),
      embeddings: (await library.index.current())?.model,
      webSearch: (await library.web.providers()).map(provider => provider.id),
    }
  } }), 'library: services')
  // The settings page's 测试连接: reach the chosen parser, or embed two words with Voyage (no PDF is sent).
  ctx.effect(() => endpoint({ unit: 'library', method: 'testService', input: z.object({ service: z.enum(['parser', 'embeddings', ...PROVIDER_ORDER]) }), handle: async ({ service }, signal) => {
    const started = Date.now()
    if (service === 'parser') await (await library.parser()).check(signal)
    else if (service !== 'embeddings') {
      // One real search (the services charge per call), on a course topic: nothing of the learner's is sent.
      const provider = await library.web.provider(service)
      if (!provider) throw new LearningApiError('learning/library/no-key', '还没有填写这个搜索服务的密钥')
      await provider.search('化工原理 离心泵', { limit: 1 }, signal)
    } else {
      const embedder = chooseEmbedder(true, await secret(ctx, VOYAGE_KEY))
      if (!embedder) throw new LearningApiError('learning/library/no-key', '还没有填写 Voyage 密钥')
      await embedder.embed(['连接测试'], 'query', signal)
    }
    return { ms: Date.now() - started }
  } }), 'library: test service')
  ctx.effect(() => endpoint({ unit: 'library', method: 'retry', input: z.object({ id: z.string() }), handle: ({ id }) => { library.retryImport(id); return { ok: true } } }), 'library: retry')
  ctx.effect(() => endpoint({ unit: 'library', method: 'cancel', input: z.object({ id: z.string() }), handle: ({ id }) => { library.cancelImport(id); return { ok: true } } }), 'library: cancel')
  ctx.effect(() => endpoint({ unit: 'library', method: 'reparse', input: z.object({ sourceId: z.string(), courseId: z.string().optional() }), handle: ({ sourceId, courseId }) => {
    if (courseId && !ctx.learnCore.courses.get(courseId)) throw new Error('找不到课程')
    return library.reparse(sourceId, courseId)
  } }), 'library: reparse')
  ctx.effect(() => endpoint({ unit: 'library', method: 'document', input: z.object({ sourceId: z.string() }), handle: ({ sourceId }) => {
    const source = library.source(sourceId)
    // A kept web page is read as its chunks, in order; a PDF is read from the original file.
    const page = source?.origin.kind === 'web' && source.origin.format === 'html'
    return { source, outline: library.outline(sourceId), ...(page ? { chunks: library.store.chunks(sourceId) } : {}) }
  } }), 'library: document')

  ctx.effect(() => endpoint({
    unit: 'library',
    method: 'pageChunks',
    input: z.object({ sourceId: z.string(), page: z.number().int().positive() }),
    handle: ({ sourceId, page }) => library.store.pageChunks(sourceId, page),
  }), 'library: page chunks')
  ctx.effect(() => endpoint({ unit: 'library', method: 'webSearch', input: z.object({ query: z.string().trim().min(1).max(200) }), handle: ({ query }, signal) => library.searchWeb([query], { signal }) }), 'library: web search')
  ctx.effect(() => endpoint({
    unit: 'library',
    method: 'addWeb',
    input: z.object({ courseId: z.string(), url: z.string().min(1), title: z.string().optional() }),
    handle: async ({ courseId, url, title }, signal) => {
      course(courseId)
      const results = await library.addWeb(courseId, [{ url, title }], 'learner', signal)
      handoffWeb(courseId, results)
      return results[0]
    },
  }), 'library: add web')
  ctx.effect(() => endpoint({ unit: 'library', method: 'webPending', input: z.object({ courseId: z.string() }), handle: ({ courseId }) => library.web.pending(courseId) }), 'library: web pending')
  ctx.effect(() => endpoint({ unit: 'library', method: 'confirmWeb', input: z.object({ id: z.string() }), handle: async ({ id }, signal) => {
    const courseId = library.store.pendingItem(id).courseId
    const result = await library.web.confirm(id, signal)
    handoffWeb(courseId, [result], true)
    return result
  } }), 'library: confirm web')
  ctx.effect(() => endpoint({ unit: 'library', method: 'dismissWeb', input: z.object({ id: z.string() }), handle: ({ id }) => { library.web.dismiss(id); return { ok: true } } }), 'library: dismiss web')
  ctx.effect(() => endpoint({ unit: 'library', method: 'siteRules', handle: () => library.store.siteRules() }), 'library: site rules')
  ctx.effect(() => endpoint({
    unit: 'library',
    method: 'setSiteRule',
    input: z.object({ host: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, '网站写成域名，例如 hg.kmust.edu.cn'), authority: z.union([Authority, z.literal('blocked')]).optional() }),
    handle: ({ host, authority }) => { library.store.setSiteRule(host.replace(/^www\./, ''), authority); return library.store.siteRules() },
  }), 'library: set site rule')
  ctx.effect(() => endpoint({ unit: 'library', method: 'detach', input: z.object({ courseId: z.string(), sourceId: z.string() }), handle: ({ courseId, sourceId }) => {
    library.store.detach(courseId, sourceId)
    ctx.emit('learning/source-updated', { sourceId })
    return { ok: true }
  } }), 'library: detach')
  ctx.effect(() => endpoint({ unit: 'library', method: 'pageOffset', input: z.object({ sourceId: z.string(), offset: z.number().int() }), handle: ({ sourceId, offset }) => {
    return library.setPageOffset(sourceId, offset)
  } }), 'library: page offset')

  // Without a course: the whole library, each source with the courses that use it. With one: that course's
  // sources in their roles, with the chapter outline of the ones read as pages.
  ctx.effect(() => endpoint({
    unit: 'library',
    method: 'sources',
    input: z.object({ courseId: z.string().optional() }),
    handle: ({ courseId }) => {
      const row = (source: Source) => ({ source, chunks: library.store.count(source.id), index: library.indexState(source.id) })
      if (courseId) {
        return library.courseSources(courseId).map(entry => {
          const page = entry.source.origin.kind === 'web' && entry.source.origin.format === 'html'
          return { ...row(entry.source), role: entry.role, ...(page ? {} : { outline: library.outline(entry.sourceId) }) }
        })
      }
      const uses = library.store.uses()
      return library.sources().map(source => ({
        ...row(source),
        courses: (uses.get(source.id) ?? []).flatMap(use => {
          const course = ctx.learnCore.courses.get(use.courseId)
          return course ? [{ id: course.id, title: course.title, role: use.role }] : []
        }),
      }))
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
    handle: ({ query, ...options }) => library.retrieve(query, options),
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
    // Web material can grow long; the brief counts it, search_library reaches it.
    const own = sources.filter(entry => entry.source.origin.kind === 'file')
    const web = sources.length - own.length
    const pending = library.web.pending(request.courseId).length
    const text = [
      own.length ? own.map(entry => `《${entry.source.title}》（${ROLE_LABEL[entry.role]}，资料 ID ${entry.sourceId}）`).join('；') : '本课还没有导入的资料。',
      web ? `另有 ${web} 份网上找到的参考资料，检索时一并查到。` : '',
      pending ? `${pending} 份三级网上资料等学习者确认。` : '',
    ].filter(Boolean).join('')
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
