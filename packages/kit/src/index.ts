// Host helpers shared by the units (bundled into each, like contracts; no shared state).
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-attachment'
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

/**
 * Run at the start of a tool that a side chat must not freely use (contracts §5.1, `learnSidechat.checkTool`): throws the
 * reason, which the model gets back as the tool's error. Sessions that are not side chats pass; so does a deployment
 * without the side-chat unit.
 */
export function allowTool(ctx: Context, exec: ToolRunContext, tool: string): void {
  const sessionId = exec.agent?.session.id
  if (!sessionId) return
  const verdict = ctx.get('learnSidechat')?.checkTool(sessionId, tool)
  if (verdict && !verdict.allowed) throw new Error(verdict.reason ?? '侧边会话现在不能用这个工具。')
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

/** One logged message of a DSH session: the learner's own words, the assistant's reply, or context a plugin added. */
export interface SessionLine {
  readonly seq: number
  /** Unix epoch milliseconds when it was logged. */
  readonly at: number
  readonly who: 'learner' | 'assistant' | 'context'
  /** Who produced a context message (its source kind), e.g. `learning-handoff`. */
  readonly source?: string
  readonly text: string
}

/** A session's messages in log order, read without activating its agent. */
export async function sessionLines(ctx: Context, sessionId: string, signal?: AbortSignal): Promise<SessionLine[]> {
  const inspection = await ctx.sessionController.inspect(sessionId as never, signal) as unknown as { events?: readonly { type: string; seq?: number; time?: number; data: unknown }[] } | undefined
  return (inspection?.events ?? []).flatMap((event, index): SessionLine[] => {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') return []
    const line = { seq: event.seq ?? index, at: event.time ?? Date.now(), text: messageText(event.data) }
    if (event.type === 'assistant/message') return [{ ...line, who: 'assistant' }]
    const source = (event.data as { source?: { kind?: string } }).source?.kind
    return [source === 'user' ? { ...line, who: 'learner' } : { ...line, who: 'context', ...(source ? { source } : {}) }]
  })
}

/** The text parts of a message-like value, concatenated. */
export function messageText(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(part => ((part as { type?: string })?.type === 'text' ? String((part as { text?: unknown }).text ?? '') : '')).join('')
  const record = value as Record<string, unknown>
  if (record.content) return messageText(record.content)
  if (record.message) return messageText(record.message)
  return ''
}

/** A picture sent with a one-shot prompt, e.g. a handwriting photo. */
export interface PromptImage {
  readonly data: Uint8Array
  readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  readonly name?: string
}

/**
 * Pictures as the user message's image blocks: stored by DSH's attachment service, which the model route
 * reads them from. Always the user message: the relay turns images in tool results into text (V0). A
 * model that declares it takes no images is refused here rather than answering from a placeholder.
 */
async function imageBlocks(ctx: Context, route: ModelRoute, images: readonly PromptImage[], info: ModelInfo | undefined) {
  const store = ctx.get('attachments')
  if (!store) throw new LearningApiError('learning/model/no-images', '这里没有图片存储服务，不能把图片发给模型')
  if (info?.inputModalities && !info.inputModalities.includes('image')) {
    throw new LearningApiError('learning/model/no-vision', `模型 ${route.model} 不能看图（可以在 设置 › 模型 里换一个能看图的模型）`, { provider: route.provider, model: route.model })
  }
  const refs = await store.saveImages(images.map(image => ({ data: image.data, mediaType: image.mediaType, ...(image.name ? { name: image.name } : {}) })))
  return refs.map(attachment => ({ type: 'image' as const, attachment }))
}

/**
 * Failures worth another try: DSH's default retryable classes. One-shot calls go around the agent loop, so
 * DSH's own retry never sees them; a relay that drops a stream now and then would otherwise fail a lesson.
 */
const RETRYABLE = new Set(['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
const RETRY_DELAYS_MS = [2000, 6000]

function retryable(error: unknown): boolean {
  const code = LearningApiError.is(error) ? error.details.failureCode : (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && RETRYABLE.has(code)
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve() }, ms)
    const stop = () => { clearTimeout(timer); reject(signal!.reason) }
    signal?.addEventListener('abort', stop, { once: true })
  })
}

type ModelInfo = Awaited<ReturnType<NonNullable<Context['llm']['resolveModelInfo']>>>

/**
 * One model call without a session (grading, summaries, textbook blocks). Returns the reply text. The output budget
 * never exceeds the model's own cap set under 设置 › 模型 › 高级设置: a call's explicit budget would otherwise win.
 */
export async function complete(ctx: Context, options: {
  readonly system: string
  readonly prompt: string
  /** Pictures shown before the prompt. */
  readonly images?: readonly PromptImage[]
  /** Shown in DSH's usage accounting, e.g. `learning-textbook`. */
  readonly purpose: string
  /** The calling role's model setting (`provider/model`); absent follows the default model. */
  readonly model?: string | ModelRoute
  readonly maxTokens?: number
  readonly signal?: AbortSignal
}): Promise<string> {
  const route = routeOf(options.model) ?? await defaultModel(ctx)
  const info = await ctx.llm.resolveModelInfo?.(route.provider, route.model).catch(() => undefined)
  const pictures = options.images?.length ? await imageBlocks(ctx, route, options.images, info) : []
  const wanted = options.maxTokens ?? 4000
  const cap = info?.defaultMaxTokens
  const maxTokens = cap && cap < wanted ? cap : wanted
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await once(ctx, route, pictures, { ...options, maxTokens })
    } catch (error) {
      if (LearningApiError.is(error) && error.code === 'learning/model/truncated' && maxTokens < wanted) {
        throw new LearningApiError('learning/model/truncated', `模型输出达到长度上限，回复不完整：${route.model} 的最大输出设为 ${maxTokens}，这次需要 ${wanted}（可以在 设置 › 模型 › 高级设置 里调大）`, { provider: route.provider, model: route.model })
      }
      if (!retryable(error) || attempt >= RETRY_DELAYS_MS.length || options.signal?.aborted) throw describe(error, route)
      await pause(RETRY_DELAYS_MS[attempt]!, options.signal)
    }
  }
}

function once(ctx: Context, route: ModelRoute, pictures: Awaited<ReturnType<typeof imageBlocks>>, options: Parameters<typeof complete>[1] & { readonly maxTokens: number }): Promise<string> {
  return collectText(ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
    system: options.system,
    messages: [createUserMessage({ content: [...pictures, { type: 'text' as const, text: options.prompt }], source: { kind: 'user' } })],
    maxTokens: options.maxTokens,
    purpose: options.purpose,
    signal: options.signal ?? new AbortController().signal,
  } as never))
}

/** Truncated or empty replies are the model's answer; anything else may be the route itself. */
function describe(error: unknown, route: ModelRoute): unknown {
  if (LearningApiError.is(error) && error.code !== 'learning/model/failed') return error
  const reason = LearningApiError.is(error) ? error.message : `模型调用失败：${error instanceof Error ? error.message : String(error)}`
  return new LearningApiError('learning/model/failed', `${reason}（模型 ${route.model}，可以在 设置 › 模型 里更换）`, { provider: route.provider, model: route.model })
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
