// planner unit, host half. Provides `ctx.learnPlanner` (contracts §5.1): what happens next in a course.
// Skeleton: a fixed walk through the minimal learning flow (docs/PLAN.md, development route), read from the other units' state. The
// teacher gets it at the top of every brief; the home page and progress page show it to the learner.
// Review scheduling, the daily list and "welcome back" come when the unit is built out (docs/planner/design.md).
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Countdown, GoalDoc, LearnPlanner, NextStep } from '@learning-agent/contracts'
import { countdownText } from './countdown.ts'
import { z } from 'zod'

export const name = 'learning-planner'
export const inject = ['learnCore', 'learnGoal', 'learnLibrary', 'learnKnowledge', 'learnAssess', 'learnCurriculum', 'learnTextbook']

class LearnPlannerService extends Service implements LearnPlanner {
  constructor(ctx: Context) {
    super(ctx, 'learnPlanner')
  }

  async next(courseId: string): Promise<NextStep> {
    const goal = await this.ctx.learnGoal.get(courseId).catch(() => undefined)
    const step = await this.step(courseId, goal)
    const countdown = this.countdown(courseId, goal)
    return countdown ? { ...step, countdown } : step
  }

  /** The earlier of the exam date and the deadline, with the roadmap's progress. Counts days, never hours or chances. */
  countdown(courseId: string, goal: GoalDoc | undefined, today = new Date()): Countdown | undefined {
    const dates = [
      ...(goal?.goal.exam?.date ? [{ label: '考试' as const, date: goal.goal.exam.date }] : []),
      ...(goal?.goal.deadline ? [{ label: '期限' as const, date: goal.goal.deadline }] : []),
    ].sort((a, b) => a.date.localeCompare(b.date))
    const first = dates[0]
    if (!first) return undefined
    const midnight = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
    const [year, month, day] = first.date.split('-').map(Number) as [number, number, number]
    const days = Math.round((Date.UTC(year, month - 1, day) - midnight(today)) / 86_400_000)
    const stages = this.ctx.learnCurriculum.stages(courseId)
    return { ...first, days, stagesDone: stages.filter(stage => stage.status === 'done').length, stagesTotal: stages.length }
  }

  private async step(courseId: string, goal: GoalDoc | undefined): Promise<NextStep> {
    const { learnLibrary, learnKnowledge, learnAssess, learnCurriculum, learnTextbook } = this.ctx
    const step = (actor: NextStep['actor'], title: string, detail: string, page?: string, params?: Record<string, unknown>): NextStep =>
      ({ courseId, actor, title, detail, ...(page ? { page } : {}), ...(params ? { params } : {}) })

    if (!goal) return step('teacher', '商量学习目标', '用 offer_goal_options 给学习者几个候选终点，只追问会改变路线的问题；学习者选定后调用 save_goal_draft。', 'tutor.chat')
    if (goal.goal.status !== 'confirmed') return step('learner', '确认目标说明', '到"课程进度"页看目标说明草稿，没问题就点"确认目标"；要改就告诉主老师。', 'curriculum.progress')
    if (learnLibrary.courseSources(courseId).length === 0) return step('learner', '把教材加入本课', '到"资料库"把骨架教材设为本课的骨架教材（还没导入就先导入）。', 'library.sources')
    if (learnKnowledge.graph(courseId).nodes.length === 0) return step('teacher', '搭初版知识图', '用 read_section 看骨架教材目录和第一部分的内容，再用 add_knowledge_nodes 建出知识节点和先修关系。', 'tutor.chat')

    const tests = learnAssess.tests(courseId)
    const diagnostic = tests.find(test => test.kind === 'diagnostic')
    if (!diagnostic) return step('teacher', '出摸底题', '用 read_section 读"习题"，给第一阶段要用到的知识节点各导入一两道能当场判分、步骤不多的习题（import_exercises，pool 填 practice），再用 start_test(kind="diagnostic", nodes=…) 发布：程序沿先修关系逐题出，最多 10 题。', 'tutor.chat')
    if (diagnostic.status === 'open') return step('learner', '做摸底题', '只是摸底，不算成绩，一次一题，不会就点"不会"。', 'assess.test', { id: diagnostic.id })

    const stages = learnCurriculum.stages(courseId)
    if (stages.length === 0) return step('teacher', '排课程路线', '结合目标和摸底结果（get_test_result），用 save_roadmap 排出阶段（只写标题和阶段目标）。', 'tutor.chat')
    if (learnCurriculum.revision(courseId)) return step('learner', '看看路线调整', '主老师提议调整后面的路线。到"课程进度"页看改了什么、为什么，点"按新路线"或"保持原来的"。', 'curriculum.progress')
    const stage = learnCurriculum.currentStage(courseId)
    if (!stage) return step('teacher', '结课', '所有阶段都完成了（骨架阶段还没有结课流程）。')
    if (stage.status === 'planned') return step('teacher', `设计阶段 ${stage.index}`, `用 save_stage_design 为阶段 ${stage.index}「${stage.title}」（${stage.id}）写设计书：先写阶段验收和测试蓝图，再写节点、课时（一个课时对应骨架教材的一个小节）。`, 'tutor.chat')
    if (stage.status === 'designing' && !stage.designConfirmedAt) return step('learner', `确认阶段 ${stage.index} 的设计书`, '到"课程进度"页阅读设计书，没问题就点"确认设计，生成教材"。', 'curriculum.progress')
    // From stage 2 on, a short pretest while the textbook is written (stage 1 has the course's diagnostic;
    // a remedial stage follows its stage test).
    if (stage.index > 1 && stage.kind === 'normal') {
      const pretest = learnAssess.tests(courseId, { kind: 'pretest' }).find(test => test.stageId === stage.id)
      if (!pretest) return step('teacher', `出阶段 ${stage.index} 的前测`, `给本阶段的核心知识点各导入一两道能当场判分的短题（import_exercises，pool 填 practice），再用 start_test(kind="pretest") 发布，最多 5 题；结果用来决定本阶段从哪里讲起。`, 'tutor.chat')
      if (pretest.status === 'open') return step('learner', `做阶段 ${stage.index} 的前测`, '几道题，不算成绩，不会就点"不会"。', 'assess.test', { id: pretest.id })
    }
    // Lessons in order; each needs its textbook before its reading task. The stage becomes ready
    // with its first lesson's textbook, so later lessons may still be generating.
    for (const lesson of learnCurriculum.lessons(stage.id)) {
      if (lesson.status === 'done') continue
      const textbook = learnTextbook.status(lesson.id)
      if (textbook.state === 'running') return step('learner', `等教材 ${lesson.number} 生成`, `${textbook.message || '正在生成'}。长的小节要几分钟，生成好了主老师会接着上课。`, 'textbook.reader', { id: lesson.id })
      if (textbook.state === 'failed' && (textbook.failures ?? 1) >= 2) return step('learner', `教材 ${lesson.number} 生成失败`, `已经连续失败 ${textbook.failures} 次，最近一次的原因：${textbook.message}。可以稍后在教材页点"生成本节教材"再试。`, 'textbook.reader', { id: lesson.id })
      if (textbook.state === 'failed') return step('teacher', `教材 ${lesson.number} 生成失败`, `失败原因：${textbook.message}。告诉学习者发生了什么，然后用 regenerate_textbook（lessonId="${lesson.id}"）重试一次；再失败就请学习者稍后在教材页点"生成本节教材"。`, 'tutor.chat')
      if (textbook.state === 'missing') return step('teacher', `生成教材 ${lesson.number}`, `课时 ${lesson.number} ${lesson.title} 还没有教材，用 regenerate_textbook（lessonId="${lesson.id}"）生成。`, 'tutor.chat')
      const tasks = learnCurriculum.tasks(courseId, { lessonId: lesson.id })
      const read = tasks.find(task => task.kind === 'read')
      if (!read) return step('teacher', `发布 ${lesson.number} 的阅读任务`, `用 publish_task 发布课时 ${lesson.number} ${lesson.title}（${lesson.id}）的阅读任务，写清读哪里。`, 'tutor.chat')
      if (read.status === 'open') return step('learner', `读教材 ${lesson.number} ${lesson.title}`, '读完在"课程进度"页点"完成"，或者告诉主老师。读的时候随时可以点一段在右侧提问。', 'textbook.reader', { id: lesson.id })
      const quiz = learnAssess.tests(courseId, { lessonId: lesson.id, kind: 'quiz' }).at(-1)
      if (!quiz) return step('teacher', `出 ${lesson.number} 的小测`, `先 read_lesson_textbook 读本节教材，再出 2–3 道凭记忆作答的小测题（优先用资料里的题，add_problems），用 start_test(kind="quiz", lessonId="${lesson.id}") 发布。`, 'tutor.chat')
      if (quiz.status === 'open') return step('learner', `做 ${lesson.number} 的小测`, '凭记忆作答。', 'assess.test', { id: quiz.id })
      return step('teacher', `${lesson.number} 的汇报和小结`, `用 get_test_result 看小测结果，请学习者用一两句话说说学到了什么、哪里还不清楚，然后 write_lesson_summary 写小结（lessonId="${lesson.id}"）。`, 'tutor.chat')
    }
    const stageTest = learnAssess.tests(courseId, { kind: 'stage' }).filter(test => test.stageId === stage.id).at(-1)
    if (!stageTest || stageTest.status === 'abandoned') return step('teacher', `发布阶段 ${stage.index} 的阶段测试`, '本阶段的课时都完成了。用 start_test(kind="stage") 发布阶段测试：程序按阶段设计里的核心知识点，从没见过的测试预留题里组卷（一道完整任务题、每个核心知识点都有题、一两道前面阶段的题）。', 'tutor.chat')
    if (stageTest.status === 'open') return step('learner', `做阶段 ${stage.index} 的阶段测试`, '独立完成，按测试条件作答。题目有问题可以点"这题有问题"。', 'assess.test', { id: stageTest.id })
    if (stage.review) return step('learner', `决定阶段 ${stage.index} 之后怎么走`, '到"课程进度"页看复盘：哪些知识点过了、哪些没过，主老师建议补课还是进入下一阶段，由你决定。', 'curriculum.progress')
    return step('teacher', `阶段 ${stage.index} 的复盘`, `简报里有按知识点的复盘事实和默认建议。先处理等复核的题和申诉，再和学习者过一遍结果，用 save_stage_review 保存复盘。`, 'tutor.chat')
  }
}

export function apply(ctx: Context): void {
  const planner = new LearnPlannerService(ctx)

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const step = await planner.next(request.courseId)
    const text = step.actor === 'teacher'
      ? `该你做：${step.title}。${step.detail}`
      : `等学习者：${step.title}。${step.detail}（这一步由学习者在页面上完成，你可以提醒学习者，不要替学习者做。）`
    return [...sections, { unit: 'planner', title: '下一步', text: step.countdown ? `${text}\n${countdownText(step.countdown)}。` : text }]
  })

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'planner',
    method: 'next',
    input: z.object({ courseId: z.string() }),
    handle: ({ courseId }) => planner.next(courseId),
  }), 'planner: next')

  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'planner',
    method: 'home',
    handle: async () => Promise.all(ctx.learnCore.courses.list().map(async course => ({ course, next: await planner.next(course.id).catch(() => null) }))),
  }), 'planner: home')
}
