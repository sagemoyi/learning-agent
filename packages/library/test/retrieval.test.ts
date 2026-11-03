import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Database } from '../../core/src/db.ts'
import { LibraryStore, libraryMigrations } from '../src/store.ts'
import { LibraryIndex, rrf } from '../src/retrieval.ts'
import { EmbeddingUnavailable, type Embedder, type Ranked } from '../src/embeddings.ts'

const FIXTURE = join(import.meta.dirname, '../../../tests/fixtures/retrieval-chapter')

/**
 * Deterministic stand-in for an embedding service: a vector of character counts, with a few
 * hand-made synonyms so a paraphrase lands near its passage, as a real model would place it.
 */
class FakeEmbedder implements Embedder {
  readonly dims = 512
  calls = 0
  failing = false
  rerankScale = 1
  constructor(readonly model = 'fake@512') {}
  private static readonly SYNONYMS: [RegExp, string][] = [[/内部摩擦/g, '黏性黏度'], [/层流还是湍流/g, '雷诺数层流湍流']]
  private vector(text: string): Float32Array {
    const vector = new Float32Array(this.dims)
    let expanded = text
    for (const [pattern, replacement] of FakeEmbedder.SYNONYMS) expanded = expanded.replace(pattern, replacement)
    for (const char of expanded) if (/[一-鿿]/.test(char)) vector[char.codePointAt(0)! % this.dims]! += 1
    return vector
  }
  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls++
    if (this.failing) throw new EmbeddingUnavailable('合成故障')
    return texts.map(text => this.vector(text))
  }
  async rerank(query: string, documents: readonly string[]): Promise<Ranked[]> {
    const q = this.vector(query)
    const norm = (v: Float32Array) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1
    return documents.map((document, index) => {
      const d = this.vector(document)
      return { index, score: this.rerankScale * q.reduce((sum, x, i) => sum + x * d[i]!, 0) / norm(q) / norm(d) }
    }).sort((a, b) => b.score - a.score)
  }
}

/** An embedding service that answers only when the test lets it, recording what each request was handed. */
class HeldEmbedder extends FakeEmbedder {
  readonly signals: AbortSignal[] = []
  private readonly waiting: (() => void)[] = []
  constructor(model: string, readonly version: string) { super(model) }
  override async embed(texts: readonly string[], _type?: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]> {
    if (_type === 'query') return super.embed(texts)
    this.signals.push(signal!)
    await new Promise<void>((resolve, reject) => {
      this.waiting.push(resolve)
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    return super.embed(texts)
  }
  release(): void { this.waiting.shift()?.() }
}

describe('hybrid retrieval', () => {
  let root: string, db: Database, store: LibraryStore, ctx: Context, embedder: FakeEmbedder, index: LibraryIndex, sourceId: string
  const updates: string[] = []
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'learning-retrieval-'))
    db = new Database(join(root, 'learning.db')); db.migrate('library', libraryMigrations)
    store = new LibraryStore(db.sqlite, fn => db.transaction(fn), root)
    ctx = new Context(); updates.length = 0
    ctx.on('learning/source-updated', ({ sourceId }) => { updates.push(sourceId) })
    sourceId = store.importParsed({ title: '检索基准合成资料', kind: 'textbook', authority: '1', file: join(FIXTURE, 'source.md'), parsed: [join(FIXTURE, 'middle.json')], courseId: 'course-a', role: 'skeleton' }).id
    embedder = new FakeEmbedder()
    index = new LibraryIndex(ctx, store, db.sqlite, fn => db.transaction(fn), embedder)
  })
  afterEach(() => { index.dispose(); db.close(); rmSync(root, { recursive: true, force: true }) })
  const indexed = async () => { index.schedule(sourceId); for (let i = 0; i < 100 && index.state(sourceId).state !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 5)) }

  it('indexes every chunk once and reports progress', async () => {
    expect(index.state(sourceId)).toMatchObject({ state: 'waiting', done: 0, total: store.count(sourceId), model: 'fake@512' })
    await indexed()
    expect(index.state(sourceId)).toMatchObject({ state: 'ready', done: store.count(sourceId) })
    expect(updates).toContain(sourceId)
    const calls = embedder.calls
    index.schedule(sourceId); await new Promise(resolve => setTimeout(resolve, 20))
    expect(embedder.calls).toBe(calls)
  })

  it('finds a paraphrased question that full text misses, with relevance', async () => {
    await indexed()
    const query = '液体流动时内部摩擦的大小用什么表示'
    expect(store.search(query, { courseId: 'course-a' }).some(hit => hit.chunk.text.includes('叫做黏度'))).toBe(false)
    const result = await index.retrieve(query, { courseId: 'course-a', limit: 5 })
    expect(result.mode).toBe('hybrid')
    expect(result.hits.some(hit => hit.chunk.text.includes('叫做黏度'))).toBe(true)
    expect(result.hits.every(hit => typeof hit.relevance === 'number')).toBe(true)
  })

  it('flags a gap when even the best passage scores low', async () => {
    await indexed()
    embedder.rerankScale = 0.4
    const result = await index.retrieve('精馏塔的最小回流比怎么求', { courseId: 'course-a' })
    expect(result.gap).toBe(true)
    expect(result.hits.length).toBeLessThanOrEqual(3)
  })

  it('respects kinds and course scope', async () => {
    await indexed()
    const exercises = await index.retrieve('判断流型', { courseId: 'course-a', kinds: ['exercise', 'answer'] })
    expect(exercises.hits.length).toBeGreaterThan(0)
    expect(exercises.hits.every(hit => ['exercise', 'answer'].includes(hit.chunk.kind))).toBe(true)
    expect((await index.retrieve('雷诺数', { courseId: 'other-course' })).hits).toHaveLength(0)
  })

  it('falls back to full text, and says why, when the service fails or the index is empty', async () => {
    expect((await index.retrieve('雷诺数', { courseId: 'course-a' })).note).toContain('语义索引还在建立')
    await indexed()
    embedder.failing = true
    const result = await index.retrieve('雷诺数', { courseId: 'course-a' })
    expect(result).toMatchObject({ mode: 'fulltext' })
    expect(result.note).toContain('合成故障')
    expect(result.hits.length).toBeGreaterThan(0)
  })

  it('never mixes vectors of different models', async () => {
    await indexed()
    const other = new LibraryIndex(ctx, store, db.sqlite, fn => db.transaction(fn), new FakeEmbedder('fake-v2@512'))
    expect(other.state(sourceId)).toMatchObject({ state: 'waiting', done: 0 })
    expect(new LibraryIndex(ctx, store, db.sqlite, fn => db.transaction(fn)).state(sourceId).state).toBe('off')
    other.dispose()
  })

  it('follows the semantic-search setting without a restart', async () => {
    let chosen: FakeEmbedder | undefined
    const live = new LibraryIndex(ctx, store, db.sqlite, fn => db.transaction(fn), async () => chosen)
    await live.refresh()
    expect(live.state(sourceId).state).toBe('off')
    expect((await live.retrieve('雷诺数', { courseId: 'course-a' })).mode).toBe('fulltext')

    // Switched on (or a key saved): refreshing starts indexing for that model.
    chosen = embedder
    await live.refresh()
    for (let i = 0; i < 100 && live.state(sourceId).state !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(live.state(sourceId)).toMatchObject({ state: 'ready', model: 'fake@512' })
    expect((await live.retrieve('怎样判断层流还是湍流', { courseId: 'course-a' })).mode).toBe('hybrid')

    // Switched off again: queries read the setting themselves and fall back to full text.
    chosen = undefined
    expect((await live.retrieve('雷诺数', { courseId: 'course-a' })).mode).toBe('fulltext')
    expect(live.state(sourceId).state).toBe('off')
    live.dispose()
  })

  it('stops the batch on its way when semantic search is switched off, the key changes or the unit stops', async () => {
    const vectors = () => (db.sqlite.prepare('SELECT COUNT(*) AS n FROM library_vectors').get() as { n: number }).n
    const keyA = new HeldEmbedder('fake@512', 'fake@512#a')
    let chosen: Embedder | undefined = keyA
    const live = new LibraryIndex(ctx, store, db.sqlite, fn => db.transaction(fn), async () => chosen)
    await live.refresh()
    await vi.waitFor(() => expect(keyA.signals).toHaveLength(1))
    expect(live.state(sourceId)).toMatchObject({ state: 'indexing', sent: 1 })
    // Switched off: the request on its way is aborted, nothing is kept, nothing more is sent.
    chosen = undefined
    await live.refresh()
    expect(keyA.signals[0]!.aborted).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    keyA.release()
    expect(keyA.signals).toHaveLength(1)
    expect(vectors()).toBe(0)
    expect(live.state(sourceId).state).toBe('off')

    // On again with key A, then another key for the same model: A's batch is aborted, B starts from what is saved.
    chosen = keyA
    await live.refresh()
    await vi.waitFor(() => expect(keyA.signals).toHaveLength(2))
    const keyB = new HeldEmbedder('fake@512', 'fake@512#b')
    chosen = keyB
    await live.refresh()
    expect(keyA.signals[1]!.aborted).toBe(true)
    await vi.waitFor(() => expect(keyB.signals).toHaveLength(1))
    for (let i = 0; i < 20 && live.state(sourceId).state !== 'ready'; i++) { keyB.release(); await new Promise(resolve => setTimeout(resolve, 5)) }
    expect(live.state(sourceId)).toMatchObject({ state: 'ready', done: store.count(sourceId) })
    expect(keyA.signals).toHaveLength(2)

    // The unit stops (DSH exits or reloads it): the batch on its way is aborted too.
    db.sqlite.prepare('DELETE FROM library_vectors').run()
    const keyC = new HeldEmbedder('fake@512', 'fake@512#c')
    chosen = keyC
    await live.refresh()
    await vi.waitFor(() => expect(keyC.signals).toHaveLength(1))
    live.dispose()
    expect(keyC.signals[0]!.aborted).toBe(true)
  })

  it('fuses ranked lists by reciprocal rank', () => {
    expect(rrf(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c', 'b'])
  })
})
