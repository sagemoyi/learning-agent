// textbook unit, host half. Provides `ctx.learnTextbook` (contracts §5.1): writes each stage's handout (讲义), one
// file its lessons share (docs/textbook/design.md), keeps the block index (ids, citations, unverified flags, linked
// nodes, the lesson each block is in), answers block lookups and takes the learner's own edits.
// One call plans the handout from the chapter's outline and its exercise stems; gaps are looked for in the course's
// other material and on the web; the terms and formulas, each section, the confusions and the problem types are
// written, then checked by the program alone (11-01: a handout is notes, no check model reads it again). A formula
// unlike the source, a number the material lacks, an exercise named or copied, a paragraph copied from the source or
// a section over its length is rewritten once. Each stage's generation is kept in `textbook_handouts`, so a restart
// resumes it and reuses the replies already written; what the check finds is kept in `textbook_checks`, bound to
// the paragraph's text.
import { createHash, randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  Block,
  COURSE_LAYOUT,
  LearningApiError,
  STAGE_LAYOUT,
  handoutFile,
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
  type Stage,
} from '@learning-agent/contracts'
import { complete, must, now, parseJsonReply } from '@learning-agent/kit'
import { roleModel, Schema } from '@learning-agent/kit/settings'
import { z } from 'zod'
import { checkOf, copiesOf, flagged, paragraphsOf, precheck, reasonOf, type ParagraphCheck, type Problem } from './check.ts'
import { finalize, halve, indexBlocks, isTable, replyBody, splitPieces, teachingPartOf } from './format.ts'
import {
  CONFUSIONS_SYSTEM, OVERVIEW_SYSTEM, OVER_CAP, PLAN_SYSTEM, SECTION_CAP, SECTION_EMBEDS, SECTION_SYSTEM, TYPES_SYSTEM,
  chunksNaming, confusionsTable, exampleWithSolution, formulaCell, formulaMaterial, formulasTable, hanCount, planPrompt,
  readConfusions, readOverview, readPlan, sectionHeading, sectionNumberOf, stemsOf, termMaterial, termsTable,
  type Cite, type HandoutPlan, type Section, type Term,
} from './handout.ts'
import { REVISER_SYSTEM, applyRevision, parseRevision, revisionPrompt } from './revise.ts'

export const name = 'learning-textbook'
export const inject = ['learnCore', 'learnCurriculum', 'learnLibrary', 'learnKnowledge', 'learnLearner', 'llm', 'sessionController']

export const Config = Schema.object({
  model: roleModel('写讲义'),
  // The key keeps its 10-09 name: learners who turned it off stay off.
  webCheck: Schema.boolean().default(true).description('写讲义时联网补找资料里没讲的内容').volatile(),
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
  // The sentence-by-sentence checks of 10-09 have no reader any more (docs/textbook/design.md).
  { version: 5, sql: 'DELETE FROM textbook_checks;' },
  // One generation per stage since 11-01 (a handout its lessons share); the lessons' own runs of before are dropped.
  {
    version: 6,
    sql: `
      CREATE TABLE textbook_handouts (
        stage_id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      DROP TABLE textbook_runs;
    `,
  },
]

/** Paragraphs a revision may rewrite at once. */
const REVISE_LIMIT = 8
/** Why a learner's own edit is recorded: their paragraphs are not checked, and a regeneration says it replaces them. */
const LEARNER_EDIT = '学习者在讲义页修改'
const REGENERATED = '重新生成讲义'

const CheckRow = z.object({
  verdict: z.enum(['ok', 'unsupported', 'contradicted', 'unchecked']),
  note: z.string(),
  sources: z.array(z.string()),
})

/** What the check found in one paragraph. Owner: textbook. `hash` is the paragraph's text when checked: an edit voids it. */
const BlockCheck = CheckRow.extend({
  hash: z.string(),
  checkedAt: z.string(),
})
type BlockCheck = z.infer<typeof BlockCheck>

/** A web page a handout quotes by its address: never added to the library (10-15). */
const WebUse = z.object({ url: z.string(), title: z.string(), site: z.string(), level: z.string(), passages: z.array(z.string()) })
type WebUse = z.infer<typeof WebUse>

/** One paragraph's sources and state, as the reader shows it when asked (`textbook.blockInfo`); client.tsx keeps the same shape. */
interface BlockInfo {
  readonly kind: 'original' | 'explanation' | 'recall'
  readonly state: 'flagged' | 'edited' | 'none'
  readonly note: string
  readonly sources: readonly { readonly chunkId: string; readonly citation: string; readonly text: string }[]
  readonly web: readonly { readonly url: string; readonly title: string; readonly site: string; readonly passage: string }[]
  /** What the teacher last revised the paragraph for. */
  readonly revised?: string
}

/** One stage's latest handout generation. Owner: textbook. */
const Run = z.object({
  stageId: z.string(),
  courseId: z.string(),
  /** Written into the published file's frontmatter, so a restart recognizes a run it already published. */
  run: z.string(),
  /** `conflict`: written, but the file changed since the run began; the handout is held for the learner to pick. */
  state: z.enum(['queued', 'running', 'ready', 'failed', 'conflict']),
  /**
   * The handout file as the run found it when it began (`null`: there was none). Publishing does not write over a
   * file that differs; a run resumed after a restart keeps it, so edits made while the program was stopped count.
   */
  base: z.object({ hash: z.string().nullable() }).optional(),
  /** The handout written over a changed file, held until the learner picks it or the file. */
  held: z.string().optional(),
  message: z.string().default(''),
  /** Failed attempts in a row since the last success. */
  failures: z.number().int().nonnegative().default(0),
  /** Model replies already written, by the hash of their whole input; dropped once the handout is published. */
  parts: z.record(z.string(), z.array(z.string())).default({}),
  /** Where the writing is, for the reader page. */
  step: z.enum(['plan', 'write', 'check', 'publish']).optional(),
  startedAt: z.string().optional(),
  points: z.array(z.object({ title: z.string(), done: z.boolean() })).default([]),
  /** The parts written so far, while the handout is being written. */
  draft: z.string().optional(),
  /** Knowledge points sourced in the stage's material that no paragraph explains. */
  uncovered: z.array(z.string()).default([]),
  /** What the chapter's exercises need that no material explains. */
  missing: z.array(z.string()).default([]),
  /** Web pages the handout quotes. */
  web: z.array(WebUse).default([]),
  notes: z.array(z.string()).default([]),
  /** What the check found in the text being published, by block id, kept until the file is written. */
  pending: z.record(z.string(), CheckRow).optional(),
  /** Model calls this run made and their tokens (thinking included in the output), for measuring. */
  usage: z.object({ calls: z.number().int(), input: z.number().int(), output: z.number().int() }).default({ calls: 0, input: 0, output: 0 }),
  updatedAt: z.string(),
})
type Run = z.infer<typeof Run>

/**
 * A remedial stage (docs/curriculum/design.md, 补课) mends what the stage review found instead of retelling the
 * sections: rereading the same explanation rarely fixes a misconception.
 */
const REMEDIAL_NOTE = `这是补课阶段：学习者已经学过这些小节，阶段测试暴露了下面复盘里写的问题。只讲这些没过的地方，不重写整节：
1. 先点明错在哪里、为什么容易错；
2. 换一种讲法讲清道理：把步骤拆开，对照常见错误；
3. 学习者已经会的内容一句带过。`

/** Output budgets; the model's thinking counts against them (a plan cut off is written without one). */
const WRITER_MAX_TOKENS = 16_000
const PLAN_MAX_TOKENS = 32_000
/** Gaps looked for outside the stage's material, and what is kept of a web page. */
const GAP_LIMIT = 3
const WEB_PASSAGES = 3
/** Knowledge points the learner already has that the terms may build on, and terms one call explains. */
const KNOWN_LIMIT = 15
const TERM_GROUP = 15
/** Chunks a confusion is told from. */
const CONFUSION_CHUNKS = 30
const PASSAGE_CHARS = 700
const QUEUED = '排队等待生成'
/** Writing calls at once. */
const WRITERS = 3

/** Material kinds a handout may draw on: exercises and their answers belong to assess (docs/assess/design.md). */
const TEACHING_KINDS = ['heading', 'text', 'formula', 'table', 'figure', 'example'] as const
const KIND_LABEL: Record<string, string> = { heading: '小标题', text: '正文', formula: '公式', table: '表', figure: '图', example: '例题' }

function materialOf(chunks: readonly CitedChunk[]): string {
  return chunks.map(chunk => {
    const bare = chunk.kind === 'figure' && /^（?图）?$/.test(chunk.text.trim())
    return `[${chunk.id}] ${chunk.citation} · ${KIND_LABEL[chunk.kind] ?? chunk.kind} · ${chunk.section.at(-1) ?? ''}\n${bare ? '（无图注的图）' : chunk.text}`
  }).join('\n\n')
}

/** `items` in the fewest groups of at most `size`, as even as they can be. */
function groupsOf<T>(items: readonly T[], size: number): T[][] {
  const count = Math.ceil(items.length / size)
  const each = Math.ceil(items.length / Math.max(1, count))
  return Array.from({ length: count }, (_, index) => items.slice(index * each, (index + 1) * each))
}

/** The one page given from the site a link names by its root alone: a writer cited the site, not the page (10-31). */
function pageOnSite(url: string, pages: readonly WebUse[]): string | undefined {
  try {
    const link = new URL(url)
    if (link.pathname.replace(/\/+$/, '') !== '' || link.search) return undefined
    const same = pages.filter(page => new URL(page.url).host === link.host)
    return same.length === 1 ? same[0]!.url : undefined
  } catch {
    return undefined
  }
}

/** Web pages as a writer sees them: title, address, site and authority, then the passages kept. */
function pagesOf(pages: readonly WebUse[]): string {
  return pages.map(page => `[${page.title}](${page.url}) · ${page.site} · ${page.level}\n${page.passages.join('\n\n')}`).join('\n\n')
}

/** How to write a knowledge point, by the learner's state on it (docs/textbook/design.md, 详略). */
const MASTERY: Record<MasteryState, { readonly label: string; readonly write: string }> = {
  independent: { label: '已独立完成', write: '一两句带过，保留定义、符号和适用条件' },
  retained: { label: '已延迟验证', write: '一两句带过，保留定义、符号和适用条件' },
  'not-yet': { label: '还没答对', write: '多讲一步：拆开步骤，点明常见错误' },
  conflict: { label: '证据冲突', write: '多讲一步：拆开步骤，点明常见错误' },
  assisted: { label: '有帮助才完成', write: '正常讲，提醒学习者自己独立做一遍' },
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
  if (code === 'learning/model/truncated') return '讲义有一部分太长，拆开后仍超出模型单次能写的长度，请稍后重试'
  if (code === 'learning/core/conflict') return '生成期间讲义文件被修改过（可能是在讲义页或应用外改的），没有覆盖。要按现在的设计书重写，请再生成一次'
  return message ?? String(error)
}

/** "38 段，2 段待核实；习题要用、资料里没有讲到：A" for handoffs and the brief. */
function summaryOf(status: LessonTextbookStatus): string {
  return [
    `${status.blocks ?? 0} 段`,
    status.unverified ? `，${status.unverified} 段待核实` : '',
    status.edited ? `，学习者改过 ${status.edited} 段` : '',
    ...(status.notes ?? []).map(note => `；${note}`),
    status.missing?.length ? `；习题要用、资料里没有讲到：${status.missing.join('、')}` : '',
    status.uncovered?.length ? `；这些知识点正文没有讲到：${status.uncovered.join('、')}` : '',
  ].join('')
}

/** What one part gets besides its own material: chunks and web pages found for its gaps, and gaps found nowhere. */
interface Supplement {
  readonly local: CitedChunk[]
  readonly web: WebUse[]
  readonly missing: string[]
}

/** A citation link's short form in the learner's editor: `〔p.12〕` for `[《书》p.12](cite:…)`, a web page by its title. */
function markerOf(label: string): string {
  const page = /《[^》]+》\s*((?:p|P)\.?\s*[\d\-–~、,，]+.*)$/.exec(label.trim())
  return `〔${(page ? page[1]! : label).replace(/\s+/g, '').replace(/[〔〕]/g, '')}〕`
}

const LINK = /\[([^\]]*)\]\((cite:[^)\s]+|https?:\/\/[^)\s]+)\)/g

/** A link to a web page the paragraph quotes (its source, as a chunk citation is). */
const WEB_CITATION = /\]\(https?:\/\/[^)\s]+\)/

/** A paragraph as the editor shows it: citations as short markers. */
const withMarkers = (text: string) => text.replace(LINK, (_, label: string) => markerOf(label))

/** What a lesson is: the stage's section of a handout, or a lesson of before 11-01 with a file of its own. */
const isHandout = (stage: Stage, file: string | undefined) => file === handoutFile(stage.folder)

class LearnTextbookService extends Service implements LearnTextbook {
  /** Stages being written, by stage id. */
  private readonly inFlight = new Map<string, Promise<void>>()
  /** Aborts the model calls in flight when the unit stops; those stages stay running and resume on the next start. */
  private readonly stopping = new AbortController()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'learnTextbook')
    ctx.learnCore.db.migrate('textbook', migrations)
  }

  private get sqlite() {
    return this.ctx.learnCore.db.sqlite
  }

  private runOf(stageId: string): Run | undefined {
    const row = this.sqlite.prepare('SELECT data FROM textbook_handouts WHERE stage_id = ?').get(stageId) as { data: string } | undefined
    return row ? Run.parse(JSON.parse(row.data)) : undefined
  }

  private saveRun(run: Run): Run {
    this.sqlite.prepare(`INSERT INTO textbook_handouts (stage_id, course_id, data) VALUES (?, ?, ?)
      ON CONFLICT (stage_id) DO UPDATE SET data = excluded.data`).run(run.stageId, run.courseId, JSON.stringify(run))
    return run
  }

  private writing(stageId: string): boolean {
    const run = this.runOf(stageId)
    return run ? run.state === 'queued' || run.state === 'running' : this.inFlight.has(stageId)
  }

  /** Lessons whose handout is queued or being written. */
  running = () => {
    const rows = this.sqlite.prepare("SELECT stage_id FROM textbook_handouts WHERE json_extract(data, '$.state') IN ('queued', 'running')").all() as { stage_id: string }[]
    const stages = new Set([...this.inFlight.keys(), ...rows.map(row => row.stage_id)])
    return [...stages].flatMap(stageId => this.ctx.learnCurriculum.lessons(stageId).map(lesson => lesson.id as string))
  }

  status(lessonId: string): LessonTextbookStatus {
    const lesson = this.ctx.learnCurriculum.lesson(lessonId)
    const stage = lesson ? this.ctx.learnCurriculum.stage(lesson.stageId) : undefined
    if (!lesson || !stage) return { state: 'missing' }
    const run = this.runOf(stage.id)
    // The run's state counts once there is one: a handout just published is ready while its call unwinds.
    if (this.writing(stage.id)) {
      return {
        state: 'running',
        message: run?.message ?? '',
        ...(run?.step && run.startedAt ? { progress: { step: run.step, startedAt: run.startedAt, points: run.points } } : {}),
        ...(run?.draft ? { draft: run.draft } : {}),
      }
    }
    const blocks = lesson.textbookFile ? this.blocks(stage.courseId, lesson.textbookFile) : []
    if (run?.state === 'failed') return { state: 'failed', message: run.message, failures: run.failures, ...(blocks.length ? { blocks: blocks.length } : {}) }
    if (run?.state === 'conflict') return { state: 'conflict', message: run.message, ...(blocks.length ? { blocks: blocks.length } : {}), ...(run.held ? { draft: parseFrontmatter(run.held).body } : {}) }
    if (blocks.length === 0) return { state: 'missing' }
    const own = isHandout(stage, lesson.textbookFile) ? run : undefined
    const edited = this.editedOf(stage.courseId, blocks.map(block => block.id))
    const uncited = this.uncitedOf(stage.courseId, blocks, edited).length
    return {
      state: 'ready',
      blocks: blocks.length,
      unverified: blocks.filter(block => block.unverified).length,
      ...(edited.size ? { edited: edited.size } : {}),
      ...(uncited ? { uncited } : {}),
      ...(own?.uncovered.length ? { uncovered: own.uncovered } : {}),
      ...(own?.missing.length ? { missing: own.missing } : {}),
      ...(own?.notes.length ? { notes: own.notes } : {}),
    }
  }

  /** Of these paragraphs, those the learner last changed themselves. */
  private editedOf(courseId: string, blockIds: readonly string[]): Set<string> {
    if (blockIds.length === 0) return new Set()
    const rows = this.sqlite.prepare(`SELECT block_id, data FROM textbook_revisions WHERE course_id = ? AND block_id IN (${blockIds.map(() => '?').join(', ')}) ORDER BY id`).all(courseId, ...blockIds) as { block_id: string; data: string }[]
    const last = new Map<string, BlockRevision>()
    for (const row of rows) {
      const revision = JSON.parse(row.data) as BlockRevision
      if (revision.into[0] === row.block_id) last.set(row.block_id, revision)
    }
    return new Set([...last].filter(([, revision]) => revision.reason === LEARNER_EDIT).map(([id]) => id))
  }

  /**
   * Rewrite `targets` of `body` (no frontmatter) by `instruction` from the chunks they cite and their neighbours in
   * the material: paragraphs only, never source text copied in or a table (the program lays tables out).
   */
  private async revise(heading: string, material: readonly CitedChunk[], body: string, targets: readonly string[], instruction: string, newId: () => string, stageId?: string) {
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
      prompt: revisionPrompt({ heading, instruction, targets: blocks.filter(block => targets.includes(block.id)).map(block => ({ id: block.id, text: block.text })), around, material: [...near, ...others] }),
      purpose: 'learning-textbook', model: this.config.model.get(), maxTokens: WRITER_MAX_TOKENS, signal: this.stopping.signal,
      ...(stageId ? { onUsage: this.counted(stageId) } : {}),
    })
    const revised = parseRevision(reply, targets)
    if (revised.size === 0) throw new Error('模型没有按格式给出改好的段落，讲义没有改动')
    const known = new Set<string>([...near, ...others].map(chunk => chunk.id))
    return applyRevision(body, revised, { knownChunk: id => known.has(id), embed: { order: material, extra: others, examples: false }, newBlockId: newId })
  }

  /** What the program finds in these paragraphs of `body`, by block id (docs/textbook/design.md, 程序检查). */
  private problems(body: string, material: string, stems: readonly string[], only?: ReadonlySet<string>): Map<string, Problem> {
    const out = new Map<string, Problem>()
    for (const paragraph of paragraphsOf(body, only)) {
      const problem = precheck(paragraph.text, material, stems)
      if (problem) out.set(paragraph.blockId, problem)
    }
    return out
  }

  async reviseBlocks(lessonId: string, input: { readonly blockIds: readonly string[]; readonly instruction: string }, meta: ChangeMeta) {
    const lesson = must(this.ctx.learnCurriculum.lesson(lessonId), 'textbook', '课时', lessonId)
    const stage = must(this.ctx.learnCurriculum.stage(lesson.stageId), 'textbook', '阶段', lesson.stageId)
    const courseId = stage.courseId
    const file = lesson.textbookFile!
    if (this.writing(stage.id)) throw new LearningApiError('learning/textbook/busy', `${stage.title} 的讲义正在生成，等生成完再改`)
    const current = await this.ctx.learnCore.files.read(courseId, file)
    if (!current) throw new LearningApiError('learning/textbook/missing', `${stage.title} 还没有讲义，先生成`)
    const targets = [...new Set(input.blockIds)]
    if (targets.length === 0 || targets.length > REVISE_LIMIT) throw new LearningApiError('learning/textbook/too-many', `一次改 1 到 ${REVISE_LIMIT} 段；要重写整份讲义，就重新生成`)
    const present = indexBlocks(current.text)
    const unknown = targets.filter(id => !present.some(block => block.id === id))
    if (unknown.length) throw new LearningApiError('learning/textbook/no-block', `讲义里没有这些段落：${unknown.join('、')}。段落编号是每段末尾 ^ 后面的 6 位编号`)
    const originals = targets.filter(id => present.find(block => block.id === id)!.original)
    if (originals.length) throw new LearningApiError('learning/textbook/original', `这些段落是资料原文，原样引用，不能改写：${originals.join('、')}。可以改它们前后的讲解，或者重新生成讲义`)
    const tables = targets.filter(id => isTable(present.find(block => block.id === id)!.text))
    if (tables.length) throw new LearningApiError('learning/textbook/table', `这些是程序排的表格，不能局部改写：${tables.join('、')}。请学习者在讲义页直接改，或者重新生成讲义`)
    const newId = this.idMaker(courseId)
    const { data, body } = parseFrontmatter(current.text)
    const lessons = this.lessonsOf(courseId, file)
    const material = lessons.flatMap(item => this.material(courseId, item))
    const stems = stemsOf(this.exercises(material))
    const result = await this.revise(isHandout(stage, file) ? `${stage.title} 的讲义` : `${lesson.number} ${lesson.title}`, material, body, targets, input.instruction, newId)
    const changed = new Set([...result.into.values()].flat())
    const found = this.problems(result.body, material.map(chunk => chunk.text).join('\n'), stems, changed)
    const text = withFrontmatter({ ...data, version: Number(data.version ?? 0) + 1, revisedAt: now() }, result.body)
    const change = await this.ctx.learnCore.files.write(courseId, file, text, { ...meta, size: meta.size ?? 'minor' }, { ifHash: current.hash })
    const removed = [...result.into].filter(([, into]) => into.length === 0).map(([id]) => id)
    this.ctx.learnCore.db.transaction(() => {
      this.dropChecks(courseId, [...targets, ...changed])
      this.keepChecks(courseId, file, indexBlocks(text), new Map([...found].map(([id, problem]) => [id, checkOf(problem)])))
      this.record(courseId, [...result.into].map(([blockId, into]) => ({ blockId, into: [...into], changeId: change.id, reason: input.instruction })))
    })
    this.reindex(courseId, file, text)
    const added = [...result.into.values()].reduce((sum, into) => sum + Math.max(0, into.length - 1), 0)
    const texts = new Map(indexBlocks(text).map(block => [block.id, block.text]))
    const unverified = [...found].map(([id, problem]) => reasonOf(texts.get(id) ?? '', checkOf(problem)))
    return { revised: targets.length - removed.length, added, removed: removed.length, unverified, notes: [] }
  }

  /**
   * A paragraph as the learner edits it in the reader: its Markdown with citations as short markers (`〔p.12〕`), or
   * why it cannot be edited there.
   */
  async blockSource(courseId: string, blockId: string): Promise<{ readonly text: string; readonly hash: string } | { readonly refused: string }> {
    const block = await this.block(courseId, blockId)
    if (!block?.current) return { refused: '找不到这一段，可能刚改过，刷新后再试' }
    if (block.original) return { refused: '这是原书原文，原样引用，不能改；可以在旁边批注' }
    return { text: withMarkers(block.text), hash: block.current }
  }

  /**
   * The learner's own edit of one paragraph (11-01: a handout is notes the learner may change). The paragraph keeps
   * its id, so notes and questions on it stay; empty text removes it. Markers go back to the links they stand for
   * (a marker the paragraph did not have is dropped); source text copied in cannot be edited. The program does not
   * check what the learner wrote. `base` is the fingerprint the paragraph had when the editor opened: a paragraph
   * changed since (another tab, Obsidian, a regeneration) is not overwritten; the error carries its text now.
   */
  async editBlock(courseId: string, blockId: string, input: string, base: string): Promise<{ readonly blocks: readonly string[] }> {
    const block = await this.block(courseId, blockId)
    if (!block?.current) throw new LearningApiError('learning/textbook/no-block', '找不到这一段，可能刚改过，刷新后再试')
    if (block.original) throw new LearningApiError('learning/textbook/original', '这是原书原文，原样引用，不能改；可以在旁边批注')
    if (block.current !== base) {
      throw new LearningApiError('learning/textbook/edited', '这一段在你打开后被改过，没有保存', { text: withMarkers(block.text), hash: block.current })
    }
    const lessons = this.lessonsOf(courseId, block.file)
    const stage = lessons[0] ? this.ctx.learnCurriculum.stage(lessons[0].stageId) : undefined
    if (stage && this.writing(stage.id)) throw new LearningApiError('learning/textbook/busy', '讲义正在生成，等生成完再改')
    const current = await this.ctx.learnCore.files.read(courseId, block.file)
    if (!current) throw new LearningApiError('learning/textbook/missing', '讲义文件不见了，刷新后再试')
    // Each marker takes the next link of the paragraph with the same short form.
    const links = new Map<string, string[]>()
    for (const match of block.text.matchAll(LINK)) links.set(markerOf(match[1]!), [...links.get(markerOf(match[1]!)) ?? [], match[0]])
    const text = input.replace(/〔[^〔〕\n]*〕/g, marker => links.get(marker)?.shift() ?? '').trim()
    const cites = new Set<string>(block.citations)
    const pages = new Set([...block.text.matchAll(LINK)].map(match => match[2]!).filter(target => target.startsWith('http')))
    const { data, body } = parseFrontmatter(current.text)
    const applied = applyRevision(body, new Map([[blockId, text || null]]), { knownChunk: id => cites.has(id), knownUrl: url => pages.has(url), newBlockId: this.idMaker(courseId) })
    const written = withFrontmatter({ ...data, version: Number(data.version ?? 0) + 1, revisedAt: now() }, applied.body)
    const change = await this.ctx.learnCore.files.write(courseId, block.file, written, { actor: 'user', reason: text ? '在讲义页改了一段' : '在讲义页删了一段', size: 'minor' }, { ifHash: current.hash })
      .catch(error => {
        if ((error as { code?: string }).code === 'learning/core/conflict') throw new LearningApiError('learning/textbook/conflict', '讲义刚被别处改过，刷新后再改')
        throw error
      })
    const into = applied.into.get(blockId) ?? []
    this.ctx.learnCore.db.transaction(() => {
      this.dropChecks(courseId, [blockId, ...into])
      this.record(courseId, [{ blockId, into: [...into], changeId: change.id, reason: LEARNER_EDIT }, ...into.slice(1).map(id => ({ blockId: id, into: [id], changeId: change.id, reason: LEARNER_EDIT }))])
    })
    this.reindex(courseId, block.file, written)
    return { blocks: into }
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

  /** Keep what the check found in these paragraphs, bound to their text in `blocks`. */
  private keepChecks(courseId: string, file: string, blocks: readonly { readonly id: string; readonly hash: string }[], checks: ReadonlyMap<string, ParagraphCheck>): void {
    const checkedAt = now()
    const insert = this.sqlite.prepare('INSERT OR REPLACE INTO textbook_checks (course_id, block_id, file, data) VALUES (?, ?, ?, ?)')
    for (const block of blocks) {
      const check = checks.get(block.id)
      if (check) insert.run(courseId, block.id, file, JSON.stringify(BlockCheck.parse({ ...check, sources: [...check.sources], hash: block.hash, checkedAt })))
    }
  }

  private dropChecks(courseId: string, blockIds: readonly string[]): void {
    if (blockIds.length) this.sqlite.prepare(`DELETE FROM textbook_checks WHERE course_id = ? AND block_id IN (${blockIds.map(() => '?').join(', ')})`).run(courseId, ...blockIds)
  }

  /** The lessons read in a file: a stage's lessons for its handout, one lesson for a file of before 11-01. */
  private lessonsOf(courseId: string, file: string): Lesson[] {
    return this.ctx.learnCurriculum.stages(courseId).flatMap(stage => this.ctx.learnCurriculum.lessons(stage.id)).filter(item => item.textbookFile === file)
  }

  /**
   * The lessons citing each source of a course, in course order (the library's 本课资料 shows them). A citation made
   * before a reparse counts for the newest parse, which is the one the course uses. The chapter's own parts of a
   * handout count for no lesson.
   */
  sourceUses(courseId: string): { sourceId: string; lessons: { id: string; number: string; title: string }[] }[] {
    const lessons = this.ctx.learnCurriculum.stages(courseId).flatMap(stage => this.ctx.learnCurriculum.lessons(stage.id))
    const cited = new Map<string, Set<string>>()
    for (const block of this.blocks(courseId)) {
      if (!block.lessonId) continue
      for (const chunkId of block.citations) cited.set(chunkId, (cited.get(chunkId) ?? new Set()).add(block.lessonId))
    }
    const uses = new Map<string, Set<string>>()
    for (const [chunkId, sourceId] of Object.entries(this.ctx.learnLibrary.chunkSources([...cited.keys()]))) {
      const into = uses.get(sourceId) ?? new Set()
      for (const lessonId of cited.get(chunkId)!) into.add(lessonId)
      uses.set(sourceId, into)
    }
    return [...uses].map(([sourceId, ids]) => ({ sourceId, lessons: lessons.filter(lesson => ids.has(lesson.id)).map(lesson => ({ id: lesson.id, number: lesson.number, title: lesson.title })) }))
  }

  /**
   * The knowledge points a lesson explains, for the knowledge sidebar's local graph: those its section's paragraphs
   * are linked to, in reading order; before the handout is written, those sourced in its material, in the course's order.
   */
  lessonNodes(lessonId: string): { lesson: { id: string; number: string; title: string }; nodeIds: string[]; from: 'textbook' | 'material' } | undefined {
    const lesson = this.ctx.learnCurriculum.lesson(lessonId)
    const stage = lesson ? this.ctx.learnCurriculum.stage(lesson.stageId) : undefined
    if (!lesson || !stage) return undefined
    const about = { id: lesson.id, number: lesson.number, title: lesson.title }
    const own = lesson.textbookFile ? this.blocks(stage.courseId, lesson.textbookFile).filter(block => block.lessonId === lesson.id) : []
    const linked = [...new Set(own.flatMap(block => block.nodeIds))]
    if (linked.length) return { lesson: about, nodeIds: linked, from: 'textbook' }
    const { expected } = this.candidates(stage.courseId, stage, this.material(stage.courseId, lesson).map(chunk => chunk.id), [])
    const nodeIds = this.ctx.learnKnowledge.graph(stage.courseId).nodes.map(node => node.id as string).filter(id => expected.has(id))
    return { lesson: about, nodeIds, from: 'material' }
  }

  /** The paragraphs of a lesson's handout the reader marks in the margin: the ones to read with care. */
  flaggedBlocks(lessonId: string): string[] {
    const lesson = this.ctx.learnCurriculum.lesson(lessonId)
    const stage = lesson ? this.ctx.learnCurriculum.stage(lesson.stageId) : undefined
    if (!lesson?.textbookFile || !stage) return []
    return this.blocks(stage.courseId, lesson.textbookFile).filter(block => block.unverified).map(block => block.id)
  }

  /** The explanation paragraphs of a lesson's handout that cite nothing (11-02: shown by rule, never checked by model). */
  uncitedBlocks(lessonId: string): string[] {
    const lesson = this.ctx.learnCurriculum.lesson(lessonId)
    const stage = lesson ? this.ctx.learnCurriculum.stage(lesson.stageId) : undefined
    if (!lesson?.textbookFile || !stage) return []
    const blocks = this.blocks(stage.courseId, lesson.textbookFile)
    return this.uncitedOf(stage.courseId, blocks, this.editedOf(stage.courseId, blocks.map(block => block.id)))
  }

  /** Uncited paragraphs, without those flagged already (counted there) and the learner's own. */
  private uncitedOf(courseId: string, blocks: readonly Block[], edited: ReadonlySet<string>): string[] {
    return blocks.filter(block => block.uncited && !block.unverified && !edited.has(block.id)).map(block => block.id)
  }

  /** One paragraph's sources (with their text) and state, in the learner's words. No internal ids beyond what opens a source. */
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
    const stage = block.lessonId ? this.ctx.learnCurriculum.stage(this.ctx.learnCurriculum.lesson(block.lessonId)?.stageId ?? '') : this.lessonsOf(courseId, block.file).map(lesson => this.ctx.learnCurriculum.stage(lesson.stageId)).find(Boolean)
    const pages = stage ? this.runOf(stage.id)?.web ?? [] : []
    const links = [...block.text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map(match => match[1]!)
    const web = pages.filter(page => links.includes(page.url)).map(page => ({ url: page.url, title: page.title, site: page.site, passage: page.passages[0] ?? '' }))
    const history = this.revisions(courseId, blockId).filter(item => item.into[0] === blockId && item.reason !== REGENERATED)
    const latest = history.at(-1)
    const teacher = history.filter(item => item.reason !== LEARNER_EDIT).at(-1)
    const kind = block.original ? 'original' : indexed?.recall ? 'recall' : 'explanation'
    const edited = latest?.reason === LEARNER_EDIT
    const state = edited ? 'edited' : block.unverified ? 'flagged' : 'none'
    const note = edited ? '' : block.unverified && !current ? '这段在旧版里标了待核实；重新生成后会按新规则检查' : current && flagged(current) ? current.note : ''
    return {
      kind, state, note, sources, web,
      ...(teacher && !edited ? { revised: [...teacher.reason].length > 60 ? `${[...teacher.reason].slice(0, 58).join('')}…` : teacher.reason } : {}),
    }
  }

  /** The kept check of each paragraph of a file, by block id. */
  checks(courseId: string, file: string): Map<string, BlockCheck> {
    const rows = this.sqlite.prepare('SELECT block_id, data FROM textbook_checks WHERE course_id = ? AND file = ?').all(courseId, file) as { block_id: string; data: string }[]
    return new Map(rows.map(row => [row.block_id, BlockCheck.parse(JSON.parse(row.data))]))
  }

  /**
   * Save the stage's run with `patch` and tell open pages. Writing a handout again after it was published starts a
   * new run: its id must not match the file already published.
   */
  private progress(stage: Stage, patch: Partial<Run> & Pick<Run, 'state'>): Run {
    const previous = this.runOf(stage.id)
    const fresh = !previous || ((previous.state === 'ready' || previous.state === 'conflict') && patch.state !== previous.state && patch.state !== 'ready')
    const restart = fresh ? { run: randomUUID().slice(0, 8), parts: {}, points: [], draft: undefined, step: undefined, startedAt: undefined, missing: [], web: [], notes: [], usage: { calls: 0, input: 0, output: 0 } } : {}
    const run = this.saveRun(Run.parse({ stageId: stage.id, courseId: stage.courseId, ...previous, ...restart, ...patch, updatedAt: now() }))
    const state = run.state === 'ready' || run.state === 'conflict' ? 'done' : run.state === 'failed' ? 'failed' : 'running'
    const first = this.ctx.learnCurriculum.lessons(stage.id)[0]
    this.ctx.learnCore.feed.publish('learning/textbook-progress', { lessonId: first?.id ?? '', stageId: stage.id, state, message: run.message })
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

  /** The stage's sections in lesson order, each chunk in the first section that has it. */
  private sectionsOf(courseId: string, lessons: readonly Lesson[]): Section[] {
    const seen = new Set<string>()
    return lessons.map(lesson => ({
      lessonId: lesson.id,
      number: lesson.number,
      title: lesson.title,
      chunks: this.material(courseId, lesson).filter(chunk => !seen.has(chunk.id) && seen.add(chunk.id)),
    }))
  }

  /**
   * The exercises of the chapters the material belongs to, in the same source: what the handout should prepare the
   * learner for (docs/textbook/design.md). Only their stems are shown when planning.
   */
  private exercises(material: readonly CitedChunk[]): CitedChunk[] {
    const chapters = new Map<string, Set<string | undefined>>()
    for (const chunk of material) chapters.set(chunk.sourceId, (chapters.get(chunk.sourceId) ?? new Set()).add(chunk.section.length > 1 ? chunk.section[0] : undefined))
    return [...chapters].flatMap(([sourceId, names]) => this.ctx.learnLibrary.chunks(sourceId as never).filter(chunk => chunk.kind === 'exercise' && [...names].some(chapter => (chapter ? chunk.section[0] === chapter : chunk.section.length <= 1))))
  }

  generateLesson(lessonId: string): Promise<void> {
    const lesson = must(this.ctx.learnCurriculum.lesson(lessonId), 'textbook', '课时', lessonId)
    return this.generateStage(lesson.stageId)
  }

  generateStage(stageId: string): Promise<void> {
    const existing = this.inFlight.get(stageId)
    if (existing) return existing
    const stage = must(this.ctx.learnCurriculum.stage(stageId), 'textbook', '阶段', stageId)
    if (this.runOf(stageId)?.state !== 'running') this.progress(stage, { state: 'queued', message: QUEUED })
    const run = this.writeStage(stageId).finally(() => this.inFlight.delete(stageId))
    this.inFlight.set(stageId, run)
    return run
  }

  /** One model reply, reused from the stage's run when the same input was written before. */
  private async reply(stageId: string, input: { readonly system: string; readonly prompt: string; readonly maxTokens: number; readonly model: string | undefined }, write: () => Promise<string[]>): Promise<string[]> {
    const key = hashOf([input.system, input.prompt, input.maxTokens, input.model ?? ''])
    const cached = this.runOf(stageId)?.parts[key]
    if (cached) return cached
    const texts = await write()
    const run = this.runOf(stageId)
    if (run) this.saveRun({ ...run, parts: { ...run.parts, [key]: texts } })
    return texts
  }

  /** Add one model attempt to the stage's run. */
  private counted(stageId: string) {
    return (usage: { readonly inputTokens: number; readonly outputTokens: number }) => {
      const run = this.runOf(stageId)
      if (run) this.saveRun({ ...run, usage: { calls: run.usage.calls + 1, input: run.usage.input + usage.inputTokens, output: run.usage.output + usage.outputTokens } })
    }
  }

  /** One call through the stage's cache. */
  private async call(stageId: string, system: string, prompt: string, purpose: string, maxTokens = WRITER_MAX_TOKENS, check?: (text: string) => void): Promise<string> {
    const input = { system, prompt, maxTokens, model: this.config.model.get() }
    const [text = ''] = await this.reply(stageId, input, async () => {
      const text = await complete(this.ctx, { ...input, purpose, signal: this.stopping.signal, onUsage: this.counted(stageId) })
      check?.(text)
      return [text]
    })
    return text
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

  /** The handout's plan: from one planning reply, or sections alone (with why) when the reply is unusable. */
  private async plan(stage: Stage, prompt: string, sections: readonly Section[], stems: readonly string[]): Promise<HandoutPlan & { readonly failed?: string }> {
    try {
      const text = await this.call(stage.id, PLAN_SYSTEM, prompt, 'learning-textbook-plan', PLAN_MAX_TOKENS, reply => {
        if (!readPlan(parseJsonReply(reply), sections, stems)) throw new Error('提纲规划没有给出可用的结果')
      })
      return readPlan(parseJsonReply(text), sections, stems)!
    } catch (error) {
      if (this.stopping.signal.aborted) throw error
      this.ctx.logger('learning-textbook').warn('stage %s: planning failed, writing the sections alone: %s', stage.title, (error as Error).message)
      return { overview: '', terms: [], formulas: [], needs: sections.map(() => []), confusions: [], types: [], untyped: [], failed: (error as Error).message }
    }
  }

  /**
   * What the handout needs that its material does not explain (a few at most), for each part that needs it
   * (`parts[i]` for part i): the course's other material first, then one web page of authority 1–2, read and
   * quoted by its address, never added to the library (10-15). A gap found nowhere is said to be missing.
   */
  private async supplement(courseId: string, parts: readonly (readonly string[])[], material: readonly CitedChunk[]): Promise<Supplement[]> {
    const out: Supplement[] = parts.map(() => ({ local: [], web: [], missing: [] }))
    const own = new Set(material.map(chunk => chunk.id))
    const gaps = parts.flatMap((texts, index) => texts.map(need => ({ index, need })))
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
   * Write one section (or a part of one). A reply cut off at the output limit is retried as two halves of the
   * material; the second half goes on without an opening. A single chunk that does not fit is reported.
   */
  private async writeSection(stageId: string, prompt: (chunks: readonly CitedChunk[], first: boolean) => string, chunks: readonly CitedChunk[], first: boolean, depth = 0): Promise<string[]> {
    try {
      return [await this.call(stageId, SECTION_SYSTEM, prompt(chunks, first), 'learning-textbook')]
    } catch (error) {
      if ((error as { code?: string }).code !== 'learning/model/truncated' || chunks.length < 2 || depth >= 2) throw error
      const [head, tail] = halve(chunks)
      return [...await this.writeSection(stageId, prompt, head, first, depth + 1), ...await this.writeSection(stageId, prompt, tail, false, depth + 1)]
    }
  }

  private async writeStage(stageId: string): Promise<void> {
    const curriculum = this.ctx.learnCurriculum
    const stage = must(curriculum.stage(stageId), 'textbook', '阶段', stageId)
    const courseId = stage.courseId
    const lessons = curriculum.lessons(stageId)
    const file = handoutFile(stage.folder)
    const before = await this.ctx.learnCore.files.read(courseId, file)
    const previous = this.runOf(stageId)
    // Published just before a restart: only the index, the status and the handoff are left.
    if (previous?.state === 'running' && before && parseFrontmatter(before.text).data.run === previous.run) {
      this.publish(stage, before.text)
      return
    }
    // An unfinished run keeps its id, the replies it already has, its clock and the file it began from.
    const resumed = previous?.state === 'running'
    const startedAt = resumed && previous.startedAt ? previous.startedAt : now()
    const base = resumed && previous.base ? previous.base : { hash: before?.hash ?? null }
    this.progress(stage, { state: 'running', message: `正在整理 ${stage.title} 的提纲`, step: 'plan', startedAt, points: [], draft: undefined, base, held: undefined })
    try {
      if (lessons.length === 0) throw new Error(`${stage.title} 还没有课时，先在设计书里排好课时`)
      const sections = this.sectionsOf(courseId, lessons)
      const chunks = sections.flatMap(section => section.chunks)
      if (chunks.length === 0) throw new Error(`资料库里找不到 ${stage.title} 的资料，先把教材加入本课`)
      const known = new Set<string>(chunks.map(chunk => chunk.id))
      const design = await this.ctx.learnCore.files.read(courseId, `${stage.folder}/${STAGE_LAYOUT.design}`)
      const goal = await this.ctx.learnCore.files.read(courseId, COURSE_LAYOUT.goal)
      const parent = stage.kind === 'remedial' && stage.remedialOf ? curriculum.stage(stage.remedialOf) : undefined
      const review = parent ? await this.ctx.learnCore.files.read(courseId, `${parent.folder}/${STAGE_LAYOUT.review}`) : undefined
      const remedial = stage.kind === 'remedial'
      const mastery = this.masteryOf(courseId, stage, chunks)
      const masteryPart = mastery ? `# 学习者对本章知识点的掌握（按作答证据；阅读和聊天不算已会）\n${mastery}` : ''
      const context = [
        goal ? `# 学习目标\n${parseFrontmatter(goal.text).body.slice(0, 2000)}` : '',
        design ? `# 阶段设计书（测试部分已略去）\n${teachingPartOf(parseFrontmatter(design.text).body)}` : '',
        masteryPart,
        remedial ? `# 补课\n${REMEDIAL_NOTE}${review ? `\n\n## 上一阶段的复盘\n${parseFrontmatter(review.text).body.trim()}` : ''}` : '',
      ].filter(Boolean).join('\n\n')

      // 1. The plan, with what the chapter's exercises need; the writers never see the exercises.
      const stems = stemsOf(this.exercises(chunks))
      const plan = await this.plan(stage, planPrompt({ context, sections, stems, remedial }), sections, stems)
      // 2. What the material does not explain, the terms' first: other course material, then the web.
      const unexplained = plan.terms.filter(term => !term.chunk).map(term => term.name)
      const supplements = await this.supplement(courseId, [unexplained, ...plan.needs.map(needs => needs.filter(need => !need.covered && !unexplained.includes(need.text)).map(need => need.text))], chunks)
      const aside = supplements[0]!
      const extra = supplements.slice(1)
      const web = supplements.flatMap(item => item.web)
      const missing = supplements.flatMap(item => item.missing)
      // Terms found nowhere are only named, in the program's note.
      const terms = plan.terms.filter(term => !aside.missing.includes(term.name))
      const parts = [
        ...(plan.overview || terms.length || plan.formulas.length ? ['本章速览'] : []),
        ...sections.map(section => `${section.number} ${section.title}`),
        ...(plan.confusions.length ? ['易混点'] : []),
        ...(plan.types.length ? ['题型与方法'] : []),
      ]
      this.progress(stage, { state: 'running', step: 'write', message: `正在编写 ${stage.title} 的讲义（0/${parts.length} 部分）`, points: parts.map(title => ({ title, done: false })), web, missing })

      // 3. The overview's tables, each section, the confusions and the types, a few at a time.
      const taken = this.idMaker(courseId)
      // A paragraph that reads exactly as before keeps its id (notes stay on it); each old id is used once.
      const unchanged = new Map<string, string[]>()
      for (const block of before ? indexBlocks(before.text) : []) unchanged.set(block.text, [...unchanged.get(block.text) ?? [], block.id])
      const local = supplements.flatMap(item => item.local)
      const knownChunk = (id: string) => known.has(id) || local.some(chunk => chunk.id === id)
      const knownUrl = (url: string) => web.some(page => page.url === url) || pageOnSite(url, web)
      const dropped: string[] = []
      const finish = (text: string, embed?: { readonly order: readonly CitedChunk[]; readonly extra: readonly CitedChunk[] }) => {
        const done = finalize(text, {
          knownChunk, knownUrl, newBlockId: taken, reuse: piece => unchanged.get(piece)?.shift(),
          ...(embed ? { embed: { ...embed, examples: false }, embedLimit: SECTION_EMBEDS } : {}),
        })
        dropped.push(...done.dropped)
        return done.body.trim()
      }
      const citeOf = (id: string): Cite | undefined => {
        const chunk = chunks.find(item => item.id === id) ?? local.find(item => item.id === id)
        if (chunk) return { label: chunk.citation, target: chunk.id }
        const page = web.find(item => item.url === id)
        return page ? { label: page.title, target: page.url } : undefined
      }
      const anchors = this.knownOf(courseId, stage, chunks)
      const formulaTex = plan.formulas.map(formula => formulaCell(formula).tex)
      // The plan's few sentences open 本章速览 as a paragraph of their own.
      const opening = plan.overview ? finish(plan.overview) : ''

      const groups = terms.length ? groupsOf(terms, TERM_GROUP) : plan.formulas.length ? [[]] : []
      const overviewPrompt = (group: readonly Term[], withFormulas: boolean) => {
        const own = [...termMaterial(group, chunks), ...(withFormulas ? formulaMaterial(plan.formulas, chunks) : [])]
          .filter((chunk, index, all) => all.indexOf(chunk) === index).sort((a, b) => chunks.indexOf(a) - chunks.indexOf(b))
        const gaps = group.some(term => !term.chunk)
        return [
          masteryPart,
          anchors.length ? `# 学习者已经会的（可以拿来类比，只点名）\n${anchors.join('、')}` : '',
          `# 本章：${stage.title}`,
          group.length ? `# 要解释的名词（按这个顺序）\n${group.map((term, index) => `${index + 1}. ${term.name}${term.chunk ? `（见 ${term.chunk.id}）` : '（本章资料没讲，见补充资料或网页摘录）'}`).join('\n')}` : '',
          withFormulas ? `# 要写名称和什么时候用的公式\n${plan.formulas.map(formula => `- ${formula.id}：${formulaCell(formula).tex}`).join('\n')}` : '',
          own.length ? `# 资料片段（只能引用这些 ID）\n${materialOf(own)}` : '',
          gaps && aside.local.length ? `# 补充资料（为本章资料没讲的名词找来的，可以引用）\n${materialOf(aside.local)}` : '',
          gaps && aside.web.length ? `# 网页摘录（cite 写网址）\n${pagesOf(aside.web)}` : '',
        ].filter(Boolean).join('\n\n')
      }
      const outline = sections.map((section, index) => `${index + 1}. ${section.number} ${section.title}`).join('\n')
      const sectionPrompt = (index: number) => (part: readonly CitedChunk[], first: boolean) => {
        const section = sections[index]!
        const { local: found, web: pages, missing: absent } = extra[index]!
        const cap = this.capOf(courseId, stage, section.chunks)
        return [
          context,
          `# 本章：${stage.title}\n本章的小节依次是：\n${outline}\n这次写第 ${index + 1} 个。`,
          terms.length ? `# 本章速览里已经解释的名词（直接用，不再定义）\n${terms.map(term => term.name).join('、')}` : '',
          formulaTex.length ? `# 公式表里已经列出的式子（讲到时用行内公式写原式即可，不必再嵌入）\n${formulaTex.join('　')}` : '',
          `# 这次写：${section.number} ${section.title}\n字数上限：${cap.cap} 字（${cap.why}）${first ? '' : '\n这一节的资料较长，分两次写，这是后半部分：接着前面写，不要开场白。'}`,
          cap.lines ? `# 学习者对本节知识点的掌握\n${cap.lines}` : '',
          plan.needs[index]!.length ? `# 做练习要会的（只讲道理，不出题、不提习题）\n${plan.needs[index]!.map(need => `- ${need.text}${need.covered ? '' : absent.includes(need.text) ? '（资料里找不到，不要讲）' : '（本节资料没讲，见补充资料）'}`).join('\n')}` : '',
          `# 资料片段（只能引用和嵌入这些 ID）\n${materialOf(part)}`,
          found.length && first ? `# 补充资料（为"做练习要会的"找来的，可以引用）\n${materialOf(found)}` : '',
          pages.length && first ? `# 网页摘录（引用时写成 [网页标题](网址)，不能嵌入）\n${pagesOf(pages)}` : '',
        ].filter(Boolean).join('\n\n')
      }
      const confusionChunks = plan.confusions.flatMap(pair => [...chunksNaming(pair.a, chunks), ...chunksNaming(pair.b, chunks)])
        .filter((chunk, index, all) => all.indexOf(chunk) === index).sort((a, b) => chunks.indexOf(a) - chunks.indexOf(b)).slice(0, CONFUSION_CHUNKS)
      const typeChunks = [...plan.types.flatMap(type => (type.example ? exampleWithSolution(type.example, chunks) : [])), ...plan.formulas]
        .filter((chunk, index, all) => all.indexOf(chunk) === index).sort((a, b) => chunks.indexOf(a) - chunks.indexOf(b))
      const typesPrompt = () => [
        masteryPart,
        `# 本章：${stage.title}`,
        `# 题型（按这个顺序写）\n${plan.types.map((type, index) => [
          `${index + 1}. ${type.name}`,
          type.sections.length ? `要用到的小节：${type.sections.map(at => `${sections[at]!.number} ${sections[at]!.title}`).join('、')}` : '',
          ...type.sections.flatMap(at => plan.needs[at]!.map(need => `要会的：${need.text}`)),
          type.example ? `原书例题：${type.example.id}` : '没有原书例题',
        ].filter(Boolean).join('\n')).join('\n\n')}`,
        typeChunks.length ? `# 资料片段（原书例题和解答、本章的公式；只能引用这些 ID）\n${materialOf(typeChunks)}` : '',
      ].filter(Boolean).join('\n\n')

      // What is written so far, by part; undefined while it is being written.
      let overview: { terms: string; formulas: string } | undefined
      const overviewRows: { terms: ReturnType<typeof readOverview>['terms']; formulas: ReturnType<typeof readOverview>['formulas'] }[] = groups.map(() => ({ terms: [], formulas: [] }))
      const groupDone = groups.map(() => false)
      const bodies: (string | undefined)[] = new Array(sections.length)
      let confusions: { table: string; rows: ReturnType<typeof readConfusions> } | undefined
      let types: string | undefined
      const writingNote = '（正在写…）'
      // Terms found nowhere, and those the writers left out or could not source.
      const notExplained = [...aside.missing]
      const missingTerms = () => (notExplained.length ? `> [!note] 资料里没有讲到：${notExplained.join('；')}。可以问主老师，或在资料库里加一份讲它的资料。` : '')
      const overviewText = () => {
        if (!parts.includes('本章速览')) return []
        if (!overview) return ['### 本章速览', opening, writingNote]
        return ['### 本章速览', opening, ...(overview.terms ? ['#### 名词', overview.terms] : []), missingTerms(), ...(overview.formulas ? ['#### 公式', overview.formulas] : [])]
      }
      const assemble = () => [
        `## ${stage.title}`,
        ...overviewText(),
        ...sections.flatMap((section, index) => [sectionHeading(section), bodies[index] ?? writingNote]),
        ...(parts.includes('易混点') ? ['### 易混点', confusions?.table ?? writingNote] : []),
        ...(parts.includes('题型与方法') ? ['### 题型与方法', types ?? writingNote] : []),
      ].filter(Boolean).join('\n\n')

      let failure: { readonly error: unknown } | undefined
      type Task = { readonly kind: 'overview'; readonly group: number } | { readonly kind: 'section'; readonly index: number } | { readonly kind: 'confusions' } | { readonly kind: 'types' }
      const queue: Task[] = [
        ...groups.map((_, group) => ({ kind: 'overview' as const, group })),
        ...sections.map((_, index) => ({ kind: 'section' as const, index })),
        ...(plan.confusions.length ? [{ kind: 'confusions' as const }] : []),
        ...(plan.types.length ? [{ kind: 'types' as const }] : []),
      ]
      const partOf = (task: Task) => (task.kind === 'overview' ? 0 : task.kind === 'section' ? parts.indexOf(`${sections[task.index]!.number} ${sections[task.index]!.title}`) : parts.indexOf(task.kind === 'confusions' ? '易混点' : '题型与方法'))
      await Promise.all(Array.from({ length: WRITERS }, async () => {
        for (let task = queue.shift(); task !== undefined && !failure; task = queue.shift()) {
          try {
            if (task.kind === 'overview') {
              const group = groups[task.group]!
              const reply = await this.call(stageId, OVERVIEW_SYSTEM, overviewPrompt(group, task.group === 0), 'learning-textbook', WRITER_MAX_TOKENS, text => { parseJsonReply(text) })
              overviewRows[task.group] = readOverview(parseJsonReply(reply), { terms: group, formulas: task.group === 0 ? plan.formulas : [], known: citeOf })
              groupDone[task.group] = true
              if (groupDone.every(Boolean)) {
                const termRows = overviewRows.flatMap(rows => rows.terms)
                const formulaRows = overviewRows.flatMap(rows => rows.formulas)
                for (const term of terms) if (!term.chunk && !termRows.some(row => row.name === term.name)) notExplained.push(term.name)
                overview = { terms: termRows.length ? finish(termsTable(termRows)) : '', formulas: formulaRows.length ? finish(formulasTable(formulaRows)) : '' }
              }
            } else if (task.kind === 'section') {
              const section = sections[task.index]!
              const replies = await this.writeSection(stageId, sectionPrompt(task.index), section.chunks, true)
              const body = finish(replies.map(reply => replyBody(reply)).join('\n\n'), { order: section.chunks, extra: extra[task.index]!.local })
              // Something the material does not explain, said where it was needed.
              const absent = extra[task.index]!.missing
              bodies[task.index] = absent.length ? `${body}\n\n> [!note] 资料里没有讲到：${absent.join('；')}。可以问主老师，或在资料库里加一份讲它的资料。` : body
            } else if (task.kind === 'confusions') {
              const reply = await this.call(stageId, CONFUSIONS_SYSTEM, [`# 本章：${stage.title}`, `# 容易混的概念\n${plan.confusions.map((pair, index) => `${index + 1}. ${pair.a} 与 ${pair.b}`).join('\n')}`, `# 资料片段（只能引用这些 ID）\n${materialOf(confusionChunks)}`].join('\n\n'), 'learning-textbook', WRITER_MAX_TOKENS, text => { parseJsonReply(text) })
              const rows = readConfusions(parseJsonReply(reply), citeOf)
              confusions = { rows, table: rows.length ? finish(confusionsTable(rows)) : '' }
            } else {
              types = finish(replyBody(await this.call(stageId, TYPES_SYSTEM, typesPrompt(), 'learning-textbook'), 4))
            }
          } catch (error) {
            failure ??= { error }
            return
          }
          const run = this.runOf(stageId)!
          const at = partOf(task)
          const marked = run.points.map((entry, i) => (i === at && (task.kind !== 'overview' || overview) ? { ...entry, done: true } : entry))
          this.progress(stage, { state: 'running', step: 'write', points: marked, draft: assemble(), message: `正在编写 ${stage.title} 的讲义（已完成 ${marked.filter(entry => entry.done).length}/${parts.length} 部分）` })
        }
      }))
      if (failure) throw failure.error

      // 4. The program's check (no model), and one rewrite of what it found.
      this.progress(stage, { state: 'running', step: 'check', message: `正在检查 ${stage.title} 的讲义`, draft: assemble() })
      const sourceText = [...chunks, ...local].map(chunk => chunk.text).concat(web.flatMap(page => page.passages)).join('\n')
      let body = `${assemble()}\n`
      const found = this.problems(body, sourceText, stems)
      const copies = copiesOf([...chunks, ...local].map(chunk => chunk.text).join('\n'))
      const copied = paragraphsOf(body).filter(paragraph => !found.has(paragraph.blockId) && copies(paragraph.text)).map(paragraph => paragraph.blockId)
      const long = sections.flatMap((section, index) => {
        const cap = this.capOf(courseId, stage, section.chunks).cap
        const text = bodies[index] ?? ''
        return hanCount(text) > cap * OVER_CAP ? [{ section, cap, ids: paragraphsOf(text).map(paragraph => paragraph.blockId) }] : []
      })
      const targets = [...new Set([...found.keys(), ...copied, ...long.flatMap(item => item.ids)])].slice(0, REVISE_LIMIT)
      const notes: string[] = []
      if (targets.length) {
        this.progress(stage, { state: 'running', step: 'check', message: `正在修改 ${stage.title} 讲义里的 ${targets.length} 段` })
        const texts = new Map(indexBlocks(body).map(block => [block.id, block.text]))
        const pick = (ids: readonly string[]) => ids.filter(id => targets.includes(id))
        const wrong = pick([...found.keys()]), same = pick(copied)
        const instruction = [
          wrong.length ? `程序检查发现这些段落有问题：${wrong.map(id => reasonOf(texts.get(id) ?? '', checkOf(found.get(id)!))).join('；')}。按资料改正：式子改用资料里的原式，资料里没有的数值去掉，不提习题。` : '',
          same.length ? `这些段落几乎照抄了资料原文：${same.map(id => `「${[...(texts.get(id) ?? '')].slice(0, 20).join('')}…」`).join('、')}。换成自己的话讲，意思、出处和式子不变。` : '',
          ...long.filter(item => item.ids.some(id => targets.includes(id))).map(item => `${item.section.number} ${item.section.title} 的讲解（${pick(item.ids).join('、')}）超过了 ${item.cap} 字的上限，压缩到上限以内：只删可有可无的话，保留结论、条件和式子。`),
          '其余照旧。',
        ].join('')
        try {
          const fixed = await this.revise(`${stage.title} 的讲义`, [...chunks, ...local], body, targets, instruction, taken, stageId)
          body = fixed.body
          const changed = new Set([...fixed.into.values()].flat())
          for (const id of fixed.into.keys()) found.delete(id)
          for (const [id, problem] of this.problems(body, sourceText, stems, changed)) found.set(id, problem)
        } catch (error) {
          if (this.stopping.signal.aborted) throw error
          notes.push(`按检查结果修改没有完成：${(error as Error).message}`)
        }
      }
      // Rows of the tables the program could not take as they are.
      const tableChecks = new Map<string, ParagraphCheck>()
      const rowProblems = (table: string, rows: readonly { readonly label: string; readonly text: string }[]) => {
        const [block] = indexBlocks(table)
        const bad = rows.flatMap(row => { const problem = precheck(row.text, sourceText, stems); return problem ? [{ row, problem }] : [] })
        if (block && bad.length) tableChecks.set(block.id, { verdict: bad.some(item => item.problem.contradicts) ? 'contradicted' : 'unsupported', note: bad.map(item => `「${item.row.label}」这一行：${item.problem.note}`).join('；'), sources: [] })
      }
      if (overview?.terms) rowProblems(overview.terms, overviewRows.flatMap(rows => rows.terms).map(row => ({ label: row.name, text: row.text })))
      if (confusions?.table) rowProblems(confusions.table, confusions.rows.map(row => ({ label: `${row.a}与${row.b}`, text: row.diff })))
      const checks = new Map<string, ParagraphCheck>([...[...found].map(([id, problem]) => [id, checkOf(problem)] as const), ...tableChecks])
      notes.push(
        ...web.map(page => `联网补充：《${page.title}》（${page.url}）`),
        ...(plan.failed ? [`列提纲没有成功，只按小节写了讲解，没有本章速览、易混点和题型：${plan.failed}`] : []),
        ...(plan.untyped.length ? [`有 ${plan.untyped.length} 道习题没有归进任何题型`] : []),
        ...(dropped.length ? [`${dropped.length} 处出处或嵌入无效，已去掉`] : []),
      )
      const run = this.saveRun({ ...this.runOf(stageId)!, step: 'publish', notes, missing: [...new Set([...missing, ...notExplained])], pending: Object.fromEntries([...checks].map(([id, check]) => [id, CheckRow.parse({ ...check, sources: [...check.sources] })])) }).run
      const version = Number(before ? parseFrontmatter(before.text).data.version ?? 0 : 0) + 1
      const text = withFrontmatter({ stage: stage.id, title: stage.title, version, generatedAt: now(), run }, body)
      // Not over a file that changed since the run began (an edit in Obsidian, also while the program was stopped).
      const change = await this.ctx.learnCore.files.write(courseId, file, text, {
        actor: 'system',
        reason: `生成讲义 ${stage.title}${dropped.length ? `（${dropped.length} 处无效出处或嵌入已去掉）` : ''}`,
        size: before ? 'major' : 'minor',
      }, { ifHash: base.hash }).catch(error => {
        if ((error as { code?: string }).code === 'learning/core/conflict') return undefined
        throw error
      })
      if (!change) {
        this.hold(stage, text)
        return
      }
      // Paragraphs of the old version that did not survive: their notes can still find the old text.
      const kept = new Set(indexBlocks(text).map(block => block.id))
      this.record(courseId, (before ? indexBlocks(before.text) : []).filter(block => !kept.has(block.id)).map(block => ({ blockId: block.id, into: [], changeId: change.id, reason: REGENERATED })))
      this.publish(stage, text)
    } catch (error) {
      // The unit is stopping: the stage stays running and resumes on the next start.
      if (this.stopping.signal.aborted) return
      const message = describeFailure(error)
      this.progress(stage, { state: 'failed', message, failures: (this.runOf(stageId)?.failures ?? 0) + 1 })
      this.ctx.emit('learning/textbook-failed', { courseId, stageId, lessonId: lessons[0]?.id ?? '', message })
      this.ctx.emit('learning/handoff', { courseId, unit: 'textbook', text: `讲义 ${stage.title} 生成失败：${message}` })
      throw error
    }
  }

  /** Written, but the file changed since the run began: the handout waits for the learner to pick it or the file. */
  private hold(stage: Stage, text: string): void {
    this.progress(stage, { state: 'conflict', message: '讲义文件在生成期间被改过，新讲义没有覆盖它', held: text, step: undefined, draft: undefined })
    this.ctx.emit('learning/handoff', { courseId: stage.courseId, unit: 'textbook', text: `讲义 ${stage.title} 写好了，但讲义文件在生成期间（或程序停着时）被改过，新讲义没有覆盖它，等学习者在讲义页选用哪一份。` })
  }

  /**
   * The learner's pick after a conflict: the new handout over the file as it is now, or the file as it is. Either
   * way the stage's handout is then the one published.
   */
  async resolveConflict(lessonId: string, choice: 'replace' | 'keep'): Promise<LessonTextbookStatus> {
    const lesson = must(this.ctx.learnCurriculum.lesson(lessonId), 'textbook', '课时', lessonId)
    const stage = must(this.ctx.learnCurriculum.stage(lesson.stageId), 'textbook', '阶段', lesson.stageId)
    const run = this.runOf(stage.id)
    if (run?.state !== 'conflict' || !run.held) throw new LearningApiError('learning/textbook/no-conflict', '这份讲义没有等你选的版本')
    const file = handoutFile(stage.folder)
    const current = await this.ctx.learnCore.files.read(stage.courseId, file)
    if (choice === 'keep') {
      if (!current) throw new LearningApiError('learning/textbook/missing', '讲义文件已经不在了：用新讲义，或者重新生成')
      this.publish(stage, current.text, 'keep')
      return this.status(lessonId)
    }
    const { data, body } = parseFrontmatter(run.held)
    const text = withFrontmatter({ ...data, version: Number(current ? parseFrontmatter(current.text).data.version ?? 0 : 0) + 1 }, body)
    const change = await this.ctx.learnCore.files.write(stage.courseId, file, text, { actor: 'user', reason: `用新生成的讲义替换（生成期间文件被改过）${stage.title}`, size: 'major' }, { ifHash: current?.hash ?? null })
      .catch(error => {
        if ((error as { code?: string }).code === 'learning/core/conflict') throw new LearningApiError('learning/textbook/conflict', '讲义刚被别处改过，刷新后再选')
        throw error
      })
    const kept = new Set(indexBlocks(text).map(block => block.id))
    this.record(stage.courseId, (current ? indexBlocks(current.text) : []).filter(block => !kept.has(block.id)).map(block => ({ blockId: block.id, into: [], changeId: change.id, reason: REGENERATED })))
    this.publish(stage, text)
    return this.status(lessonId)
  }

  /** The file is written: keep its check, point the lessons at it, index it, mark the run done, then tell the stage and the teacher once. */
  private publish(stage: Stage, text: string, kept?: 'keep'): void {
    const courseId = stage.courseId
    const file = handoutFile(stage.folder)
    const pending = this.runOf(stage.id)?.pending
    const lessons = this.ctx.learnCurriculum.setTextbookFile(stage.id, file)
    // A file kept as it is keeps the checks of its paragraphs; a new handout brings its own.
    if (!kept) {
      this.ctx.learnCore.db.transaction(() => {
        this.sqlite.prepare('DELETE FROM textbook_checks WHERE course_id = ? AND file = ?').run(courseId, file)
        if (pending) this.keepChecks(courseId, file, indexBlocks(text), new Map(Object.entries(pending)))
      })
    }
    const { uncovered } = this.reindex(courseId, file, text)
    this.progress(stage, { state: 'ready', message: '', failures: 0, parts: {}, uncovered, pending: undefined, draft: undefined, step: undefined, base: undefined, held: undefined })
    const first = lessons[0]
    const summary = first ? summaryOf(this.status(first.id)) : ''
    this.progress(stage, { state: 'ready', message: summary })
    if (first) this.ctx.emit('learning/textbook-ready', { courseId, stageId: stage.id, lessonId: first.id })
    this.ctx.emit('learning/handoff', { courseId, unit: 'textbook', text: kept ? `学习者保留了讲义 ${stage.title} 现在的文件，没有用新生成的（${summary}）。` : `讲义 ${stage.title} 已生成（${summary}）。` })
  }

  /** After a restart: stages queued or cut off go on. */
  resume(): void {
    const rows = this.sqlite.prepare("SELECT data FROM textbook_handouts WHERE json_extract(data, '$.state') IN ('queued', 'running')").all() as { data: string }[]
    for (const row of rows) {
      const run = Run.parse(JSON.parse(row.data))
      if (!this.ctx.learnCurriculum.stage(run.stageId)) { this.sqlite.prepare('DELETE FROM textbook_handouts WHERE stage_id = ?').run(run.stageId); continue }
      void this.generateStage(run.stageId).catch((error: Error) => this.ctx.logger('learning-textbook').warn('stage %s: %s', run.stageId, error.message))
    }
  }

  /**
   * What the stage-changed and doc-changed listeners would have done, at start (docs/textbook/design.md, 发布、恢复和块 ID):
   * a confirmed design whose handout never started starts now, and a handout whose block index is behind its file is
   * indexed again. Either event is lost when the process stops between a commit and its listeners.
   */
  async reconcile(): Promise<void> {
    for (const course of this.ctx.learnCore.courses.list()) {
      const files = new Set((this.sqlite.prepare('SELECT DISTINCT file FROM textbook_blocks WHERE course_id = ?').all(course.id) as { file: string }[]).map(row => row.file))
      for (const stage of this.ctx.learnCurriculum.stages(course.id)) {
        if (stage.status === 'designing' && stage.designConfirmedAt && !this.runOf(stage.id)) {
          void this.generateStage(stage.id).catch((error: Error) => this.ctx.logger('learning-textbook').warn('stage %s: %s', stage.id, error.message))
        }
        for (const lesson of this.ctx.learnCurriculum.lessons(stage.id)) if (lesson.textbookFile) files.add(lesson.textbookFile)
      }
      for (const file of files) {
        const text = (await this.ctx.learnCore.files.read(course.id, file))?.text
        const current = text ? indexBlocks(text).map(block => `${block.id}:${block.hash}`) : []
        const stored = this.blocks(course.id, file)
        const indexed = stored.map(block => `${block.id}:${block.hash}`)
        // An index written before blocks said whether they cite anything is written again too.
        if (current.join() !== indexed.join() || stored.some(block => block.uncited === undefined)) this.reindex(course.id, file, text)
      }
    }
  }

  stop(): void {
    this.stopping.abort()
  }

  /** The learner's state on each knowledge point, a node's state in this course before its state overall. */
  private statesOf(courseId: string, nodeIds: readonly string[]) {
    const states = new Map(this.ctx.learnLearner.states(nodeIds as never).map(state => [state.nodeId as string, state]))
    return (nodeId: string) => {
      const overall = states.get(nodeId)
      const state = overall?.courses.find(entry => entry.courseId === courseId) ?? overall
      // Asked about again and again: written out in full, whatever the answers say.
      const kind: MasteryState = state?.doubtful ? 'conflict' : state?.state ?? 'untested'
      const label = state?.doubtful ? `${MASTERY[state.state].label}，反复提问过` : MASTERY[state?.state ?? 'untested'].label
      return { kind, label, explanation: state?.explanation }
    }
  }

  /** The stage's knowledge points with the learner's state on each and how to write it, one line each; empty when there are none. */
  private masteryOf(courseId: string, stage: Stage, material: readonly CitedChunk[]): string {
    const { nodes, candidates } = this.candidates(courseId, stage, material.map(chunk => chunk.id), [])
    const own = nodes.filter(node => candidates.has(node.id)).slice(0, 30)
    const stateOf = this.statesOf(courseId, own.map(node => node.id))
    return own.map(node => {
      const state = stateOf(node.id)
      return `- ${node.title}：${state.label}${state.explanation ? `（${state.explanation.replace(/。$/, '')}）` : ''}。${MASTERY[state.kind].write}。`
    }).join('\n')
  }

  /**
   * How long a section may be (docs/textbook/design.md, 详略): short when the learner can already do all its
   * knowledge points, long when one is not yet done; and the lines that say so.
   */
  private capOf(courseId: string, stage: Stage, material: readonly CitedChunk[]): { cap: number; why: string; lines: string } {
    if (stage.kind === 'remedial') return { cap: SECTION_CAP.weak, why: '补课', lines: '' }
    const { nodes, expected } = this.candidates(courseId, stage, material.map(chunk => chunk.id), [])
    const own = nodes.filter(node => expected.has(node.id)).slice(0, 12)
    const stateOf = this.statesOf(courseId, own.map(node => node.id))
    const states = own.map(node => ({ node, state: stateOf(node.id) }))
    const lines = states.map(({ node, state }) => `- ${node.title}：${state.label}。${MASTERY[state.kind].write}。`).join('\n')
    if (states.some(({ state }) => state.kind === 'not-yet' || state.kind === 'conflict')) return { cap: SECTION_CAP.weak, why: '有还没掌握的知识点', lines }
    if (states.length && states.every(({ state }) => state.kind === 'independent' || state.kind === 'retained')) return { cap: SECTION_CAP.known, why: '这一节的知识点都已经会了', lines }
    return { cap: SECTION_CAP.usual, why: '正常讲', lines }
  }

  /**
   * Knowledge points of the course outside the stage that the learner has done on their own: what a term may be
   * likened to (10-31, 联系学员的知识掌握水平). A node's state in this course counts first.
   */
  private knownOf(courseId: string, stage: Stage, material: readonly CitedChunk[]): string[] {
    const { nodes, candidates } = this.candidates(courseId, stage, material.map(chunk => chunk.id), [])
    const others = nodes.filter(node => !candidates.has(node.id))
    const titles = new Map(others.map(node => [node.id as string, node.title]))
    return this.ctx.learnLearner.states(others.map(node => node.id)).filter(state => {
      const own = state.courses.find(entry => entry.courseId === courseId) ?? state
      return own.state === 'independent' || own.state === 'retained'
    }).flatMap(state => titles.get(state.nodeId) ?? []).slice(0, KNOWN_LIMIT)
  }

  /** Knowledge points a handout may explain: the stage's core nodes, those sourced in its material or in `cited`. */
  private candidates(courseId: string, stage: Stage | undefined, material: readonly string[], cited: readonly string[]) {
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
   * Knowledge points the file's paragraphs may explain (docs/textbook/design.md, 知识关联): the stage's core nodes
   * and those sourced in its lessons' material or in a chunk the file cites. A paragraph is linked to one when it
   * cites a chunk the node is sourced in, or names it by a title or alias no other node of the course shares; a
   * recall question explains nothing and is linked to none.
   */
  private linker(courseId: string, file: string, cited: readonly string[]) {
    const lessons = this.lessonsOf(courseId, file)
    const stage = lessons[0] ? this.ctx.learnCurriculum.stage(lessons[0].stageId) : undefined
    const material = lessons.flatMap(lesson => this.material(courseId, lesson).map(chunk => chunk.id))
    const { nodes, inChunks, expected, candidates } = this.candidates(courseId, stage, material, cited)
    const names = (node: (typeof nodes)[number]) => [node.title, ...node.aliases].map(name => name.trim()).filter(name => [...name].length >= 2)
    const shared = new Map<string, number>()
    for (const node of nodes) for (const name of new Set(names(node))) shared.set(name, (shared.get(name) ?? 0) + 1)
    const named = nodes.filter(node => candidates.has(node.id)).map(node => ({ id: node.id, names: names(node).filter(name => shared.get(name) === 1) }))
    return {
      lessons,
      link: (block: { readonly text: string; readonly citations: readonly string[]; readonly recall: boolean }) => block.recall ? [] : [...new Set([
        ...inChunks(block.citations),
        ...named.filter(node => node.names.some(name => block.text.includes(name))).map(node => node.id),
      ])],
      /** Titles of the material's knowledge points no paragraph is linked to. */
      uncovered: (linked: ReadonlySet<string>) => nodes.filter(node => expected.has(node.id) && !linked.has(node.id)).map(node => node.title),
    }
  }

  /**
   * The lesson each block of a file is in: in a handout, the section its `###` heading opens (the chapter's own
   * parts have none); in a lesson's own file of before 11-01, that lesson.
   */
  private sectionsIn(text: string, lessons: readonly Lesson[]): Map<string, string> {
    const out = new Map<string, string>()
    if (lessons.length === 1) {
      for (const block of indexBlocks(text)) out.set(block.id, lessons[0]!.id)
      return out
    }
    let current: string | undefined
    for (const piece of splitPieces(parseFrontmatter(text).body)) {
      if (/^###\s/.test(piece)) {
        const number = sectionNumberOf(piece)
        current = number ? lessons.find(lesson => lesson.number === number)?.id : undefined
        continue
      }
      if (/^#{1,2}\s/.test(piece)) { current = undefined; continue }
      const id = /\s\^([0-9a-z]{6})\s*$/.exec(piece)?.[1] ?? /^\^([0-9a-z]{6})\s*$/.exec(piece.trim())?.[1] ?? /\n\^([0-9a-z]{6})\s*$/.exec(piece)?.[1]
      if (id && current) out.set(id, current)
    }
    return out
  }

  /**
   * Rebuild the block index of one file, with the lesson each block is in, and link blocks to the stage's knowledge
   * points. A paragraph is unverified when what the check found still holds for its text, or when an older file
   * says so in its text.
   */
  reindex(courseId: string, file: string, text: string | undefined): { blocks: Block[]; uncovered: string[] } {
    const indexed = text ? indexBlocks(text) : []
    const linker = this.linker(courseId, file, indexed.flatMap(block => block.citations))
    const lessonOf = text ? this.sectionsIn(text, linker.lessons) : new Map<string, string>()
    const checks = this.checks(courseId, file)
    const explanation = new Set(text ? paragraphsOf(text).map(paragraph => paragraph.blockId) : [])
    const blocks = indexed.map(block => {
      const check = checks.get(block.id)
      const lessonId = lessonOf.get(block.id)
      const citations = block.citations.filter(id => id.startsWith('ck_') && id.length === 29)
      return Block.parse({
        courseId, id: block.id, file, hash: block.hash, nodeIds: linker.link(block), citations,
        unverified: block.unverified || (!!check && check.hash === block.hash && flagged(check)),
        original: block.original,
        uncited: explanation.has(block.id) && citations.length === 0 && !WEB_CITATION.test(block.text),
        ...(lessonId ? { lessonId } : {}),
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
      for (let i = 0; i < links.length; i += 100) this.ctx.learnKnowledge.link(links.slice(i, i + 100), { actor: 'system', reason: '讲义段落关联明确的知识身份' }, courseId)
      // An edit changes what the handout covers.
      const stage = linker.lessons[0] ? this.ctx.learnCurriculum.stage(linker.lessons[0].stageId) : undefined
      const run = stage && isHandout(stage, file) ? this.runOf(stage.id) : undefined
      if (run?.state === 'ready') this.saveRun({ ...run, uncovered })
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
    const found = file ? indexBlocks(file.text).find(item => item.id === blockId) : undefined
    // `current`: the paragraph's fingerprint as the file holds it now (the index may lag behind an outside edit).
    return { ...block, text: found?.text ?? '', ...(found ? { current: found.hash } : {}) }
  }
}

/** A stage's handout, or a lesson's own file of before 11-01. */
function isTextbookFile(path: string): boolean {
  return /^stages\/[^/]+\/(?:textbook\/[^/]+\.md|handout\.md)$/.test(path)
}

export function apply(ctx: Context, config: Config): void {
  const textbook = new LearnTextbookService(ctx, config)
  const endpoint = ctx.learnCore.api.endpoint
  // After the units started in the same turn (the tutor hears the handoff of a handout finished on resume).
  ctx.effect(() => {
    const timer = setTimeout(() => {
      try {
        textbook.resume()
      } catch (error) {
        ctx.logger('learning-textbook').warn('resume failed: %s', (error as Error).stack ?? error)
      }
      void textbook.reconcile().catch(error => ctx.logger('learning-textbook').warn('reconcile failed: %s', (error as Error).stack ?? error))
    }, 0)
    return () => { clearTimeout(timer); textbook.stop() }
  }, 'textbook: resume generation')

  // Keep the block index in step with the files (our own writes and the learner's outside edits).
  ctx.on('learning/doc-changed', ({ courseId, path }) => {
    if (!courseId || !isTextbookFile(path)) return
    void ctx.learnCore.files.read(courseId, path).then(file => textbook.reindex(courseId, path, file?.text))
      .catch(error => ctx.logger('learning-textbook').warn('reindex %s failed: %s', path, (error as Error).stack ?? error))
  })

  // A confirmed design starts the stage's handout.
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
      // Where each lesson's section of a handout ends: its 读完了 goes there.
      const ends: Record<string, string> = {}
      if (lesson.textbookFile && isHandout(stage, lesson.textbookFile)) {
        for (const block of textbook.blocks(stage.courseId, lesson.textbookFile)) if (block.lessonId) ends[block.lessonId] = block.id
      }
      return { lesson, stage: { id: stage.id, index: stage.index, title: stage.title }, siblings, text: file?.text ?? null, handout: isHandout(stage, lesson.textbookFile), ends, status: textbook.status(lessonId) }
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
    method: 'flagged',
    input: z.object({ lessonId: z.string() }),
    handle: ({ lessonId }) => textbook.flaggedBlocks(lessonId),
  }), 'textbook: flagged')

  ctx.effect(() => endpoint({
    unit: 'textbook',
    method: 'uncited',
    input: z.object({ lessonId: z.string() }),
    handle: ({ lessonId }) => textbook.uncitedBlocks(lessonId),
  }), 'textbook: uncited')

  ctx.effect(() => endpoint({
    unit: 'textbook',
    method: 'sourceUses',
    input: z.object({ courseId: z.string() }),
    handle: ({ courseId }) => textbook.sourceUses(courseId),
  }), 'textbook: source uses')

  ctx.effect(() => endpoint({
    unit: 'textbook',
    method: 'blockInfo',
    input: z.object({ courseId: z.string(), blockId: z.string() }),
    handle: async ({ courseId, blockId }) => (await textbook.blockInfo(courseId, blockId)) ?? null,
  }), 'textbook: block info')

  ctx.effect(() => endpoint({
    unit: 'textbook',
    method: 'blockSource',
    input: z.object({ courseId: z.string(), blockId: z.string() }),
    handle: ({ courseId, blockId }) => textbook.blockSource(courseId, blockId),
  }), 'textbook: block source')

  ctx.effect(() => endpoint({
    unit: 'textbook',
    method: 'editBlock',
    input: z.object({ courseId: z.string(), blockId: z.string(), text: z.string().max(20_000), base: z.string() }),
    handle: ({ courseId, blockId, text, base }) => textbook.editBlock(courseId, blockId, text, base),
  }), 'textbook: edit block')

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
    method: 'lessonNodes',
    // Without a lesson: the one the reader opens by default (the current stage's lesson in progress).
    input: z.object({ courseId: z.string(), lessonId: z.string().optional() }),
    handle: ({ courseId, lessonId }) => {
      const stage = lessonId ? undefined : ctx.learnCurriculum.currentStage(courseId)
      const lessons = stage ? ctx.learnCurriculum.lessons(stage.id) : []
      const id = lessonId ?? (lessons.find(lesson => lesson.status === 'in-progress') ?? lessons[0])?.id
      return (id ? textbook.lessonNodes(id) : undefined) ?? null
    },
  }), 'textbook: lesson nodes')

  ctx.effect(() => endpoint({
    unit: 'textbook',
    method: 'generate',
    input: z.object({ lessonId: z.string() }),
    handle: ({ lessonId }) => {
      void textbook.generateLesson(lessonId).catch(() => { /* reported on the feed */ })
      return { started: true }
    },
  }), 'textbook: generate')

  ctx.effect(() => endpoint({
    unit: 'textbook',
    method: 'resolveConflict',
    input: z.object({ lessonId: z.string(), choice: z.enum(['replace', 'keep']) }),
    handle: ({ lessonId, choice }) => textbook.resolveConflict(lessonId, choice),
  }), 'textbook: resolve conflict')

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const stage = ctx.learnCurriculum.currentStage(request.courseId)
    if (!stage) return sections
    const [first] = ctx.learnCurriculum.lessons(stage.id)
    if (!first) return sections
    const status = textbook.status(first.id)
    const text = {
      missing: '未生成',
      running: '生成中',
      ready: `已生成，${summaryOf(status)}`,
      failed: `生成失败：${status.message}`,
      conflict: '新讲义写好了，但讲义文件在生成期间被改过，没有覆盖，等学习者在讲义页选用哪一份',
    }[status.state]
    return [...sections, { unit: 'textbook', title: '本阶段讲义', text: `- ${stage.title}：${text}` }]
  })

  ctx.on('learning/describe-selection', async (selection, next) => {
    const lines = await next()
    const picked = selection.selected
    if (picked?.kind === 'block' && picked.id && selection.courseId) {
      const block = await textbook.block(selection.courseId, picked.id)
      if (block) {
        // The learner selects a sentence; the paragraph around it is context.
        const where = `${picked.label}${block.original ? '，资料原文' : ''}，块 ${block.id}`
        lines.push(picked.quote ? `学习者选中的原句：「${picked.quote.exact}」\n所在的讲义段落（${where}）：\n${block.text}` : `选中的讲义段落（${where}）：\n${block.text}`)
      }
    }
    return lines
  })
}
