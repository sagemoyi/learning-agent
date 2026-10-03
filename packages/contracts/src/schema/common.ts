// Shared zod building blocks.
import { z } from 'zod'
import { ID_PREFIX, type Id, type IdKind } from '../ids.ts'

/** Id of one kind: `<prefix>_<ULID>`. */
export function idOf<K extends IdKind>(kind: K) {
  const prefix = `${ID_PREFIX[kind]}_`
  return z.string().refine(value => value.startsWith(prefix) && value.length === prefix.length + 26, {
    message: `expected a ${kind} id (${prefix}…)`,
  }) as unknown as z.ZodType<Id<K>>
}

/** ISO-8601 instant (UTC), e.g. `2026-10-03T11:06:26.000Z`. */
export const instant = z.iso.datetime()

/** DSH session id (a UUID we mint before creating the session). */
export const sessionId = z.uuid()

/** Textbook block id without the caret: 6 lowercase letters/digits, unique within a course. */
export const blockId = z.string().regex(/^[0-9a-z]{6}$/)

/** Path relative to a course folder or the data root, always with forward slashes. */
export const relativePath = z.string().min(1).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..'), {
  message: 'expected a forward-slash relative path without ..',
})
