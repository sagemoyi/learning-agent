// Embedding and reranking service for hybrid retrieval (docs/library/research.md, batch B).
// Voyage AI today; the index records the model, so a different provider builds its own vectors.

export interface Ranked { readonly index: number; readonly score: number }

export interface Embedder {
  /** Stored with each vector, e.g. `voyage-4@1024`; vectors of different models are never mixed. */
  readonly model: string
  readonly dims: number
  embed(texts: readonly string[], inputType: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]>
  rerank(query: string, documents: readonly string[], signal?: AbortSignal): Promise<Ranked[]>
}

export class EmbeddingUnavailable extends Error {}

const VOYAGE = 'https://api.voyageai.com/v1'
/** Texts per request and a character budget well under the model's token limit. */
const BATCH_TEXTS = 128
const BATCH_CHARS = 120_000

export class Voyage implements Embedder {
  readonly model: string
  constructor(private readonly apiKey: string, private readonly embedModel = 'voyage-4', readonly dims = 1024, private readonly rerankModel = 'rerank-2.5') {
    this.model = `${embedModel}@${dims}`
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(60_000)
      let response: Response
      try {
        response = await fetch(`${VOYAGE}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
      } catch (error) {
        if (signal?.aborted) throw error
        if (attempt < 2) { await pause(1000 * 2 ** attempt, signal); continue }
        throw new EmbeddingUnavailable('连接 Voyage AI 失败')
      }
      if (response.ok) return response.json() as Promise<T>
      if ((response.status === 429 || response.status >= 500) && attempt < 3) { await pause(1500 * 2 ** attempt, signal); continue }
      if (response.status === 401 || response.status === 403) throw new EmbeddingUnavailable('Voyage AI 拒绝了密钥，请检查 .env 里的 VOYAGEAI_API_KEY')
      throw new EmbeddingUnavailable(`Voyage AI 返回 ${response.status}`)
    }
  }

  async embed(texts: readonly string[], inputType: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]> {
    const vectors: Float32Array[] = []
    for (const batch of batches(texts)) {
      const body = await this.post<{ data: { index: number; embedding: number[] }[] }>('/embeddings', { model: this.embedModel, input: batch, input_type: inputType, output_dimension: this.dims }, signal)
      const ordered = [...body.data].sort((a, b) => a.index - b.index)
      if (ordered.length !== batch.length || ordered.some(item => item.embedding.length !== this.dims)) throw new EmbeddingUnavailable('Voyage AI 返回的向量数量或维度不符')
      vectors.push(...ordered.map(item => Float32Array.from(item.embedding)))
    }
    return vectors
  }

  async rerank(query: string, documents: readonly string[], signal?: AbortSignal): Promise<Ranked[]> {
    if (documents.length === 0) return []
    const body = await this.post<{ data: { index: number; relevance_score: number }[] }>('/rerank', { model: this.rerankModel, query, documents }, signal)
    return body.data.map(item => ({ index: item.index, score: item.relevance_score })).sort((a, b) => b.score - a.score)
  }
}

/** Voyage when `VOYAGEAI_API_KEY` is set, unless `LEARNING_EMBEDDINGS=off`. */
export function embedderFromEnv(env: NodeJS.ProcessEnv = process.env): Embedder | undefined {
  if (env.LEARNING_EMBEDDINGS === 'off' || !env.VOYAGEAI_API_KEY) return undefined
  return new Voyage(env.VOYAGEAI_API_KEY)
}

function* batches(texts: readonly string[]): Generator<string[]> {
  let batch: string[] = [], chars = 0
  for (const text of texts) {
    if (batch.length && (batch.length >= BATCH_TEXTS || chars + text.length > BATCH_CHARS)) { yield batch; batch = []; chars = 0 }
    batch.push(text); chars += text.length
  }
  if (batch.length) yield batch
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}
