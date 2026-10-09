// curriculum unit, host half. Provides `ctx.learnCurriculum` (contracts §5.1): the roadmap, stages
// and their lifecycle, stage designs, lessons (= textbook subsections), tasks and stage reviews.
// Stage lifecycle: planned → designing (design saved) → design confirmed (textbook generation starts)
// → ready (its first lesson's textbook is ready) → learning (first task published) → testing (stage
// test published) → reviewing (graded) → done (the learner chose after the review; a remedial stage
// may follow). The review's facts are read in tools.ts, which may inject the units that need this one.
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  COURSE_LAYOUT,
  LearningApiError,
  STAGE_LAYOUT,
  Task,
  newId,
  parseFrontmatter,
  withFrontmatter,
  type CarriedNode,
  type ChangeMeta,
  type CourseReportFacts,
  type LearnCurriculum,
  type Lesson,
  type ReviewChoice,
  type ReviewInput,
  type ReviewResult,
  type RoadmapResult,
  type RoadmapRevision,
  type Stage,
  type StageDraft,
} from '@learning-agent/contracts'
import { must, now } from '@learning-agent/kit'
import { z } from 'zod'
import { reportTable } from './report.ts'
import { carriedOf } from './review.ts'
import { CurriculumStore, curriculumMigrations, supportsOf } from './store.ts'

export const name = 'learning-curriculum'
export const inject = ['learnCore', 'learnGoal']

export const STAGE_STATUS_LABEL: Record<Stage['status'], string> = {
  planned: '计划中', designing: '设计中', ready: '待学习', learning: '学习中', testing: '测试中', reviewing: '复盘中', done: '已完成',
}
export const REVIEW_RESULT_LABEL: Record<ReviewResult, string> = { pass: '过了', fail: '没过', unverified: '待验证' }
const TASK_KIND_LABEL: Record<Task['kind'], string> = {
  predict: '预测', read: '阅读', quiz: '小测', practice: '练习', report: '汇报', 'stage-test': '阶段测试', review: '复查', other: '其他',
}

/**
 * A pass mark on the total ("正确率 ≥ 80%", "做对 80% 以上"): stage tests judge each core node instead
 * (docs/assess/design.md, B), so a design or roadmap promising one would mislead the learner.
 */
const PASS_MARK = /过关线|及格线|合格线|(?:做对|答对|正确率|得分率?)[^。；\n]{0,12}?\d+\s*[%％]/

function refusePassMark(text: string, where: string): void {
  const found = PASS_MARK.exec(text)
  if (found) throw new LearningApiError('learning/curriculum/pass-mark', `${where}里写了总分过关线（"${found[0]}"）。阶段测试不设总分线，按核心知识点逐个看：每个核心知识点都独立做对没见过的题才算过。请删掉这句，改写成要做到的事`)
}

/** The route has started once a stage design was confirmed: from then on the learner confirms changes. */
const started = (stages: readonly Stage[]) => stages.some(stage => stage.designConfirmedAt !== undefined)

class LearnCurriculumService extends Service implements LearnCurriculum {
  readonly store: CurriculumStore

  constructor(ctx: Context) {
    super(ctx, 'learnCurriculum')
    ctx.learnCore.db.migrate('curriculum', curriculumMigrations)
    this.store = new CurriculumStore(ctx.learnCore.db.sqlite)
  }

  private get core() {
    return this.ctx.learnCore
  }

  /** Save a stage and emit `learning/stage-changed` after the transaction commits. */
  private updateStage(stage: Stage, from: Stage['status'] | undefined): Stage {
    const saved = this.store.saveStage(stage)
    this.ctx.emit('learning/stage-changed', { stage: saved, from })
    return saved
  }

  stages = (courseId: string) => this.store.stages(courseId)
  stage = (stageId: string) => this.store.stage(stageId)
  currentStage = (courseId: string) => this.store.stages(courseId).find(stage => stage.status !== 'done')

  /** The goal's "can do" items by key; a stage may only name these. */
  private async goalItems(courseId: string, keys: readonly string[]): Promise<Map<string, string>> {
    const goal = await this.ctx.learnGoal.get(courseId).catch(() => undefined)
    const items = new Map((goal?.goal.canDo ?? []).map(item => [item.key, item.text]))
    const unknown = keys.filter(key => !items.has(key))
    if (unknown.length) throw new LearningApiError('learning/curriculum/unknown-goal-item', `目标说明里没有这些"能做"条目：${unknown.join('、')}。现有的是：${[...items].map(([key, text]) => `${key} ${text}`).join('；') || '（还没有）'}`)
    return items
  }

  /** Write `roadmap.md` from the stages as they are. */
  private async writeRoadmap(courseId: string, meta: ChangeMeta): Promise<void> {
    const stages = this.store.stages(courseId)
    const goal = await this.ctx.learnGoal.get(courseId).catch(() => undefined)
    const items = new Map((goal?.goal.canDo ?? []).map(item => [item.key, item.text]))
    const body = stages.map(stage => `## 阶段 ${stage.index}${stage.kind === 'remedial' ? '（补课）' : ''}：${stage.title}\n\n${stage.objective}\n${stage.supports.length ? `\n对应目标：${stage.supports.map(key => items.get(key) ?? key).join('；')}\n` : ''}`).join('\n')
    await this.core.files.write(courseId, COURSE_LAYOUT.roadmap, withFrontmatter({ course: courseId, stages: stages.map(stage => stage.id) }, `# 课程路线\n\n${body}`), { ...meta, size: 'major' })
  }

  /** Check a draft of the open stages: no pass marks, no fixed stage again, known goal items, no goal item lost. */
  private async checkRoadmap(courseId: string, drafts: readonly StageDraft[]): Promise<void> {
    const { fixed, open } = this.store.split(courseId)
    if (fixed.length + drafts.length === 0) throw new LearningApiError('learning/curriculum/empty-roadmap', '路线至少要有一个阶段')
    for (const draft of drafts) refusePassMark(`${draft.title}\n${draft.objective}`, `阶段「${draft.title}」的目标`)
    const again = drafts.filter(draft => fixed.some(stage => stage.title === draft.title))
    if (again.length) throw new LearningApiError('learning/curriculum/stage-started', `只写还没开始的阶段：${fixed.map(stage => `阶段 ${stage.index}「${stage.title}」`).join('、')}已经开始或排定，保持不变，不要再写。重复的是：${again.map(draft => draft.title).join('、')}`)
    const items = await this.goalItems(courseId, drafts.flatMap(draft => draft.supports ?? []))
    const before = new Set([...fixed, ...open].flatMap(stage => stage.supports))
    const after = new Set([...fixed.flatMap(stage => stage.supports), ...drafts.flatMap((draft, position) => supportsOf(draft, open, position))])
    const lost = [...before].filter(key => !after.has(key))
    if (lost.length) throw new LearningApiError('learning/curriculum/goal-item-lost', `改完后这些目标条目没有阶段对应了：${lost.map(key => `${key} ${items.get(key) ?? ''}`.trim()).join('；')}。让某个阶段支撑它们（supports）；要缩小范围，先和学习者修订目标`)
  }

  async saveRoadmap(courseId: string, drafts: readonly StageDraft[], meta: ChangeMeta): Promise<RoadmapResult> {
    await this.checkRoadmap(courseId, drafts)
    const current = this.store.stages(courseId)
    if (started(current)) {
      const { open } = this.store.split(courseId)
      const revision = this.store.saveRevision({
        courseId: courseId as RoadmapRevision['courseId'],
        stages: drafts.map(draft => ({ title: draft.title, objective: draft.objective, ...(draft.supports ? { supports: [...draft.supports] } : {}) })),
        before: open.map(stage => ({ title: stage.title, objective: stage.objective })),
        reason: meta.reason,
        at: now(),
      })
      this.ctx.emit('learning/roadmap-revised', { courseId, pending: true })
      return { stages: current, revision }
    }
    return { stages: await this.applyRoadmap(courseId, drafts, meta) }
  }

  private async applyRoadmap(courseId: string, drafts: readonly StageDraft[], meta: ChangeMeta): Promise<Stage[]> {
    const { stages, created } = this.core.db.transaction(() => this.store.applyRoadmap(courseId, drafts))
    await this.writeRoadmap(courseId, meta)
    for (const stage of created) this.ctx.emit('learning/stage-changed', { stage, from: undefined })
    // New stages after the course ended: it is in progress again.
    if (created.length && this.core.courses.get(courseId)?.status === 'finished') this.core.courses.setStatus(courseId, 'active')
    return stages
  }

  revision = (courseId: string) => this.store.revision(courseId)

  async decideRevision(courseId: string, apply: boolean): Promise<Stage[]> {
    const revision = this.store.revision(courseId)
    if (!revision) throw new LearningApiError('learning/curriculum/no-revision', '没有待确认的路线调整')
    if (apply) await this.checkRoadmap(courseId, revision.stages)
    const stages = apply
      ? await this.applyRoadmap(courseId, revision.stages, { actor: 'user', reason: `学习者确认路线调整：${revision.reason}` })
      : this.store.stages(courseId)
    this.store.deleteRevision(courseId)
    this.ctx.emit('learning/roadmap-revised', { courseId, pending: false })
    this.ctx.emit('learning/handoff', { courseId, unit: 'curriculum', text: apply ? `学习者确认了路线调整（${revision.reason}），后面的阶段已经按新路线排好。` : `学习者决定保持原来的路线，没有采用这次调整（${revision.reason}）。` })
    return stages
  }

  async saveDesign(stageId: string, input: { readonly markdown: string; readonly lessons: readonly { readonly number: string; readonly title: string }[]; readonly supports?: readonly string[]; readonly nodeIds?: readonly string[] }, meta: ChangeMeta) {
    const found = must(this.store.stage(stageId), 'curriculum', '阶段', stageId)
    if (input.lessons.length === 0) throw new LearningApiError('learning/curriculum/no-lessons', '阶段设计至少要有一个课时')
    refusePassMark(input.markdown, '设计书')
    if (input.supports) await this.goalItems(found.courseId, input.supports)
    const changed = { ...(input.supports ? { supports: [...input.supports] } : {}), ...(input.nodeIds ? { nodeIds: [...new Set(input.nodeIds)] as Stage['nodeIds'] } : {}) }
    const stage = Object.keys(changed).length ? this.updateStage({ ...found, ...changed }, found.status) : found
    const lessons = this.core.db.transaction(() => this.store.applyLessons(stage, input.lessons))
    await this.core.files.write(stage.courseId, `${stage.folder}/${STAGE_LAYOUT.design}`, withFrontmatter({ stage: stage.id, status: 'draft' }, input.markdown), { ...meta, size: 'major' })
    const { designConfirmedAt: _confirmed, ...rest } = stage
    const designing = this.updateStage({ ...rest, status: stage.status === 'planned' || stage.status === 'designing' || stage.status === 'ready' ? 'designing' : stage.status }, stage.status)
    return { stage: designing, lessons }
  }

  async confirmDesign(stageId: string): Promise<Stage> {
    const stage = must(this.store.stage(stageId), 'curriculum', '阶段', stageId)
    if (stage.status !== 'designing') throw new LearningApiError('learning/curriculum/not-designing', `阶段 ${stage.index} 现在是「${STAGE_STATUS_LABEL[stage.status]}」，没有待确认的设计`)
    if (stage.designConfirmedAt) return stage
    const path = `${stage.folder}/${STAGE_LAYOUT.design}`
    const file = await this.core.files.read(stage.courseId, path)
    if (!file) throw new LearningApiError('learning/curriculum/no-design', '还没有阶段设计书')
    const { data, body } = parseFrontmatter(file.text)
    await this.core.files.write(stage.courseId, path, withFrontmatter({ ...data, status: 'confirmed' }, body), { actor: 'user', reason: '学习者确认阶段设计', size: 'major' })
    const confirmed = this.updateStage({ ...stage, designConfirmedAt: now() }, stage.status)
    this.ctx.emit('learning/handoff', { courseId: stage.courseId, unit: 'curriculum', text: `学习者确认了阶段 ${stage.index}「${stage.title}」的设计书，教材开始生成。` })
    return confirmed
  }

  setStatus(stageId: string, status: Stage['status']): Stage {
    const stage = must(this.store.stage(stageId), 'curriculum', '阶段', stageId)
    return stage.status === status ? stage : this.updateStage({ ...stage, status }, stage.status)
  }

  setStageSession(stageId: string, sessionId: string): Stage {
    const stage = must(this.store.stage(stageId), 'curriculum', '阶段', stageId)
    return this.store.saveStage({ ...stage, sessionId })
  }

  lessons = (stageId: string) => this.store.lessons(stageId)
  lesson = (lessonId: string) => this.store.lesson(lessonId)

  setLessonStatus(lessonId: string, status: Lesson['status']): Lesson {
    const lesson = must(this.store.lesson(lessonId), 'curriculum', '课时', lessonId)
    return this.store.saveLesson({ ...lesson, status })
  }

  publishTask(input: Omit<Task, 'id' | 'status' | 'createdAt' | 'doneAt'>): Task {
    const task = this.store.saveTask(Task.parse({ ...input, id: newId('task'), status: 'open', createdAt: now() }))
    // Publishing work on a ready stage starts it; a lesson with work is in progress.
    if (task.stageId) {
      const stage = this.store.stage(task.stageId)
      if (stage?.status === 'ready') this.setStatus(stage.id, 'learning')
    }
    if (task.lessonId) {
      const lesson = this.store.lesson(task.lessonId)
      if (lesson?.status === 'not-started') this.setLessonStatus(lesson.id, 'in-progress')
    }
    this.ctx.emit('learning/task-published', task)
    return task
  }

  completeTask(taskId: string, result?: Task['result']): Task {
    const task = must(this.store.task(taskId), 'curriculum', '任务', taskId)
    if (task.status !== 'open') return task
    const done = this.store.saveTask({ ...task, status: 'done', doneAt: now(), ...(result ? { result } : {}) })
    this.ctx.emit('learning/task-done', done)
    return done
  }

  tasks = (courseId: string, filter?: { readonly status?: Task['status']; readonly lessonId?: string }) => this.store.tasks(courseId, filter)

  async saveReview(stageId: string, input: ReviewInput, meta: ChangeMeta): Promise<Stage> {
    const stage = must(this.store.stage(stageId), 'curriculum', '阶段', stageId)
    if (stage.status !== 'reviewing') throw new LearningApiError('learning/curriculum/not-reviewing', `阶段 ${stage.index} 现在是「${STAGE_STATUS_LABEL[stage.status]}」，不在复盘`)
    if (input.recommendation === 'remedial' && !input.remedial) throw new LearningApiError('learning/curriculum/no-remedial', '建议补课时要写补课阶段的标题、目标和要补的知识点')
    const review: Stage['review'] = {
      testId: input.testId as never,
      nodes: input.nodes.map(node => ({ ...node })),
      ...(input.task ? { task: input.task } : {}),
      recommendation: input.recommendation,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.remedial ? { remedial: { ...input.remedial, nodeIds: [...input.remedial.nodeIds] } } : {}),
      savedAt: now(),
    }
    const table = [
      '| 知识点 | 结果 |',
      '| --- | --- |',
      ...input.nodes.map(node => `| ${node.title} | ${REVIEW_RESULT_LABEL[node.result]} |`),
      ...(input.task ? [`| 完整任务题 | ${REVIEW_RESULT_LABEL[input.task]} |`] : []),
    ].join('\n')
    const body = `# 阶段 ${stage.index} 复盘：${stage.title}\n\n## 阶段测试的结果\n\n${table}\n\n${input.markdown.trim()}\n`
    await this.core.files.write(stage.courseId, `${stage.folder}/${STAGE_LAYOUT.review}`, withFrontmatter({ stage: stage.id, test: input.testId, status: 'saved' }, body), { ...meta, size: 'major' })
    return this.updateStage({ ...stage, review }, stage.status)
  }

  async decideReview(stageId: string, choice: ReviewChoice): Promise<Stage> {
    const stage = must(this.store.stage(stageId), 'curriculum', '阶段', stageId)
    const review = stage.review
    if (review?.choice) return stage
    if (stage.status !== 'reviewing' || !review) throw new LearningApiError('learning/curriculum/no-review', `阶段 ${stage.index} 还没有写好的复盘`)
    const failed = review.nodes.filter(node => node.result === 'fail')
    const unverified = review.nodes.filter(node => node.result === 'unverified')
    let remedial: Stage | undefined
    if (choice === 'remedial') {
      const nodes = failed.length ? failed : unverified
      const spec = review.remedial ?? (nodes.length ? { title: nodes.map(node => node.title).join('、'), objective: `把${nodes.map(node => node.title).join('、')}补上，再用没见过的题重测。`, nodeIds: nodes.map(node => node.nodeId) } : undefined)
      if (!spec) throw new LearningApiError('learning/curriculum/nothing-to-remedy', '这次复盘没有没过或待验证的知识点，不需要补课')
      remedial = this.core.db.transaction(() => this.store.insertRemedial(stage, spec))
    }
    const decided = this.updateStage({ ...stage, status: 'done', review: { ...review, choice, decidedAt: now() } }, stage.status)
    if (remedial) this.ctx.emit('learning/stage-changed', { stage: remedial, from: undefined })
    const risky = review.task === 'fail' ? [...failed, ...unverified] : failed
    const words = choice === 'remedial'
      ? `先补课（补课阶段「${remedial!.title}」）`
      : `进入下一阶段${risky.length ? `（${review.task === 'fail' ? `完整任务题没过，${risky.map(node => node.title).join('、')}` : `${risky.map(node => node.title).join('、')}没过，`}记为风险）` : ''}${review.task !== 'fail' && unverified.length ? `；待验证：${unverified.map(node => node.title).join('、')}` : ''}`
    const path = `${stage.folder}/${STAGE_LAYOUT.review}`
    const file = await this.core.files.read(stage.courseId, path)
    if (file) {
      const { data, body } = parseFrontmatter(file.text)
      await this.core.files.write(stage.courseId, path, withFrontmatter({ ...data, status: 'decided', choice }, `${body.trimEnd()}\n\n## 你的决定\n\n${words}。\n`), { actor: 'user', reason: '学习者决定复盘后的安排', size: 'minor' })
    }
    if (remedial) await this.writeRoadmap(stage.courseId, { actor: 'user', reason: `学习者决定先补课，插入补课阶段「${remedial.title}」` })
    this.ctx.emit('learning/handoff', { courseId: stage.courseId, unit: 'curriculum', text: `学习者看了阶段 ${stage.index}「${stage.title}」的复盘，决定${words}。` })
    return decided
  }

  async saveReport(courseId: string, input: { readonly markdown: string; readonly facts: CourseReportFacts; readonly finalTestId?: string }, meta: ChangeMeta): Promise<void> {
    const stages = this.store.stages(courseId)
    if (stages.length === 0 || stages.some(stage => stage.status !== 'done')) throw new LearningApiError('learning/curriculum/not-finished', '还有没完成的阶段：所有阶段完成、做过结课检验后再写课程报告')
    const course = must(this.core.courses.get(courseId), 'curriculum', '课程', courseId)
    const body = `# 课程报告：${course.title}\n\n## 目标里的每一条\n\n${reportTable(input.facts)}\n\n${input.markdown.trim()}\n`
    const items = input.facts.items.map(item => ({ key: item.key, text: item.text, status: item.status, missing: [...item.missing] }))
    await this.core.files.write(courseId, COURSE_LAYOUT.report, withFrontmatter({ course: courseId, ...(input.finalTestId ? { final: input.finalTestId } : {}), items, writtenAt: now() }, body), { ...meta, size: 'major' })
    this.core.courses.setStatus(courseId, 'finished')
  }

  async report(courseId: string) {
    const file = await this.core.files.read(courseId, COURSE_LAYOUT.report)
    if (!file) return undefined
    const data = parseFrontmatter(file.text).data as { items?: unknown; writtenAt?: unknown }
    const items = Array.isArray(data.items) ? data.items as { key: string; text: string; status: 'done' | 'gaps' | 'not-done' | 'unchecked'; missing?: string[] }[] : []
    return { items: items.map(item => ({ key: item.key, text: item.text, status: item.status, stages: [], nodes: [], missing: item.missing ?? [] })), writtenAt: String(data.writtenAt ?? '') }
  }

  carried = (courseId: string): CarriedNode[] => carriedOf(this.store.stages(courseId))
}

export function apply(ctx: Context): void {
  const curriculum = new LearnCurriculumService(ctx)
  const endpoint = ctx.learnCore.api.endpoint

  // A finished test completes the task that published it; a stage test moves its stage on to review.
  ctx.on('learning/test-finished', ({ test }) => {
    for (const task of curriculum.tasks(test.courseId, { status: 'open' })) {
      if (task.result?.kind === 'test' && task.result.id === test.id) curriculum.completeTask(task.id)
    }
    const stage = test.kind === 'stage' && test.stageId ? curriculum.stage(test.stageId) : undefined
    if (stage?.status === 'testing' && test.status === 'graded') curriculum.setStatus(stage.id, 'reviewing')
  })

  // Publishing the stage test starts the stage's testing.
  ctx.on('learning/task-published', task => {
    const stage = task.kind === 'stage-test' && task.stageId ? curriculum.stage(task.stageId) : undefined
    if (stage && (stage.status === 'learning' || stage.status === 'ready')) curriculum.setStatus(stage.id, 'testing')
  })

  // The stage's first lesson has its textbook: the stage can start while later lessons are written.
  ctx.on('learning/textbook-ready', ({ stageId, lessonId }) => {
    const stage = curriculum.stage(stageId)
    if (stage?.status === 'designing' && stage.designConfirmedAt && curriculum.lessons(stageId)[0]?.id === lessonId) {
      curriculum.setStatus(stage.id, 'ready')
    }
  })

  ctx.effect(() => endpoint({
    unit: 'curriculum',
    method: 'overview',
    input: z.object({ courseId: z.string() }),
    handle: ({ courseId }) => ({
      stages: curriculum.stages(courseId).map(stage => ({ ...stage, lessons: curriculum.lessons(stage.id) })),
      tasks: curriculum.tasks(courseId),
      revision: curriculum.revision(courseId) ?? null,
    }),
  }), 'curriculum: overview')

  ctx.effect(() => endpoint({
    unit: 'curriculum',
    method: 'report',
    input: z.object({ courseId: z.string() }),
    handle: async ({ courseId }) => {
      const summary = await curriculum.report(courseId)
      if (!summary) return null
      const file = await ctx.learnCore.files.read(courseId, COURSE_LAYOUT.report)
      // A course with stages added after its report is in progress again: the report is the last one.
      return { ...summary, finished: ctx.learnCore.courses.get(courseId)?.status === 'finished', body: file ? parseFrontmatter(file.text).body : '' }
    },
  }), 'curriculum: report')

  ctx.effect(() => endpoint({
    unit: 'curriculum',
    method: 'design',
    input: z.object({ stageId: z.string() }),
    handle: async ({ stageId }) => {
      const stage = must(curriculum.stage(stageId), 'curriculum', '阶段', stageId)
      const file = await ctx.learnCore.files.read(stage.courseId, `${stage.folder}/${STAGE_LAYOUT.design}`)
      return file ? parseFrontmatter(file.text).body : null
    },
  }), 'curriculum: design')

  ctx.effect(() => endpoint({
    unit: 'curriculum',
    method: 'review',
    input: z.object({ stageId: z.string() }),
    handle: async ({ stageId }) => {
      const stage = must(curriculum.stage(stageId), 'curriculum', '阶段', stageId)
      const file = await ctx.learnCore.files.read(stage.courseId, `${stage.folder}/${STAGE_LAYOUT.review}`)
      return file ? parseFrontmatter(file.text).body : null
    },
  }), 'curriculum: review')

  ctx.effect(() => endpoint({
    unit: 'curriculum',
    method: 'decideReview',
    input: z.object({ stageId: z.string(), choice: z.enum(['next', 'remedial']) }),
    handle: ({ stageId, choice }) => curriculum.decideReview(stageId, choice),
  }), 'curriculum: decideReview')

  ctx.effect(() => endpoint({
    unit: 'curriculum',
    method: 'decideRevision',
    input: z.object({ courseId: z.string(), apply: z.boolean() }),
    handle: ({ courseId, apply }) => curriculum.decideRevision(courseId, apply),
  }), 'curriculum: decideRevision')

  ctx.effect(() => endpoint({
    unit: 'curriculum',
    method: 'confirmDesign',
    input: z.object({ stageId: z.string() }),
    handle: ({ stageId }) => curriculum.confirmDesign(stageId),
  }), 'curriculum: confirmDesign')

  ctx.effect(() => endpoint({
    unit: 'curriculum',
    method: 'completeTask',
    input: z.object({ taskId: z.string() }),
    handle: ({ taskId }) => {
      const task = must(curriculum.store.task(taskId), 'curriculum', '任务', taskId)
      const done = curriculum.completeTask(taskId)
      // The learner marked it done on the progress page: the teacher carries on from there.
      if (task.status === 'open') ctx.emit('learning/handoff', { courseId: task.courseId, unit: 'curriculum', text: `学习者完成了任务「${task.title}」。` })
      return done
    },
  }), 'curriculum: completeTask')

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const stages = curriculum.stages(request.courseId)
    const current = curriculum.currentStage(request.courseId)
    const reviewWords = (stage: Stage) => {
      if (stage.status === 'reviewing') return stage.review ? '，复盘已写好，等学习者在课程进度页决定' : '，复盘还没写'
      if (!stage.review?.choice) return ''
      const failed = stage.review.nodes.filter(node => node.result === 'fail').map(node => node.title)
      return stage.review.choice === 'remedial' ? '，复盘后学习者选择先补课' : `，复盘后进入下一阶段${failed.length ? `（${failed.join('、')}没过，记为风险）` : ''}`
    }
    const revision = curriculum.revision(request.courseId)
    const roadmap = stages.length
      ? [
          ...stages.map(stage => `- 阶段 ${stage.index}（${stage.id}）${stage.kind === 'remedial' ? '[补课] ' : ''}${stage.title}：${STAGE_STATUS_LABEL[stage.status]}${stage.status === 'designing' ? (stage.designConfirmedAt ? '，设计已确认，教材生成中' : '，设计待学习者确认') : ''}${reviewWords(stage)}${stage.supports.length ? `；支撑目标 ${stage.supports.join('、')}` : ''}`),
          ...(stages.some(stage => stage.designConfirmedAt) ? ['路线已经开始：save_roadmap 只写计划中的普通阶段（前面已开始或排定的保持不变），写明 reason，学习者在课程进度页确认后才生效。'] : []),
          ...(revision ? [`有一份路线调整等学习者确认（${revision.reason}）。`] : []),
        ].join('\n')
      : '还没有课程路线。'
    const goal = stages.length ? await ctx.learnGoal.get(request.courseId).catch(() => undefined) : undefined
    const uncovered = (goal?.goal.canDo ?? []).filter(item => !stages.some(stage => stage.supports.includes(item.key)))
    const lessons = current
      ? curriculum.lessons(current.id).map(lesson => `- ${lesson.id} ${lesson.number} ${lesson.title}：${{ 'not-started': '未开始', 'in-progress': '进行中', done: '已完成' }[lesson.status]}`).join('\n')
      : ''
    const open = curriculum.tasks(request.courseId, { status: 'open' })
    const tasks = open.length
      ? open.map(task => `- ${task.id} [${TASK_KIND_LABEL[task.kind]}] ${task.title}`).join('\n')
      : '没有待做的任务。'
    return [
      ...sections,
      { unit: 'curriculum', title: '课程路线', text: `${roadmap}${uncovered.length ? `\n目标里还没有阶段对应的条目：${uncovered.map(item => `${item.key} ${item.text}`).join('；')}。用 save_roadmap 或 save_stage_design 的 supports 补上。` : ''}` },
      ...(current ? [{ unit: 'curriculum', title: `当前阶段：${current.index} ${current.title}`, text: `阶段目标：${current.objective}\n${current.nodeIds.length ? `核心知识点 ${current.nodeIds.length} 个（阶段测试按它们组卷）` : '还没记下核心知识点（save_stage_design 的 nodes）'}\n课时：\n${lessons || '（还没有阶段设计）'}` }] : []),
      { unit: 'curriculum', title: '待做任务', text: tasks },
    ]
  })

  ctx.on('learning/describe-selection', async (selection, next) => {
    const lines = await next()
    const picked = selection.selected
    if (picked?.kind === 'stage' && picked.id) {
      const stage = curriculum.stage(picked.id)
      if (stage) lines.push(`选中的阶段：阶段 ${stage.index} ${stage.title}（${STAGE_STATUS_LABEL[stage.status]}）。阶段目标：${stage.objective}`)
    }
    if (picked?.kind === 'lesson' && picked.id) {
      const lesson = curriculum.lesson(picked.id)
      if (lesson) lines.push(`选中的课时：${lesson.number} ${lesson.title}`)
    }
    return lines
  })
}
