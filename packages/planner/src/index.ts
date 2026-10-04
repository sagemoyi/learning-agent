// planner unit, host half. Provides `ctx.learnPlanner` (contracts §5.1): what happens next in a course.
// Skeleton: a fixed walk through the PLAN §10 minimal flow, read from the other units' state. The
// teacher gets it at the top of every brief; the home page and progress page show it to the learner.
// Review scheduling, the daily list and "welcome back" come when the unit is built out (PLAN §4.10).
import { Service, type Context } from '@deepseek-ai/cordis'
import type { LearnPlanner, NextStep } from '@learning-agent/contracts'
import { z } from 'zod'

export const name = 'learning-planner'
export const inject = ['learnCore', 'learnGoal', 'learnLibrary', 'learnKnowledge', 'learnAssess', 'learnCurriculum', 'learnTextbook']

class LearnPlannerService extends Service implements LearnPlanner {
  constructor(ctx: Context) {
    super(ctx, 'learnPlanner')
  }

  async next(courseId: string): Promise<NextStep> {
    const { learnGoal, learnLibrary, learnKnowledge, learnAssess, learnCurriculum, learnTextbook } = this.ctx
    const step = (actor: NextStep['actor'], title: string, detail: string, page?: string, params?: Record<string, unknown>): NextStep =>
      ({ courseId, actor, title, detail, ...(page ? { page } : {}), ...(params ? { params } : {}) })

    const goal = await learnGoal.get(courseId).catch(() => undefined)
    if (!goal) return step('teacher', '商量学习目标', '先给学习者几个候选终点（各配"学成后能做什么"的例子），只追问会改变路线的问题；商定后调用 save_goal_draft。', 'tutor.chat')
    if (goal.goal.status !== 'confirmed') return step('learner', '确认目标说明', '到"课程进度"页看目标说明草稿，没问题就点"确认目标"；要改就告诉主老师。', 'curriculum.progress')
    if (learnLibrary.courseSources(courseId).length === 0) return step('learner', '把教材加入本课', '到"资料库"把骨架教材设为本课的骨架教材（还没导入就先导入）。', 'library.sources')
    if (learnKnowledge.graph(courseId).nodes.length === 0) return step('teacher', '搭初版知识图', '用 read_section 看骨架教材目录和第一部分的内容，再用 add_knowledge_nodes 建出知识节点和先修关系。', 'tutor.chat')

    const tests = learnAssess.tests(courseId)
    const diagnostic = tests.find(test => test.kind === 'diagnostic')
    if (!diagnostic) return step('teacher', '出摸底题', '从骨架教材的习题里挑 3 道有区分度的题（read_section "习题"），用 add_problems 加入题库，再用 start_test 发布 kind="diagnostic" 的摸底。', 'tutor.chat')
    if (diagnostic.status === 'open') return step('learner', '做摸底题', '只是摸底，不算成绩，不会就写"不会"。', 'assess.test', { id: diagnostic.id })

    const stages = learnCurriculum.stages(courseId)
    if (stages.length === 0) return step('teacher', '排课程路线', '结合目标和摸底结果（get_test_result），用 save_roadmap 排出阶段（只写标题和阶段目标）。', 'tutor.chat')
    const stage = learnCurriculum.currentStage(courseId)
    if (!stage) return step('teacher', '结课', '所有阶段都完成了（骨架阶段还没有结课流程）。')
    if (stage.status === 'planned') return step('teacher', `设计阶段 ${stage.index}`, `用 save_stage_design 为阶段 ${stage.index}「${stage.title}」（${stage.id}）写设计书：先写阶段验收和测试蓝图，再写节点、课时（一个课时对应骨架教材的一个小节）。`, 'tutor.chat')
    if (stage.status === 'designing' && !stage.designConfirmedAt) return step('learner', `确认阶段 ${stage.index} 的设计书`, '到"课程进度"页阅读设计书，没问题就点"确认设计，生成教材"。', 'curriculum.progress')
    if (stage.status === 'designing') {
      const running = learnTextbook.running().length
      return step('learner', '等教材生成', running ? `正在生成 ${running} 个课时的教材，稍等一两分钟。` : '教材生成没有完成，可以在教材页重新生成。', 'textbook.reader')
    }

    for (const lesson of learnCurriculum.lessons(stage.id)) {
      if (lesson.status === 'done') continue
      const tasks = learnCurriculum.tasks(courseId, { lessonId: lesson.id })
      const read = tasks.find(task => task.kind === 'read')
      if (!read) return step('teacher', `发布 ${lesson.number} 的阅读任务`, `用 publish_task 发布课时 ${lesson.number} ${lesson.title}（${lesson.id}）的阅读任务，写清读哪里。`, 'tutor.chat')
      if (read.status === 'open') return step('learner', `读教材 ${lesson.number} ${lesson.title}`, '读完在"课程进度"页点"完成"，或者告诉主老师。读的时候随时可以点一段在右侧提问。', 'textbook.reader', { id: lesson.id })
      const quiz = learnAssess.tests(courseId, { lessonId: lesson.id, kind: 'quiz' }).at(-1)
      if (!quiz) return step('teacher', `出 ${lesson.number} 的小测`, `先 read_lesson_textbook 读本节教材，再出 2–3 道凭记忆作答的小测题（优先用资料里的题，add_problems），用 start_test(kind="quiz", lessonId="${lesson.id}") 发布。`, 'tutor.chat')
      if (quiz.status === 'open') return step('learner', `做 ${lesson.number} 的小测`, '凭记忆作答。', 'assess.test', { id: quiz.id })
      return step('teacher', `${lesson.number} 的汇报和小结`, `用 get_test_result 看小测结果，请学习者用一两句话说说学到了什么、哪里还不清楚，然后 write_lesson_summary 写小结（lessonId="${lesson.id}"）。`, 'tutor.chat')
    }
    return step('teacher', `阶段 ${stage.index} 的阶段测试和复盘`, '本阶段的课时都完成了。阶段测试和复盘在骨架阶段还没有实现。', 'tutor.chat')
  }
}

export function apply(ctx: Context): void {
  const planner = new LearnPlannerService(ctx)

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const step = await planner.next(request.courseId)
    const text = step.actor === 'teacher'
      ? `该你做：${step.title}。${step.detail}`
      : `等学习者：${step.title}。${step.detail}（这一步由学习者在页面上完成，你可以提醒他，不要替他做。）`
    return [...sections, { unit: 'planner', title: '下一步', text }]
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
