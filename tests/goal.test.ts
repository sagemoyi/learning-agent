// goal A (docs/goal/design.md): checked teacher writes, facts with their source, revisions by
// version, the learner's own fact edits, changes since the learner last confirmed, versions, and
// test conditions taken from the goal. Synthetic data only; no model calls.
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { COURSE_LAYOUT, type GoalDraft, type GoalView, type Id } from '@learning-agent/contracts'
import * as goalTools from '../packages/goal/src/tools.ts'
import { FIXTURES, createHarness, type Harness } from './harness.ts'

let h: Harness
let courseId = ''
let chunkId = '' as Id<'chunk'>
const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()

const teacher = { actor: 'teacher' as const, reason: '目标测试（合成）' }
const DRAFT: GoalDraft = {
  purpose: '通过合成课程的期末考试，并真正理解静水压强',
  scenario: '期末复习',
  canDo: [{ text: '能按给定参数算出静水压强，结果与书后答案一致' }, '能解释为什么同一深度各方向压强相等'],
  level: '独立完成计算题',
  verification: '阶段测试和一次模拟卷',
  boundaries: { exclude: ['推导'], defaultConditions: { book: 'closed', calculator: true, formulaSheet: false }, timeBudget: '每周 4–6 小时' },
  exam: { scope: '第一章', sections: ['1.1'], format: [{ type: '计算题', points: 60 }, { type: '填空题', points: 40 }], conditions: { book: 'closed', calculator: true, formulaSheet: false, timeLimit: 120 }, focus: 'balanced' },
  facts: { 'exam.scope': { basis: 'learner' } },
}

beforeAll(async () => {
  h = createHarness(call => { throw new Error(`unexpected model call: ${call.purpose}`) })
  const course = await h.endpoint('core', 'createCourse', { title: '目标测试（合成资料）' })
  courseId = course.id
  const fixture = join(FIXTURES, 'synthetic-chapter')
  const source = await h.endpoint('library', 'import', { title: '合成教学大纲', kind: 'textbook', authority: '1', file: join(fixture, 'source.md'), parsed: [join(fixture, 'middle.json')], courseId, role: 'skeleton' })
  chunkId = h.ctx.learnLibrary.section(source.id, '1.1')[0]!.id
  ;(h.ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  goalTools.apply(h.ctx as never)
})

afterAll(() => h.dispose())

/** The goal's section of the teacher's brief. */
async function goalBrief(id: string): Promise<string> {
  const sections = await (h.ctx as unknown as { waterfall(name: string, request: unknown, last: () => Promise<{ unit: string; text: string }[]>): Promise<{ unit: string; text: string }[]> })
    .waterfall('learning/course-brief', { courseId: id, sessionId: 'brief' }, async () => [])
  return sections.find(section => section.unit === 'goal')!.text
}

async function view(): Promise<GoalView> {
  return h.endpoint<GoalView>('goal', 'view', { courseId })
}

it('rejects a goal the learner could not check, and says how to fix it', async () => {
  const vague = h.ctx.learnGoal.saveDraft(courseId, { ...DRAFT, canDo: ['理解静水压强'] }, '# 目标说明\n', teacher)
  await expect(vague).rejects.toThrow(/「理解静水压强」不是能检查的动作/)
  const internal = h.ctx.learnGoal.saveDraft(courseId, { ...DRAFT, level: '掌握 kn_01J0000000000000000000000A 的计算' }, '# 目标说明\n', teacher)
  await expect(internal).rejects.toThrow(/不写内部编号/)
  const official = h.ctx.learnGoal.saveDraft(courseId, { ...DRAFT, facts: { 'exam.date': { basis: 'official' } }, exam: { ...DRAFT.exam!, date: '2027-01-10' } }, '# 目标说明\n', teacher)
  await expect(official).rejects.toThrow(/「考试日期」标为官方，但没有附资料片段/)
  expect(await h.ctx.learnGoal.get(courseId)).toBeUndefined()
})

it('saves a checked draft: keys for each can-do item, hours from the words, facts the teacher guessed', async () => {
  const { doc, warnings } = await h.ctx.learnGoal.saveDraft(courseId, { ...DRAFT, verification: '阶段测试正确率 80% 以上' }, '# 目标说明\n\n合成。\n', teacher)
  expect(doc.goal).toMatchObject({ status: 'draft', version: 1, boundaries: { hoursPerWeek: { min: 4, max: 6 } } })
  expect(doc.goal.canDo.map(item => item.key)).toEqual(['c1', 'c2'])
  expect(warnings.join('\n')).toMatch(/百分比门槛没有写依据/)
  const page = await view()
  expect(page.facts.filter(fact => fact.basis === 'assumed').map(fact => fact.label)).toEqual(['测试条件', '每周投入', '题型和分值', '考试条件'])
  expect(page.facts.find(fact => fact.fact === 'exam.scope')?.basis).toBe('learner')
  // The teacher sees the keys, the version and what still waits for the learner.
  const brief = await goalBrief(courseId)
  expect(brief).toContain('第 1 版')
  expect(brief).toContain('- c2 能解释为什么同一深度各方向压强相等')
  expect(brief).toMatch(/待确认的事实：测试条件、每周投入、题型和分值、考试条件/)
})

it('warns when a goal mentions an exam but has no exam profile', async () => {
  const other = await h.endpoint('core', 'createCourse', { title: '目标测试（无档案）' })
  const { exam: _exam, facts: _facts, ...rest } = DRAFT
  const { warnings } = await h.ctx.learnGoal.saveDraft(other.id, { ...rest, facts: { 'exam.date': { basis: 'learner' } } }, '# 目标说明\n', teacher)
  expect(warnings.join('\n')).toMatch(/提到了考试，但没有考试档案/)
  // A source given for a fact with no value is not kept, and the teacher hears why.
  expect(warnings.join('\n')).toMatch(/「考试日期」在目标说明里没有值/)
})

it('takes test conditions from the goal: the exam for stage tests and mocks, the default otherwise', async () => {
  expect(await h.ctx.learnGoal.conditions(courseId, 'quiz')).toEqual({ book: 'closed', calculator: true, formulaSheet: false })
  expect(await h.ctx.learnGoal.conditions(courseId, 'stage')).toEqual({ book: 'closed', calculator: true, formulaSheet: false })
  expect(await h.ctx.learnGoal.conditions(courseId, 'mock')).toEqual({ book: 'closed', calculator: true, formulaSheet: false, timeLimit: 120 })
})

it('confirms with facts still pending, and tells the teacher which', async () => {
  await h.endpoint('goal', 'confirm', { courseId })
  await h.settle()
  expect(h.delivered.at(-1)!.text).toContain('还待确认的事实：测试条件、每周投入、题型和分值、考试条件')
  expect((await view()).changes).toEqual([])
})

it('lets the learner set and confirm facts on the page, without confirming the goal again', async () => {
  const before = await view()
  await h.endpoint('goal', 'setFacts', { courseId, version: before.doc.goal.version, examDate: '2027-01-10', confirm: ['exam.conditions'] })
  const after = await view()
  expect(after.doc.goal.status).toBe('confirmed')
  expect(after.doc.goal.exam?.date).toBe('2027-01-10')
  expect(after.facts.find(fact => fact.fact === 'exam.date')?.basis).toBe('learner')
  expect(after.facts.find(fact => fact.fact === 'exam.conditions')?.basis).toBe('learner')
  await h.settle()
  expect(h.delivered.at(-1)!.text).toContain('学习者在目标说明里：考试日期改为 2027-01-10；确认了考试条件。')
  // A stale page and a malformed date are refused in words.
  expect((await h.call('goal', 'setFacts', { courseId, version: before.doc.goal.version, deadline: '2027-02-01' })).error?.code).toBe('learning/goal/stale')
  expect((await h.call('goal', 'setFacts', { courseId, version: after.doc.goal.version, deadline: '明年' })).error?.message).toMatch(/2027-01-10 这样的日期/)
})

it('keeps a confirmed goal confirmed for fact revisions and shows the learner what changed', async () => {
  const current = (await h.ctx.learnGoal.get(courseId))!
  const official = await h.ctx.learnGoal.revise(courseId, current.goal.version, { exam: { grading: '平时 30%，期末 70%' }, facts: { 'exam.grading': { basis: 'official', chunkId } } }, { ...teacher, reason: '按教学大纲补成绩构成' })
  expect(official.doc.goal.status).toBe('confirmed')
  expect(official.doc.goal.exam?.date).toBe('2027-01-10')
  const page = await view()
  expect(page.changes).toEqual([{ label: '成绩构成', after: '平时 30%，期末 70%' }])
  expect(page.facts.find(fact => fact.fact === 'exam.grading')).toMatchObject({ basis: 'official', chunkId })
  expect(page.facts.find(fact => fact.fact === 'exam.grading')?.citation).toBeTruthy()
  await h.endpoint('goal', 'acknowledge', { courseId, version: page.doc.goal.version })
  expect((await view()).changes).toEqual([])
})

it('reopens a confirmed goal when a choice changes, keeping the keys of reworded items', async () => {
  const current = (await h.ctx.learnGoal.get(courseId))!
  await expect(h.ctx.learnGoal.revise(courseId, current.goal.version - 1, { level: '更高' }, teacher)).rejects.toThrow(/已经是第/)
  await expect(h.ctx.learnGoal.revise(courseId, current.goal.version, { canDo: [{ key: 'c9', text: '能算' }] }, teacher)).rejects.toThrow(/没有这些"学成后能做"条目：c9/)
  const { doc } = await h.ctx.learnGoal.revise(courseId, current.goal.version, {
    canDo: [{ key: 'c1', text: '能按给定参数算出静水压强和总压力，结果与书后答案一致' }, { text: '能判断两点压强的大小关系' }],
  }, { ...teacher, reason: '学习者想加一条' })
  expect(doc.goal.status).toBe('draft')
  expect(doc.goal.canDo.map(item => item.key)).toEqual(['c1', 'c3'])
  const page = await view()
  expect(page.changes.map(change => change.before === undefined ? `+${change.after}` : change.after === undefined ? `-${change.before}` : `${change.before}→${change.after}`)).toEqual([
    '能按给定参数算出静水压强，结果与书后答案一致→能按给定参数算出静水压强和总压力，结果与书后答案一致',
    '+能判断两点压强的大小关系',
    '-能解释为什么同一深度各方向压强相等',
  ])
  expect(page.impacts).toEqual(['课程路线和阶段设计可能要跟着调整，老师会检查'])
  // Every write is a version the learner can read back, newest first.
  expect(page.history.map(version => `${version.version} ${version.actor} ${version.status}`)).toEqual([
    `${doc.goal.version} teacher draft`, `${doc.goal.version - 1} user confirmed`, `${doc.goal.version - 2} teacher confirmed`, `${doc.goal.version - 3} user confirmed`, '2 user confirmed', '1 teacher draft',
  ])
  // Saving the same content again writes nothing.
  const same = await h.ctx.learnGoal.revise(courseId, doc.goal.version, { level: doc.goal.level }, teacher)
  expect(same.doc.goal.version).toBe(doc.goal.version)
  expect(same.warnings[0]).toMatch(/没有修改|相同/)
})

it('reads a skeleton goal file: plain can-do strings get keys and the version counts its writes', async () => {
  const other = await h.endpoint('core', 'createCourse', { title: '目标测试（旧文件）' })
  const text = '---\nstatus: confirmed\npurpose: 旧目标\nscenario: 复习\ncanDo:\n  - 能算出静水压强\n  - 能解释等压面\nlevel: 会做题\nverification: 阶段测试\nboundaries:\n  exclude: []\n  defaultConditions:\n    book: closed\n    calculator: true\n    formulaSheet: false\n---\n\n# 目标说明\n'
  await h.ctx.learnCore.files.write(other.id, COURSE_LAYOUT.goal, text, { actor: 'teacher', reason: '旧骨架写入' })
  await h.ctx.learnCore.files.write(other.id, COURSE_LAYOUT.goal, text, { actor: 'user', reason: '旧骨架确认' })
  const doc = (await h.ctx.learnGoal.get(other.id))!
  expect(doc.goal.version).toBe(2)
  expect(doc.goal.canDo).toEqual([{ key: 'c1', text: '能算出静水压强' }, { key: 'c2', text: '能解释等压面' }])
  // Its assumed conditions show as pending; a revision writes version 3 with the keys kept.
  const { doc: next } = await h.ctx.learnGoal.revise(other.id, 2, { deadline: '2027-01-20' }, teacher)
  expect(next.goal).toMatchObject({ version: 3, status: 'confirmed', canDo: [{ key: 'c1' }, { key: 'c2' }] })
  expect((await h.endpoint<GoalView>('goal', 'view', { courseId: other.id })).history.map(version => version.version)).toEqual([3, 2, 1])
})

it('gives the teacher tools that write the exam profile and revise single fields', async () => {
  const other = await h.endpoint('core', 'createCourse', { title: '目标测试（工具）' })
  const sessionId = await h.ctx.learnTutor.session(other.id)
  const exec = { agent: { session: { id: sessionId } } }
  const saved = await tools.get('save_goal_draft')!.execute({
    purpose: '期末考试', scenario: '复习', canDo: [{ text: '能算出静水压强' }], level: '会做题', verification: '模拟卷',
    book: 'closed', calculator: true, formulaSheet: false, exam: { scope: '第一章', book: 'open', calculator: true, formulaSheet: true, focus: 'pass' },
    facts: [{ fact: 'exam.conditions', basis: 'learner' }], notes: '学习者选了"能做题"。',
  }, exec)
  expect(saved).toBe('目标说明已保存为第 1 版，等学习者在"课程进度"页确认；确认前不要进入下一步。\n页面会请学习者确认这些推测的事实：测试条件、考试范围。')
  const revised = await tools.get('revise_goal')!.execute({ version: 1, reason: '学习者说考试可以带公式表', formulaSheet: true, exam: { date: '2027-01-12' }, facts: [{ fact: 'exam.date', basis: 'learner' }] }, exec)
  expect(revised).toMatch(/^目标说明已保存为第 2 版/)
  const doc = (await h.ctx.learnGoal.get(other.id))!
  expect(doc.goal.boundaries.defaultConditions).toEqual({ book: 'closed', calculator: true, formulaSheet: true })
  expect(doc.goal.exam).toMatchObject({ date: '2027-01-12', conditions: { book: 'open', calculator: true, formulaSheet: true }, focus: 'pass' })
  await expect(tools.get('revise_goal')!.execute({ version: 2, reason: '加档案', removeExam: true, exam: { scope: 'x' } }, exec)).resolves.toMatch(/第 3 版/)
  expect((await h.ctx.learnGoal.get(other.id))!.goal.exam).toBeUndefined()
})
