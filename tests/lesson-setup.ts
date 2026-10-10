// A course at its first lesson, for tests that need a stage under way: the goal confirmed, the synthetic
// chapter as the skeleton textbook, one knowledge node, the chapter's exercises as practice problems
// (answers 10000, 20000, … Pa), a finished diagnostic, and a one-lesson stage whose textbook is written.
import { join } from 'node:path'
import type { Id, Lesson, Problem, Stage } from '@learning-agent/contracts'
import { FIXTURES, textbookSettled, type Harness, type ModelCall } from './harness.ts'

const FIXTURE = join(FIXTURES, 'synthetic-chapter')
const meta = { actor: 'teacher' as const, reason: '课时测试准备（合成）' }

let citation = ''

/** The fake writer's lesson for 1.1; `undefined` for any other call. */
export function lessonText(call: ModelCall): string | undefined {
  if (call.purpose === 'learning-textbook') return `## 1.1 静水压强\n\n静水压强按 $p=\\rho g h$ 计算。[合成资料 p.1](cite:${citation})\n\n### 读完就答\n\n1. 水深加倍时，静水压强怎样变化？`
  return undefined
}

export interface LessonCourse {
  readonly courseId: string
  readonly nodeId: string
  readonly stage: Stage
  readonly lesson: Lesson
  readonly problems: readonly Problem[]
}

/** `beforeConfirm` runs just before the learner confirms the stage design (and its textbook is written). */
export async function lessonCourse(h: Harness, title: string, beforeConfirm?: () => void): Promise<LessonCourse> {
  const { ctx, endpoint } = h
  const course = await endpoint('core', 'createCourse', { title })
  const courseId = course.id as string
  await ctx.learnGoal.saveDraft(courseId, {
    purpose: '课时测试', scenario: '合成资料短题', canDo: ['按给定参数计算静水压强'], level: '能独立完成资料中的计算', verification: '小测',
    boundaries: { exclude: ['资料以外的内容'], defaultConditions: { book: 'closed', calculator: true, formulaSheet: false } },
  }, '# 目标说明\n\n仅用于测试。\n', meta)
  await endpoint('goal', 'confirm', { courseId })
  const source = await endpoint('library', 'import', {
    title: '合成验收资料', kind: 'textbook', authority: '1',
    file: join(FIXTURE, 'source.md'), parsed: [join(FIXTURE, 'middle.json')], courseId, role: 'skeleton',
  })
  citation = ctx.learnLibrary.section(source.id, '1.1').find(chunk => chunk.kind === 'text')!.id
  const graph = await ctx.learnKnowledge.add(courseId, { nodes: [{ title: '静水压强计算', kind: 'skill' }] }, meta)
  const nodeId = graph.nodes[0]!.id as string
  const exercises = ctx.learnLibrary.section(source.id, '习题').filter(chunk => chunk.kind === 'exercise')
  const problems = ctx.learnAssess.addProblems(exercises.map((chunk, i) => ({
    stem: chunk.text,
    answer: { kind: 'numeric' as const, value: (i + 1) * 10000, unit: 'Pa', tolerance: { absolute: 1 } },
    answerSource: 'book' as const, tier: 1 as const,
    origin: { kind: 'chunk' as const, chunkId: chunk.id, label: chunk.citation },
    nodeIds: [nodeId as Id<'node'>], pool: 'practice' as const,
  })))
  const diagnostic = ctx.learnAssess.startTest({ courseId, kind: 'diagnostic', problemIds: [problems[0]!.id] })
  await endpoint('assess', 'submit', { testId: diagnostic.id, answers: [{ problemId: problems[0]!.id, text: '10000 Pa' }] })
  const { stages } = await ctx.learnCurriculum.saveRoadmap(courseId, [{ title: '静水压强', objective: '按资料参数计算静水压强' }], meta)
  const design = await ctx.learnCurriculum.saveDesign(stages[0]!.id, {
    markdown: '# 阶段设计\n\n## 验收\n\n能算静水压强。\n\n## 测试蓝图\n\n小测。\n\n## 课时\n\n1.1 静水压强。',
    lessons: [{ number: '1.1', title: '静水压强' }],
  }, meta)
  const lesson = design.lessons[0]!
  beforeConfirm?.()
  const settled = textbookSettled(ctx, lesson.id)
  await endpoint('curriculum', 'confirmDesign', { stageId: stages[0]!.id })
  if (await settled !== 'ready') throw new Error('textbook not written')
  await h.settle()
  return { courseId, nodeId, stage: ctx.learnCurriculum.stage(stages[0]!.id)!, lesson, problems }
}
