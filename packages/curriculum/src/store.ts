// Stages, lessons and tasks. Owner of `curriculum_*` tables (contracts §4.3).
import type { DatabaseSync } from 'node:sqlite'
import {
  LearningApiError,
  Lesson,
  Stage,
  Task,
  lessonRecordFile,
  newId,
  stageFolder,
  textbookFile,
  type Migration,
} from '@learning-agent/contracts'

export const curriculumMigrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE curriculum_stages (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX curriculum_stages_course ON curriculum_stages (course_id, idx);
      CREATE TABLE curriculum_lessons (
        id TEXT PRIMARY KEY,
        stage_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX curriculum_lessons_stage ON curriculum_lessons (stage_id, idx);
      CREATE TABLE curriculum_tasks (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX curriculum_tasks_course ON curriculum_tasks (course_id, status);
    `,
  },
]

export class CurriculumStore {
  constructor(private readonly sqlite: DatabaseSync) {}

  stages(courseId: string): Stage[] {
    return (this.sqlite.prepare('SELECT data FROM curriculum_stages WHERE course_id = ? ORDER BY idx').all(courseId) as { data: string }[])
      .map(row => Stage.parse(JSON.parse(row.data)))
  }

  stage(stageId: string): Stage | undefined {
    const row = this.sqlite.prepare('SELECT data FROM curriculum_stages WHERE id = ?').get(stageId) as { data: string } | undefined
    return row ? Stage.parse(JSON.parse(row.data)) : undefined
  }

  saveStage(stage: Stage): Stage {
    const parsed = Stage.parse(stage)
    this.sqlite.prepare(`INSERT INTO curriculum_stages (id, course_id, idx, data) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET idx = excluded.idx, data = excluded.data`).run(parsed.id, parsed.courseId, parsed.index, JSON.stringify(parsed))
    return parsed
  }

  deleteStage(stageId: string): void {
    this.sqlite.prepare('DELETE FROM curriculum_lessons WHERE stage_id = ?').run(stageId)
    this.sqlite.prepare('DELETE FROM curriculum_stages WHERE id = ?').run(stageId)
  }

  /** Create or rename the course's stages to match the roadmap; only planned stages may be dropped. */
  applyRoadmap(courseId: string, drafts: readonly { title: string; objective: string }[]): { stages: Stage[]; created: Stage[] } {
    const existing = this.stages(courseId)
    const created: Stage[] = []
    drafts.forEach((draft, position) => {
      const index = position + 1
      const current = existing[position]
      if (current) {
        this.saveStage({ ...current, index, title: draft.title, objective: draft.objective })
      } else {
        const stage = this.saveStage(Stage.parse({
          id: newId('stage'),
          courseId,
          index,
          title: draft.title,
          objective: draft.objective,
          kind: 'normal',
          status: 'planned',
          folder: stageFolder(index, draft.title),
        }))
        created.push(stage)
      }
    })
    for (const extra of existing.slice(drafts.length)) {
      if (extra.status !== 'planned') throw new LearningApiError('learning/curriculum/stage-in-use', `阶段 ${extra.index}「${extra.title}」已经开始，不能从路线里删掉`, { stageId: extra.id })
      this.deleteStage(extra.id)
    }
    return { stages: this.stages(courseId), created }
  }

  lessons(stageId: string): Lesson[] {
    return (this.sqlite.prepare('SELECT data FROM curriculum_lessons WHERE stage_id = ? ORDER BY idx').all(stageId) as { data: string }[])
      .map(row => Lesson.parse(JSON.parse(row.data)))
  }

  lesson(lessonId: string): Lesson | undefined {
    const row = this.sqlite.prepare('SELECT data FROM curriculum_lessons WHERE id = ?').get(lessonId) as { data: string } | undefined
    return row ? Lesson.parse(JSON.parse(row.data)) : undefined
  }

  saveLesson(lesson: Lesson): Lesson {
    const parsed = Lesson.parse(lesson)
    this.sqlite.prepare(`INSERT INTO curriculum_lessons (id, stage_id, idx, data) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET idx = excluded.idx, data = excluded.data`).run(parsed.id, parsed.stageId, parsed.index, JSON.stringify(parsed))
    return parsed
  }

  /** Replace a stage's lessons with the design's list, keeping lessons already started. */
  applyLessons(stage: Stage, drafts: readonly { number: string; title: string }[]): Lesson[] {
    const existing = this.lessons(stage.id)
    const started = existing.filter(lesson => lesson.status !== 'not-started')
    for (const lesson of existing) if (lesson.status === 'not-started') this.sqlite.prepare('DELETE FROM curriculum_lessons WHERE id = ?').run(lesson.id)
    drafts.forEach((draft, position) => {
      const kept = started.find(lesson => lesson.number === draft.number)
      if (kept) {
        this.saveLesson({ ...kept, index: position + 1, title: draft.title })
        return
      }
      this.saveLesson(Lesson.parse({
        id: newId('lesson'),
        stageId: stage.id,
        index: position + 1,
        number: draft.number,
        title: draft.title,
        status: 'not-started',
        textbookFile: textbookFile(stage.folder, draft.number, draft.title),
        recordFile: lessonRecordFile(stage.folder, draft.number),
      }))
    })
    return this.lessons(stage.id)
  }

  saveTask(task: Task): Task {
    const parsed = Task.parse(task)
    this.sqlite.prepare(`INSERT INTO curriculum_tasks (id, course_id, status, data) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET status = excluded.status, data = excluded.data`).run(parsed.id, parsed.courseId, parsed.status, JSON.stringify(parsed))
    return parsed
  }

  task(taskId: string): Task | undefined {
    const row = this.sqlite.prepare('SELECT data FROM curriculum_tasks WHERE id = ?').get(taskId) as { data: string } | undefined
    return row ? Task.parse(JSON.parse(row.data)) : undefined
  }

  tasks(courseId: string, filter: { status?: Task['status']; lessonId?: string } = {}): Task[] {
    return (this.sqlite.prepare(`SELECT data FROM curriculum_tasks WHERE course_id = ? ${filter.status ? 'AND status = ?' : ''} ORDER BY id`)
      .all(...[courseId, ...(filter.status ? [filter.status] : [])]) as { data: string }[])
      .map(row => Task.parse(JSON.parse(row.data)))
      .filter(task => !filter.lessonId || task.lessonId === filter.lessonId)
  }
}
