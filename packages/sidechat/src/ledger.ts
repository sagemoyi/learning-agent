// sidechat unit: the record of a side chat (docs/sidechat/design.md, B). After each reply, what was said since the last
// record is sorted by a one-shot model (the 侧边会话总结 role) into the learner's questions, what was concluded, the
// help given and possible misconceptions. The program keeps only what it can check (knowledge points and problems
// from the lists it gave, the learner's words found in the learner's messages, replies that exist), logs the help
// and signals at once, dated by their messages, and stores the sorted stretch: closing the chat builds its summary
// from the stretches and only sorts what is still new.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { HelpLevel, TEST_KIND_LABEL, type HelpLevel as Level, type Migration, type NewLogEntry, type Selection } from '@learning-agent/contracts'
import { complete, parseJsonReply, sessionLines, type SessionLine } from '@learning-agent/kit'
import { z } from 'zod'

export const ledgerMigration: Migration = {
  version: 2,
  sql: `
    CREATE TABLE sidechat_stretches (
      session_id TEXT NOT NULL,
      from_seq INTEGER NOT NULL,
      up_to INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (session_id, up_to)
    );
  `,
}

/** The message that carries the selection's context (sidechat's own pre-step message). */
export const CONTEXT_SOURCE = 'learning-side-chat-context'

const MAX_NODES = 60
const MAX_PROBLEMS = 20
/** Lines of talk sorted per model call. */
const WINDOW = 12
/** A stretch that fails this many times in a row is skipped, so one bad stretch cannot stop the record or the closing. */
const MAX_FAILURES = 3
const MAX_LINE_CHARS = 1500
/** A stretch with no learner words and only short replies has nothing to record. */
const SHORT_REPLY = 30

export const RECORD_SYSTEM = `你整理侧边答疑的一段对话，记下事实，供课程笔记和学习分析使用。只根据对话判断，不推测，不补充。
对话里每条消息前有编号，如 【3 学习者】、【4 助手】。只输出一个 JSON 对象：
{"questions":[{"quote":"…","text":"…","nodes":["N1"]}],"conclusions":[{"text":"…","from":4}],"help":[{"reply":4,"level":"hint","nodes":["N1"],"problem":"P1"}],"misconceptions":[{"quote":"…","text":"…","nodes":["N1"]}]}

questions：学习者就学习内容提的问题，不含怎么操作页面的问题。text 用一句话写问了什么，quote 逐字摘自那条学习者消息。
conclusions：这段对话在学习内容上讲清楚了什么（每条一句，写给学习者看，不写"学习者""助手"这类称呼）。只说明怎么操作、为什么现在不能讨论的不算。from 填结论出自哪条消息的编号。
help：助手的哪条回复在学习内容上帮了学习者，reply 填那条助手消息的编号。level 取这条回复给到的最高一档：
- hint：只点出方向、条件或该检查哪里，下一步留给学习者；
- explanation：讲解概念、公式、单位或适用条件；
- worked-solution：把一道题的解法完整做出来；
- answer-revealed：直接给出一道题的答案或结果。
只说明怎么操作、打招呼、表扬鼓励的回复不算帮助。帮助针对下面列出的某道题时，problem 填它的编号，否则不填。
misconceptions：学习者自己的说法里表现出的可能误解，text 用一句话写误解是什么，quote 逐字摘自学习者的话。学习者在引用别人的说法、提问、假设，或已经自己改正了的，都不算。
nodes 只填下面列出的知识点编号，对不上就给空数组。哪一类都没有就给空数组。`

const Ref = z.array(z.string()).default([])
const Reply = z.object({
  questions: z.array(z.object({ quote: z.string().default(''), text: z.string().default(''), nodes: Ref })).default([]),
  conclusions: z.array(z.object({ text: z.string(), from: z.number().int().nullish() })).default([]),
  help: z.array(z.object({ reply: z.number().int(), level: HelpLevel, nodes: Ref, problem: z.string().nullish() })).default([]),
  misconceptions: z.array(z.object({ quote: z.string().default(''), text: z.string(), nodes: Ref })).default([]),
})

/** One sorted stretch of a side chat, kept for its summary. Seqs are the session's own message numbers. */
export const Stretch = z.object({
  from: z.number().int(),
  upTo: z.number().int(),
  questions: z.array(z.object({ text: z.string(), quote: z.string(), seq: z.number().int(), nodeIds: z.array(z.string()) })).default([]),
  conclusions: z.array(z.object({ text: z.string(), seq: z.number().int(), by: z.enum(['learner', 'assistant']) })).default([]),
  help: z.array(z.object({ seq: z.number().int(), level: HelpLevel, nodeIds: z.array(z.string()), problemId: z.string().optional() })).default([]),
  /** `seq`, when the learner's words were found; a misconception without them is kept for the note, never logged. */
  misconceptions: z.array(z.object({ text: z.string(), quote: z.string(), seq: z.number().int().optional(), nodeIds: z.array(z.string()) })).default([]),
  /** Could not be sorted after repeated failures. */
  skipped: z.boolean().optional(),
})
export type Stretch = z.infer<typeof Stretch>

/** Spaces and punctuation do not count when a quote is matched against what the learner wrote. */
const bare = (text: string) => text.replace(/[\s，。！？、；：,.!?;:“”"'‘’（）()「」『』…—\-~～]/g, '')

interface Problem { readonly id: string; readonly nodeIds: readonly string[]; readonly testId: string; readonly open: boolean; readonly lessonId?: string; readonly line: string }

export interface Ledger {
  /** Sort what is new; with `final`, wait for one already running and include every line (the closing's cut). */
  record(sessionId: string, options?: { readonly final?: boolean; readonly signal?: AbortSignal }): Promise<void>
  stretches(sessionId: string): Stretch[]
}

export function installLedger(ctx: Context, deps: { model(): string | undefined }): Ledger {
  const sqlite = ctx.learnCore.db.sqlite
  const logger = ctx.logger('learning-sidechat')
  const chains = new Map<string, Promise<void>>()
  const failures = new Map<string, number>()

  const mark = (sessionId: string): number =>
    (sqlite.prepare('SELECT MAX(up_to) AS seq FROM sidechat_stretches WHERE session_id = ?').get(sessionId) as { seq: number | null }).seq ?? -1

  function stretches(sessionId: string): Stretch[] {
    const rows = sqlite.prepare('SELECT data FROM sidechat_stretches WHERE session_id = ? ORDER BY up_to').all(sessionId) as { data: string }[]
    return rows.map(row => Stretch.parse(JSON.parse(row.data)))
  }

  function store(sessionId: string, stretch: Stretch, entries: readonly NewLogEntry[] = []): void {
    ctx.learnCore.db.transaction(() => {
      for (const entry of entries) ctx.learnCore.log.append(entry)
      sqlite.prepare('INSERT INTO sidechat_stretches (session_id, from_seq, up_to, data) VALUES (?, ?, ?, ?)').run(sessionId, stretch.from, stretch.upTo, JSON.stringify(stretch))
    })
  }

  /** Knowledge points the selection is about: they head the list the model picks from. */
  async function selectionNodes(courseId: string, selection: Selection | undefined): Promise<string[]> {
    const selected = selection?.selected
    if (!selected?.id) return []
    try {
      if (selected.kind === 'node') return [selected.id]
      if (selected.kind === 'block') return [...(await ctx.get('learnTextbook')?.block(courseId, selected.id))?.nodeIds ?? []]
      if (selected.kind === 'problem') return [...ctx.get('learnAssess')?.problem(selected.id)?.nodeIds ?? []]
      if (selected.kind === 'stage') return [...ctx.get('learnCurriculum')?.stage(selected.id)?.nodeIds ?? []]
      if (selected.kind === 'text' && selection?.page === 'annotation') {
        const anchor = ctx.get('learnAnnotation')?.get(selected.id)?.anchor
        if (anchor?.kind === 'block') return [...(await ctx.get('learnTextbook')?.block(courseId, anchor.blockId))?.nodeIds ?? []]
      }
    } catch (error) {
      logger.warn('side chat record could not read the selection: %s', (error as Error).message)
    }
    return []
  }

  /** The lesson being taught now, for its knowledge points and the help's context. */
  function lessonNow(courseId: string): { lessonId?: string; nodeIds: readonly string[] } {
    const curriculum = ctx.get('learnCurriculum')
    const stage = curriculum?.currentStage(courseId)
    if (!curriculum || !stage) return { nodeIds: [] }
    const lesson = curriculum.lessons(stage.id).find(item => item.status !== 'done')
    return { ...(lesson ? { lessonId: lesson.id } : {}), nodeIds: stage.nodeIds }
  }

  /** Problems the talk may be about: the selected one, open tests, and the last two graded. */
  function problemsOf(courseId: string, selection: Selection | undefined): Problem[] {
    const assess = ctx.get('learnAssess')
    if (!assess) return []
    const tests = assess.tests(courseId)
    const chosen = [...tests.filter(test => test.status === 'open'), ...tests.filter(test => test.status === 'graded').slice(-2)]
    const picked = selection?.selected?.kind === 'problem' ? selection.selected.id : undefined
    const list = chosen.flatMap(test => test.problemIds.flatMap((id, index) => {
      const problem = assess.problem(id)
      if (!problem) return []
      const stem = problem.stem.replace(/\s+/g, ' ').slice(0, 120)
      return [{ id, nodeIds: problem.nodeIds, testId: test.id, open: test.status === 'open' && test.kind !== 'practice', ...(test.lessonId ? { lessonId: test.lessonId } : {}), line: `${TEST_KIND_LABEL[test.kind]} 第 ${index + 1} 题${problem.ref ? `（习题 ${problem.ref}）` : ''}${test.status === 'open' ? '（未交卷）' : ''}：${stem}` }]
    }))
    return [...list.filter(item => item.id === picked), ...list.filter(item => item.id !== picked)].slice(0, MAX_PROBLEMS)
  }

  async function sortStretch(sessionId: string, courseId: string, talk: readonly SessionLine[], upTo: number, signal?: AbortSignal): Promise<void> {
    const from = talk[0]?.seq ?? upTo
    const learner = talk.filter(line => line.who === 'learner')
    const replies = talk.filter(line => line.who === 'assistant' && line.text.trim())
    if (learner.length === 0 && replies.every(line => line.text.trim().length < SHORT_REPLY)) return store(sessionId, Stretch.parse({ from, upTo }))

    const link = ctx.learnCore.sessions.get(sessionId)
    const place = lessonNow(courseId)
    const problems = problemsOf(courseId, link?.openedFrom)
    const first = [...await selectionNodes(courseId, link?.openedFrom), ...problems.flatMap(problem => problem.nodeIds), ...place.nodeIds]
    const graph = ctx.learnKnowledge.graph(courseId).nodes
    const rank = (id: string) => { const at = first.indexOf(id); return at < 0 ? first.length : at }
    const nodes = [...graph].sort((a, b) => rank(a.id) - rank(b.id)).slice(0, MAX_NODES)
    const label = (line: SessionLine, index: number) => `${index + 1} ${line.who === 'learner' ? '学习者' : line.who === 'assistant' ? '助手' : '上下文'}`
    const prompt = [
      `学习者从「${link?.openedFrom?.selected?.label || '整门课'}」打开了这次提问。`,
      `# 知识点\n${nodes.map((node, index) => `[N${index + 1}] ${node.title}`).join('\n') || '（没有）'}`,
      `# 题目\n${problems.map((problem, index) => `[P${index + 1}] ${problem.line}`).join('\n') || '（没有）'}`,
      `# 对话\n${talk.map((line, index) => `【${label(line, index)}】${line.text.trim().slice(0, MAX_LINE_CHARS)}`).join('\n\n')}`,
    ].join('\n\n')
    let reply: z.infer<typeof Reply>
    try {
      // DeepSeek's output cap includes its thinking as well as the JSON.
      const text = await complete(ctx, { system: RECORD_SYSTEM, prompt, purpose: 'learning-sidechat-summary', model: deps.model(), maxTokens: 8000, ...(signal ? { signal } : {}) })
      reply = Reply.parse(parseJsonReply(text))
    } catch (error) {
      const key = `${sessionId}:${from}`
      const failed = (failures.get(key) ?? 0) + 1
      if (failed < MAX_FAILURES) {
        failures.set(key, failed)
        throw error
      }
      failures.delete(key)
      logger.warn('side chat record skipped a stretch after %d failures: %s', failed, (error as Error).stack ?? error)
      return store(sessionId, Stretch.parse({ from, upTo, skipped: true }))
    }

    const nodeOf = (refs: readonly string[]) => [...new Set(refs.flatMap(ref => {
      const node = nodes[Number(/^N(\d+)$/i.exec(ref.trim())?.[1]) - 1]
      return node ? [node.id as string] : []
    }))]
    const problemOf = (ref: string | null | undefined) => (ref ? problems[Number(/^P(\d+)$/i.exec(ref.trim())?.[1]) - 1] : undefined)
    const message = (n: number | null | undefined) => (n ? talk[n - 1] : undefined)
    /** The learner's message a quote comes from, word for word. */
    const source = (quote: string) => (bare(quote).length >= 2 ? learner.find(line => bare(line.text).includes(bare(quote))) : undefined)
    const at = (line: SessionLine) => new Date(line.at).toISOString()

    const stretch: Stretch = {
      from,
      upTo,
      questions: reply.questions.flatMap(item => {
        const line = source(item.quote)
        const text = item.text.trim() || item.quote.trim()
        return line && text ? [{ text, quote: item.quote.trim(), seq: line.seq, nodeIds: nodeOf(item.nodes) }] : []
      }),
      conclusions: reply.conclusions.flatMap(item => {
        const line = message(item.from)
        return line && line.who !== 'context' && item.text.trim() ? [{ text: item.text.trim(), seq: line.seq, by: line.who }] : []
      }),
      help: reply.help.flatMap(item => {
        const line = message(item.reply)
        const problem = problemOf(item.problem)
        const nodeIds = [...new Set([...nodeOf(item.nodes), ...(problem?.nodeIds ?? [])])]
        return line?.who === 'assistant' && nodeIds.length ? [{ seq: line.seq, level: item.level as Level, nodeIds, ...(problem ? { problemId: problem.id } : {}) }] : []
      }),
      misconceptions: reply.misconceptions.flatMap(item => {
        if (!item.text.trim()) return []
        const line = source(item.quote)
        return [{ text: item.text.trim(), quote: item.quote.trim(), ...(line ? { seq: line.seq } : {}), nodeIds: nodeOf(item.nodes) }]
      }),
    }

    // Evidence, dated by the messages. A knowledge point gets one question signal per chat, however often it is asked
    // about in it: asking several times in one sitting is one episode of doubt.
    const base = { courseId: courseId as never, context: { sessionId: sessionId as never } }
    const lineOf = (seq: number) => talk.find(line => line.seq === seq)!
    const asked = new Set(stretches(sessionId).flatMap(item => item.questions.flatMap(question => question.nodeIds)))
    const entries: NewLogEntry[] = []
    for (const question of stretch.questions) {
      const fresh = question.nodeIds.filter(id => !asked.has(id))
      if (fresh.length === 0) continue
      for (const id of fresh) asked.add(id)
      entries.push({ ...base, type: 'signal.question', at: at(lineOf(question.seq)), nodeIds: fresh as never, text: question.quote || question.text })
    }
    for (const item of stretch.misconceptions) {
      if (item.seq === undefined || item.nodeIds.length === 0) continue
      entries.push({ ...base, type: 'signal.misconception', at: at(lineOf(item.seq)), nodeIds: item.nodeIds as never, text: `${item.text}（原话："${item.quote}"）` })
    }
    for (const item of stretch.help) {
      const problem = problems.find(entry => entry.id === item.problemId)
      // Help on what an open test asks counts against that test, named problem or not.
      const testId = problem?.testId ?? problems.find(entry => entry.open && entry.nodeIds.some(id => item.nodeIds.includes(id)))?.testId
      const lessonId = problem?.lessonId ?? place.lessonId
      entries.push({
        ...base,
        type: 'help.given',
        at: at(lineOf(item.seq)),
        nodeIds: item.nodeIds as never,
        level: item.level,
        via: 'side-chat',
        ...(item.problemId ? { problemId: item.problemId as never } : {}),
        context: { ...base.context, ...(lessonId ? { lessonId: lessonId as never } : {}), ...(testId ? { testId: testId as never } : {}) },
      })
    }
    store(sessionId, stretch, entries)
  }

  /** The chat as the record reads it: the learner, the assistant and the selection's context; other context is left out. */
  async function talkOf(sessionId: string, signal?: AbortSignal): Promise<SessionLine[]> {
    return (await sessionLines(ctx, sessionId, signal)).filter(line => line.who !== 'context' || line.source === CONTEXT_SOURCE)
  }

  async function catchUp(sessionId: string, signal?: AbortSignal): Promise<void> {
    const courseId = ctx.learnCore.sessions.get(sessionId)?.courseId
    if (!courseId) return
    const done = mark(sessionId)
    const fresh = (await talkOf(sessionId, signal)).filter(line => line.seq > done)
    for (let start = 0; start < fresh.length; start += WINDOW) {
      const window = fresh.slice(start, start + WINDOW)
      await sortStretch(sessionId, courseId, window, window.at(-1)!.seq, signal)
    }
  }

  return {
    stretches,
    record(sessionId, options = {}) {
      // One session at a time: a turn's record and the closing's catch-up never sort the same lines twice.
      const previous = chains.get(sessionId) ?? Promise.resolve()
      const run = previous.catch(() => undefined).then(() => catchUp(sessionId, options.signal))
      const kept = run.catch(error => { if (!options.final) logger.warn('side chat record failed: %s', (error as Error).stack ?? error) })
      chains.set(sessionId, kept)
      void kept.finally(() => { if (chains.get(sessionId) === kept) chains.delete(sessionId) })
      return options.final ? run : kept
    },
  }
}
