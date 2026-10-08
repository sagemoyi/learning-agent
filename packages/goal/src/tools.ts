// goal unit, agent tools: draft the goal statement, then revise it field by field against its version.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { FactSource, GoalFact, GoalSaved, TestConditions } from '@learning-agent/contracts'
import { linkOf, textTool } from '@learning-agent/kit'
import { FACT_LABEL, pendingFacts } from './words.ts'

export const name = 'learning-goal-tools'
export const inject = ['tools', 'learnGoal', 'learnCore']

const FACT_KEYS = ['conditions', 'hours', 'deadline', 'exam.date', 'exam.scope', 'exam.format', 'exam.grading', 'exam.conditions'] as const

const CAN_DO = {
  type: 'object', additionalProperties: false, properties: {
    text: { type: 'string', required: true, description: '以"能……"开头的可检查动作，写清条件' },
    evidence: { type: 'string', description: '和整体验证方式不同时才写' },
  },
} as const

const EXAM = {
  scope: { type: 'string', description: '用章节名称写' },
  sections: { type: 'array', items: { type: 'string' }, description: '骨架教材的小节号' },
  format: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', required: true, description: '题型' }, points: { type: 'number', description: '分值' }, note: { type: 'string' } } } },
  grading: { type: 'string', description: '成绩构成，例如"平时 30%，期末 70%"' },
  date: { type: 'string', description: '考试日期，YYYY-MM-DD' },
  book: { type: 'string', enum: ['closed', 'open'] },
  calculator: { type: 'boolean' },
  formulaSheet: { type: 'boolean' },
  timeLimit: { type: 'integer', description: '考试时长，分钟' },
  focus: { type: 'string', enum: ['pass', 'balanced', 'understanding'], description: '只求通过 / 兼顾分数和理解 / 以理解为主' },
} as const

const FACTS = {
  type: 'array',
  description: '学习者说的或资料里读到的事实；没列出的算你的推测，页面会请学习者确认',
  items: { type: 'object', additionalProperties: false, properties: {
    fact: { type: 'string', required: true, enum: FACT_KEYS, description: 'conditions 默认测试条件，hours 每周投入' },
    basis: { type: 'string', required: true, enum: ['learner', 'official'], description: 'official 须附 chunkId' },
    chunkId: { type: 'string', description: '资料片段 ID' },
  } },
} as const

type FactArg = { fact: (typeof FACT_KEYS)[number]; basis: 'learner' | 'official'; chunkId?: string }

function factMap(facts: readonly FactArg[] | undefined): Partial<Record<GoalFact, FactSource>> | undefined {
  return facts && Object.fromEntries(facts.map(item => [item.fact, item.basis === 'official' ? { basis: 'official', chunkId: item.chunkId } : { basis: 'learner' }]))
}

type ExamArg = { scope?: string; sections?: string[]; format?: { type: string; points?: number; note?: string }[]; grading?: string; date?: string; book?: 'closed' | 'open'; calculator?: boolean; formulaSheet?: boolean; timeLimit?: number; focus?: 'pass' | 'balanced' | 'understanding' }

/** Tool arguments → an exam profile patch: the conditions merge into the current ones. */
function examOf(args: ExamArg, current?: TestConditions): Record<string, unknown> {
  const { book, calculator, formulaSheet, timeLimit, ...rest } = args
  const touched = book !== undefined || calculator !== undefined || formulaSheet !== undefined || timeLimit !== undefined
  return { ...rest, ...(touched ? { conditions: { ...current, ...(book ? { book } : {}), ...(calculator === undefined ? {} : { calculator }), ...(formulaSheet === undefined ? {} : { formulaSheet }), ...(timeLimit ? { timeLimit } : {}) } } : {}) }
}

function report(saved: GoalSaved, reopened: boolean): string {
  const { goal } = saved.doc
  const unchanged = saved.warnings.find(line => line.startsWith('内容和第'))
  const pending = pendingFacts(goal)
  return [
    unchanged ? `没有修改：${unchanged}` : `目标说明已保存为第 ${goal.version} 版${reopened ? '，回到草稿，等学习者重新确认' : goal.status === 'draft' ? '，等学习者在"课程进度"页确认；确认前不要进入下一步' : '，仍是已确认的目标（只改了事实）'}。`,
    pending.length ? `页面会请学习者确认这些推测的事实：${pending.map(fact => FACT_LABEL[fact]).join('、')}。` : '',
    ...saved.warnings.filter(line => line !== unchanged).map(line => `提醒：${line}`),
  ].filter(Boolean).join('\n')
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(textTool({
    name: 'save_goal_draft',
    title: '保存目标说明草稿',
    description: '把和学习者商量好的目标写成目标说明（整份）。学习者在"课程进度"页确认；已确认的目标改了目的、能做、程度这类选择会回到草稿。只改个别字段用 revise_goal。各字段学习者会读：用名称，不写内部编号；公式写成 $…$。',
    parameters: {
      purpose: { type: 'string', required: true, description: '目的：为什么学' },
      scenario: { type: 'string', required: true, description: '使用场景' },
      canDo: { type: 'array', required: true, items: CAN_DO, description: '学成后能做的事' },
      level: { type: 'string', required: true, description: '要做到什么程度' },
      verification: { type: 'string', required: true, description: '怎么验证学会了；门槛要有依据（例如考试的及格线）' },
      exclude: { type: 'array', items: { type: 'string' }, description: '边界：不学什么' },
      book: { type: 'string', required: true, enum: ['closed', 'open'], description: '默认测试条件（还有 calculator、formulaSheet）' },
      calculator: { type: 'boolean', required: true },
      formulaSheet: { type: 'boolean', required: true },
      timeBudget: { type: 'string', description: '打算投入多少时间，写成"每周 4–6 小时"这样' },
      deadline: { type: 'string', description: '学习者自己定的完成日期，YYYY-MM-DD；考试日期写在 exam.date' },
      exam: { type: 'object', additionalProperties: false, properties: EXAM, description: '有考试时的考试档案；scope、book、calculator、formulaSheet、focus 必填，学习者说不清的先写推测' },
      facts: FACTS,
      notes: { type: 'string', required: true, description: '正文：用几段话说明这个目标，包括你给过的候选终点和学习者的选择' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const before = await ctx.learnGoal.get(courseId).catch(() => undefined)
      const saved = await ctx.learnGoal.saveDraft(courseId, {
        purpose: args.purpose,
        scenario: args.scenario,
        canDo: args.canDo,
        level: args.level,
        verification: args.verification,
        boundaries: {
          exclude: args.exclude ?? [],
          defaultConditions: { book: args.book, calculator: args.calculator, formulaSheet: args.formulaSheet },
          ...(args.timeBudget ? { timeBudget: args.timeBudget } : {}),
        },
        ...(args.deadline ? { deadline: args.deadline } : {}),
        ...(args.exam ? { exam: examOf(args.exam) as never } : {}),
        ...(args.facts ? { facts: factMap(args.facts as FactArg[]) } : {}),
      }, `# 目标说明\n\n${args.notes}\n`, { actor: 'teacher', reason: '主老师起草目标说明' })
      return report(saved, before?.goal.status === 'confirmed' && saved.doc.goal.status === 'draft')
    },
  })), 'goal tools: save_goal_draft')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'revise_goal',
    title: '修订目标说明',
    description: '按版本修改目标说明的个别字段，没传的字段不变。版本和"能做"条目的键见简报里的目标说明。改目的、能做、程度、验证方式、不学或考试侧重会让已确认的目标回到草稿；只改事实（测试条件、时间、日期、考试档案的其他项）仍是已确认的。',
    parameters: {
      version: { type: 'integer', required: true, description: '要修订的版本' },
      reason: { type: 'string', required: true, description: '为什么改，学习者会在版本记录里看到' },
      purpose: { type: 'string' },
      scenario: { type: 'string' },
      canDo: { type: 'array', items: { ...CAN_DO, properties: { key: { type: 'string', description: '已有条目的键，例如 c2；新条目不写' }, ...CAN_DO.properties } }, description: '完整列表：带键的是改写已有条目，不带键的是新条目，没列出的条目删除' },
      level: { type: 'string' },
      verification: { type: 'string' },
      exclude: { type: 'array', items: { type: 'string' } },
      book: { type: 'string', enum: ['closed', 'open'], description: '默认测试条件' },
      calculator: { type: 'boolean' },
      formulaSheet: { type: 'boolean' },
      timeBudget: { type: 'string', description: '写成"每周 4–6 小时"这样' },
      deadline: { type: 'string', description: '学习者自己定的完成日期，YYYY-MM-DD，空字符串表示去掉；考试日期写在 exam.date' },
      exam: { type: 'object', additionalProperties: false, properties: EXAM, description: '只写要改的项；还没有考试档案时，新建要写 scope、book、calculator、formulaSheet、focus' },
      removeExam: { type: 'boolean', description: 'true 表示这门课没有考试，去掉考试档案' },
      facts: FACTS,
      notes: { type: 'string', description: '新的正文，整段替换' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const current = await ctx.learnGoal.get(courseId)
      if (!current) return '还没有目标说明，先用 save_goal_draft 起草。'
      const conditions = args.book !== undefined || args.calculator !== undefined || args.formulaSheet !== undefined
        ? { ...current.goal.boundaries.defaultConditions, ...(args.book ? { book: args.book } : {}), ...(args.calculator === undefined ? {} : { calculator: args.calculator }), ...(args.formulaSheet === undefined ? {} : { formulaSheet: args.formulaSheet }) }
        : undefined
      const boundaries = { ...(args.exclude ? { exclude: args.exclude } : {}), ...(conditions ? { defaultConditions: conditions } : {}), ...(args.timeBudget === undefined ? {} : { timeBudget: args.timeBudget }) }
      const saved = await ctx.learnGoal.revise(courseId, args.version, {
        ...(args.purpose === undefined ? {} : { purpose: args.purpose }),
        ...(args.scenario === undefined ? {} : { scenario: args.scenario }),
        ...(args.canDo ? { canDo: args.canDo } : {}),
        ...(args.level === undefined ? {} : { level: args.level }),
        ...(args.verification === undefined ? {} : { verification: args.verification }),
        ...(Object.keys(boundaries).length ? { boundaries } : {}),
        ...(args.deadline === undefined ? {} : { deadline: args.deadline }),
        ...(args.removeExam ? { exam: null } : args.exam ? { exam: examOf(args.exam, current.goal.exam?.conditions) as never } : {}),
        ...(args.facts ? { facts: factMap(args.facts as FactArg[]) } : {}),
        ...(args.notes === undefined ? {} : { body: `# 目标说明\n\n${args.notes}\n` }),
      }, { actor: 'teacher', reason: args.reason })
      return report(saved, current.goal.status === 'confirmed' && saved.doc.goal.status === 'draft')
    },
  })), 'goal tools: revise_goal')
}
