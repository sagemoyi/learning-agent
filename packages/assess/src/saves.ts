// Saving answers in progress (docs/assess/design.md, 作答), one queue per problem. At most one save of a problem is
// on its way, so the server receives a problem's versions in order; a version counts as saved only when its own
// reply comes back. A failed save is kept and reported; the input stays where it is until a retry or the next
// change saves it. Handing in, reading photos and leaving wait for what is queued and on its way. No React here.

export type SaveState = 'saving' | 'saved' | 'failed'

interface Entry<T> {
  value: T
  /** Bumped by every change. */
  version: number
  /** The latest version whose own reply came back. */
  saved: number
  running?: Promise<void>
}

/** Thrown by `saveAll` when some problems could not be saved: which ones, and the first reason. */
export class SavesFailed extends Error {
  constructor(readonly keys: readonly string[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}

export class SaveQueue<T> {
  private readonly entries = new Map<string, Entry<T>>()

  constructor(
    private readonly send: (key: string, value: T) => Promise<unknown>,
    private readonly onState: (key: string, state: SaveState, error?: unknown) => void = () => {},
  ) {}

  /** A new version of `key`, saved by the next `save`. */
  put(key: string, value: T): void {
    const entry = this.entries.get(key)
    if (entry) {
      entry.value = value
      entry.version += 1
    } else this.entries.set(key, { value, version: 1, saved: 0 })
  }

  /** Is anything changed but not saved yet (queued, on its way or failed)? */
  get pending(): boolean {
    return [...this.entries.values()].some(entry => entry.saved < entry.version)
  }

  /**
   * Save the latest version of `key`, after the save already on its way. Resolves once the version current at the
   * call (or a later one) is saved; rejects when a save fails.
   */
  async save(key: string): Promise<void> {
    const entry = this.entries.get(key)
    if (!entry) return
    const target = entry.version
    while (entry.saved < target) await (entry.running ?? this.run(key, entry))
  }

  /** Save everything changed, waiting for what is already on its way. */
  async saveAll(): Promise<void> {
    const keys = [...this.entries.keys()]
    const results = await Promise.allSettled(keys.map(key => this.save(key)))
    const failed = keys.filter((_, at) => results[at]!.status === 'rejected')
    if (failed.length) throw new SavesFailed(failed, (results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason)
  }

  /** Send the latest version once; a version put meanwhile goes in the next run. */
  private run(key: string, entry: Entry<T>): Promise<void> {
    const { version, value } = entry
    this.onState(key, 'saving')
    entry.running = this.send(key, value).then(
      () => {
        entry.saved = Math.max(entry.saved, version)
        if (entry.saved === entry.version) this.onState(key, 'saved')
      },
      (error: unknown) => {
        this.onState(key, 'failed', error)
        throw error
      },
    ).finally(() => { entry.running = undefined })
    return entry.running
  }
}
