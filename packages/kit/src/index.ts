// Host helpers shared by the units (bundled into each, like contracts; no shared state).
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferArgs, type ParameterSchemaSpec, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { LearningApiError, type SessionLink } from '@learning-agent/contracts'
import { collectText } from './collect-text.ts'
import { repairLatexDeep } from './latex-escapes.ts'

/**
 * An agent tool whose result is plain text for the model (contracts §7.2: `verb_noun` names).
 * Throwing returns the message to the model as a tool error, so it can correct itself. String
 * arguments get their LaTeX backslashes repaired first (see latex-escapes.ts).
 */
export function textTool<const S extends ParameterSchemaSpec>(spec: {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly parameters: S
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<string>
}) {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args, exec) => spec.execute(repairLatexDeep(args), exec),
    presentCall: args => ({ card: 'generic', title: spec.title, kind: 'other', rawInput: args as never }),
  })
}

/** The session link of the agent running a tool; tools only act inside a course session. */
export function linkOf(ctx: Context, exec: ToolRunContext): SessionLink & { readonly courseId: string } {
  const sessionId = exec.agent?.session.id
  const link = sessionId ? ctx.learnCore.sessions.get(sessionId) : undefined
  if (!link?.courseId) throw new Error('这个工具只能在课程会话里使用（会话没有登记到课程）。')
  return link as SessionLink & { readonly courseId: string }
}

let route: Promise<{ provider: string; model: string }> | undefined

/** The deployment's default model route (skeleton: every one-shot role uses it; PLAN §9.5 adds per-role models). */
function defaultRoute(ctx: Context): Promise<{ provider: string; model: string }> {
  route ??= ctx.sessionController.modelCatalog().then(catalog => {
    const record = catalog as unknown as Record<string, { provider: string; model: string } | undefined>
    const found = record.default ?? record.deploymentDefault
    if (!found) {
      route = undefined
      throw new Error('模型目录里没有默认模型')
    }
    return { provider: found.provider, model: found.model }
  })
  return route
}

/** One model call without a session (grading, summaries, textbook blocks). Returns the reply text. */
export async function complete(ctx: Context, options: {
  readonly system: string
  readonly prompt: string
  /** Shown in DSH's usage accounting, e.g. `learning-textbook`. */
  readonly purpose: string
  readonly maxTokens?: number
  readonly signal?: AbortSignal
}): Promise<string> {
  const { provider, model } = await defaultRoute(ctx)
  return collectText(ctx.llm.stream({
    provider,
    model,
    system: options.system,
    messages: [createUserMessage({ content: [{ type: 'text', text: options.prompt }], source: { kind: 'user' } })],
    maxTokens: options.maxTokens ?? 4000,
    purpose: options.purpose,
    signal: options.signal ?? new AbortController().signal,
  } as never))
}

/** Pull the first JSON object or array out of a model reply (fenced or bare). */
export function parseJsonReply(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  const start = body.search(/[[{]/)
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  if (start < 0 || end < start) throw new Error(`模型回复里没有 JSON：${text.slice(0, 200)}`)
  // LaTeX written without doubled backslashes: `\mathrm` is not a JSON escape (double it), while
  // `\rho`, `\frac`… parse as control characters (repaired afterwards).
  const json = body.slice(start, end + 1).replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})?/g, (escape, valid?: string) => (valid ? escape : '\\\\'))
  return repairLatexDeep(JSON.parse(json) as unknown)
}

/** Throw a LearningApiError when a referenced record is missing. */
export function must<T>(value: T | undefined, unit: string, what: string, id: string): T {
  if (value === undefined) throw new LearningApiError(`learning/${unit}/not-found`, `找不到${what}：${id}`, { id })
  return value
}

/** ISO instant now. */
export function now(): string {
  return new Date().toISOString()
}
