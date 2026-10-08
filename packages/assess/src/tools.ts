// assess unit, agent tools: import textbook exercises by number, add other problems, the restricted
// calculator, start a test (published as a task), read a test's result, check flagged problems and
// regrade. Also the bank lines of the brief (here because they need the course's knowledge nodes and
// stages, and knowledge itself depends on assess). Diagnostics and stage tests are given the nodes as the
// graph is now (titles, prerequisites, merged identities), so assess can probe and report without knowledge.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { REPORT_REASON_LABEL, TEST_KIND_LABEL, type Answer, type NewProblem, type Problem, type ProbeNode, type Task, type Test } from '@learning-agent/contracts'
import { linkOf, textTool } from '@learning-agent/kit'
import { diagnosisText } from './adaptive.ts'
import { inUnit } from './calculator.ts'
import { answerFromPrinted } from './exercises.ts'
import { answerText } from './grading.ts'
import { stageReportText } from './stage.ts'
import { ruleGradable } from './store.ts'
import { prettyUnit } from './units.ts'

export const name = 'learning-assess-tools'
export const inject = ['tools', 'learnAssess', 'learnKnowledge', 'learnLibrary', 'learnCurriculum', 'learnCore', 'learnGoal']

/** Tests before a goal exists (rare: the planner asks for the goal first). */
const NO_GOAL_CONDITIONS = { book: 'closed', calculator: true, formulaSheet: false } as const

const TASK_KIND: Record<Test['kind'], Task['kind']> = { diagnostic: 'quiz', pretest: 'quiz', quiz: 'quiz', practice: 'practice', stage: 'stage-test', review: 'review', mock: 'stage-test' }
const KIND_LABEL = TEST_KIND_LABEL
const POOL_LABEL: Record<Problem['pool'], string> = { practice: '练习题池', 'test-reserved': '测试预留题池' }
const VERDICT_LABEL = { correct: '对', partial: '部分对', incorrect: '错', 'pending-review': '待复核' } as const

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

  /** The nodes as the course graph has them now: title, hard prerequisites among them, merged identities. */
  const probeNodes = (courseId: string, nodeIds: readonly string[]): ProbeNode[] => {
    const graph = ctx.learnKnowledge.graph(courseId)
    const ids = [...new Set(nodeIds)]
    const wanted = new Set(ids)
    return ids.map(id => ({
      id: id as ProbeNode['id'],
      title: graph.nodes.find(node => node.id === id)?.title ?? ctx.learnKnowledge.node(id)?.title ?? id,
      requires: graph.edges.filter(edge => edge.type === 'requires' && edge.from === id && wanted.has(edge.to) && edge.status !== 'disputed').map(edge => edge.to),
      also: [...ctx.learnKnowledge.identity(id).merged] as ProbeNode['also'],
    }))
  }

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
            parts: {
              type: 'array',
              description: '分几问的数值题（如完整任务题），每问一项，答案都由 calculation 算出',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string', required: true, description: '如 "（1）"' },
                  result: { type: 'string', required: true, description: 'calculation 里这一问答案的变量名' },
                  unit: { type: 'string', description: '这一问答案的单位' },
                },
              },
            },
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
        if (draft.parts?.length) {
          // Several numeric parts: one calculation, a variable per part.
          if (draft.answerKind !== 'numeric' || !draft.calculation?.trim() || draft.parts.length < 2) throw new Error(`${where}：parts 用于分两问以上的数值题，并要写 calculation`)
          const run = ctx.learnAssess.calculate(draft.calculation, draft.parts.map(part => part.result))
          answer = {
            kind: 'parts',
            parts: draft.parts.map(part => {
              const value = inUnit(run.values[part.result]!, part.unit ?? '')
              if (value === undefined) throw new Error(`${where} ${part.label}：算出 ${run.values[part.result]!.text}，和单位 "${part.unit ?? ''}" 对不上`)
              return { label: part.label, answer: { kind: 'numeric' as const, value: Number(value.toPrecision(6)), unit: part.unit ?? '', tolerance: { relative: draft.relativeTolerance ?? 0.02 } } }
            }),
          }
          calculation = { script: draft.calculation, results: draft.parts.map(part => part.result), lines: [...run.lines], at: new Date().toISOString() }
        } else if (draft.calculation?.trim()) {
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
    description: '组一份测试并作为任务发布给学习者（在左侧"测试"页作答，交卷后判分，结果以进度通知告诉你）。摸底 "diagnostic" 和阶段前测 "pretest"：给 nodes（前测默认本阶段的核心知识点），程序沿先修关系逐题出，只用练习题池里能当场判分的题。阶段测试 "stage"：程序按本阶段的核心知识点，从没见过的测试预留题里组卷。课后小测 "quiz" 要写 lessonId，可以直接给题目，或给 nodes 让系统挑没做过的题。',
    parameters: {
      kind: { type: 'string', required: true, enum: ['diagnostic', 'pretest', 'quiz', 'practice', 'stage', 'review'] },
      problemIds: { type: 'array', items: { type: 'string' }, description: '题目 ID 或教材题号；摸底和阶段测试一般不填，由程序选' },
      nodes: { type: 'array', items: { type: 'string' }, description: '知识节点标题或 ID：摸底要探的、小测要考的；阶段测试不填就用阶段设计里的核心知识点' },
      count: { type: 'integer', description: '最多几题：摸底默认 10，前测 5，阶段测试 10，其余默认 3' },
      lessonId: { type: 'string', description: '小测所属课时 ID' },
      book: { type: 'string', enum: ['closed', 'open'], description: '不填按目标说明：阶段测试按考试档案的条件，其他按默认测试条件' },
      instructions: { type: 'string', required: true, description: '给学习者的说明，例如"凭记忆作答，不算成绩"' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      // Problems written for an identity later merged into this node still count for it.
      const named = args.nodes?.map(ref => {
        const node = ctx.learnKnowledge.resolve(courseId, ref)
        if (!node) throw new Error(`知识节点 "${ref}" 不在本课知识图里`)
        return node.id as string
      })
      const nodeIds = named?.flatMap(id => [id, ...ctx.learnKnowledge.identity(id).merged])
      const problems = args.problemIds?.map(ref => problemOf(courseId, ref))
      const lesson = args.lessonId ? ctx.learnCurriculum.lesson(args.lessonId) : undefined
      if (args.lessonId && !lesson) throw new Error(`课时 ${args.lessonId} 不存在`)
      const stage = lesson ? ctx.learnCurriculum.stage(lesson.stageId) : ctx.learnCurriculum.currentStage(courseId)
      const probing = args.kind === 'diagnostic' || args.kind === 'pretest'
      let scope: ProbeNode[] | undefined
      let blueprint: { core: ProbeNode[]; earlier: ProbeNode[]; goals: { key: string; text: string }[] } | undefined
      if (probing) {
        const inGraph = new Set(ctx.learnKnowledge.graph(courseId).nodes.map(node => node.id as string))
        const ids = named ?? (problems ? problems.flatMap(problem => problem.nodeIds.map(id => ctx.learnKnowledge.identity(id).current)).filter(id => inGraph.has(id))
          : args.kind === 'pretest' ? [...(stage?.nodeIds ?? [])] : [...inGraph])
        if (ids.length === 0) throw new Error(args.kind === 'pretest' ? '阶段设计里没有记下核心知识点：在 nodes 里写要探的知识点' : '在 nodes 里写要探的知识点')
        scope = probeNodes(courseId, ids)
      }
      if (args.kind === 'stage' && !problems) {
        if (!stage) throw new Error('现在没有进行中的阶段')
        const core = named ?? [...stage.nodeIds]
        if (core.length === 0) throw new Error('阶段设计里没有记下核心知识点：在 nodes 里写本阶段的核心知识点，或重新 save_stage_design 时写上 nodes')
        const earlier = ctx.learnCurriculum.stages(courseId).filter(other => other.index < stage.index).flatMap(other => other.nodeIds).filter(id => !core.includes(id))
        const goal = await ctx.learnGoal.get(courseId).catch(() => undefined)
        blueprint = {
          core: probeNodes(courseId, core),
          earlier: probeNodes(courseId, earlier),
          goals: (goal?.goal.canDo ?? []).filter(item => stage.supports.includes(item.key)).map(item => ({ key: item.key, text: item.text })),
        }
      }
      const test = ctx.learnAssess.startTest({
        courseId,
        kind: args.kind,
        ...(problems ? { problemIds: problems.map(problem => problem.id) } : {}),
        ...(nodeIds && !probing ? { nodeIds } : {}),
        ...(args.count ? { count: args.count } : {}),
        ...(lesson ? { lessonId: lesson.id } : {}),
        ...(stage && args.kind !== 'diagnostic' ? { stageId: stage.id } : {}),
        ...(scope ? { scope } : {}),
        ...(blueprint ? { blueprint } : {}),
        conditions: { ...(await ctx.learnGoal.conditions(courseId, args.kind)) ?? NO_GOAL_CONDITIONS, ...(args.book ? { book: args.book } : {}) },
      })
      const task = ctx.learnCurriculum.publishTask({
        courseId: courseId as Task['courseId'],
        ...(test.stageId ? { stageId: test.stageId } : {}),
        ...(test.lessonId ? { lessonId: test.lessonId } : {}),
        kind: TASK_KIND[test.kind],
        title: `${stage && test.kind === 'pretest' ? `阶段 ${stage.index} ` : ''}${KIND_LABEL[test.kind]}${lesson ? ` · ${lesson.number} ${lesson.title}` : ''}（${test.scope?.adaptive ? `最多 ${test.scope.max} 题` : `${test.problemIds.length} 题`}）`,
        instructions: args.instructions,
        createdBy: 'teacher',
        result: { kind: 'test', id: test.id },
      })
      const head = `测试 ${test.id} 已发布为任务 ${task.id}`
      if (test.scope?.adaptive) {
        const blind = test.scope.nodes.filter(node => !ctx.learnAssess.problems({ nodeIds: [node.id, ...node.also], pool: 'practice' }).some(problem => ruleGradable(problem) && problem.size !== 'task'))
        return `${head}：逐题出，最多 ${test.scope.max} 题，要探的知识点 ${test.scope.nodes.length} 个。${blind.length ? `这些知识点没有能当场判分的练习题，探不到：${blind.map(node => node.title).join('、')}。` : ''}学习者做完后，用 get_test_result 看结果。`
      }
      if (test.plan) {
        const uncovered = test.plan.core.filter(node => test.plan!.uncovered.includes(node.id))
        return `${head}，共 ${test.problemIds.length} 题：${test.plan.task ? '完整任务题 1 道，' : '没有完整任务题，'}核心知识点 ${test.plan.core.length - uncovered.length}/${test.plan.core.length} 个有新题，前面阶段的题 ${test.problemIds.filter(id => !test.plan!.core.some(node => ctx.learnAssess.problem(id)?.nodeIds.some(nodeId => nodeId === node.id || node.also.includes(nodeId)))).length} 道。${uncovered.length ? `这些核心知识点没有新题，结果会是"证据不够"：${uncovered.map(node => node.title).join('、')}。` : ''}学习者交卷后，用 get_test_result 看按知识点的结果。`
      }
      return `${head}，共 ${test.problemIds.length} 题。学习者交卷后，用 get_test_result 查看结果。`
    },
  })), 'assess tools: start_test')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'get_test_result',
    title: '查看测试结果',
    description: '查看一份测试的结果：摸底按知识点分已会、边界、还不会、推测已会、未探测；阶段测试按知识点给通过、没过、证据不够；还有每道题的作答和判分、学习者报告的题和申诉。',
    parameters: { testId: { type: 'string', required: true } },
    async execute(args) {
      const view = ctx.learnAssess.view(args.testId)
      if (!view) throw new Error(`测试 ${args.testId} 不存在`)
      if (view.test.status === 'open') return `测试 ${view.test.id} 还没交卷。`
      const head: string[] = []
      if (view.diagnosis) head.push(`摸底结果：${diagnosisText(view.diagnosis)}。"推测已会"没有直接测，只用来排路线。`)
      if (view.stageReport) {
        const report = view.stageReport
        head.push(`按知识点：${stageReportText(report)}。`)
        if (report.task) head.push(`完整任务题（第 ${report.task.number} 题）：${VERDICT_LABEL[report.task.verdict ?? 'pending-review']}${report.goals.length ? `；对应目标：${report.goals.map(goal => goal.text).join('；')}` : ''}。`)
        if (report.earlier.length) head.push(`前面阶段的题：${report.earlier.map(item => `${item.title}（第 ${item.number} 题）${VERDICT_LABEL[item.verdict ?? 'pending-review']}`).join('、')}。`)
      }
      for (const report of view.reports) head.push(`报告的题：${report.ref ? `习题 ${report.ref}` : report.problemId}"${REPORT_REASON_LABEL[report.reason]}"${report.note ? `（${report.note}）` : ''}，${report.replacedBy ? '已换题' : '已跳过'}；${report.outcome ? `已核对：${report.outcome.note}` : '待你用 review_problem 核对'}。`)
      const problems = view.problems.map((problem, index) => {
        const attempt = view.attempts.find(item => item.problemId === problem.id)
        const finals = attempt?.finals.filter(Boolean).join('；')
        const working = attempt?.text ? `\n过程：${attempt.text.slice(0, 600)}` : ''
        const grading = attempt?.grading
        const verdict = grading?.parts?.length ? grading.parts.map(part => `${part.label}${part.verdict}`).join('、') : grading?.verdict ?? '无'
        const appeal = view.appeals.filter(item => item.attemptId === attempt?.id).at(-1)
        const appealed = appeal ? `\n申诉："${appeal.text}"${appeal.outcome ? `；已复核：${appeal.outcome.changed ? '改判' : '维持'}${VERDICT_LABEL[appeal.outcome.verdict]}` : '；待你用 regrade 复核'}` : ''
        return `第 ${index + 1} 题（${problem.ref ? `习题 ${problem.ref}，` : ''}${problem.id}）：${problem.stem.slice(0, 80)}\n参考答案：${problem.answer ? answerText(problem.answer) : '—'}\n作答：${attempt?.gaveUp ? '（选了"不会"）' : finals || (attempt?.text ? '' : '（空）')}${working}\n判分：${verdict}，${grading?.rationale ?? ''}${appealed}`
      })
      return [...(head.length ? [head.join('\n')] : []), ...problems].join('\n\n')
    },
  })), 'assess tools: get_test_result')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'review_problem',
    title: '核对题目',
    description: '处理学习者报告有问题的题、或答案存疑的题。先核对原书，数值答案用 calculate 的 check 验算（确认书后答案错了就加 apply 改用算出的答案），再选：keep 题目没问题，恢复使用；fixed 已改正（题干或文字答案的改正写在 stem、answer 里）；retired 停用。note 写给学习者看，说明核对的结果。',
    parameters: {
      problem: { type: 'string', required: true, description: '题号或题目 ID' },
      action: { type: 'string', required: true, enum: ['keep', 'fixed', 'retired'] },
      note: { type: 'string', required: true, description: '核对结果，一两句，学习者会在测试页看到' },
      stem: { type: 'string', description: 'fixed：改正后的题干' },
      answer: { type: 'string', description: 'fixed：改正后的答案，写法同书后答案；这样改的答案记为未核对，题目改进练习题池' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const problem = problemOf(courseId, args.problem)
      const changes = { ...(args.stem?.trim() ? { stem: args.stem } : {}), ...(args.answer?.trim() ? { answer: answerFromPrinted(args.answer) } : {}) }
      const saved = ctx.learnAssess.reviewProblem(problem.id, args.action, args.note, args.action === 'fixed' ? changes : {})
      const state = saved.status === 'retired' ? '已停用' : `已恢复使用（${POOL_LABEL[saved.pool]}）`
      return `${label(saved)}：${state}。${changes.answer && args.action === 'fixed' ? '答案改成你写的，记为未核对。' : ''}把核对结果告诉学习者。`
    },
  })), 'assess tools: review_problem')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'regrade',
    title: '复核判分',
    description: '复核一道题的判分：学习者申诉、或判分"待复核"时用。verdict 是复核后的结论，和原判相同就是维持原判。改判追加进证据日志，原来的判分记录保留，掌握状态按新的判分重算。reason 写给学习者看。',
    parameters: {
      testId: { type: 'string', required: true },
      number: { type: 'integer', required: true, description: '测试里的第几题（从 1 开始）' },
      verdict: { type: 'string', required: true, enum: ['correct', 'partial', 'incorrect'] },
      reason: { type: 'string', required: true, description: '复核的理由，一两句' },
    },
    async execute(args) {
      const view = ctx.learnAssess.view(args.testId)
      if (!view) throw new Error(`测试 ${args.testId} 不存在`)
      const problem = view.problems[args.number - 1]
      const attempt = problem && view.attempts.find(item => item.problemId === problem.id)
      if (!attempt) throw new Error(`测试 ${args.testId} 没有第 ${args.number} 题的作答`)
      const { changed } = ctx.learnAssess.regrade(attempt.id, args.verdict, args.reason)
      return `第 ${args.number} 题：${changed ? `改判为${VERDICT_LABEL[args.verdict]}` : `维持${VERDICT_LABEL[args.verdict]}`}。把理由告诉学习者。`
    },
  })), 'assess tools: regrade')

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const nodeIds = ctx.learnKnowledge.graph(request.courseId).nodes.map(node => node.id)
    const bank = ctx.learnAssess.bank(request.courseId, nodeIds)
    const lines: string[] = []
    if (bank.practice + bank.reserved + bank.doubtful.length > 0 || bank.homework.length > 0) {
      lines.push(`练习题 ${bank.practice} 道，测试预留题 ${bank.reserved} 道（覆盖 ${bank.nodes.length} 个知识节点）。`)
      if (bank.doubtful.length) lines.push(`暂停使用、待核对：${bank.doubtful.map(item => item.ref ?? item.problemId).join('、')}（用 calculate 的 check 验算，或 review_problem 处理）。`)
      if (bank.homework.length) lines.push(`学习者作业做过（不算新题）：${bank.homework.map(mark => mark.ref).join('、')}。`)
    }
    // Before the stage test is assembled: does each core node have a new reserved problem, is there a complete task?
    const stage = ctx.learnCurriculum.currentStage(request.courseId)
    if (stage?.nodeIds.length && !ctx.learnAssess.tests(request.courseId, { kind: 'stage' }).some(test => test.stageId === stage.id)) {
      const core = probeNodes(request.courseId, stage.nodeIds)
      const coverage = ctx.learnAssess.coverage(request.courseId, core)
      const missing = core.filter(node => coverage.nodes.find(item => item.nodeId === node.id)?.fresh === 0).map(node => node.title)
      if (missing.length || !coverage.task) {
        const gaps = [missing.length ? `${missing.join('、')} 除完整任务题外还没有没见过的测试预留题` : '', coverage.task ? '' : '还没有完整任务题（import_exercises 或 add_problems 的 size 填 task）'].filter(Boolean)
        lines.push(`阶段 ${stage.index} 的阶段测试备题不够：${gaps.join('；')}。${stage.designConfirmedAt ? '' : '在学习者确认设计书前'}用 import_exercises（pool 填 test-reserved）或改编题补上。`)
      }
    }
    return lines.length ? [...sections, { unit: 'assess', title: '题库', text: lines.join('\n') }] : sections
  })
}
