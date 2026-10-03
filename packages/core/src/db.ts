// The shared SQLite database (node:sqlite, built into Node; stage-0 V7).
// Each unit owns tables prefixed with its own name and brings them up to date with `migrate`.
// Events must only fire after the data is durable, so post-commit work queues on `afterCommit`.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Migration } from '@learning-agent/contracts'

/** SQLite cannot bind `undefined`; store it as NULL. */
export function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value
}

export class Database {
  readonly sqlite: DatabaseSync
  private depth = 0
  private pending: (() => void)[] = []

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.sqlite = new DatabaseSync(file)
    this.sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.sqlite.exec(`CREATE TABLE IF NOT EXISTS core_migrations (
      unit TEXT NOT NULL,
      version INTEGER NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (unit, version)
    )`)
  }

  migrate(unit: string, steps: readonly Migration[]): void {
    if (!/^[a-z][a-z0-9-]*$/.test(unit)) throw new Error(`learning-core: invalid unit name ${JSON.stringify(unit)}`)
    const row = this.sqlite.prepare('SELECT MAX(version) AS version FROM core_migrations WHERE unit = ?').get(unit) as { version: number | null }
    const current = row.version ?? 0
    const ordered = [...steps].sort((a, b) => a.version - b.version)
    ordered.forEach((step, index) => {
      if (step.version !== index + 1) throw new Error(`learning-core: ${unit} migrations must be numbered 1, 2, 3 … (got ${step.version})`)
    })
    for (const step of ordered) {
      if (step.version <= current) continue
      this.transaction(() => {
        this.sqlite.exec(step.sql)
        this.sqlite.prepare('INSERT INTO core_migrations (unit, version, applied_at) VALUES (?, ?, ?)')
          .run(unit, step.version, new Date().toISOString())
      })
    }
  }

  /** Run `fn` atomically. Nested calls join the outermost transaction. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth += 1
      try { return fn() } finally { this.depth -= 1 }
    }
    this.depth = 1
    this.sqlite.exec('BEGIN IMMEDIATE')
    let result: T
    try {
      result = fn()
      this.sqlite.exec('COMMIT')
    } catch (error) {
      this.sqlite.exec('ROLLBACK')
      this.pending = []
      this.depth = 0
      throw error
    }
    this.depth = 0
    const pending = this.pending
    this.pending = []
    for (const run of pending) run()
    return result
  }

  /** Run after the current transaction commits (immediately when none is open); dropped on rollback. */
  afterCommit(run: () => void): void {
    if (this.depth > 0) this.pending.push(run)
    else run()
  }

  close(): void {
    this.sqlite.close()
  }
}
