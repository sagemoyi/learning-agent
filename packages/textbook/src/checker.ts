// The check of a lesson before it is published (docs/textbook/design.md, 逐句核对): each sentence
// against the material it cites, then a second source for key facts from the course's other material,
// then the web for what is still short. Model replies go through the lesson run's cache, so a lesson
// resumed after a restart does not ask again what it already asked.
import type { Context } from '@deepseek-ai/cordis'
import type { CitedChunk } from '@learning-agent/contracts'
import { complete, parseJsonReply } from '@learning-agent/kit'
import {
  CHECK_SYSTEM,
  SECOND_SYSTEM,
  checkPrompt,
  judge,
  markBody,
  planBatches,
  secondPrompt,
  settled,
  termsOf,
  unitsOf,
  type CheckChunk,
  type Sentence,
  type SentenceCheck,
  type Unit,
} from './check.ts'

/** Characters of sentences and material per check call, and sentences judged in one reply. */
const BATCH_LIMIT = 8000
const BATCH_SENTENCES = 16
/** Key facts per second-source call: each comes with up to three candidate passages. */
const SECOND_SENTENCES = 4
/** Output budget of one check call; the model's thinking counts against it. */
const CHECK_MAX_TOKENS = 12_000
/** Web searches per lesson, and other-source candidates per key fact. */
const WEB_QUESTIONS = 3
const CANDIDATES = 3
const TEACHING_KINDS = ['text', 'formula', 'table', 'example'] as const

export interface CheckDeps {
  readonly ctx: Context
  readonly courseId: string
  /** The material the writer was given. */
  readonly material: readonly CitedChunk[]
  readonly model: string | undefined
  /** Search the web for key facts with one source and sentences with none. */
  readonly web: boolean
  readonly signal: AbortSignal
  /** One model reply through the lesson run's cache. */
  readonly reply: (input: { readonly system: string; readonly prompt: string; readonly maxTokens: number }, write: () => Promise<string[]>) => Promise<string[]>
}

export interface CheckOutcome {
  readonly body: string
  /** Each checked paragraph's sentences, by block id. */
  readonly checks: ReadonlyMap<string, readonly SentenceCheck[]>
  /** False when the check model failed for some paragraphs: they count as not checked. */
  readonly checked: boolean
  /** What the web supplement did, or why the check did not finish, in words for the learner. */
  readonly notes: readonly string[]
}

const truncated = (error: unknown) => (error as { code?: string }).code === 'learning/model/truncated'

const toCheck = (chunk: CitedChunk): CheckChunk => ({ id: chunk.id, text: chunk.text, kind: chunk.kind, citation: chunk.citation, sourceId: chunk.sourceId })

/** Characters two texts share in pairs, to rank a new web page's chunks against a sentence. */
function overlap(a: string, b: string): number {
  const pairs = new Set<string>()
  for (let i = 0; i + 1 < a.length; i += 1) pairs.add(a.slice(i, i + 2))
  let shared = 0
  for (let i = 0; i + 1 < b.length; i += 1) if (pairs.has(b.slice(i, i + 2))) shared += 1
  return shared
}

/** Run `work` over `items`, four at a time. */
async function inPairs<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all([0, 1, 2, 3].map(async () => { for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item) }))
}

/**
 * The material's formula chunk a display formula comes from: a formula cannot carry a citation, and
 * the paragraph after it usually cites the explanation, not the formula itself.
 */
function formulaSource(formula: string, material: readonly CheckChunk[]): CheckChunk | undefined {
  const squeeze = (text: string) => text.replace(/\$|\s/g, '')
  const own = squeeze(formula)
  const scored = material.filter(chunk => chunk.kind === 'formula').map(chunk => ({ chunk, score: overlap(own, squeeze(chunk.text)) / Math.max(1, own.length - 1) }))
  return scored.sort((a, b) => b.score - a.score).find(item => item.score >= 0.5)?.chunk
}

export async function checkLesson(deps: CheckDeps, body: string, newBlockId: () => string): Promise<CheckOutcome> {
  const { ctx, courseId } = deps
  const library = ctx.learnLibrary
  const known = new Map<string, CheckChunk | undefined>()
  const chunkOf = (id: string) => {
    if (!known.has(id)) { const chunk = library.chunk(id); known.set(id, chunk ? toCheck(chunk) : undefined) }
    return known.get(id)
  }
  /**
   * One check reply, asked again once when it fails; a reply cut off at the output limit is not asked
   * again (the caller splits the batch). A reply is kept only once it parses.
   */
  const ask = async (system: string, prompt: string): Promise<unknown> => {
    const write = async () => {
      const text = await complete(ctx, { system, prompt, purpose: 'learning-textbook-check', model: deps.model, maxTokens: CHECK_MAX_TOKENS, signal: deps.signal })
      parseJsonReply(text)
      return [text]
    }
    const input = { system, prompt, maxTokens: CHECK_MAX_TOKENS }
    const [text] = await deps.reply(input, write).catch(error => {
      if (truncated(error) || deps.signal.aborted) throw error
      return deps.reply(input, write)
    })
    return parseJsonReply(text!)
  }

  const material = deps.material.map(toCheck)
  for (const chunk of material) known.set(chunk.id, chunk)
  const units = unitsOf(body).map(unit => {
    const source = unit.formula ? formulaSource(unit.sentences[0]!.text, material) : undefined
    return source ? { ...unit, citations: [source.id] } : unit
  })
  const sentences = units.flatMap(unit => unit.sentences)
  const results = new Map<string, SentenceCheck>()
  const notes: string[] = []
  let checked = true
  /** Sources to cite for a sentence besides its paragraph's own citations. */
  const extra = new Map<string, CheckChunk[]>()
  const support = (sentence: Sentence, check: SentenceCheck) => {
    const evidence = check.evidence.map(entry => chunkOf(entry.chunkId)!)
    results.set(sentence.id, { ...check, groups: [...new Set(evidence.map(chunk => library.sourceGroup(chunk.sourceId)))] })
    extra.set(sentence.id, evidence)
  }

  // 1. Each sentence against the chunks its batch cites; a batch whose reply is cut off is halved.
  const first = async (batch: { readonly units: readonly Unit[]; readonly chunks: readonly CheckChunk[] }, depth = 0): Promise<void> => {
    const own = batch.units.flatMap(unit => unit.sentences)
    const allowed = new Map(batch.chunks.map(chunk => [chunk.id, chunk]))
    let reply: unknown
    try {
      reply = await ask(CHECK_SYSTEM, checkPrompt(batch))
    } catch (error) {
      if (deps.signal.aborted) throw error
      if (truncated(error) && batch.units.length > 1 && depth < 3) {
        const middle = Math.ceil(batch.units.length / 2)
        const cut = batch.units[middle - 1]!.formula && middle < batch.units.length - 1 ? middle + 1 : middle
        for (const half of [batch.units.slice(0, cut), batch.units.slice(cut)]) if (half.length) await first(planBatches(half, chunkOf, Number.POSITIVE_INFINITY)[0]!, depth + 1)
        return
      }
      checked = false
      notes.push(`有 ${batch.units.length} 段出处没有核对完：${(error as Error).message}`)
    }
    for (const [id, check] of judge(own, reply, allowed)) {
      const sentence = own.find(item => item.id === id)!
      if (check.verdict === 'supported') support(sentence, check)
      else results.set(id, check)
    }
    if (own.some(sentence => results.get(sentence.id)?.verdict === 'unchecked')) checked = false
  }
  await inPairs(planBatches(units, chunkOf, BATCH_LIMIT, BATCH_SENTENCES), batch => first(batch))

  // 2. Key facts with one source: candidates from the course's other material, checked in batches;
  //    a batch whose reply is cut off is halved.
  type Item = { readonly sentence: Sentence; readonly chunks: readonly CheckChunk[] }
  const secondBatch = async (batch: readonly Item[]): Promise<void> => {
    let reply: unknown
    try { reply = await ask(SECOND_SYSTEM, secondPrompt(batch)) } catch (error) {
      if (deps.signal.aborted) throw error
      if (truncated(error) && batch.length > 1) {
        const middle = Math.ceil(batch.length / 2)
        for (const half of [batch.slice(0, middle), batch.slice(middle)]) await secondBatch(half)
        return
      }
      notes.push(`有 ${batch.length} 句的第二来源没有核对完：${(error as Error).message}`)
      return
    }
    for (const { sentence, chunks } of batch) {
      const check = judge([sentence], reply, new Map(chunks.map(chunk => [chunk.id, chunk]))).get(sentence.id)!
      const before = results.get(sentence.id)!
      if (check.verdict !== 'supported') continue
      const found = check.evidence.map(entry => chunkOf(entry.chunkId)!)
      const groups = [...new Set([...before.verdict === 'supported' ? before.groups : [], ...found.map(chunk => library.sourceGroup(chunk.sourceId))])]
      results.set(sentence.id, before.verdict === 'supported'
        ? { ...before, evidence: [...before.evidence, ...check.evidence], groups }
        : { ...check, key: before.key, groups })
      extra.set(sentence.id, [...extra.get(sentence.id) ?? [], ...found])
    }
  }
  const second = async (items: readonly Item[]) => {
    const batchesOf: Item[][] = [[]]
    let size = 0
    for (const item of items) {
      const cost = item.sentence.text.length + item.chunks.reduce((sum, chunk) => sum + chunk.text.length + 60, 0)
      if (batchesOf.at(-1)!.length && (size + cost > BATCH_LIMIT || batchesOf.at(-1)!.length >= SECOND_SENTENCES)) { batchesOf.push([]); size = 0 }
      batchesOf.at(-1)!.push(item)
      size += cost
    }
    await inPairs(batchesOf.filter(batch => batch.length), secondBatch)
  }
  const single = sentences.filter(sentence => settled(results.get(sentence.id)!) === 'single')
  // A formula is looked for by the paragraph that explains it: LaTeX finds nothing in a search.
  const queryOf = new Map(units.flatMap((unit, index) => unit.formula && units[index + 1] ? [[unit.sentences[0]!.id, units[index + 1]!.sentences.map(item => item.text).join('')] as const] : []))
  const local: { sentence: Sentence; chunks: CheckChunk[] }[] = []
  await inPairs(single, async sentence => {
    const groups = results.get(sentence.id)!.groups
    const query = queryOf.get(sentence.id) ?? sentence.text
    // Meaning first (when semantic search is on), then shared keywords: the full-text search alone
    // matches the whole sentence as one phrase.
    const retrieval = await library.retrieve(query, { courseId, kinds: TEACHING_KINDS, limit: 10 })
    const keywords = library.search(termsOf(query), { courseId, kinds: TEACHING_KINDS, limit: 10 })
    const chunks = [...retrieval.hits, ...keywords].map(hit => toCheck(hit.chunk))
      .filter((chunk, index, all) => all.findIndex(other => other.id === chunk.id) === index && !groups.includes(library.sourceGroup(chunk.sourceId)))
      .slice(0, CANDIDATES)
    for (const chunk of chunks) known.set(chunk.id, chunk)
    if (chunks.length) local.push({ sentence, chunks })
  })
  await second(local)

  // 3. The web, for the most important sentences still short: key facts without support, then key
  //    facts with one source, then other sentences without support.
  const short = (sentence: Sentence) => {
    const check = results.get(sentence.id)!
    if (check.verdict === 'missing') return check.key ? 0 : 2
    return settled(check) === 'single' ? 1 : undefined
  }
  const targets = sentences.filter(sentence => short(sentence) !== undefined).sort((a, b) => short(a)! - short(b)!).slice(0, WEB_QUESTIONS)
  if (deps.web && targets.length) {
    try {
      const questions = targets.map(sentence => sentence.text.replace(/\$\$?/g, '').slice(0, 120))
      const found = await library.searchWeb(questions, { signal: deps.signal })
      const picks = targets.flatMap((sentence, index) => {
        const groups = results.get(sentence.id)!.groups
        const pick = found.candidates.find(candidate => candidate.question === questions[index] && (candidate.authority === '1' || candidate.authority === '2') && candidate.format === 'html' && !groups.includes(`site:${candidate.organization}`))
        return pick ? [{ sentence, pick }] : []
      }).filter((item, index, all) => all.findIndex(other => other.pick.url === item.pick.url) === index)
      const added = picks.length ? await library.addWeb(courseId, picks.map(({ sentence, pick }) => ({ url: pick.url, title: pick.title, reason: `核对教材里的一句话：${sentence.text.slice(0, 60)}` })), 'teacher', deps.signal) : []
      const web: { sentence: Sentence; chunks: CheckChunk[] }[] = []
      for (const result of added) {
        const item = picks.find(entry => entry.pick.url === result.url)
        if (result.status !== 'added' || !result.sourceId || !item) continue
        const chunks = library.chunks(result.sourceId).filter(chunk => (TEACHING_KINDS as readonly string[]).includes(chunk.kind)).map(toCheck)
          .sort((a, b) => overlap(item.sentence.text, b.text) - overlap(item.sentence.text, a.text)).slice(0, CANDIDATES)
        for (const chunk of chunks) known.set(chunk.id, chunk)
        if (chunks.length) web.push({ sentence: item.sentence, chunks })
      }
      const titles = added.filter(result => result.status === 'added' && result.sourceId).map(result => `《${library.source(result.sourceId!)?.title ?? result.url}》`)
      notes.push(titles.length ? `联网补充加入了${titles.join('、')}` : '联网补充没有找到可以直接加入的二级以上网页')
      await second(web)
    } catch (error) {
      if (deps.signal.aborted) throw error
      notes.push(`联网补充没有完成：${(error as Error).message}`)
    }
  }

  // 4. Into the text: 待核实 where a sentence is not supported, citations for sources found.
  const checks = new Map<string, SentenceCheck[]>()
  const marks = new Map<string, { unsupported: boolean; add: CheckChunk[] }>()
  for (const unit of units) {
    const own = unit.sentences.map(sentence => results.get(sentence.id)!)
    checks.set(unit.blockId, own)
    const unsupported = own.some(check => check.verdict === 'partial' || check.verdict === 'contradicted' || check.verdict === 'missing')
    const add = unit.sentences.filter(sentence => results.get(sentence.id)!.verdict === 'supported').flatMap(sentence => extra.get(sentence.id) ?? [])
    // Only paragraphs whose sentences were all checked change; an unchecked one keeps what the writer cited.
    if (own.every(check => check.verdict !== 'unchecked')) marks.set(unit.blockId, { unsupported, add })
  }
  return { body: markBody(body, marks, newBlockId), checks, checked, notes }
}
