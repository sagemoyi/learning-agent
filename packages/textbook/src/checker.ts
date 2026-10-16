// The check of one point's explanation against its material (docs/textbook/design.md, 讲解与原文): one model
// call per point, halved when the reply is cut off. Paragraphs that cite nothing get the chunks the check
// found them in. A failed call leaves its paragraphs unchecked; the lesson is published all the same.
import type { Context } from '@deepseek-ai/cordis'
import { complete, parseJsonReply } from '@learning-agent/kit'
import { CHECK_SYSTEM, addSources, checkPrompt, judge, paragraphsOf, precheck, type CheckChunk, type Paragraph, type ParagraphCheck } from './check.ts'

/** Output budget of one check call; the model's thinking counts against it. */
const CHECK_MAX_TOKENS = 8000

export interface CheckDeps {
  readonly ctx: Context
  readonly model: string | undefined
  readonly signal: AbortSignal
  /** One model reply through the lesson run's cache. */
  readonly reply: (input: { readonly system: string; readonly prompt: string; readonly maxTokens: number }, write: () => Promise<string[]>) => Promise<string[]>
}

/** One point: its text, the material it was written from (web passages by address), the exercise stems. */
export interface PointToCheck {
  readonly body: string
  readonly chunks: readonly CheckChunk[]
  readonly stems: readonly string[]
  /** Check these paragraphs only (a local revision). */
  readonly only?: ReadonlySet<string>
}

export interface CheckOutcome {
  readonly body: string
  /** Each checked paragraph, by block id. */
  readonly checks: ReadonlyMap<string, ParagraphCheck>
  /** False when the check model failed for some paragraphs: they count as not checked. */
  readonly checked: boolean
  /** Why the check did not finish, in words for the learner. */
  readonly notes: readonly string[]
}

const truncated = (error: unknown) => (error as { code?: string }).code === 'learning/model/truncated'

export async function checkPoint(deps: CheckDeps, point: PointToCheck): Promise<CheckOutcome> {
  const paragraphs = paragraphsOf(point.body, point.only)
  if (paragraphs.length === 0) return { body: point.body, checks: new Map(), checked: true, notes: [] }
  const material = point.chunks.map(chunk => chunk.text).join('\n')
  const allowed = new Set(point.chunks.map(chunk => chunk.id))
  const found = new Map<string, string>()
  const unknown = new Map<string, readonly string[]>()
  for (const paragraph of paragraphs) {
    const result = precheck(paragraph.text, material, point.stems)
    if (result.problem) found.set(paragraph.id, result.problem)
    if (result.unknown.length) unknown.set(paragraph.id, result.unknown)
  }
  const notes: string[] = []
  const checks = new Map<string, ParagraphCheck>()
  /** One reply, asked again once when it does not parse; a reply cut off at the output limit is halved instead. */
  const run = async (group: readonly Paragraph[], depth = 0): Promise<void> => {
    const prompt = checkPrompt(group, point.chunks, unknown)
    const input = { system: CHECK_SYSTEM, prompt, maxTokens: CHECK_MAX_TOKENS }
    const write = async () => {
      const text = await complete(deps.ctx, { ...input, purpose: 'learning-textbook-check', model: deps.model, signal: deps.signal })
      parseJsonReply(text)
      return [text]
    }
    let reply: unknown
    try {
      const [text] = await deps.reply(input, write).catch(error => {
        if (truncated(error) || deps.signal.aborted) throw error
        return deps.reply(input, write)
      })
      reply = parseJsonReply(text!)
    } catch (error) {
      if (deps.signal.aborted) throw error
      if (truncated(error) && group.length > 1 && depth < 3) {
        const middle = Math.ceil(group.length / 2)
        await run(group.slice(0, middle), depth + 1)
        await run(group.slice(middle), depth + 1)
        return
      }
      notes.push(`有 ${group.length} 段讲解没有核对完：${(error as Error).message}`)
    }
    for (const [id, check] of judge(group, reply, allowed, found)) checks.set(id, check)
  }
  await run(paragraphs)
  const chunkOf = new Map(point.chunks.map(chunk => [chunk.id, chunk]))
  const additions = new Map<string, CheckChunk[]>()
  for (const paragraph of paragraphs) {
    const check = checks.get(paragraph.blockId)
    if (check?.verdict !== 'ok' || paragraph.citations.length) continue
    const add = check.sources.filter(id => id.startsWith('ck_')).map(id => chunkOf.get(id)!).slice(0, 2)
    if (add.length) additions.set(paragraph.blockId, add)
  }
  return {
    body: addSources(point.body, additions),
    checks,
    checked: [...checks.values()].every(check => check.verdict !== 'unchecked'),
    notes,
  }
}
