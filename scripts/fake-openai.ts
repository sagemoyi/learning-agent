// A local stand-in for a model service, for running real DSH with no key and no paid calls: 设置 › 添加模型服务 and 测试连接,
// the browser tests (scripts/e2e/), or the teacher by hand (start DSH with DEEPSEEK_BASE_URL pointing here). Speaks the
// OpenAI form and the Messages form DSH's built-in DeepSeek service uses, streamed or not.
//
// What it answers, by the last user message and the system prompt:
// - `【工具】name {json}` calls that tool once, then reports `工具结果：<what came back>`, which is how the e2e tests script the teacher;
// - a message containing 慢 streams 40 sentences over about 12 seconds; anything else `收到：<its last words>`;
// - the app's one-shot calls get replies of the right shape: knowledge extraction, the handout's plan and sections, the
//   classroom records, the grader. Each cites the first chunk id of its prompt, so handouts come out with real sources.
//
// Usage: node scripts/fake-openai.ts [port]      (default 16590; base URL http://127.0.0.1:<port>/v1)
// Logs each request, whether it carried a key (never the key itself), and the output budget and thinking parameters.
import { createServer, type Server } from 'node:http'

interface Message { readonly role: string; readonly content?: unknown; readonly tool_call_id?: string }
interface Input { readonly model?: string; readonly stream?: boolean; readonly system?: unknown; readonly messages?: readonly Message[]; readonly tools?: readonly unknown[] }
type Reply = { readonly words: readonly string[]; readonly pauseMs: number } | { readonly tool: { readonly name: string; readonly input: unknown } }

const MODELS = ['fake-chat', 'fake-mini', 'deepseek-flash', 'deepseek-pro'].map(id => ({ id, object: 'model', owned_by: 'local' }))
const PLAN = { overview: '', terms: [], formulas: [], needs: [], confusions: [], types: [] }

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(part => (part as { text?: string; content?: unknown }).text ?? textOf((part as { content?: unknown }).content)).join('')
      : ''

/** A one-shot call's answer, by its system prompt (their first lines are in the units' prompt constants). */
function oneShot(system: string, prompt: string): string | undefined {
  const chunk = /\bck_[0-9A-Z]{26}\b/.exec(prompt)?.[0]
  if (system.includes('规划一章讲义')) return JSON.stringify(PLAN)
  if (system.includes('写一章讲义里的一个小节')) return `这一节讲静水压强怎样按水深计算（合成）。[合成资料 p.1](cite:${chunk})`
  if (system.includes('整理知识节点')) return JSON.stringify({ nodes: chunk ? [{ title: '静水压强', kind: 'knowledge', description: '静止液体内部的压强（合成）', sources: [chunk] }] : [], edges: [] })
  if (system.includes('主老师和学习者的对话')) return JSON.stringify({ help: [], claims: [], questions: [] })
  if (system.includes('侧边答疑')) return JSON.stringify({ questions: [], conclusions: [], help: [], claims: [], misconceptions: [] })
  if (system.includes('判分助手')) return JSON.stringify({ verdict: 'correct', score: 1, confidence: 'high', rationale: '（合成）' })
  return undefined
}

function replyTo(input: Input): Reply {
  const messages = input.messages ?? []
  const lastUser = [...messages].reverse().find(message => message.role === 'user')
  const fromTool = messages.at(-1)?.role === 'tool' || (Array.isArray(lastUser?.content) && lastUser.content.some(part => (part as { type?: string }).type === 'tool_result'))
  const text = textOf(lastUser?.content)
  if (fromTool) return { words: [`工具结果：${(messages.at(-1)?.role === 'tool' ? textOf(messages.at(-1)!.content) : text).slice(0, 2000)}`], pauseMs: 0 }
  const system = [textOf(input.system), ...messages.filter(message => message.role === 'system').map(message => textOf(message.content))].join('\n')
  const shot = oneShot(system, text)
  if (shot !== undefined) return { words: [shot], pauseMs: 0 }
  // Only a call offering tools: the same words also reach calls that quote the talk, such as naming the session.
  const scripted = input.tools?.length ? /【工具】(\w+)\s+(\{[\s\S]*\})/.exec(text) : undefined
  if (scripted) return { tool: { name: scripted[1]!, input: JSON.parse(scripted[2]!) } }
  if (text.includes('慢')) return { words: Array.from({ length: 40 }, (_, i) => `第${i + 1}句。`), pauseMs: 300 }
  return { words: [`收到：${text.trim().slice(-12)}`], pauseMs: 0 }
}

const wordsOf = (reply: Reply) => ('words' in reply ? reply.words : [])

export function startFakeModel(port: number): Promise<Server> {
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      void (async () => {
        console.log(new Date().toISOString(), request.method, request.url, request.headers.authorization || request.headers['x-api-key'] ? 'with key' : 'no key')
        const url = request.url ?? ''
        if (request.method === 'GET' && url.endsWith('/models')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ object: 'list', data: MODELS }))
          return
        }
        if (request.method !== 'POST' || !(url.endsWith('/chat/completions') || url.endsWith('/messages'))) {
          response.writeHead(404, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: 'not found' } }))
          return
        }
        const input = JSON.parse(body || '{}') as Input
        // The output budget and thinking parameters the request carried, to check what the settings send.
        const fields = ['max_tokens', 'max_completion_tokens', 'reasoning_effort', 'thinking'] as const
        console.log('  ', JSON.stringify({ model: input.model, ...Object.fromEntries(fields.flatMap(field => (field in input ? [[field, (input as Record<string, unknown>)[field]]] : []))) }))
        const reply = replyTo(input)
        const stream = (words: readonly string[], each: (word: string) => void) => words.reduce<Promise<void>>((done, word) => done.then(async () => {
          each(word)
          const pauseMs = 'pauseMs' in reply ? reply.pauseMs : 0
          if (pauseMs) await new Promise(resolve => setTimeout(resolve, pauseMs))
        }), Promise.resolve())
        const toolId = `call_${Date.now()}`

        if (url.endsWith('/messages')) {
          const stopReason = 'tool' in reply ? 'tool_use' : 'end_turn'
          if (!input.stream) {
            const content = 'tool' in reply ? [{ type: 'tool_use', id: toolId, ...reply.tool }] : [{ type: 'text', text: wordsOf(reply).join('') }]
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: input.model, content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 2 } }))
            return
          }
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          const send = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
          send('message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } })
          if ('tool' in reply) {
            send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: toolId, name: reply.tool.name, input: {} } })
            send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.tool.input) } })
          } else {
            send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
            await stream(wordsOf(reply), word => send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: word } }))
          }
          send('content_block_stop', { index: 0 })
          send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 2 } })
          send('message_stop', {})
          response.end()
          return
        }

        const head = { id: 'chatcmpl-fake', created: Math.floor(Date.now() / 1000), model: input.model }
        const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
        const call = 'tool' in reply ? { id: toolId, type: 'function', function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.input) } } : undefined
        const finish = call ? 'tool_calls' : 'stop'
        if (!input.stream) {
          const message = call ? { role: 'assistant', content: null, tool_calls: [call] } : { role: 'assistant', content: wordsOf(reply).join('') }
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ...head, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage }))
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const send = (delta: object, finish_reason: string | null) => response.write(`data: ${JSON.stringify({ ...head, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
        if (call) send({ role: 'assistant', tool_calls: [{ index: 0, ...call }] }, null)
        else await stream(wordsOf(reply), word => send({ role: 'assistant', content: word }, null))
        response.write(`data: ${JSON.stringify({ ...head, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`)
        response.end('data: [DONE]\n\n')
      })().catch((error: unknown) => {
        console.error(error)
        response.destroy()
      })
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    const { port: bound } = server.address() as { port: number }
    console.log(`fake model service on http://127.0.0.1:${bound}/v1`)
    resolve(server)
  }))
}

if (import.meta.main) await startFakeModel(Number(process.argv[2] ?? 16590))
