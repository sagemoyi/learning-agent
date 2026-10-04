// curriculum unit, host half. Provides `ctx.learnCurriculum` (contracts §5.1): the roadmap, stages
// and their lifecycle, stage designs, lessons (= textbook subsections) and tasks.
// Stage lifecycle in the skeleton: planned → designing (design saved) → design confirmed (textbook
// generation starts) → ready (its first lesson's textbook is ready) → learning (first task published) → … done.
// Stage tests, reviews and remedial stages come when the unit is built out (PLAN §4.8–4.9).
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  COURSE_LAYOUT,
  LearningApiError,
  STAGE_LAYOUT,
  Task,
  newId,
  parseFrontmatter,
  withFrontmatter,
  type ChangeMeta,
  type LearnCurriculum,
  type Lesson,
  type Stage,
} from '@learning-agent/contracts'
import { must, now } from '@learning-agent/kit'
import { z } from 'zod'
import { CurriculumStore, curriculumMigrations } from './store.ts'

export const name = 'learning-curriculum'
export const inject = ['learnCore']

export const STAGE_STATUS_LABEL: Record<Stage['status'], string> = {
  planned: '计划中', designing: '设计中', ready: '待学习', learning: '学习中', testing: '测试中', reviewing: '复盘中', done: '已完成',
}
const TASK_KIND_LABEL: Record<Task['kind'], string> = {
  predict: '预测', read: '阅读', quiz: '小测', practice: '练习', report: '汇报', 'stage-test': '阶段测试', review: '复查', other: '其他',
}

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

  async saveRoadmap(courseId: string, drafts: readonly { readonly title: string; readonly objective: string }[], meta: ChangeMeta): Promise<Stage[]> {
    if (drafts.length === 0) throw new LearningApiError('learning/curriculum/empty-roadmap', '路线至少要有一个阶段')
    const { stages, created } = this.core.db.transaction(() => this.store.applyRoadmap(courseId, drafts))
    const body = stages.map(stage => `## 阶段 ${stage.index}：${stage.title}\n\n${stage.objective}\n`).join('\n')
    await this.core.files.write(courseId, COURSE_LAYOUT.roadmap, withFrontmatter({ course: courseId, stages: stages.map(stage => stage.id) }, `# 课程路线\n\n${body}`), { ...meta, size: 'major' })
    for (const stage of created) this.ctx.emit('learning/stage-changed', { stage, from: undefined })
    return stages
  }

  async saveDesign(stageId: string, input: { readonly markdown: string; readonly lessons: readonly { readonly number: string; readonly title: string }[] }, meta: ChangeMeta) {
    const stage = must(this.store.stage(stageId), 'curriculum', '阶段', stageId)
    if (input.lessons.length === 0) throw new LearningApiError('learning/curriculum/no-lessons', '阶段设计至少要有一个课时')
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
}

export function apply(ctx: Context): void {
  const curriculum = new LearnCurriculumService(ctx)
  const endpoint = ctx.learnCore.api.endpoint

  // A finished test completes the task that published it.
  ctx.on('learning/test-finished', ({ test }) => {
    for (const task of curriculum.tasks(test.courseId, { status: 'open' })) {
      if (task.result?.kind === 'test' && task.result.id === test.id) curriculum.completeTask(task.id)
    }
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
    }),
  }), 'curriculum: overview')

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
    const roadmap = stages.length
      ? stages.map(stage => `- 阶段 ${stage.index}（${stage.id}）${stage.title}：${STAGE_STATUS_LABEL[stage.status]}${stage.status === 'designing' ? (stage.designConfirmedAt ? '，设计已确认，教材生成中' : '，设计待学习者确认') : ''}`).join('\n')
      : '还没有课程路线。'
    const lessons = current
      ? curriculum.lessons(current.id).map(lesson => `- ${lesson.id} ${lesson.number} ${lesson.title}：${{ 'not-started': '未开始', 'in-progress': '进行中', done: '已完成' }[lesson.status]}`).join('\n')
      : ''
    const open = curriculum.tasks(request.courseId, { status: 'open' })
    const tasks = open.length
      ? open.map(task => `- ${task.id} [${TASK_KIND_LABEL[task.kind]}] ${task.title}`).join('\n')
      : '没有待做的任务。'
    return [
      ...sections,
      { unit: 'curriculum', title: '课程路线', text: roadmap },
      ...(current ? [{ unit: 'curriculum', title: `当前阶段：${current.index} ${current.title}`, text: `阶段目标：${current.objective}\n课时：\n${lessons || '（还没有阶段设计）'}` }] : []),
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
