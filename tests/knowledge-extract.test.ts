// Knowledge C, section extraction with a fake model: what a reply may add, what is skipped and why,
// failed replies writing nothing, one job per unchanged section, cancel, retry and restart. Synthetic data.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId, type ExtractionOverview, type ExtractionStart, type Handoff, type KnowledgeExtraction } from '@learning-agent/contracts'
import { checkDraft, sectionKey } from '../packages/knowledge/src/extract.ts'
import { FIXTURES, createHarness, type Harness, type ModelCall } from './harness.ts'

let h: Harness
let reply: (call: ModelCall) => string | { readonly finish: 'max-tokens' }
const teacher = { actor: 'teacher' as const, reason: '合成抽取验收' }
beforeEach(() => {
  reply = () => { throw new Error('no reply set') }
  h = createHarness(call => reply(call))
})
afterEach(async () => { await h.settle(); h.dispose() })

async function setup() {
  const course = await h.ctx.learnCore.courses.create({ title: '流体抽取课' })
  const fixture = join(FIXTURES, 'retrieval-chapter')
  const source = await h.ctx.learnLibrary.importParsed({ title: '检索合成资料', kind: 'textbook', authority: '1', file: join(fixture, 'source.md'), parsed: [join(fixture, 'middle.json')], courseId: course.id })
  await h.ctx.learnKnowledge.add(course.id, { nodes: [{ title: '密度', kind: 'knowledge', aliases: ['ρ'] }] }, teacher)
  const chunks = h.ctx.learnLibrary.section(source.id, '1.1').filter(chunk => chunk.kind !== 'heading')
  return { course, source, chunks }
}

/** The job once it has ended: at once when it already has, otherwise at its next terminal event. */
function settled(id: string): Promise<KnowledgeExtraction> {
  const now = (h.ctx.learnKnowledge as unknown as { sections: { get(id: string): KnowledgeExtraction | undefined } }).sections.get(id)
  if (now && ['done', 'failed', 'canceled'].includes(now.status)) return Promise.resolve(now)
  return new Promise(done => {
    const off = h.ctx.on('learning/extraction-changed', job => {
      if (job.id === id && ['done', 'failed', 'canceled'].includes(job.status)) { off(); done(job) }
    })
  })
}

async function run(courseId: string, section: string): Promise<KnowledgeExtraction> {
  const [start] = await h.endpoint<ExtractionStart[]>('knowledge', 'extract', { courseId, sections: [section] })
  expect(start!.outcome).toBe('started')
  return settled(start!.job!.id)
}

describe('section extraction', () => {
  it('adds checked nodes and draft relations as one group, reuses course nodes, skips the rest with reasons, and hands back once', async () => {
    const { course, chunks } = await setup(), k = h.ctx.learnKnowledge
    const [c1, c2] = chunks.map(chunk => chunk.id)
    reply = call => {
      expect(call.purpose).toBe('learning-knowledge-extract')
      return JSON.stringify({
        nodes: [
          { title: 'ρ', kind: 'knowledge', sources: [c1] },
          { title: '黏度', kind: 'knowledge', description: '流体内摩擦的量度', aliases: ['动力黏度'], sources: [c1, c2, 'ck_01ZZZZZZZZZZZZZZZZZZZZZZZZ'] },
          { title: '不可压缩流体', kind: 'knowledge', sources: [c2] },
          { title: '没有出处', kind: 'knowledge', sources: ['ck_01ZZZZZZZZZZZZZZZZZZZZZZZZ'] },
          { title: '动力黏度', kind: 'knowledge', sources: [c1] },
          { title: '密度', kind: 'skill', sources: [c1] },
          { title: '类型错', kind: 'concept', sources: [c1] },
        ],
        edges: [
          { from: '不可压缩流体', to: '密度', type: 'requires', rationale: '原文直接陈述：按密度不随压力变化来理解', sources: [c2] },
          { from: '黏度', to: '密度', type: 'related', rationale: '教学推断：都是流体物性', sources: [] },
          { from: '密度', to: '黏度', type: 'related', rationale: '重复的反向相关' },
          { from: '黏度', to: '不存在', type: 'related', rationale: 'x' },
          { from: '黏度', to: '黏度', type: 'related', rationale: 'x' },
          { from: '黏度', to: '不可压缩流体', type: 'part-of' },
        ],
      })
    }
    const handoffs: Handoff[] = []
    h.ctx.on('learning/handoff', handoff => { handoffs.push(handoff) })
    const job = await run(course.id, '1.1')
    expect(job).toMatchObject({ status: 'done', result: { nodes: 2, reused: 1, edges: 2 } })
    expect(job.result!.skipped).toHaveLength(8)
    expect(job.result!.skipped.join('\n')).toMatch(/没有引用本小节的原文[\s\S]*重复[\s\S]*类型是知识，不同/)
    const graph = k.graph(course.id)
    expect(graph.nodes.map(node => node.title)).toEqual(['密度', '黏度', '不可压缩流体'])
    expect(graph.edges.every(edge => edge.status === 'draft' && edge.scope.kind === 'course')).toBe(true)
    expect(k.links(k.resolve(course.id, '密度')!.id).map(link => link.target)).toEqual([{ kind: 'chunk', id: c1 }])
    expect(k.links(k.resolve(course.id, '黏度')!.id).map(link => link.target)).toEqual([{ kind: 'chunk', id: c1 }, { kind: 'chunk', id: c2 }])
    expect(k.history(course.id)[0]).toMatchObject({ id: job.operationId, actor: 'system' })
    const prompt = h.calls[0]!.prompt
    expect(prompt).toContain(`[${c1}]`)
    expect(prompt).toContain('- 密度（knowledge）')
    expect(prompt).not.toContain('判断流型')
    expect(handoffs).toEqual([expect.objectContaining({ courseId: course.id, unit: 'knowledge', text: expect.stringContaining('新增 2 个节点、2 条草案关系') })])

    // The same unchanged section is not drafted twice.
    const [again] = await h.endpoint<ExtractionStart[]>('knowledge', 'extract', { courseId: course.id, sections: ['1.1 流体的密度与黏度'] })
    expect(again).toMatchObject({ section: '1.1', outcome: 'done' })
    expect(h.calls).toHaveLength(1)
    const overview = await h.endpoint<ExtractionOverview>('knowledge', 'extractions', { courseId: course.id })
    expect(overview.sections.find(section => section.section === '1.1')).toMatchObject({ heading: '1.1 流体的密度与黏度', depth: 2, job: { status: 'done' } })
    expect(overview.sections.find(section => section.section === '1.1')?.stale).toBeUndefined()
  })

  it('writes nothing when the reply is cut off, empty, not JSON or has nothing usable, and a retry can still succeed', async () => {
    const { course, chunks } = await setup(), k = h.ctx.learnKnowledge
    const nodes = k.graph(course.id).nodes.length, history = k.history(course.id).length
    const handoffs: Handoff[] = []
    h.ctx.on('learning/handoff', handoff => { handoffs.push(handoff) })
    for (const [answer, message] of [
      [{ finish: 'max-tokens' } as const, /长度上限/],
      ['', /没有返回正文/],
      ['这一节讲了密度。', /不是 JSON/],
      [JSON.stringify({ nodes: [{ title: '黏度', kind: 'knowledge', sources: [] }], edges: [] }), /没有一项通过检查：「黏度」没有引用本小节的原文/],
    ] as const) {
      reply = () => answer
      const job = await run(course.id, '1.1')
      expect(job.status).toBe('failed')
      expect(job.message).toMatch(message)
      expect(k.graph(course.id).nodes).toHaveLength(nodes)
      expect(k.history(course.id)).toHaveLength(history)
    }
    expect(handoffs).toHaveLength(4)
    expect(handoffs[0]!.text).toMatch(/没有完成.*可以稍后重试/)
    reply = () => JSON.stringify({ nodes: [{ title: '黏度', kind: 'knowledge', sources: [chunks[0]!.id] }] })
    expect(await run(course.id, '1.1')).toMatchObject({ status: 'done', result: { nodes: 1 } })
  })

  it('runs two sections at a time, cancels a queued one, and picks up interrupted jobs after a restart', async () => {
    const { course, source, chunks } = await setup(), k = h.ctx.learnKnowledge
    reply = call => JSON.stringify({ nodes: [{ title: `节点${h.calls.indexOf(call)}`, kind: 'knowledge', sources: [/\[(ck_[0-9A-Z]{26})\]/.exec(call.prompt)![1]] }] })
    // Service calls without awaiting in between, so the third is still waiting when it is canceled.
    const starts = k.extract(course.id, ['1.2', '1.3', '1.4'], 'learner')
    expect(starts.map(start => start.outcome)).toEqual(['started', 'started', 'started'])
    expect(starts.map(start => k.extractions(course.id).sections.find(section => section.section === start.section)?.job?.status)).toEqual(['running', 'running', 'queued'])
    expect(k.cancelExtraction(starts[2]!.job!.id).status).toBe('canceled')
    await Promise.all(starts.slice(0, 2).map(start => settled(start.job!.id)))
    await h.settle()
    expect(h.calls).toHaveLength(2)
    expect(k.extractions(course.id).sections.find(section => section.section === '1.4')?.job?.status).toBe('canceled')

    // A restart finds one job that had already written its group and one that never ran.
    const sqlite = h.ctx.learnCore.db.sqlite
    const done = k.extractions(course.id).sections.find(section => section.section === '1.2')!.job!
    sqlite.prepare("UPDATE knowledge_extractions SET status = 'running', data = json_set(data, '$.status', 'running') WHERE id = ?").run(done.id)
    const queued = { ...done, id: newId('extraction'), section: '1.5', heading: '1.5 流动型态与雷诺数', status: 'queued', message: '排队中', result: undefined, operationId: undefined }
    sqlite.prepare('INSERT INTO knowledge_extractions VALUES (?, ?, ?, ?, ?, ?)').run(queued.id, course.id, source.id, '1.5', 'queued', JSON.stringify(queued))
    const calls = h.calls.length
    ;(k as unknown as { sections: { resume(): void } }).sections.resume()
    expect(await settled(done.id)).toMatchObject({ status: 'done', message: '已加入本课', operationId: done.operationId })
    expect(await settled(queued.id)).toMatchObject({ status: 'done', result: { nodes: 1 } })
    expect(h.calls).toHaveLength(calls + 1)
    expect(chunks.length).toBeGreaterThan(0)
  })
})

describe('draft checks', () => {
  const known = [{ id: 'kn_A', title: '雷诺数', aliases: ['Re'], kind: 'knowledge' as const }]
  it('treats a bracket note or alias as the same course node, and keeps every relation a draft', () => {
    const draft = checkDraft({
      nodes: [{ title: '雷诺数（Re）', kind: 'knowledge', sources: ['c1'] }, { title: '流型', kind: 'knowledge', sources: ['c1'] }],
      edges: [{ from: '流型', to: 'Re', type: 'requires', rationale: '原文直接陈述', status: 'valid' }],
    }, ['c1'], known, [])
    expect(draft.nodes).toEqual([{ title: '雷诺数', kind: 'knowledge', reuseId: 'kn_A', sources: ['c1'] }, expect.objectContaining({ title: '流型' })])
    expect(draft.edges).toEqual([{ from: '流型', to: 'kn_A', type: 'requires', rationale: '原文直接陈述', sources: [], status: 'draft' }])
    expect(draft.reused).toBe(1)
  })
  it('skips relations the course already has and refuses a reply without a node list', () => {
    expect(checkDraft({ nodes: [], edges: [{ from: 'Re', to: '雷诺数', type: 'related', rationale: 'x' }] }, [], known, []).skipped).toEqual(['「Re」和「雷诺数」的关系连向了自己'])
    expect(checkDraft({ nodes: [{ title: '流型', kind: 'knowledge', sources: ['c1'] }], edges: [{ from: '雷诺数', to: '流型', type: 'related', rationale: 'x' }] }, ['c1'], [...known, { id: 'kn_B', title: '流型', aliases: [], kind: 'knowledge' }], [{ from: 'kn_B', to: 'kn_A', type: 'related' }]).skipped)
      .toEqual(['「雷诺数」和「流型」的关系已经有了'])
    expect(() => checkDraft([], [], known, [])).toThrow(/节点列表/)
    expect(sectionKey('1.3 管内流动阻力')).toBe('1.3')
    expect(sectionKey('绪论')).toBe('绪论')
  })
})
