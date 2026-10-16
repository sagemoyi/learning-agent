// A fake model for textbook generation (docs/textbook/design.md, 讲解与原文): it reads the prompts the way
// the real one would — the plan's numbered outline, the writer's material list, the check's paragraphs —
// and answers in the formats the program asks for. Tests override one call kind at a time.
import type { ModelCall } from './harness.ts'

export const isPlan = (call: ModelCall) => call.purpose === 'learning-textbook-plan'
export const isWriter = (call: ModelCall) => call.purpose === 'learning-textbook' && call.system.startsWith('你为一位具体的学习者写')
export const isQuestions = (call: ModelCall) => call.purpose === 'learning-textbook' && call.system.startsWith('你为一节教材写')
export const isReviser = (call: ModelCall) => call.purpose === 'learning-textbook' && call.system.startsWith('你修改一节教材')
export const isCheck = (call: ModelCall) => call.purpose === 'learning-textbook-check'

export const QUESTIONS = '### 读完就答\n\n1. 表压强和绝对压强差在哪里？\n2. 等压面要满足哪些条件？'

/** The plan prompt's outline: `[n] kind · text`. */
export function outline(call: ModelCall): { readonly n: number; readonly kind: string; readonly text: string }[] {
  const part = call.prompt.split('# 本节资料提纲').at(-1)!.split('\n# ')[0]!
  return [...part.matchAll(/^\[(\d+)\] (\S+) · (.*)$/gm)].map(match => ({ n: Number(match[1]), kind: match[2]!, text: match[3]! }))
}

/** A plan with one point per subsection heading, and the needs given. */
export function planBySubsection(call: ModelCall, needs: readonly { text: string; point: number; covered: boolean }[] = []): string {
  const lines = outline(call)
  const starts = lines.filter(line => line.kind === '小标题' && /^\d+\.\d+\.\d+/.test(line.text))
  const points = starts.map((line, index) => ({
    title: line.text.replace(/^[\d.]+\s*/, '').replace(/（合成）$/, ''),
    focus: `讲清${line.text}`,
    from: line.n,
    to: (starts[index + 1]?.n ?? lines.length + 1) - 1,
  }))
  return JSON.stringify({ points, needs })
}

/** The chunks a writer prompt lists, in order: its own material, then the supplementary one. */
export function materialOf(call: ModelCall): { readonly id: string; readonly kind: string; readonly text: string }[] {
  return [...call.prompt.matchAll(/^\[(ck_[0-9A-Z]{26})\] .+? · (\S+) · .*\n(.*)$/gm)].map(match => ({ id: match[1]!, kind: match[2]!, text: match[3]! }))
}

/** The title the writer is asked for. */
export function titleOf(call: ModelCall): string {
  return /# 这次写：(.+)/.exec(call.prompt)![1]!
}

/**
 * A writer reply: the point's heading, a paragraph in its own words citing the first text chunk, and the first
 * formula embedded; a lesson of one point also writes its recall questions.
 */
export function writePoint(call: ModelCall, words = '这一点用自己的话讲'): string {
  const material = materialOf(call)
  const text = material.find(chunk => chunk.kind === '正文') ?? material[0]!
  const formula = material.find(chunk => chunk.kind === '公式')
  const single = call.prompt.includes('这一节只有这一个要点')
  return [
    call.prompt.includes('不要写标题') || single ? '' : `### ${titleOf(call)}`,
    `${words}。[合成资料 p.1](cite:${text.id})`,
    formula ? `![[${formula.id}]]` : '',
    single ? QUESTIONS : '',
  ].filter(Boolean).join('\n\n')
}

/** The check prompt's paragraphs: `[P1] text`. */
export function paragraphsOf(call: ModelCall): { readonly id: string; readonly text: string }[] {
  const part = call.prompt.split('# 要核对的讲解段落').at(-1)!
  return [...part.matchAll(/^\[(P\d+)\] (.*)$/gm)].map(match => ({ id: match[1]!, text: match[2]! }))
}

/** Every paragraph ok, coming from the first chunk of the check's material. */
export function checkOk(call: ModelCall, verdict: (text: string) => { verdict: string; note?: string } = () => ({ verdict: 'ok' })): string {
  const first = /^\[(ck_[0-9A-Z]{26})\]/m.exec(call.prompt)?.[1]
  return JSON.stringify({ results: paragraphsOf(call).map(paragraph => ({ id: paragraph.id, sources: first ? [first] : [], note: '', ...verdict(paragraph.text) })) })
}

/** The usual fake: plan by subsection, write each point, ask the questions, check everything as fine. */
export function textbookReply(call: ModelCall): string | undefined {
  if (isPlan(call)) return planBySubsection(call)
  if (isWriter(call)) return writePoint(call)
  if (isQuestions(call)) return QUESTIONS
  if (isCheck(call)) return checkOk(call)
  return undefined
}
