// core (docs/core/design.md, 备份和恢复): upgrades guarded by a copy taken first, and backups that restore
// only after every file checks out. A hand-made library: the database, course files, a secret, and DSH's
// sessions and attachments next to it.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DATA_LAYOUT } from '@learning-agent/contracts'
import { MANIFEST, backup, holdLock, lockHolder, restore, verifyBackup, type BackupManifest } from '../src/backup.ts'
import { Database } from '../src/db.ts'
import { coreMigrations } from '../src/migrations.ts'

let dir = ''
const at = (...parts: string[]) => join(dir, ...parts)
const v1 = { version: 1, sql: 'CREATE TABLE demo_notes (id TEXT PRIMARY KEY, text TEXT NOT NULL)' }
const v2 = { version: 2, sql: "ALTER TABLE demo_notes ADD COLUMN tag TEXT NOT NULL DEFAULT ''" }

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'learning-backup-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

it('refuses data written by a newer program, and copies the database before upgrading existing data', () => {
  const file = at('home', DATA_LAYOUT.database)
  const backups = at('home', DATA_LAYOUT.upgradeBackups)
  const first = new Database(file, backups)
  first.migrate('demo', [v1])
  first.sqlite.prepare("INSERT INTO demo_notes VALUES ('n1', '旧的笔记')").run()
  // A unit without data yet needs no copy.
  expect(existsSync(backups)).toBe(false)
  first.migrate('demo', [v1, v2])
  first.close()
  const copies = readdirSync(backups)
  expect(copies).toHaveLength(1)
  const copy = new DatabaseSync(join(backups, copies[0]!))
  expect(copy.prepare("SELECT MAX(version) AS v FROM core_migrations WHERE unit = 'demo'").get()).toMatchObject({ v: 1 })
  expect(copy.prepare('SELECT text FROM demo_notes').all()).toEqual([{ text: '旧的笔记' }])
  copy.close()

  // The older program finds version 2 and does not load the unit.
  const older = new Database(file, backups)
  expect(() => older.migrate('demo', [v1])).toThrow('学习库是新版本程序写的（demo 的数据是第 2 版，这个程序只认识到第 1 版）')
  older.close()
})

it('says where the copy is when an upgrade fails, and the copy brings the old data back', () => {
  const file = at('home', DATA_LAYOUT.database)
  const backups = at('home', DATA_LAYOUT.upgradeBackups)
  const first = new Database(file, backups)
  first.migrate('demo', [v1])
  first.sqlite.prepare("INSERT INTO demo_notes VALUES ('n1', '旧的笔记')").run()
  first.close()

  const broken = { version: 2, sql: 'ALTER TABLE demo_notes ADD COLUMN tag TEXT NOT NULL' }
  const upgrading = new Database(file, backups)
  let message = ''
  try { upgrading.migrate('demo', [v1, broken]) } catch (error) { message = (error as Error).message }
  upgrading.close()
  expect(message).toMatch(/demo 升级到第 2 版失败（.+）。升级前的数据库备份在 .+learning-.+\.db。/)
  const copy = /备份在 (.+\.db)。/.exec(message)![1]!

  // Put the copy back and the old program runs as before.
  rmSync(file, { force: true })
  rmSync(`${file}-wal`, { force: true })
  rmSync(`${file}-shm`, { force: true })
  writeFileSync(file, readFileSync(copy))
  const restored = new Database(file, backups)
  restored.migrate('demo', [v1])
  expect(restored.sqlite.prepare('SELECT text FROM demo_notes').all()).toEqual([{ text: '旧的笔记' }])
  restored.close()
})

it('keeps the latest three copies taken before upgrades', () => {
  const file = at('home', DATA_LAYOUT.database)
  const backups = at('home', DATA_LAYOUT.upgradeBackups)
  mkdirSync(backups, { recursive: true })
  for (const day of ['01', '02', '03', '04']) writeFileSync(join(backups, `learning-2026-10-${day}T00-00-00-000Z.db`), '')
  const first = new Database(file, backups)
  first.migrate('demo', [v1])
  first.migrate('demo', [v1, v2])
  first.close()
  const copies = readdirSync(backups).sort()
  expect(copies).toHaveLength(3)
  expect(copies.slice(0, 2)).toEqual(['learning-2026-10-03T00-00-00-000Z.db', 'learning-2026-10-04T00-00-00-000Z.db'])
})

/** A library with a course file, a PDF, a secret and a link; DSH with this library's session, another one, and an image. */
function library(): { home: string; dsh: string; db: Database } {
  const home = at('home')
  const dsh = at('dsh')
  const db = new Database(join(home, DATA_LAYOUT.database), join(home, DATA_LAYOUT.upgradeBackups))
  db.migrate('core', coreMigrations)
  db.sqlite.prepare("INSERT INTO core_sessions (session_id, course_id, role, data) VALUES ('sess-ours', 'course_1', 'teacher', '{}')").run()
  write(join(home, 'courses', '流体', 'course.md'), '# 流体（合成）\n')
  write(join(home, 'library', 'src_1-合成教材', 'source.pdf'), '%PDF-合成\n')
  write(join(home, DATA_LAYOUT.cache, 'page-1.png'), 'cache')
  write(join(home, '.env'), 'DEEPSEEK_API_KEY=合成的假密钥\n')
  symlinkSync(join(home, 'courses'), join(home, 'courses-link'))
  write(join(dsh, 'sessions', '--home-courses-流体--', 'sess-ours', 'session.v4.jsonl'), '{"合成":1}\n')
  write(join(dsh, 'sessions', '--elsewhere--', 'sess-other', 'session.v4.jsonl'), '{"别的":1}\n')
  write(join(dsh, 'attachments', 'v1', 'ab', 'abcdef.png'), 'png')
  write(join(dsh, '.credentials.yaml'), 'secret: 合成\n')
  return { home, dsh, db }
}

it('backs up a stopped library as one moment: the database with its WAL, the files, the sessions it owns, no secrets', async () => {
  const { home, dsh, db } = library()
  // Written but still only in the WAL: the database stays open, as after a crash.
  db.sqlite.prepare("INSERT INTO core_sessions (session_id, course_id, role, data) VALUES ('sess-late', 'course_1', 'side-chat', '{}')").run()

  const release = holdLock(home)
  expect(lockHolder(home)?.pid).toBe(process.pid)
  await expect(backup({ dataRoot: home, target: at('backup'), dshHome: dsh })).rejects.toThrow(/学习库正在被使用（进程 \d+.*先停掉 DSH 再备份/)
  expect(existsSync(at('backup'))).toBe(false)
  release()
  // A record left by a process that is gone does not block.
  write(join(home, DATA_LAYOUT.lock), JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: '2026-11-01T00:00:00Z' }))

  await expect(backup({ dataRoot: home, target: join(home, 'backup'), dshHome: dsh })).rejects.toThrow('备份不能放在学习库里面')
  const manifest = await backup({ dataRoot: home, target: at('backup'), dshHome: dsh })
  db.close()

  expect(manifest.files.map(file => file.path).sort()).toEqual([
    'dsh/attachments/v1/ab/abcdef.png',
    'dsh/sessions/--home-courses-流体--/sess-ours/session.v4.jsonl',
    'home/.learning/learning.db',
    'home/courses/流体/course.md',
    'home/library/src_1-合成教材/source.pdf',
  ])
  expect(manifest.migrations).toEqual({ core: coreMigrations.length })
  expect(manifest.notIncluded.map(item => item.path)).toEqual(expect.arrayContaining(['.env', 'courses-link', 'DSH 会话 sess-late']))
  expect(JSON.stringify(manifest)).not.toContain('合成的假密钥')
  const copy = new DatabaseSync(at('backup', 'home', DATA_LAYOUT.database))
  expect(copy.prepare('SELECT session_id FROM core_sessions ORDER BY session_id').all()).toEqual([{ session_id: 'sess-late' }, { session_id: 'sess-ours' }])
  copy.close()
  expect(readdirSync(at('backup', 'home', '.learning'))).toEqual(['learning.db'])

  await expect(backup({ dataRoot: home, target: at('backup'), dshHome: dsh })).rejects.toThrow('备份目标必须是一个不存在的或者空的文件夹')
})

it('restores into a new folder only after every file checks out, and gives DSH back the sessions it lacks', async () => {
  const { home, dsh, db } = library()
  db.close()
  await backup({ dataRoot: home, target: at('backup'), dshHome: dsh })

  // A changed file, then a missing one: nothing is written.
  const pdf = at('backup', 'home', 'library', 'src_1-合成教材', 'source.pdf')
  writeFileSync(pdf, '%PDF-被改过\n')
  await expect(restore({ source: at('backup'), target: at('restored') })).rejects.toThrow(/备份校验没有通过，什么都没有写入：\n {2}home\/library\/src_1-合成教材\/source.pdf：内容和清单不一致/)
  rmSync(pdf)
  await expect(verifyBackup(at('backup'))).rejects.toThrow('source.pdf：缺失')
  expect(existsSync(at('restored'))).toBe(false)
  writeFileSync(pdf, '%PDF-合成\n')

  // A manifest that would write outside the target is refused.
  const manifest = JSON.parse(readFileSync(at('backup', MANIFEST), 'utf8')) as BackupManifest
  writeFileSync(at('backup', MANIFEST), JSON.stringify({ ...manifest, files: [...manifest.files, { path: 'home/../../escape.txt', size: 0, sha256: '' }] }))
  await expect(restore({ source: at('backup'), target: at('restored') })).rejects.toThrow('home/../../escape.txt：不是备份里的路径')
  writeFileSync(at('backup', MANIFEST), JSON.stringify(manifest))

  mkdirSync(at('busy'))
  writeFileSync(at('busy', 'x.md'), '')
  await expect(restore({ source: at('backup'), target: at('busy') })).rejects.toThrow('恢复目标必须是一个不存在的或者空的文件夹')

  // A new DSH home has neither session; the old one keeps its own as it is.
  const fresh = at('dsh-new')
  const result = await restore({ source: at('backup'), target: at('restored'), dshHome: fresh })
  expect(result).toMatchObject({ files: 3, sessions: { restored: 1, kept: 0 } })
  expect(readFileSync(at('restored', 'courses', '流体', 'course.md'), 'utf8')).toBe('# 流体（合成）\n')
  expect(existsSync(at('restored', '.env'))).toBe(false)
  expect(readFileSync(join(fresh, 'sessions', '--home-courses-流体--', 'sess-ours', 'session.v4.jsonl'), 'utf8')).toBe('{"合成":1}\n')
  expect(existsSync(join(fresh, 'sessions', '--elsewhere--'))).toBe(false)
  expect(readFileSync(join(fresh, 'attachments', 'v1', 'ab', 'abcdef.png'), 'utf8')).toBe('png')
  const again = await restore({ source: at('backup'), target: at('restored-2'), dshHome: dsh })
  expect(again.sessions).toEqual({ restored: 0, kept: 1 })

  const restored = new Database(at('restored', DATA_LAYOUT.database))
  expect(restored.sqlite.prepare('SELECT session_id FROM core_sessions').all()).toEqual([{ session_id: 'sess-ours' }])
  restored.close()
})
