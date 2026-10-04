// textbook unit, host half. Provides `ctx.learnTextbook` (contracts §5.1): generates each lesson's
// textbook file from the course's skeleton material and the stage design, keeps the block index
// (ids, citations, unverified flags, linked nodes), answers block lookups.
// Skeleton: one model call per lesson, citations checked against the library, nodes linked by title
// match. Block-by-block writing with claim checking (PLAN §4.6) comes when the unit is built out.
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  Block,
  COURSE_LAYOUT,
  STAGE_LAYOUT,
  newBlockId,
  parseFrontmatter,
  withFrontmatter,
  type CitedChunk,
  type LearnTextbook,
  type Lesson,
  type Migration,
} from '@learning-agent/contracts'
import { complete, must, now } from '@learning-agent/kit'
import { z } from 'zod'
import { finalize, indexBlocks, teachingPartOf } from './format.ts'

export const name = 'learning-textbook'
export const inject = ['learnCore', 'learnCurriculum', 'learnLibrary', 'learnKnowledge', 'llm', 'sessionController']

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
]

const WRITER_SYSTEM = `你是教材编写者，为一位具体的学习者编写课程中一个小节的教材。规则：
1. 只依据给出的资料片段写，不使用你自己的知识；资料里没有的内容不写。
2. 每个段落末尾用链接注明出处，格式 [《书名》p.页码](cite:片段ID)，片段 ID 只能是"资料片段"里列出的 ID。一段可以有多个出处。不要写没有出处的导读、过渡或总结段落，需要的话并进有出处的段落里。
3. 公式用 LaTeX：行内用 $…$；独立公式单独成段，写成 $$…$$，紧接着的下一段说明公式含义并带出处。
4. 结构：用 "## 小节号 标题" 开头，下面用 "###" 分子标题。先讲清概念和道理，再给公式和例题。例题只能用资料片段里的例题，题目条件和数字照原样写，保留原编号和解答要点，不要改编或自编。最后一个 "### 读完就答" 子标题下给 2 个凭记忆作答的小问题（不给答案）。
5. 不写习题、小测题或测试安排，不提考试形式和测试条件：练习和测试由测试页单独发布，写进教材会让测试失效。
6. 按阶段设计书的要求决定详略：学习者已经会的压缩，薄弱的展开。正文里不要出现内部编号（kn_、ck_ 等）。
7. 中文，简洁准确。直接输出教材正文 Markdown，不要前言后语，不要代码块包裹。`

/** Material kinds a textbook may draw on: exercises and their answers belong to assess (PLAN §5.2). */
const TEACHING_KINDS = new Set<string>(['heading', 'text', 'formula', 'table', 'figure', 'example'])

function materialOf(chunks: readonly CitedChunk[]): string {
  return chunks
    .filter(chunk => chunk.kind !== 'figure' || chunk.text.length > 4)
    .map(chunk => `[${chunk.id}] ${chunk.citation} · ${chunk.section.at(-1) ?? ''}\n${chunk.text}`)
    .join('\n\n')
}

class LearnTextbookService extends Service implements LearnTextbook {
  private readonly inFlight = new Map<string, Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'learnTextbook')
    ctx.learnCore.db.migrate('textbook', migrations)
  }

  private get sqlite() {
    return this.ctx.learnCore.db.sqlite
  }

  running = () => [...this.inFlight.keys()]

  private progress(lesson: Lesson, state: 'running' | 'done' | 'failed', message = ''): void {
    this.ctx.learnCore.feed.publish('textbook/progress', { lessonId: lesson.id, stageId: lesson.stageId, state, message })
  }

  /** Teaching material for a lesson: the skeleton source's subsection, else a search by title. */
  private material(courseId: string, lesson: Lesson): CitedChunk[] {
    const sources = this.ctx.learnLibrary.courseSources(courseId)
    const skeleton = sources.find(entry => entry.role === 'skeleton') ?? sources[0]
    const section = skeleton ? this.ctx.learnLibrary.section(skeleton.sourceId, lesson.number) : []
    const chunks = section.length > 0 ? section : this.ctx.learnLibrary.search(lesson.title, { courseId, limit: 40 }).map(hit => hit.chunk)
    return chunks.filter(chunk => TEACHING_KINDS.has(chunk.kind))
  }

  generateLesson(lessonId: string): Promise<void> {
    const existing = this.inFlight.get(lessonId)
    if (existing) return existing
    const run = this.writeLesson(lessonId).finally(() => this.inFlight.delete(lessonId))
    this.inFlight.set(lessonId, run)
    return run
  }

  private async writeLesson(lessonId: string): Promise<void> {
    const curriculum = this.ctx.learnCurriculum
    const lesson = must(curriculum.lesson(lessonId), 'textbook', '课时', lessonId)
    const stage = must(curriculum.stage(lesson.stageId), 'textbook', '阶段', lesson.stageId)
    const courseId = stage.courseId
    this.progress(lesson, 'running', `正在编写 ${lesson.number} ${lesson.title}`)
    try {
      const chunks = this.material(courseId, lesson)
      if (chunks.length === 0) throw new Error(`资料库里找不到 ${lesson.number} ${lesson.title} 的资料，先把骨架教材加入本课`)
      const known = new Set<string>(chunks.map(chunk => chunk.id))
      const design = await this.ctx.learnCore.files.read(courseId, `${stage.folder}/${STAGE_LAYOUT.design}`)
      const goal = await this.ctx.learnCore.files.read(courseId, COURSE_LAYOUT.goal)
      const prompt = [
        goal ? `# 学习目标\n${parseFrontmatter(goal.text).body.slice(0, 2000)}` : '',
        design ? `# 阶段设计书（测试部分已略去）\n${teachingPartOf(parseFrontmatter(design.text).body)}` : '',
        `# 要写的小节\n${lesson.number} ${lesson.title}`,
        `# 资料片段（只能引用这些 ID）\n${materialOf(chunks)}`,
      ].filter(Boolean).join('\n\n')
      const draft = await complete(this.ctx, { system: WRITER_SYSTEM, prompt, purpose: 'learning-textbook', maxTokens: 16_000 })

      const taken = new Set<string>((this.sqlite.prepare('SELECT block_id FROM textbook_blocks WHERE course_id = ?').all(courseId) as { block_id: string }[]).map(row => row.block_id))
      const newId = () => {
        let id = newBlockId()
        while (taken.has(id)) id = newBlockId()
        taken.add(id)
        return id
      }
      // Only the material the writer was given counts as a source; any other id becomes 待核实.
      const { body, blocks, dropped } = finalize(draft, { knownChunk: id => known.has(id), newBlockId: newId })
      const file = lesson.textbookFile!
      const previous = await this.ctx.learnCore.files.read(courseId, file)
      const version = Number(previous ? parseFrontmatter(previous.text).data.version ?? 0 : 0) + 1
      await this.ctx.learnCore.files.write(courseId, file, withFrontmatter({ lesson: lesson.id, title: `${lesson.number} ${lesson.title}`, version, generatedAt: now() }, body), {
        actor: 'system',
        reason: `生成教材 ${lesson.number}${dropped.length ? `（${dropped.length} 处无效出处已标为待核实）` : ''}`,
        size: previous ? 'major' : 'minor',
      })
      const unverified = blocks.filter(block => block.unverified).length
      this.progress(lesson, 'done', `${blocks.length} 段，${unverified} 段待核实`)
    } catch (error) {
      this.progress(lesson, 'failed', (error as Error).message)
      throw error
    }
  }

  async generateStage(stageId: string): Promise<void> {
    const stage = must(this.ctx.learnCurriculum.stage(stageId), 'textbook', '阶段', stageId)
    const lessons = this.ctx.learnCurriculum.lessons(stageId)
    // Two at a time: fast enough, gentle on the relay.
    const queue = [...lessons]
    const failures: string[] = []
    await Promise.all([0, 1].map(async () => {
      for (let lesson = queue.shift(); lesson; lesson = queue.shift()) {
        await this.generateLesson(lesson.id).catch((error: Error) => { failures.push(`${lesson!.number}：${error.message}`) })
      }
    }))
    if (failures.length) {
      this.ctx.logger('learning-textbook').warn('stage %s: %s', stageId, failures.join('; '))
      return
    }
    this.ctx.emit('learning/textbook-ready', { courseId: stage.courseId, stageId, lessonIds: lessons.map(lesson => lesson.id) })
  }

  /** Rebuild the block index of one file and link blocks to course nodes named in them. */
  reindex(courseId: string, file: string, text: string | undefined): void {
    const blocks = text ? indexBlocks(text) : []
    const nodes = this.ctx.learnKnowledge.graph(courseId).nodes
    this.ctx.learnCore.db.transaction(() => {
      this.sqlite.prepare('DELETE FROM textbook_blocks WHERE course_id = ? AND file = ?').run(courseId, file)
      const insert = this.sqlite.prepare('INSERT OR REPLACE INTO textbook_blocks (course_id, block_id, file, seq, data) VALUES (?, ?, ?, ?, ?)')
      blocks.forEach((block, seq) => {
        const nodeIds = nodes.filter(node => block.text.includes(node.title)).map(node => node.id)
        const row = Block.parse({ courseId, id: block.id, file, hash: block.hash, nodeIds, citations: block.citations.filter(id => id.startsWith('ck_') && id.length === 29), unverified: block.unverified })
        insert.run(courseId, block.id, file, seq, JSON.stringify(row))
        if (nodeIds.length) this.ctx.learnKnowledge.link(nodeIds.map(nodeId => ({ nodeId: nodeId as Block['nodeIds'][number], target: { kind: 'block', courseId: courseId as Block['courseId'], id: block.id }, relation: 'explains' })))
      })
    })
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

export function apply(ctx: Context): void {
  const textbook = new LearnTextbookService(ctx)
  const endpoint = ctx.learnCore.api.endpoint

  // Keep the block index in step with the files (our own writes and the learner's outside edits).
  ctx.on('learning/doc-changed', ({ courseId, path }) => {
    if (!courseId || !isTextbookFile(path)) return
    void ctx.learnCore.files.read(courseId, path).then(file => textbook.reindex(courseId, path, file?.text))
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
      return { lesson, stage: { id: stage.id, index: stage.index, title: stage.title }, siblings, text: file?.text ?? null, running: textbook.running().includes(lessonId) }
    },
  }), 'textbook: lesson')

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
    const running = textbook.running()
    const lines = lessons.map(lesson => {
      if (running.includes(lesson.id)) return `- ${lesson.number}：生成中`
      const blocks = lesson.textbookFile ? textbook.blocks(request.courseId, lesson.textbookFile) : []
      return `- ${lesson.number}：${blocks.length ? `已生成，${blocks.length} 段，${blocks.filter(block => block.unverified).length} 段待核实` : '未生成'}`
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
