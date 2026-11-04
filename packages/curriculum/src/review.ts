// Stage reviews (docs/curriculum/design.md, 阶段复盘): the facts the program reads for each core node and its
// default recommendation. Pure; tools.ts gathers the inputs from assess, learner and knowledge.
import type { CarriedNode, MasteryState, NodeOutcome, ReportVerdict, ReviewChoice, ReviewNodeFacts, ReviewResult, Stage, StageReviewFacts, TestView, Verdict } from '@learning-agent/contracts'

export interface NodeSignals {
  readonly help: number
  readonly questions: number
  readonly misconceptions: readonly string[]
}

export interface ReviewSources {
  readonly stage: Stage
  /** The stage a remedial stage follows. */
  readonly parent?: Stage
  /** The stage test, graded. */
  readonly view: TestView
  readonly states: ReadonlyMap<string, { readonly state: MasteryState; readonly explanation: string; readonly doubtful: boolean }>
  readonly signals: ReadonlyMap<string, NodeSignals>
  readonly dependents: ReadonlyMap<string, number>
  readonly prerequisites?: ReadonlyMap<string, readonly { readonly title: string; readonly state: MasteryState }[]>
  readonly carried: readonly CarriedNode[]
  /** The identity a problem's node is now; the problems keep the ids they were written with. */
  readonly currentOf?: (nodeId: string) => string
}

/**
 * Nodes the decided reviews carried on, oldest first. Passed over (the learner went on): a failed node is a
 * risk, and with the complete task failed so are the nodes it left unverified; otherwise those stay
 * unverified. A later review of the node replaces what an earlier one carried. `now`: a decided review's results as
 * its stage test reads today; a result changed after the decision counts as it is now, passed over (the decision did
 * not see it), with a note. `named`: a node as the identity it is now, so a later review of the node it was merged into
 * replaces it too.
 */
export function carriedOf(stages: readonly Stage[], now?: (stage: Stage) => ReadonlyMap<string, ReviewResult> | undefined, named: (node: { readonly nodeId: string; readonly title: string }) => { readonly nodeId: string; readonly title: string } = node => node): CarriedNode[] {
  const carried = new Map<string, CarriedNode>()
  for (const stage of stages) {
    const review = stage.review
    if (!review?.choice) continue
    const current = now?.(stage)
    for (const node of review.nodes) {
      const { nodeId, title } = named(node)
      carried.delete(nodeId)
      const result = current?.get(nodeId) ?? node.result
      const changed = result !== node.result
      const passedOver = review.choice === 'next' || changed
      const kind = result === 'fail' ? (passedOver ? 'risk' : undefined) : result === 'unverified' ? (passedOver && review.task === 'fail' ? 'risk' : 'unverified') : undefined
      if (kind) carried.set(nodeId, { nodeId: nodeId as never, title, kind, stageId: stage.id, ...(changed ? { note: `复盘决定后结果从"${RESULT_WORD[node.result]}"变成"${RESULT_WORD[result]}"` } : {}) })
    }
  }
  return [...carried.values()]
}

/**
 * What a review rests on, one line per problem of its stage test: the grading that stands, how it counts now, an open
 * appeal, a problem under review. Saved with the review; a line that differs later makes it stale.
 */
export function basisOf(view: TestView): string[] {
  return view.problems.map((problem, index) => {
    const attempt = view.attempts.find(item => item.problemId === problem.id)
    const counting = attempt ? view.counting?.find(item => item.attemptId === attempt.id) : undefined
    const parts = [
      attempt?.grading ? VERDICT_WORD[attempt.grading.verdict] : '没答',
      counting?.status === 'void' ? '不计' : counting?.help === 'helped' ? '有帮助' : counting?.help === 'uncertain' ? '帮助状态不确定' : '',
      view.appeals.some(appeal => appeal.problemId === problem.id && !appeal.outcome) ? '有申诉待复核' : '',
      problem.status === 'under-review' ? '在核查中' : '',
    ].filter(Boolean)
    return `第 ${index + 1} 题：${parts.join('，')}`
  })
}

/** How the facts changed since a review was saved: "第 2 题：原来"对"，现在"错"". None for a review saved without a basis. */
export function basisChanges(saved: readonly string[] | undefined, now: readonly string[]): string[] {
  if (!saved) return []
  return now.flatMap((line, index) => {
    const before = saved[index]
    if (before === line) return []
    const head = line.slice(0, line.indexOf('：') + 1)
    return [`${head}原来"${before?.slice(head.length) ?? '—'}"，现在"${line.slice(head.length)}"`]
  })
}

/** A stage test's results per core node as its report reads now. */
export function resultsOf(view: TestView): ReadonlyMap<string, ReviewResult> {
  return new Map((view.stageReport?.nodes ?? []).map(node => [node.nodeId, RESULT_OF[node.outcome]]))
}

/** What must be settled before a test's result is read: pending gradings, open appeals, problems under review. */
export function blockersOf(view: TestView): string[] {
  const numberOf = (problemId: string) => view.problems.findIndex(problem => problem.id === problemId) + 1
  return [
    ...view.attempts.filter(attempt => attempt.grading?.verdict === 'pending-review').map(attempt => `第 ${numberOf(attempt.problemId)} 题等复核：核对后用 regrade 判`),
    ...view.appeals.filter(appeal => !appeal.outcome).map(appeal => `第 ${numberOf(appeal.problemId)} 题有学习者的申诉：用 regrade 复核`),
    ...view.problems.filter(problem => problem.status === 'under-review').map(problem => `第 ${numberOf(problem.id)} 题在核查中（被报告有问题或答案存疑）：用 review_problem 处理`),
  ]
}

/** Helped or help uncertain: done, but not yet on the learner's own. */
const RESULT_OF: Record<NodeOutcome, ReviewResult> = { pass: 'pass', assisted: 'unverified', fail: 'fail', mixed: 'unverified', insufficient: 'unverified', pending: 'unverified' }

/** A complete task partly right has not been done to the standard; one helped, or whose problem was found wrong, is not verified. */
function taskResult(task: ReportVerdict): ReviewResult {
  if (task.void || task.assisted) return 'unverified'
  return task.verdict === 'correct' ? 'pass' : task.verdict === 'partial' || task.verdict === 'incorrect' ? 'fail' : 'unverified'
}

export function reviewFacts(sources: ReviewSources): StageReviewFacts {
  const { stage, parent, view } = sources
  const report = view.stageReport
  if (!report) throw new Error(`测试 ${view.test.id} 不是判过分的阶段测试`)
  const blockers = blockersOf(view)

  const again = new Set<string>(parent?.review?.remedial?.nodeIds ?? [])
  const nodes: ReviewNodeFacts[] = report.nodes.map(node => {
    const state = sources.states.get(node.nodeId)
    const signals = sources.signals.get(node.nodeId)
    // The report reads answers as they count now: one whose problem was found wrong later is no evidence either way.
    const result = RESULT_OF[node.outcome]
    return {
      nodeId: node.nodeId,
      title: node.title,
      result,
      outcome: node.outcome,
      problems: node.problems,
      state: state?.state ?? 'untested',
      explanation: state?.explanation ?? '',
      doubtful: state?.doubtful ?? false,
      help: signals?.help ?? 0,
      questions: signals?.questions ?? 0,
      misconceptions: signals?.misconceptions ?? [],
      dependents: sources.dependents.get(node.nodeId) ?? 0,
      prerequisites: sources.prerequisites?.get(node.nodeId) ?? [],
      again: stage.kind === 'remedial' && result === 'fail' && again.has(node.nodeId),
      ...(node.notes?.length ? { notes: node.notes } : {}),
    }
  })

  const taskProblem = report.task ? view.problems[report.task.number - 1] : undefined
  const task = report.task && taskProblem
    ? { number: report.task.number, result: taskResult(report.task), nodeIds: [...new Set(taskProblem.nodeIds.map(id => sources.currentOf?.(id) ?? id))].filter(id => stage.nodeIds.includes(id as never)) as string[] }
    : undefined

  const carried = sources.carried.flatMap(item => {
    const core = report.nodes.find(node => node.nodeId === item.nodeId)
    const earlier = report.earlier.find(entry => entry.nodeId === item.nodeId)
    if (!core && !earlier) return []
    // Helped, or found wrong later: no conclusion this time.
    const verdict: Verdict | undefined = core ? ({ pass: 'correct', fail: 'incorrect' } as Partial<Record<NodeOutcome, Verdict>>)[core.outcome] : earlier && !earlier.assisted && !earlier.void ? earlier.verdict : undefined
    return [{ ...item, ...(verdict ? { verdict } : {}) }]
  })

  let recommendation: ReviewChoice | undefined = nodes.some(node => node.result === 'fail') || task?.result === 'fail' ? 'remedial' : 'next'
  if (nodes.some(node => node.again)) recommendation = undefined
  return {
    stageId: stage.id,
    testId: view.test.id,
    nodes,
    ...(task ? { task } : {}),
    earlier: report.earlier,
    goals: report.goals,
    carried,
    blockers,
    ...(recommendation ? { recommendation } : {}),
  }
}

/** The nodes a remedial stage should take on by default: the failed ones, else the complete task's. */
export function remedialNodes(facts: StageReviewFacts): string[] {
  const failed = facts.nodes.filter(node => node.result === 'fail').map(node => node.nodeId)
  return failed.length ? failed : facts.task?.result === 'fail' ? [...facts.task.nodeIds] : []
}

export const STATE_WORD: Record<MasteryState, string> = {
  untested: '未探测', 'not-yet': '还没答对', assisted: '有帮助完成', independent: '已独立完成', retained: '已延迟验证', conflict: '证据冲突',
}
const RESULT_WORD: Record<ReviewResult, string> = { pass: '过了', fail: '没过', unverified: '待验证' }
const OUTCOME_WORD: Record<NodeOutcome, string> = { pass: '新题都对', assisted: '新题做对了，但有帮助或帮助状态不确定', fail: '新题没做对', mixed: '有对有错', pending: '等复核', insufficient: '没有算数的新题作答' }
const VERDICT_WORD: Record<Verdict, string> = { correct: '对', partial: '部分对', incorrect: '错', 'pending-review': '等复核' }

/** The facts for the teacher's brief, in words. */
export function reviewFactsText(stage: Stage, facts: StageReviewFacts): string {
  const nodeLines = facts.nodes.map(node => {
    const process = [
      `${STATE_WORD[node.state]}${node.explanation ? `（${node.explanation}）` : ''}${node.doubtful ? '，有疑点' : ''}`,
      node.help ? `本阶段得到帮助 ${node.help} 次` : '',
      node.questions ? `侧边会话问过 ${node.questions} 次` : '',
      node.misconceptions.length ? `记下的误解：${node.misconceptions.slice(0, 2).join('；')}` : '',
      node.dependents ? `后面 ${node.dependents} 个知识点以它为先修` : '',
      node.result === 'fail' && node.prerequisites.length ? `它的先修：${node.prerequisites.map(item => `${item.title}（${STATE_WORD[item.state]}）`).join('、')}` : '',
      node.again ? '补课后又没过' : '',
      ...(node.notes ?? []),
    ].filter(Boolean).join('；')
    return `- ${node.title}：${RESULT_WORD[node.result]}（${OUTCOME_WORD[node.outcome]}，第 ${node.problems.join('、') || '—'} 题）。${process}`
  })
  const lines = [
    `阶段测试 ${facts.testId} 已判分。按核心知识点：`,
    ...nodeLines,
    ...(facts.task ? [`完整任务题（第 ${facts.task.number} 题）：${RESULT_WORD[facts.task.result]}`] : ['这次没有完整任务题。']),
    ...(facts.earlier.length ? [`前面阶段的题：${facts.earlier.map(entry => `${entry.title}（第 ${entry.number} 题）${entry.void ? '题目有错，不计' : entry.assisted ? '有帮助做对' : entry.verdict ? VERDICT_WORD[entry.verdict] : '没答'}`).join('；')}`] : []),
    ...(facts.carried.length ? [`以前复盘带过来的：${facts.carried.map(item => `${item.title}（${item.kind === 'risk' ? '风险' : '待验证'}）这次${item.verdict ? VERDICT_WORD[item.verdict] : '没有定论'}`).join('；')}`] : []),
    ...(facts.blockers.length ? [`先处理这些再写复盘：${facts.blockers.join('；')}。`] : []),
  ]
  const failed = facts.nodes.filter(node => node.result === 'fail').map(node => node.title)
  const unverified = facts.nodes.filter(node => node.result === 'unverified').map(node => node.title)
  const advice = facts.recommendation === undefined
    ? `没有默认建议：${facts.nodes.filter(node => node.again).map(node => node.title).join('、')}补课后又没过。先看它们的先修知识点和题目本身，再和学习者商量（补先修、调整路线、修订目标，或带着风险往前走），save_stage_review 时写明 reason。`
    : facts.recommendation === 'remedial'
      ? `默认建议：先补课（${failed.length ? failed.join('、') : '完整任务涉及的知识点'}）${unverified.length ? `；待验证的 ${unverified.join('、')} 带进下一阶段` : ''}。`
      : `默认建议：进入下一阶段${unverified.length ? `，${unverified.join('、')}记为待验证，下一阶段补验证` : ''}。`
  return [
    ...lines,
    advice,
    `做法：先在对话里和学习者过一遍每个知识点的结果和依据，就没过的地方问一句当时怎么想的（不填表）；然后用 save_stage_review 保存复盘，学习者在"课程进度"页决定。${stage.kind === 'remedial' ? '这是补课阶段的复盘。' : ''}`,
  ].join('\n')
}
