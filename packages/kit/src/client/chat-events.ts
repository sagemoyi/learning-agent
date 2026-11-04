// What the chat shows, worked out from a DSH session's events (kept apart so it can be tested without React or DSH):
// injected context folded, progress notices as notices, a run of tool calls as one line of steps, a successful call of
// a card tool as its card, and whether a turn is running or ended in an error.
import { repairLatexDeep } from '../latex-escapes.ts'

export interface SessionEvent {
  readonly type: string
  readonly seq?: number
  readonly data?: Record<string, unknown>
}

export type Item =
  | { readonly key: string; readonly role: 'user' | 'assistant'; readonly text: string }
  | { readonly key: string; readonly role: 'context'; readonly title: string; readonly text: string }
  | { readonly key: string; readonly role: 'notice'; readonly lines: readonly string[] }
  | { readonly key: string; readonly role: 'steps'; readonly steps: readonly string[] }
  | { readonly key: string; readonly role: 'card'; readonly name: string; readonly args: Readonly<Record<string, unknown>> }

/** Concatenate the text parts of a message-like value. */
function textOf(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(part => ((part as { type?: string })?.type === 'text' ? String((part as { text?: unknown }).text ?? '') : '')).join('')
  const record = value as Record<string, unknown>
  if (record.content) return textOf(record.content)
  if (record.message) return textOf(record.message)
  return ''
}

/** Source of the teacher's progress notices; only their "- " lines are for the learner to read. */
const NOTICE_SOURCE = 'learning-handoff'

/** Context the system adds to a conversation, shown folded; other sources than the learner show as 系统信息. */
const CONTEXT_TITLES: Record<string, string> = {
  'learning-course-brief': '课程现状简报',
  'learning-next-step': '下一步更新',
  'learning-side-chat-context': '本次提问的上下文',
  'learning-side-chat-policy': '测试进行中',
}

const TOOL_TITLES: Record<string, string> = {
  search_library: '查资料库', read_section: '读资料原文', add_knowledge_nodes: '添加知识节点', save_goal_draft: '保存目标说明草稿', revise_goal: '修订目标说明',
  add_problems: '加入题库', start_test: '发布测试', get_test_result: '查看测试结果', save_roadmap: '保存课程路线', save_stage_review: '保存阶段复盘', save_course_report: '保存课程报告',
  save_stage_design: '保存阶段设计书', publish_task: '发布任务', read_lesson_textbook: '读讲义', regenerate_textbook: '重新生成讲义', revise_textbook: '修改讲义段落', decide_proposal: '处理修改提案',
  write_lesson_summary: '写课时小结', web_search: '联网搜索', offer_goal_options: '给出候选终点', mark_exam_scope: '标记考试范围', settle_same_name: '区分同名节点',
  import_exercises: '导入习题', calculate: '计算', mark_homework: '记下作业做过的题', review_problem: '核对题目', regrade: '复核判分', withdraw_test: '撤回测试',
}

/** Tools whose successful call shows a card (drawn by the unit through the `learning.chat-card` slot). */
const CARD_TOOLS: ReadonlySet<string> = new Set(['offer_goal_options'])

/** Tool arguments as the model sent them, with LaTeX backslashes repaired as the tool itself saw them. */
function argsOf(raw: unknown): Readonly<Record<string, unknown>> {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw
    return value && typeof value === 'object' ? repairLatexDeep(value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The list the chat draws from the events it holds, oldest first. */
export function itemsOf(events: readonly SessionEvent[]): Item[] {
  const items: Item[] = []
  // Card tool calls wait for their result: a refused call shows no card.
  const cards = new Map<string, { name: string; args: Readonly<Record<string, unknown>> }>()
  for (const event of events) {
    const data = event.data ?? {}
    const key = String(event.seq)
    if (event.type === 'user/message') {
      const source = (data.source as { kind?: string } | undefined)?.kind
      const text = textOf(data)
      if (source === NOTICE_SOURCE) items.push({ key, role: 'notice', lines: text.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2)) })
      else if (!source || source === 'user') items.push({ key, role: 'user', text })
      else items.push({ key, role: 'context', title: CONTEXT_TITLES[source] ?? '系统信息', text })
    } else if (event.type === 'assistant/message') {
      const text = textOf(data)
      if (text) items.push({ key, role: 'assistant', text })
    } else if (event.type === 'tool/result') {
      const message = data.message as { toolCallId?: string; isError?: boolean } | undefined
      const card = message?.toolCallId ? cards.get(message.toolCallId) : undefined
      if (card && !message!.isError) items.push({ key, role: 'card', ...card })
    } else if (event.type === 'tool/call') {
      const name = String(data.name ?? '')
      if (CARD_TOOLS.has(name) && data.callId) cards.set(String(data.callId), { name, args: argsOf(data.arguments) })
      const step = TOOL_TITLES[name] ?? name
      const last = items.at(-1)
      if (last?.role === 'steps') items[items.length - 1] = { ...last, steps: [...last.steps, step] }
      else items.push({ key, role: 'steps', steps: [step] })
    }
  }
  return items
}

/** Whether the latest turn is still under way. */
export function runningOf(events: readonly SessionEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === 'turn/end') return false
    if (events[i]!.type === 'turn/start') return true
  }
  return false
}

/** Why the latest turn did not finish, when it ended in an error; a turn started since clears it. */
export function turnErrorOf(events: readonly SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'turn/start') return undefined
    if (event.type !== 'turn/end') continue
    const reason = event.data?.reason as { kind?: string; error?: { message?: string; code?: string } } | undefined
    return reason?.kind === 'error' ? `这次回复没有完成：${reason.error?.message ?? reason.error?.code ?? '模型调用失败'}。可以重新发送消息再试。` : undefined
  }
  return undefined
}

/** The readable text of one live chunk: thinking is left out. */
export function chunkText(chunk: unknown): string {
  const record = (chunk ?? {}) as { type?: unknown; text?: unknown; delta?: unknown }
  if (String(record.type ?? '').includes('reason')) return ''
  return typeof record.text === 'string' ? record.text : typeof record.delta === 'string' ? record.delta : ''
}

/** What a reply still being written has said so far, from DSH's compact form of its stream at a reconnect. */
export function attemptText(stream: readonly unknown[]): string {
  return stream.flatMap(record => {
    const part = (record ?? {}) as { type?: unknown; texts?: unknown; chunk?: unknown }
    if (part.type === 'text-chunks' && Array.isArray(part.texts)) return part.texts.filter((text): text is string => typeof text === 'string')
    return part.type === 'chunk' ? [chunkText(part.chunk)] : []
  }).join('')
}
