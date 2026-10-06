// Textbook blocks and annotations (contracts §3.2, §4.5).
import { z } from 'zod'
import { blockId, idOf, instant, relativePath, sessionId } from './common.ts'

/**
 * Textbook Markdown conventions (contracts §3.2):
 * - a block ends with ` ^<blockId>` (Obsidian block reference); tables and display math carry the id
 *   on its own line right after the block;
 * - a citation is a link `[label](cite:<chunkId>)`; content still lacking a source carries
 *   `[待核实](cite:unverified)`.
 */
export const BLOCK_ID_PATTERN = /(?:^|\s)\^([0-9a-z]{6})\s*$/
export const CITATION_PATTERN = /\[([^\]]+)\]\(cite:(ck_[0-9A-HJKMNP-TV-Z]{26}|unverified)\)/g
export const UNVERIFIED_CITATION = 'cite:unverified'

/** Index row for one textbook block. The text itself lives in the Markdown file. Owner: textbook. */
export const Block = z.object({
  courseId: idOf('course'),
  id: blockId,
  file: relativePath,
  /** Content fingerprint; a mismatch on read means the file was edited outside the app. */
  hash: z.string(),
  nodeIds: z.array(idOf('node')),
  citations: z.array(idOf('chunk')),
  unverified: z.boolean(),
})
export type Block = z.infer<typeof Block>

/** W3C Web Annotation style quote selector inside one block or chunk. */
export const TextQuote = z.object({
  exact: z.string().min(1),
  prefix: z.string().default(''),
  suffix: z.string().default(''),
})
export type TextQuote = z.infer<typeof TextQuote>

export const AnnotationAnchor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('block'), courseId: idOf('course'), blockId, quote: TextQuote.optional() }),
  z.object({ kind: z.literal('chunk'), chunkId: idOf('chunk'), quote: TextQuote.optional() }),
])

/** question / my understanding / highlight / error report (docs/annotation/design.md). Owner: annotation. */
export const AnnotationType = z.enum(['question', 'understanding', 'highlight', 'error'])

export const Annotation = z.object({
  id: idOf('annotation'),
  anchor: AnnotationAnchor,
  type: AnnotationType,
  text: z.string().default(''),
  createdAt: instant,
  /** Where it went next. */
  sideChatSessionId: sessionId.optional(),
  proposalId: idOf('proposal').optional(),
  resolvedAt: instant.optional(),
})
export type Annotation = z.infer<typeof Annotation>
