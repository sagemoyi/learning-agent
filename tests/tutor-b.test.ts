// tutor B (docs/tutor/design.md, 课堂记录与课时收尾): after each teacher turn the classroom record
// logs the help the teacher gave and what the learner said, keeping only what the program can check;
// help is dated by the reply, so an answer right after it counts as helped; while a test is open the
// brief carries the classroom rule; "I know this" waits in the brief until an answer checks it; the
// lesson summary is refused until the quiz is settled and the report is the learner's own words.
// Synthetic data; fake model and fake DSH sessions.
import { afterEach, expect, it } from 'vitest'
import * as tutorTools from '../packages/tutor/src/tools.ts'
import { createHarness, type Harness, type ModelCall } from './harness.ts'
import { lessonCourse, lessonText } from './lesson-setup.ts'

const meta = { actor: 'teacher' as const, reason: '主老师 B 测试（合成）' }

let h: Harness | undefined
afterEach(() => h?.dispose())

/** What the fake 课堂记录 model answers next: a reply, or an error. */
let ledger: unknown = { help: [] }
const ledgerCalls = () => h!.calls.filter(call => call.purpose === 'learning-tutor-ledger')

function reply(call: ModelCall): string {
  const text = lessonText(call)
  if (text) return text
  if (call.purpose === 'learning-tutor-ledger') {
    if (ledger instanceof Error) throw ledger
    return JSON.stringify(ledger)
  }
  throw new Error(`unexpected model call: ${call.purpose}`)
}

let clock = 0
/** Log one message in a fake session, now (and after the previous one). */
function say(sessionId: string, who: 'learner' | 'teacher' | string, text: string): number {
  const session = h!.sessions.get(sessionId) ?? { events: [] }
  h!.sessions.set(sessionId, session)
  clock = Math.max(clock + 1, Date.now())
  const content = [{ type: 'text', text }]
  session.events.push(who === 'teacher'
    ? { type: 'assistant/message', time: clock, data: { message: { content } } } as never
    : { type: 'user/message', time: clock, data: { content, source: { kind: who === 'learner' ? 'user' : who } } } as never)
  return clock
}

/** The teacher's turn is over: its agent goes idle. */
async function endTurn(sessionId: string): Promise<void> {
  ;(h!.ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('agent/status', { agent: { session: { id: sessionId } }, status: 'idle' })
  await h!.settle(60)
}

const log = (courseId: string) => h!.ctx.learnCore.log.query({ courseId, types: ['help.given', 'signal.self-report', 'signal.question', 'signal.misconception'] })
const brief = (courseId: string) => h!.ctx.learnTutor.brief(courseId, 'brief')

it('records the help and what the learner said, keeping only what it can check', async () => {
  h = createHarness(reply)
  const { ctx } = h
  const course = await h.endpoint('core', 'createCourse', { title: '主老师 B 课堂记录（合成资料）' })
  const graph = await ctx.learnKnowledge.add(course.id, { nodes: [{ title: '静水压强计算', kind: 'skill' }] }, meta)
  const nodeId = graph.nodes[0]!.id
  const teacher = await ctx.learnTutor.session(course.id)
  await h.settle()

  say(teacher, 'learning-course-brief', '【课程现状简报】不该出现在课堂记录里')
  say(teacher, 'learning-handoff', '【进度通知】\n- 学习者交了小测（1 题），判分：错')
  say(teacher, 'learner', '压强为什么和深度有关？我一直以为只和面积有关。')
  const explained = say(teacher, 'teacher', '静水压强来自上面液柱的重量：深度越大，上面的液柱越高，所以 p = ρgh 随深度线性增加，和容器的面积无关。')
  const claimed = say(teacher, 'learner', '这个我会了，换一题吧。')
  say(teacher, 'teacher', '好。')
  ledger = {
    help: [
      { reply: 1, level: 'explanation', nodes: ['N1'] },
      { reply: 5, level: 'hint', nodes: ['N1'] }, // no such reply
      { reply: 2, level: 'hint', nodes: ['N9'] }, // no such node
    ],
    claims: [{ quote: '这个我会了', claim: 'known', nodes: ['N1'] }, { quote: '我早就全懂了', claim: 'known', nodes: ['N1'] }],
    questions: [{ quote: '压强为什么和深度有关', nodes: ['N1'] }],
    misconceptions: [
      { quote: '以为只和面积有关', text: '认为静水压强只和受力面积有关', nodes: ['N1'] },
      { quote: '压强和体积成正比', text: '认为压强和体积成正比', nodes: ['N1'] }, // the learner never said it
    ],
  }
  await endTurn(teacher)

  const prompt = ledgerCalls().at(-1)!.prompt
  expect(prompt).toContain('[N1] 静水压强计算')
  expect(prompt).toContain('【老师 1】静水压强来自上面液柱的重量')
  expect(prompt).toContain('【系统通知】【进度通知】')
  expect(prompt).not.toContain('不该出现在课堂记录里')
  const entries = log(course.id)
  expect(entries.map(entry => entry.type).sort()).toEqual(['help.given', 'signal.misconception', 'signal.question', 'signal.self-report'])
  expect(entries.find(entry => entry.type === 'help.given')).toMatchObject({ level: 'explanation', via: 'teacher', nodeIds: [nodeId], at: new Date(explained).toISOString(), context: { sessionId: teacher } })
  expect(entries.find(entry => entry.type === 'signal.self-report')).toMatchObject({ claim: 'known', text: '这个我会了', at: new Date(claimed).toISOString() })
  expect(entries.find(entry => entry.type === 'signal.misconception')).toMatchObject({ text: '认为静水压强只和受力面积有关（原话："以为只和面积有关"）' })

  // Nothing new: no call. A turn with only a short teacher line: no call either.
  await endTurn(teacher)
  say(teacher, 'teacher', '好的，去测试页作答吧。')
  await endTurn(teacher)
  expect(ledgerCalls()).toHaveLength(1)

  // The model fails: nothing is logged, and the next turn records both turns once.
  ledger = new Error('模型不可用')
  say(teacher, 'learner', '那温度对压强有影响吗？')
  say(teacher, 'teacher', '在本章的条件下液体密度看作不变，温度的影响通过密度体现，这里不考虑。')
  await endTurn(teacher)
  expect(log(course.id)).toHaveLength(4)
  ledger = { questions: [{ quote: '那温度对压强有影响吗', nodes: ['N1'] }, { quote: '密度变了怎么办', nodes: ['N1'] }] }
  say(teacher, 'learner', '密度变了怎么办？')
  say(teacher, 'teacher', '密度变了就按新的密度代入 p = ρgh。')
  await endTurn(teacher)
  const retried = ledgerCalls().at(-1)!.prompt
  expect(retried).toContain('那温度对压强有影响吗')
  expect(retried).toContain('密度变了怎么办')
  expect(retried).not.toContain('好的，去测试页作答吧')
  expect(log(course.id).filter(entry => entry.type === 'signal.question').map(entry => (entry as { text: string }).text).sort()).toEqual(['压强为什么和深度有关', '那温度对压强有影响吗', '密度变了怎么办'].sort())
})

it('counts an answer right after the teacher helped as helped, with the classroom rule while the test is open', async () => {
  h = createHarness(reply)
  const { ctx, endpoint } = h
  const { courseId, nodeId, lesson, problems } = await lessonCourse(h, '主老师 B 帮助与测试（合成资料）')
  const teacher = await ctx.learnTutor.session(courseId)

  // "I know this" waits in the brief until an answer checks it.
  say(teacher, 'learner', '静水压强这个我会了。')
  say(teacher, 'teacher', '好，等会儿出两道题验证一下，先把这一节读完。')
  ledger = { claims: [{ quote: '这个我会了', claim: 'known', nodes: ['N1'] }] }
  await endTurn(teacher)
  expect(await brief(courseId)).toContain('学习者说已经会了、还没用题验证：静水压强计算（"这个我会了"）')

  const quiz = ctx.learnAssess.startTest({ courseId, kind: 'quiz', lessonId: lesson.id, problemIds: [problems[3]!.id, problems[4]!.id] })
  expect(await brief(courseId)).toMatch(/## 课堂\n没交卷的测试：小测 · 1\.1（2 题）。学习者问到这些测试里的题，只说明怎么作答/)
  // The learner asks about the first quiz problem; the teacher gives it away.
  say(teacher, 'learner', '小测第一题的水深要换算成米吗？')
  const hinted = say(teacher, 'teacher', '要，先把水深换成米，再代入 p = ρgh。')
  ledger = { help: [{ reply: 1, level: 'hint', problem: 'P1' }] }
  await endTurn(teacher)
  expect(ledgerCalls().at(-1)!.prompt).toMatch(/\[P1\] 小测 · 1\.1 第 1 题（未交卷）：/)
  expect(log(courseId).find(entry => entry.type === 'help.given')).toMatchObject({
    level: 'hint', problemId: problems[3]!.id, nodeIds: [nodeId], at: new Date(hinted).toISOString(),
    context: { sessionId: teacher, lessonId: lesson.id, testId: quiz.id },
  })

  // An explanation of what the open quiz asks, without naming a problem, also counts against it.
  say(teacher, 'learner', '为什么深度一样压强就一样？')
  say(teacher, 'teacher', '因为静止的同一种液体里，压强只由上面液柱的高度决定，和容器形状无关，所以同一深度压强相等。')
  ledger = { help: [{ reply: 1, level: 'explanation', nodes: ['N1'] }] }
  await endTurn(teacher)
  expect(log(courseId).filter(entry => entry.type === 'help.given').at(-1)).toMatchObject({ level: 'explanation', context: { testId: quiz.id, lessonId: lesson.id } })
  expect(log(courseId).filter(entry => entry.type === 'help.given').at(-1)).not.toHaveProperty('problemId')

  await endpoint('assess', 'submit', { testId: quiz.id, answers: [{ problemId: problems[3]!.id, text: '40000 Pa' }, { problemId: problems[4]!.id, text: '50000 Pa' }] })
  // The diagnostic before any help stays independent; both quiz answers in the lesson count as helped.
  expect(ctx.learnLearner.states([nodeId])[0]!.explanation).toContain('独立答对 1 次，有帮助答对 2 次')
  const after = await brief(courseId)
  expect(after).not.toContain('没交卷的测试')
  expect(after).not.toContain('还没用题验证')
})

it('writes the lesson summary only when the quiz is settled and the report is the learner\'s own words', async () => {
  h = createHarness(reply)
  const { ctx, endpoint } = h
  const { courseId, lesson, problems } = await lessonCourse(h, '主老师 B 小结（合成资料）')
  const teacher = await ctx.learnTutor.session(courseId)
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  tutorTools.apply(ctx as never)
  const summarize = (learnerReport: string, session = teacher) => tools.get('write_lesson_summary')!.execute({ lessonId: lesson.id, learnerReport, summary: '小测两题都对。单位换算还要再练。' }, { agent: { session: { id: session } } })

  await expect(summarize('我会了')).rejects.toThrow('1.1 还没有小测')
  const quiz = ctx.learnAssess.startTest({ courseId, kind: 'quiz', lessonId: lesson.id, problemIds: [problems[3]!.id, problems[4]!.id] })
  await expect(summarize('我会了')).rejects.toThrow('小测还没交卷')
  await endpoint('assess', 'submit', { testId: quiz.id, answers: [{ problemId: problems[3]!.id, text: '40000 Pa' }, { problemId: problems[4]!.id, text: '50000 Pa' }] })

  // The teacher makes up a report: refused.
  say(teacher, 'learner', '我学会了按水深算压强，单位换算还不太熟。')
  await expect(summarize('我已经完全掌握了静水压强')).rejects.toThrow('汇报要照录学习者在对话里说过的原话')
  // Another course's session cannot close this lesson.
  const other = await endpoint('core', 'createCourse', { title: '另一门课（合成资料）' })
  const otherTeacher = await ctx.learnTutor.session(other.id)
  await expect(summarize('我学会了按水深算压强', otherTeacher)).rejects.toThrow('不是这门课的课时')
  expect(ctx.learnCurriculum.lesson(lesson.id)?.status).not.toBe('done')

  expect(await summarize('我学会了按水深算压强\n单位换算还不太熟')).toBe('课时记录已写好，这一课时已记为完成。')
  expect(ctx.learnCurriculum.lesson(lesson.id)?.status).toBe('done')
  const text = (await ctx.learnCore.files.read(courseId, lesson.recordFile!))!.text
  const body = text.slice(text.indexOf('\n---', 3) + 4)
  expect(body).toContain('## 小测\n\n对 2/2\n\n- 第 1 题')
  expect(body).toContain('## 本课时记下的帮助\n\n没有。')
  expect(body).toContain('## 写小结时的掌握状态\n\n- 静水压强计算：独立完成')
  expect(body).toContain('## 学习者的汇报\n\n我学会了按水深算压强\n单位换算还不太熟')
  expect(body).not.toMatch(/\b[a-z]{2}_[0-9A-Z]{20,}/)
})

it('sorts a long stretch a window at a time and skips a stretch that keeps failing', async () => {
  h = createHarness(reply)
  const { ctx } = h
  const course = await h.endpoint('core', 'createCourse', { title: '主老师 B 分段整理（合成资料）' })
  await ctx.learnKnowledge.add(course.id, { nodes: [{ title: '静水压强计算', kind: 'skill' }] }, meta)
  const teacher = await ctx.learnTutor.session(course.id)
  await h.settle()
  ledger = { help: [] }
  for (let i = 1; i <= 8; i++) {
    say(teacher, 'learner', `第 ${i} 个问题：水深 ${i} m 处的压强怎么算？`)
    say(teacher, 'teacher', `按 p = ρgh 代入水深 ${i} m，记得单位统一成国际单位再算，结果的单位是帕斯卡。`)
  }
  const before = ledgerCalls().length
  await endTurn(teacher)
  // 16 lines of talk: two calls, the first with 12 lines.
  const calls = ledgerCalls().slice(before)
  expect(calls).toHaveLength(2)
  expect(calls[0]!.prompt).toContain('第 1 个问题')
  expect(calls[0]!.prompt).not.toContain('第 7 个问题')
  expect(calls[1]!.prompt).toContain('第 7 个问题')

  // The same stretch fails three times: it is skipped, and what comes after is still recorded.
  ledger = new Error('模型不可用')
  say(teacher, 'learner', '跳过的问题：压强的单位是什么？')
  say(teacher, 'teacher', '压强的单位是帕斯卡，1 Pa 等于 1 N/m²，工程上常用 kPa 和 MPa。')
  for (let i = 0; i < 3; i++) await endTurn(teacher)
  ledger = { help: [] }
  say(teacher, 'learner', '最后一个问题：表压和绝压差多少？')
  say(teacher, 'teacher', '差一个当地大气压：绝对压强等于表压强加上大气压强。')
  await endTurn(teacher)
  const last = ledgerCalls().at(-1)!.prompt
  expect(last).toContain('最后一个问题')
  expect(last).not.toContain('跳过的问题')
})
