// Ids: `<prefix>_<ULID>` for database objects (time-ordered, so SQLite inserts append to the B-tree),
// and short random ids for textbook blocks (`^b7k2qx`, unique within a course).

/** Type prefix of every database object id (contracts §4.2). */
export const ID_PREFIX = {
  course: 'cr',
  stage: 'st',
  lesson: 'ls',
  task: 'tk',
  node: 'kn',
  edge: 'ke',
  source: 'src',
  chunk: 'ck',
  problem: 'pb',
  test: 'ts',
  attempt: 'at',
  log: 'lg',
  annotation: 'an',
  proposal: 'pp',
  change: 'chg',
  operation: 'op',
  extraction: 'kx',
  summary: 'sm',
  report: 'rp',
  appeal: 'ap',
  draft: 'df',
} as const

export type IdKind = keyof typeof ID_PREFIX
export type Id<K extends IdKind> = `${(typeof ID_PREFIX)[K]}_${string}` & { readonly __id?: K }

// Crockford base32, as ULID specifies.
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

/** The random part of the last id made, and its millisecond: ids made in the same millisecond count up from it. */
let last: { time: number; random: number[] } | undefined

/**
 * A 26-character ULID: 48-bit millisecond time + 80 random bits. Works in Node and the browser. Ids made in the same
 * millisecond increase (the ULID spec's monotonic mode), so sorting by id keeps the order they were made in; without
 * it, two records made together would sort at random wherever id breaks a tie.
 */
export function ulid(now: number = Date.now()): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i += 1) {
    time = ULID_ALPHABET[t % 32] + time
    t = Math.floor(t / 32)
  }
  let random = last?.time === now ? increment(last.random) : undefined
  random ??= Array.from(randomBytes(16), byte => byte % 32)
  last = { time: now, random }
  return time + random.map(digit => ULID_ALPHABET[digit]).join('')
}

/** The next value of base-32 digits, or nothing when they are all at the top (start again from random). */
function increment(digits: readonly number[]): number[] | undefined {
  const next = [...digits]
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i]! < 31) {
      next[i]! += 1
      return next
    }
    next[i] = 0
  }
  return undefined
}

/** New database id of the given kind, e.g. `newId('problem')` → `pb_01JA…`. */
export function newId<K extends IdKind>(kind: K): Id<K> {
  return `${ID_PREFIX[kind]}_${ulid()}` as Id<K>
}

const BLOCK_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** New textbook block id without the caret, e.g. `b7k2qx`. Callers check uniqueness within the course. */
export function newBlockId(): string {
  let id = ''
  for (const byte of randomBytes(6)) id += BLOCK_ALPHABET[byte % 36]
  return id
}
