// Page context shared by pages, the side chat and annotations (contracts §6.4).
import { z } from 'zod'
import { idOf } from './common.ts'
import { TextQuote } from './textbook.ts'

export const SelectionKind = z.enum(['block', 'node', 'stage', 'lesson', 'task', 'problem', 'attempt', 'chunk', 'source', 'text'])

export const Selection = z.object({
  /** Page id, e.g. `textbook.reader`. */
  page: z.string(),
  courseId: idOf('course').optional(),
  selected: z.object({
    kind: SelectionKind,
    id: z.string().optional(),
    quote: TextQuote.optional(),
    /** What the UI shows for it, e.g. `1.3 管内流动阻力 · 第 2 段`. */
    label: z.string(),
  }).optional(),
})
export type Selection = z.infer<typeof Selection>
