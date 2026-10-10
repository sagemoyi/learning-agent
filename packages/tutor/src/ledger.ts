// tutor unit: the classroom record (docs/tutor/design.md, B). After each teacher turn, what was said
// since the last record is read back from the session and sorted by a one-shot model into the help
// the teacher gave and what the learner said about their own knowledge: claims, questions and
// possible misconceptions. The program keeps only what it can check: knowledge points and problems
// from the lists it gave, quotes found word for word in the learner's messages. Help is dated by the
// reply that gave it, so an answer submitted right after still counts as helped.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { HelpLevel, TEST_KIND_LABEL, type Migration, type NewLogEntry, type Stage } from '@learning-agent/contracts'
import { complete, parseJsonReply, sessionLines, type SessionLine } from '@learning-agent/kit'
import { z } from 'zod'

export const ledgerMigration: Migration = {
  version: 2,
  sql: `
    CREATE TABLE tutor_ledger (
      session_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL
    );
  `,
}

const STAGED: readonly Stage['status'][] = ['ready', 'learning', 'testing', 'reviewing']
const MAX_NODES = 60
const MAX_PROBLEMS = 20
/** Lines of talk sorted per model call. */
const WINDOW = 12
/** A session that began before the record existed: only its latest talk is recorded. */
const BACKLOG = 24
/** A stretch that fails this many times in a row is skipped, so one bad stretch cannot stop the record. */
const MAX_FAILURES = 3
const MAX_LINE_CHARS = 1500
/** A turn with no learner words and only short teacher lines (a notice acknowledged, a task given) has nothing to record. */
const SHORT_REPLY = 30

export const LEDGER_SYSTEM = `你整理一段主老师和学习者的对话，记下课堂事实，供学习分析使用。只根据对话判断，不推测，不补充。
只输出一个 JSON 对象：
{"help":[{"reply":1,"level":"hint","nodes":["N1"],"problem":"P1"}],"claims":[{"quote":"…","claim":"known","nodes":["N1"]}],"questions":[{"quote":"…","nodes":["N1"]}],"misconceptions":[{"quote":"…","text":"…","nodes":["N1"]}]}

help：老师的哪条回复在学习内容上帮了学习者，reply 填回复编号。level 取这条回复给到的最高一档：
- hint：只点出方向、条件或该检查哪里，下一步留给学习者；
- explanation：讲解概念、公式、单位或适用条件；
- worked-solution：把一道题的解法完整做出来；
- answer-revealed：直接给出一道题的答案或结果。
只说明怎么操作、布置任务、打招呼、复述判分结果、表扬鼓励的回复不算帮助。帮助针对下面列出的某道题时，problem 填它的编号，否则不填。
claims：学习者明确说自己会了（known）或不会（unknown）某个知识点。引用别人的话、假设、否定（如"我不是说我会了"）不算。
questions：学习者就学习内容提的问题，不含怎么操作页面的问题。
misconceptions：学习者自己的说法里表现出的可能误解，text 用一句话写误解是什么。学习者引用的错误说法、已经自己改正的、老师说的都不算。
quote 逐字摘自学习者的话，不改写。nodes 只填下面列出的知识点编号，对不上就给空数组。哪一类都没有就给空数组。`

const Ref = z.array(z.string()).default([])
const Reply = z.object({
  help: z.array(z.object({ reply: z.number().int(), level: HelpLevel, nodes: Ref, problem: z.string().nullish() })).default([]),
  claims: z.array(z.object({ quote: z.string(), claim: z.enum(['known', 'unknown']), nodes: Ref })).default([]),
  questions: z.array(z.object({ quote: z.string(), nodes: Ref })).default([]),
  misconceptions: z.array(z.object({ quote: z.string(), text: z.string(), nodes: Ref })).default([]),
})

/** Spaces and punctuation do not count when a quote is matched against what the learner wrote. */
export const bare = (text: string) => text.replace(/[\s，。！？、；：,.!?;:“”"'‘’（）()「」『』…—\-~～]/g, '')

interface Problem { readonly id: string; readonly nodeIds: readonly string[]; readonly testId: string; readonly open: boolean; readonly lessonId?: string; readonly line: string }

export interface LedgerDeps {
  /** The 课堂记录 model setting; absent follows the default model. */
  model(): string | undefined
}

export function installLedger(ctx: Context, deps: LedgerDeps): void {
  const sqlite = ctx.learnCore.db.sqlite
  const logger = ctx.logger('learning-tutor')
  const chains = new Map<string, Promise<void>>()
  const failures = new Map<string, number>()

  /** The lesson being taught now: the current stage's first lesson not done. */
  function where(courseId: string): { stageId?: string; lessonId?: string; lessonFile?: string; stageNodes: readonly string[] } {
    const stage = ctx.learnCurriculum.currentStage(courseId)
    if (!stage || !STAGED.includes(stage.status)) return { stageNodes: [] }
    const lesson = ctx.learnCurriculum.lessons(stage.id).find(item => item.status !== 'done')
    return { stageId: stage.id, stageNodes: stage.nodeIds, ...(lesson ? { lessonId: lesson.id, lessonFile: lesson.textbookFile } : {}) }
  }

  /** Problems the talk may be about: open tests, and the last two that were graded. */
  function problemsOf(courseId: string): Problem[] {
    const tests = ctx.learnAssess.tests(courseId)
    const chosen = [...tests.filter(test => test.status === 'open'), ...tests.filter(test => test.status === 'graded').slice(-2)]
    return chosen.flatMap(test => {
      const lesson = test.lessonId ? ctx.learnCurriculum.lesson(test.lessonId) : undefined
      const name = `${TEST_KIND_LABEL[test.kind]}${lesson ? ` · ${lesson.number}` : ''}`
      return test.problemIds.flatMap((id, index) => {
        const problem = ctx.learnAssess.problem(id)
        if (!problem) return []
        const stem = problem.stem.replace(/\s+/g, ' ').slice(0, 120)
        return [{ id, nodeIds: problem.nodeIds, testId: test.id, open: test.status === 'open' && test.kind !== 'practice', ...(test.lessonId ? { lessonId: test.lessonId } : {}), line: `${name} 第 ${index + 1} 题${problem.ref ? `（习题 ${problem.ref}）` : ''}${test.status === 'open' ? '（未交卷）' : ''}：${stem}` }]
      })
    }).slice(0, MAX_PROBLEMS)
  }

  /** What is new since the mark, a window at a time; the mark moves past each window recorded. */
  async function record(sessionId: string, courseId: string): Promise<void> {
    const mark = (sqlite.prepare('SELECT seq FROM tutor_ledger WHERE session_id = ?').get(sessionId) as { seq: number } | undefined)?.seq ?? -1
    const fresh = (await sessionLines(ctx, sessionId)).filter(line => line.seq > mark)
    if (fresh.length === 0) return
    const end = Math.max(...fresh.map(line => line.seq))
    // The conversation: the learner, the teacher, and progress notices for what happened on the pages.
    let talk = fresh.filter(line => line.who !== 'context' || line.source === 'learning-handoff')
    if (mark < 0) talk = talk.slice(-BACKLOG)
    if (talk.length === 0) return advance(sessionId, end)
    for (let start = 0; start < talk.length; start += WINDOW) {
      const window = talk.slice(start, start + WINDOW)
      await recordWindow(sessionId, courseId, window, start + WINDOW >= talk.length ? end : window.at(-1)!.seq)
    }
  }

  function advance(sessionId: string, seq: number): void {
    sqlite.prepare('INSERT INTO tutor_ledger (session_id, seq) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET seq = excluded.seq').run(sessionId, seq)
  }

  async function recordWindow(sessionId: string, courseId: string, talk: readonly SessionLine[], upTo: number): Promise<void> {
    const learner = talk.filter(line => line.who === 'learner')
    const replies = talk.filter(line => line.who === 'assistant' && line.text.trim())
    if (learner.length === 0 && replies.every(line => line.text.trim().length < SHORT_REPLY)) return advance(sessionId, upTo)

    const place = where(courseId)
    const problems = problemsOf(courseId)
    const lessonNodes = place.lessonFile ? ctx.learnTextbook.blocks(courseId, place.lessonFile).flatMap(block => block.nodeIds) : []
    const first = new Set<string>([...lessonNodes, ...place.stageNodes, ...problems.flatMap(problem => problem.nodeIds)])
    const graph = ctx.learnKnowledge.graph(courseId).nodes
    const nodes = [...graph.filter(node => first.has(node.id)), ...graph.filter(node => !first.has(node.id))].slice(0, MAX_NODES)
    const label = (line: SessionLine) => (line.who === 'learner' ? '学习者' : line.who === 'assistant' ? `老师 ${replies.indexOf(line) + 1}` : '系统通知')
    const prompt = [
      `# 知识点\n${nodes.map((node, index) => `[N${index + 1}] ${node.title}`).join('\n') || '（没有）'}`,
      `# 题目\n${problems.map((problem, index) => `[P${index + 1}] ${problem.line}`).join('\n') || '（没有）'}`,
      `# 对话\n${talk.map(line => `【${label(line)}】${line.text.trim().slice(0, MAX_LINE_CHARS)}`).join('\n\n')}`,
    ].join('\n\n')
    let reply: z.infer<typeof Reply>
    try {
      // DeepSeek's output cap includes its thinking as well as the JSON.
      const text = await complete(ctx, { system: LEDGER_SYSTEM, prompt, purpose: 'learning-tutor-ledger', model: deps.model(), maxTokens: 8000 })
      reply = Reply.parse(parseJsonReply(text))
    } catch (error) {
      const key = `${sessionId}:${talk[0]!.seq}`
      const failed = (failures.get(key) ?? 0) + 1
      if (failed < MAX_FAILURES) {
        failures.set(key, failed)
        throw error
      }
      failures.delete(key)
      logger.warn('classroom record skipped a stretch after %d failures: %s', failed, (error as Error).stack ?? error)
      return advance(sessionId, upTo)
    }

    const nodeOf = (refs: readonly string[]) => [...new Set(refs.flatMap(ref => {
      const node = nodes[Number(/^N(\d+)$/i.exec(ref.trim())?.[1]) - 1]
      return node ? [node.id as string] : []
    }))]
    const problemOf = (ref: string | null | undefined) => (ref ? problems[Number(/^P(\d+)$/i.exec(ref.trim())?.[1]) - 1] : undefined)
    /** The learner's message a quote comes from, word for word; its time dates the signal. */
    const source = (quote: string) => (bare(quote).length >= 2 ? learner.find(line => bare(line.text).includes(bare(quote))) : undefined)
    const saidAt = (line: SessionLine) => new Date(line.at).toISOString()
    const base = { courseId: courseId as never, context: { sessionId: sessionId as never, ...(place.stageId ? { stageId: place.stageId as never } : {}) } }
    const entries: NewLogEntry[] = []
    for (const help of reply.help) {
      const line = replies[help.reply - 1]
      const problem = problemOf(help.problem)
      const nodeIds = [...new Set([...nodeOf(help.nodes), ...(problem?.nodeIds ?? [])])]
      if (!line || nodeIds.length === 0) continue
      // Help on what an open test asks counts against that test, named problem or not.
      const testId = problem?.testId ?? problems.find(item => item.open && item.nodeIds.some(id => nodeIds.includes(id)))?.testId
      const lessonId = problem?.lessonId ?? place.lessonId
      entries.push({
        ...base,
        type: 'help.given',
        at: saidAt(line),
        nodeIds: nodeIds as never,
        level: help.level,
        via: 'teacher',
        ...(problem ? { problemId: problem.id as never } : {}),
        context: { ...base.context, ...(lessonId ? { lessonId: lessonId as never } : {}), ...(testId ? { testId: testId as never } : {}) },
      })
    }
    for (const claim of reply.claims) {
      const nodeIds = nodeOf(claim.nodes), line = source(claim.quote)
      if (nodeIds.length && line) entries.push({ ...base, type: 'signal.self-report', at: saidAt(line), nodeIds: nodeIds as never, claim: claim.claim, text: claim.quote.trim() })
    }
    for (const question of reply.questions) {
      const nodeIds = nodeOf(question.nodes), line = source(question.quote)
      if (nodeIds.length && line) entries.push({ ...base, type: 'signal.question', at: saidAt(line), nodeIds: nodeIds as never, text: question.quote.trim() })
    }
    for (const misconception of reply.misconceptions) {
      const nodeIds = nodeOf(misconception.nodes), line = source(misconception.quote)
      if (nodeIds.length && line && misconception.text.trim()) {
        entries.push({ ...base, type: 'signal.misconception', at: saidAt(line), nodeIds: nodeIds as never, text: `${misconception.text.trim()}（原话："${misconception.quote.trim()}"）` })
      }
    }
    ctx.learnCore.db.transaction(() => {
      for (const entry of entries) ctx.learnCore.log.append(entry)
      advance(sessionId, upTo)
    })
  }

  // A teacher went idle (its turn is over): record what is new, one session at a time. A failure
  // leaves the mark where it was, so the next turn records both. (DSH's `session/event` is scoped
  // and does not reach the learning units; agent events do, like `agent/pre-step` for the brief.)
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    const sessionId = agent.session.id as string
    const link = ctx.learnCore.sessions.get(sessionId)
    if (link?.role !== 'teacher' || !link.courseId) return
    const courseId = link.courseId
    const chain = (chains.get(sessionId) ?? Promise.resolve())
      .then(() => record(sessionId, courseId))
      .catch(error => logger.warn('classroom record failed: %s', (error as Error).stack ?? error))
    chains.set(sessionId, chain)
  })
}
