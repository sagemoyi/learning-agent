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

let lastTime = -1
let lastRandom: number[] = []

/**
 * A 26-character ULID: 48-bit millisecond time + 80 random bits. Works in Node and the browser.
 * Ids made in the same millisecond count up (the ULID spec's monotonic mode, random part plus one),
 * so sorting by id is the order they were made in: the evidence log reads in that order, and a
 * regrade or a help entry written in the same millisecond as the answer it concerns must not sort before it.
 */
export function ulid(now: number = Date.now()): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i += 1) {
    time = ULID_ALPHABET[t % 32] + time
    t = Math.floor(t / 32)
  }
  let digits: number[] | undefined
  if (now === lastTime) {
    // Carry through the random part; a full overflow (2^80 ids in one millisecond) falls back to a fresh draw.
    const next = [...lastRandom]
    let at = next.length - 1
    while (at >= 0 && next[at] === 31) { next[at] = 0; at -= 1 }
    if (at >= 0) { next[at] = next[at]! + 1; digits = next }
  }
  digits ??= Array.from(randomBytes(16), byte => byte % 32)
  lastTime = now
  lastRandom = digits
  return time + digits.map(digit => ULID_ALPHABET[digit]).join('')
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
