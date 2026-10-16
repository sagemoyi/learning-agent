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
  /** Source text the program copied in as it is (a `> [!quote]` box): never rewritten, never checked. */
  original: z.boolean().default(false),
})
export type Block = z.infer<typeof Block>

/** W3C Web Annotation style quote selector inside one block or chunk. */
export const TextQuote = z.object({
  exact: z.string().min(1),
  prefix: z.string().default(''),
  suffix: z.string().default(''),
})
export type TextQuote = z.infer<typeof TextQuote>

/**
 * Where an annotation was made (docs/annotation/design.md). The anchor is what the learner saw and never changes:
 * a block with the block's content fingerprint at that time, or a library chunk (chunks are snapshots).
 */
export const AnnotationAnchor = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('block'),
    courseId: idOf('course'),
    blockId,
    quote: TextQuote.optional(),
    /** `Block.hash` when the annotation was made; a different hash now means the paragraph was edited since. */
    hash: z.string().optional(),
  }),
  z.object({ kind: z.literal('chunk'), courseId: idOf('course').optional(), chunkId: idOf('chunk'), quote: TextQuote.optional() }),
])
export type AnnotationAnchor = z.infer<typeof AnnotationAnchor>

/** question / my understanding / highlight / error report (docs/annotation/design.md). Owner: annotation. */
export const AnnotationType = z.enum(['question', 'understanding', 'highlight', 'error'])
export type AnnotationType = z.infer<typeof AnnotationType>

/**
 * Can the annotation be shown at its place in the current text? Derived from the anchor and recomputed, so a
 * record is never lost when this fails: `original-only` still has the learner's quote and note.
 * - `anchored`: the quote was found once, or once more after the context decided between several matches;
 * - `needs-confirmation`: several places fit, or the sentence was changed and only something close remains;
 * - `original-only`: the paragraph or sentence is gone.
 */
export const AnnotationLocation = z.object({
  status: z.enum(['anchored', 'needs-confirmation', 'original-only']),
  /** The paragraph it is shown on now (differs from the anchor's after a revision moved or split it). */
  blockId: blockId.optional(),
  /** Plain-language reason when not `anchored`. */
  reason: z.string().optional(),
  /** What looks like the old sentence now, to be confirmed by the learner; never applied by itself. */
  suggestion: z.string().optional(),
  /** The learner confirmed this place after a change; kept until the paragraph changes again. */
  confirmedAt: instant.optional(),
  /** `Block.hash` the status was computed against. */
  hash: z.string().optional(),
  checkedAt: instant,
})
export type AnnotationLocation = z.infer<typeof AnnotationLocation>

export const Annotation = z.object({
  id: idOf('annotation'),
  courseId: idOf('course'),
  anchor: AnnotationAnchor,
  type: AnnotationType,
  text: z.string().default(''),
  createdAt: instant,
  updatedAt: instant,
  location: AnnotationLocation,
  /** Where it went next. */
  sideChatSessionId: sessionId.optional(),
  proposalId: idOf('proposal').optional(),
  resolvedAt: instant.optional(),
  /** Hidden from the page; the record and the signals already logged stay. */
  hiddenAt: instant.optional(),
})
export type Annotation = z.infer<typeof Annotation>
