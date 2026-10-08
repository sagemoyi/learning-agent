// assess unit, agent tools: add problems, start a test (published as a task), read a test's result.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { Answer, NewProblem, Task, Test } from '@learning-agent/contracts'
import { linkOf, textTool } from '@learning-agent/kit'
import { answerText } from './grading.ts'

export const name = 'learning-assess-tools'
export const inject = ['tools', 'learnAssess', 'learnKnowledge', 'learnLibrary', 'learnCurriculum', 'learnCore']

const TASK_KIND: Record<Test['kind'], Task['kind']> = { diagnostic: 'quiz', quiz: 'quiz', practice: 'practice', stage: 'stage-test', review: 'review', mock: 'stage-test' }
const KIND_LABEL: Record<Test['kind'], string> = { diagnostic: '摸底', quiz: '小测', practice: '练习', stage: '阶段测试', review: '复查', mock: '模拟考' }

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(textTool({
    name: 'add_problems',
    title: '加入题库',
    description: '把题目加入题库。优先用资料里的原题（tier 1，answerSource "book"，带 chunkId）。数值题写 value、unit，误差默认 2%；多问的题用 open 并在 rubric 里写全各问答案。你自己出的题只能是 tier 4、pool "practice"、answerSource "unverified"。每题至少挂一个本课知识节点（写标题或 ID）。',
    parameters: {
      problems: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stem: { type: 'string', required: true, description: '题干（Markdown，公式用 $…$）' },
            answerKind: { type: 'string', required: true, enum: ['numeric', 'choice', 'expression', 'open'] },
            value: { type: 'number', description: 'numeric：参考数值' },
            unit: { type: 'string', description: 'numeric：单位' },
            relativeTolerance: { type: 'number', description: 'numeric：相对误差，默认 0.02' },
            options: { type: 'array', items: { type: 'string' }, description: 'choice：选项' },
            correct: { type: 'array', items: { type: 'integer' }, description: 'choice：正确选项的下标（从 0 开始）' },
            expression: { type: 'string', description: 'expression：参考表达式' },
            rubric: { type: 'string', description: 'open：评分标准和参考答案' },
            answerSource: { type: 'string', required: true, enum: ['book', 'authority', 'calculated', 'unverified'] },
            tier: { type: 'integer', required: true, enum: [1, 2, 3, 4] },
            chunkId: { type: 'string', description: '题目出处的资料片段 ID' },
            nodes: { type: 'array', required: true, items: { type: 'string' }, description: '考查的知识节点（标题或 ID）' },
            pool: { type: 'string', required: true, enum: ['practice', 'test-reserved'], description: '练习题池或测试预留题池' },
          },
        },
      },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const drafts: NewProblem[] = args.problems.map((draft, index) => {
        const nodeIds = draft.nodes.map(ref => {
          const node = ctx.learnKnowledge.resolve(courseId, ref)
          if (!node) throw new Error(`第 ${index + 1} 题：知识节点 "${ref}" 不在本课知识图里，先用 add_knowledge_nodes 添加`)
          return node.id
        })
        const answer: Answer = draft.answerKind === 'numeric'
          ? { kind: 'numeric', value: draft.value ?? Number.NaN, unit: draft.unit ?? '', tolerance: { relative: draft.relativeTolerance ?? 0.02 } }
          : draft.answerKind === 'choice'
            ? { kind: 'choice', options: draft.options ?? [], correct: draft.correct ?? [] }
            : draft.answerKind === 'expression'
              ? { kind: 'expression', value: draft.expression ?? '' }
              : { kind: 'open', rubric: draft.rubric ?? '' }
        if (answer.kind === 'numeric' && !Number.isFinite(answer.value)) throw new Error(`第 ${index + 1} 题：数值题缺少 value`)
        const chunk = draft.chunkId ? ctx.learnLibrary.chunk(draft.chunkId) : undefined
        if (draft.chunkId && !chunk) throw new Error(`第 ${index + 1} 题：资料片段 ${draft.chunkId} 不存在`)
        return {
          stem: draft.stem,
          answer,
          answerSource: draft.answerSource,
          tier: draft.tier as 1 | 2 | 3 | 4,
          origin: chunk ? { kind: 'chunk', chunkId: chunk.id, locator: chunk.locator, label: chunk.citation } : { kind: 'agent' },
          nodeIds,
          pool: draft.pool,
        } as NewProblem
      })
      const problems = ctx.learnAssess.addProblems(drafts)
      return `已加入 ${problems.length} 道题：\n${problems.map(problem => `${problem.id} ${problem.stem.slice(0, 40).replace(/\n/g, ' ')}…（答案：${answerText(problem.answer).slice(0, 40)}）`).join('\n')}`
    },
  })), 'assess tools: add_problems')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'start_test',
    title: '发布测试',
    description: '组一份测试并作为任务发布给学习者（学习者在左侧"测试"页作答，交卷后判分，结果会以进度通知告诉你）。摸底用 kind "diagnostic"，课后小测用 "quiz"（要写 lessonId）。可以直接给 problemIds，或给 nodes 让系统从题库挑没做过的题。',
    parameters: {
      kind: { type: 'string', required: true, enum: ['diagnostic', 'quiz', 'practice', 'stage', 'review'] },
      problemIds: { type: 'array', items: { type: 'string' } },
      nodes: { type: 'array', items: { type: 'string' }, description: '知识节点标题或 ID' },
      count: { type: 'integer', description: '题数，默认 3' },
      lessonId: { type: 'string', description: '小测所属课时 ID' },
      book: { type: 'string', enum: ['closed', 'open'], description: '默认闭卷' },
      instructions: { type: 'string', required: true, description: '给学习者的说明，例如"凭记忆作答，不算成绩"' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      // Problems written for an identity later merged into this node still count for it.
      const nodeIds = args.nodes?.flatMap(ref => {
        const id = ctx.learnKnowledge.resolve(courseId, ref)?.id ?? ref
        return [id, ...ctx.learnKnowledge.identity(id).merged]
      })
      const lesson = args.lessonId ? ctx.learnCurriculum.lesson(args.lessonId) : undefined
      if (args.lessonId && !lesson) throw new Error(`课时 ${args.lessonId} 不存在`)
      const stage = lesson ? ctx.learnCurriculum.stage(lesson.stageId) : ctx.learnCurriculum.currentStage(courseId)
      const test = ctx.learnAssess.startTest({
        courseId,
        kind: args.kind,
        ...(args.problemIds ? { problemIds: args.problemIds } : {}),
        ...(nodeIds ? { nodeIds } : {}),
        ...(args.count ? { count: args.count } : {}),
        ...(lesson ? { lessonId: lesson.id } : {}),
        ...(stage && args.kind !== 'diagnostic' ? { stageId: stage.id } : {}),
        conditions: { book: args.book ?? 'closed', calculator: true, formulaSheet: false },
      })
      const task = ctx.learnCurriculum.publishTask({
        courseId: courseId as Task['courseId'],
        ...(test.stageId ? { stageId: test.stageId } : {}),
        ...(test.lessonId ? { lessonId: test.lessonId } : {}),
        kind: TASK_KIND[test.kind],
        title: `${KIND_LABEL[test.kind]}${lesson ? ` · ${lesson.number} ${lesson.title}` : ''}（${test.problemIds.length} 题）`,
        instructions: args.instructions,
        createdBy: 'teacher',
        result: { kind: 'test', id: test.id },
      })
      return `测试 ${test.id} 已发布为任务 ${task.id}，共 ${test.problemIds.length} 题。学习者交卷后，用 get_test_result 查看结果。`
    },
  })), 'assess tools: start_test')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'get_test_result',
    title: '查看测试结果',
    description: '查看一份测试的题目、学习者的作答和判分结果。',
    parameters: { testId: { type: 'string', required: true } },
    async execute(args) {
      const view = ctx.learnAssess.view(args.testId)
      if (!view) throw new Error(`测试 ${args.testId} 不存在`)
      if (view.test.status === 'open') return `测试 ${view.test.id} 还没交卷。`
      return view.problems.map((problem, index) => {
        const attempt = view.attempts.find(item => item.problemId === problem.id)
        return `第 ${index + 1} 题（${problem.id}）：${problem.stem.slice(0, 80)}\n参考答案：${problem.answer ? answerText(problem.answer) : '—'}\n作答：${attempt?.text || '（空）'}\n判分：${attempt?.grading?.verdict ?? '无'}，${attempt?.grading?.rationale ?? ''}`
      }).join('\n\n')
    },
  })), 'assess tools: get_test_result')
}
