// The shared SQLite database (node:sqlite, built into Node; stage-0 V7).
// Each unit owns tables prefixed with its own name and brings them up to date with `migrate`.
// Events must only fire after the data is durable, so post-commit work queues on `afterCommit`.
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Migration } from '@learning-agent/contracts'

/** Database copies taken before upgrades that are kept; older ones are removed. */
const KEPT_UPGRADE_BACKUPS = 3

/** SQLite cannot bind `undefined`; store it as NULL. */
export function nullable<T>(value: T | undefined): T | null {
  return value === undefined ? null : value
}

/**
 * Write a complete copy of the database to `file`, including what is still in the WAL, as one file.
 * The copy is consistent even while others read; it cannot run inside a transaction.
 */
export function snapshot(sqlite: DatabaseSync, file: string): void {
  mkdirSync(dirname(file), { recursive: true })
  sqlite.prepare('VACUUM INTO ?').run(file)
}

/** Each unit's schema version recorded in a database. */
export function migrationVersions(sqlite: DatabaseSync): Record<string, number> {
  const rows = sqlite.prepare('SELECT unit, MAX(version) AS version FROM core_migrations GROUP BY unit ORDER BY unit').all() as { unit: string; version: number }[]
  return Object.fromEntries(rows.map(row => [row.unit, row.version]))
}

export class Database {
  readonly sqlite: DatabaseSync
  private depth = 0
  private pending: (() => void)[] = []
  /** Taken once per start, before the first upgrade of data an older program wrote. */
  private upgradeBackup: string | undefined

  /** @param upgradeBackups - folder for the copy taken before upgrading existing data; none when omitted. */
  constructor(file: string, private readonly upgradeBackups?: string) {
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
    // Older code on newer data would misread it, or write what the newer code does not expect.
    if (current > ordered.length) {
      throw new Error(`learning-core: 学习库是新版本程序写的（${unit} 的数据是第 ${current} 版，这个程序只认识到第 ${ordered.length} 版），${unit} 不加载。请用新版本的程序打开，或者恢复一份旧的备份。`)
    }
    const pending = ordered.filter(step => step.version > current)
    if (pending.length === 0) return
    const backup = current > 0 ? this.backupBeforeUpgrade() : undefined
    for (const step of pending) {
      try {
        this.transaction(() => {
          this.sqlite.exec(step.sql)
          this.sqlite.prepare('INSERT INTO core_migrations (unit, version, applied_at) VALUES (?, ?, ?)')
            .run(unit, step.version, new Date().toISOString())
        })
      } catch (error) {
        const where = backup ? `升级前的数据库备份在 ${backup}` : '这个单元之前没有数据'
        throw new Error(`learning-core: ${unit} 升级到第 ${step.version} 版失败（${(error as Error).message}）。${where}。`, { cause: error })
      }
    }
  }

  /** Copy the database before the first upgrade of existing data in this start; keep the latest few copies. */
  private backupBeforeUpgrade(): string | undefined {
    if (!this.upgradeBackups || this.upgradeBackup) return this.upgradeBackup
    const file = join(this.upgradeBackups, `learning-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
    snapshot(this.sqlite, file)
    this.upgradeBackup = file
    const copies = readdirSync(this.upgradeBackups).filter(name => /^learning-.*\.db$/.test(name)).sort()
    for (const name of copies.slice(0, -KEPT_UPGRADE_BACKUPS)) rmSync(join(this.upgradeBackups, name), { force: true })
    return file
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
