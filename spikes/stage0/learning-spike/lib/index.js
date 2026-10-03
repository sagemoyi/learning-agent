// Host half of the stage-0 spike.
// V3: our own endpoints as exact routes under /api (DSH allows a single /api interceptor, which its gateway owns;
//     exact routes are matched before it and share the same browser authentication and RPC envelope).
// V5: a custom web search provider registered into ctx.web.

/** Plugin name shown in DSH diagnostics. */
export const name = 'learning-spike'

/** Host services this plugin needs before it activates. */
export const inject = ['web']

const EXA_ENDPOINT = 'https://api.exa.ai/search'

/** Read the Exa key from the launching environment; the user's .env spells it EXA_API_Key. */
function exaKey() {
  return process.env.EXA_API_KEY ?? process.env.EXA_API_Key
}

/**
 * Serve `learning/<name>` as an exact route on DSH's authenticated /api channel, speaking the
 * Connection RPC envelope so the browser can call it with ctx.connection.rpc.call('/api', 'learning/<name>').
 */
function endpoint(ctx, name, handler) {
  return ctx.connection.fetch.register({
    path: `/api/learning/${name}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const message = await request.json()
      try {
        const value = await handler(message.payload, request.signal)
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } })
      } catch (error) {
        const failure = { code: 'learning/failed', message: String(error?.message ?? error), details: {} }
        return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: false, error: failure } })
      }
    },
  })
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  ctx.inject(['connection'], c => {
    endpoint(c, 'hello', payload => {
      const who = typeof payload?.name === 'string' ? payload.name : '同学'
      return {
        greeting: `你好，${who}。这条消息来自 learning-spike 后端插件。`,
        serverTime: new Date().toISOString(),
        pid: process.pid,
        cwd: process.cwd(),
      }
    })
  })

  ctx.effect(() => ctx.web.registerSearchProvider({
    id: 'learning-exa',
    available: () => Boolean(exaKey()),
    async search(request, signal) {
      const response = await fetch(EXA_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': exaKey() },
        body: JSON.stringify({
          query: request.query,
          numResults: Math.min(request.maxResults ?? 5, 10),
          type: 'auto',
          contents: { highlights: { numSentences: 2 } },
        }),
        signal,
      })
      if (!response.ok) throw new Error(`learning-exa: HTTP ${response.status}`)
      const data = await response.json()
      const sources = (data.results ?? []).map(item => ({
        url: item.url,
        title: item.title ?? undefined,
        snippet: item.highlights?.join(' ') || undefined,
        publishedAt: item.publishedDate ?? undefined,
      }))
      return { sources, truncated: false }
    },
  }), 'learning-spike: web search provider')
}
