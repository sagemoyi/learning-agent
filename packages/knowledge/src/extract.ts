// Section extraction (knowledge C): one model call drafts a section's knowledge in the background. The
// program checks every item against the section's text and the course graph; what passes goes in as one
// operation group the learner can undo, with every relation a draft. A failed call writes nothing.
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-jobs'
import {
  EdgeType, KnowledgeExtraction, LearningApiError, NodeKind, newId,
  type CitedChunk, type ExtractionOverview, type ExtractionStart, type KnowledgeEdge, type NewEdge, type NewNode,
} from '@learning-agent/contracts'
import { complete, parseJsonReply } from '@learning-agent/kit'
import { normalizeLabel, nodeLabels, type KnowledgeStore } from './store.ts'
import { KIND_LABEL } from './labels.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { 'knowledge-extract': 'knowledge-extract' }
}

/** A longer section is asked for by its subsections, so one reply stays reviewable. */
export const MAX_SECTION_CHARS = 24_000
const MAX_NODES = 20
const MAX_EDGES = 40
/** deepseek-flash thinks before answering, and the thinking counts against this (AGENTS.md). */
const MAX_TOKENS = 16_000
const PARALLEL = 2
const LEFT_OUT = new Set<CitedChunk['kind']>(['exercise', 'answer'])

export const EXTRACT_SYSTEM = `你从教材的一个小节里整理知识节点和它们之间的关系，放进学习者的知识图。只依据给出的原文，不补充原文没有的内容。

节点：
- kind 取 knowledge（概念、事实、定律）、skill（能动手做的步骤或计算方法）、integrated（要协调几项知识和技能的综合能力）、task（真实场景里的完整任务）。
- 只收会影响诊断、讲解或出题的内容，一个小节通常 3 到 12 个；不要把每个术语都列成节点。
- title 用原文里的名称；description 用一两句话写含义和边界；conditions 写"在什么条件下能做到什么"，原文没有就留空；aliases 写原文里的别称或符号。
- sources 写支持这个节点的片段编号（原文每段开头方括号里的编号），至少一个。
- 本课已有节点里有同一项时，title 写成和已有节点完全相同的名称，不要另起名字。

关系（from、to 写节点名称，可以是本小节的节点或本课已有节点）：
- requires：from 需要先掌握 to，原文说明了这种必要性才用；
- recommended-before：建议先学 from 再学 to，只是教学顺序；
- part-of：from 是 to 的组成部分；
- related：有联系但没有先后。
- 章节先后不能证明 requires。
- rationale 写成立的理由，注明"原文直接陈述"还是"教学推断"；sources 写依据片段编号。

只输出一个 JSON 对象：
{"nodes":[{"title":"","kind":"","description":"","aliases":[],"conditions":"","sources":[""]}],"edges":[{"from":"","to":"","type":"","rationale":"","sources":[""]}]}
公式里的反斜杠写成两个。`

/** The outline key of a heading: its number ("1.3" of "1.3 管内流动阻力"), or the heading itself. */
export function sectionKey(heading: string): string {
  const match = /^(\d+(?:\.\d+)*)\s/.exec(heading.trim())
  return match ? match[1]! : heading.trim()
}

export interface ExtractionDraft {
  readonly nodes: NewNode[]
  readonly edges: NewEdge[]
  readonly reused: number
  readonly skipped: string[]
}

type Known = { readonly id: string; readonly title: string; readonly aliases: readonly string[]; readonly kind: NewNode['kind'] }

/**
 * Check a model reply item by item. Sources must come from the section; a node named like a course node of
 * the same kind is that node (it only gains sources); relations need known ends and a reason, and stay drafts.
 */
export function checkDraft(reply: unknown, chunkIds: readonly string[], known: readonly Known[], knownEdges: readonly Pick<KnowledgeEdge, 'from' | 'to' | 'type'>[]): ExtractionDraft {
  const record = reply && typeof reply === 'object' && !Array.isArray(reply) ? reply as Record<string, unknown> : undefined
  if (!record || !Array.isArray(record.nodes)) throw new Error('模型回复里没有节点列表')
  const allowed = new Set(chunkIds)
  const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '')
  const cited = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).filter((id): id is string => typeof id === 'string').map(id => id.trim()).filter(id => allowed.has(id)))]
  const skipped: string[] = []
  const nodes: NewNode[] = []
  /** Normalized label → the reference a relation end resolves to: a new node's title or a course node's id. */
  const refs = new Map<string, string>()
  let reused = 0
  for (const item of record.nodes.slice(0, 100)) {
    const raw = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const title = text(raw.title, 200)
    if (!title) { skipped.push('有一个节点没有名称'); continue }
    const kind = NodeKind.safeParse(raw.kind)
    if (!kind.success) { skipped.push(`「${title}」的类型不对`); continue }
    const sources = cited(raw.sources)
    if (!sources.length) { skipped.push(`「${title}」没有引用本小节的原文`); continue }
    const aliases = (Array.isArray(raw.aliases) ? raw.aliases : []).map(alias => text(alias, 100)).filter(Boolean).slice(0, 10)
    const labels = nodeLabels({ title, aliases })
    if ([...labels].some(label => refs.has(label))) { skipped.push(`「${title}」重复`); continue }
    const same = known.filter(node => [...nodeLabels(node)].some(label => labels.has(label)))
    const match = same.filter(node => node.kind === kind.data)
    if (same.length && match.length !== 1) {
      skipped.push(match.length > 1 ? `本课有几个和「${title}」同名的节点，分不清是哪一个` : `本课已有同名的「${same[0]!.title}」，类型是${KIND_LABEL[same[0]!.kind]}，不同`)
      continue
    }
    if (nodes.length >= MAX_NODES) { skipped.push(`超出每节 ${MAX_NODES} 个节点的上限：「${title}」`); continue }
    if (match[0]) {
      nodes.push({ title: match[0].title, kind: match[0].kind, reuseId: match[0].id, sources })
      for (const label of labels) refs.set(label, match[0].id)
      reused++
    } else {
      nodes.push({ title, kind: kind.data, description: text(raw.description, 2000), aliases, conditions: text(raw.conditions, 1000), sources })
      for (const label of labels) refs.set(label, title)
    }
  }
  for (const node of known) for (const label of nodeLabels(node)) if (!refs.has(label)) refs.set(label, node.id)
  const seen = new Set(knownEdges.map(edge => edgeKey(edge.type, edge.from, edge.to)))
  const edges: NewEdge[] = []
  for (const item of Array.isArray(record.edges) ? record.edges.slice(0, 200) : []) {
    const raw = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const fromText = text(raw.from, 200), toText = text(raw.to, 200), what = `「${fromText}」和「${toText}」的关系`
    const type = EdgeType.safeParse(raw.type)
    if (!type.success) { skipped.push(`${what}类型不对`); continue }
    const resolve = (value: string) => refs.get(normalizeLabel(value)) ?? known.find(node => node.id === value)?.id
    const from = resolve(fromText), to = resolve(toText)
    if (!from || !to) { skipped.push(`${what}有一端不是本小节或本课的节点`); continue }
    if (from === to) { skipped.push(`${what}连向了自己`); continue }
    const rationale = text(raw.rationale, 2000)
    if (!rationale) { skipped.push(`${what}没有写理由`); continue }
    const k = edgeKey(type.data, from, to)
    if (seen.has(k)) { skipped.push(`${what}已经有了`); continue }
    if (edges.length >= MAX_EDGES) { skipped.push(`超出每节 ${MAX_EDGES} 条关系的上限：${what}`); continue }
    seen.add(k)
    edges.push({ from, to, type: type.data, rationale, sources: cited(raw.sources), status: 'draft' })
  }
  return { nodes, edges, reused, skipped }
}

function edgeKey(type: string, from: string, to: string): string {
  return type === 'related' ? `${type}:${[from, to].sort().join(':')}` : `${type}:${from}:${to}`
}

function fingerprint(chunks: readonly CitedChunk[]): string {
  const hash = createHash('sha256')
  for (const chunk of chunks) hash.update(`${chunk.id}\n${chunk.text}\n`)
  return hash.digest('hex')
}

export class KnowledgeExtractions {
  private readonly running = new Map<string, AbortController>()
  private readonly queue: string[] = []
  private disposed = false

  constructor(private readonly ctx: Context, private readonly store: KnowledgeStore, private readonly model: () => string | undefined) {}

  private get sqlite() { return this.ctx.learnCore.db.sqlite }

  get(id: string): KnowledgeExtraction | undefined {
    const row = this.sqlite.prepare('SELECT data FROM knowledge_extractions WHERE id = ?').get(id) as { data: string } | undefined
    return row ? KnowledgeExtraction.parse(JSON.parse(row.data)) : undefined
  }

  private save(job: KnowledgeExtraction, patch: Partial<KnowledgeExtraction> = {}): KnowledgeExtraction {
    const next = KnowledgeExtraction.parse({ ...job, ...patch, updatedAt: new Date().toISOString() })
    this.sqlite.prepare(`INSERT INTO knowledge_extractions VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`).run(next.id, next.courseId, next.sourceId, next.section, next.status, JSON.stringify(next))
    this.ctx.emit('learning/extraction-changed', next)
    return next
  }

  private jobs(courseId: string, sourceId: string): Map<string, KnowledgeExtraction> {
    const latest = new Map<string, KnowledgeExtraction>()
    for (const row of this.sqlite.prepare('SELECT data FROM knowledge_extractions WHERE course_id = ? AND source_id = ? ORDER BY rowid').all(courseId, sourceId) as { data: string }[]) {
      const job = KnowledgeExtraction.parse(JSON.parse(row.data))
      latest.set(job.section, job)
    }
    return latest
  }

  private sources(courseId: string) {
    if (!this.ctx.learnCore.courses.get(courseId)) throw new LearningApiError('learning/knowledge/no-course', '课程不存在')
    return this.ctx.learnLibrary.courseSources(courseId).filter(entry => entry.source.status === 'ready' && entry.source.authority !== 'clue')
  }

  private pickSource(courseId: string, sourceId?: string) {
    const sources = this.sources(courseId)
    const source = sourceId ? sources.find(entry => entry.sourceId === sourceId) : sources.find(entry => entry.role === 'skeleton') ?? sources[0]
    if (!source) throw new LearningApiError('learning/knowledge/no-source', sourceId ? '这份资料没有加入本课或还不能引用' : '本课还没有可以引用的资料，请学习者先在资料库把教材加入本课')
    return source
  }

  private chunks(sourceId: string, section: string): CitedChunk[] {
    return this.ctx.learnLibrary.section(sourceId, section).filter(chunk => !LEFT_OUT.has(chunk.kind))
  }

  overview(courseId: string, sourceId?: string): ExtractionOverview {
    const sources = this.sources(courseId)
    const source = sources.length ? this.pickSource(courseId, sourceId) : undefined
    if (!source) return { sources: [], sections: [] }
    const jobs = this.jobs(courseId, source.sourceId)
    const seen = new Set<string>()
    const sections = this.ctx.learnLibrary.outline(source.sourceId).flatMap(entry => {
      const heading = entry.section.at(-1)
      if (!heading) return []
      const section = sectionKey(heading)
      if (seen.has(section)) return []
      seen.add(section)
      const job = jobs.get(section)
      const stale = job?.status === 'done' && fingerprint(this.chunks(source.sourceId, section)) !== job.fingerprint
      return [{ section, heading, depth: entry.section.length, ...(job ? { job } : {}), ...(stale ? { stale } : {}) }]
    })
    return { sources: sources.map(entry => ({ id: entry.sourceId, title: entry.source.title, role: entry.role })), sourceId: source.sourceId, sections }
  }

  start(courseId: string, sections: readonly string[], by: KnowledgeExtraction['by'], sourceId?: string): ExtractionStart[] {
    const source = this.pickSource(courseId, sourceId)
    const outline = this.ctx.learnLibrary.outline(source.sourceId).map(entry => entry.section.at(-1) ?? '')
    const jobs = this.jobs(courseId, source.sourceId)
    const results = [...new Set(sections.map(section => sectionKey(section)))].map((section): ExtractionStart => {
      const chunks = this.chunks(source.sourceId, section)
      if (!chunks.length) return { section, outcome: 'not-found', message: `《${source.source.title}》里没有小节 ${section}，或者这一节只有习题` }
      const size = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)
      if (size > MAX_SECTION_CHARS) return { section, outcome: 'too-long', message: `${section} 太长（约 ${Math.round(size / 1000)} 千字），请改用它的下一级小节` }
      const print = fingerprint(chunks)
      const job = jobs.get(section)
      if (job && (job.status === 'queued' || job.status === 'running')) return { section, outcome: 'running', message: `${section} 正在抽取`, job }
      if (job?.status === 'done' && job.fingerprint === print) return { section, outcome: 'done', message: `${section} 已经抽取过：${job.message}`, job }
      const heading = outline.find(part => sectionKey(part) === section) ?? chunks[0]!.section.find(part => sectionKey(part) === section) ?? section
      const now = new Date().toISOString()
      const created = this.save(KnowledgeExtraction.parse({
        id: newId('extraction'), courseId, sourceId: source.sourceId, section, heading, fingerprint: print,
        status: 'queued', by, message: '排队中', createdAt: now, updatedAt: now,
      }))
      this.queue.push(created.id)
      return { section, outcome: 'started', message: `${section} 已开始抽取`, job: created }
    })
    this.pump()
    return results
  }

  cancel(id: string): KnowledgeExtraction {
    const job = this.get(id)
    if (!job) throw new LearningApiError('learning/knowledge/no-extraction', '找不到这个抽取任务')
    if (job.status !== 'queued' && job.status !== 'running') return job
    const index = this.queue.indexOf(id)
    if (index >= 0) this.queue.splice(index, 1)
    const canceled = this.save(job, { status: 'canceled', message: '已取消' })
    this.running.get(id)?.abort()
    return canceled
  }

  /** Jobs a restart interrupted start again; one that already wrote its group is only marked done. */
  resume(): void {
    for (const row of this.sqlite.prepare("SELECT data FROM knowledge_extractions WHERE status IN ('queued', 'running') ORDER BY rowid").all() as { data: string }[]) {
      const job = KnowledgeExtraction.parse(JSON.parse(row.data))
      if (this.queue.includes(job.id) || this.running.has(job.id)) continue
      this.save(job, { status: 'queued', message: '程序重启后继续' })
      this.queue.push(job.id)
    }
    this.pump()
  }

  dispose(): void {
    this.disposed = true
    this.queue.length = 0
    for (const controller of this.running.values()) controller.abort()
  }

  private pump(): void {
    while (!this.disposed && this.running.size < PARALLEL && this.queue.length) this.launch(this.queue.shift()!)
  }

  private launch(id: string): void {
    const job = this.get(id)
    if (!job || job.status !== 'queued') return
    const controller = new AbortController()
    this.running.set(id, controller)
    const work = (progress: (text: string) => void) => this.run(id, controller.signal, progress).finally(() => {
      this.running.delete(id)
      this.pump()
    })
    if (!this.ctx.jobs) { void work(() => {}); return } // Unit harness: no jobs service.
    try {
      this.ctx.jobs.start({
        kind: 'knowledge-extract', label: `抽取 ${job.heading} 的知识`,
        run: handle => ({
          cancel: () => controller.abort(),
          done: work(text => handle.updateProgress(text)).then(() => {
            if (this.disposed) return { status: 'killed' as const, detail: '程序关闭；下次启动继续' }
            const settled = this.get(id)
            return { status: settled?.status === 'done' ? 'completed' as const : settled?.status === 'canceled' ? 'killed' as const : 'failed' as const, detail: settled?.message ?? '' }
          }),
        }),
      })
    } catch {
      this.running.delete(id)
      this.save(job, { status: 'failed', message: '后台任务服务暂不可用，请稍后重试' })
    }
  }

  private async run(id: string, signal: AbortSignal, progress: (text: string) => void): Promise<void> {
    let job = this.get(id)!
    const course = this.ctx.learnCore.courses.get(job.courseId)
    const source = this.ctx.learnLibrary.source(job.sourceId)
    const requestId = `extract:${job.id}`
    try {
      job = this.save(job, { status: 'running', message: '正在抽取' })
      progress(job.message)
      if (!course || !source) throw new Error('课程或资料已不存在')
      const chunks = this.chunks(job.sourceId, job.section)
      if (!chunks.length) throw new Error('这一节的原文已不存在，资料可能被重新解析过')
      const graph = this.store.graph(job.courseId)
      // A restart after the group was written but before the job was marked: keep that group.
      const done = this.store.operationFor(job.courseId, requestId)
      let draft: ExtractionDraft | undefined
      let operationId = done?.id
      if (!done) {
        const known = graph.nodes.map(node => ({ id: node.id as string, title: node.title, aliases: node.aliases, kind: node.kind }))
        const prompt = [
          `# 课程\n${course.title}`,
          `# 资料\n《${source.title}》${job.heading}`,
          `# 本课已有节点\n${known.length ? known.slice(0, 300).map(node => `- ${node.title}（${node.kind}）`).join('\n') + (known.length > 300 ? `\n其余 ${known.length - 300} 个省略` : '') : '还没有'}`,
          `# 原文\n${chunks.map(chunk => `[${chunk.id}] ${chunk.citation}\n${chunk.text}`).join('\n\n')}`,
        ].join('\n\n')
        const reply = await complete(this.ctx, { system: EXTRACT_SYSTEM, prompt, purpose: 'learning-knowledge-extract', model: this.model(), maxTokens: MAX_TOKENS, signal })
        signal.throwIfAborted()
        let parsed: unknown
        try { parsed = parseJsonReply(reply) } catch { throw new Error('模型回复不是 JSON') }
        draft = checkDraft(parsed, chunks.map(chunk => chunk.id), known, graph.edges)
        if (!draft.nodes.length && !draft.edges.length) throw new Error(`没有一项通过检查${draft.skipped.length ? `：${draft.skipped.slice(0, 3).join('；')}` : ''}`)
        const result = this.store.add(job.courseId, { requestId, nodes: draft.nodes, edges: draft.edges }, { actor: 'system', reason: `按小节抽取知识草案：《${source.title}》${job.heading}` })
        operationId = result.operationId
      }
      const created = draft ? draft.nodes.length - draft.reused : 0
      const summary = draft
        ? `新增 ${created} 个节点、${draft.edges.length} 条草案关系${draft.reused ? `，给 ${draft.reused} 个已有节点补了出处` : ''}${draft.skipped.length ? `，跳过 ${draft.skipped.length} 项` : ''}`
        : '已加入本课'
      job = this.save(job, {
        status: 'done', message: summary,
        ...(draft ? { result: { nodes: created, reused: draft.reused, edges: draft.edges.length, skipped: draft.skipped.slice(0, 30) } } : {}),
        ...(operationId ? { operationId: operationId as KnowledgeExtraction['operationId'] } : {}),
      })
      this.ctx.emit('learning/handoff', { courseId: job.courseId, unit: 'knowledge', text: `《${source.title}》${job.heading} 的知识草案已加入本课：${summary}。关系都是草案，核对原文后再改为有效。` })
    } catch (error) {
      if (this.disposed) return
      if (signal.aborted) {
        if (this.get(id)?.status !== 'canceled') this.save(job, { status: 'canceled', message: '已取消' })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      job = this.save(job, { status: 'failed', message })
      this.ctx.emit('learning/handoff', { courseId: job.courseId, unit: 'knowledge', text: `《${source?.title ?? '资料'}》${job.heading} 的知识抽取没有完成：${message}。可以稍后重试。` })
    }
  }
}
