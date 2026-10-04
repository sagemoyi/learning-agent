// The PLAN §10 minimal learning flow across the real host units, on a synthetic chapter.
// DSH's transport, sessions and the model are fakes; every unit's service, endpoint, table,
// course file and event is real. Run against a fresh data root in the system temp folder.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Id } from '@learning-agent/contracts'
import * as core from '../packages/core/src/index.ts'
import * as library from '../packages/library/src/index.ts'
import * as knowledge from '../packages/knowledge/src/index.ts'
import * as goal from '../packages/goal/src/index.ts'
import * as assess from '../packages/assess/src/index.ts'
import * as curriculum from '../packages/curriculum/src/index.ts'
import * as textbook from '../packages/textbook/src/index.ts'
import * as learner from '../packages/learner/src/index.ts'
import * as sidechat from '../packages/sidechat/src/index.ts'
import * as tutor from '../packages/tutor/src/index.ts'
import * as planner from '../packages/planner/src/index.ts'

const FIXTURE = resolve(import.meta.dirname, 'fixtures/synthetic-chapter')

let root: string
let ctx: Context
const routes = new Map<string, { fetch(request: Request): Promise<Response> }>()
const sessions = new Map<string, { events: { type: string; data: unknown }[] }>()
const prompts: Record<string, string> = {}
let nodeId = ''
let citation = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'learning-flow-'))
  process.env.LEARNING_HOME = root
  ctx = new Context()
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; fetch(request: Request): Promise<Response> }) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  })
  ctx.provide('workspaceRegistry', { create: async () => ({ id: globalThis.crypto.randomUUID() }) })
  ctx.provide('sessionController', {
    modelCatalog: async () => ({ default: { provider: 'fixture', model: 'fixture' } }),
    create: async (input: { sessionId: string }) => {
      sessions.set(input.sessionId, { events: [] })
      return { sessionId: input.sessionId }
    },
    inspect: async (id: string) => sessions.get(id),
    prompt: async (input: { sessionId: string; content: unknown }) => {
      const session = sessions.get(input.sessionId)!
      session.events.push({ type: 'user/message', data: { content: input.content, source: { kind: 'user' } } })
      session.events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '水深加倍，静水压强也加倍。' }] } } })
      return { ok: true }
    },
  })
  ctx.provide('llm', {
    async *stream(options: { purpose: string; messages: { content: { text: string }[] }[] }) {
      prompts[options.purpose] = options.messages[0]!.content[0]!.text
      let text: string
      if (options.purpose === 'learning-textbook') {
        text = `## 1.1 静水压强\n\n静水压强按 $p=\\rho g h$ 计算。[合成资料 p.1](cite:${citation})\n\n### 读完就答\n\n1. 水深加倍时，静水压强怎样变化？`
      } else if (options.purpose === 'learning-sidechat-summary') {
        text = JSON.stringify({ questions: ['水深加倍时会怎样？'], conclusions: ['静水压强加倍。'], nodeIds: [nodeId], misconceptions: [], help: [{ nodeIds: [nodeId], level: 'explanation' }] })
      } else {
        throw new Error(`unexpected model call: ${options.purpose}`)
      }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  for (const plugin of [core, library, knowledge, goal, assess, curriculum, textbook, learner, sidechat, tutor, planner]) plugin.apply(ctx as never)
})

afterAll(() => {
  ctx.learnCore.db.sqlite.close()
  rmSync(root, { recursive: true, force: true })
})

/** Call an endpoint the way the page does, through its exact route and the RPC envelope. */
async function endpoint<T = any>(unit: string, method: string, payload: unknown): Promise<T> {
  const route = routes.get(`/api/learning/${unit}.${method}`)
  expect(route, `${unit}.${method} registered`).toBeTruthy()
  const response = await route!.fetch(new Request(`http://localhost/api/learning/${unit}.${method}`, {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'flow', payload }),
  }))
  const message = await response.json() as { result: { ok: boolean; value: T; error?: unknown } }
  expect(message.result.ok, JSON.stringify(message.result.error)).toBe(true)
  return message.result.value
}

it('runs the minimal learning flow', async () => {
  const meta = { actor: 'teacher' as const, reason: '合成资料流程测试' }

  // 建课 → 目标草稿 → 学习者确认
  const course = await endpoint('core', 'createCourse', { title: '流程测试（合成资料）' })
  expect((await ctx.learnPlanner.next(course.id)).title).toBe('商量学习目标')
  await ctx.learnGoal.saveDraft(course.id, {
    purpose: '验证最小学习流程', scenario: '合成资料短题', canDo: ['按给定参数计算 $p=\\rho g h$'], level: '能独立完成资料中的计算', verification: '三道摸底与两道小测',
    boundaries: { exclude: ['资料以外的内容'], defaultConditions: { book: 'closed', calculator: true, formulaSheet: false } },
  }, '# 目标说明\n\n仅用于测试。\n', meta)
  expect((await ctx.learnPlanner.next(course.id)).actor).toBe('learner')
  await endpoint('goal', 'confirm', { courseId: course.id })
  expect((await ctx.learnGoal.get(course.id))?.goal.status).toBe('confirmed')

  // 资料导入（MinerU 结构化结果）→ 检索与出处
  const source = await endpoint('library', 'import', {
    title: '合成验收资料', kind: 'textbook', authority: '1',
    file: join(FIXTURE, 'source.md'), parsed: [join(FIXTURE, 'middle.json')], courseId: course.id, role: 'skeleton',
  })
  const section = ctx.learnLibrary.section(source.id, '1.1')
  citation = section.find(chunk => chunk.kind === 'text')!.id
  expect(ctx.learnLibrary.search('静水压强', { courseId: course.id }).length).toBeGreaterThan(0)

  // 知识节点：登记不等于掌握
  const graph = await ctx.learnKnowledge.add(course.id, { nodes: [{ title: '静水压强计算', kind: 'skill' }] }, meta)
  nodeId = graph.nodes[0]!.id
  expect(ctx.learnLearner.states([nodeId])).toEqual([])

  // 3 道摸底：交卷前不给答案，交卷后规则判分并追加证据
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

  // 一页阶段设计 → 确认 → 自动生成一节教材 → 阶段就绪
  const [stage] = await ctx.learnCurriculum.saveRoadmap(course.id, [{ title: '静水压强', objective: '按资料参数独立计算静水压强' }], meta)
  const design = await ctx.learnCurriculum.saveDesign(stage!.id, {
    markdown: '# 阶段设计\n\n## 验收\n\n能算静水压强。\n\n## 测试蓝图\n\n小测：水深 4 m 的数值题（保密）。\n\n## 课时\n\n1.1 静水压强。',
    lessons: [{ number: '1.1', title: '静水压强' }],
  }, meta)
  const ready = new Promise<void>(done => ctx.on('learning/textbook-ready', ({ stageId }) => { if (stageId === stage!.id) done() }))
  await endpoint('curriculum', 'confirmDesign', { stageId: stage!.id })
  await ready
  await new Promise(done => setTimeout(done, 30))
  expect(ctx.learnCurriculum.stage(stage!.id)?.status).toBe('ready')
  // The writer sees teaching material only: no exercises, no answers, no test blueprint.
  expect(prompts['learning-textbook']).toContain(citation)
  expect(prompts['learning-textbook']).not.toContain('1-4 水深')
  expect(prompts['learning-textbook']).not.toContain('40000 Pa')
  expect(prompts['learning-textbook']).not.toContain('保密')
  const lesson = design.lessons[0]!
  const blocks = ctx.learnTextbook.blocks(course.id, lesson.textbookFile)
  expect(blocks.some(block => block.citations.includes(citation as never))).toBe(true)
  expect(blocks.filter(block => block.unverified)).toEqual([])

  // 发布阅读任务 → 完成 → 2 道小测 → 任务自动完成 → 汇报与小结
  const read = ctx.learnCurriculum.publishTask({ courseId: course.id, stageId: stage!.id, lessonId: lesson.id, kind: 'read', title: '读 1.1', instructions: '读完本节', createdBy: 'teacher' })
  expect(ctx.learnCurriculum.stage(stage!.id)?.status).toBe('learning')
  await endpoint('curriculum', 'completeTask', { taskId: read.id })
  const quiz = ctx.learnAssess.startTest({ courseId: course.id, kind: 'quiz', stageId: stage!.id, lessonId: lesson.id, problemIds: problems.slice(3).map(p => p.id) })
  ctx.learnCurriculum.publishTask({ courseId: course.id, stageId: stage!.id, lessonId: lesson.id, kind: 'quiz', title: '小测', instructions: '凭记忆作答', createdBy: 'teacher', result: { kind: 'test', id: quiz.id } })
  await endpoint('assess', 'submit', { testId: quiz.id, answers: problems.slice(3).map((p, i) => ({ problemId: p.id, text: `${(i + 4) * 10000} Pa` })) })
  expect(ctx.learnCurriculum.tasks(course.id, { lessonId: lesson.id }).every(task => task.status === 'done')).toBe(true)
  await ctx.learnTutor.writeLessonSummary(lesson.id, { summary: '小测两题正确。', learnerReport: '我能按给定参数计算。' }, meta)
  expect(ctx.learnCurriculum.lesson(lesson.id)?.status).toBe('done')
  expect((await ctx.learnCore.files.read(course.id, lesson.recordFile!))?.text).toContain('对 2/2')

  // 侧边会话：与主老师隔离，结束写总结、记帮助，不提升掌握状态，重复关闭不重复写
  const opening = await ctx.learnTutor.session(course.id)
  const side = await ctx.learnSidechat.open({ courseId: course.id, page: 'textbook.reader', selected: { kind: 'block', id: blocks[0]!.id, label: '静水压强' } } as never)
  expect(side.sessionId).not.toBe(opening)
  await ctx.sessionController.prompt({ requestId: globalThis.crypto.randomUUID(), sessionId: side.sessionId, mode: 'queue', content: [{ type: 'text', text: '水深加倍时会怎样？' }] } as never, new AbortController().signal)
  const summary = await ctx.learnSidechat.close(side.sessionId)
  expect((await ctx.learnSidechat.close(side.sessionId)).id).toBe(summary.id)
  expect((await ctx.learnCore.files.read(course.id, 'notes/side-chats.md'))?.text).toContain('水深加倍')
  expect(ctx.learnCore.log.query({ courseId: course.id, types: ['help.given'] })).toHaveLength(1)
  expect(ctx.learnCore.sessions.get(side.sessionId)?.closedAt).toBeTruthy()
  expect(ctx.learnLearner.states([nodeId])[0]?.state).toBe('independent')

  // 每轮课程简报汇总各单元，"下一步"在最前
  const brief = await ctx.learnTutor.brief(course.id, opening)
  expect(brief.indexOf('## 下一步')).toBeGreaterThan(0)
  expect(brief.indexOf('## 下一步')).toBeLessThan(brief.indexOf('## 目标说明'))
})
