// Shapes the host half and the browser half of the annotation unit share (types only).
import type { Annotation, Proposal } from '@learning-agent/contracts'

/** Where a note is read, for the page that lists the notes of a whole course (`annotation.places`). */
export type NotePlace =
  | { readonly kind: 'lesson'; readonly lessonId: string; readonly title: string }
  | { readonly kind: 'source'; readonly chunkId: string; readonly title: string }

/** A paragraph a note whose place is unsure may be on (`annotation.candidates`). */
export interface PlaceCandidate {
  readonly blockId: string
  readonly preview: string
}

/** An annotation as the pages show it (`annotation.list`): with what became of its error report or question. */
export type NoteView = Annotation & {
  readonly proposal?: { readonly status: Proposal['status']; readonly note?: string }
  /** The side chat the question went to is still open. */
  readonly chatOpen?: true
}
