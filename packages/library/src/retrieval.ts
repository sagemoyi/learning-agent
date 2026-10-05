// Semantic index (one embedding per chunk, in `library_vectors`) and hybrid retrieval:
// full text + nearest vectors fused by rank (RRF), then reranked. Without an embedding service,
// or when it fails, retrieval is plain full text and says so.
import type { Context } from '@deepseek-ai/cordis'
import type { DatabaseSync } from 'node:sqlite'
import type { ChunkKind, CitedChunk, IndexState, Retrieval } from '@learning-agent/contracts'
import type { LibraryStore } from './store.ts'
import { EmbeddingUnavailable, type Embedder, type Ranked } from './embeddings.ts'

/**
 * Reranker relevance under this means the material does not answer the query. Synthetic benchmark
 * (tests/retrieval-bench.test.ts, rerank-2.5): answerable queries ≥ 0.71, unanswerable ≤ 0.35.
 */
export const GAP_RELEVANCE = 0.5
/** Weaker hits are left out: they only invite citing unrelated passages. */
const MIN_RELEVANCE = 0.3
const RRF_K = 60
const CANDIDATES = 50
const RERANK = 24
const INDEX_BATCH = 256
const MAX_TEXT = 4000

interface Options { readonly courseId?: string; readonly kinds?: readonly ChunkKind[]; readonly limit?: number }
interface SourceVectors { readonly ids: string[]; readonly kinds: string[]; readonly matrix: Float32Array }

/** What the embedding model and the reranker read for a chunk: its section path, then its text. */
export function documentText(chunk: { readonly section: string | readonly string[]; readonly text: string }): string {
  const section = typeof chunk.section === 'string' ? chunk.section : chunk.section.join(' › ')
  return `${section}\n${chunk.text}`.slice(0, MAX_TEXT)
}

/** Reciprocal-rank fusion of ranked id lists. */
export function rrf(...lists: readonly (readonly string[])[]): string[] {
  const scores = new Map<string, number>()
  for (const list of lists) list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

export class LibraryIndex {
  private readonly cache = new Map<string, SourceVectors>()
  private readonly queue: string[] = []
  private readonly failures = new Map<string, string>()
  private readonly controller = new AbortController()
  private active?: string
  private working = false
  private readonly embedderNow: () => Promise<Embedder | undefined>
  /** The embedder last resolved from the settings; `state()` reports against it. */
  embedder?: Embedder

  /**
   * `embedder` is a resolver when the settings choose it: retrieval re-reads it on every query, and
   * `refresh()` re-reads it when the semantic-search setting or the Voyage key changes.
   */
  constructor(
    private readonly ctx: Context,
    private readonly store: LibraryStore,
    private readonly sqlite: DatabaseSync,
    private readonly transaction: <T>(fn: () => T) => T,
    embedder?: Embedder | (() => Promise<Embedder | undefined>),
  ) {
    this.embedderNow = typeof embedder === 'function' ? embedder : async () => embedder
    if (typeof embedder !== 'function') this.embedder = embedder
  }

  /** The embedder the settings choose right now, without starting any indexing. */
  current(): Promise<Embedder | undefined> {
    return this.embedderNow()
  }

  /** Re-read the embedder; with one available, index whatever lacks a vector for its model. */
  async refresh(): Promise<Embedder | undefined> {
    const next = await this.embedderNow()
    if (next?.model !== this.embedder?.model) this.cache.clear()
    this.embedder = next
    if (next) this.resume()
    else this.queue.length = 0
    return next
  }

  state(sourceId: string): IndexState {
    const total = this.store.count(sourceId)
    if (!this.embedder) return { state: 'off', done: 0, total }
    const done = (this.sqlite.prepare(`SELECT COUNT(*) AS n FROM library_chunks c JOIN library_vectors v ON v.chunk_id = c.id AND v.model = ?
      WHERE c.source_id = ?`).get(this.embedder.model, sourceId) as { n: number }).n
    const failure = this.failures.get(sourceId)
    const state = done >= total ? 'ready' : this.active === sourceId ? 'indexing' : failure ? 'failed' : 'waiting'
    return { state, done, total, model: this.embedder.model, ...(state === 'failed' ? { message: failure } : {}) }
  }

  /** Embed whatever chunks of the source still lack a vector for the current model. */
  schedule(sourceId: string): void {
    if (!this.embedder || this.controller.signal.aborted) return
    this.failures.delete(sourceId)
    if (this.active !== sourceId && !this.queue.includes(sourceId)) this.queue.push(sourceId)
    void this.work()
  }

  resume(): void {
    for (const source of this.store.sources()) if (this.state(source.id).state !== 'ready') this.schedule(source.id)
  }

  dispose(): void { this.controller.abort() }

  private changed(sourceId: string): void {
    this.cache.delete(sourceId)
    this.ctx.emit('learning/source-updated', { sourceId })
  }

  private async work(): Promise<void> {
    if (this.working) return
    this.working = true
    try {
      while (this.queue.length && !this.controller.signal.aborted) {
        const embedder = this.embedder
        if (!embedder) break // Semantic search was switched off; refresh() emptied the queue.
        const sourceId = this.queue.shift()!
        this.active = sourceId
        this.changed(sourceId)
        try { await this.indexSource(sourceId, embedder) } catch (error) {
          if (this.controller.signal.aborted) return
          this.failures.set(sourceId, error instanceof Error ? error.message : '建立语义索引失败')
        }
        this.active = undefined
        this.changed(sourceId)
      }
    } finally { this.working = false; this.active = undefined }
  }

  private async indexSource(sourceId: string, embedder: Embedder): Promise<void> {
    const missing = this.sqlite.prepare(`SELECT c.id, c.section, c.text FROM library_chunks c WHERE c.source_id = ?
      AND NOT EXISTS (SELECT 1 FROM library_vectors v WHERE v.chunk_id = c.id AND v.model = ?) ORDER BY c.seq LIMIT ${INDEX_BATCH}`)
    const insert = this.sqlite.prepare('INSERT OR REPLACE INTO library_vectors (chunk_id, model, vector) VALUES (?, ?, ?)')
    for (;;) {
      const rows = missing.all(sourceId, embedder.model) as unknown as { id: string; section: string; text: string }[]
      if (rows.length === 0) return
      const vectors = await embedder.embed(rows.map(documentText), 'document', this.controller.signal)
      this.transaction(() => rows.forEach((row, i) => insert.run(row.id, embedder.model, blob(normalize(vectors[i]!)))))
      this.changed(sourceId)
    }
  }

  private vectors(sourceId: string): SourceVectors {
    const cached = this.cache.get(sourceId)
    if (cached) return cached
    const rows = this.sqlite.prepare(`SELECT c.id, c.kind, v.vector FROM library_chunks c JOIN library_vectors v ON v.chunk_id = c.id AND v.model = ?
      WHERE c.source_id = ? ORDER BY c.seq`).all(this.embedder!.model, sourceId) as unknown as { id: string; kind: string; vector: Uint8Array }[]
    const dims = this.embedder!.dims
    const matrix = new Float32Array(rows.length * dims)
    rows.forEach((row, i) => matrix.set(new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength)), i * dims))
    const loaded = { ids: rows.map(row => row.id), kinds: rows.map(row => row.kind), matrix }
    this.cache.set(sourceId, loaded)
    return loaded
  }

  private nearest(query: Float32Array, sourceIds: readonly string[], kinds: readonly ChunkKind[] | undefined, limit: number): string[] {
    const dims = this.embedder!.dims
    const scored: { id: string; score: number }[] = []
    for (const sourceId of sourceIds) {
      const { ids, kinds: chunkKinds, matrix } = this.vectors(sourceId)
      for (let i = 0; i < ids.length; i++) {
        if (kinds?.length && !kinds.includes(chunkKinds[i] as ChunkKind)) continue
        let score = 0
        for (let d = 0, at = i * dims; d < dims; d++) score += query[d]! * matrix[at + d]!
        scored.push({ id: ids[i]!, score })
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(hit => hit.id)
  }

  async retrieve(query: string, options: Options = {}): Promise<Retrieval> {
    const limit = options.limit ?? 8
    const fulltext = this.store.search(query, { ...options, limit: CANDIDATES })
    const plain = (note?: string): Retrieval => ({ hits: fulltext.slice(0, limit), mode: 'fulltext', gap: fulltext.length === 0, ...(note ? { note } : {}) })
    const embedder = await this.embedderNow()
    const switched = embedder?.model !== this.embedder?.model
    this.embedder = embedder
    if (switched) {
      this.cache.clear()
      if (embedder) this.resume()
    }
    if (!embedder || !query.trim()) return plain()
    const sourceIds = options.courseId ? this.store.courseSources(options.courseId).map(entry => entry.sourceId as string) : this.store.sources().map(source => source.id)
    const states = sourceIds.map(id => this.state(id))
    const indexed = sourceIds.filter((_, i) => states[i]!.done > 0)
    const done = states.reduce((sum, state) => sum + state.done, 0), total = states.reduce((sum, state) => sum + state.total, 0)
    if (indexed.length === 0) return plain(total ? '语义索引还在建立，暂时只按关键词检索' : undefined)
    const partial = done < total ? `语义索引建立中（${done}/${total} 个片段），结果可能不全` : undefined

    let semantic: string[]
    try {
      const [vector] = await embedder.embed([query], 'query')
      semantic = this.nearest(normalize(vector!), indexed, options.kinds, CANDIDATES)
    } catch (error) {
      if (error instanceof EmbeddingUnavailable) return plain(`语义检索暂不可用（${error.message}），以下只按关键词匹配`)
      throw error
    }
    const known = new Map(fulltext.map(hit => [hit.chunk.id as string, hit.chunk]))
    const chunks = rrf(fulltext.map(hit => hit.chunk.id), semantic).slice(0, RERANK)
      .map(id => known.get(id) ?? this.store.chunk(id)).filter((chunk): chunk is CitedChunk => !!chunk)
    let ranked: Ranked[]
    try { ranked = await embedder.rerank(query, chunks.map(documentText)) } catch (error) {
      if (!(error instanceof EmbeddingUnavailable)) throw error
      const note = [partial, `重排暂不可用（${error.message}），按融合名次返回`].filter(Boolean).join('；')
      return { hits: chunks.slice(0, limit).map((chunk, rank) => ({ chunk, rank })), mode: 'hybrid', gap: chunks.length === 0, note }
    }
    const gap = (ranked[0]?.score ?? 0) < GAP_RELEVANCE
    const kept = ranked.filter(hit => hit.score >= MIN_RELEVANCE)
    const chosen = (kept.length ? kept : ranked.slice(0, 3)).slice(0, limit)
    return { hits: chosen.map((hit, rank) => ({ chunk: chunks[hit.index]!, rank, relevance: hit.score })), mode: 'hybrid', gap, ...(partial ? { note: partial } : {}) }
  }
}

function normalize(vector: Float32Array): Float32Array {
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm) || 1
  return vector.map(value => value / norm)
}

function blob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
}
