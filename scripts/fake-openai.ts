// A local stand-in for an OpenAI-compatible model service, for checking 设置 › 添加模型服务 and 测试连接
// without paid calls. Lists two models and answers every chat request with "好的" (streamed or not).
// Logs each request and whether it carried a key, never the key itself.
//
// Usage: node scripts/fake-openai.ts [port]      (default 16590; base URL http://127.0.0.1:<port>/v1)
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 16590)
const MODELS = [
  { id: 'fake-chat', object: 'model', owned_by: 'local' },
  { id: 'fake-mini', object: 'model', owned_by: 'local' },
]

createServer((request, response) => {
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    console.log(new Date().toISOString(), request.method, request.url, request.headers.authorization ? 'with key' : 'no key')
    const url = request.url ?? ''
    if (request.method === 'GET' && url.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: MODELS }))
      return
    }
    if (request.method === 'POST' && url.endsWith('/chat/completions')) {
      const input = JSON.parse(body || '{}') as { model?: string; stream?: boolean }
      const head = { id: 'chatcmpl-fake', created: Math.floor(Date.now() / 1000), model: input.model }
      const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
      if (!input.stream) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ...head, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '好的' }, finish_reason: 'stop' }], usage }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`)
      send({ ...head, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '好的' }, finish_reason: null }] })
      send({ ...head, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })
      response.end('data: [DONE]\n\n')
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'not found' } }))
  })
}).listen(port, '127.0.0.1', () => console.log(`fake OpenAI-compatible service on http://127.0.0.1:${port}/v1`))
