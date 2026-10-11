// "考我一下" (docs/learner/design.md, C): the learner asks to be checked on one knowledge point. One practice
// problem the learner has not met is published as a one-problem 复查 test (marked `check`), under the course's
// conditions for reviews; while it is open the teacher does not discuss it (tutor's classroom rule), and handing
// it in goes back to the teacher like any test. Mastery still comes only from the graded answer. The planner
// suggests checks too (docs/planner/design.md, B), and the teacher can start one; all go through here.
import type { Context } from '@deepseek-ai/cordis'
import { LearningApiError, type Problem, type Task, type Test } from '@learning-agent/contracts'
import type { AssessStore } from './store.ts'

const NO_GOAL_CONDITIONS = { book: 'closed', calculator: true, formulaSheet: false } as const
const TITLE = '考我一下'

type Needed = 'learnKnowledge' | 'learnCurriculum' | 'learnGoal'

/** A unit assess does not inject (it loads without them), looked up when the learner asks. */
function service<K extends Needed>(ctx: Context, name: K): Context[K] {
  const found = ctx.get(name) as Context[K] | undefined
  if (!found) throw new LearningApiError('learning/assess/unavailable', '知识模型、课程设计或目标单元没有加载，现在出不了题')
  return found
}

/** The node and the identities merged into it: problems written for those ask about it too. */
function idsOf(ctx: Context, nodeId: string): Set<string> {
  return new Set([nodeId, ...service(ctx, 'learnKnowledge').identity(nodeId).merged])
}

/** Practice problems on the node the learner has not met, whole tasks left out; those on this point alone first. */
export function freshProblems(ctx: Context, store: AssessStore, courseId: string, nodeId: string, seen = store.seenProblemIds(courseId)): Problem[] {
  const knowledge = service(ctx, 'learnKnowledge')
  const ids = idsOf(ctx, nodeId)
  const only = (problem: Problem) => problem.nodeIds.every(id => ids.has(knowledge.identity(id).current) || ids.has(id))
  return store.problems({ nodeIds: [...ids], pool: 'practice' })
    .filter(problem => !seen.has(problem.id) && problem.size !== 'task')
    .sort((a, b) => Number(!only(a)) - Number(!only(b)))
}

/** The nodes a check can ask about now: each has a practice problem the learner has not met. */
export function checkable(ctx: Context, store: AssessStore, courseId: string, nodeIds: readonly string[]): string[] {
  if (nodeIds.length === 0) return []
  const seen = store.seenProblemIds(courseId)
  return nodeIds.filter(nodeId => freshProblems(ctx, store, courseId, nodeId, seen).length > 0)
}

/** The check's name as its task shows it, e.g. 考我一下 · 静水压强计算（1 题）. */
export function checkTitle(ctx: Context, test: Test): string {
  const node = test.check ? (ctx.get('learnKnowledge') as Context['learnKnowledge'] | undefined)?.node(test.check.nodeId) : undefined
  return `${TITLE}${node ? ` · ${node.title}` : ''}（${test.problemIds.length} 题）`
}

/** Start a check on the node, or return the one still open on it. `by`: who asked, the learner or the teacher. */
export async function quickCheck(ctx: Context, store: AssessStore, courseId: string, nodeId: string, by: Task['createdBy'] = 'user'): Promise<Test> {
  const knowledge = service(ctx, 'learnKnowledge'), curriculum = service(ctx, 'learnCurriculum')
  const node = knowledge.graph(courseId).nodes.find(item => item.id === nodeId)
  if (!node) throw new LearningApiError('learning/assess/not-in-course', '这个知识点不在本课的知识模型里', { nodeId })
  const conditions = (await service(ctx, 'learnGoal').conditions(courseId, 'review')) ?? NO_GOAL_CONDITIONS
  // From here on nothing waits: two requests at once cannot both find no check and start one each.
  const ids = idsOf(ctx, nodeId)
  const publish = (test: Test) => curriculum.publishTask({
    courseId: courseId as Test['courseId'],
    ...(test.stageId ? { stageId: test.stageId } : {}),
    kind: 'review',
    title: checkTitle(ctx, test),
    instructions: '不看资料、不问老师，自己做。做完交卷，结果会记进这个知识点的证据。',
    createdBy: by,
    result: { kind: 'test', id: test.id },
  })
  const open = store.tests(courseId, { kind: 'review' }).find(test => test.status === 'open' && test.check && ids.has(test.check.nodeId))
  if (open) {
    // Started before a task could be published (a crash in between): the learner still needs the task.
    if (!curriculum.tasks(courseId).some(task => task.result?.kind === 'test' && task.result.id === open.id)) publish(open)
    return open
  }
  const problem = freshProblems(ctx, store, courseId, nodeId)[0]
  if (!problem) {
    throw new LearningApiError('learning/assess/no-fresh-problem', `「${node.title}」没有你还没做过的练习题。可以请主老师补几道题再来。`, { nodeId })
  }
  const stage = curriculum.currentStage(courseId)
  const test = store.startTest({
    courseId,
    kind: 'review',
    problemIds: [problem.id],
    check: { nodeId },
    ...(stage ? { stageId: stage.id } : {}),
    conditions,
  })
  publish(test)
  return test
}
