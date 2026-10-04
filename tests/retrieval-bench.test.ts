// Retrieval benchmark on the synthetic chapter: full-text vs embeddings vs RRF hybrid.
// Runs only on request (calls the Voyage API with synthetic text):
//   RETRIEVAL_BENCH=1 pnpm vitest run tests/retrieval-bench.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Database } from '../packages/core/src/db.ts'
import { LibraryStore, libraryMigrations } from '../packages/library/src/store.ts'
import { LibraryIndex } from '../packages/library/src/retrieval.ts'
import { Voyage } from '../packages/library/src/embeddings.ts'
import { Context } from '@deepseek-ai/cordis'

const FIXTURE = join(import.meta.dirname, 'fixtures/retrieval-chapter')
const CACHE = join(import.meta.dirname, '../.scratch/retrieval-bench-cache')
const MODELS = (process.env.RETRIEVAL_MODELS ?? 'voyage-4-lite,voyage-4,voyage-4-large').split(',')
const K = 60

interface Query { q: string; kind: string; expect?: string[]; expectSection?: string }
interface Row { id: string; kind: string; section: string; text: string }

async function embed(model: string, texts: string[], inputType: 'query' | 'document'): Promise<number[][]> {
  mkdirSync(CACHE, { recursive: true })
  const file = join(CACHE, `${model}-${inputType}.json`)
  const cache: Record<string, number[]> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const key = (text: string) => createHash('sha256').update(text).digest('hex')
  const missing = texts.filter(text => !cache[key(text)])
  for (let i = 0; i < missing.length; i += 128) {
    const batch = missing.slice(i, i + 128)
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.VOYAGEAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: batch, input_type: inputType, output_dimension: 1024 }),
    })
    if (!response.ok) throw new Error(`Voyage ${response.status}: ${(await response.text()).slice(0, 200)}`)
    const body = await response.json() as { data: { index: number; embedding: number[] }[] }
    for (const item of body.data) cache[key(batch[item.index]!)] = item.embedding
  }
  writeFileSync(file, JSON.stringify(cache))
  return texts.map(text => cache[key(text)]!)
}

const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i]!, 0)

function rrf(...lists: string[][]): string[] {
  const scores = new Map<string, number>()
  for (const list of lists) list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (K + rank + 1)))
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

describe.skipIf(!process.env.RETRIEVAL_BENCH)('retrieval benchmark', () => {
  it('reports recall by query kind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'learning-bench-'))
    const db = new Database(join(root, 'learning.db')); db.migrate('library', libraryMigrations)
    const store = new LibraryStore(db.sqlite, fn => db.transaction(fn), root)
    store.importParsed({ title: '检索基准合成资料', kind: 'textbook', authority: '1', file: join(FIXTURE, 'source.md'), parsed: [join(FIXTURE, 'middle.json')], courseId: 'bench', role: 'skeleton' })
    const rows = db.sqlite.prepare('SELECT id, kind, section, text FROM library_chunks ORDER BY seq').all() as unknown as Row[]
    const queries = JSON.parse(readFileSync(join(FIXTURE, 'queries.json'), 'utf8')) as Query[]
    const relevant = (query: Query) => new Set(rows.filter(row => query.expectSection
      ? row.section.includes(query.expectSection)
      : query.expect!.some(marker => row.text.includes(marker))).map(row => row.id))
    for (const query of queries) if (query.kind !== '无答案') expect(relevant(query).size, query.q).toBeGreaterThan(0)

    const methods: Record<string, (query: Query, i: number) => string[]> = {
      全文: query => store.search(query.q, { limit: 50 }).map(hit => hit.chunk.id),
    }
    const topScores: Record<string, number[]> = {}
    for (const model of MODELS) {
      const docs = await embed(model, rows.map(row => `${row.section}\n${row.text}`), 'document')
      const asked = await embed(model, queries.map(query => query.q), 'query')
      const ranked = asked.map(vector => rows.map((row, i) => ({ id: row.id, score: dot(vector, docs[i]!) })).sort((a, b) => b.score - a.score))
      topScores[model] = ranked.map(list => list[0]!.score)
      methods[model] = (_, i) => ranked[i]!.slice(0, 50).map(hit => hit.id)
      methods[`混合 ${model}`] = (query, i) => rrf(methods.全文!(query, i), methods[model]!(query, i))
    }

    const kinds = [...new Set(queries.map(query => query.kind))].filter(kind => kind !== '无答案')
    const lines = [`| 方法 | ${kinds.map(kind => `${kind}`).join(' | ')} | 全部 R@5 | MRR@10 |`, `|---|${kinds.map(() => '---').join('|')}|---|---|`]
    const report: Record<string, unknown> = {}
    for (const [name, run] of Object.entries(methods)) {
      const results = queries.map((query, i) => {
        if (query.kind === '无答案') return undefined
        const ids = run(query, i), want = relevant(query)
        const first = ids.slice(0, 10).findIndex(id => want.has(id))
        return { kind: query.kind, q: query.q, at5: ids.slice(0, 5).some(id => want.has(id)), rr: first < 0 ? 0 : 1 / (first + 1) }
      }).filter(result => result !== undefined)
      const pct = (list: typeof results) => `${list.filter(r => r.at5).length}/${list.length}`
      lines.push(`| ${name} | ${kinds.map(kind => pct(results.filter(r => r.kind === kind))).join(' | ')} | ${pct(results)} | ${(results.reduce((s, r) => s + r.rr, 0) / results.length).toFixed(2)} |`)
      report[name] = results.filter(r => !r.at5).map(r => r.q)
    }
    const noAnswer = queries.map((query, i) => ({ query, i })).filter(({ query }) => query.kind === '无答案')
    for (const model of MODELS) {
      const answered = topScores[model]!.filter((_, i) => queries[i]!.kind !== '无答案').sort((a, b) => a - b)
      lines.push(`\n${model} 最高相似度：有答案的最低 ${answered[0]!.toFixed(3)}、中位 ${answered[Math.floor(answered.length / 2)]!.toFixed(3)}；无答案 ${noAnswer.map(({ i }) => topScores[model]![i]!.toFixed(3)).join('、')}`)
    }
    // Rerank the hybrid top 20 and compare the best relevance score with and without an answer.
    for (const reranker of (process.env.RETRIEVAL_RERANK ?? '').split(',').filter(Boolean)) {
      const hybrid = `混合 ${MODELS.at(-1)}`
      const scores: { kind: string; top: number; hit: boolean }[] = []
      for (const [i, query] of queries.entries()) {
        const ids = methods[hybrid]!(query, i).slice(0, 20)
        const response = await fetch('https://api.voyageai.com/v1/rerank', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.VOYAGEAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: reranker, query: query.q, documents: ids.map(id => rows.find(row => row.id === id)!).map(row => `${row.section}\n${row.text}`) }),
        })
        if (!response.ok) throw new Error(`Voyage rerank ${response.status}`)
        const body = await response.json() as { data: { index: number; relevance_score: number }[] }
        const best = body.data.sort((a, b) => b.relevance_score - a.relevance_score)[0]!
        scores.push({ kind: query.kind, top: best.relevance_score, hit: query.kind !== '无答案' && relevant(query).has(ids[best.index]!) })
      }
      const answered = scores.filter(s => s.kind !== '无答案').map(s => s.top).sort((a, b) => a - b)
      lines.push(`\n${reranker}（重排${hybrid}前 20）：第一名正确 ${scores.filter(s => s.hit).length}/${answered.length}；最高相关度 有答案的最低 ${answered[0]!.toFixed(3)}、中位 ${answered[Math.floor(answered.length / 2)]!.toFixed(3)}；无答案 ${scores.filter(s => s.kind === '无答案').map(s => s.top.toFixed(3)).join('、')}`)
    }
    console.log(`\n${rows.length} 个片段，${queries.length} 条查询\n${lines.join('\n')}\n\n未进前五：${JSON.stringify(report, null, 1)}`)
    writeFileSync(join(CACHE, 'report.md'), lines.join('\n'))
    db.sqlite.close(); rmSync(root, { recursive: true, force: true })
  }, 300_000)

  it('runs the product pipeline (index, hybrid, rerank, gap)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'learning-bench-'))
    const db = new Database(join(root, 'learning.db')); db.migrate('library', libraryMigrations)
    const store = new LibraryStore(db.sqlite, fn => db.transaction(fn), root)
    const sourceId = store.importParsed({ title: '检索基准合成资料', kind: 'textbook', authority: '1', file: join(FIXTURE, 'source.md'), parsed: [join(FIXTURE, 'middle.json')], courseId: 'bench', role: 'skeleton' }).id
    const index = new LibraryIndex(new Context(), store, db.sqlite, fn => db.transaction(fn), new Voyage(process.env.VOYAGEAI_API_KEY!))
    const started = Date.now()
    index.schedule(sourceId)
    while (index.state(sourceId).state !== 'ready') {
      if (index.state(sourceId).state === 'failed') throw new Error(index.state(sourceId).message)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    const indexing = Date.now() - started
    const rows = db.sqlite.prepare('SELECT id, kind, section, text FROM library_chunks').all() as unknown as Row[]
    const queries = JSON.parse(readFileSync(join(FIXTURE, 'queries.json'), 'utf8')) as Query[]
    let top1 = 0, at5 = 0, gapRight = 0, answered = 0, elapsed = 0
    const misses: string[] = []
    for (const query of queries) {
      const want = new Set(rows.filter(row => query.expectSection ? row.section.includes(query.expectSection) : (query.expect ?? []).some(marker => row.text.includes(marker))).map(row => row.id))
      const t0 = Date.now()
      const result = await index.retrieve(query.q, { courseId: 'bench', limit: 5 })
      elapsed += Date.now() - t0
      const noAnswer = query.kind === '无答案'
      if (result.gap === noAnswer) gapRight++; else misses.push(`${query.q}（gap=${result.gap}，最高 ${result.hits[0]?.relevance?.toFixed(2)}）`)
      if (noAnswer) continue
      answered++
      if (want.has(result.hits[0]?.chunk.id ?? '')) top1++
      if (result.hits.some(hit => want.has(hit.chunk.id))) at5++; else misses.push(`${query.q}（未进前五）`)
    }
    console.log(`\n产品管线：建索引 ${rows.length} 个片段 ${(indexing / 1000).toFixed(1)} 秒；第一名正确 ${top1}/${answered}，前五 ${at5}/${answered}，有无答案判断正确 ${gapRight}/${queries.length}，平均每次检索 ${Math.round(elapsed / queries.length)} ms\n${misses.join('\n')}`)
    index.dispose(); db.sqlite.close(); rmSync(root, { recursive: true, force: true })
  }, 300_000)
})
