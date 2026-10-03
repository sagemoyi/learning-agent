// Data-root and course-folder layout (contracts §3.1). Paths are relative, forward-slash.

/** Under the data root (default `Documents/学习库`, overridable with LEARNING_HOME). */
export const DATA_LAYOUT = {
  appDir: '.learning',
  database: '.learning/learning.db',
  cache: '.learning/cache',
  library: 'library',
  courses: 'courses',
} as const

/** Under one course folder. */
export const COURSE_LAYOUT = {
  card: 'course.md',
  goal: 'goal.md',
  roadmap: 'roadmap.md',
  report: 'report.md',
  sideChats: 'notes/side-chats.md',
  attachments: 'attachments',
  stages: 'stages',
} as const

/** Under one stage folder. */
export const STAGE_LAYOUT = {
  design: 'design.md',
  review: 'review.md',
  textbook: 'textbook',
  lessons: 'lessons',
} as const

/** A title made safe as a Windows/macOS/Linux file name; keeps Chinese as is. */
export function safeFileName(title: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  return cleaned.slice(0, 60) || '未命名'
}

/** `stages/01-流体流动` */
export function stageFolder(index: number, title: string): string {
  return `${COURSE_LAYOUT.stages}/${String(index).padStart(2, '0')}-${safeFileName(title)}`
}

/** `stages/01-流体流动/textbook/1.1-流体静力学.md` */
export function textbookFile(stageDir: string, number: string, title: string): string {
  return `${stageDir}/${STAGE_LAYOUT.textbook}/${safeFileName(`${number}-${title}`)}.md`
}

/** `stages/01-流体流动/lessons/1.1.md` */
export function lessonRecordFile(stageDir: string, number: string): string {
  return `${stageDir}/${STAGE_LAYOUT.lessons}/${safeFileName(number)}.md`
}
