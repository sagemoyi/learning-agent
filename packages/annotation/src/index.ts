// annotation unit, host half. Provides `ctx.learnAnnotation` (contracts §5.1, docs/annotation/design.md): notes on a
// paragraph of the textbook or a chunk of a source, of four kinds (question / my understanding / highlight / error).
//
// Findable first: an annotation keeps the quote the learner selected and the content fingerprint of the paragraph at
// that time, and its place in today's text is derived from them (anchor.ts) and shown only when it can be verified.
// A note is never lost when that fails. A note is a signal, never evidence of mastery: only a question about a
// node adds one `signal.question` (once per annotation); editing, hiding or resolving a note changes no evidence.
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  Annotation,
  AnnotationAnchor,
  AnnotationType,
  LearningApiError,
  newId,
  type AnnotationFilter,
  type AnnotationLocation,
  type BlockWithText,
  type LearnAnnotation,
  type Migration,
  type NewAnnotation,
  type Proposal,
  type Selection,
  type TextQuote,
} from '@learning-agent/contracts'
import { must, now } from '@learning-agent/kit'
import { z } from 'zod'
import type { NotePlace, NoteView } from './types.ts'
import { locateQuote, placeAnnotation, plainText, quoteCutsFormula, quoteFound, type Candidate } from './anchor.ts'

export const name = 'learning-annotation'
export const inject = ['learnCore', 'learnTextbook', 'learnCurriculum', 'learnLibrary', 'learnSidechat']

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE annotation_annotations (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        request_id TEXT,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX annotation_by_course ON annotation_annotations (course_id, created_at);
      CREATE UNIQUE INDEX annotation_by_request ON annotation_annotations (course_id, request_id) WHERE request_id IS NOT NULL;
    `,
  },
]

/** How long a quote may be, and how much of the note is kept in a log or label. */
const MAX_QUOTE = 2000
const MAX_TEXT = 8000
const SUCCESSOR_DEPTH = 6

const NewAnnotationInput = z.object({
  courseId: z.string(),
  anchor: AnnotationAnchor,
  type: AnnotationType,
  text: z.string().max(MAX_TEXT).optional(),
  requestId: z.string().min(1).max(100).optional(),
})

const brief = (text: string, max = 40): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return [...flat].length > max ? `${[...flat].slice(0, max - 1).join('')}…` : flat
}

const candidateOf = (block: BlockWithText): Candidate => ({ blockId: block.id, hash: block.hash, text: block.text })

const sameLocation = (a: AnnotationLocation, b: AnnotationLocation): boolean =>
  a.status === b.status && a.blockId === b.blockId && a.hash === b.hash && a.reason === b.reason && a.suggestion === b.suggestion && a.confirmedAt === b.confirmedAt

class LearnAnnotationService extends Service implements LearnAnnotation {
  constructor(ctx: Context) {
    super(ctx, 'learnAnnotation')
    ctx.learnCore.db.migrate('annotation', migrations)
  }

  private get sqlite() {
    return this.ctx.learnCore.db.sqlite
  }

  private read(annotationId: string): Annotation | undefined {
    const row = this.sqlite.prepare('SELECT data FROM annotation_annotations WHERE id = ?').get(annotationId) as { data: string } | undefined
    return row ? Annotation.parse(JSON.parse(row.data)) : undefined
  }

  private save(annotation: Annotation): void {
    this.sqlite.prepare('UPDATE annotation_annotations SET data = ? WHERE id = ?').run(JSON.stringify(annotation), annotation.id)
  }

  private changed(annotation: Annotation): void {
    this.ctx.emit('learning/annotation-changed', { courseId: annotation.courseId, annotationId: annotation.id })
  }

  get(annotationId: string): Annotation | undefined {
    return this.read(annotationId)
  }

  /** The paragraphs the annotation can be on now: its own, or what a revision turned it into. */
  private async candidates(annotation: Annotation): Promise<Candidate[]> {
    const { anchor, courseId } = annotation
    if (anchor.kind !== 'block') return []
    const textbook = this.ctx.learnTextbook
    const own = await textbook.block(courseId, anchor.blockId)
    if (own) return [candidateOf(own)]
    const found = new Map<string, BlockWithText>()
    const seen = new Set<string>([anchor.blockId])
    let frontier = [anchor.blockId]
    for (let depth = 0; depth < SUCCESSOR_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = []
      for (const id of frontier) {
        for (const revision of textbook.revisions(courseId, id)) {
          for (const into of revision.into) {
            if (seen.has(into)) continue
            seen.add(into)
            const block = await textbook.block(courseId, into)
            if (block) found.set(block.id, block)
            else next.push(into)
          }
        }
      }
      frontier = next
    }
    return [...found.values()].map(candidateOf)
  }

  /** Where the annotation is now. A chunk is a snapshot of the source: it stays unless the source is gone. */
  private async place(annotation: Annotation): Promise<AnnotationLocation> {
    const at = now()
    const { anchor } = annotation
    if (anchor.kind === 'chunk') {
      const chunk = this.ctx.learnLibrary.chunk(anchor.chunkId)
      if (!chunk) return { status: 'original-only', reason: '这份资料已经不在资料库里了，批注和原句还保留着', checkedAt: at }
      if (!anchor.quote) return { status: 'anchored', checkedAt: at }
      const found = locateQuote(plainText(chunk.text), anchor.quote)
      return found.status === 'anchored'
        ? { status: 'anchored', checkedAt: at }
        : { status: found.status, reason: found.reason, ...(found.status === 'needs-confirmation' && found.suggestion ? { suggestion: found.suggestion } : {}), checkedAt: at }
    }
    return placeAnnotation(anchor.quote, await this.candidates(annotation), {
      ...(anchor.hash ? { anchorHash: anchor.hash } : {}),
      previous: annotation.location,
      at,
    })
  }

  private refuseHalfFormula(text: string, quote: TextQuote | undefined): void {
    if (quote && quoteCutsFormula(text, quote)) throw new LearningApiError('learning/annotation/quote-cuts-formula', '选中的内容只含半个公式，请把整个公式选上')
  }

  async create(input: NewAnnotation): Promise<Annotation> {
    const parsed = NewAnnotationInput.parse(input)
    const { courseId, type } = parsed
    const course = must(this.ctx.learnCore.courses.get(courseId), 'annotation', '课程', courseId)
    if (parsed.requestId) {
      const known = this.sqlite.prepare('SELECT id FROM annotation_annotations WHERE course_id = ? AND request_id = ?').get(courseId, parsed.requestId) as { id: string } | undefined
      if (known) return must(this.read(known.id), 'annotation', '批注', known.id)
    }
    const text = (parsed.text ?? '').trim()
    if (type !== 'highlight' && !text) {
      throw new LearningApiError('learning/annotation/needs-text', { question: '请写下要问的问题', understanding: '请写下你的理解', error: '请写明哪里有错' }[type])
    }
    if (parsed.anchor.quote && [...parsed.anchor.quote.exact].length > MAX_QUOTE) {
      throw new LearningApiError('learning/annotation/quote-too-long', `选中的文字太长（最多 ${MAX_QUOTE} 字），请分开批注`)
    }

    // The place must exist now and the quote must be in it; the fingerprint is the paragraph as the learner saw it.
    let anchor: AnnotationAnchor = parsed.anchor
    let nodeIds: readonly string[] = []
    if (anchor.kind === 'block') {
      if (anchor.courseId !== course.id) throw new LearningApiError('learning/annotation/wrong-course', '这一段不属于这门课')
      const block = await this.ctx.learnTextbook.block(course.id, anchor.blockId)
      if (!block) throw new LearningApiError('learning/annotation/block-missing', '这一段已经不在教材里了，刷新页面后再批注')
      if (anchor.quote && !quoteFound(plainText(block.text), anchor.quote)) {
        throw new LearningApiError('learning/annotation/quote-missing', '选中的文字不在这一段里（教材可能刚刚改过），刷新页面后重新选')
      }
      this.refuseHalfFormula(block.text, anchor.quote)
      anchor = { ...anchor, hash: block.hash }
      nodeIds = block.nodeIds
    } else {
      const chunk = must(this.ctx.learnLibrary.chunk(anchor.chunkId), 'annotation', '资料片段', anchor.chunkId)
      if (!this.ctx.learnLibrary.courseSources(course.id).some(entry => entry.sourceId === chunk.sourceId)) {
        throw new LearningApiError('learning/annotation/wrong-course', '这份资料没有加入这门课，不能在这里批注')
      }
      if (anchor.quote && !quoteFound(plainText(chunk.text), anchor.quote)) {
        throw new LearningApiError('learning/annotation/quote-missing', '选中的文字不在这个资料片段里')
      }
      this.refuseHalfFormula(chunk.text, anchor.quote)
      anchor = { ...anchor, courseId: course.id }
    }

    const at = now()
    const draft: Annotation = {
      id: newId('annotation'),
      courseId: course.id,
      anchor,
      type,
      text,
      createdAt: at,
      updatedAt: at,
      location: { status: 'anchored', checkedAt: at },
    }
    const location = await this.place(draft)
    const annotation: Annotation = { ...draft, location }
    const core = this.ctx.learnCore
    core.db.transaction(() => {
      this.sqlite.prepare('INSERT INTO annotation_annotations (id, course_id, request_id, created_at, data) VALUES (?, ?, ?, ?, ?)')
        .run(annotation.id, course.id, parsed.requestId ?? null, annotation.createdAt, JSON.stringify(annotation))
      // Asking about a paragraph that explains knowledge points marks them 有疑点; nothing else is evidence.
      if (type === 'question' && nodeIds.length > 0) {
        core.log.append({ type: 'signal.question', courseId: course.id, nodeIds: [...nodeIds] as never, context: {}, text, ref: `annotation:${annotation.id}` })
      }
    })
    this.changed(annotation)
    // An error report with a certain place becomes a proposal at once; otherwise it waits for the place to be confirmed.
    if (type === 'error' && annotation.anchor.kind === 'block' && location.status === 'anchored') {
      try {
        await this.submitError(annotation.id)
      } catch (error) {
        this.ctx.logger('learning-annotation').warn('proposal for %s failed: %s', annotation.id, (error as Error).message)
      }
    }
    return must(this.read(annotation.id), 'annotation', '批注', annotation.id)
  }

  async list(filter: AnnotationFilter): Promise<Annotation[]> {
    const rows = this.sqlite.prepare('SELECT data FROM annotation_annotations WHERE course_id = ? ORDER BY created_at DESC, id DESC').all(filter.courseId) as { data: string }[]
    const result: Annotation[] = []
    for (const row of rows) {
      let annotation = Annotation.parse(JSON.parse(row.data))
      // Recomputed on every read, kept quietly (an event here would make every open page reload again).
      const location = await this.place(annotation)
      if (!sameLocation(annotation.location, location)) {
        annotation = { ...annotation, location }
        this.save(annotation)
      }
      if (!filter.includeHidden && annotation.hiddenAt) continue
      if (filter.type && annotation.type !== filter.type) continue
      if (filter.resolved !== undefined && Boolean(annotation.resolvedAt) !== filter.resolved) continue
      if (filter.blockId && annotation.location.blockId !== filter.blockId) continue
      if (filter.locationIssues && annotation.location.status === 'anchored') continue
      result.push(annotation)
    }
    return result
  }

  private update(annotationId: string, change: (annotation: Annotation) => Annotation): Annotation {
    const current = must(this.read(annotationId), 'annotation', '批注', annotationId)
    const next = { ...change(current), updatedAt: now() }
    this.save(next)
    this.changed(next)
    return next
  }

  edit(annotationId: string, patch: { readonly text: string }): Annotation {
    const text = z.string().max(MAX_TEXT).parse(patch.text).trim()
    const current = must(this.read(annotationId), 'annotation', '批注', annotationId)
    if (current.type !== 'highlight' && !text) throw new LearningApiError('learning/annotation/needs-text', '批注内容不能为空')
    return this.update(annotationId, annotation => ({ ...annotation, text }))
  }

  setResolved(annotationId: string, resolved: boolean): Annotation {
    return this.update(annotationId, ({ resolvedAt: _, ...rest }) => ({ ...rest, ...(resolved ? { resolvedAt: now() } : {}) }))
  }

  setHidden(annotationId: string, hidden: boolean): Annotation {
    return this.update(annotationId, ({ hiddenAt: _, ...rest }) => ({ ...rest, ...(hidden ? { hiddenAt: now() } : {}) }))
  }

  async confirmLocation(annotationId: string, blockId?: string): Promise<Annotation> {
    const annotation = must(this.read(annotationId), 'annotation', '批注', annotationId)
    if (annotation.anchor.kind !== 'block') throw new LearningApiError('learning/annotation/no-place', '资料片段是固定的快照，不需要确认位置')
    const candidates = await this.candidates(annotation)
    const current = await this.place(annotation)
    if (current.status === 'anchored') return annotation
    if (candidates.length === 0) throw new LearningApiError('learning/annotation/no-place', '这一段已经不在教材里了，没有可以确认的位置；批注和原句还保留着')
    const target = blockId ? candidates.find(candidate => candidate.blockId === blockId) : candidates.length === 1 ? candidates[0] : undefined
    if (!target) throw new LearningApiError('learning/annotation/pick-block', '这条批注可能在几段里，请指明是哪一段', { blockIds: candidates.map(candidate => candidate.blockId) })
    const at = now()
    const confirmed = this.update(annotationId, item => ({ ...item, location: { status: 'anchored', blockId: target.blockId, hash: target.hash, confirmedAt: at, checkedAt: at } }))
    if (confirmed.type === 'error' && !confirmed.proposalId) await this.submitError(annotationId)
    return must(this.read(annotationId), 'annotation', '批注', annotationId)
  }

  /** The paragraphs a note whose place is unsure may belong to now, for the learner to pick from. */
  async candidateList(annotationId: string): Promise<{ readonly blockId: string; readonly preview: string }[]> {
    const annotation = must(this.read(annotationId), 'annotation', '批注', annotationId)
    return (await this.candidates(annotation)).map(candidate => ({ blockId: candidate.blockId, preview: brief(plainText(candidate.text), 60) }))
  }

  /** Where each note of the course is read: the lesson of its paragraph, or the source it is on. */
  async places(courseId: string): Promise<Record<string, NotePlace>> {
    const lessonOfFile = new Map<string, NotePlace>()
    for (const stage of this.ctx.learnCurriculum.stages(courseId)) {
      for (const lesson of this.ctx.learnCurriculum.lessons(stage.id)) {
        if (lesson.textbookFile) lessonOfFile.set(lesson.textbookFile, { kind: 'lesson', lessonId: lesson.id, title: `${lesson.number} ${lesson.title}` })
      }
    }
    const result: Record<string, NotePlace> = {}
    for (const row of this.sqlite.prepare('SELECT data FROM annotation_annotations WHERE course_id = ?').all(courseId) as { data: string }[]) {
      const annotation = Annotation.parse(JSON.parse(row.data))
      if (annotation.anchor.kind === 'chunk') {
        const chunk = this.ctx.learnLibrary.chunk(annotation.anchor.chunkId)
        if (chunk) result[annotation.id] = { kind: 'source', chunkId: chunk.id, title: chunk.citation }
        continue
      }
      const block = await this.ctx.learnTextbook.block(courseId, annotation.location.blockId ?? annotation.anchor.blockId)
      const place = block ? lessonOfFile.get(block.file) : undefined
      if (place) result[annotation.id] = place
    }
    return result
  }

  sideChatSelection(annotationId: string): Selection {
    const annotation = must(this.read(annotationId), 'annotation', '批注', annotationId)
    const where = annotation.anchor.kind === 'block' ? '教材' : '资料'
    return {
      page: 'annotation',
      courseId: annotation.courseId,
      selected: {
        kind: 'text',
        id: annotation.id,
        ...(annotation.anchor.quote ? { quote: annotation.anchor.quote } : {}),
        label: `${where}批注 · ${brief(annotation.anchor.quote?.exact ?? annotation.text, 18)}`,
      },
    }
  }

  /** The teacher decided an error report: its notes count as handled (the page shows what was done and why). */
  handled(proposal: Proposal): void {
    if (!proposal.courseId) return
    const rows = this.sqlite.prepare("SELECT id FROM annotation_annotations WHERE course_id = ? AND json_extract(data, '$.proposalId') = ?").all(proposal.courseId, proposal.id) as { id: string }[]
    for (const { id } of rows) {
      const annotation = this.read(id)
      if (annotation && !annotation.resolvedAt) this.update(id, item => ({ ...item, resolvedAt: proposal.decidedAt ?? now() }))
    }
  }

  /** Notes with what became of their error reports and side chats, for the pages. */
  view(notes: readonly Annotation[]): NoteView[] {
    const core = this.ctx.learnCore
    return notes.map(note => {
      const proposal = note.proposalId ? core.proposals.get(note.proposalId) : undefined
      const chat = note.sideChatSessionId ? core.sessions.get(note.sideChatSessionId) : undefined
      return {
        ...note,
        ...(proposal ? { proposal: { status: proposal.status, ...(proposal.decisionNote ? { note: proposal.decisionNote } : {}) } } : {}),
        ...(chat && !chat.closedAt ? { chatOpen: true as const } : {}),
      }
    })
  }

  linkSideChat(annotationId: string, sessionId: string): Annotation {
    return this.update(annotationId, annotation => ({ ...annotation, sideChatSessionId: sessionId }))
  }

  async submitError(annotationId: string): Promise<Proposal> {
    const annotation = must(this.read(annotationId), 'annotation', '批注', annotationId)
    const core = this.ctx.learnCore
    if (annotation.type !== 'error') throw new LearningApiError('learning/annotation/not-error', '只有"报错"批注能提交修改提案')
    if (annotation.proposalId) return must(core.proposals.get(annotation.proposalId), 'annotation', '提案', annotation.proposalId)
    if (annotation.anchor.kind !== 'block') throw new LearningApiError('learning/annotation/no-target', '资料里的错误要在资料库页处理；教材里的错误才能提交修改提案')
    const location = await this.place(annotation)
    if (location.status !== 'anchored' || !location.blockId) {
      throw new LearningApiError('learning/annotation/place-unsure', `还不能确定错在哪一处，先确认批注的位置（${location.reason ?? '位置不确定'}）`)
    }
    const block = must(await this.ctx.learnTextbook.block(annotation.courseId, location.blockId), 'annotation', '教材段落', location.blockId)
    const quote = annotation.anchor.quote?.exact
    const proposal = core.db.transaction(() => {
      const created = core.proposals.create({
        courseId: annotation.courseId,
        source: 'annotation',
        targets: [{ kind: 'file', courseId: annotation.courseId, path: block.file }],
        summary: `教材报错：${brief(quote ?? plainText(block.text), 30)}`,
        rationale: [`学习者说：${annotation.text}`, quote ? `段落 ^${block.id} 里选中的原句：「${quote}」` : `针对整段 ^${block.id}`].join('\n'),
      })
      this.save({ ...annotation, proposalId: created.id, updatedAt: now(), location })
      return created
    })
    this.changed(annotation)
    this.ctx.emit('learning/handoff', { courseId: annotation.courseId, unit: 'annotation', text: `学习者在教材上报了一处错误，已生成修改提案：${proposal.summary}。` })
    return proposal
  }
}

export function apply(ctx: Context): void {
  const annotations = new LearnAnnotationService(ctx)
  const asking = new Map<string, Promise<{ sessionId: string; reused: boolean }>>()

  /** A question goes to one side chat; asking again while it is open goes back to it. */
  const ask = async (annotationId: string): Promise<{ sessionId: string; reused: boolean }> => {
    const annotation = must(annotations.get(annotationId), 'annotation', '批注', annotationId)
    const linked = annotation.sideChatSessionId ? ctx.learnCore.sessions.get(annotation.sideChatSessionId) : undefined
    if (linked && !linked.closedAt) return { sessionId: linked.sessionId, reused: true }
    const { sessionId } = await ctx.learnSidechat.open(annotations.sideChatSelection(annotationId))
    annotations.linkSideChat(annotationId, sessionId)
    return { sessionId, reused: false }
  }

  ctx.on('learning/proposal-decided', proposal => {
    if (proposal.source === 'annotation') annotations.handled(proposal)
  })

  // The side chat sees the learner's own note and the sentence it is about, with a plain note when the text moved on.
  ctx.on('learning/describe-selection', async (selection, next) => {
    const lines = await next()
    if (selection.page !== 'annotation' || selection.selected?.kind !== 'text' || !selection.selected.id) return lines
    const annotation = annotations.get(selection.selected.id)
    if (!annotation) return lines
    const kind = { question: '疑问', understanding: '我的理解', highlight: '重点', error: '报错' }[annotation.type]
    const parts = [`学习者的批注（${kind}）：${annotation.text || '（没有写字，只划了重点）'}`]
    if (annotation.anchor.quote) parts.push(`批注针对的原句：「${annotation.anchor.quote.exact}」`)
    if (annotation.location.status !== 'anchored') parts.push(`注意：这句话现在在教材里${annotation.location.status === 'original-only' ? '找不到了' : '位置不确定'}（${annotation.location.reason ?? ''}），以学习者当时划的原句为准。`)
    if (annotation.anchor.kind === 'block' && annotation.location.blockId) {
      const block = await ctx.learnTextbook.block(annotation.courseId, annotation.location.blockId)
      if (block) parts.push(`所在教材段落：\n${plainText(block.text)}`)
    }
    return [...lines, parts.join('\n')]
  })

  const endpoint = ctx.learnCore.api.endpoint
  const id = z.object({ annotationId: z.string() })
  ctx.effect(() => endpoint({ unit: 'annotation', method: 'create', input: NewAnnotationInput, handle: input => annotations.create(input as NewAnnotation) }), 'annotation: create')
  ctx.effect(() => endpoint({
    unit: 'annotation',
    method: 'list',
    input: z.object({
      courseId: z.string(),
      type: AnnotationType.optional(),
      resolved: z.boolean().optional(),
      blockId: z.string().optional(),
      locationIssues: z.boolean().optional(),
      includeHidden: z.boolean().optional(),
    }),
    handle: async filter => annotations.view(await annotations.list(filter)),
  }), 'annotation: list')
  ctx.effect(() => endpoint({ unit: 'annotation', method: 'edit', input: id.extend({ text: z.string() }), handle: ({ annotationId, text }) => annotations.edit(annotationId, { text }) }), 'annotation: edit')
  ctx.effect(() => endpoint({ unit: 'annotation', method: 'resolve', input: id.extend({ resolved: z.boolean() }), handle: ({ annotationId, resolved }) => annotations.setResolved(annotationId, resolved) }), 'annotation: resolve')
  ctx.effect(() => endpoint({ unit: 'annotation', method: 'hide', input: id.extend({ hidden: z.boolean() }), handle: ({ annotationId, hidden }) => annotations.setHidden(annotationId, hidden) }), 'annotation: hide')
  ctx.effect(() => endpoint({ unit: 'annotation', method: 'confirm', input: id.extend({ blockId: z.string().optional() }), handle: ({ annotationId, blockId }) => annotations.confirmLocation(annotationId, blockId) }), 'annotation: confirm')
  ctx.effect(() => endpoint({ unit: 'annotation', method: 'candidates', input: id, handle: ({ annotationId }) => annotations.candidateList(annotationId) }), 'annotation: candidates')
  ctx.effect(() => endpoint({ unit: 'annotation', method: 'places', input: z.object({ courseId: z.string() }), handle: ({ courseId }) => annotations.places(courseId) }), 'annotation: places')
  ctx.effect(() => endpoint({ unit: 'annotation', method: 'submitError', input: id, handle: ({ annotationId }) => annotations.submitError(annotationId) }), 'annotation: submitError')
  ctx.effect(() => endpoint({
    unit: 'annotation',
    method: 'ask',
    input: id,
    // Two clicks at once share one opening.
    handle: async ({ annotationId }) => {
      const running = asking.get(annotationId) ?? ask(annotationId).finally(() => asking.delete(annotationId))
      asking.set(annotationId, running)
      const { sessionId, reused } = await running
      const annotation = must(annotations.get(annotationId), 'annotation', '批注', annotationId)
      return { sessionId, reused, question: annotation.text }
    },
  }), 'annotation: ask')
}
