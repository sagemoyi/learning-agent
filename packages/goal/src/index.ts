// goal unit, host half. Provides `ctx.learnGoal` (contracts §5.1): the goal statement in `goal.md`
// (six elements, optional exam profile and the source of each fact in the frontmatter, prose below).
// Versions come from core's change log. The teacher drafts and revises with tools; the learner
// confirms on the progress page and may set the facts there (docs/goal/design.md).
import { Service, type Context } from '@deepseek-ai/cordis'
import {
  COURSE_LAYOUT,
  ExamProfile,
  GoalFact,
  GoalFrontmatter,
  LearningApiError,
  parseFrontmatter,
  TestConditions,
  withFrontmatter,
  type ChangeMeta,
  type FactSource,
  type GoalDoc,
  type GoalDraft,
  type GoalFactEdit,
  type GoalPatch,
  type GoalSaved,
  type GoalVersion,
  type GoalView,
  type Id,
  type LearnGoal,
  type TestKind,
} from '@learning-agent/contracts'
import { z } from 'zod'
import { checkGoal } from './checks.ts'
import { basisOf, choiceKey, compare, EDITABLE, FACT_LABEL, factValue, FOCUS_LABEL, hoursText, parseHours, pendingFacts, presentFacts } from './words.ts'

export const name = 'learning-goal'
export const inject = ['learnCore', 'learnLibrary']

type Goal = GoalFrontmatter
interface Snapshot { readonly goal: Goal; readonly body: string }

function parse(text: string): Snapshot {
  const { data, body } = parseFrontmatter(text)
  const goal = GoalFrontmatter.safeParse(data)
  if (!goal.success) {
    throw new LearningApiError('learning/goal/invalid-file', `goal.md 的头部字段不完整：${goal.error.issues.map(issue => issue.path.join('.')).join('、')}`, { issues: goal.error.issues })
  }
  return { goal: goal.data, body }
}

/** Key order differs between a parsed file and a fresh draft; compare the content. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item))
}

/** Zod's messages name paths; the teacher gets them in words. */
function invalid(error: z.ZodError): LearningApiError {
  return new LearningApiError('learning/goal/check', `目标说明的字段不对：${error.issues.map(issue => `${issue.path.join('.') || '整体'}：${issue.message}`).join('；')}`)
}

class LearnGoalService extends Service implements LearnGoal {
  constructor(ctx: Context) {
    super(ctx, 'learnGoal')
  }

  private changes(courseId: string) {
    return this.ctx.learnCore.changes.list({ target: { kind: 'file', courseId: courseId as Id<'course'>, path: COURSE_LAYOUT.goal }, limit: 200 })
  }

  async get(courseId: string): Promise<GoalDoc | undefined> {
    const file = await this.ctx.learnCore.files.read(courseId, COURSE_LAYOUT.goal)
    if (!file) return undefined
    const { goal, body } = parse(file.text)
    // Skeleton files have no version; their writes so far are the versions before this one.
    const versioned = 'version' in (parseFrontmatter(file.text).data ?? {})
    return { courseId, goal: versioned ? goal : { ...goal, version: Math.max(1, this.changes(courseId).length) }, body }
  }

  async view(courseId: string): Promise<GoalView | undefined> {
    const doc = await this.get(courseId)
    if (!doc) return undefined
    const { goal } = doc
    const history = this.history(courseId)
    // What the learner last confirmed or edited is the baseline the page compares against.
    const seen = this.changes(courseId).find(change => change.actor === 'user' && change.after !== null)
    const baseline = seen?.after ? parse(seen.after) : undefined
    const { changes, impacts } = baseline ? compare(baseline, doc) : { changes: [], impacts: [] }
    const facts = presentFacts(goal).map(fact => {
      const source = goal.facts[fact]
      const chunk = source?.chunkId ? this.ctx.learnLibrary.chunk(source.chunkId) : undefined
      return { fact, label: FACT_LABEL[fact], basis: basisOf(goal, fact), editable: EDITABLE.has(fact), ...(chunk ? { citation: chunk.citation, chunkId: chunk.id } : {}) }
    })
    const pastPapers = (goal.exam?.pastPaperSourceIds ?? []).map(id => ({ id, title: this.ctx.learnLibrary.source(id)?.title ?? '已移除的资料' }))
    return { doc, facts, changes, impacts, history, pastPapers }
  }

  private history(courseId: string): GoalVersion[] {
    const oldestFirst = this.changes(courseId).filter(change => change.after !== null).reverse()
    let previous = 0
    return oldestFirst.map(change => {
      const { data } = parseFrontmatter(change.after!)
      const stated = typeof data?.version === 'number' ? data.version : undefined
      previous = stated ?? previous + 1
      return { version: previous, at: change.at, actor: change.actor, status: data?.status === 'confirmed' ? 'confirmed' : 'draft', reason: change.reason } satisfies GoalVersion
    }).reverse()
  }

  /** Official facts must point at a passage of this course's sources; the others need no passage. */
  private sources(courseId: string, given: Partial<Record<GoalFact, FactSource>> | undefined): Partial<Record<GoalFact, FactSource>> {
    const attached = new Set(this.ctx.learnCore.courses.get(courseId) ? this.ctx.learnLibrary.courseSources(courseId).map(entry => entry.sourceId) : [])
    const problems: string[] = []
    const out: Partial<Record<GoalFact, FactSource>> = {}
    for (const [fact, source] of Object.entries(given ?? {}) as [GoalFact, FactSource][]) {
      if (!GoalFact.safeParse(fact).success) { problems.push(`没有"${fact}"这项事实，可用的有：${GoalFact.options.join('、')}`); continue }
      if (source.basis !== 'official') { out[fact] = { basis: source.basis }; continue }
      const chunk = source.chunkId ? this.ctx.learnLibrary.chunk(source.chunkId) : undefined
      if (!chunk || !attached.has(chunk.sourceId)) problems.push(`「${FACT_LABEL[fact]}」标为官方，但${source.chunkId ? '这个片段不在本课的资料里' : '没有附资料片段'}。附上 read_section 或 search_library 给出的片段 ID，或者改标 learner、assumed`)
      else out[fact] = { basis: 'official', chunkId: chunk.id }
    }
    if (problems.length) throw new LearningApiError('learning/goal/check', `目标说明还不能保存：\n- ${problems.join('\n- ')}`)
    return out
  }

  /** Bases for the facts of `next`: given ones win; an unchanged value keeps its basis; a new or changed value without one is the teacher's guess. */
  private facts(before: Goal | undefined, next: Goal, given: Partial<Record<GoalFact, FactSource>>): Goal['facts'] {
    const out: Goal['facts'] = {}
    for (const fact of presentFacts(next)) {
      const source = given[fact] ?? (before && factValue(before, fact) === factValue(next, fact) ? before.facts[fact] : undefined)
      if (source && source.basis !== 'assumed') out[fact] = source
    }
    return out
  }

  /** New "can do" items take keys never used in any version, so a key cited by a stage design always means one item. */
  private withKeys(courseId: string, items: GoalDraft['canDo']): { key?: string; text: string; evidence?: string }[] {
    const objects = items.map(item => (typeof item === 'string' ? { text: item } : { ...item }))
    const number = (key: string | undefined) => Number(/^c(\d+)$/.exec(key ?? '')?.[1] ?? 0)
    const past = this.changes(courseId).flatMap(change => {
      if (!change.after) return []
      const goal = GoalFrontmatter.safeParse(parseFrontmatter(change.after).data)
      return goal.success ? goal.data.canDo.map(item => number(item.key)) : []
    })
    let next = Math.max(0, ...past, ...objects.map(item => number(item.key))) + 1
    return objects.map(item => (item.key ? item : { ...item, key: `c${next++}` }))
  }

  /** Validate, keep the status rule and write one version. Unchanged content writes nothing. */
  private async commit(courseId: string, before: GoalDoc | undefined, draft: { canDo: GoalDraft['canDo'] } & Record<string, unknown>, body: string, meta: ChangeMeta, given?: Partial<Record<GoalFact, FactSource>>): Promise<GoalSaved> {
    const parsed = GoalFrontmatter.safeParse({ ...draft, canDo: this.withKeys(courseId, draft.canDo) })
    if (!parsed.success) throw invalid(parsed.error)
    let goal = parsed.data
    if (!goal.boundaries.hoursPerWeek) {
      const hours = parseHours(goal.boundaries.timeBudget)
      if (hours) goal = { ...goal, boundaries: { ...goal.boundaries, hoursPerWeek: hours } }
    }
    goal = { ...goal, facts: this.facts(before?.goal, goal, given ?? {}) }
    const warnings: string[] = []
    const absent = (Object.keys(given ?? {}) as GoalFact[]).filter(fact => !presentFacts(goal).includes(fact))
    if (absent.length) warnings.push(`facts 里的${absent.map(fact => `「${FACT_LABEL[fact]}」`).join('')}在目标说明里没有值，来源没有记下；先写入它的值。`)
    if (meta.actor === 'teacher') {
      const check = checkGoal(goal, body)
      if (check.errors.length) throw new LearningApiError('learning/goal/check', `目标说明还不能保存：\n- ${check.errors.join('\n- ')}`)
      warnings.push(...check.warnings)
    }
    const reopens = before?.goal.status === 'confirmed' && choiceKey(before.goal, before.body) !== choiceKey(goal, body)
    const status = before && !reopens ? before.goal.status : 'draft'
    if (before && canonical({ ...before.goal, version: 0 }) === canonical({ ...goal, status, version: 0 }) && before.body.trim() === body.trim()) {
      return { doc: before, warnings: [`内容和第 ${before.goal.version} 版相同，没有修改。`, ...warnings] }
    }
    const next = GoalFrontmatter.parse({ ...goal, status, version: (before?.goal.version ?? 0) + 1 })
    await this.ctx.learnCore.files.write(courseId, COURSE_LAYOUT.goal, withFrontmatter(next as Record<string, unknown>, body), { ...meta, size: reopens ? 'major' : meta.size ?? 'minor' })
    return { doc: { courseId, goal: next, body }, warnings }
  }

  async saveDraft(courseId: string, draft: GoalDraft, body: string, meta: ChangeMeta): Promise<GoalSaved> {
    const before = await this.get(courseId).catch(() => undefined)
    const given = this.sources(courseId, draft.facts)
    const { facts: _facts, ...rest } = draft
    // Re-sent items with the same wording keep their keys, so stage designs that cite them still do.
    const keys = new Map(before?.goal.canDo.map(item => [item.text, item.key]))
    const canDo = rest.canDo.map(item => (typeof item === 'string' ? { text: item } : item)).map(item => (item.key || !keys.has(item.text) ? item : { ...item, key: keys.get(item.text) }))
    return this.commit(courseId, before, { ...rest, canDo, status: 'draft' }, body, meta, given)
  }

  async revise(courseId: string, version: number, patch: GoalPatch, meta: ChangeMeta): Promise<GoalSaved> {
    const before = await this.get(courseId)
    if (!before) throw new LearningApiError('learning/goal/missing', '还没有目标说明，先用 save_goal_draft 起草')
    if (before.goal.version !== version) throw new LearningApiError('learning/goal/stale', `目标说明已经是第 ${before.goal.version} 版，请按简报里的最新内容修订`)
    const given = this.sources(courseId, patch.facts)
    const { goal } = before
    const canDo = patch.canDo?.map(item => (typeof item === 'string' ? { text: item } : item))
    const unknown = canDo?.filter(item => item.key && !goal.canDo.some(old => old.key === item.key)).map(item => item.key)
    if (unknown?.length) throw new LearningApiError('learning/goal/check', `没有这些"学成后能做"条目：${unknown.join('、')}。改已有条目要沿用它的键，新条目不写键`)
    let exam: unknown = goal.exam
    if (patch.exam === null) exam = undefined
    else if (patch.exam) {
      exam = goal.exam ? { ...goal.exam, ...patch.exam } : patch.exam
      const checked = ExamProfile.safeParse(exam)
      if (!checked.success) throw new LearningApiError('learning/goal/check', goal.exam ? `考试档案的字段不对：${checked.error.issues.map(issue => issue.path.join('.')).join('、')}` : '还没有考试档案；新建时要写范围（scope）、考试条件（book、calculator、formulaSheet）和侧重（focus）')
    }
    const draft = {
      ...goal,
      ...(patch.purpose === undefined ? {} : { purpose: patch.purpose }),
      ...(patch.scenario === undefined ? {} : { scenario: patch.scenario }),
      ...(canDo ? { canDo } : {}),
      ...(patch.level === undefined ? {} : { level: patch.level }),
      ...(patch.verification === undefined ? {} : { verification: patch.verification }),
      boundaries: { ...goal.boundaries, ...patch.boundaries, ...(patch.boundaries?.timeBudget !== undefined && !patch.boundaries.hoursPerWeek ? { hoursPerWeek: undefined } : {}) },
      deadline: patch.deadline === undefined ? goal.deadline : patch.deadline || undefined,
      exam,
    }
    return this.commit(courseId, before, draft, patch.body ?? before.body, meta, given)
  }

  async setFacts(courseId: string, version: number, edit: GoalFactEdit): Promise<GoalDoc> {
    const before = await this.get(courseId)
    if (!before) throw new LearningApiError('learning/goal/missing', '还没有目标说明，先和主老师商量出一份草稿')
    if (before.goal.version !== version) throw new LearningApiError('learning/goal/stale', '目标说明刚有了新版本，页面已经刷新，请再改一次')
    const { goal } = before
    if ((edit.examDate !== undefined || edit.examConditions) && !goal.exam) throw new LearningApiError('learning/goal/no-exam', '这个目标还没有考试档案，请告诉主老师考试的情况')
    const date = (value: string | null | undefined, label: string) => {
      if (value && !z.iso.date().safeParse(value).success) throw new LearningApiError('learning/goal/date', `${label}要写成 2027-01-10 这样的日期`)
      return value || undefined
    }
    const hours = edit.hours === undefined ? undefined : edit.hours
    if (hours && !(hours.min > 0 && hours.max >= hours.min)) throw new LearningApiError('learning/goal/hours', '每周投入要写成"最少几小时到最多几小时"，最少不能大于最多')
    const next: Goal = {
      ...goal,
      boundaries: {
        ...goal.boundaries,
        ...(edit.conditions ? { defaultConditions: TestConditions.parse(edit.conditions) } : {}),
        ...(edit.hours === undefined ? {} : { hoursPerWeek: hours ?? undefined, timeBudget: undefined }),
      },
      deadline: edit.deadline === undefined ? goal.deadline : date(edit.deadline, '最后期限'),
      ...(goal.exam ? { exam: { ...goal.exam, ...(edit.examDate === undefined ? {} : { date: date(edit.examDate, '考试日期') }), ...(edit.examConditions ? { conditions: TestConditions.parse(edit.examConditions) } : {}) } } : {}),
    }
    const edited = presentFacts(next).filter(fact => factValue(goal, fact) !== factValue(next, fact))
    const confirmed = (edit.confirm ?? []).filter(fact => presentFacts(next).includes(fact) && basisOf(next, fact) === 'assumed' && !edited.includes(fact))
    const removed = presentFacts(goal).filter(fact => !presentFacts(next).includes(fact))
    if (!edited.length && !confirmed.length && !removed.length) return before
    const facts: Goal['facts'] = { ...next.facts }
    for (const fact of [...edited, ...confirmed]) facts[fact] = { basis: 'learner' }
    for (const fact of removed) delete facts[fact]
    const written = GoalFrontmatter.parse({ ...next, facts, version: goal.version + 1 })
    // The version list shows the learner's own edits next to "你", so the reason has no subject.
    const parts = [
      ...edited.map(fact => `${FACT_LABEL[fact]}改为 ${factValue(written, fact)}`),
      ...removed.map(fact => `去掉了${FACT_LABEL[fact]}`),
      ...(confirmed.length ? [`确认了${confirmed.map(fact => FACT_LABEL[fact]).join('、')}`] : []),
    ].join('；')
    await this.ctx.learnCore.files.write(courseId, COURSE_LAYOUT.goal, withFrontmatter(written as Record<string, unknown>, before.body), { actor: 'user', reason: parts, size: 'minor' })
    this.ctx.emit('learning/handoff', { courseId, unit: 'goal', text: `学习者在目标说明里：${parts}。` })
    return { courseId, goal: written, body: before.body }
  }

  async acknowledge(courseId: string, version: number): Promise<GoalDoc> {
    const before = await this.get(courseId)
    if (!before) throw new LearningApiError('learning/goal/missing', '还没有目标说明')
    if (before.goal.version !== version) throw new LearningApiError('learning/goal/stale', '目标说明刚有了新版本，页面已经刷新，请再看一次')
    const goal = GoalFrontmatter.parse({ ...before.goal, version: version + 1 })
    await this.ctx.learnCore.files.write(courseId, COURSE_LAYOUT.goal, withFrontmatter(goal as Record<string, unknown>, before.body), { actor: 'user', reason: '看过老师的修改', size: 'minor' })
    return { courseId, goal, body: before.body }
  }

  async confirm(courseId: string): Promise<GoalDoc> {
    const current = await this.get(courseId)
    if (!current) throw new LearningApiError('learning/goal/missing', '还没有目标说明，先和主老师商量出一份草稿')
    if (current.goal.status === 'confirmed') return current
    const goal = GoalFrontmatter.parse({ ...current.goal, status: 'confirmed', version: current.goal.version + 1 })
    await this.ctx.learnCore.files.write(courseId, COURSE_LAYOUT.goal, withFrontmatter(goal as Record<string, unknown>, current.body), { actor: 'user', reason: '确认目标说明', size: 'major' })
    this.ctx.emit('learning/goal-confirmed', { courseId })
    const pending = pendingFacts(goal)
    this.ctx.emit('learning/handoff', { courseId, unit: 'goal', text: `学习者确认了目标说明。${pending.length ? `还待确认的事实：${pending.map(fact => FACT_LABEL[fact]).join('、')}。` : ''}` })
    return { courseId, goal, body: current.body }
  }

  async conditions(courseId: string, kind: TestKind): Promise<TestConditions | undefined> {
    const doc = await this.get(courseId).catch(() => undefined)
    if (!doc) return undefined
    const exam = doc.goal.exam
    if (!exam || (kind !== 'stage' && kind !== 'mock')) return doc.goal.boundaries.defaultConditions
    const { timeLimit, ...rest } = exam.conditions
    return kind === 'mock' && timeLimit ? { ...rest, timeLimit } : rest
  }
}

const BASIS_NOTE = { official: '', learner: '', assumed: '（老师推测，待学习者确认）' } as const

/** The goal for the teacher's brief: choices, facts with their basis, the exam, and what still waits for the learner. */
function brief(doc: GoalDoc): string {
  const { goal } = doc
  const fact = (key: GoalFact) => `${factValue(goal, key)}${BASIS_NOTE[basisOf(goal, key)]}`
  const exam = goal.exam
  const pending = pendingFacts(goal)
  return [
    `状态：${goal.status === 'confirmed' ? '已确认' : '草稿，等学习者确认'}（第 ${goal.version} 版）`,
    `目的：${goal.purpose}`,
    `场景：${goal.scenario}`,
    `学成后能做：\n${goal.canDo.map(item => `- ${item.key} ${item.text}${item.evidence ? `（验证：${item.evidence}）` : ''}`).join('\n')}`,
    `程度：${goal.level}`,
    `验证方式：${goal.verification}`,
    `不学：${goal.boundaries.exclude.join('、') || '（未写）'}`,
    `默认测试条件：${fact('conditions')}`,
    hoursText(goal.boundaries) ? `每周投入：${fact('hours')}` : '',
    goal.deadline ? `最后期限：${fact('deadline')}` : '',
    exam ? [
      '考试档案：',
      `- 日期：${exam.date ? fact('exam.date') : '（未知）'}`,
      `- 范围：${fact('exam.scope')}`,
      `- 题型和分值：${exam.format.length ? fact('exam.format') : '（未知）'}`,
      exam.grading ? `- 成绩构成：${fact('exam.grading')}` : '',
      `- 考试条件：${fact('exam.conditions')}；阶段测试和模拟考默认按它`,
      `- 往年题：${exam.pastPaperSourceIds.length} 份`,
      `- 侧重：${FOCUS_LABEL[exam.focus]}`,
    ].filter(Boolean).join('\n') : '',
    pending.length ? `待确认的事实：${pending.map(key => FACT_LABEL[key]).join('、')}。用到之前，提醒学习者在课程进度页确认或修改。` : '',
  ].filter(Boolean).join('\n')
}

export function apply(ctx: Context): void {
  const goals = new LearnGoalService(ctx)
  const courseId = z.object({ courseId: z.string() })
  const versioned = courseId.extend({ version: z.number().int().positive() })

  ctx.effect(() => ctx.learnCore.api.endpoint({ unit: 'goal', method: 'get', input: courseId, handle: async input => (await goals.get(input.courseId)) ?? null }), 'goal: get')
  ctx.effect(() => ctx.learnCore.api.endpoint({ unit: 'goal', method: 'view', input: courseId, handle: async input => (await goals.view(input.courseId)) ?? null }), 'goal: view')
  ctx.effect(() => ctx.learnCore.api.endpoint({ unit: 'goal', method: 'confirm', input: courseId, handle: input => goals.confirm(input.courseId) }), 'goal: confirm')
  ctx.effect(() => ctx.learnCore.api.endpoint({ unit: 'goal', method: 'acknowledge', input: versioned, handle: input => goals.acknowledge(input.courseId, input.version) }), 'goal: acknowledge')
  ctx.effect(() => ctx.learnCore.api.endpoint({
    unit: 'goal',
    method: 'setFacts',
    input: versioned.extend({
      conditions: TestConditions.optional(),
      hours: z.object({ min: z.number(), max: z.number() }).nullable().optional(),
      deadline: z.string().nullable().optional(),
      examDate: z.string().nullable().optional(),
      examConditions: TestConditions.optional(),
      confirm: z.array(GoalFact).optional(),
    }),
    handle: ({ courseId: id, version, ...edit }) => goals.setFacts(id, version, edit),
  }), 'goal: setFacts')

  ctx.on('learning/course-brief', async (request, next) => {
    const sections = await next()
    const doc = await goals.get(request.courseId).catch(() => undefined)
    return [...sections, { unit: 'goal', title: '目标说明', text: doc ? brief(doc) : '还没有目标说明。' }]
  })
}
