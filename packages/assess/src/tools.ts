// assess unit, agent tools: import textbook exercises by number, add other problems, the restricted
// calculator, start a test (published as a task), read a test's result. Also the bank line of the brief
// (here because it needs the course's knowledge nodes, and knowledge itself depends on assess).
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { Answer, NewProblem, Problem, Task, Test } from '@learning-agent/contracts'
import { linkOf, textTool } from '@learning-agent/kit'
import { inUnit } from './calculator.ts'
import { answerFromPrinted } from './exercises.ts'
import { answerText } from './grading.ts'
import { prettyUnit } from './units.ts'

export const name = 'learning-assess-tools'
export const inject = ['tools', 'learnAssess', 'learnKnowledge', 'learnLibrary', 'learnCurriculum', 'learnCore', 'learnGoal']

/** Tests before a goal exists (rare: the planner asks for the goal first). */
const NO_GOAL_CONDITIONS = { book: 'closed', calculator: true, formulaSheet: false } as const

const TASK_KIND: Record<Test['kind'], Task['kind']> = { diagnostic: 'quiz', quiz: 'quiz', practice: 'practice', stage: 'stage-test', review: 'review', mock: 'stage-test' }
const KIND_LABEL: Record<Test['kind'], string> = { diagnostic: '摸底', quiz: '小测', practice: '练习', stage: '阶段测试', review: '复查', mock: '模拟考' }
const POOL_LABEL: Record<Problem['pool'], string> = { practice: '练习题池', 'test-reserved': '测试预留题池' }

export function apply(ctx: Context): void {
  const nodeIdsOf = (courseId: string, refs: readonly string[], where: string) => refs.map(ref => {
    const node = ctx.learnKnowledge.resolve(courseId, ref)
    if (!node) throw new Error(`${where}：知识节点 "${ref}" 不在本课知识图里，先用 add_knowledge_nodes 添加`)
    return node.id
  })

  /** A problem by ID or by its exercise number in one of the course's sources. */
  const problemOf = (courseId: string, ref: string): Problem => {
    const byId = ref.startsWith('pb_') ? ctx.learnAssess.problem(ref) : undefined
    if (byId) return byId
    const sources = new Set(ctx.learnLibrary.courseSources(courseId).map(source => source.sourceId as string))
    const found = ctx.learnAssess.problems({ includeReview: true }).find(problem => problem.ref === ref.trim() && problem.sourceKey && sources.has(problem.sourceKey.split('#')[0]!))
    if (!found) throw new Error(`题库里没有 ${ref}：教材习题先用 import_exercises 导入`)
    return found
  }

  const label = (problem: Problem) => (problem.ref ? `习题 ${problem.ref}` : problem.id)

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'import_exercises',
    title: '导入习题',
    description: '把本课资料里的教材习题按题号加入题库：题干、附图和书后答案由程序从原书取，你不用抄写。返回每题解析出的答案，请核对；同一题号只入库一次。',
    parameters: {
      exercises: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref: { type: 'string', required: true, description: '题号，如 "1-25"' },
            nodes: { type: 'array', required: true, items: { type: 'string' }, description: '考查的知识节点（标题或 ID）' },
            pool: { type: 'string', enum: ['practice', 'test-reserved'], description: '马上要用在摸底、小测或练习里的题填 practice。不填由程序按节点分：约三分之一进测试预留题池（留给阶段测试）；作业做过的、短题和没有书后答案的只进练习题池' },
            size: { type: 'string', enum: ['check', 'standard', 'task'], description: 'check 一步就能做的短题，standard 普通习题，task 综合整个阶段的完整任务题。不填时习题为 standard，复习思考题为 check' },
            answer: { type: 'string', description: '书后答案解析错了、或书后没有答案时填，写法同书后答案，如 "336 m" 或 "（1）484.8 Pa；（2）0.0493 m"。书后没有答案时，这里的答案记为未核对，只进练习题池' },
          },
        },
      },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const items = args.exercises.map(item => ({
        ref: item.ref,
        nodeIds: nodeIdsOf(courseId, item.nodes, item.ref),
        ...(item.pool ? { pool: item.pool } : {}),
        ...(item.size ? { size: item.size } : {}),
        ...(item.answer?.trim() ? { answer: answerFromPrinted(item.answer) } : {}),
      }))
      return ctx.learnAssess.importExercises(courseId, items).map(result => {
        if (result.status === 'failed' || !result.problem) return `${result.ref}：没有导入。${result.reason ?? ''}`
        const problem = result.problem
        const status = result.status === 'added' ? `已加入${POOL_LABEL[problem.pool]}` : result.status === 'updated' ? '已改正答案' : `已在${POOL_LABEL[problem.pool]}`
        const figures = problem.figures.length ? `，附图 ${problem.figures.length} 张` : ''
        return `${result.ref}：${status}（${problem.id}${figures}）。答案：${answerText(problem.answer)}`
      }).join('\n')
    },
  })), 'assess tools: import_exercises')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'add_problems',
    title: '加入题库',
    description: '把教材习题以外的题加入题库：权威来源的题（tier 2）、改编题（tier 3）和你自己出的题（tier 4，只能进练习题池）。教材习题用 import_exercises。改编题和自己出的数值题，答案由 calculation 算出，不要自己心算；没有计算过程的答案记为未核对，不能进测试预留题池。',
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
            value: { type: 'number', description: 'numeric：参考数值；有 calculation 时可省略，填了会和算出的比较' },
            unit: { type: 'string', description: 'numeric：单位' },
            relativeTolerance: { type: 'number', description: 'numeric：相对误差，默认 0.02' },
            options: { type: 'array', items: { type: 'string' }, description: 'choice：选项' },
            correct: { type: 'array', items: { type: 'integer' }, description: 'choice：正确选项的下标（从 0 开始）' },
            expression: { type: 'string', description: 'expression：参考表达式' },
            rubric: { type: 'string', description: 'open：评分要点，逐条写出（每条一行），判分时逐条判断是否做到' },
            calculation: { type: 'string', description: 'numeric：计算过程，写法同 calculate 的 script；最后一行的变量是答案' },
            answerSource: { type: 'string', enum: ['authority', 'unverified'], description: 'authority：权威来源给出的答案；不填时有 calculation 记为已验算，否则为未核对' },
            tier: { type: 'integer', required: true, enum: [2, 3, 4] },
            adaptedFrom: { type: 'string', description: 'tier 3 必填：原题的题号或 ID' },
            chunkId: { type: 'string', description: '题目出处的资料片段 ID（tier 2）' },
            size: { type: 'string', enum: ['check', 'standard', 'task'], description: '默认 standard' },
            nodes: { type: 'array', required: true, items: { type: 'string' }, description: '考查的知识节点（标题或 ID）' },
            pool: { type: 'string', required: true, enum: ['practice', 'test-reserved'], description: '练习题池或测试预留题池' },
          },
        },
      },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const drafts: NewProblem[] = args.problems.map((draft, index) => {
        const where = `第 ${index + 1} 题`
        const nodeIds = nodeIdsOf(courseId, draft.nodes, where)
        let answer: Answer = draft.answerKind === 'numeric'
          ? { kind: 'numeric', value: draft.value ?? Number.NaN, unit: draft.unit ?? '', tolerance: { relative: draft.relativeTolerance ?? 0.02 } }
          : draft.answerKind === 'choice'
            ? { kind: 'choice', options: draft.options ?? [], correct: draft.correct ?? [] }
            : draft.answerKind === 'expression'
              ? { kind: 'expression', value: draft.expression ?? '' }
              : { kind: 'open', rubric: draft.rubric ?? '' }
        let calculation: NewProblem['calculation']
        if (draft.calculation?.trim()) {
          if (answer.kind !== 'numeric') throw new Error(`${where}：calculation 只用于数值题`)
          const last = [...draft.calculation.split(/\r?\n/)].reverse().find(line => /^\s*[A-Za-z_]\w*\s*=/.test(line))
          const result = last ? /^\s*([A-Za-z_]\w*)/.exec(last)![1]! : ''
          if (!result) throw new Error(`${where}：计算过程的最后要把答案赋给一个变量，例如 answer = …`)
          const run = ctx.learnAssess.calculate(draft.calculation, [result])
          const value = inUnit(run.values[result]!, answer.unit)
          if (value === undefined) throw new Error(`${where}：算出 ${run.values[result]!.text}，和单位 "${answer.unit}" 对不上`)
          if (Number.isFinite(answer.value) && Math.abs(value - answer.value) > Math.abs(value) * (answer.tolerance.relative ?? 0.02)) {
            throw new Error(`${where}：你写的答案 ${answer.value}，计算过程算出 ${Number(value.toPrecision(6))} ${prettyUnit(answer.unit)}，差 ${Number(((answer.value - value) / (value || 1) * 100).toPrecision(3))}%。先核对再加`)
          }
          answer = { ...answer, value: Number(value.toPrecision(6)) }
          calculation = { script: draft.calculation, results: [result], lines: [...run.lines], at: new Date().toISOString() }
        }
        if (answer.kind === 'numeric' && !Number.isFinite(answer.value)) throw new Error(`${where}：数值题缺少 value 或 calculation`)
        if (draft.tier === 3 && answer.kind === 'numeric' && !calculation) throw new Error(`${where}：改编的数值题要写 calculation，由计算工具算出答案`)
        const chunk = draft.chunkId ? ctx.learnLibrary.chunk(draft.chunkId) : undefined
        if (draft.chunkId && !chunk) throw new Error(`${where}：资料片段 ${draft.chunkId} 不存在`)
        const original = draft.adaptedFrom ? problemOf(courseId, draft.adaptedFrom) : undefined
        const origin = chunk ? { kind: 'chunk' as const, chunkId: chunk.id, locator: chunk.locator, label: chunk.citation }
          : original?.origin.kind === 'chunk' ? { ...original.origin, label: `改编自${original.ref ? `习题 ${original.ref}，` : ''}${original.origin.label}` }
            : { kind: 'agent' as const }
        return {
          stem: draft.stem,
          answer,
          answerSource: draft.answerSource ?? (calculation ? 'calculated' : 'unverified'),
          tier: draft.tier as 2 | 3 | 4,
          origin,
          ...(original ? { adaptedFrom: original.id } : {}),
          ...(calculation ? { calculation } : {}),
          ...(draft.size ? { size: draft.size } : {}),
          nodeIds,
          pool: draft.pool,
        } as NewProblem
      })
      const problems = ctx.learnAssess.addProblems(drafts)
      return `已加入 ${problems.length} 道题：\n${problems.map(problem => `${problem.id}（${POOL_LABEL[problem.pool]}）${problem.stem.slice(0, 30).replace(/\n/g, ' ')}…答案：${answerText(problem.answer).slice(0, 40)}`).join('\n')}`
    },
  })), 'assess tools: add_problems')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'calculate',
    title: '计算',
    description: '受限计算器：每行一个赋值，数值可以带单位，例如 p = 101325 Pa + 0.2 at、rho = p*M/(R*T)、x to kg/m^3；可用 sqrt、exp、log、log10、pow、abs、min、max、round 和三角函数。只能做数学计算。用来验算书后答案和给改编题算答案。',
    parameters: {
      script: { type: 'string', required: true, description: '计算过程，一行一个赋值' },
      results: { type: 'array', items: { type: 'string' }, description: '要输出的变量。填 check 时按小问顺序一一对应，不是数值的那一问写 "-"' },
      check: { type: 'string', description: '要验算的题（题号或 ID）：逐问和答案比较，一致的记下验算；不一致的标"答案存疑"，暂停使用' },
      apply: { type: 'boolean', description: '和 check 一起用：确认书后答案有误时为 true，改用算出的答案（记为已验算）' },
    },
    async execute(args, exec) {
      if (!args.check) {
        const run = ctx.learnAssess.calculate(args.script, args.results ?? [])
        return run.lines.join('\n')
      }
      const { courseId } = linkOf(ctx, exec)
      const problem = problemOf(courseId, args.check)
      const check = ctx.learnAssess.checkAnswer(problem.id, args.script, args.results ?? [], args.apply ?? false)
      const outcome = args.apply ? '已改用算出的答案。' : check.agrees ? '验算一致，已记下。' : '对不上，这道题标为"答案存疑"，组卷时不再选它；核对后可以 apply 改用算出的答案，或改正计算过程后再验算。'
      return `${label(problem)}：${outcome}\n${check.lines.join('\n')}`
    },
  })), 'assess tools: calculate')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'mark_homework',
    title: '记下作业做过的题',
    description: '学习者说作业或课上做过的教材习题，按题号记下：这些题以后不算新题，不分进测试预留题池。学习者也可以自己在"测试"页标记。',
    parameters: {
      refs: { type: 'string', required: true, description: '题号，如 "1-1~1-10, 2-3"' },
      undo: { type: 'boolean', description: '学习者说记错了时为 true，取消标记' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const update = ctx.learnAssess.markHomework(courseId, args.refs, !args.undo, 'teacher')
      if (args.undo) return `已取消：${update.refs.join('、')}。`
      return `已记下作业做过：${update.refs.join('、')}。${update.reserved.length ? `其中 ${update.reserved.join('、')} 在测试预留题池里，已不算新题，阶段测试要另备新题。` : ''}`
    },
  })), 'assess tools: mark_homework')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'start_test',
    title: '发布测试',
    description: '组一份测试并作为任务发布给学习者（学习者在左侧"测试"页作答，交卷后判分，结果会以进度通知告诉你）。摸底用 kind "diagnostic"，课后小测用 "quiz"（要写 lessonId）。可以直接给题目，或给 nodes 让系统从题库挑没做过的题。',
    parameters: {
      kind: { type: 'string', required: true, enum: ['diagnostic', 'quiz', 'practice', 'stage', 'review'] },
      problemIds: { type: 'array', items: { type: 'string' }, description: '题目 ID 或教材题号' },
      nodes: { type: 'array', items: { type: 'string' }, description: '知识节点标题或 ID' },
      count: { type: 'integer', description: '题数，默认 3' },
      lessonId: { type: 'string', description: '小测所属课时 ID' },
      book: { type: 'string', enum: ['closed', 'open'], description: '不填按目标说明：阶段测试按考试档案的条件，其他按默认测试条件' },
      instructions: { type: 'string', required: true, description: '给学习者的说明，例如"凭记忆作答，不算成绩"' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      // Problems written for an identity later merged into this node still count for it.
      const nodeIds = args.nodes?.flatMap(ref => {
        const id = ctx.learnKnowledge.resolve(courseId, ref)?.id ?? ref
        return [id, ...ctx.learnKnowledge.identity(id).merged]
      })
      const problemIds = args.problemIds?.map(ref => problemOf(courseId, ref).id)
      const lesson = args.lessonId ? ctx.learnCurriculum.lesson(args.lessonId) : undefined
      if (args.lessonId && !lesson) throw new Error(`课时 ${args.lessonId} 不存在`)
      const stage = lesson ? ctx.learnCurriculum.stage(lesson.stageId) : ctx.learnCurriculum.currentStage(courseId)
      const test = ctx.learnAssess.startTest({
        courseId,
        kind: args.kind,
        ...(problemIds ? { problemIds } : {}),
        ...(nodeIds ? { nodeIds } : {}),
        ...(args.count ? { count: args.count } : {}),
        ...(lesson ? { lessonId: lesson.id } : {}),
        ...(stage && args.kind !== 'diagnostic' ? { stageId: stage.id } : {}),
        conditions: { ...(await ctx.learnGoal.conditions(courseId, args.kind)) ?? NO_GOAL_CONDITIONS, ...(args.book ? { book: args.book } : {}) },
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
        const finals = attempt?.finals.filter(Boolean).join('；')
        const working = attempt?.text ? `\n过程：${attempt.text.slice(0, 600)}` : ''
        const grading = attempt?.grading
        const verdict = grading?.parts?.length ? grading.parts.map(part => `${part.label}${part.verdict}`).join('、') : grading?.verdict ?? '无'
        return `第 ${index + 1} 题（${problem.ref ? `习题 ${problem.ref}，` : ''}${problem.id}）：${problem.stem.slice(0, 80)}\n参考答案：${problem.answer ? answerText(problem.answer) : '—'}\n作答：${finals || (attempt?.text ? '' : '（空）')}${working}\n判分：${verdict}，${grading?.rationale ?? ''}`
      }).join('\n\n')
    },
  })), 'assess tools: get_test_result')

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const nodeIds = ctx.learnKnowledge.graph(request.courseId).nodes.map(node => node.id)
    const bank = ctx.learnAssess.bank(request.courseId, nodeIds)
    if (bank.practice + bank.reserved + bank.doubtful.length === 0 && bank.homework.length === 0) return sections
    const lines = [`练习题 ${bank.practice} 道，测试预留题 ${bank.reserved} 道（覆盖 ${bank.nodes.length} 个知识节点）。`]
    if (bank.doubtful.length) lines.push(`答案存疑、暂停使用：${bank.doubtful.map(item => item.ref ?? item.problemId).join('、')}（用 calculate 的 check 核对）。`)
    if (bank.homework.length) lines.push(`学习者作业做过（不算新题）：${bank.homework.map(mark => mark.ref).join('、')}。`)
    return [...sections, { unit: 'assess', title: '题库', text: lines.join('\n') }]
  })
}
