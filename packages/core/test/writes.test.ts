// core (docs/core/design.md, 数据库和升级, 课程文件和变更日志): a failure at any step of a transaction or a course-file
// write leaves the file, its hash and the change log agreeing, now or after a restart, and a system write is never
// taken for the learner's own edit.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Database } from '../src/db.ts'
import { coreMigrations } from '../src/migrations.ts'
import { CoreStore, diskIo, type FileIo } from '../src/store.ts'

let root = ''
let db: Database
let events: string[]
let errors: unknown[]
let io: FileIo
let courseId = ''

const meta = { actor: 'system' as const, reason: '写入测试（合成）' }
const fileOf = (path: string) => join(root, 'courses', '写入', path)
const changes = (store: CoreStore) => store.changes.list({ courseId, limit: 100 })
const intents = () => (db.sqlite.prepare('SELECT COUNT(*) AS n FROM core_file_writes').get() as { n: number }).n

function open(): CoreStore {
  db = new Database(join(root, '.learning', 'learning.db'))
  db.onError = error => errors.push(error)
  db.migrate('core', coreMigrations)
  // A restart settles what an earlier start left, as core does before anything reads.
  const store = new CoreStore(db, root, name => events.push(name), () => ({ create: async () => ({ id: 'ws' }) }), {
    replace: (file, text) => io.replace(file, text),
    remove: file => io.remove(file),
  })
  store.settleFileWrites()
  return store
}

/** Restart on the same data: the database closes and opens again. */
function restart(): CoreStore {
  db.close()
  return open()
}

/** Fail the `nth` (1-based) COMMIT from now on. */
function failCommit(nth: number): void {
  let seen = 0
  const exec = db.sqlite.exec.bind(db.sqlite)
  vi.spyOn(db.sqlite, 'exec').mockImplementation(sql => {
    if (sql === 'COMMIT' && ++seen === nth) throw new Error('注入的提交失败')
    return exec(sql)
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'learning-writes-'))
  events = []
  errors = []
  io = diskIo
  const store = open()
  courseId = (await store.courses.create({ title: '写入（合成）', slug: '写入' })).id
  await store.files.write(courseId, 'notes.md', '旧\n', meta)
  events = []
})

afterEach(() => {
  vi.restoreAllMocks()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

it('resets after a failed BEGIN, COMMIT or callback, and stops using a connection whose ROLLBACK failed', () => {
  db.sqlite.exec('CREATE TABLE demo_rows (x INTEGER)')
  const insert = (x: number) => db.sqlite.prepare('INSERT INTO demo_rows VALUES (?)').run(x)
  const rows = () => (db.sqlite.prepare('SELECT x FROM demo_rows ORDER BY x').all() as { x: number }[]).map(row => row.x)
  const seen: string[] = []
  const exec = db.sqlite.exec.bind(db.sqlite)
  let fail = ''
  vi.spyOn(db.sqlite, 'exec').mockImplementation(sql => {
    if (sql === fail) {
      fail = ''
      throw new Error(`注入的 ${sql} 失败`)
    }
    return exec(sql)
  })

  fail = 'BEGIN IMMEDIATE'
  expect(() => db.transaction(() => { insert(1); db.afterCommit(() => seen.push('lost')) })).toThrow('BEGIN IMMEDIATE')
  expect(db.inTransaction).toBe(false)
  // The next transaction is a real one: a failing callback rolls back everything it wrote.
  expect(() => db.transaction(() => { insert(2); throw new Error('回调出错') })).toThrow('回调出错')
  expect(rows()).toEqual([])
  db.transaction(() => { insert(3); db.afterCommit(() => seen.push('committed')) })
  expect(seen).toEqual(['committed'])

  fail = 'COMMIT'
  expect(() => db.transaction(() => { insert(4); db.afterCommit(() => seen.push('dropped')) })).toThrow('COMMIT')
  expect(rows()).toEqual([3])
  expect(db.sqlite.isTransaction).toBe(false)
  db.transaction(() => { insert(5); db.afterCommit(() => seen.push('again')) })
  expect(seen).toEqual(['committed', 'again'])

  // A listener that throws after the commit is reported; the write stands.
  db.transaction(() => { insert(6); db.afterCommit(() => { throw new Error('监听出错') }) })
  expect(rows()).toEqual([3, 5, 6])
  expect(String(errors.at(-1))).toContain('监听出错')

  let rolledBack = false
  vi.spyOn(db.sqlite, 'exec').mockImplementation(sql => {
    if (sql === 'COMMIT') throw new Error('注入的提交失败')
    if (sql === 'ROLLBACK' && !rolledBack) { rolledBack = true; throw new Error('注入的回滚失败') }
    return exec(sql)
  })
  expect(() => db.transaction(() => insert(7))).toThrow('注入的提交失败')
  expect(() => db.transaction(() => insert(8))).toThrow('连接状态不明。请重启 DSH')
})

it('leaves the file and the log as they were when the file cannot be written', async () => {
  let store = restart()
  for (const step of ['temporary', 'rename'] as const) {
    io = {
      replace: (file, text) => {
        if (step === 'temporary') throw new Error('注入：写临时文件失败')
        writeFileSync(`${file}.tmp`, text)
        throw new Error('注入：改名失败')
      },
      remove: diskIo.remove,
    }
    await expect(store.files.write(courseId, 'notes.md', `新-${step}\n`, meta)).rejects.toThrow('注入')
    expect(readFileSync(fileOf('notes.md'), 'utf8')).toBe('旧\n')
    expect(changes(store).map(change => change.after)).toEqual(['旧\n', expect.stringContaining('# 写入')])
    expect(intents()).toBe(0)
  }
  io = diskIo
  rmSync(fileOf('notes.md.tmp'), { force: true })
  store = restart()
  expect((await store.files.read(courseId, 'notes.md'))?.text).toBe('旧\n')
  expect(changes(store).filter(change => change.actor === 'user')).toEqual([])
  expect(events).toEqual([])
})

it('writes nothing when the intent cannot be recorded', async () => {
  const store = restart()
  failCommit(1)
  await expect(store.files.write(courseId, 'notes.md', '新\n', meta)).rejects.toThrow('注入的提交失败')
  expect(readFileSync(fileOf('notes.md'), 'utf8')).toBe('旧\n')
  expect(intents()).toBe(0)
  expect(changes(store)).toHaveLength(2)
})

it('publishes a write whose last commit failed, at the next read or the next start, never as the learner\'s edit', async () => {
  let store = restart()
  failCommit(2)
  await expect(store.files.write(courseId, 'notes.md', '新\n', meta)).rejects.toThrow('注入的提交失败')
  vi.restoreAllMocks()
  // The file has the new text; the change waits as an intent.
  expect(readFileSync(fileOf('notes.md'), 'utf8')).toBe('新\n')
  expect(intents()).toBe(1)
  expect(changes(store)).toHaveLength(2)
  // Read in the same run: published as the system's write.
  expect((await store.files.read(courseId, 'notes.md'))?.text).toBe('新\n')
  expect(changes(store)[0]).toMatchObject({ actor: 'system', before: '旧\n', after: '新\n', reason: meta.reason })
  expect(intents()).toBe(0)

  // The same failure, then a restart (as after a crash between the file and the second commit).
  failCommit(2)
  await expect(store.files.write(courseId, 'notes.md', '更新\n', meta)).rejects.toThrow('注入的提交失败')
  vi.restoreAllMocks()
  store = restart()
  expect(intents()).toBe(0)
  expect(changes(store)[0]).toMatchObject({ actor: 'system', before: '新\n', after: '更新\n' })
  expect((await store.files.read(courseId, 'notes.md'))?.text).toBe('更新\n')
  expect(changes(store).filter(change => change.actor === 'user')).toEqual([])
})

it('drops an intent whose file was never replaced, and logs an outside edit made meanwhile as the learner\'s', async () => {
  let store = restart()
  // As after a crash between recording the intent and replacing the file.
  io = { replace: () => { throw new Error('进程在这里中断') }, remove: diskIo.remove }
  const drop = vi.spyOn(store as unknown as { dropFileWrite(id: string): void }, 'dropFileWrite').mockImplementation(() => {})
  await expect(store.files.write(courseId, 'notes.md', '没写成\n', meta)).rejects.toThrow('中断')
  drop.mockRestore()
  io = diskIo
  expect(intents()).toBe(1)
  store = restart()
  expect(intents()).toBe(0)
  expect((await store.files.read(courseId, 'notes.md'))?.text).toBe('旧\n')
  expect(changes(store)).toHaveLength(2)

  io = { replace: () => { throw new Error('进程在这里中断') }, remove: diskIo.remove }
  const again = vi.spyOn(store as unknown as { dropFileWrite(id: string): void }, 'dropFileWrite').mockImplementation(() => {})
  await expect(store.files.write(courseId, 'notes.md', '没写成\n', meta)).rejects.toThrow('中断')
  again.mockRestore()
  io = diskIo
  writeFileSync(fileOf('notes.md'), '在 Obsidian 里改的\n')
  store = restart()
  expect((await store.files.read(courseId, 'notes.md'))?.text).toBe('在 Obsidian 里改的\n')
  expect(changes(store)[0]).toMatchObject({ actor: 'user', after: '在 Obsidian 里改的\n', reason: '在应用外修改' })
  expect(readdirSync(join(root, 'courses', '写入')).filter(name => name.endsWith('.tmp'))).toEqual([])
})

it('deletes through the same steps', async () => {
  let store = restart()
  failCommit(2)
  const before = await store.files.read(courseId, 'notes.md')
  expect(before).toBeDefined()
  await expect(store.changes.revert(changes(store).find(change => change.after === '旧\n')!.id, meta)).rejects.toThrow('注入的提交失败')
  vi.restoreAllMocks()
  expect(existsSync(fileOf('notes.md'))).toBe(false)
  store = restart()
  expect(changes(store)[0]).toMatchObject({ before: '旧\n', after: null })
  expect(intents()).toBe(0)
})
