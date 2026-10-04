// Library: sources and their locatable chunks (contracts §4.5). Owner: library.
import { z } from 'zod'
import { idOf, instant, relativePath } from './common.ts'

export const SourceKind = z.enum(['textbook', 'slides', 'paper', 'web', 'exam', 'standard', 'other'])

/** 1 = your own course material and official sources … `clue` = may suggest, never cite. */
export const Authority = z.enum(['1', '2', '3', 'clue'])
export type Authority = z.infer<typeof Authority>

export const Source = z.object({
  id: idOf('source'),
  title: z.string(),
  kind: SourceKind,
  authority: Authority,
  origin: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('file'), fileName: z.string() }),
    z.object({ kind: z.literal('web'), url: z.url(), fetchedAt: instant }),
  ]),
  /** Folder under `library/`, e.g. `src_01JA…-化工原理第3版`. */
  folder: relativePath,
  parser: z.object({ name: z.string(), version: z.string().optional(), where: z.enum(['local', 'cloud']) }).optional(),
  /** A reparse is a new snapshot; old chunks remain reachable by their original citations. */
  supersedes: idOf('source').optional(),
  pages: z.number().int().nonnegative().optional(),
  /** Printed page number = PDF page − pageOffset (citations show printed pages). */
  pageOffset: z.number().int().default(0),
  status: z.enum(['importing', 'ready', 'failed']),
  importedAt: instant,
})
export type Source = z.infer<typeof Source>

/** Where a chunk sits in its source. Page numbers are PDF pages, 1-based. */
export const Locator = z.object({
  page: z.number().int().positive(),
  /** Block index on the page, as the parser numbered it. */
  block: z.number().int().nonnegative(),
  /** [x0, y0, x1, y1], top-left PDF points when pageSize is present; legacy geometry stays page-only. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  /** Top-left parser coordinates; the dimensions make PDF zoom/rotation mapping explicit. */
  pageSize: z.tuple([z.number().positive(), z.number().positive()]).optional(),
})
export type Locator = z.infer<typeof Locator>

export const ChunkKind = z.enum(['heading', 'text', 'formula', 'table', 'figure', 'example', 'exercise', 'answer'])
export type ChunkKind = z.infer<typeof ChunkKind>

export const Chunk = z.object({
  id: idOf('chunk'),
  sourceId: idOf('source'),
  locator: Locator,
  kind: ChunkKind,
  /** Chapter/section path, e.g. ['第1章 流体流动', '1.3 管内流动阻力']. */
  section: z.array(z.string()),
  text: z.string(),
  /** Source-local exercise number connecting a stem, continuation and answer across pages. */
  problemGroup: z.string().optional(),
})
export type Chunk = z.infer<typeof Chunk>

export const CourseSource = z.object({
  courseId: idOf('course'),
  sourceId: idOf('source'),
  role: z.enum(['skeleton', 'reference', 'exam-archive']),
})
export type CourseSource = z.infer<typeof CourseSource>

/** Durable library-owned import; DSH's runtime job id is deliberately not its identity. */
export const LibraryImport = z.object({
  id: z.string(),
  title: z.string(),
  fileName: z.string(),
  fingerprint: z.string(),
  bytes: z.number().int().positive(),
  kind: SourceKind,
  authority: Authority,
  pageOffset: z.number().int(),
  courseId: z.string().optional(),
  role: CourseSource.shape.role.optional(),
  status: z.enum(['queued', 'parsing', 'indexing', 'waiting', 'ready', 'failed', 'canceled']),
  message: z.string(),
  remoteId: z.string().optional(),
  reparseOf: z.string().optional(),
  sourceId: z.string().optional(),
  createdAt: instant,
  updatedAt: instant,
})
export type LibraryImport = z.infer<typeof LibraryImport>
