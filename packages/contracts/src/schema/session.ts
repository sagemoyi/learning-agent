// Sessions, side-chat summaries, proposals and the change log (contracts §4.7).
import { z } from 'zod'
import { idOf, instant, relativePath, sessionId } from './common.ts'
import { Selection } from './selection.ts'

export const SessionRole = z.enum(['teacher', 'side-chat', 'researcher'])
export type SessionRole = z.infer<typeof SessionRole>

/** Which course/stage/role a DSH session belongs to (DSH session headers carry no custom data). Owner: core. */
export const SessionLink = z.object({
  sessionId,
  courseId: idOf('course').optional(),
  role: SessionRole,
  stageId: idOf('stage').optional(),
  /** Page and selection the side chat was opened from. */
  openedFrom: Selection.optional(),
  createdAt: instant,
  closedAt: instant.optional(),
})
export type SessionLink = z.infer<typeof SessionLink>

/** Structured part of one side-chat summary; the prose is appended to `notes/side-chats.md`. Owner: sidechat. */
export const SideChatSummary = z.object({
  id: idOf('summary'),
  sessionId,
  courseId: idOf('course').optional(),
  at: instant,
  openedFrom: Selection.optional(),
  questions: z.array(z.string()),
  conclusions: z.array(z.string()),
  nodeIds: z.array(idOf('node')),
  misconceptions: z.array(z.string()),
  helpGiven: z.array(z.object({ nodeIds: z.array(idOf('node')), level: z.enum(['hint', 'explanation', 'worked-solution', 'answer-revealed']) })),
  proposalIds: z.array(idOf('proposal')),
})
export type SideChatSummary = z.infer<typeof SideChatSummary>

/** What a proposal or change targets. */
export const ChangeTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), courseId: idOf('course').optional(), path: relativePath }),
  z.object({ kind: z.literal('node'), id: idOf('node') }),
  z.object({ kind: z.literal('edge'), id: idOf('edge') }),
  z.object({ kind: z.literal('course-node'), id: z.string().min(1) }),
  z.object({ kind: z.literal('node-link'), id: z.string().min(1) }),
  z.object({ kind: z.literal('problem'), id: idOf('problem') }),
  z.object({ kind: z.literal('stage'), id: idOf('stage') }),
])
export type ChangeTarget = z.infer<typeof ChangeTarget>

export const ProposalStatus = z.enum(['open', 'accepted', 'rejected', 'applied', 'withdrawn'])

/** Stored by core, handled by tutor (docs/journey.md). */
export const Proposal = z.object({
  id: idOf('proposal'),
  courseId: idOf('course').optional(),
  source: z.enum(['user', 'side-chat', 'annotation', 'review', 'teacher']),
  targets: z.array(ChangeTarget).min(1),
  summary: z.string(),
  rationale: z.string(),
  status: ProposalStatus,
  createdAt: instant,
  decidedAt: instant.optional(),
  changeIds: z.array(idOf('change')).default([]),
})
export type Proposal = z.infer<typeof Proposal>

/** One applied change with full before/after content; reverting is another change. Owner: core. */
export const Change = z.object({
  id: idOf('change'),
  at: instant,
  actor: z.enum(['teacher', 'user', 'system']),
  target: ChangeTarget,
  size: z.enum(['minor', 'major']),
  /** null before = created; null after = deleted. Text for files, JSON for records. */
  before: z.string().nullable(),
  after: z.string().nullable(),
  reason: z.string(),
  proposalId: idOf('proposal').optional(),
  revertOf: idOf('change').optional(),
  /** Groups an owner's atomic database edit; core never reverts another unit's tables. */
  operationId: idOf('operation').optional(),
  courseId: idOf('course').optional(),
})
export type Change = z.infer<typeof Change>
