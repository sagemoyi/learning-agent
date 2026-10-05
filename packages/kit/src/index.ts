// Host helpers shared by the units (bundled into each, like contracts; no shared state).
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-credentials'
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

/** A DSH model route: provider route id and model id, as a role's settings field stores it. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** A role setting (`provider/model`) as a route; empty or malformed follows the default model. */
export function routeOf(setting: string | ModelRoute | undefined): ModelRoute | undefined {
  if (typeof setting !== 'string') return setting
  const slash = setting.indexOf('/')
  if (slash <= 0 || slash === setting.length - 1) return undefined
  return { provider: setting.slice(0, slash), model: setting.slice(slash + 1) }
}

/**
 * The deployment's default model (DSH `agent-default-model`), read on every call: a change on the
 * settings page applies to the next request. Without that service (the test harness) the session
 * controller's catalog default stands in.
 */
export async function defaultModel(ctx: Context): Promise<ModelRoute> {
  const service = ctx.get('agentDefaultModel')
  if (service) return service.currentSelection()
  const catalog = await ctx.sessionController.modelCatalog() as unknown as Record<string, ModelRoute | undefined>
  const found = catalog.default ?? catalog.deploymentDefault
  if (!found) throw new Error('模型目录里没有默认模型')
  return { provider: found.provider, model: found.model }
}

/**
 * A secret by name from DSH's credential store, which looks in the launch environment, the keys saved
 * on the settings page, then `.env` files. Read at each use, so a key saved on the settings page applies
 * to the next request. Without the store (the test harness) the process environment answers.
 */
export async function secret(ctx: Context, name: string): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (!credentials) return process.env[name] || undefined
  return (await credentials.resolve(name as never))?.value
}

/**
 * Point a session at a role's model, or at the default model when the role follows it. Sessions keep
 * the model they were created with until told otherwise, so units call this when a role setting or
 * the default changes.
 */
export async function selectSessionModel(ctx: Context, sessionId: string, role: string | ModelRoute | undefined): Promise<void> {
  const route = routeOf(role) ?? await defaultModel(ctx)
  await ctx.sessionController.selectModel({
    sessionId: sessionId as never,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
  })
}

/** One model call without a session (grading, summaries, textbook blocks). Returns the reply text. */
export async function complete(ctx: Context, options: {
  readonly system: string
  readonly prompt: string
  /** Shown in DSH's usage accounting, e.g. `learning-textbook`. */
  readonly purpose: string
  /** The calling role's model setting (`provider/model`); absent follows the default model. */
  readonly model?: string | ModelRoute
  readonly maxTokens?: number
  readonly signal?: AbortSignal
}): Promise<string> {
  const route = routeOf(options.model) ?? await defaultModel(ctx)
  try {
    return await collectText(ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
      system: options.system,
      messages: [createUserMessage({ content: [{ type: 'text', text: options.prompt }], source: { kind: 'user' } })],
      maxTokens: options.maxTokens ?? 4000,
      purpose: options.purpose,
      signal: options.signal ?? new AbortController().signal,
    } as never))
  } catch (error) {
    // Truncated or empty replies are the model's answer; anything else may be the route itself.
    if (LearningApiError.is(error) && error.code !== 'learning/model/failed') throw error
    const reason = LearningApiError.is(error) ? error.message : `模型调用失败：${error instanceof Error ? error.message : String(error)}`
    throw new LearningApiError('learning/model/failed', `${reason}（模型 ${route.model}，可以在 设置 › 模型 里更换）`, { provider: route.provider, model: route.model })
  }
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
