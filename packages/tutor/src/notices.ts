// tutor unit: the hand-back queue (docs/tutor/design.md, A). A handoff is stored first, merged per
// course for a short window, and marked sent only once DSH holds it. A failed delivery is retried a
// few times; what a restart interrupted is sent again. Whether the teacher acts is decided when the
// notice goes out, from the planner's next step then.
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Handoff, Migration } from '@learning-agent/contracts'
import { now } from '@learning-agent/kit'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Progress notices from `learning/handoff`; the chat shows them as notices, not as the learner's words. */
    'learning-handoff': { kind: 'learning-handoff' }
  }
}

const HANDOFF_SOURCE = 'learning-handoff'
/** Waits before retrying a failed delivery; after the last one the waiting notices are dropped (the brief still has the state). */
const RETRY_MS = [2000, 15_000, 60_000]
/** Notices older than this are not sent again after a restart. */
const RESEND_WITHIN_MS = 12 * 60 * 60 * 1000

export const noticeMigration: Migration = {
  version: 1,
  sql: `
    CREATE TABLE tutor_notices (
      id TEXT PRIMARY KEY,
      course_id TEXT NOT NULL,
      unit TEXT NOT NULL,
      text TEXT NOT NULL,
      at TEXT NOT NULL,
      sent_at TEXT,
      session_id TEXT,
      woke INTEGER NOT NULL DEFAULT 0,
      dropped INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX tutor_notices_waiting ON tutor_notices (course_id) WHERE sent_at IS NULL AND dropped = 0;
  `,
}

interface Row { readonly id: string; readonly text: string }

export interface NoticeDeps {
  readonly delayMs: number
  /** The course's teacher session now, created when missing. */
  session(courseId: string): Promise<string>
}

export function installNotices(ctx: Context, deps: NoticeDeps): void {
  const sqlite = ctx.learnCore.db.sqlite
  const logger = ctx.logger('learning-tutor')
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Map<string, Promise<void>>()
  const again = new Set<string>()
  /** Failed deliveries in a row, per course; while a retry is pending, new notices wait for it. */
  const failures = new Map<string, number>()

  function schedule(courseId: string, ms: number): void {
    clearTimeout(timers.get(courseId))
    timers.set(courseId, setTimeout(() => {
      timers.delete(courseId)
      flush(courseId).catch(error => logger.warn('handoff delivery failed: %s', (error as Error).stack ?? error))
    }, ms))
  }

  /** One delivery at a time per course; notices arriving meanwhile go out right after. */
  async function flush(courseId: string): Promise<void> {
    if (running.has(courseId)) {
      again.add(courseId)
      return
    }
    const run = deliverWaiting(courseId).finally(() => {
      running.delete(courseId)
      if (again.delete(courseId) && !failures.has(courseId)) schedule(courseId, deps.delayMs)
    })
    running.set(courseId, run)
    await run
  }

  async function deliverWaiting(courseId: string): Promise<void> {
    const rows = sqlite.prepare('SELECT id, text FROM tutor_notices WHERE course_id = ? AND sent_at IS NULL AND dropped = 0 ORDER BY at, rowid').all(courseId) as unknown as Row[]
    if (rows.length === 0) return
    const ids = rows.map(row => row.id)
    const marks = ids.map(() => '?').join(', ')
    try {
      const { sessionId, wake } = await deliver(courseId, rows.map(row => row.text))
      sqlite.prepare(`UPDATE tutor_notices SET sent_at = ?, session_id = ?, woke = ? WHERE id IN (${marks})`).run(now(), sessionId, wake ? 1 : 0, ...ids)
      failures.delete(courseId)
    } catch (error) {
      const failed = (failures.get(courseId) ?? 0) + 1
      const dropped = failed > RETRY_MS.length
      logger.warn('handoff delivery failed (%s): %s', dropped ? 'dropped' : `retry ${failed}`, (error as Error).stack ?? error)
      if (dropped) {
        sqlite.prepare(`UPDATE tutor_notices SET dropped = 1 WHERE id IN (${marks})`).run(...ids)
        failures.delete(courseId)
      } else {
        failures.set(courseId, failed)
        schedule(courseId, RETRY_MS[failed - 1]!)
      }
    }
  }

  /** The first notice that wakes the teacher in a stage session opens the stage, unless the teacher already spoke there. */
  async function opening(sessionId: string): Promise<boolean> {
    if (!ctx.learnCore.sessions.get(sessionId)?.stageId) return false
    if (sqlite.prepare('SELECT 1 FROM tutor_notices WHERE session_id = ? AND woke = 1 LIMIT 1').get(sessionId)) return false
    const inspection = await ctx.sessionController.inspect(sessionId as never) as unknown as { events?: readonly { type: string }[] } | undefined
    return !(inspection?.events ?? []).some(event => event.type === 'assistant/message')
  }

  async function deliver(courseId: string, texts: readonly string[]): Promise<{ sessionId: string; wake: boolean }> {
    const wake = (await ctx.learnPlanner.next(courseId)).actor === 'teacher'
    const sessionId = await deps.session(courseId)
    const opens = wake && await opening(sessionId)
    const text = [
      '【进度通知】',
      ...texts.map(line => `- ${line}`),
      '',
      wake
        ? (opens ? '这是这个阶段的第一次课：先向学习者简单介绍这个阶段要做成什么，再按课程现状简报的"下一步"继续。' : '先用一句话回应学习者，再按课程现状简报的"下一步"继续。')
        : '现在轮到学习者，不需要回复。',
    ].join('\n')
    await ctx.agents.withoutInitiator(async () => {
      const resolved = await ctx.sessionController.resolveAgent(sessionId as never)
      if ('error' in resolved) throw resolved.error
      const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: HANDOFF_SOURCE } })
      if (wake) resolved.agent.followup(message)
      else resolved.agent.inject(message)
      await ctx.sessions.flush(resolved.agent.session)
    })
    return { sessionId, wake }
  }

  ctx.on('learning/handoff', ({ courseId, unit, text }: Handoff) => {
    sqlite.prepare('INSERT INTO tutor_notices (id, course_id, unit, text, at) VALUES (?, ?, ?, ?, ?)').run(globalThis.crypto.randomUUID(), courseId, unit, text, now())
    if (!failures.has(courseId)) schedule(courseId, deps.delayMs)
  })

  // After a restart: what was received but not sent goes out again, unless it is stale.
  const cutoff = new Date(Date.now() - RESEND_WITHIN_MS).toISOString()
  sqlite.prepare('UPDATE tutor_notices SET dropped = 1 WHERE sent_at IS NULL AND dropped = 0 AND at < ?').run(cutoff)
  const waiting = sqlite.prepare('SELECT DISTINCT course_id AS courseId FROM tutor_notices WHERE sent_at IS NULL AND dropped = 0').all() as unknown as { courseId: string }[]
  for (const { courseId } of waiting) schedule(courseId, deps.delayMs)

  ctx.effect(() => () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }, 'tutor: notice timers')
}
