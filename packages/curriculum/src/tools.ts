// curriculum unit, agent tools: roadmap, stage design, publishing tasks, stage reviews; and the brief's
// review facts, which read assess, learner and knowledge (the service itself may not inject them:
// knowledge injects curriculum).
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { STAGE_LAYOUT, parseFrontmatter, type NodeState, type Stage, type StageReviewFacts, type Task } from '@learning-agent/contracts'
import { linkOf, textTool } from '@learning-agent/kit'
import { remedialNodes, reviewFacts, reviewFactsText, type NodeSignals } from './review.ts'

export const name = 'learning-curriculum-tools'
export const inject = ['tools', 'learnCurriculum', 'learnCore', 'learnKnowledge', 'learnAssess', 'learnLearner']

/** This course's state of a node: help counts from anywhere, attempts from this course (docs/learner/design.md). */
function courseState(state: NodeState | undefined, courseId: string) {
  const mine = state?.courses.find(entry => entry.courseId === courseId)
  return mine ?? (state && state.courses.length === 0 ? state : undefined)
}

/** The teacher's part of a review (no result table, no decision), shortened for the brief. */
export function reviewProse(body: string, limit = 1500): string {
  const prose = body.replace(/^[\s\S]*?\n## 阶段测试的结果\n\n(?:\|.*\n)+/, '').replace(/\n## 你的决定[\s\S]*$/, '').trim()
  return prose.length > limit ? `${prose.slice(0, limit)}…` : prose
}

export function apply(ctx: Context): void {
  /** The review facts of a stage whose stage test is graded; undefined while there is none. */
  function factsOf(stage: Stage): StageReviewFacts | undefined {
    const test = ctx.learnAssess.tests(stage.courseId, { kind: 'stage' }).filter(item => item.stageId === stage.id && item.status === 'graded').at(-1)
    const view = test ? ctx.learnAssess.view(test.id) : undefined
    if (!view?.stageReport) return undefined
    const nodeIds = view.stageReport.nodes.map(node => node.nodeId)
    const states = new Map(ctx.learnLearner.states(nodeIds).flatMap(state => {
      const mine = courseState(state, stage.courseId)
      return mine ? [[state.nodeId as string, mine] as const] : []
    }))
    const signals = new Map<string, NodeSignals>(nodeIds.map(nodeId => {
      const entries = ctx.learnCore.log.query({ courseId: stage.courseId, nodeId, types: ['help.given', 'signal.question', 'signal.misconception'], ...(stage.designConfirmedAt ? { since: stage.designConfirmedAt } : {}) })
      return [nodeId, {
        help: entries.filter(entry => entry.type === 'help.given').length,
        questions: entries.filter(entry => entry.type === 'signal.question').length,
        misconceptions: entries.flatMap(entry => (entry.type === 'signal.misconception' ? [entry.text] : [])),
      }]
    }))
    const graph = ctx.learnKnowledge.graph(stage.courseId)
    const edges = graph.edges.filter(edge => edge.type === 'requires')
    const dependents = new Map(nodeIds.map(nodeId => [nodeId, edges.filter(edge => edge.to === nodeId).length]))
    const required = new Map(nodeIds.map(nodeId => [nodeId, edges.filter(edge => edge.from === nodeId).map(edge => edge.to as string)]))
    const requiredStates = new Map(ctx.learnLearner.states([...new Set([...required.values()].flat())]).map(state => [state.nodeId as string, courseState(state, stage.courseId)?.state ?? 'untested' as const]))
    const prerequisites = new Map([...required].map(([nodeId, ids]) => [nodeId, ids.map(id => ({ title: graph.nodes.find(node => node.id === id)?.title ?? id, state: requiredStates.get(id) ?? 'untested' as const }))]))
    const parent = stage.remedialOf ? ctx.learnCurriculum.stage(stage.remedialOf) : undefined
    const carried = ctx.learnCurriculum.carried(stage.courseId).filter(item => item.stageId !== stage.id)
    return reviewFacts({ stage, ...(parent ? { parent } : {}), view, states, signals, dependents, prerequisites, carried })
  }

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'save_roadmap',
    title: '保存课程路线',
    description: '保存粗略的课程路线：只写到"阶段标题 + 阶段目标"。每个阶段围绕一个完整任务组织。只有当前阶段会做详细设计，后面的阶段以后可以调整。只写计划中的普通阶段：已经开始或排定的阶段（包括补课阶段）保持不变，不要再写。路线开始后（第一个阶段的设计已确认）的调整要写 reason，学习者在"课程进度"页确认后才生效；改完后原来有阶段对应的目标条目必须仍有阶段对应。阶段目标写要做到的事，不写总分过关线（"做对 80%"）。路线是写给学习者看的：用名称，不写内部编号（kn_、ck_ 等）；公式写成 $…$。',
    parameters: {
      stages: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: '例如 "流体流动"' },
            objective: { type: 'string', required: true, description: '学完这个阶段能完成的完整任务' },
            supports: { type: 'array', items: { type: 'string' }, description: '这个阶段支撑目标里的哪几条"能做"（条目键，见简报）' },
          },
        },
      },
      reason: { type: 'string', description: '路线开始后必填：为什么这样调整（学习者会看到）' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const begun = ctx.learnCurriculum.stages(courseId).some(stage => stage.designConfirmedAt)
      if (begun && !args.reason?.trim()) throw new Error('路线已经开始：调整要写 reason，说明为什么这样改，学习者确认时会看到')
      const { stages, revision } = await ctx.learnCurriculum.saveRoadmap(courseId, args.stages, { actor: 'teacher', reason: args.reason?.trim() || '主老师制定课程路线' })
      if (revision) return `路线调整已提交，等学习者在"课程进度"页确认后生效（之前保持原路线）：\n${revision.stages.map(stage => `- ${stage.title}`).join('\n')}`
      return `路线已保存：\n${stages.map(stage => `${stage.id} 阶段 ${stage.index}：${stage.title}`).join('\n')}`
    },
  })), 'curriculum tools: save_roadmap')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'save_stage_design',
    title: '保存阶段设计书',
    description: '保存一个阶段的设计书（一页纸，逆向设计：先写阶段验收和测试蓝图，再写节点清单、课时安排和要用的资料），以及课时列表（一个课时 = 骨架教材的一个小节）和本阶段的核心知识点（阶段测试按它们组卷）。学习者确认设计书后，系统会自动生成这些课时的教材。简报列出以前复盘带过来的知识点时，写明怎么处理（放进哪个课时复习、前测探一下）。设计书学习者会读：测试蓝图只写考哪些知识点、题型、条件和新题比例，不写具体题目、题号或答案，也不写总分过关线（阶段测试按核心知识点逐个看）；用名称而不是内部编号（kn_、ck_、ts_ 等）；资料出处写成 [《书名》p.页码](cite:片段ID)；公式写成 $…$。',
    parameters: {
      stageId: { type: 'string', required: true },
      markdown: { type: 'string', required: true, description: '设计书正文（Markdown）' },
      supports: { type: 'array', items: { type: 'string' }, description: '本阶段的验收支撑目标里的哪几条"能做"（条目键）；不写则沿用路线里的' },
      nodes: { type: 'array', items: { type: 'string' }, description: '本阶段的核心知识点（标题或 ID）：阶段测试每个都要考到，阶段前测也探这些' },
      lessons: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            number: { type: 'string', required: true, description: '小节号，例如 "1.2"' },
            title: { type: 'string', required: true, description: '例如 "流体静力学"' },
          },
        },
      },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const nodeIds = args.nodes?.map(ref => {
        const node = ctx.learnKnowledge.resolve(courseId, ref)
        if (!node) throw new Error(`知识节点 "${ref}" 不在本课知识图里，先用 add_knowledge_nodes 添加`)
        return node.id as string
      })
      const { stage, lessons } = await ctx.learnCurriculum.saveDesign(args.stageId, { markdown: args.markdown, lessons: args.lessons, ...(args.supports ? { supports: args.supports } : {}), ...(nodeIds ? { nodeIds } : {}) }, { actor: 'teacher', reason: '主老师编写阶段设计' })
      return `阶段 ${stage.index} 的设计书已保存，共 ${lessons.length} 个课时：\n${lessons.map(lesson => `${lesson.id} ${lesson.number} ${lesson.title}`).join('\n')}\n请学习者到"课程进度"页阅读并确认。`
    },
  })), 'curriculum tools: save_stage_design')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'publish_task',
    title: '发布任务',
    description: '给学习者发布一个任务，会显示在"课程进度"页。阅读任务写清楚读到哪里停下。测试类任务请用 start_test。',
    parameters: {
      kind: { type: 'string', required: true, enum: ['predict', 'read', 'practice', 'report', 'review', 'other'] },
      title: { type: 'string', required: true },
      instructions: { type: 'string', required: true },
      lessonId: { type: 'string', description: '所属课时 ID' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const lesson = args.lessonId ? ctx.learnCurriculum.lesson(args.lessonId) : undefined
      if (args.lessonId && !lesson) throw new Error(`课时 ${args.lessonId} 不存在`)
      const stage = lesson ? ctx.learnCurriculum.stage(lesson.stageId) : ctx.learnCurriculum.currentStage(courseId)
      const task = ctx.learnCurriculum.publishTask({
        courseId: courseId as Task['courseId'],
        ...(stage ? { stageId: stage.id } : {}),
        ...(lesson ? { lessonId: lesson.id } : {}),
        kind: args.kind,
        title: args.title,
        instructions: args.instructions,
        createdBy: 'teacher',
      })
      return `任务 ${task.id} 已发布。`
    },
  })), 'curriculum tools: publish_task')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'save_stage_review',
    title: '保存阶段复盘',
    description: '阶段测试判完分后，保存这个阶段的复盘，学习者在"课程进度"页看完后决定补课还是进入下一阶段。程序已在简报里按核心知识点列出结果和默认建议，并会把结果表放在复盘开头；有题等复核或申诉时要先处理。markdown 写给学习者看：做得好的、要修的（错在哪、可能的原因）、为什么这样建议；不写内部编号。建议和默认不同（或没有默认建议）时写 reason。建议补课时写 remedial：补课阶段的标题和目标（只补没过的知识点，换一种讲法，用新题重测）。',
    parameters: {
      markdown: { type: 'string', required: true, description: '复盘正文（Markdown），从正文写起：标题和结果表程序会写' },
      recommend: { type: 'string', required: true, enum: ['next', 'remedial'], description: 'next：进入下一阶段；remedial：先补课' },
      reason: { type: 'string', description: '建议和默认不同时的理由（学习者会看到）' },
      remedial: {
        type: 'object',
        additionalProperties: false,
        description: '建议补课时必填',
        properties: {
          title: { type: 'string', required: true, description: '例如 "U 形压差计读数"（页面会标上"补课"）' },
          objective: { type: 'string', required: true, description: '补完要做到的事' },
          nodes: { type: 'array', items: { type: 'string' }, description: '要补的知识点（标题或 ID）；不写则补没过的知识点' },
        },
      },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const stage = ctx.learnCurriculum.currentStage(courseId)
      if (stage?.status !== 'reviewing') throw new Error('现在没有在复盘的阶段：阶段测试判完分后才能写复盘')
      const facts = factsOf(stage)
      if (!facts) throw new Error('找不到这个阶段判过分的阶段测试')
      if (facts.blockers.length) throw new Error(`先处理这些再写复盘：${facts.blockers.join('；')}`)
      if (args.recommend !== facts.recommendation && !args.reason?.trim()) {
        throw new Error(facts.recommendation ? `默认建议是${facts.recommendation === 'remedial' ? '先补课' : '进入下一阶段'}；建议不同时要写 reason` : '这次没有默认建议（补课后又没过）：写 reason 说明为什么这样建议')
      }
      let remedial: { title: string; objective: string; nodeIds: string[] } | undefined
      if (args.recommend === 'remedial') {
        if (!args.remedial) throw new Error('建议补课时要写 remedial（补课阶段的标题和目标）')
        const nodeIds = args.remedial.nodes?.length
          ? args.remedial.nodes.map(ref => {
            const node = ctx.learnKnowledge.resolve(courseId, ref)
            if (!node) throw new Error(`知识节点 "${ref}" 不在本课知识图里`)
            return node.id as string
          })
          : remedialNodes(facts)
        if (nodeIds.length === 0) throw new Error('这次没有没过的知识点：在 remedial.nodes 里写要补哪些')
        // The stage is shown as 补课 already; a title starting with it would say so twice.
        remedial = { title: args.remedial.title.replace(/^补课[：:]\s*/, '') || args.remedial.title, objective: args.remedial.objective, nodeIds }
      }
      await ctx.learnCurriculum.saveReview(stage.id, {
        markdown: args.markdown,
        testId: facts.testId,
        nodes: facts.nodes.map(node => ({ nodeId: node.nodeId as never, title: node.title, result: node.result })),
        ...(facts.task ? { task: facts.task.result } : {}),
        recommendation: args.recommend,
        ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
        ...(remedial ? { remedial: remedial as never } : {}),
      }, { actor: 'teacher', reason: '主老师写阶段复盘' })
      return `阶段 ${stage.index} 的复盘已保存。请学习者到"课程进度"页看复盘，决定${args.recommend === 'remedial' ? '先补课还是直接进入下一阶段' : '进入下一阶段'}。`
    },
  })), 'curriculum tools: save_stage_review')

  /** A remedial stage before its design is confirmed: what the review it follows found, and how to design it. */
  async function remedialBrief(stage: Stage): Promise<string> {
    const parent = stage.remedialOf ? ctx.learnCurriculum.stage(stage.remedialOf) : undefined
    const titles = new Map(ctx.learnKnowledge.graph(stage.courseId).nodes.map(node => [node.id as string, node.title]))
    const file = parent ? await ctx.learnCore.files.read(stage.courseId, `${parent.folder}/${STAGE_LAYOUT.review}`) : undefined
    const taskFailed = parent?.review?.task === 'fail'
    return [
      `要补的知识点：${stage.nodeIds.map(id => titles.get(id) ?? id).join('、')}${taskFailed ? '；上一阶段的完整任务题也没过' : ''}。`,
      file ? `阶段 ${parent!.index} 复盘里写的（学习者看过）：\n${reviewProse(parseFrontmatter(file.text).body)}` : '',
      `设计补课：设计书写清每个知识点错在哪、这次换什么讲法（例题拆步讲、对照常见错误），不重讲整节；一两个课时，按要补的知识点所在的小节排（lessons 用小节号）。补课阶段不做前测；重测只考这些知识点，用没见过的测试预留题${taskFailed ? '，还要有一道没见过的完整任务题（size 填 task）' : ''}，在学习者确认设计书前备好。`,
    ].filter(Boolean).join('\n')
  }

  // The review's facts while a stage is in review; a remedial stage's brief while it is designed;
  // otherwise what earlier reviews carried on and is still unverified (an independent answer after
  // the decision verifies it).
  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const stage = ctx.learnCurriculum.currentStage(request.courseId)
    if (stage?.kind === 'remedial' && !stage.designConfirmedAt) {
      return [...sections, { unit: 'curriculum', title: `补课阶段 ${stage.index} 的设计`, text: await remedialBrief(stage) }]
    }
    if (stage?.status === 'reviewing') {
      const facts = factsOf(stage)
      if (!facts) return sections
      if (stage.review) return [...sections, { unit: 'curriculum', title: `阶段 ${stage.index} 的复盘`, text: '复盘已保存，等学习者在"课程进度"页决定。' }]
      return [...sections, { unit: 'curriculum', title: `阶段 ${stage.index} 的复盘`, text: reviewFactsText(stage, facts) }]
    }
    const carried = ctx.learnCurriculum.carried(request.courseId)
    if (carried.length === 0) return sections
    const decidedAt = new Map(ctx.learnCurriculum.stages(request.courseId).map(item => [item.id as string, item.review?.decidedAt ?? '']))
    const states = new Map(ctx.learnLearner.states(carried.map(item => item.nodeId)).map(state => [state.nodeId as string, courseState(state, request.courseId)]))
    const open = carried.filter(item => {
      const state = states.get(item.nodeId)
      return !(state && (state.state === 'independent' || state.state === 'retained') && (state.lastEvidenceAt ?? '') > (decidedAt.get(item.stageId) ?? ''))
    })
    if (open.length === 0) return sections
    const risks = open.filter(item => item.kind === 'risk').map(item => item.title)
    const unverified = open.filter(item => item.kind === 'unverified').map(item => item.title)
    return [...sections, {
      unit: 'curriculum',
      title: '以前复盘带过来的知识点',
      text: `${risks.length ? `风险（没过，学习者选择往前走）：${risks.join('、')}。` : ''}${unverified.length ? `待验证（有对有错或没测到）：${unverified.join('、')}。` : ''}设计阶段时写明怎么处理（放进哪个课时复习、前测探一下）；阶段测试会优先出它们的题。独立做对一道新题后就不再列出。`,
    }]
  })
}
