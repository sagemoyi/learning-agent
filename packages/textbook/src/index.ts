// textbook unit, host half. Provides `ctx.learnTextbook` (contracts §5.1): generates each lesson's
// textbook file from the course's skeleton material and the stage design, keeps the block index
// (ids, citations, unverified flags, linked nodes), answers block lookups.
// A lesson is explanation in the writer's words plus source text the program copies in (docs/textbook/
// design.md, 讲解与原文): one call plans the points (with what the chapter's exercises need), gaps are
// looked for in the course's other material and on the web, each point is written and its explanation
// checked against its material. Each lesson's generation is kept in `textbook_runs`, so a restart resumes
// queued and interrupted lessons and reuses the replies already written; each paragraph's check is kept
// in `textbook_checks`, bound to the paragraph's text.
import { createHash, randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  Block,
  COURSE_LAYOUT,
  LearningApiError,
  STAGE_LAYOUT,
  newBlockId,
  parseFrontmatter,
  withFrontmatter,
  type BlockRevision,
  type ChangeMeta,
  type CitedChunk,
  type LearnKnowledge,
  type LearnTextbook,
  type Lesson,
  type LessonTextbookStatus,
  type MasteryState,
  type Migration,
} from '@learning-agent/contracts'
import { complete, must, now, parseJsonReply } from '@learning-agent/kit'
import { roleModel, Schema } from '@learning-agent/kit/settings'
import { z } from 'zod'
import { flagged, reasonOf, type CheckChunk, type ParagraphCheck } from './check.ts'
import { checkPoint, type CheckOutcome } from './checker.ts'
import { REVISER_SYSTEM, applyRevision, parseRevision, revisionPrompt } from './revise.ts'
import { finalize, halve, indexBlocks, pointText, teachingPartOf } from './format.ts'
import { PLAN_SYSTEM, fallbackPoints, planPrompt, readPlan, stemsOf, type Point } from './plan.ts'

export const name = 'learning-textbook'
export const inject = ['learnCore', 'learnCurriculum', 'learnLibrary', 'learnKnowledge', 'learnLearner', 'llm', 'sessionController']

export const Config = Schema.object({
  model: roleModel('写教材'),
  checkModel: roleModel('核对教材'),
  // The key keeps its 10-09 name: learners who turned it off stay off.
  webCheck: Schema.boolean().default(true).description('写教材时联网补找资料里没讲的内容').volatile(),
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
  {
    version: 4,
    sql: `
      CREATE TABLE textbook_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX textbook_revisions_block ON textbook_revisions (course_id, block_id);
    `,
  },
  // The sentence-by-sentence checks of 10-09 have no reader any more (docs/textbook/design.md, 讲解与原文).
  { version: 5, sql: 'DELETE FROM textbook_checks;' },
]

/** Paragraphs a local revision may rewrite at once. */
const REVISE_LIMIT = 8

const CheckRow = z.object({
  verdict: z.enum(['ok', 'unsupported', 'contradicted', 'unchecked']),
  note: z.string(),
  sources: z.array(z.string()),
})

/** One paragraph's check. Owner: textbook. `hash` is the paragraph's text when checked: an edit voids it. */
const BlockCheck = CheckRow.extend({
  hash: z.string(),
  checkedAt: z.string(),
})
type BlockCheck = z.infer<typeof BlockCheck>

/** A web page a lesson quotes by its address: never added to the library (10-15). */
const WebUse = z.object({ url: z.string(), title: z.string(), site: z.string(), level: z.string(), passages: z.array(z.string()) })
type WebUse = z.infer<typeof WebUse>

/** The state of a paragraph shown in the reader's margin (`textbook.checks`). */
type CheckState = 'flagged' | 'unchecked' | 'stale'

/** One paragraph's sources and check, as the reader shows it when asked (`textbook.blockInfo`); client.tsx keeps the same shape. */
interface BlockInfo {
  readonly kind: 'original' | 'explanation' | 'recall'
  readonly state: 'ok' | CheckState | 'none'
  readonly note: string
  readonly sources: readonly { readonly chunkId: string; readonly citation: string; readonly text: string }[]
  readonly web: readonly { readonly url: string; readonly title: string; readonly site: string; readonly passage: string }[]
  /** What the paragraph was last revised for. */
  readonly revised?: string
}

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
  /** Where the writing is, for the reader page. */
  step: z.enum(['plan', 'write', 'check', 'publish']).optional(),
  startedAt: z.string().optional(),
  points: z.array(z.object({ title: z.string(), done: z.boolean() })).default([]),
  /** The points written so far, while the lesson is being written. */
  draft: z.string().optional(),
  /** Knowledge points sourced in the lesson's material that no paragraph explains. */
  uncovered: z.array(z.string()).default([]),
  /** What the chapter's exercises need that no material explains. */
  missing: z.array(z.string()).default([]),
  /** Web pages the lesson quotes. */
  web: z.array(WebUse).default([]),
  /** Whether every paragraph was checked, and what the check left to say. */
  checked: z.boolean().optional(),
  notes: z.array(z.string()).default([]),
  /** The check of the text being published, by block id, kept until the file is written. */
  pending: z.record(z.string(), CheckRow).optional(),
  updatedAt: z.string(),
})
type Run = z.infer<typeof Run>

const WRITER_SYSTEM = `你为一位具体的学习者写一节教材里的一个要点。教材由两部分组成：你写的讲解，和程序从资料里原样放进来的原文。规则：
1. 讲解用你自己的话、按学习者的水平讲：这一点要解决什么问题，道理是什么，怎么用，容易错在哪。简练，不照抄资料原句，不逐段复述资料。
2. 讲解里的事实只能来自给出的资料片段和网页摘录，不用你自己的知识；资料里没有的内容不写。讲事实的句子末尾标出处：[《书名》p.页码](cite:片段ID)；网页摘录写成 [网页标题](网址)。出处只用这样的链接，正文里不写资料名、网站名或网址。
3. 公式、图、表、例题的题目和原书解答不要自己重写，而是嵌入原文：单独一行写 ![[片段ID]]，连续几段写 ![[第一段ID..最后一段ID]]，程序会放进原文。正文段落不嵌入：讲解讲过的内容不再重复放原文，学习者点出处标签就能看原文。讲解里可以用行内公式指代符号和关系（如 $p_2=p_1+\\rho g h$），完整的式子用嵌入。讲到哪张图就在那里嵌入它。
4. 例题：先嵌入题目，再用两三句话讲解题思路（为什么这样列式、关键一步在哪），最后嵌入原书解答。不改编、不自编题目。
5. 不写习题、小测题或测试安排；"做练习要会的"要讲到，但只讲道理，不出题、不提习题。
6. 有"学习者对本课知识点的掌握"时按它定详略：已经会的一两句带过，保留嵌入的公式；薄弱的展开、拆步骤。不要在正文里复述学习者的掌握情况。除了出处和嵌入里的片段 ID，正文不出现内部编号（kn_、ck_ 等）。
7. 篇幅大致和这一点的资料原文相当，已经会的更短；不逐条复述资料，不在末尾把前面讲过的再总结一遍。要点里不再分小标题，也不要用单独一行加粗字当小标题。
8. 中文。直接输出 Markdown，不要前言后语，不要代码块包裹。`

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

/** Material per point when there is no usable plan; a part this size is written within the output budget even with thinking. */
const PART_LIMIT = 6000
/** Output budgets of a writer and a planning call; the model's thinking counts against them (a plan cut off falls back to subsections). */
const WRITER_MAX_TOKENS = 16_000
const PLAN_MAX_TOKENS = 16_000
/** Characters of material up to which every point is checked against the whole section. */
const CHECK_WHOLE = 30_000
/** Needs looked for outside the lesson's material, and what is kept of a web page. */
const GAP_LIMIT = 3
const WEB_PASSAGES = 3
const PASSAGE_CHARS = 700
const QUEUED = '排队等待生成'

/** Material kinds a textbook may draw on: exercises and their answers belong to assess (docs/assess/design.md). */
const TEACHING_KINDS = ['heading', 'text', 'formula', 'table', 'figure', 'example'] as const
const KIND_LABEL: Record<string, string> = { heading: '小标题', text: '正文', formula: '公式', table: '表', figure: '图', example: '例题' }

function materialOf(chunks: readonly CitedChunk[]): string {
  return chunks.map(chunk => {
    const bare = chunk.kind === 'figure' && /^（?图）?$/.test(chunk.text.trim())
    return `[${chunk.id}] ${chunk.citation} · ${KIND_LABEL[chunk.kind] ?? chunk.kind} · ${chunk.section.at(-1) ?? ''}\n${bare ? '（无图注的图）' : chunk.text}`
  }).join('\n\n')
}

const toCheck = (chunk: CitedChunk): CheckChunk => ({ id: chunk.id, text: chunk.text, kind: chunk.kind, citation: chunk.citation })
const webChunks = (web: readonly WebUse[]): CheckChunk[] => web.map(page => ({ id: page.url, text: page.passages.join('\n'), kind: 'web', citation: page.title }))

/** How to write a knowledge point, by the learner's state on it (docs/textbook/design.md, 按掌握证据定详略). */
const MASTERY: Record<MasteryState, { readonly label: string; readonly write: string }> = {
  independent: { label: '已独立完成', write: '压缩：保留定义、符号和适用条件，不展开推导和例题' },
  retained: { label: '已延迟验证', write: '压缩：保留定义、符号和适用条件，不展开推导和例题' },
  'not-yet': { label: '还没答对', write: '展开：拆开步骤讲，对照常见错误，用资料里的例题一步一步讲' },
  conflict: { label: '证据冲突', write: '展开：拆开步骤讲，对照常见错误，用资料里的例题一步一步讲' },
  assisted: { label: '有帮助才完成', write: '正常讲，并提醒学习者自己独立做一遍' },
  untested: { label: '没测过', write: '正常讲' },
}

const hashOf = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)

/** Characters two texts share in pairs, to rank a web page's passages against what is looked for. */
function overlap(a: string, b: string): number {
  const pairs = new Set<string>()
  for (let i = 0; i + 1 < a.length; i += 1) pairs.add(a.slice(i, i + 2))
  let shared = 0
  for (let i = 0; i + 1 < b.length; i += 1) if (pairs.has(b.slice(i, i + 2))) shared += 1
  return shared
}

/** Keywords for the full-text search, which matches each term as a phrase: Chinese runs in pieces of four, and Latin words. */
function termsOf(text: string): string {
  const plain = text.replace(/\$[^$]*\$/g, ' ')
  const pieces: string[] = []
  for (const run of plain.match(/[一-鿿]+|[A-Za-z]{3,}/g) ?? []) {
    if (/^[A-Za-z]/.test(run)) pieces.push(run)
    else for (let i = 0; i < run.length; i += 4) if (run.length - i >= 3) pieces.push(run.slice(i, i + 4))
  }
  return [...new Set(pieces)].slice(0, 6).join(' ')
}

/** Why generation failed, in words for the learner and the teacher. */
function describeFailure(error: unknown): string {
  const { code, message } = error as { code?: string; message?: string }
  if (code === 'learning/model/truncated') return '这一节有一部分内容太长，拆开后仍超出模型单次能写的长度，请稍后重试'
  if (code === 'learning/core/conflict') return '生成期间这一节的教材文件被修改过（可能是在应用外编辑），没有覆盖。要按现在的设计书重写，请再生成一次'
  return message ?? String(error)
}

/** "12 段，2 段待核实；习题要用、资料里没有讲到：A" for handoffs and the brief. */
function summaryOf(status: LessonTextbookStatus): string {
  const check = status.check
  return [
    `${status.blocks ?? 0} 段`,
    status.unverified ? `，${status.unverified} 段待核实` : '',
    check?.stale ? `，${check.stale} 段核对后改过` : '',
    check?.state === 'unchecked' ? '，讲解没有核对完' : '',
    ...(check?.notes ?? []).map(note => `；${note}`),
    status.missing?.length ? `；习题要用、资料里没有讲到：${status.missing.join('、')}` : '',
    status.uncovered?.length ? `；这些知识点正文没有讲到：${status.uncovered.join('、')}` : '',
  ].join('')
}

/** What one point gets besides its own material: chunks and web pages found for its gaps, and gaps found nowhere. */
interface Supplement {
  readonly local: CitedChunk[]
  readonly web: WebUse[]
  readonly missing: string[]
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
    if (run ? run.state === 'queued' || run.state === 'running' : this.inFlight.has(lessonId)) {
      return {
        state: 'running',
        message: run?.message ?? '',
        ...(run?.step && run.startedAt ? { progress: { step: run.step, startedAt: run.startedAt, points: run.points } } : {}),
        ...(run?.draft ? { draft: run.draft } : {}),
      }
    }
    const lesson = this.ctx.learnCurriculum.lesson(lessonId)
    const stage = lesson ? this.ctx.learnCurriculum.stage(lesson.stageId) : undefined
    const blocks = lesson?.textbookFile && stage ? this.blocks(stage.courseId, lesson.textbookFile) : []
    if (run?.state === 'failed') return { state: 'failed', message: run.message, failures: run.failures, ...(blocks.length ? { blocks: blocks.length } : {}) }
    if (blocks.length === 0) return { state: 'missing' }
    const checks = this.checks(stage!.courseId, lesson!.textbookFile!)
    return {
      state: 'ready',
      blocks: blocks.length,
      unverified: blocks.filter(block => block.unverified).length,
      ...(run?.uncovered.length ? { uncovered: run.uncovered } : {}),
      ...(run?.missing.length ? { missing: run.missing } : {}),
      ...(checks.size || run?.checked === false ? {
        check: {
          state: run?.checked === false ? 'unchecked' : 'checked',
          stale: blocks.filter(block => checks.has(block.id) && checks.get(block.id)!.hash !== block.hash).length,
          notes: run?.notes ?? [],
        },
      } : {}),
    }
  }

  private checkDeps(lessonId: string) {
    return {
      ctx: this.ctx, model: this.config.checkModel.get(), signal: this.stopping.signal,
      reply: (input: { readonly system: string; readonly prompt: string; readonly maxTokens: number }, write: () => Promise<string[]>) => this.reply(lessonId, { ...input, model: this.config.checkModel.get() }, write),
    }
  }

  /** Contradicted paragraphs of a checked draft, rewritten against the material once; the rest as checked. */
  private async correct(lesson: Lesson, courseId: string, material: readonly CitedChunk[], stems: readonly string[], outcome: CheckOutcome, newId: () => string): Promise<CheckOutcome> {
    const wrong = [...outcome.checks].filter(([, check]) => check.verdict === 'contradicted').map(([id]) => id).slice(0, REVISE_LIMIT)
    if (wrong.length === 0) return outcome
    this.progress(lesson, courseId, { state: 'running', message: `正在按原文改正 ${lesson.number} 里和原文不一致的 ${wrong.length} 段` })
    const texts = new Map(indexBlocks(outcome.body).map(block => [block.id, block.text]))
    const reasons = wrong.map(id => reasonOf(texts.get(id) ?? '', outcome.checks.get(id)!)).join('；')
    try {
      const fixed = await this.revise(lesson, courseId, material, stems, outcome.body, wrong, `核对发现这些段落和资料原文不一致：${reasons}。按原文改正不一致的地方，其余照旧。`, newId)
      const checks = new Map(outcome.checks)
      for (const id of wrong) checks.delete(id)
      for (const [id, item] of fixed.checks) checks.set(id, item)
      return { body: fixed.body, checks, checked: outcome.checked && fixed.checked, notes: [...outcome.notes, ...fixed.notes] }
    } catch (error) {
      if (this.stopping.signal.aborted) throw error
      return { ...outcome, notes: [...outcome.notes, `按原文改正没有完成：${(error as Error).message}`] }
    }
  }

  /**
   * Rewrite `targets` of `body` (no frontmatter) by `instruction` from the chunks they cite and their
   * neighbours in the lesson's material, then check the paragraphs that came out.
   */
  private async revise(lesson: Lesson, courseId: string, material: readonly CitedChunk[], stems: readonly string[], body: string, targets: readonly string[], instruction: string, newId: () => string) {
    const blocks = indexBlocks(body)
    const cited = new Set(blocks.filter(block => targets.includes(block.id)).flatMap(block => block.citations))
    const near = material.filter((_, index) => material.slice(Math.max(0, index - 2), index + 3).some(chunk => cited.has(chunk.id)))
    const others = [...cited].filter(id => !near.some(chunk => chunk.id === id)).flatMap(id => { const chunk = this.ctx.learnLibrary.chunk(id); return chunk ? [chunk] : [] })
    const around = blocks.flatMap((block, index) => {
      if (targets.includes(block.id)) return []
      const before = blocks[index + 1] && targets.includes(blocks[index + 1]!.id), after = blocks[index - 1] && targets.includes(blocks[index - 1]!.id)
      return before || after ? [{ text: block.text, after: before ? '在要改的段落前面' : '在要改的段落后面' }] : []
    })
    const reply = await complete(this.ctx, {
      system: REVISER_SYSTEM,
      prompt: revisionPrompt({ heading: `${lesson.number} ${lesson.title}`, instruction, targets: blocks.filter(block => targets.includes(block.id)).map(block => ({ id: block.id, text: block.text })), around, material: [...near, ...others] }),
      purpose: 'learning-textbook', model: this.config.model.get(), maxTokens: WRITER_MAX_TOKENS, signal: this.stopping.signal,
    })
    const revised = parseRevision(reply, targets)
    if (revised.size === 0) throw new Error('模型没有按格式给出改好的段落，教材没有改动')
    const known = new Set<string>([...near, ...others].map(chunk => chunk.id))
    const applied = applyRevision(body, revised, { knownChunk: id => known.has(id), embed: { order: material, extra: others }, newBlockId: newId })
    const changed = new Set([...applied.into.values()].flat())
    const outcome = await checkPoint({ ...this.checkDeps(lesson.id), reply: (_input, write) => write() }, { body: applied.body, chunks: [...near, ...others].map(toCheck), stems, only: changed })
    return { ...outcome, into: applied.into }
  }

  async reviseBlocks(lessonId: string, input: { readonly blockIds: readonly string[]; readonly instruction: string }, meta: ChangeMeta) {
    const lesson = must(this.ctx.learnCurriculum.lesson(lessonId), 'textbook', '课时', lessonId)
    const stage = must(this.ctx.learnCurriculum.stage(lesson.stageId), 'textbook', '阶段', lesson.stageId)
    const courseId = stage.courseId
    const file = lesson.textbookFile!
    if (this.running().includes(lessonId)) throw new LearningApiError('learning/textbook/busy', `${lesson.number} 的教材正在生成，等生成完再改`)
    const current = await this.ctx.learnCore.files.read(courseId, file)
    if (!current) throw new LearningApiError('learning/textbook/missing', `${lesson.number} 还没有教材，先生成`)
    const targets = [...new Set(input.blockIds)]
    if (targets.length === 0 || targets.length > REVISE_LIMIT) throw new LearningApiError('learning/textbook/too-many', `一次改 1 到 ${REVISE_LIMIT} 段；要重写整节，就重新生成`)
    const present = indexBlocks(current.text)
    const unknown = targets.filter(id => !present.some(block => block.id === id))
    if (unknown.length) throw new LearningApiError('learning/textbook/no-block', `${lesson.number} 的教材里没有这些段落：${unknown.join('、')}。段落编号是每段末尾 ^ 后面的 6 位编号`)
    const originals = targets.filter(id => present.find(block => block.id === id)!.original)
    if (originals.length) throw new LearningApiError('learning/textbook/original', `这些段落是资料原文，原样引用，不能改写：${originals.join('、')}。可以改它们前后的讲解，或者重新生成本节`)
    const newId = this.idMaker(courseId)
    const { data, body } = parseFrontmatter(current.text)
    const material = this.material(courseId, lesson)
    const result = await this.revise(lesson, courseId, material, stemsOf(this.exercises(material)), body, targets, input.instruction, newId)
    const text = withFrontmatter({ ...data, version: Number(data.version ?? 0) + 1, revisedAt: now() }, result.body)
    const change = await this.ctx.learnCore.files.write(courseId, file, text, { ...meta, size: meta.size ?? 'minor' }, { ifHash: current.hash })
    const removed = [...result.into].filter(([, into]) => into.length === 0).map(([id]) => id)
    this.ctx.learnCore.db.transaction(() => {
      this.sqlite.prepare(`DELETE FROM textbook_checks WHERE course_id = ? AND block_id IN (${removed.map(() => '?').join(', ') || "''"})`).run(courseId, ...removed)
      this.keepChecks(courseId, file, indexBlocks(text), result.checks)
      this.record(courseId, [...result.into].map(([blockId, into]) => ({ blockId, into: [...into], changeId: change.id, reason: input.instruction })))
    })
    this.reindex(courseId, file, text)
    const added = [...result.into.values()].reduce((sum, into) => sum + Math.max(0, into.length - 1), 0)
    const texts = new Map(indexBlocks(text).map(block => [block.id, block.text]))
    const unverified = [...result.checks].filter(([, check]) => flagged(check)).map(([id, check]) => reasonOf(texts.get(id) ?? '', check))
    return { revised: targets.length - removed.length, added, removed: removed.length, unverified, notes: [...result.notes] }
  }

  revisions(courseId: string, blockId: string): BlockRevision[] {
    const rows = this.sqlite.prepare('SELECT data FROM textbook_revisions WHERE course_id = ? AND block_id = ? ORDER BY id').all(courseId, blockId) as { data: string }[]
    return rows.map(row => JSON.parse(row.data) as BlockRevision)
  }

  /** Remember where paragraphs went. */
  private record(courseId: string, items: readonly Omit<BlockRevision, 'at'>[]): void {
    const at = now()
    const insert = this.sqlite.prepare('INSERT INTO textbook_revisions (course_id, block_id, data) VALUES (?, ?, ?)')
    for (const item of items) insert.run(courseId, item.blockId, JSON.stringify({ ...item, at }))
  }

  /** Keep the checks of these paragraphs, bound to their text in `blocks`. */
  private keepChecks(courseId: string, file: string, blocks: readonly { readonly id: string; readonly hash: string }[], checks: ReadonlyMap<string, ParagraphCheck>): void {
    const checkedAt = now()
    const insert = this.sqlite.prepare('INSERT OR REPLACE INTO textbook_checks (course_id, block_id, file, data) VALUES (?, ?, ?, ?)')
    for (const block of blocks) {
      const check = checks.get(block.id)
      if (check) insert.run(courseId, block.id, file, JSON.stringify(BlockCheck.parse({ ...check, sources: [...check.sources], hash: block.hash, checkedAt })))
    }
  }

  private lessonOf(courseId: string, file: string): Lesson | undefined {
    return this.ctx.learnCurriculum.stages(courseId).flatMap(stage => this.ctx.learnCurriculum.lessons(stage.id)).find(item => item.textbookFile === file)
  }

  /** The paragraphs of a lesson the reader marks in the margin: to read with care, not checked, or edited since. */
  checkMarks(lessonId: string): Record<string, CheckState> {
    const lesson = this.ctx.learnCurriculum.lesson(lessonId)
    const stage = lesson ? this.ctx.learnCurriculum.stage(lesson.stageId) : undefined
    if (!lesson?.textbookFile || !stage) return {}
    const checks = this.checks(stage.courseId, lesson.textbookFile)
    const marks: Record<string, CheckState> = {}
    for (const block of this.blocks(stage.courseId, lesson.textbookFile)) {
      const check = checks.get(block.id)
      if (block.unverified) marks[block.id] = 'flagged'
      else if (check && check.hash !== block.hash) marks[block.id] = 'stale'
      else if (check?.verdict === 'unchecked') marks[block.id] = 'unchecked'
    }
    return marks
  }

  /** One paragraph's sources (with their text) and check, in the learner's words. No internal ids beyond what opens a source. */
  async blockInfo(courseId: string, blockId: string): Promise<BlockInfo | undefined> {
    const block = await this.block(courseId, blockId)
    if (!block) return undefined
    const file = await this.ctx.learnCore.files.read(courseId, block.file)
    const indexed = file ? indexBlocks(file.text).find(item => item.id === blockId) : undefined
    const check = this.checks(courseId, block.file).get(blockId)
    const current = check && check.hash === block.hash ? check : undefined
    const ids = [...new Set([...block.citations, ...current?.sources.filter(id => id.startsWith('ck_')) ?? []])].slice(0, 4)
    const sources = ids.flatMap(id => {
      const chunk = this.ctx.learnLibrary.chunk(id)
      if (!chunk) return []
      const text = chunk.kind === 'figure' ? chunk.text.split('\n')[0]! : chunk.text
      return [{ chunkId: chunk.id, citation: chunk.citation, text: [...text].length > 240 && !text.includes('$') ? `${[...text].slice(0, 238).join('')}…` : text }]
    })
    const lesson = this.lessonOf(courseId, block.file)
    const pages = lesson ? this.runOf(lesson.id)?.web ?? [] : []
    const links = [...block.text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map(match => match[1]!)
    const web = pages.filter(page => links.includes(page.url)).map(page => ({ url: page.url, title: page.title, site: page.site, passage: page.passages[0] ?? '' }))
    const revision = this.revisions(courseId, blockId).filter(item => item.into[0] === blockId && item.reason !== '重新生成本节').at(-1)
    const kind = block.original ? 'original' : indexed?.recall ? 'recall' : 'explanation'
    const state = block.unverified ? 'flagged' : check && check.hash !== block.hash ? 'stale' : current?.verdict === 'unchecked' ? 'unchecked' : current ? 'ok' : 'none'
    const note = block.unverified && !current ? '这段在旧版教材里标了待核实；重新生成后会按新规则核对' : current?.note ?? ''
    return {
      kind, state, note, sources, web,
      ...(revision ? { revised: [...revision.reason].length > 60 ? `${[...revision.reason].slice(0, 58).join('')}…` : revision.reason } : {}),
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
    const restart = fresh ? { run: randomUUID().slice(0, 8), parts: {}, points: [], draft: undefined, step: undefined, startedAt: undefined, missing: [], web: [], notes: [], checked: undefined } : {}
    const run = this.saveRun(Run.parse({ lessonId: lesson.id, courseId, stageId: lesson.stageId, ...previous, ...restart, ...patch, updatedAt: now() }))
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
    return chunks.filter(chunk => (TEACHING_KINDS as readonly string[]).includes(chunk.kind) && !chunk.problemGroup && !chunk.section.some(part => /^(习题|复习思考题|思考题)/.test(part)))
  }

  /**
   * The exercises of the chapter the material belongs to, in the same source: what the lesson should
   * prepare the learner for (docs/textbook/design.md, 讲解与原文). Only their stems are shown when planning.
   */
  private exercises(material: readonly CitedChunk[]): CitedChunk[] {
    const first = material[0]
    if (!first) return []
    const chapter = first.section.length > 1 ? first.section[0] : undefined
    return this.ctx.learnLibrary.chunks(first.sourceId).filter(chunk => chunk.kind === 'exercise' && (chapter ? chunk.section[0] === chapter : chunk.section.length <= 1))
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

  /** New block ids, unique in the course. */
  private idMaker(courseId: string): () => string {
    const taken = new Set<string>((this.sqlite.prepare('SELECT block_id FROM textbook_blocks WHERE course_id = ?').all(courseId) as { block_id: string }[]).map(row => row.block_id))
    return () => {
      let id = newBlockId()
      while (taken.has(id)) id = newBlockId()
      taken.add(id)
      return id
    }
  }

  /** The lesson's points: from one planning reply, or by subsection (with why) when the reply is unusable. */
  private async plan(lesson: Lesson, heading: string, prompt: string, material: readonly CitedChunk[], stems: readonly string[]): Promise<{ readonly points: Point[]; readonly failed?: string }> {
    const input = { system: PLAN_SYSTEM, prompt, maxTokens: PLAN_MAX_TOKENS, model: this.config.model.get() }
    try {
      const [text] = await this.reply(lesson.id, input, async () => {
        const text = await complete(this.ctx, { ...input, purpose: 'learning-textbook-plan', signal: this.stopping.signal })
        if (!readPlan(parseJsonReply(text), material, stems)) throw new Error('要点规划没有给出可用的要点')
        return [text]
      })
      return { points: readPlan(parseJsonReply(text!), material, stems)! }
    } catch (error) {
      if (this.stopping.signal.aborted) throw error
      this.ctx.logger('learning-textbook').warn('lesson %s: planning failed, writing by subsection: %s', lesson.number, (error as Error).message)
      return { points: fallbackPoints(material, heading, PART_LIMIT), failed: (error as Error).message }
    }
  }

  /**
   * What the exercises need that the lesson's material does not explain (a few at most): the course's other
   * material first, then one web page of authority 1–2, read and quoted by its address, never added to the
   * library (10-15). A need found nowhere is said to be missing.
   */
  private async supplement(courseId: string, points: readonly Point[], material: readonly CitedChunk[]): Promise<Supplement[]> {
    const out: Supplement[] = points.map(() => ({ local: [], web: [], missing: [] }))
    const own = new Set(material.map(chunk => chunk.id))
    const gaps = points.flatMap((point, index) => point.needs.filter(need => !need.covered).map(need => ({ index, need: need.text })))
    const library = this.ctx.learnLibrary
    for (const [at, gap] of gaps.entries()) {
      if (at >= GAP_LIMIT) { out[gap.index]!.missing.push(gap.need); continue }
      const retrieval = await library.retrieve(gap.need, { courseId, kinds: TEACHING_KINDS, limit: 6 })
      const keywords = termsOf(gap.need) ? library.search(termsOf(gap.need), { courseId, kinds: TEACHING_KINDS, limit: 6 }) : []
      const local = [...(retrieval.gap ? [] : retrieval.hits), ...keywords].map(hit => hit.chunk)
        .filter((chunk, index, all) => !own.has(chunk.id) && chunk.kind !== 'heading' && all.findIndex(other => other.id === chunk.id) === index).slice(0, 4)
      if (local.length) { out[gap.index]!.local.push(...local); continue }
      const page = this.config.webCheck.get() ? await this.webPage(gap.need) : undefined
      if (page) out[gap.index]!.web.push(page)
      else out[gap.index]!.missing.push(gap.need)
    }
    return out
  }

  /** One page of authority 1–2 that explains `need`, with its passages closest to it. */
  private async webPage(need: string): Promise<WebUse | undefined> {
    const library = this.ctx.learnLibrary
    try {
      const found = await library.searchWeb([need], { signal: this.stopping.signal })
      const picks = found.candidates.filter(candidate => (candidate.authority === '1' || candidate.authority === '2') && candidate.format === 'html').slice(0, 2)
      for (const pick of picks) {
        const page = await library.readWeb(pick.url, this.stopping.signal)
        if (page.status !== 'read') continue
        const passages = page.passages.filter(passage => [...passage].length >= 20)
          .sort((a, b) => overlap(need, b) - overlap(need, a)).slice(0, WEB_PASSAGES)
          .map(passage => ([...passage].length > PASSAGE_CHARS ? `${[...passage].slice(0, PASSAGE_CHARS).join('')}…` : passage))
        if (passages.length && overlap(need, passages[0]!) > 0) return { url: page.url, title: pick.title || page.title, site: page.site, level: `${page.authority === '1' ? '一级' : '二级'}（${page.rule}）`, passages }
      }
    } catch (error) {
      if (this.stopping.signal.aborted) throw error
      this.ctx.logger('learning-textbook').warn('web supplement failed: %s', (error as Error).message)
    }
    return undefined
  }

  /**
   * Write one point (or a part of one). A reply cut off at the output limit is retried as two halves of
   * the material; the second half goes on without a heading. A single chunk that does not fit is reported.
   */
  private async writePoint(lessonId: string, prompt: (chunks: readonly CitedChunk[], first: boolean) => string, chunks: readonly CitedChunk[], first: boolean, depth = 0): Promise<{ text: string; first: boolean }[]> {
    const input = { system: WRITER_SYSTEM, prompt: prompt(chunks, first), maxTokens: WRITER_MAX_TOKENS, model: this.config.model.get() }
    try {
      const [text = ''] = await this.reply(lessonId, input, async () => [await complete(this.ctx, { ...input, purpose: 'learning-textbook', signal: this.stopping.signal })])
      return [{ text, first }]
    } catch (error) {
      if ((error as { code?: string }).code !== 'learning/model/truncated' || chunks.length < 2 || depth >= 2) throw error
      const [head, tail] = halve(chunks)
      return [...await this.writePoint(lessonId, prompt, head, first, depth + 1), ...await this.writePoint(lessonId, prompt, tail, false, depth + 1)]
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
    // The clock starts when the writing does: a lesson cut off by a restart keeps its start.
    const startedAt = previous?.state === 'running' && previous.startedAt ? previous.startedAt : now()
    this.progress(lesson, courseId, { state: 'running', message: `正在整理 ${heading} 的要点`, step: 'plan', startedAt, points: [], draft: undefined })
    try {
      const chunks = this.material(courseId, lesson)
      if (chunks.length === 0) throw new Error(`资料库里找不到 ${heading} 的资料，先把骨架教材加入本课`)
      const known = new Set<string>(chunks.map(chunk => chunk.id))
      const design = await this.ctx.learnCore.files.read(courseId, `${stage.folder}/${STAGE_LAYOUT.design}`)
      const goal = await this.ctx.learnCore.files.read(courseId, COURSE_LAYOUT.goal)
      const parent = stage.kind === 'remedial' && stage.remedialOf ? this.ctx.learnCurriculum.stage(stage.remedialOf) : undefined
      const review = parent ? await this.ctx.learnCore.files.read(courseId, `${parent.folder}/${STAGE_LAYOUT.review}`) : undefined
      const remedial = stage.kind === 'remedial'
      const mastery = this.masteryOf(courseId, lesson, chunks)
      const context = [
        goal ? `# 学习目标\n${parseFrontmatter(goal.text).body.slice(0, 2000)}` : '',
        design ? `# 阶段设计书（测试部分已略去）\n${teachingPartOf(parseFrontmatter(design.text).body)}` : '',
        mastery ? `# 学习者对本课知识点的掌握（按作答证据；阅读和聊天不算已会）\n${mastery}` : '',
        remedial ? `# 补课\n${REMEDIAL_NOTE}${review ? `\n\n## 上一阶段的复盘\n${parseFrontmatter(review.text).body.trim()}` : ''}` : '',
      ].filter(Boolean).join('\n\n')

      // 1. The points, with what the chapter's exercises need; the writer never sees the exercises.
      const stems = stemsOf(this.exercises(chunks))
      const { points, failed: planning } = await this.plan(lesson, heading, planPrompt({ context, material: chunks, stems, remedial }), chunks, stems)
      // 2. Needs the material does not explain: other course material, then the web.
      const extra = await this.supplement(courseId, points, chunks)
      const web = extra.flatMap(item => item.web)
      const missing = extra.flatMap(item => item.missing)
      this.progress(lesson, courseId, {
        state: 'running', step: 'write', message: `正在编写 ${heading}（0/${points.length} 个要点）`,
        points: points.map(point => ({ title: point.title, done: false })), web, missing,
      })

      // 3. Each point, two at a time; a lesson of one point is written whole, with its recall questions.
      const single = points.length === 1
      const outline = points.map((point, index) => `${index + 1}. ${point.title}`).join('\n')
      const prompt = (index: number) => (part: readonly CitedChunk[], first: boolean) => {
        const point = points[index]!
        const { local, web: pages, missing: absent } = extra[index]!
        const scope = remedial && single
          ? '补课课时，按上面"补课"的要求写，不写整节。最后一个 "### 读完就答" 子标题下给 2 个凭记忆作答的小问题（不给答案），问这次补的地方。'
          : !first ? '这一点的资料较长，分两次写，这是后半部分：接着前面写，不要写标题，也不要写开场白。'
            : single ? '这一节只有这一个要点：直接写正文，不写标题。最后一个 "### 读完就答" 子标题下给 2 个凭记忆作答的小问题（不给答案）。'
              : `用 "### ${point.title}" 开头，只写这一点，不写本节总结，也不写"读完就答"。`
        return [
          context,
          `# 本节：${heading}${single ? '' : `\n本节的要点依次是：\n${outline}\n这次写第 ${index + 1} 个。`}`,
          `# 这次写：${point.title}${point.focus ? `\n要讲清：${point.focus}` : ''}`,
          point.needs.length ? `# 做练习要会的（只讲道理，不出题、不提习题）\n${point.needs.map(need => `- ${need.text}${need.covered ? '' : absent.includes(need.text) ? '（资料里找不到，不要讲）' : '（本节资料没讲，见补充资料）'}`).join('\n')}` : '',
          `# 写法\n${scope}`,
          `# 资料片段（只能引用和嵌入这些 ID）\n${materialOf(part)}`,
          local.length && first ? `# 补充资料（为"做练习要会的"找来的，可以引用，也可以单独嵌入）\n${materialOf(local)}` : '',
          pages.length && first ? `# 网页摘录（引用时写成 [网页标题](网址)，不能嵌入）\n${pages.map(page => `[${page.title}](${page.url}) · ${page.site} · ${page.level}\n${page.passages.join('\n\n')}`).join('\n\n')}` : '',
        ].filter(Boolean).join('\n\n')
      }
      const taken = this.idMaker(courseId)
      // A paragraph that reads exactly as before keeps its id (annotations stay on it); each old id is used once.
      const unchanged = new Map<string, string[]>()
      for (const block of before ? indexBlocks(before.text) : []) unchanged.set(block.text, [...unchanged.get(block.text) ?? [], block.id])
      const bodies: (string | undefined)[] = new Array(points.length)
      const dropped: string[] = []
      const draftOf = () => [`## ${heading}`, ...points.map((point, index) => bodies[index] ?? `### ${point.title}\n\n（正在写…）`)].join('\n\n')
      let failure: { readonly error: unknown } | undefined
      const queue = points.map((_, index) => index)
      await Promise.all([0, 1].map(async () => {
        for (let index = queue.shift(); index !== undefined && !failure; index = queue.shift()) {
          try {
            const point = points[index]!
            const parts = await this.writePoint(lesson.id, prompt(index), point.chunks, true)
            const text = parts.map((part, at) => pointText(part.text, part.first && !single ? point.title : undefined, single && at === parts.length - 1)).join('\n\n')
            const { local, web: pages } = extra[index]!
            const done = finalize(text, {
              knownChunk: id => known.has(id) || local.some(chunk => chunk.id === id),
              knownUrl: url => pages.some(page => page.url === url),
              embed: { order: chunks, extra: local },
              newBlockId: taken,
              reuse: piece => unchanged.get(piece)?.shift(),
            })
            // Something the material does not explain, said where it was needed.
            const absent = extra[index]!.missing
            bodies[index] = absent.length ? `${done.body.trim()}\n\n> [!note] 资料里没有讲到：${absent.join('；')}。可以问主老师，或在资料库里加一份讲它的资料。` : done.body.trim()
            dropped.push(...done.dropped)
          } catch (error) {
            failure ??= { error }
            return
          }
          const run = this.runOf(lesson.id)!
          const marked = run.points.map((point, at) => (at === index ? { ...point, done: true } : point))
          this.progress(lesson, courseId, { state: 'running', step: 'write', points: marked, draft: draftOf(), message: `正在编写 ${heading}（已完成 ${marked.filter(point => point.done).length}/${points.length} 个要点）` })
        }
      }))
      if (failure) throw failure.error
      // Written in more than one reply: the recall questions are asked over the whole section.
      let questions = ''
      if (!single) {
        const input = { system: QUESTIONS_SYSTEM, prompt: `# 小节\n${heading}\n\n# 教材正文\n${bodies.join('\n\n')}`, maxTokens: 4000, model: this.config.model.get() }
        const [reply = ''] = await this.reply(lesson.id, input, async () => [(await complete(this.ctx, { ...input, purpose: 'learning-textbook', signal: this.stopping.signal })).trim()])
        const text = /读完就答/.test(reply) ? reply.slice(reply.search(/#*\s*读完就答/)).replace(/^#*\s*读完就答/, '### 读完就答') : `### 读完就答\n\n${reply}`
        questions = finalize(text, { knownChunk: () => false, newBlockId: taken, reuse: piece => unchanged.get(piece)?.shift() }).body.trim()
      }

      // 4. Each point's explanation, three at a time (a check thinks far longer than a writer). A short section is
      //    checked whole, so a point may build on what an earlier one explained; a long one gives each point its
      //    own material and what it cites.
      this.progress(lesson, courseId, { state: 'running', step: 'check', message: `正在核对 ${heading} 的讲解`, draft: draftOf() })
      const checked: CheckOutcome[] = new Array(points.length)
      const pending = points.map((_, index) => index)
      const deps = this.checkDeps(lesson.id)
      const whole = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) <= CHECK_WHOLE
      await Promise.all([0, 1, 2].map(async () => {
        for (let index = pending.shift(); index !== undefined; index = pending.shift()) {
          const { local, web: pages } = extra[index]!
          const own = points[index]!.chunks
          const cited = new Set(indexBlocks(bodies[index]!).flatMap(block => block.citations))
          const material = whole ? chunks : chunks.filter(chunk => own.includes(chunk) || cited.has(chunk.id))
          checked[index] = await checkPoint(deps, { body: `${bodies[index]!}\n`, chunks: [...material, ...local].map(toCheck).concat(webChunks(pages)), stems })
        }
      }))
      const joined: CheckOutcome = {
        body: `${[`## ${heading}`, ...checked.map(outcome => outcome.body.trim()), questions].filter(Boolean).join('\n\n')}\n`,
        checks: new Map(checked.flatMap(outcome => [...outcome.checks])),
        checked: checked.every(outcome => outcome.checked),
        notes: checked.flatMap(outcome => outcome.notes),
      }
      // Paragraphs the material contradicts are rewritten against it once before the lesson is published.
      const outcome = await this.correct(lesson, courseId, [...chunks, ...extra.flatMap(item => item.local)], stems, joined, taken)
      const notes = [
        ...outcome.notes,
        ...web.map(page => `联网补充：《${page.title}》（${page.url}）`),
        ...(planning ? [`列要点没有成功，按小标题分了要点：${planning}`] : []),
        ...(dropped.length ? [`${dropped.length} 处出处或嵌入无效，已去掉`] : []),
      ]
      const run = this.saveRun({ ...this.runOf(lesson.id)!, step: 'publish', checked: outcome.checked, notes, pending: Object.fromEntries([...outcome.checks].map(([id, check]) => [id, CheckRow.parse({ ...check, sources: [...check.sources] })])) }).run
      const version = Number(before ? parseFrontmatter(before.text).data.version ?? 0 : 0) + 1
      const text = withFrontmatter({ lesson: lesson.id, title: heading, version, generatedAt: now(), run }, outcome.body)
      // Not over a file that changed while the lesson was written (an outside edit, another writer).
      const change = await this.ctx.learnCore.files.write(courseId, file, text, {
        actor: 'system',
        reason: `生成教材 ${lesson.number}${dropped.length ? `（${dropped.length} 处无效出处或嵌入已去掉）` : ''}`,
        size: before ? 'major' : 'minor',
      }, { ifHash: before?.hash ?? null })
      // Paragraphs of the old version that did not survive: their annotations can still find the old text.
      const kept = new Set(indexBlocks(text).map(block => block.id))
      this.record(courseId, (before ? indexBlocks(before.text) : []).filter(block => !kept.has(block.id)).map(block => ({ blockId: block.id, into: [], changeId: change.id, reason: '重新生成本节' })))
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

  /** The file is written: keep its check, index it, mark the run done, then tell the stage and the teacher once. */
  private publish(lesson: Lesson, courseId: string, text: string): void {
    const file = lesson.textbookFile!
    const pending = this.runOf(lesson.id)?.pending
    if (pending) {
      this.ctx.learnCore.db.transaction(() => {
        this.sqlite.prepare('DELETE FROM textbook_checks WHERE course_id = ? AND file = ?').run(courseId, file)
        this.keepChecks(courseId, file, indexBlocks(text), new Map(Object.entries(pending)))
      })
    }
    const { uncovered } = this.reindex(courseId, file, text)
    this.progress(lesson, courseId, { state: 'ready', message: '', failures: 0, parts: {}, uncovered, pending: undefined, draft: undefined, step: undefined })
    const summary = summaryOf(this.status(lesson.id))
    this.progress(lesson, courseId, { state: 'ready', message: summary })
    this.ctx.emit('learning/textbook-ready', { courseId, stageId: lesson.stageId, lessonId: lesson.id })
    this.ctx.emit('learning/handoff', { courseId, unit: 'textbook', text: `教材 ${lesson.number} ${lesson.title} 已生成（${summary}）。` })
  }

  async generateStage(stageId: string): Promise<void> {
    const stage = must(this.ctx.learnCurriculum.stage(stageId), 'textbook', '阶段', stageId)
    // In lesson order, so the first lesson is ready (and the stage can start) as early as possible;
    // a lesson's points are written two at a time. Each lesson reports its own outcome.
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
   * The lesson's knowledge points with the learner's state on each and how to write it, one line each;
   * empty when the lesson has none. A node's state in this course counts before its state overall.
   */
  private masteryOf(courseId: string, lesson: Lesson, material: readonly CitedChunk[]): string {
    const { nodes, candidates } = this.candidates(courseId, lesson, material.map(chunk => chunk.id), [])
    const own = nodes.filter(node => candidates.has(node.id)).slice(0, 30)
    const states = new Map(this.ctx.learnLearner.states(own.map(node => node.id)).map(state => [state.nodeId as string, state]))
    return own.map(node => {
      const overall = states.get(node.id)
      const state = overall?.courses.find(entry => entry.courseId === courseId) ?? overall
      // Asked about again and again: written out in full, whatever the answers say.
      const kind: MasteryState = state?.doubtful ? 'conflict' : state?.state ?? 'untested'
      const how = MASTERY[kind]
      const label = state?.doubtful ? `${MASTERY[state.state].label}，反复提问过` : MASTERY[state?.state ?? 'untested'].label
      return `- ${node.title}：${label}${state?.explanation ? `（${state.explanation.replace(/。$/, '')}）` : ''}。${how.write}。`
    }).join('\n')
  }

  /** Knowledge points the lesson may explain: the stage's core nodes, those sourced in its material or in `cited`. */
  private candidates(courseId: string, lesson: Lesson | undefined, material: readonly string[], cited: readonly string[]) {
    const stage = lesson ? this.ctx.learnCurriculum.stage(lesson.stageId) : undefined
    const nodes = this.ctx.learnKnowledge.graph(courseId).nodes
    const sourced = new Map<string, Set<string>>()
    for (const source of this.ctx.learnKnowledge.sourceLayer(courseId).sources) {
      for (const link of source.links) for (const chunk of link.chunks) sourced.set(chunk.id, (sourced.get(chunk.id) ?? new Set()).add(link.nodeId))
    }
    const inChunks = (ids: readonly string[]) => new Set(ids.flatMap(id => [...sourced.get(id) ?? []]))
    const expected = inChunks(material)
    return { nodes, inChunks, expected, candidates: new Set([...stage?.nodeIds ?? [], ...expected, ...inChunks(cited)]) }
  }

  /**
   * Knowledge points the lesson's paragraphs may explain (docs/textbook/design.md, 知识关联): the stage's
   * core nodes and those sourced in the lesson's material or in a chunk the file cites. A paragraph is
   * linked to one when it cites a chunk the node is sourced in, or names it by a title or alias no
   * other node of the course shares; a recall question explains nothing and is linked to none.
   */
  private linker(courseId: string, file: string, cited: readonly string[]) {
    const lesson = this.lessonOf(courseId, file)
    const material = lesson ? this.material(courseId, lesson).map(chunk => chunk.id) : []
    const { nodes, inChunks, expected, candidates } = this.candidates(courseId, lesson, material, cited)
    const names = (node: (typeof nodes)[number]) => [node.title, ...node.aliases].map(name => name.trim()).filter(name => [...name].length >= 2)
    const shared = new Map<string, number>()
    for (const node of nodes) for (const name of new Set(names(node))) shared.set(name, (shared.get(name) ?? 0) + 1)
    const named = nodes.filter(node => candidates.has(node.id)).map(node => ({ id: node.id, names: names(node).filter(name => shared.get(name) === 1) }))
    return {
      link: (block: { readonly text: string; readonly citations: readonly string[]; readonly recall: boolean }) => block.recall ? [] : [...new Set([
        ...inChunks(block.citations),
        ...named.filter(node => node.names.some(name => block.text.includes(name))).map(node => node.id),
      ])],
      /** Titles of the material's knowledge points no paragraph is linked to. */
      uncovered: (linked: ReadonlySet<string>) => nodes.filter(node => expected.has(node.id) && !linked.has(node.id)).map(node => node.title),
    }
  }

  /**
   * Rebuild the block index of one file and link blocks to the lesson's knowledge points. A paragraph is
   * unverified when its current check finds a problem, or when an older file says so in its text.
   */
  reindex(courseId: string, file: string, text: string | undefined): { blocks: Block[]; uncovered: string[] } {
    const indexed = text ? indexBlocks(text) : []
    const linker = this.linker(courseId, file, indexed.flatMap(block => block.citations))
    const checks = this.checks(courseId, file)
    const blocks = indexed.map(block => {
      const check = checks.get(block.id)
      return Block.parse({
        courseId, id: block.id, file, hash: block.hash, nodeIds: linker.link(block),
        citations: block.citations.filter(id => id.startsWith('ck_') && id.length === 29),
        unverified: block.unverified || (!!check && check.hash === block.hash && flagged(check)),
        original: block.original,
      })
    })
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
    method: 'checks',
    input: z.object({ lessonId: z.string() }),
    handle: ({ lessonId }) => textbook.checkMarks(lessonId),
  }), 'textbook: checks')

  ctx.effect(() => endpoint({
    unit: 'textbook',
    method: 'blockInfo',
    input: z.object({ courseId: z.string(), blockId: z.string() }),
    handle: async ({ courseId, blockId }) => (await textbook.blockInfo(courseId, blockId)) ?? null,
  }), 'textbook: block info')

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
      if (block) lines.push(`选中的教材段落（${picked.label}${block.original ? '，资料原文' : ''}，块 ${block.id}）：\n${block.text}`)
    }
    return lines
  })
}
