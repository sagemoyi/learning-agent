// tutor unit: when the course brief reaches the teacher (docs/tutor/design.md, A). The brief goes in
// before a turn's first step only when the model cannot already see the same one. That is read from
// the committed session log through a session projection (the seam DSH's own time context uses), so
// a restart, a turn cancelled before its messages were committed, or a compaction that summarized the
// brief away never leaves a stale answer. Within a turn, a changed next step gets a one-line update.
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type { NextStep } from '@learning-agent/contracts'
import { messageText } from '@learning-agent/kit'
import { z } from 'zod'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** `step` is the next step the brief was written for; briefs logged before it existed have none. */
    'learning-course-brief': { kind: 'learning-course-brief'; step?: string } & ContextFormed
    'learning-next-step': { kind: 'learning-next-step'; step: string } & ContextFormed
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    learningBrief: BriefState
  }
}

export const BRIEF_SOURCE = 'learning-course-brief'
const STEP_SOURCE = 'learning-next-step'

const BriefState = z.object({
  /** Fingerprint of the brief the model can see, null when none is (never sent, or compacted away). */
  hash: z.string().nullable(),
  seq: z.number().nullable(),
  /** The next step the model was last told about, by the brief or a later update. */
  step: z.string().nullable(),
})
export type BriefState = z.infer<typeof BriefState>

const EMPTY: BriefState = { hash: null, seq: null, step: null }

export const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32)

/** Who acts and on what, enough to tell that the step moved on; new words for the same action are not a new step. */
export const stepKey = (step: Pick<NextStep, 'actor' | 'key'>): string => `${step.actor}|${step.key}`

/** Fold one committed event. Pure: DSH replays the log through it after a restart. */
export function foldBrief(state: BriefState, event: Pick<SessionEvent, 'type' | 'seq' | 'data'>): BriefState {
  if (event.type === 'user/message') {
    const message = event.data as { content?: unknown; source?: { kind?: string; step?: string } }
    if (message.source?.kind === BRIEF_SOURCE) return { hash: fingerprint(messageText(message.content)), seq: event.seq, step: message.source.step ?? null }
    if (message.source?.kind === STEP_SOURCE) return { ...state, step: message.source.step ?? null }
    return state
  }
  if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
    const shadowed = (event.data as { shadowedSeqs?: readonly number[] }).shadowedSeqs ?? []
    return state.seq !== null && shadowed.includes(state.seq) ? EMPTY : state
  }
  return state
}

/** What a step should carry: the whole brief, a one-line update, or nothing. */
export function briefAction(state: BriefState | undefined, step: number, hash: string | undefined, current: string): 'brief' | 'update' | 'none' {
  if (!state?.hash) return 'brief'
  if (step === 1 && hash !== state.hash) return 'brief'
  return current !== state.step ? 'update' : 'none'
}

export interface BriefDeps {
  /** The course of a teacher session, or undefined for every other session. */
  courseOf(sessionId: string): string | undefined
  brief(courseId: string, sessionId: string): Promise<string>
  next(courseId: string): Promise<NextStep>
}

export function installBrief(ctx: Context, deps: BriefDeps): void {
  ctx.effect(() => ctx.sessionProjections.register({
    key: 'learningBrief',
    stateVersion: 1,
    stateSchema: BriefState,
    init: () => EMPTY,
    apply: foldBrief,
  }), 'tutor: brief projection')

  ctx.on('agent/pre-step', async ({ agent, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const courseId = deps.courseOf(agent.session.id)
    if (!courseId) return decision
    const state = ctx.sessionProjections.stateOf(agent.session, 'learningBrief')
    const now = await deps.next(courseId)
    const current = stepKey(now)
    // The full brief is assembled only where it may be needed: a turn's first step, or no brief in view.
    const text = step === 1 || !state?.hash ? await deps.brief(courseId, agent.session.id) : undefined
    const action = briefAction(state, step, text === undefined ? undefined : fingerprint(text), current)
    if (action === 'none') return decision
    const message = action === 'brief'
      ? createUserMessage({ content: [{ type: 'text', text: text! }], source: { kind: BRIEF_SOURCE, step: current, form: 'snapshot', sections: [{ name: BRIEF_SOURCE, text: text! }] } })
      : updateMessage(now, current)
    return { ...decision, messages: [...decision.messages, message] }
  }, { prepend: true })
}

function updateMessage(step: NextStep, key: string) {
  const text = step.actor === 'teacher' ? `【下一步更新】该你做：${step.title}。${step.detail}`
    : step.actor === 'learner' ? `【下一步更新】等学习者：${step.title}。${step.detail}（这一步由学习者在页面上完成：提醒学习者，然后停下来等。）`
      : `【下一步更新】现在不用你做：${step.title}。${step.detail}`
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: STEP_SOURCE, step: key, form: 'snapshot', sections: [{ name: STEP_SOURCE, text }] } })
}
