// What the library's pages and the 本课资料 panel share: the rows the host sends, labels, and how a source opens.
import type { CourseSource, IndexState, Source } from '@learning-agent/contracts'
import type { LearnShell } from '@learning-agent/contracts/client'
import type { OutlineEntry } from './outline.ts'

/** A course using a source, in the whole-library list. */
export type SourceCourse = { id: string; title: string; role: CourseSource['role'] }
/** The whole library (主界面): each source with the courses that use it. */
export type LibraryRow = { source: Source; chunks: number; index?: IndexState; courses: SourceCourse[] }
/** One course's sources in their roles; sources read as pages carry their chapter outline. */
export type CourseRow = { source: Source; chunks: number; index?: IndexState; role: CourseSource['role']; outline?: OutlineEntry[] }
/** Where PDFs are parsed and which service embeds them, from the library's settings and keys. */
export type Services = { parser: '本机' | '云端'; parserReady: boolean; semanticSearch: boolean; embeddings?: string; webSearch: string[] }
/** The lessons citing a source (`textbook.sourceUses`). */
export type LessonUse = { id: string; number: string; title: string }

export const ROLE_LABEL: Record<CourseSource['role'], string> = { skeleton: '骨架教材', reference: '参考资料', 'exam-archive': '往年试题' }
export const ROLE_HINT: Record<CourseSource['role'], string> = { skeleton: '教材按它的结构编写', reference: '讲解和出题时一并查', 'exam-archive': '按题号导入，组模拟考' }
export const ROLES: readonly CourseSource['role'][] = ['skeleton', 'reference', 'exam-archive']
export const AUTHORITY_LABEL: Record<Source['authority'], string> = { '1': '一级', '2': '二级', '3': '三级', clue: '只当线索' }

export function isWeb(source: Source): boolean {
  return source.origin.kind === 'web'
}

/** A kept web page, read as its text rather than as pages. */
export function isWebPage(source: Source): boolean {
  return source.origin.kind === 'web' && source.origin.format === 'html'
}

/** The page number printed in the book, when the PDF page has one. */
export function printedPage(source: Source, page: number): number | undefined {
  const printed = page - source.pageOffset
  return printed > 0 ? printed : undefined
}

export function siteOf(source: Source): string {
  if (source.origin.kind !== 'web') return ''
  try { return new URL(source.origin.url).hostname.replace(/^www\./, '') } catch { return source.origin.url }
}

/** "1.2、1.3 引用", or "1.2、1.3、1.4 等 6 节引用" past three lessons. */
export function usesText(lessons: readonly LessonUse[]): string {
  if (lessons.length === 0) return ''
  const shown = lessons.slice(0, 3).map(lesson => lesson.number).join('、')
  return lessons.length > 3 ? `${shown} 等 ${lessons.length} 节引用` : `${shown} 引用`
}

/** Open a source in the current tab, at a PDF page when given. */
export function openSource(shell: LearnShell, source: Source, page?: number): void {
  shell.openPage('library.sources', page ? { sourceId: source.id, page } : { sourceId: source.id }, { title: source.title })
}

export function openLesson(shell: LearnShell, lesson: LessonUse): void {
  shell.openPage('textbook.reader', { id: lesson.id }, { title: `${lesson.number} ${lesson.title}` })
}
