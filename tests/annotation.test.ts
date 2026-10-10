// annotation (docs/annotation/design.md): notes that stay findable when the text changes, and what each kind does next.
// Real units on a synthetic textbook file; DSH's transport, sessions and the model are fakes (tests/harness.ts).
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Annotation, Id, Proposal } from '@learning-agent/contracts'
import { FIXTURES, createHarness, type Harness } from './harness.ts'

const FILE = 'stages/st_synthetic/textbook/1.1.md'
const meta = { actor: 'teacher' as const, reason: '批注测试（合成）' }
const A = 'aaa111'
const B = 'bbb222'
const C = 'ccc333'
const TEXT = {
  [A]: '水深加倍时，静水压强也加倍。这里可以忽略高差。',
  [B]: '压强相同。其他条件不变时，压强相同。',
  [C]: '流速不变，质量流量不变。',
}

const lesson = (texts: Record<string, string>) => `# 1.1 静水压强\n\n${Object.entries(texts).map(([id, text]) => `${text} ^${id}`).join('\n\n')}\n`

let h: Harness
let courseId: Id<'course'>

beforeEach(async () => {
  h = createHarness(() => { throw new Error('annotation never calls the model') })
  courseId = (await h.endpoint('core', 'createCourse', { title: '批注测试（合成资料）' })).id
  await write(TEXT)
})
afterEach(() => h.dispose())

/** Write the textbook file and wait for the block index to follow. */
async function write(texts: Record<string, string>) {
  await h.ctx.learnCore.files.write(courseId, FILE, lesson(texts), meta)
  await h.settle()
}

const create = (input: Record<string, unknown>) => h.endpoint<Annotation>('annotation', 'create', { courseId, ...input })
const anchor = (blockId: string, exact?: string, prefix = '', suffix = '') => ({
  kind: 'block', courseId, blockId, ...(exact ? { quote: { exact, prefix, suffix } } : {}),
})
const list = (extra: Record<string, unknown> = {}) => h.endpoint<Annotation[]>('annotation', 'list', { courseId, ...extra })
const logOf = (type: 'signal.question' | 'signal.misconception' | 'help.given') => h.ctx.learnCore.log.query({ courseId, types: [type] })

/** Give a paragraph knowledge points, the way the textbook's lesson links would. */
function link(blockId: string, nodeIds: string[]) {
  h.ctx.learnCore.db.sqlite.prepare("UPDATE textbook_blocks SET data = json_set(data, '$.nodeIds', json(?)) WHERE course_id = ? AND block_id = ?").run(JSON.stringify(nodeIds), courseId, blockId)
}
/** What the side chat is told about the selection a session was opened from (the units' describe-selection chain). */
const describe = async (sessionId: string) =>
  (await h.ctx.waterfall('learning/describe-selection', h.ctx.learnCore.sessions.get(sessionId)!.openedFrom!, async () => [] as string[])).join('\n\n')
const NODE = 'kn_01J0000000000000000000000A'

it('keeps the quote and the paragraph as the learner saw them, once per request', async () => {
  const input = { type: 'highlight', anchor: anchor(A, '静水压强也加倍', '水深加倍时，', '。'), requestId: 'req-1' }
  const first = await create(input)
  const again = await create(input)
  expect(again.id).toBe(first.id)
  expect(await list()).toHaveLength(1)
  expect(first.anchor).toMatchObject({ kind: 'block', blockId: A, quote: { exact: '静水压强也加倍' }, hash: expect.any(String) })
  expect(first.location).toMatchObject({ status: 'anchored', blockId: A })
  // The paragraph's fingerprint is the server's, not whatever the page sent.
  const forged = await create({ type: 'highlight', anchor: { ...anchor(A, '静水压强也加倍'), hash: 'forged' } })
  expect(forged.anchor).toMatchObject({ hash: first.anchor.kind === 'block' ? first.anchor.hash : '' })
})

it('refuses what cannot be found or is not this course\'s', async () => {
  const failed = async (input: Record<string, unknown>) => (await h.call('annotation', 'create', { courseId, ...input })).error?.code
  expect(await failed({ type: 'highlight', anchor: anchor(A, '教材里没有这句话') })).toBe('learning/annotation/quote-missing')
  expect(await failed({ type: 'highlight', anchor: anchor('zzz999', '水深') })).toBe('learning/annotation/block-missing')
  expect(await failed({ type: 'question', anchor: anchor(A, '静水压强也加倍') })).toBe('learning/annotation/needs-text')
  expect(await failed({ type: 'highlight', anchor: { ...anchor(A, '水深'), courseId: 'cr_01J0000000000000000000000B' } })).toBe('learning/annotation/wrong-course')
  expect(await list()).toHaveLength(0)
})

it('a formula is selected whole: half a formula is refused, a whole one or the words around it are fine', async () => {
  await write({ [A]: '压强按 $p=\\rho g h$ 计算，与深度成正比。', [B]: TEXT[B] })
  const failed = async (exact: string) => (await h.call('annotation', 'create', { courseId, type: 'highlight', anchor: anchor(A, exact) })).error?.code
  expect(await failed('rho g')).toBe('learning/annotation/quote-cuts-formula')
  expect(await failed('压强按 $p=\\rho')).toBe('learning/annotation/quote-cuts-formula')
  expect(await list()).toHaveLength(0)
  const whole = await create({ type: 'highlight', anchor: anchor(A, '按 $p=\\rho g h$ 计算') })
  expect(whole.location.status).toBe('anchored')
  expect((await create({ type: 'highlight', anchor: anchor(A, '与深度成正比') })).location.status).toBe('anchored')
})

it('the page is told about what the learner does, never about a place worked out again', async () => {
  const changes: string[] = []
  h.ctx.on('learning/annotation-changed', change => { changes.push(change.annotationId) })
  const note = await create({ type: 'highlight', anchor: anchor(A, '静水压强也加倍', '水深加倍时，', '。') })
  expect(changes).toEqual([note.id])
  // The sentence changes and the place is worked out again on every read: the notes are saved, nobody is told.
  await write({ [A]: '水深加倍时，静水压强也不加倍。', [B]: TEXT[B] })
  expect((await list())[0]!.location.status).toBe('needs-confirmation')
  await list()
  await list({ locationIssues: true })
  expect(changes).toEqual([note.id])
  // What the learner does is told once each.
  await h.endpoint('annotation', 'edit', { annotationId: note.id, text: '改了' })
  await h.endpoint('annotation', 'resolve', { annotationId: note.id, resolved: true })
  await h.endpoint('annotation', 'hide', { annotationId: note.id, hidden: true })
  await h.endpoint('annotation', 'confirm', { annotationId: note.id })
  expect(changes).toEqual(Array(5).fill(note.id))
})

it('a question about a paragraph with knowledge points asks once; nothing else becomes a signal', async () => {
  link(A, [NODE])
  const question = await create({ type: 'question', text: '为什么可以忽略高差？', anchor: anchor(A, '这里可以忽略高差') })
  expect(logOf('signal.question')).toMatchObject([{ nodeIds: [NODE], text: '为什么可以忽略高差？', ref: `annotation:${question.id}` }])
  // Editing, hiding, resolving and reading again do not ask again, and none of them undoes the logged question.
  await h.endpoint('annotation', 'edit', { annotationId: question.id, text: '为什么这里可以忽略高差？' })
  await h.endpoint('annotation', 'hide', { annotationId: question.id, hidden: true })
  await h.endpoint('annotation', 'resolve', { annotationId: question.id, resolved: true })
  await list({ includeHidden: true })
  expect(logOf('signal.question')).toHaveLength(1)
  // My understanding, highlight and error are notes, not signals, and no note is evidence of mastery.
  await create({ type: 'understanding', text: '因为高差远小于总压头', anchor: anchor(A, '这里可以忽略高差') })
  await create({ type: 'highlight', anchor: anchor(A, '静水压强也加倍') })
  expect(logOf('signal.question')).toHaveLength(1)
  expect(logOf('signal.misconception')).toHaveLength(0)
  expect(logOf('help.given')).toHaveLength(0)
  expect(h.ctx.learnCore.log.query({ courseId, types: ['attempt.graded'] })).toHaveLength(0)
  // A paragraph without knowledge points has nothing to mark.
  await create({ type: 'question', text: '流量为什么不变？', anchor: anchor(C, '质量流量不变') })
  expect(logOf('signal.question')).toHaveLength(1)
})

it('hiding and resolving only change what the page shows', async () => {
  const note = await create({ type: 'highlight', anchor: anchor(A, '水深加倍时') })
  await h.endpoint('annotation', 'resolve', { annotationId: note.id, resolved: true })
  expect(await list({ resolved: false })).toHaveLength(0)
  expect(await list({ resolved: true })).toHaveLength(1)
  await h.endpoint('annotation', 'hide', { annotationId: note.id, hidden: true })
  expect(await list()).toHaveLength(0)
  expect((await list({ includeHidden: true }))[0]).toMatchObject({ id: note.id, hiddenAt: expect.any(String), resolvedAt: expect.any(String) })
  await h.endpoint('annotation', 'hide', { annotationId: note.id, hidden: false })
  expect(await list()).toHaveLength(1)
})

it('follows a paragraph that moved or changed elsewhere, and does not follow a changed sentence', async () => {
  const note = await create({ type: 'highlight', anchor: anchor(A, '静水压强也加倍', '水深加倍时，', '。') })
  // Text before it and after it changes, the paragraph moves: still the same place.
  await write({ [C]: '前面插进来一段。', [A]: '水深加倍时，静水压强也加倍。这里可以忽略高差，也可以不忽略。', [B]: TEXT[B] })
  expect((await list())[0]!.location).toMatchObject({ status: 'anchored', blockId: A })
  // The sentence itself changes: the note stays with its quote, the place waits for the learner.
  await write({ [A]: '水深加倍时，静水压强也不加倍。', [B]: TEXT[B] })
  const changed = (await list({ locationIssues: true }))[0]!
  expect(changed).toMatchObject({ id: note.id, anchor: { quote: { exact: '静水压强也加倍' } }, location: { status: 'needs-confirmation', suggestion: expect.stringContaining('不加倍') } })
  // It is back as it was: the place is found again by itself.
  await write({ [A]: TEXT[A], [B]: TEXT[B] })
  expect((await list())[0]!.location.status).toBe('anchored')
})

it('a deleted paragraph leaves the note and its quote readable', async () => {
  const note = await create({ type: 'understanding', text: '我的理解：压强只和深度有关', anchor: anchor(A, '静水压强也加倍') })
  await write({ [B]: TEXT[B] })
  const [gone] = await list({ locationIssues: true })
  expect(gone).toMatchObject({ id: note.id, text: '我的理解：压强只和深度有关', location: { status: 'original-only' } })
  expect((await h.call('annotation', 'confirm', { annotationId: note.id })).error?.code).toBe('learning/annotation/no-place')
})

it('a paragraph rewritten into others is searched through the revisions, and a split needs a pick when both have the sentence', async () => {
  const note = await create({ type: 'highlight', anchor: anchor(A, '静水压强也加倍', '水深加倍时，', '。') })
  const record = (blockId: string, into: string[]) => h.ctx.learnCore.db.sqlite.prepare('INSERT INTO textbook_revisions (course_id, block_id, data) VALUES (?, ?, ?)')
    .run(courseId, blockId, JSON.stringify({ blockId, into, at: new Date().toISOString(), changeId: 'chg_x', reason: '拆开' }))
  // A became D (with the sentence) and E.
  await write({ ddd444: '水深加倍时，静水压强也加倍。', eee555: '这里可以忽略高差。', [B]: TEXT[B] })
  record(A, ['ddd444', 'eee555'])
  expect((await list())[0]!.location).toMatchObject({ status: 'anchored', blockId: 'ddd444' })
  // Both paragraphs now say it: the learner picks.
  await write({ ddd444: '水深加倍时，静水压强也加倍。', eee555: '水深加倍时，静水压强也加倍。', [B]: TEXT[B] })
  expect((await list())[0]!.location.status).toBe('needs-confirmation')
  const pick = await h.call('annotation', 'confirm', { annotationId: note.id })
  expect(pick.error).toMatchObject({ code: 'learning/annotation/pick-block' })
  const confirmed = await h.endpoint<Annotation>('annotation', 'confirm', { annotationId: note.id, blockId: 'eee555' })
  expect(confirmed.location).toMatchObject({ status: 'anchored', blockId: 'eee555', confirmedAt: expect.any(String) })
  expect((await list({ blockId: 'eee555' }))).toHaveLength(1)
})

it('an error report with a certain place becomes one proposal for that file', async () => {
  const report = await create({ type: 'error', text: '这里应该是质量流量，不是体积流量', anchor: anchor(C, '质量流量不变', '流速不变，', '。'), requestId: 'err-1' })
  expect(report.proposalId).toBeTruthy()
  const proposals = h.ctx.learnCore.proposals.list({ courseId })
  expect(proposals).toHaveLength(1)
  expect(proposals[0]).toMatchObject({ id: report.proposalId, source: 'annotation', status: 'open', targets: [{ kind: 'file', courseId, path: FILE }] })
  expect(proposals[0]!.rationale).toContain('质量流量')
  // Asking again (a retry, a second click, the same request) does not make a second one.
  const again = await h.endpoint<Proposal>('annotation', 'submitError', { annotationId: report.id })
  expect(again.id).toBe(report.proposalId)
  await create({ type: 'error', text: '这里应该是质量流量，不是体积流量', anchor: anchor(C, '质量流量不变', '流速不变，', '。'), requestId: 'err-1' })
  expect(h.ctx.learnCore.proposals.list({ courseId })).toHaveLength(1)
  // The teacher hears about it.
  await h.settle()
  expect(h.delivered.some(item => item.text.includes('报了一处错误'))).toBe(true)
})

it('an error report whose place is unsure waits: no guessed target, then one proposal after the learner confirms', async () => {
  const report = await create({ type: 'error', text: '这句不对', anchor: anchor(B, '压强相同') })
  expect(report.location.status).toBe('needs-confirmation')
  expect(report.proposalId).toBeUndefined()
  expect(h.ctx.learnCore.proposals.list({ courseId })).toHaveLength(0)
  expect((await h.call('annotation', 'submitError', { annotationId: report.id })).error?.code).toBe('learning/annotation/place-unsure')
  const confirmed = await h.endpoint<Annotation>('annotation', 'confirm', { annotationId: report.id, blockId: B })
  expect(confirmed).toMatchObject({ proposalId: expect.any(String), location: { status: 'anchored', confirmedAt: expect.any(String) } })
  expect(h.ctx.learnCore.proposals.list({ courseId })).toHaveLength(1)
  // Only error reports become proposals.
  const question = await create({ type: 'highlight', anchor: anchor(A, '水深') })
  expect((await h.call('annotation', 'submitError', { annotationId: question.id })).error?.code).toBe('learning/annotation/not-error')
})

it('a question goes to one side chat that carries the quote and the note; asking again goes back to it', async () => {
  const question = await create({ type: 'question', text: '为什么可以忽略高差？', anchor: anchor(A, '这里可以忽略高差', '。', '') })
  const [first, second] = await Promise.all([
    h.endpoint<{ sessionId: string; reused: boolean; question: string }>('annotation', 'ask', { annotationId: question.id }),
    h.endpoint<{ sessionId: string; reused: boolean; question: string }>('annotation', 'ask', { annotationId: question.id }),
  ])
  expect(second.sessionId).toBe(first.sessionId)
  expect(first.question).toBe('为什么可以忽略高差？')
  expect(h.ctx.learnCore.sessions.list({ courseId, role: 'side-chat' })).toHaveLength(1)
  expect((await list())[0]).toMatchObject({ sideChatSessionId: first.sessionId })
  expect(await h.endpoint('annotation', 'ask', { annotationId: question.id })).toMatchObject({ sessionId: first.sessionId, reused: true })
  // What the side chat is told: the learner's own words, the sentence, the paragraph.
  const context = await describe(first.sessionId)
  expect(context).toContain('为什么可以忽略高差？')
  expect(context).toContain('「这里可以忽略高差」')
  expect(context).toContain(TEXT[A].slice(0, 8))
  // Once that chat is closed, asking opens a new one.
  h.ctx.learnCore.sessions.close(first.sessionId)
  const next = await h.endpoint<{ sessionId: string; reused: boolean }>('annotation', 'ask', { annotationId: question.id })
  expect(next.sessionId).not.toBe(first.sessionId)
  expect(next.reused).toBe(false)
})

it('tells the side chat when the sentence has moved on', async () => {
  const question = await create({ type: 'question', text: '这句话对吗？', anchor: anchor(A, '静水压强也加倍', '水深加倍时，', '。') })
  await write({ [A]: '水深加倍时，静水压强也不加倍。', [B]: TEXT[B] })
  await list()
  const { sessionId } = await h.endpoint<{ sessionId: string }>('annotation', 'ask', { annotationId: question.id })
  const context = await describe(sessionId)
  expect(context).toContain('位置不确定')
  expect(context).toContain('静水压强也加倍')
})

it('notes on a source chunk need the source to be in the course, and keep their place', async () => {
  const source = await h.endpoint('library', 'import', {
    title: '合成验收资料', kind: 'textbook', authority: '1',
    file: join(FIXTURES, 'synthetic-chapter', 'source.md'), parsed: [join(FIXTURES, 'synthetic-chapter', 'middle.json')], courseId, role: 'skeleton',
  })
  const chunk = h.ctx.learnLibrary.section(source.id, '1.1').find(item => item.kind === 'text')!
  const exact = chunk.text.replace(/\s+/g, ' ').trim().slice(0, 6)
  const note = await create({ type: 'highlight', anchor: { kind: 'chunk', chunkId: chunk.id, quote: { exact, prefix: '', suffix: '' } } })
  expect(note.anchor).toMatchObject({ kind: 'chunk', courseId })
  expect(note.location.status).toBe('anchored')
  const other = (await h.endpoint('core', 'createCourse', { title: '另一门课（合成）' })).id
  const refused = await h.call('annotation', 'create', { courseId: other, type: 'highlight', anchor: { kind: 'chunk', chunkId: chunk.id } })
  expect(refused.error?.code).toBe('learning/annotation/wrong-course')
  // An error in a source is not a textbook proposal.
  const error = await create({ type: 'error', text: '这里印错了', anchor: { kind: 'chunk', chunkId: chunk.id, quote: { exact, prefix: '', suffix: '' } } })
  expect(error.proposalId).toBeUndefined()
  expect((await h.call('annotation', 'submitError', { annotationId: error.id })).error?.code).toBe('learning/annotation/no-target')
})

it('survives a restart: the notes are in the database, the place is derived again', async () => {
  const note = await create({ type: 'highlight', anchor: anchor(A, '静水压强也加倍') })
  const root = h.root
  h.dispose(true)
  h = createHarness(() => '', {}, { root })
  await h.settle()
  const [again] = await list()
  expect(again).toMatchObject({ id: note.id, location: { status: 'anchored', blockId: A } })
})
