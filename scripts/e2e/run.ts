// Real DSH, a real browser, synthetic data and the fake model; no key, no paid call, no 3180/3182. See docs/development.md, 测试.
// Usage: node scripts/e2e/run.ts [scenario…]     no names: all of them; `pnpm smoke` is the first alone.
// A failing check is listed and the run goes on to the next scenario; the exit code is 1 when anything failed.
// Screenshots of failures and DSH's output go to .scratch/ui/e2e and .scratch/e2e-dsh.log.
import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright-core'
import { openApp, type App } from '../browser.ts'
import { assertBuilt, startEnv, type Env } from './env.ts'
import { SCENARIOS } from './scenarios.ts'

export interface Run {
  readonly env: Env
  readonly app: App
  readonly page: Page
  check(name: string, ok: boolean, detail?: string): void
  /** Waits for a condition as a check, failing it instead of throwing when the wait runs out. */
  until(name: string, wait: Promise<unknown>): Promise<boolean>
  rpc<T = any>(method: string, payload: unknown, on?: Page): Promise<T>
  /** Open a course through the command palette. */
  enter(title: string): Promise<void>
  /** Open a new browser context logged in directly to DSH, past the proxy. */
  second(): Promise<Page>
}

const failures: string[] = []
const names = process.argv.slice(2)
const chosen = names.length ? names.map(name => {
  const found = SCENARIOS.find(scenario => scenario.name === name)
  if (!found) throw new Error(`没有场景 ${name}：${SCENARIOS.map(scenario => scenario.name).join('、')}`)
  return found
}) : SCENARIOS

assertBuilt()
const env = await startEnv()
let code = 0
try {
  await env.start()
  process.env.LEARNING_UI_URL = env.url()
  for (const scenario of chosen) {
    console.log(`\n── ${scenario.name}`)
    process.env.LEARNING_UI_URL = env.url()
    const app = await openApp({ allowWrites: true, run: 'e2e' })
    const { page } = app
    const check = (name: string, ok: boolean, detail = '') => {
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
      if (!ok) failures.push(`${scenario.name}: ${name}`)
    }
    const run: Run = {
      env, app, page, check,
      async until(name, wait) {
        const ok = await wait.then(() => true, () => false)
        check(name, ok)
        if (!ok) await app.shot(`${scenario.name}-failed-${failures.length}`, { settleMs: 0 }).catch(() => {})
        return ok
      },
      async rpc(method, payload, on = page) {
        const answer = await on.evaluate(async ({ method, payload, rpcId }) => {
          const response = await fetch(`/api/learning/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method: `learning/${method}`, payload }) })
          return response.json()
        }, { method, payload, rpcId: randomUUID() })
        if (!answer.result?.ok) throw new Error(`${method}: ${JSON.stringify(answer.result?.error ?? answer)}`)
        return answer.result.value
      },
      async enter(title) {
        if ((await page.locator('.la-switcher').getAttribute('title'))?.startsWith(title)) return
        await page.keyboard.press('Control+k')
        await page.locator('.la-palette input').fill(title)
        // The list of courses arrives a moment after the page does.
        await page.locator('.la-palette-item[data-key^="course:"]').first().click({ timeout: 10_000 })
        await page.locator('.la-palette').waitFor({ state: 'detached' })
        await page.waitForTimeout(500)
      },
      async second() {
        const context = await page.context().browser()!.newContext()
        const other = await context.newPage()
        await other.goto(env.directUrl())
        await other.locator('.la-app').waitFor()
        return other
      },
    }
    try {
      await scenario.run(run)
    } catch (error) {
      check('the scenario ran to its end', false, (error as Error).message.split('\n')[0]!.slice(0, 300))
      await app.shot(`${scenario.name}-stopped`, { settleMs: 0 }).catch(() => {})
    }
    const report = await app.close()
    // Pages may log failed requests the scenario caused on purpose; what must not happen is a script error.
    const scriptErrors = report.errors.filter(text => !text.startsWith('Failed to load resource') && !/net::ERR|Failed to fetch|EventSource|WebSocket/.test(text))
    check('no script errors on the page', scriptErrors.length === 0, scriptErrors.slice(0, 3).join(' | ').slice(0, 400))
  }
} catch (error) {
  console.error(error)
  code = 1
} finally {
  await env.stop()
}
console.log(failures.length ? `\n失败 ${failures.length} 项：\n${failures.join('\n')}` : code ? '' : '\n全部通过')
process.exit(failures.length || code ? 1 : 0)
