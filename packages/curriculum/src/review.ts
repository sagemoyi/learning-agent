// Stage reviews (docs/curriculum/design.md, A): the facts the program reads for each core node and its
// default recommendation. Pure; tools.ts gathers the inputs from assess, learner and knowledge.
import type { CarriedNode, MasteryState, NodeOutcome, ReviewChoice, ReviewNodeFacts, ReviewResult, Stage, StageReviewFacts, TestView, Verdict } from '@learning-agent/contracts'

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
}

/**
 * Nodes the decided reviews carried on, oldest first. Passed over (the learner went on): a failed node is a
 * risk, and with the complete task failed so are the nodes it left unverified; otherwise those stay
 * unverified. A later review of the node replaces what an earlier one carried.
 */
export function carriedOf(stages: readonly Stage[]): CarriedNode[] {
  const carried = new Map<string, CarriedNode>()
  for (const stage of stages) {
    const review = stage.review
    if (!review?.choice) continue
    const passedOver = review.choice === 'next'
    for (const node of review.nodes) {
      carried.delete(node.nodeId)
      const kind = node.result === 'fail' ? (passedOver ? 'risk' : undefined) : node.result === 'unverified' ? (passedOver && review.task === 'fail' ? 'risk' : 'unverified') : undefined
      if (kind) carried.set(node.nodeId, { nodeId: node.nodeId, title: node.title, kind, stageId: stage.id })
    }
  }
  return [...carried.values()]
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

const RESULT_OF: Record<NodeOutcome, ReviewResult> = { pass: 'pass', fail: 'fail', mixed: 'unverified', insufficient: 'unverified', pending: 'unverified' }

/** A complete task partly right has not been done to the standard. */
function taskResult(verdict: Verdict | undefined): ReviewResult {
  return verdict === 'correct' ? 'pass' : verdict === 'partial' || verdict === 'incorrect' ? 'fail' : 'unverified'
}

export function reviewFacts(sources: ReviewSources): StageReviewFacts {
  const { stage, parent, view } = sources
  const report = view.stageReport
  if (!report) throw new Error(`测试 ${view.test.id} 不是判过分的阶段测试`)
  const numberOf = (problemId: string) => view.problems.findIndex(problem => problem.id === problemId) + 1
  const retired = new Set(view.problems.filter(problem => problem.status === 'retired').map(problem => numberOf(problem.id)))
  const blockers = blockersOf(view)

  const again = new Set<string>(parent?.review?.remedial?.nodeIds ?? [])
  const nodes: ReviewNodeFacts[] = report.nodes.map(node => {
    const state = sources.states.get(node.nodeId)
    const signals = sources.signals.get(node.nodeId)
    // A retired problem no longer counts: what it showed is not evidence either way.
    const result = node.problems.some(number => retired.has(number)) ? 'unverified' : RESULT_OF[node.outcome]
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
    }
  })

  const taskProblem = report.task ? view.problems[report.task.number - 1] : undefined
  const task = report.task && taskProblem
    ? { number: report.task.number, result: taskResult(report.task.verdict), nodeIds: taskProblem.nodeIds.filter(id => stage.nodeIds.includes(id as never)) as string[] }
    : undefined

  const carried = sources.carried.flatMap(item => {
    const core = report.nodes.find(node => node.nodeId === item.nodeId)
    const earlier = report.earlier.find(entry => entry.nodeId === item.nodeId)
    if (!core && !earlier) return []
    const verdict: Verdict | undefined = core ? ({ pass: 'correct', fail: 'incorrect' } as Partial<Record<NodeOutcome, Verdict>>)[core.outcome] : earlier?.verdict
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
const OUTCOME_WORD: Record<NodeOutcome, string> = { pass: '新题都对', fail: '新题没做对', mixed: '有对有错', pending: '等复核', insufficient: '没答到新题' }
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
    ].filter(Boolean).join('；')
    return `- ${node.title}：${RESULT_WORD[node.result]}（${OUTCOME_WORD[node.outcome]}，第 ${node.problems.join('、') || '—'} 题）。${process}`
  })
  const lines = [
    `阶段测试 ${facts.testId} 已判分。按核心知识点：`,
    ...nodeLines,
    ...(facts.task ? [`完整任务题（第 ${facts.task.number} 题）：${RESULT_WORD[facts.task.result]}`] : ['这次没有完整任务题。']),
    ...(facts.earlier.length ? [`前面阶段的题：${facts.earlier.map(entry => `${entry.title}（第 ${entry.number} 题）${entry.verdict ? VERDICT_WORD[entry.verdict] : '没答'}`).join('；')}`] : []),
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
