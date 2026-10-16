// Browser sessions against a running learning workbench, for UI review screenshots and demo GIFs.
// playwright-core drives the installed Google Chrome (no browser download). By default every
// `/api/learning/*` call that is not a known read, and every write to DSH's settings, key, model and plugin
// services, is answered inside the browser with an error, so a review never changes learning data or
// settings or starts paid work; `close()` reports what was blocked.
// Used by the learning-ui-review and learning-record-gif skills (.agents/skills/).
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium, type Page, type Route } from 'playwright-core'

export const ROOT = resolve(import.meta.dirname, '..')

/**
 * Endpoints that only read. Any other `/api/learning/*` POST counts as a write and is blocked unless
 * `allowWrites` is set. A new read endpoint missing here shows up in `blocked` and as an error on the page.
 */
export const READ_METHODS: ReadonlySet<string> = new Set([
  'core.courses', 'core.changes',
  'assess.view', 'assess.tests', 'assess.bank',
  'curriculum.overview', 'curriculum.design', 'curriculum.review', 'curriculum.report',
  'goal.get', 'goal.view', 'knowledge.graph', 'knowledge.global', 'knowledge.sources', 'knowledge.detail', 'knowledge.candidates', 'knowledge.history', 'knowledge.operation', 'knowledge.mergeSuggestions', 'knowledge.mergePlan', 'knowledge.extractions', 'learner.states', 'learner.evidence',
  'library.sources', 'library.search', 'library.chunk', 'library.document', 'library.imports', 'library.services', 'library.webPending', 'library.siteRules',
  'library.pageChunks',
  'planner.next', 'planner.home', 'settings.about', 'sidechat.active', 'sidechat.drafts',
  'annotation.list', 'annotation.places', 'annotation.candidates',
  'textbook.lesson', 'textbook.statuses', 'textbook.current', 'textbook.checks', 'textbook.blockInfo',
  // Gets or creates the stage's teacher session; the teacher page cannot render without it.
  'tutor.session', 'tutor.brief',
])

/** DSH remote calls the settings page and the chat make that only read; other calls to these services are writes. */
export const DSH_READS: ReadonlySet<string> = new Set([
  'settings/describe', 'credentials/describe', 'pluginInventory/list', 'pluginManager/listBundles', 'pluginManager/listPlugins', 'pluginManager/registries',
  'llm/listProviders', 'llm/listConfigurableProviders', 'session/modelCatalog', 'session/projections', 'session/page', 'session/list', 'session/search',
])

export type Scheme = 'light' | 'dark'

export interface OpenOptions {
  /** DSH port. Default 3182, the synthetic-data instance. */
  readonly port?: number
  readonly width?: number
  readonly height?: number
  /** Emulated system color scheme; DSH's appearance setting must be "跟随系统" for it to apply. */
  readonly scheme?: Scheme
  /** Screenshot folder under `.scratch/ui/`. */
  readonly run?: string
  /** Let write endpoints reach the backend (only on 3182, only when the review needs the real effect). */
  readonly allowWrites?: boolean
  /**
   * Device pixel ratio. At 1 headless Chrome draws a few CJK glyphs with color fringes; take a close-up at 2
   * before calling that a page defect.
   */
  readonly scale?: number
}

export interface RunReport {
  /** Page script errors and console errors. */
  readonly errors: string[]
  /** Write endpoints answered in the browser instead of the backend, in call order. */
  readonly blocked: string[]
}

export interface App {
  readonly page: Page
  readonly width: number
  readonly scheme: Scheme
  /** Save a viewport screenshot as `.scratch/ui/<run>/<name>-<width>-<scheme>.png`; returns the path. */
  shot(name: string, options?: { readonly fullPage?: boolean; readonly settleMs?: number }): Promise<string>
  /** Open an activity's page in the current tab by its title (through Ctrl K). */
  nav(title: string): Promise<void>
  /**
   * Change a read endpoint's real value before the page sees it, to show a state the data lacks.
   * Values are endpoint JSON; `any` keeps scenario scripts free of casts.
   */
  patch(method: string, change: (value: any, input: any) => unknown): void
  /** Answer an endpoint in the browser, e.g. a write whose success state should be shown. */
  fake(method: string, value: unknown | ((input: any) => unknown)): void
  close(): Promise<RunReport>
}

/**
 * The tokenized URL of the DSH instance on `port`: `LEARNING_UI_URL`, else the newer of
 * `.scratch/url-<port>.txt` and the last address DSH printed into `.scratch/dsh-<port>.log`
 * (DSH issues a new token on every start, so an older file holds a dead address). The URL carries
 * DSH's session token, so callers must not print it.
 */
export function appUrl(port: number): string {
  const fromEnv = process.env.LEARNING_UI_URL
  if (fromEnv) return fromEnv
  const candidates: { url: string; at: number }[] = []
  const file = join(ROOT, '.scratch', `url-${port}.txt`)
  if (existsSync(file)) candidates.push({ url: readFileSync(file, 'utf8').trim(), at: statSync(file).mtimeMs })
  const log = join(ROOT, '.scratch', `dsh-${port}.log`)
  if (existsSync(log)) {
    const found = readFileSync(log, 'utf8').match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[\\w-]+`, 'g'))
    if (found) candidates.push({ url: found.at(-1)!, at: statSync(log).mtimeMs })
  }
  const newest = candidates.sort((a, b) => b.at - a.at)[0]
  if (!newest) throw new Error(`找不到 ${port} 的地址：启动 DSH 时把输出写进 .scratch/dsh-${port}.log，或把地址写进 .scratch/url-${port}.txt`)
  return newest.url
}

function methodOf(route: Route): string {
  return new URL(route.request().url()).pathname.replace(/^\/api\/learning\//, '')
}

function rpcOf(route: Route): { rpcId?: unknown; payload?: unknown } {
  try {
    return route.request().postDataJSON() ?? {}
  } catch {
    // Uploads carry a binary body; they have no rpc envelope.
    return {}
  }
}

/** Open the workbench in headless Chrome. Throws when the page's theme differs from `scheme`. */
export async function openApp(options: OpenOptions = {}): Promise<App> {
  const { port = 3182, width = 1440, height = 900, scheme = 'light', run = 'review', allowWrites = false, scale = 1 } = options
  const out = join(ROOT, '.scratch', 'ui', run)
  mkdirSync(out, { recursive: true })
  // The installed Chrome; LEARNING_CHROME points at another build (e.g. a cloud machine's Chromium).
  const executable = process.env.LEARNING_CHROME
  const browser = await chromium.launch(executable ? { executablePath: executable, headless: true } : { channel: 'chrome', headless: true })
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: scheme })
  const page = await context.newPage()
  const report: RunReport = { errors: [], blocked: [] }
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()) })

  const handlers = new Map<string, (route: Route) => Promise<void>>()
  const reply = (route: Route, result: unknown) => route.fulfill({ json: { type: 'server-response', rpcId: rpcOf(route).rpcId, result } })
  await context.route(/\/api\/learning\/[a-z]+\.[A-Za-z]+(\?|$)/, async route => {
    const method = methodOf(route)
    const handler = handlers.get(method)
    if (handler) return handler(route)
    if (route.request().method() !== 'POST' || allowWrites || READ_METHODS.has(method)) return route.fallback()
    report.blocked.push(method)
    return reply(route, { ok: false, error: { code: 'learning/review/blocked', message: '只读验收：这个写操作没有发到后端', details: { method } } })
  })
  await context.route(/\/api\/(settings|credentials|pluginManager|pluginInventory|llm|session)\/[A-Za-z]+(\?|$)/, async route => {
    const endpoint = new URL(route.request().url()).pathname.replace(/^.*\/api\//, '')
    if (route.request().method() !== 'POST' || allowWrites || DSH_READS.has(endpoint)) return route.fallback()
    report.blocked.push(endpoint)
    return reply(route, { ok: false, error: { code: 'gateway/review-blocked', message: '只读验收：这个写操作没有发到后端' } })
  })

  await page.goto(appUrl(port))
  try {
    await page.locator('.la-app').waitFor({ timeout: 20_000 })
  } catch {
    await browser.close()
    throw new Error(`${port} 上没有加载出学习工作台：DSH 没在运行、还在启动，或者地址里的 token 已过期（DSH 每次启动都换 token）`)
  }
  // The shell applies DSH's appearance setting once DSH's theme service arrives, shortly after mount.
  await page.waitForTimeout(500)
  const theme = await page.evaluate(() => document.documentElement.dataset.laTheme)
  if (theme !== scheme) {
    await browser.close()
    throw new Error(`页面是 ${theme} 主题，要求 ${scheme}：DSH 的外观设置不是"跟随系统"，请在报告里说明，不要擅自改设置`)
  }

  return {
    page,
    width,
    scheme,
    async shot(name, { fullPage = false, settleMs = 800 } = {}) {
      await page.waitForTimeout(settleMs)
      const path = join(out, `${name}-${width}-${scheme}.png`)
      await page.screenshot({ path, fullPage, animations: 'disabled' })
      return path
    },
    async nav(title) {
      // Through Ctrl K's page list: an icon with a sidebar panel shows the panel rather than its page.
      await page.keyboard.press('Control+k')
      await page.locator('.la-palette input').fill(title)
      await page.locator('.la-palette-item[data-key^="page:"]').filter({ has: page.locator('.la-palette-label', { hasText: new RegExp(`^${title}$`) }) }).first().click()
    },
    patch(method, change) {
      handlers.set(method, async route => {
        const response = await route.fetch()
        const body = await response.json() as { result?: { ok?: boolean; value?: unknown } }
        if (body.result?.ok) body.result.value = change(body.result.value, rpcOf(route).payload)
        await route.fulfill({ response, json: body })
      })
    },
    fake(method, value) {
      handlers.set(method, route => reply(route, { ok: true, value: typeof value === 'function' ? (value as (input: unknown) => unknown)(rpcOf(route).payload) : value }))
    },
    async close() {
      await browser.close()
      return report
    },
  }
}
