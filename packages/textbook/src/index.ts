// textbook unit, host half. Provides `ctx.learnTextbook` (contracts §5.1): generates each lesson's
// textbook file from the course's skeleton material and the stage design, keeps the block index
// (ids, citations, unverified flags, linked nodes), answers block lookups.
// Each lesson's generation is kept in `textbook_runs`, so a restart resumes queued and interrupted
// lessons and reuses the parts already written (docs/textbook/design.md, 生成与恢复). Before a lesson
// is published, its sentences are checked against their sources (checker.ts); the result of each
// paragraph is kept in `textbook_checks`, bound to the paragraph's text.
import { createHash, randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  Block,
  COURSE_LAYOUT,
  STAGE_LAYOUT,
  newBlockId,
  parseFrontmatter,
  withFrontmatter,
  type CitedChunk,
  type LearnKnowledge,
  type LearnTextbook,
  type Lesson,
  type LessonTextbookStatus,
  type Migration,
} from '@learning-agent/contracts'
import { complete, must, now } from '@learning-agent/kit'
import { roleModel, Schema } from '@learning-agent/kit/settings'
import { z } from 'zod'
import { settled } from './check.ts'
import { checkLesson } from './checker.ts'
import { finalize, halve, indexBlocks, missingHeadings, planParts, teachingPartOf } from './format.ts'

export const name = 'learning-textbook'
export const inject = ['learnCore', 'learnCurriculum', 'learnLibrary', 'learnKnowledge', 'llm', 'sessionController']

export const Config = Schema.object({
  model: roleModel('写教材'),
  checkModel: roleModel('核对教材'),
  webCheck: Schema.boolean().default(true).description('核对教材时联网补充出处').volatile(),
})
export type Config = ReturnType<typeof Config>

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE textbook_blocks (
        course_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        file TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (course_id, block_id)
      );
      CREATE INDEX textbook_blocks_file ON textbook_blocks (course_id, file, seq);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE textbook_runs (
        lesson_id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE textbook_checks (
        course_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        file TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (course_id, block_id)
      );
      CREATE INDEX textbook_checks_file ON textbook_checks (course_id, file);
    `,
  },
]

const SentenceCheckRow = z.object({
  text: z.string(),
  verdict: z.enum(['supported', 'partial', 'contradicted', 'missing', 'unchecked']),
  key: z.boolean(),
  copy: z.boolean(),
  evidence: z.array(z.object({ chunkId: z.string(), quote: z.string() })),
  groups: z.array(z.string()),
  note: z.string(),
})

/** One paragraph's check. Owner: textbook. `hash` is the paragraph's text when checked: an edit voids it. */
const BlockCheck = z.object({
  hash: z.string(),
  sentences: z.array(SentenceCheckRow),
  checkedAt: z.string(),
})
type BlockCheck = z.infer<typeof BlockCheck>

/** One lesson's latest generation. Owner: textbook. */
const Run = z.object({
  lessonId: z.string(),
  courseId: z.string(),
  stageId: z.string(),
  /** Written into the published file's frontmatter, so a restart recognizes a run it already published. */
  run: z.string(),
  state: z.enum(['queued', 'running', 'ready', 'failed']),
  message: z.string().default(''),
  /** Failed attempts in a row since the last success. */
  failures: z.number().int().nonnegative().default(0),
  /** Model replies already written, by the hash of their whole input; dropped once the lesson is published. */
  parts: z.record(z.string(), z.array(z.string())).default({}),
  /** Knowledge points sourced in the lesson's material that no paragraph explains. */
  uncovered: z.array(z.string()).default([]),
  /** Whether every paragraph was checked, and what the check left to say (web supplement, failures). */
  checked: z.boolean().optional(),
  notes: z.array(z.string()).default([]),
  /** The check of the text being published, by block id, kept until the file is written. */
  pending: z.record(z.string(), z.array(SentenceCheckRow)).optional(),
  updatedAt: z.string(),
})
type Run = z.infer<typeof Run>

const WRITER_SYSTEM = `你是教材编写者，为一位具体的学习者编写课程中一个小节的教材。规则：
1. 只依据给出的资料片段写，不使用你自己的知识；资料里没有的内容不写。
2. 每个段落末尾用链接注明出处，格式 [《书名》p.页码](cite:片段ID)，片段 ID 只能是"资料片段"里列出的 ID。一段可以有多个出处。不要写没有出处的导读、过渡或总结段落，需要的话并进有出处的段落里。
3. 公式用 LaTeX：行内用 $…$；独立公式单独成段，写成 $$…$$，紧接着的下一段说明公式含义并带出处。
4. 结构按"本次要写的范围"的要求：用 "###" 分子标题，先讲清概念和道理，再给公式和例题。例题只能用资料片段里的例题，题目条件和数字照原样写，保留原编号和解答要点，不要改编或自编。
5. 不写习题、小测题或测试安排，不提考试形式和测试条件：练习和测试由测试页单独发布，写进教材会让测试失效。
6. 按阶段设计书的要求决定详略：学习者已经会的压缩，薄弱的展开。正文里不要出现内部编号（kn_、ck_ 等）。
7. 中文，简洁准确。直接输出教材正文 Markdown，不要前言后语，不要代码块包裹。`

const QUESTIONS_SYSTEM = `你为一节教材写"读完就答"：2 个凭记忆作答的小问题，帮助学习者检查自己读懂了没有。
只依据给出的教材正文出题，不给答案，不出计算题，不写内部编号。
只输出：先一行 "### 读完就答"，再两行编号问题（"1. …"、"2. …"）。`

/**
 * A remedial lesson (docs/curriculum/design.md, 补课单元) mends what the stage review found instead of
 * retelling the section: rereading the same explanation rarely fixes a misconception.
 */
const REMEDIAL_NOTE = `这是补课课时：学习者已经学过这一节，阶段测试暴露了下面复盘里写的问题。只讲这些没过的地方，不重写整节：
1. 先点明错在哪里、为什么容易错；
2. 换一种讲法讲清道理：把步骤拆开，对照常见错误；
3. 用资料片段里的例题一步一步讲；
4. 学习者已经会的内容一句带过。`

/** Prompt size of one part's material; a part this size is written within the output budget even with thinking. */
const PART_LIMIT = 6000
/** Output budget of one writer call; the model's thinking counts against it. */
const WRITER_MAX_TOKENS = 16_000
const QUEUED = '排队等待生成'

/** Material kinds a textbook may draw on: exercises and their answers belong to assess (docs/assess/design.md). */
const TEACHING_KINDS = new Set<string>(['heading', 'text', 'formula', 'table', 'figure', 'example'])

function materialOf(chunks: readonly CitedChunk[]): string {
  return chunks
    .filter(chunk => chunk.kind !== 'figure' || chunk.text.length > 4)
    .map(chunk => `[${chunk.id}] ${chunk.citation} · ${chunk.section.at(-1) ?? ''}\n${chunk.text}`)
    .join('\n\n')
}

const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)

/** A part to write: its material, and whether it opens the lesson (writes the `##` title). */
interface Part {
  readonly chunks: CitedChunk[]
  readonly first: boolean
}

/** Why generation failed, in words for the learner and the teacher. */
function describeFailure(error: unknown): string {
  const { code, message } = error as { code?: string; message?: string }
  if (code === 'learning/model/truncated') return '这一节有一部分内容太长，拆开后仍超出模型单次能写的长度，请稍后重试'
  if (code === 'learning/core/conflict') return '生成期间这一节的教材文件被修改过（可能是在应用外编辑），没有覆盖。要按现在的设计书重写，请再生成一次'
  return message ?? String(error)
}

/** "12 段，2 段待核实，3 段的关键事实只有一个来源；这些知识点正文没有讲到：A、B" for handoffs and the brief. */
function summaryOf(status: LessonTextbookStatus): string {
  const check = status.check
  return [
    `${status.blocks ?? 0} 段`,
    status.unverified ? `，${status.unverified} 段待核实` : '',
    check?.single ? `，${check.single} 段的关键事实只有一个来源` : '',
    check?.stale ? `，${check.stale} 段核对后改过` : '',
    check?.state === 'unchecked' ? '，出处没有核对完' : '',
    ...(check?.notes ?? []).map(note => `；${note}`),
    status.uncovered?.length ? `；这些知识点正文没有讲到：${status.uncovered.join('、')}` : '',
  ].join('')
}

class LearnTextbookService extends Service implements LearnTextbook {
  private readonly inFlight = new Map<string, Promise<void>>()
  /** Aborts the model calls in flight when the unit stops; those lessons stay running and resume on the next start. */
  private readonly stopping = new AbortController()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'learnTextbook')
    ctx.learnCore.db.migrate('textbook', migrations)
  }

  private get sqlite() {
    return this.ctx.learnCore.db.sqlite
  }

  private runOf(lessonId: string): Run | undefined {
    const row = this.sqlite.prepare('SELECT data FROM textbook_runs WHERE lesson_id = ?').get(lessonId) as { data: string } | undefined
    return row ? Run.parse(JSON.parse(row.data)) : undefined
  }

  private saveRun(run: Run): Run {
    this.sqlite.prepare(`INSERT INTO textbook_runs (lesson_id, course_id, data) VALUES (?, ?, ?)
      ON CONFLICT (lesson_id) DO UPDATE SET data = excluded.data`).run(run.lessonId, run.courseId, JSON.stringify(run))
    return run
  }

  /** Lessons queued or being written. */
  running = () => {
    const rows = this.sqlite.prepare("SELECT lesson_id FROM textbook_runs WHERE json_extract(data, '$.state') IN ('queued', 'running')").all() as { lesson_id: string }[]
    return [...new Set([...this.inFlight.keys(), ...rows.map(row => row.lesson_id)])]
  }

  status(lessonId: string): LessonTextbookStatus {
    const run = this.runOf(lessonId)
    // The run's state counts once there is one: a lesson just published is ready while its call unwinds.
    if (run ? run.state === 'queued' || run.state === 'running' : this.inFlight.has(lessonId)) return { state: 'running', message: run?.message ?? '' }
    const lesson = this.ctx.learnCurriculum.lesson(lessonId)
    const stage = lesson ? this.ctx.learnCurriculum.stage(lesson.stageId) : undefined
    const blocks = lesson?.textbookFile && stage ? this.blocks(stage.courseId, lesson.textbookFile) : []
    if (run?.state === 'failed') return { state: 'failed', message: run.message, failures: run.failures, ...(blocks.length ? { blocks: blocks.length } : {}) }
    if (blocks.length === 0) return { state: 'missing' }
    const checks = this.checks(stage!.courseId, lesson!.textbookFile!)
    const current = blocks.filter(block => checks.get(block.id)?.hash === block.hash)
    return {
      state: 'ready',
      blocks: blocks.length,
      unverified: blocks.filter(block => block.unverified).length,
      ...(run?.uncovered.length ? { uncovered: run.uncovered } : {}),
      ...(checks.size ? {
        check: {
          state: run?.checked === false ? 'unchecked' : 'checked',
          single: current.filter(block => checks.get(block.id)!.sentences.some(sentence => settled(sentence) === 'single')).length,
          stale: blocks.filter(block => checks.has(block.id) && checks.get(block.id)!.hash !== block.hash).length,
          notes: run?.notes ?? [],
        },
      } : {}),
    }
  }

  /** The kept check of each paragraph of a file, by block id. */
  checks(courseId: string, file: string): Map<string, BlockCheck> {
    const rows = this.sqlite.prepare('SELECT block_id, data FROM textbook_checks WHERE course_id = ? AND file = ?').all(courseId, file) as { block_id: string; data: string }[]
    return new Map(rows.map(row => [row.block_id, BlockCheck.parse(JSON.parse(row.data))]))
  }

  /**
   * Save the lesson's run with `patch` and tell open pages. Writing a lesson again after it was
   * published starts a new run: its id must not match the file already published.
   */
  private progress(lesson: Lesson, courseId: string, patch: Partial<Run> & Pick<Run, 'state'>): Run {
    const previous = this.runOf(lesson.id)
    const fresh = !previous || (previous.state === 'ready' && patch.state !== 'ready')
    const run = this.saveRun(Run.parse({ lessonId: lesson.id, courseId, stageId: lesson.stageId, ...previous, ...(fresh ? { run: randomUUID().slice(0, 8), parts: {} } : {}), ...patch, updatedAt: now() }))
    const state = run.state === 'ready' ? 'done' : run.state === 'failed' ? 'failed' : 'running'
    this.ctx.learnCore.feed.publish('learning/textbook-progress', { lessonId: lesson.id, stageId: lesson.stageId, state, message: run.message })
    return run
  }

  /** Teaching material for a lesson: the skeleton source's subsection, else a search by title. */
  private material(courseId: string, lesson: Lesson): CitedChunk[] {
    const sources = this.ctx.learnLibrary.courseSources(courseId)
    const skeleton = sources.find(entry => entry.role === 'skeleton') ?? sources[0]
    const section = skeleton ? this.ctx.learnLibrary.section(skeleton.sourceId, lesson.number) : []
    const chunks = section.length > 0 ? section : this.ctx.learnLibrary.search(lesson.title, { courseId, limit: 40 }).map(hit => hit.chunk)
    return chunks.filter(chunk => TEACHING_KINDS.has(chunk.kind) && !chunk.problemGroup && !chunk.section.some(part => /^(习题|复习思考题|思考题)/.test(part)))
  }

  generateLesson(lessonId: string): Promise<void> {
    const existing = this.inFlight.get(lessonId)
    if (existing) return existing
    const run = this.writeLesson(lessonId).finally(() => this.inFlight.delete(lessonId))
    this.inFlight.set(lessonId, run)
    return run
  }

  /** One model reply, reused from the lesson's run when the same input was written before. */
  private async reply(lessonId: string, input: { readonly system: string; readonly prompt: string; readonly maxTokens: number; readonly model: string | undefined }, write: () => Promise<string[]>): Promise<string[]> {
    const key = hashOf([input.system, input.prompt, input.maxTokens, input.model ?? ''])
    const cached = this.runOf(lessonId)?.parts[key]
    if (cached) return cached
    const texts = await write()
    const run = this.runOf(lessonId)
    if (run) this.saveRun({ ...run, parts: { ...run.parts, [key]: texts } })
    return texts
  }

  /**
   * Write one part. A reply cut off at the output limit is retried as two halves, so a long
   * subsection still gets written; a single chunk that does not fit is reported.
   */
  private async writePart(part: Part, prompt: (part: Part) => string, depth = 0): Promise<string[]> {
    try {
      return [await complete(this.ctx, { system: WRITER_SYSTEM, prompt: prompt(part), purpose: 'learning-textbook', model: this.config.model.get(), maxTokens: WRITER_MAX_TOKENS, signal: this.stopping.signal })]
    } catch (error) {
      if ((error as { code?: string }).code !== 'learning/model/truncated' || part.chunks.length < 2 || depth >= 2) throw error
      const [head, tail] = halve(part.chunks)
      return [
        ...await this.writePart({ chunks: head, first: part.first }, prompt, depth + 1),
        ...await this.writePart({ chunks: tail, first: false }, prompt, depth + 1),
      ]
    }
  }

  private async writeLesson(lessonId: string): Promise<void> {
    const curriculum = this.ctx.learnCurriculum
    const lesson = must(curriculum.lesson(lessonId), 'textbook', '课时', lessonId)
    const stage = must(curriculum.stage(lesson.stageId), 'textbook', '阶段', lesson.stageId)
    const courseId = stage.courseId
    const heading = `${lesson.number} ${lesson.title}`
    const file = lesson.textbookFile!
    const before = await this.ctx.learnCore.files.read(courseId, file)
    const previous = this.runOf(lesson.id)
    // Published just before a restart: only the index, the status and the handoff are left.
    if (previous?.state === 'running' && before && parseFrontmatter(before.text).data.run === previous.run) {
      this.publish(lesson, courseId, before.text)
      return
    }
    // An unfinished run keeps its id and the replies it already has.
    this.progress(lesson, courseId, { state: 'running', message: `正在编写 ${heading}` })
    try {
      const chunks = this.material(courseId, lesson)
      if (chunks.length === 0) throw new Error(`资料库里找不到 ${heading} 的资料，先把骨架教材加入本课`)
      const known = new Set<string>(chunks.map(chunk => chunk.id))
      const design = await this.ctx.learnCore.files.read(courseId, `${stage.folder}/${STAGE_LAYOUT.design}`)
      const goal = await this.ctx.learnCore.files.read(courseId, COURSE_LAYOUT.goal)
      const parent = stage.kind === 'remedial' && stage.remedialOf ? this.ctx.learnCurriculum.stage(stage.remedialOf) : undefined
      const review = parent ? await this.ctx.learnCore.files.read(courseId, `${parent.folder}/${STAGE_LAYOUT.review}`) : undefined
      const context = [
        goal ? `# 学习目标\n${parseFrontmatter(goal.text).body.slice(0, 2000)}` : '',
        design ? `# 阶段设计书（测试部分已略去）\n${teachingPartOf(parseFrontmatter(design.text).body)}` : '',
        stage.kind === 'remedial' ? `# 补课\n${REMEDIAL_NOTE}${review ? `\n\n## 上一阶段的复盘\n${parseFrontmatter(review.text).body.trim()}` : ''}` : '',
        `# 要写的小节\n${heading}`,
      ].filter(Boolean).join('\n\n')

      // A long section is written in parts, one reply per part. A remedial lesson is short: one reply over the whole section's material.
      const parts: Part[] = stage.kind === 'remedial' ? [{ chunks, first: true }] : planParts(chunks, PART_LIMIT).map((part, index) => ({ chunks: part, first: index === 0 }))
      const outline = chunks.filter(chunk => chunk.kind === 'heading').map(chunk => chunk.text.replace(/^#+\s*/, '')).join('；')
      const scope = (part: Part) => {
        const titles = part.chunks.filter(chunk => chunk.kind === 'heading').map(chunk => chunk.text.replace(/^#+\s*/, '')).join('；')
        if (stage.kind === 'remedial' && part.first) return `补课课时，按上面"补课"的要求写，不写整节。用 "## ${heading}" 开头。最后一个 "### 读完就答" 子标题下给 2 个凭记忆作答的小问题（不给答案），问这次补的地方。`
        if (part.chunks.length === chunks.length) return `整节。用 "## ${heading}" 开头。最后一个 "### 读完就答" 子标题下给 2 个凭记忆作答的小问题（不给答案）。`
        return [
          `这一节较长，分几次写，每次只写下面资料片段覆盖的内容（${titles || '接着上一部分'}），各部分会按顺序拼成一节。本节的小标题依次是：${outline}。`,
          part.first ? `这是第一部分：用 "## ${heading}" 开头。` : '这不是第一部分：不要写 "## " 标题，也不要写开场白，直接从 "###" 子标题或正文开始。',
          '不要写 "读完就答"，也不要写本节总结。',
        ].join('\n')
      }
      const prompt = (part: Part) => [context, `# 本次要写的范围\n${scope(part)}`, `# 资料片段（只能引用这些 ID）\n${materialOf(part.chunks)}`].join('\n\n')
      // Two parts at a time; after a failure no new part starts, and the lesson fails once the running one ends.
      const texts: string[][] = new Array(parts.length)
      let written = 0
      let failure: { readonly error: unknown } | undefined
      const queue = parts.map((part, index) => ({ part, index }))
      await Promise.all([0, 1].map(async () => {
        for (let item = queue.shift(); item && !failure; item = queue.shift()) {
          const { part } = item
          try {
            const write = (ask: (part: Part) => string) => this.reply(lesson.id, { system: WRITER_SYSTEM, prompt: ask(part), maxTokens: WRITER_MAX_TOKENS, model: this.config.model.get() }, () => this.writePart(part, ask))
            texts[item.index] = await write(prompt)
            // A reply that skipped subsections of its material is written once more, naming them, and the
            // fuller of the two is kept. A remedial lesson leaves subsections out on purpose.
            const missing = stage.kind === 'remedial' ? [] : missingHeadings(part.chunks, texts[item.index]!.join('\n'))
            if (missing.length) {
              const again = await write(next => `${prompt(next)}\n\n# 注意\n上一次漏写了这些小标题下的内容：${missing.join('；')}。这次资料片段里的每个小标题都要写到，不要只写第一个。`)
              if (missingHeadings(part.chunks, again.join('\n')).length <= missing.length) texts[item.index] = again
            }
          } catch (error) {
            failure ??= { error }
            return
          }
          written += 1
          if (parts.length > 1) this.progress(lesson, courseId, { state: 'running', message: `正在编写 ${heading}（已完成 ${written}/${parts.length} 部分）` })
        }
      }))
      if (failure) throw failure.error
      let draft = texts.flat().map(text => text.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/, '$1')).join('\n\n')
      // Written in more than one reply: the recall questions are asked over the whole section.
      if (texts.flat().length > 1) {
        const input = { system: QUESTIONS_SYSTEM, prompt: `# 小节\n${heading}\n\n# 教材正文\n${draft}`, maxTokens: 4000, model: this.config.model.get() }
        const [questions = ''] = await this.reply(lesson.id, input, async () => [(await complete(this.ctx, { ...input, purpose: 'learning-textbook', signal: this.stopping.signal })).trim()])
        draft = `${draft}\n\n${/读完就答/.test(questions) ? questions : `### 读完就答\n\n${questions}`}`
      }

      const taken = new Set<string>((this.sqlite.prepare('SELECT block_id FROM textbook_blocks WHERE course_id = ?').all(courseId) as { block_id: string }[]).map(row => row.block_id))
      const newId = () => {
        let id = newBlockId()
        while (taken.has(id)) id = newBlockId()
        taken.add(id)
        return id
      }
      // A paragraph that reads exactly as before keeps its id (annotations stay on it); each old id is used once.
      const unchanged = new Map<string, string[]>()
      for (const block of before ? indexBlocks(before.text) : []) unchanged.set(block.text, [...unchanged.get(block.text) ?? [], block.id])
      // Only the material the writer was given counts as a source; any other id becomes 待核实.
      const draftBody = finalize(draft, { knownChunk: id => known.has(id), newBlockId: newId, reuse: text => unchanged.get(text)?.shift() })
      const { dropped } = draftBody
      this.progress(lesson, courseId, { state: 'running', message: `正在逐句核对 ${heading} 的出处` })
      const outcome = await checkLesson({
        ctx: this.ctx, courseId, material: chunks, model: this.config.checkModel.get(), web: this.config.webCheck.get(), signal: this.stopping.signal,
        reply: (input, write) => this.reply(lesson.id, { ...input, model: this.config.checkModel.get() }, write),
      }, draftBody.body, newId)
      const body = outcome.body
      const run = this.saveRun({ ...this.runOf(lesson.id)!, checked: outcome.checked, notes: [...outcome.notes], pending: Object.fromEntries([...outcome.checks].map(([id, checks]) => [id, SentenceCheckRow.array().parse(checks)])) }).run
      const version = Number(before ? parseFrontmatter(before.text).data.version ?? 0 : 0) + 1
      const text = withFrontmatter({ lesson: lesson.id, title: `${lesson.number} ${lesson.title}`, version, generatedAt: now(), run }, body)
      // Not over a file that changed while the lesson was written (an outside edit, another writer).
      await this.ctx.learnCore.files.write(courseId, file, text, {
        actor: 'system',
        reason: `生成教材 ${lesson.number}${dropped.length ? `（${dropped.length} 处无效出处已标为待核实）` : ''}`,
        size: before ? 'major' : 'minor',
      }, { ifHash: before?.hash ?? null })
      this.publish(lesson, courseId, text)
    } catch (error) {
      // The unit is stopping: the lesson stays running and resumes on the next start.
      if (this.stopping.signal.aborted) return
      const message = describeFailure(error)
      this.progress(lesson, courseId, { state: 'failed', message, failures: (this.runOf(lesson.id)?.failures ?? 0) + 1 })
      this.ctx.emit('learning/textbook-failed', { courseId, stageId: stage.id, lessonId: lesson.id, message })
      this.ctx.emit('learning/handoff', { courseId, unit: 'textbook', text: `教材 ${heading} 生成失败：${message}` })
      throw error
    }
  }

  /** The file is written: index it, keep its check, mark the run done, then tell the stage and the teacher once. */
  private publish(lesson: Lesson, courseId: string, text: string): void {
    const file = lesson.textbookFile!
    const { blocks, uncovered } = this.reindex(courseId, file, text)
    const pending = this.runOf(lesson.id)?.pending
    if (pending) {
      const checkedAt = now()
      this.ctx.learnCore.db.transaction(() => {
        this.sqlite.prepare('DELETE FROM textbook_checks WHERE course_id = ? AND file = ?').run(courseId, file)
        const insert = this.sqlite.prepare('INSERT OR REPLACE INTO textbook_checks (course_id, block_id, file, data) VALUES (?, ?, ?, ?)')
        for (const block of blocks) {
          const sentences = pending[block.id]
          if (sentences) insert.run(courseId, block.id, file, JSON.stringify(BlockCheck.parse({ hash: block.hash, sentences, checkedAt })))
        }
      })
    }
    this.progress(lesson, courseId, { state: 'ready', message: '', failures: 0, parts: {}, uncovered, pending: undefined })
    const summary = summaryOf(this.status(lesson.id))
    this.progress(lesson, courseId, { state: 'ready', message: summary })
    this.ctx.emit('learning/textbook-ready', { courseId, stageId: lesson.stageId, lessonId: lesson.id })
    this.ctx.emit('learning/handoff', { courseId, unit: 'textbook', text: `教材 ${lesson.number} ${lesson.title} 已生成（${summary}）。` })
  }

  async generateStage(stageId: string): Promise<void> {
    const stage = must(this.ctx.learnCurriculum.stage(stageId), 'textbook', '阶段', stageId)
    // In lesson order, so the first lesson is ready (and the stage can start) as early as possible;
    // a long lesson's parts are written two at a time. Each lesson reports its own outcome.
    const lessons = this.ctx.learnCurriculum.lessons(stageId)
    for (const lesson of lessons) if (!this.inFlight.has(lesson.id)) this.progress(lesson, stage.courseId, { state: 'queued', message: QUEUED })
    await this.drain(lessons)
  }

  /** Write the queued and interrupted lessons in order; one taken on elsewhere (a retry, the reader page) is skipped. */
  private async drain(lessons: readonly Lesson[]): Promise<void> {
    for (const lesson of lessons) {
      const state = this.runOf(lesson.id)?.state
      if (this.inFlight.has(lesson.id) || (state !== 'queued' && state !== 'running') || this.stopping.signal.aborted) continue
      await this.generateLesson(lesson.id).catch((error: Error) => {
        this.ctx.logger('learning-textbook').warn('lesson %s: %s', lesson.number, error.message)
      })
    }
  }

  /** After a restart: lessons queued or cut off go on, stage by stage. */
  resume(): void {
    const rows = this.sqlite.prepare("SELECT data FROM textbook_runs WHERE json_extract(data, '$.state') IN ('queued', 'running')").all() as { data: string }[]
    const stages = new Set<string>()
    for (const row of rows) {
      const run = Run.parse(JSON.parse(row.data))
      if (this.ctx.learnCurriculum.lesson(run.lessonId)) stages.add(run.stageId)
      else this.sqlite.prepare('DELETE FROM textbook_runs WHERE lesson_id = ?').run(run.lessonId)
    }
    for (const stageId of stages) void this.drain(this.ctx.learnCurriculum.lessons(stageId))
  }

  stop(): void {
    this.stopping.abort()
  }

  /**
   * Knowledge points the lesson's paragraphs may explain (docs/textbook/design.md, 知识关联): the stage's
   * core nodes and those sourced in the lesson's material or in a chunk the file cites. A paragraph is
   * linked to one when it cites a chunk the node is sourced in, or names it by a title or alias no
   * other node of the course shares.
   */
  private linker(courseId: string, file: string, cited: readonly string[]) {
    const lesson = this.ctx.learnCurriculum.stages(courseId).flatMap(stage => this.ctx.learnCurriculum.lessons(stage.id)).find(item => item.textbookFile === file)
    const stage = lesson ? this.ctx.learnCurriculum.stage(lesson.stageId) : undefined
    const material = lesson ? this.material(courseId, lesson).map(chunk => chunk.id) : []
    const nodes = this.ctx.learnKnowledge.graph(courseId).nodes
    const sourced = new Map<string, Set<string>>()
    for (const source of this.ctx.learnKnowledge.sourceLayer(courseId).sources) {
      for (const link of source.links) for (const chunk of link.chunks) sourced.set(chunk.id, (sourced.get(chunk.id) ?? new Set()).add(link.nodeId))
    }
    const inChunks = (ids: readonly string[]) => new Set(ids.flatMap(id => [...sourced.get(id) ?? []]))
    const expected = inChunks(material)
    const candidates = new Set([...stage?.nodeIds ?? [], ...expected, ...inChunks(cited)])
    const names = (node: (typeof nodes)[number]) => [node.title, ...node.aliases].map(name => name.trim()).filter(name => [...name].length >= 2)
    const shared = new Map<string, number>()
    for (const node of nodes) for (const name of new Set(names(node))) shared.set(name, (shared.get(name) ?? 0) + 1)
    const named = nodes.filter(node => candidates.has(node.id)).map(node => ({ id: node.id, names: names(node).filter(name => shared.get(name) === 1) }))
    return {
      link: (block: { readonly text: string; readonly citations: readonly string[] }) => [...new Set([
        ...inChunks(block.citations),
        ...named.filter(node => node.names.some(name => block.text.includes(name))).map(node => node.id),
      ])],
      /** Titles of the material's knowledge points no paragraph is linked to. */
      uncovered: (linked: ReadonlySet<string>) => nodes.filter(node => expected.has(node.id) && !linked.has(node.id)).map(node => node.title),
    }
  }

  /** Rebuild the block index of one file and link blocks to the lesson's knowledge points. */
  reindex(courseId: string, file: string, text: string | undefined): { blocks: Block[]; uncovered: string[] } {
    const indexed = text ? indexBlocks(text) : []
    const linker = this.linker(courseId, file, indexed.flatMap(block => block.citations))
    const blocks = indexed.map(block => Block.parse({ courseId, id: block.id, file, hash: block.hash, nodeIds: linker.link(block), citations: block.citations.filter(id => id.startsWith('ck_') && id.length === 29), unverified: block.unverified }))
    const uncovered = text ? linker.uncovered(new Set(blocks.flatMap(block => block.nodeIds))) : []
    this.ctx.learnCore.db.transaction(() => {
      this.sqlite.prepare('DELETE FROM textbook_blocks WHERE course_id = ? AND file = ?').run(courseId, file)
      const insert = this.sqlite.prepare('INSERT OR REPLACE INTO textbook_blocks (course_id, block_id, file, seq, data) VALUES (?, ?, ?, ?, ?)')
      const links: Parameters<LearnKnowledge['link']>[0][number][] = []
      blocks.forEach((block, seq) => {
        insert.run(courseId, block.id, file, seq, JSON.stringify(block))
        for (const nodeId of block.nodeIds) links.push({ nodeId, target: { kind: 'block', courseId: block.courseId, id: block.id }, relation: 'explains' })
      })
      // One file's links go in as a few groups (knowledge takes up to 100 per call), not one per paragraph.
      for (let i = 0; i < links.length; i += 100) this.ctx.learnKnowledge.link(links.slice(i, i + 100), { actor: 'system', reason: '教材段落关联明确的知识身份' }, courseId)
      // An edit outside the app changes what the lesson covers.
      const lessonRun = (this.sqlite.prepare('SELECT data FROM textbook_runs WHERE course_id = ?').all(courseId) as { data: string }[])
        .map(row => Run.parse(JSON.parse(row.data))).find(run => run.state === 'ready' && this.ctx.learnCurriculum.lesson(run.lessonId)?.textbookFile === file)
      if (lessonRun) this.saveRun({ ...lessonRun, uncovered })
    })
    return { blocks, uncovered }
  }

  blocks(courseId: string, file?: string): Block[] {
    const rows = (file
      ? this.sqlite.prepare('SELECT data FROM textbook_blocks WHERE course_id = ? AND file = ? ORDER BY seq').all(courseId, file)
      : this.sqlite.prepare('SELECT data FROM textbook_blocks WHERE course_id = ? ORDER BY file, seq').all(courseId)) as { data: string }[]
    return rows.map(row => Block.parse(JSON.parse(row.data)))
  }

  async block(courseId: string, blockId: string) {
    const row = this.sqlite.prepare('SELECT data FROM textbook_blocks WHERE course_id = ? AND block_id = ?').get(courseId, blockId) as { data: string } | undefined
    if (!row) return undefined
    const block = Block.parse(JSON.parse(row.data))
    const file = await this.ctx.learnCore.files.read(courseId, block.file)
    const text = file ? indexBlocks(file.text).find(item => item.id === blockId)?.text ?? '' : ''
    return { ...block, text }
  }
}

function isTextbookFile(path: string): boolean {
  return /^stages\/[^/]+\/textbook\/[^/]+\.md$/.test(path)
}

export function apply(ctx: Context, config: Config): void {
  const textbook = new LearnTextbookService(ctx, config)
  const endpoint = ctx.learnCore.api.endpoint
  // After the units started in the same turn (the tutor hears the handoff of a lesson finished on resume).
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        textbook.resume()
      } catch (error) {
        ctx.logger('learning-textbook').warn('resume failed: %s', (error as Error).stack ?? error)
      }
    }, 0)
    return () => { clearTimeout(timer); textbook.stop() }
  }, 'textbook: resume generation')

  // Keep the block index in step with the files (our own writes and the learner's outside edits).
  ctx.on('learning/doc-changed', ({ courseId, path }) => {
    if (!courseId || !isTextbookFile(path)) return
    void ctx.learnCore.files.read(courseId, path).then(file => textbook.reindex(courseId, path, file?.text))
      .catch(error => ctx.logger('learning-textbook').warn('reindex %s failed: %s', path, (error as Error).stack ?? error))
  })

  // A confirmed design starts the stage's textbook.
  ctx.on('learning/stage-changed', ({ stage }) => {
    if (stage.status !== 'designing' || !stage.designConfirmedAt) return
    const lessons = ctx.learnCurriculum.lessons(stage.id)
    if (lessons.some(lesson => textbook.running().includes(lesson.id))) return
    void textbook.generateStage(stage.id).catch(error => ctx.logger('learning-textbook').warn('generate stage failed: %s', (error as Error).stack ?? error))
  })

  ctx.effect(() => endpoint({
    unit: 'textbook',
    method: 'lesson',
    input: z.object({ lessonId: z.string() }),
    handle: async ({ lessonId }) => {
      const lesson = must(ctx.learnCurriculum.lesson(lessonId), 'textbook', '课时', lessonId)
      const stage = must(ctx.learnCurriculum.stage(lesson.stageId), 'textbook', '阶段', lesson.stageId)
      const file = lesson.textbookFile ? await ctx.learnCore.files.read(stage.courseId, lesson.textbookFile) : undefined
      const siblings = ctx.learnCurriculum.lessons(stage.id).map(item => ({ id: item.id, number: item.number, title: item.title }))
      return { lesson, stage: { id: stage.id, index: stage.index, title: stage.title }, siblings, text: file?.text ?? null, status: textbook.status(lessonId) }
    },
  }), 'textbook: lesson')

  ctx.effect(() => endpoint({
    unit: 'textbook',
    method: 'statuses',
    input: z.object({ stageId: z.string() }),
    handle: ({ stageId }) => Object.fromEntries(ctx.learnCurriculum.lessons(stageId).map(lesson => [lesson.id, textbook.status(lesson.id)])),
  }), 'textbook: statuses')

  ctx.effect(() => endpoint({
    unit: 'textbook',
    method: 'current',
    input: z.object({ courseId: z.string() }),
    handle: ({ courseId }) => {
      const stage = ctx.learnCurriculum.currentStage(courseId)
      const lessons = stage ? ctx.learnCurriculum.lessons(stage.id) : []
      return { lessonId: (lessons.find(lesson => lesson.status === 'in-progress') ?? lessons[0])?.id ?? null }
    },
  }), 'textbook: current')

  ctx.effect(() => endpoint({
    unit: 'textbook',
    method: 'generate',
    input: z.object({ lessonId: z.string() }),
    handle: ({ lessonId }) => {
      void textbook.generateLesson(lessonId).catch(() => { /* reported on the feed */ })
      return { started: true }
    },
  }), 'textbook: generate')

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const stage = ctx.learnCurriculum.currentStage(request.courseId)
    if (!stage) return sections
    const lessons = ctx.learnCurriculum.lessons(stage.id)
    if (lessons.length === 0) return sections
    const lines = lessons.map(lesson => {
      const status = textbook.status(lesson.id)
      const text = {
        missing: '未生成',
        running: '生成中',
        ready: `已生成，${summaryOf(status)}`,
        failed: `生成失败：${status.message}`,
      }[status.state]
      return `- ${lesson.number}：${text}`
    })
    return [...sections, { unit: 'textbook', title: '本阶段教材', text: lines.join('\n') }]
  })

  ctx.on('learning/describe-selection', async (selection, next) => {
    const lines = await next()
    const picked = selection.selected
    if (picked?.kind === 'block' && picked.id && selection.courseId) {
      const block = await textbook.block(selection.courseId, picked.id)
      if (block) lines.push(`选中的教材段落（${picked.label}，块 ${block.id}）：\n${block.text}`)
    }
    return lines
  })
}
