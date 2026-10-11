// The minimal learning flow (docs/PLAN.md, development route) across the real host units, on a synthetic chapter.
// DSH's transport, sessions, agents and the model are fakes (tests/harness.ts); every unit's
// service, endpoint, table, course file and event is real. Also checks the hand-back: what the
// learner finishes on a page reaches the teacher, who carries on when the next step is the teacher's.
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Id } from '@learning-agent/contracts'
import { FIXTURES, createHarness, textbookSettled, type Harness } from './harness.ts'

const FIXTURE = join(FIXTURES, 'synthetic-chapter')

let h: Harness
let nodeId = ''
let citation = ''

beforeAll(() => {
  h = createHarness(call => {
    if (call.purpose === 'learning-textbook') return `## 1.1 静水压强\n\n静水压强按 $p=\\rho g h$ 计算。[合成资料 p.1](cite:${citation})\n\n### 读完就答\n\n1. 水深加倍时，静水压强怎样变化？`
    if (call.purpose === 'learning-sidechat-summary') {
      return JSON.stringify({ questions: [{ quote: '水深加倍时会怎样', text: '水深加倍时会怎样？', nodes: ['N1'] }], conclusions: [{ text: '静水压强加倍。', from: 2 }], misconceptions: [], help: [{ reply: 2, level: 'explanation', nodes: ['N1'] }] })
    }
    throw new Error(`unexpected model call: ${call.purpose}`)
  })
})

afterAll(() => h.dispose())

/** The last notice the teacher got, after queued handoffs ran. */
async function lastNotice() {
  await h.settle()
  return h.delivered.at(-1)
}

it('runs the minimal learning flow', async () => {
  const { ctx, endpoint } = h
  const meta = { actor: 'teacher' as const, reason: '合成资料流程测试' }

  // 建课 → 目标草稿 → 学习者确认（老师收到通知，但下一步是学习者的，不唤醒）
  const course = await endpoint('core', 'createCourse', { title: '流程测试（合成资料）' })
  expect((await ctx.learnPlanner.next(course.id)).title).toBe('商量学习目标')
  await ctx.learnGoal.saveDraft(course.id, {
    purpose: '验证最小学习流程', scenario: '合成资料短题', canDo: ['按给定参数计算 $p=\\rho g h$'], level: '能独立完成资料中的计算', verification: '三道摸底与两道小测',
    boundaries: { exclude: ['资料以外的内容'], defaultConditions: { book: 'closed', calculator: true, formulaSheet: false } },
  }, '# 目标说明\n\n仅用于测试。\n', meta)
  expect((await ctx.learnPlanner.next(course.id)).actor).toBe('learner')
  await endpoint('goal', 'confirm', { courseId: course.id })
  expect((await ctx.learnGoal.get(course.id))?.goal.status).toBe('confirmed')
  const confirmed = await lastNotice()
  expect(confirmed).toMatchObject({ mode: 'inject', source: 'learning-handoff' })
  expect(confirmed!.text).toContain('学习者确认了目标说明')
  const opening = confirmed!.sessionId

  // 资料导入（MinerU 结构化结果）→ 检索与出处；加入本课后轮到老师，老师被唤醒
  const source = await endpoint('library', 'import', {
    title: '合成验收资料', kind: 'textbook', authority: '1',
    file: join(FIXTURE, 'source.md'), parsed: [join(FIXTURE, 'middle.json')], courseId: course.id, role: 'skeleton',
  })
  expect(await lastNotice()).toMatchObject({ sessionId: opening, mode: 'followup', text: expect.stringContaining('作为骨架教材') })
  const section = ctx.learnLibrary.section(source.id, '1.1')
  citation = section.find(chunk => chunk.kind === 'text')!.id
  expect(ctx.learnLibrary.search('静水压强', { courseId: course.id }).length).toBeGreaterThan(0)

  // 知识节点：登记不等于掌握
  const graph = await ctx.learnKnowledge.add(course.id, { nodes: [{ title: '静水压强计算', kind: 'skill' }] }, meta)
  nodeId = graph.nodes[0]!.id
  expect(ctx.learnLearner.states([nodeId])).toEqual([])

  // 3 道摸底：交卷前不给答案，交卷后规则判分并追加证据；交卷结果交回老师
  const exercises = ctx.learnLibrary.section(source.id, '习题').filter(chunk => chunk.kind === 'exercise')
  const problems = ctx.learnAssess.addProblems(exercises.map((chunk, i) => ({
    stem: chunk.text,
    answer: { kind: 'numeric' as const, value: (i + 1) * 10000, unit: 'Pa', tolerance: { absolute: 1 } },
    answerSource: 'book' as const, tier: 1 as const,
    origin: { kind: 'chunk' as const, chunkId: chunk.id, label: chunk.citation },
    nodeIds: [nodeId as Id<'node'>], pool: 'practice' as const,
  })))
  const diagnostic = ctx.learnAssess.startTest({ courseId: course.id, kind: 'diagnostic', problemIds: problems.slice(0, 3).map(p => p.id) })
  expect((await endpoint('assess', 'view', { testId: diagnostic.id })).problems[0].answer).toBeUndefined()
  await endpoint('assess', 'submit', { testId: diagnostic.id, answers: problems.slice(0, 3).map((p, i) => ({ problemId: p.id, text: `${(i + 1) * 10000} Pa` })) })
  expect(ctx.learnCore.log.query({ courseId: course.id, types: ['attempt.graded'] })).toHaveLength(3)
  expect(ctx.learnLearner.states([nodeId])[0]?.state).toBe('independent')
  expect(await lastNotice()).toMatchObject({ sessionId: opening, mode: 'followup', text: expect.stringContaining('学习者交了摸底（3 题），判分：对、对、对') })

  // 一页阶段设计 → 确认 → 自动生成一节教材 → 阶段就绪，新阶段会话收到"第一次课"的通知
  const { stages: [stage] } = await ctx.learnCurriculum.saveRoadmap(course.id, [{ title: '静水压强', objective: '按资料参数独立计算静水压强' }], meta)
  const design = await ctx.learnCurriculum.saveDesign(stage!.id, {
    markdown: '# 阶段设计\n\n## 验收\n\n能算静水压强。\n\n## 测试蓝图\n\n小测：水深 4 m 的数值题（保密）。\n\n## 课时\n\n1.1 静水压强。',
    lessons: [{ number: '1.1', title: '静水压强' }],
  }, meta)
  const lesson = design.lessons[0]!
  const settled = textbookSettled(ctx, lesson.id)
  await endpoint('curriculum', 'confirmDesign', { stageId: stage!.id })
  expect(await settled).toBe('ready')
  await h.settle()
  expect(ctx.learnCurriculum.stage(stage!.id)?.status).toBe('ready')
  const kickoff = h.delivered.find(item => item.mode === 'followup' && item.text.includes('教材 1.1 静水压强 已生成'))
  expect(kickoff?.sessionId).not.toBe(opening)
  expect(kickoff?.sessionId).toBe(await ctx.learnTutor.session(course.id))
  expect(kickoff?.text).toContain('第一次课')
  // The writer sees teaching material only: no exercises, no answers, no test blueprint.
  const writer = h.calls.find(call => call.purpose === 'learning-textbook')!.prompt
  expect(writer).toContain(citation)
  expect(writer).not.toContain('1-4 水深')
  expect(writer).not.toContain('40000 Pa')
  expect(writer).not.toContain('保密')
  const blocks = ctx.learnTextbook.blocks(course.id, lesson.textbookFile)
  expect(blocks.some(block => block.citations.includes(citation as never))).toBe(true)
  expect(blocks.filter(block => block.unverified)).toEqual([])
  expect(ctx.learnTextbook.status(lesson.id)).toMatchObject({ state: 'ready', unverified: 0 })

  // 发布阅读任务 → 学习者点"完成"（交回老师）→ 2 道小测 → 任务自动完成 → 汇报与小结
  const read = ctx.learnCurriculum.publishTask({ courseId: course.id, stageId: stage!.id, lessonId: lesson.id, kind: 'read', title: '读 1.1', instructions: '读完本节', createdBy: 'teacher' })
  expect(ctx.learnCurriculum.stage(stage!.id)?.status).toBe('learning')
  await endpoint('curriculum', 'completeTask', { taskId: read.id })
  expect(await lastNotice()).toMatchObject({ sessionId: kickoff!.sessionId, mode: 'followup', text: expect.stringContaining('学习者完成了任务「读 1.1」') })
  expect((await ctx.learnPlanner.next(course.id)).title).toBe('出 1.1 的小测')
  const quiz = ctx.learnAssess.startTest({ courseId: course.id, kind: 'quiz', stageId: stage!.id, lessonId: lesson.id, problemIds: problems.slice(3).map(p => p.id) })
  ctx.learnCurriculum.publishTask({ courseId: course.id, stageId: stage!.id, lessonId: lesson.id, kind: 'quiz', title: '小测', instructions: '凭记忆作答', createdBy: 'teacher', result: { kind: 'test', id: quiz.id } })
  await endpoint('assess', 'submit', { testId: quiz.id, answers: problems.slice(3).map((p, i) => ({ problemId: p.id, text: `${(i + 4) * 10000} Pa` })) })
  expect(ctx.learnCurriculum.tasks(course.id, { lessonId: lesson.id }).every(task => task.status === 'done')).toBe(true)
  // One notice for the submission, though it also completed the quiz task.
  const quizNotice = await lastNotice()
  expect(quizNotice).toMatchObject({ mode: 'followup', text: expect.stringContaining('学习者交了小测（2 题），判分：对、对') })
  await ctx.learnTutor.writeLessonSummary(lesson.id, { summary: '小测两题正确。', learnerReport: '我能按给定参数计算。' }, meta)
  expect(ctx.learnCurriculum.lesson(lesson.id)?.status).toBe('done')
  expect((await ctx.learnCore.files.read(course.id, lesson.recordFile!))?.text).toContain('对 2/2')
  // Every lesson done: the stage test, assembled by the program (docs/assess/design.md, B).
  expect(await ctx.learnPlanner.next(course.id)).toMatchObject({ actor: 'teacher', title: '发布阶段 1 的阶段测试' })
  // The teacher's own actions are not handed back to the teacher.
  await h.settle()
  expect(h.delivered.at(-1)).toBe(quizNotice)

  // 侧边会话：与主老师隔离，结束写总结、记帮助，不提升掌握状态，重复关闭不重复写
  const teacher = await ctx.learnTutor.session(course.id)
  const side = await ctx.learnSidechat.open({ courseId: course.id, page: 'textbook.reader', selected: { kind: 'block', id: blocks[0]!.id, label: '静水压强' } } as never)
  expect(side.sessionId).not.toBe(teacher)
  await ctx.sessionController.prompt({ requestId: globalThis.crypto.randomUUID(), sessionId: side.sessionId, mode: 'queue', content: [{ type: 'text', text: '水深加倍时会怎样？' }] } as never, new AbortController().signal)
  const summary = await ctx.learnSidechat.close(side.sessionId)
  expect((await ctx.learnSidechat.close(side.sessionId)).id).toBe(summary.id)
  expect((await ctx.learnCore.files.read(course.id, 'notes/side-chats.md'))?.text).toContain('水深加倍')
  expect(ctx.learnCore.log.query({ courseId: course.id, types: ['help.given'] })).toHaveLength(1)
  expect(ctx.learnCore.sessions.get(side.sessionId)?.closedAt).toBeTruthy()
  expect(ctx.learnLearner.states([nodeId])[0]?.state).toBe('independent')

  // 每轮课程简报汇总各单元，"下一步"在最前
  const brief = await ctx.learnTutor.brief(course.id, teacher)
  expect(brief.indexOf('## 下一步')).toBeGreaterThan(0)
  expect(brief.indexOf('## 下一步')).toBeLessThan(brief.indexOf('## 目标说明'))
})
