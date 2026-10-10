// "考我一下" (docs/learner/design.md, C): the learner asks to be checked on one knowledge point. One practice
// problem the learner has not met is published as a one-problem 复查 test (marked `check`), under the course's
// conditions for reviews; while it is open the teacher does not discuss it (tutor's classroom rule), and handing
// it in goes back to the teacher like any test. Mastery still comes only from the graded answer.
import type { Context } from '@deepseek-ai/cordis'
import { LearningApiError, type Problem, type Test } from '@learning-agent/contracts'
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


export async function quickCheck(ctx: Context, store: AssessStore, courseId: string, nodeId: string): Promise<Test> {
  const knowledge = service(ctx, 'learnKnowledge'), curriculum = service(ctx, 'learnCurriculum')
  const node = knowledge.graph(courseId).nodes.find(item => item.id === nodeId)
  if (!node) throw new LearningApiError('learning/assess/not-in-course', '这个知识点不在本课的知识模型里', { nodeId })
  // Problems written for an identity merged into this node ask about it too.
  const ids = new Set([nodeId, ...knowledge.identity(nodeId).merged])
  const open = store.tests(courseId, { kind: 'review' }).find(test => test.status === 'open' && test.check && ids.has(test.check.nodeId))
  if (open) return open
  const seen = store.seenProblemIds(courseId)
  const only = (problem: Problem) => problem.nodeIds.every(id => ids.has(knowledge.identity(id).current) || ids.has(id))
  const candidates = store.problems({ nodeIds: [...ids], pool: 'practice' })
    .filter(problem => !seen.has(problem.id) && problem.size !== 'task')
    // A problem on this point alone says the most about it.
    .sort((a, b) => Number(!only(a)) - Number(!only(b)))
  const problem = candidates[0]
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
    conditions: (await service(ctx, 'learnGoal').conditions(courseId, 'review')) ?? NO_GOAL_CONDITIONS,
  })
  curriculum.publishTask({
    courseId: courseId as Test['courseId'],
    ...(test.stageId ? { stageId: test.stageId } : {}),
    kind: 'review',
    title: `${TITLE} · ${node.title}（1 题）`,
    instructions: '不看资料、不问老师，自己做。做完交卷，结果会记进这个知识点的证据。',
    createdBy: 'user',
    result: { kind: 'test', id: test.id },
  })
  return test
}
