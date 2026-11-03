// Backup and restore of one learning library (docs/core/design.md, 备份和恢复).
// A backup holds the database as one consistent file, every other file of the library, and the DSH sessions
// the library's courses own, with a manifest of sizes and SHA-256 hashes. Restore checks every file against the
// manifest before writing anything, and only into a new folder. DSH's session folders are copied as they are,
// never parsed: their layout belongs to DSH.
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { DATA_LAYOUT } from '@learning-agent/contracts'
import { migrationVersions, snapshot } from './db.ts'

export const MANIFEST = 'manifest.json'

/** Data root: LEARNING_HOME, else `Documents/学习库` (contracts §3.1). */
export function resolveDataRoot(): string {
  return resolve(process.env.LEARNING_HOME || join(homedir(), 'Documents', '学习库'))
}

/** DSH's home, resolved the way DSH does (`DSH_HOME`, else `~/.dsh`); DSH's own helper is not reachable outside DSH. */
export function resolveDshHome(): string {
  const configured = process.env.DSH_HOME
  return resolve(configured && configured.trim() ? configured : join(homedir(), '.dsh'))
}

export interface ManifestFile {
  /** Relative to the backup folder, forward slashes: `library/…` and `courses/…` under `home/`, DSH's under `dsh/`. */
  readonly path: string
  readonly size: number
  readonly sha256: string
}

export interface BackupManifest {
  readonly format: 1
  readonly createdAt: string
  /** The code that wrote the backup, when it runs from a git checkout. */
  readonly commit: string | null
  /** Where the library was; DSH keeps its sessions under the course folders' paths as they were then. */
  readonly dataRoot: string
  readonly dshHome: string | null
  /** Each unit's schema version in the backed-up database. */
  readonly migrations: Record<string, number>
  readonly files: readonly ManifestFile[]
  /** What was deliberately left out, and why. */
  readonly notIncluded: readonly { readonly path: string; readonly why: string }[]
}

// ── the running check ──────────────────────────────────────────────────────

interface LockRecord {
  readonly pid: number
  readonly startedAt: string
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Record that this process has the library open; the returned function removes the record again. */
export function holdLock(dataRoot: string): () => void {
  const file = join(dataRoot, DATA_LAYOUT.lock)
  mkdirSync(dirname(file), { recursive: true })
  const record: LockRecord = { pid: process.pid, startedAt: new Date().toISOString() }
  writeFileSync(file, JSON.stringify(record))
  return () => {
    // Another start on the same library may have taken the record over since; leave its record alone.
    if (lockHolder(dataRoot)?.pid === process.pid) rmSync(file, { force: true })
  }
}

/** The live process that has the library open, if any. A record left by a process that ended is ignored. */
export function lockHolder(dataRoot: string): LockRecord | undefined {
  let record: LockRecord
  try {
    record = JSON.parse(readFileSync(join(dataRoot, DATA_LAYOUT.lock), 'utf8')) as LockRecord
  } catch {
    return undefined
  }
  return Number.isInteger(record.pid) && processAlive(record.pid) ? record : undefined
}

// ── files ──────────────────────────────────────────────────────────────────

/** Library paths that are not copied as files: the database is written as a snapshot instead; the rest can be rebuilt. */
const NOT_COPIED = [
  `${DATA_LAYOUT.database}`, `${DATA_LAYOUT.database}-wal`, `${DATA_LAYOUT.database}-shm`, `${DATA_LAYOUT.database}-journal`,
  DATA_LAYOUT.lock,
]
const NOT_COPIED_FOLDERS = [DATA_LAYOUT.cache, DATA_LAYOUT.upgradeBackups]
const SECRET_NAMES = /^(\.env(\..*)?|\.credentials\.ya?ml)$/

function posix(path: string): string {
  return path.split(sep).join('/')
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** A manifest path that stays where it is put: forward slashes, no empty, `.` or `..` parts. */
function plainPath(path: string): boolean {
  return !path.includes('\\') && !path.includes(':') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

/** Every regular file under `root` as forward-slash relative paths; symbolic links are reported, not followed. */
function walk(root: string, skip: (path: string) => boolean, links: string[], at = ''): string[] {
  const files: string[] = []
  for (const entry of readdirSync(join(root, at), { withFileTypes: true })) {
    const path = at ? `${at}/${entry.name}` : entry.name
    if (skip(path)) continue
    if (entry.isSymbolicLink()) links.push(path)
    else if (entry.isDirectory()) files.push(...walk(root, skip, links, path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** A folder that does not exist yet or is empty. */
function usableTarget(target: string, what: string): void {
  if (!existsSync(target)) return
  if (!statSync(target).isDirectory() || readdirSync(target).length > 0) {
    throw new Error(`${what}必须是一个不存在的或者空的文件夹：${target}`)
  }
}

/** Write into a hidden folder next to the target and move it into place at the end, so a failure leaves no half result. */
async function intoPlace<T>(target: string, fill: (folder: string) => Promise<T>): Promise<T> {
  const partial = join(dirname(target), `.${basename(target)}.partial-${randomUUID().slice(0, 8)}`)
  mkdirSync(partial, { recursive: true })
  try {
    const result = await fill(partial)
    if (existsSync(target)) rmdirSync(target)
    renameSync(partial, target)
    return result
  } catch (error) {
    rmSync(partial, { recursive: true, force: true })
    throw error
  }
}

function gitCommit(): string | null {
  try {
    // packages/core/src or packages/core/lib → the repository root.
    const head = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.git')
    if (!existsSync(head)) return null
    const ref = readFileSync(join(head, 'HEAD'), 'utf8').trim()
    if (!ref.startsWith('ref: ')) return ref
    const file = join(head, ref.slice(5))
    if (existsSync(file)) return readFileSync(file, 'utf8').trim()
    const packed = readFileSync(join(head, 'packed-refs'), 'utf8').split('\n').find(line => line.endsWith(` ${ref.slice(5)}`))
    return packed?.split(' ')[0] ?? null
  } catch {
    return null
  }
}

// ── backup ─────────────────────────────────────────────────────────────────

export interface BackupOptions {
  readonly dataRoot: string
  readonly target: string
  /** DSH's home, for the sessions the courses own; omitted, the backup holds no sessions. */
  readonly dshHome?: string
}

/**
 * Back up one library while DSH is stopped. Refuses while a process has the library open, since files and
 * database written meanwhile would not be from the same moment.
 */
export async function backup(options: BackupOptions): Promise<BackupManifest> {
  const dataRoot = resolve(options.dataRoot)
  const target = resolve(options.target)
  const database = join(dataRoot, DATA_LAYOUT.database)
  if (!existsSync(database)) throw new Error(`这里没有学习库：${dataRoot}（找不到 ${DATA_LAYOUT.database}）`)
  const holder = lockHolder(dataRoot)
  if (holder) throw new Error(`学习库正在被使用（进程 ${holder.pid}，${holder.startedAt} 启动）。先停掉 DSH 再备份，备份里的数据库和文件才是同一时刻的。`)
  if (inside(dataRoot, target)) throw new Error(`备份不能放在学习库里面：${target}`)
  usableTarget(target, '备份目标')

  return intoPlace(target, async folder => {
    const files: ManifestFile[] = []
    const notIncluded: { path: string; why: string }[] = [
      { path: '.env、DSH 的 .credentials.yaml', why: '密钥不进备份：备份可能被拷到别处，恢复后在设置页重填' },
    ]
    const add = async (path: string) => {
      const full = join(folder, path)
      files.push({ path, size: statSync(full).size, sha256: await sha256(full) })
    }

    // The database as one consistent file, with what is still in the WAL.
    const sqlite = new DatabaseSync(database)
    let migrations: Record<string, number>
    let sessionIds: string[]
    try {
      snapshot(sqlite, join(folder, 'home', DATA_LAYOUT.database))
      migrations = migrationVersions(sqlite)
      sessionIds = (sqlite.prepare('SELECT session_id FROM core_sessions').all() as { session_id: string }[]).map(row => row.session_id)
    } finally {
      sqlite.close()
    }
    await add(`home/${DATA_LAYOUT.database}`)

    // Every other file of the library.
    const links: string[] = []
    const skip = (path: string) => {
      if (NOT_COPIED.includes(path as never) || NOT_COPIED_FOLDERS.some(dir => path === dir || path.startsWith(`${dir}/`))) return true
      if (SECRET_NAMES.test(path.split('/').at(-1)!)) {
        notIncluded.push({ path, why: '密钥文件' })
        return true
      }
      return false
    }
    for (const path of walk(dataRoot, skip, links)) {
      mkdirSync(dirname(join(folder, 'home', path)), { recursive: true })
      copyFileSync(join(dataRoot, path), join(folder, 'home', path))
      await add(`home/${path}`)
    }
    for (const path of links) notIncluded.push({ path, why: '符号链接，不跟随' })

    // The library's DSH sessions, found by id (a session folder is named after its id), copied as they are.
    // DSH's attachment store is shared by all its sessions and holds no index, so it is copied whole.
    const dshHome = options.dshHome ? resolve(options.dshHome) : undefined
    if (dshHome) {
      const sessionsRoot = join(dshHome, 'sessions')
      const wanted = new Set(sessionIds.filter(id => /^[A-Za-z0-9._-]+$/.test(id)))
      const projects = existsSync(sessionsRoot) ? readdirSync(sessionsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()) : []
      const found = new Set<string>()
      for (const project of projects) {
        for (const session of readdirSync(join(sessionsRoot, project.name), { withFileTypes: true })) {
          if (!session.isDirectory() || !wanted.has(session.name)) continue
          found.add(session.name)
          const at = `${project.name}/${session.name}`
          for (const path of walk(join(sessionsRoot, at), () => false, [])) {
            mkdirSync(dirname(join(folder, 'dsh', 'sessions', at, path)), { recursive: true })
            copyFileSync(join(sessionsRoot, at, path), join(folder, 'dsh', 'sessions', at, path))
            await add(`dsh/sessions/${at}/${path}`)
          }
        }
      }
      for (const id of wanted) if (!found.has(id)) notIncluded.push({ path: `DSH 会话 ${id}`, why: 'DSH 里没有这个会话的记录' })
      const attachments = join(dshHome, 'attachments')
      if (existsSync(attachments)) {
        for (const path of walk(attachments, () => false, [])) {
          mkdirSync(dirname(join(folder, 'dsh', 'attachments', path)), { recursive: true })
          copyFileSync(join(attachments, path), join(folder, 'dsh', 'attachments', path))
          await add(`dsh/attachments/${path}`)
        }
      }
    }

    const manifest: BackupManifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      commit: gitCommit(),
      dataRoot,
      dshHome: dshHome ?? null,
      migrations,
      files,
      notIncluded,
    }
    writeFileSync(join(folder, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
    return manifest
  })
}

// ── restore ────────────────────────────────────────────────────────────────

function readManifest(source: string): BackupManifest {
  const file = join(source, MANIFEST)
  if (!existsSync(file)) throw new Error(`这不是一份备份：${source} 里没有 ${MANIFEST}`)
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as BackupManifest
  if (manifest.format !== 1 || !Array.isArray(manifest.files)) throw new Error(`不认识这份备份的格式：${file}`)
  return manifest
}

/** Check every file of a backup against its manifest; returns the manifest, or throws listing what is wrong. */
export async function verifyBackup(source: string): Promise<BackupManifest> {
  const root = resolve(source)
  const manifest = readManifest(root)
  const problems: string[] = []
  for (const file of manifest.files) {
    const full = resolve(root, file.path)
    if (typeof file.path !== 'string' || !plainPath(file.path) || !/^(home|dsh)\//.test(file.path)) problems.push(`${file.path}：不是备份里的路径`)
    else if (!existsSync(full) || !lstatSync(full).isFile()) problems.push(`${file.path}：缺失`)
    else if (statSync(full).size !== file.size || await sha256(full) !== file.sha256) problems.push(`${file.path}：内容和清单不一致`)
  }
  if (!manifest.files.some(file => file.path === `home/${DATA_LAYOUT.database}`)) problems.push(`home/${DATA_LAYOUT.database}：备份里没有数据库`)
  if (problems.length > 0) {
    const shown = problems.slice(0, 10).join('\n  ')
    throw new Error(`备份校验没有通过，什么都没有写入：\n  ${shown}${problems.length > 10 ? `\n  ……共 ${problems.length} 处` : ''}`)
  }
  return manifest
}

export interface RestoreOptions {
  readonly source: string
  /** A new library folder: must not exist yet, or be empty. */
  readonly target: string
  /** DSH's home: sessions missing there are put back; ones it already has are kept as they are. */
  readonly dshHome?: string
}

export interface RestoreResult {
  readonly manifest: BackupManifest
  readonly files: number
  /** DSH sessions put back, and ones left alone because DSH already has them. */
  readonly sessions: { readonly restored: number; readonly kept: number }
}

/** Restore a backup into a new library folder after checking every file. Never writes over a library in use. */
export async function restore(options: RestoreOptions): Promise<RestoreResult> {
  const source = resolve(options.source)
  const target = resolve(options.target)
  usableTarget(target, '恢复目标')
  if (inside(source, target)) throw new Error(`不能恢复到备份文件夹里面：${target}`)
  const manifest = await verifyBackup(source)

  const home = manifest.files.filter(file => file.path.startsWith('home/'))
  await intoPlace(target, async folder => {
    for (const file of home) {
      const to = join(folder, file.path.slice('home/'.length))
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(join(source, file.path), to)
    }
  })

  // DSH sessions keep the folders they were made in; DSH finds them by id. Ones DSH already has stay as they are.
  let restored = 0
  let kept = 0
  if (options.dshHome) {
    const dshHome = resolve(options.dshHome)
    const sessionsRoot = join(dshHome, 'sessions')
    const present = new Set<string>()
    if (existsSync(sessionsRoot)) {
      for (const project of readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (project.isDirectory()) for (const session of readdirSync(join(sessionsRoot, project.name))) present.add(session)
      }
    }
    const sessions = new Map<string, ManifestFile[]>()
    for (const file of manifest.files) {
      const match = /^dsh\/sessions\/([^/]+)\/([^/]+)\//.exec(file.path)
      if (match) sessions.set(`${match[1]}/${match[2]}`, [...sessions.get(`${match[1]}/${match[2]}`) ?? [], file])
    }
    for (const [at, files] of sessions) {
      if (present.has(at.split('/')[1]!)) {
        kept += 1
        continue
      }
      for (const file of files) {
        const to = join(sessionsRoot, file.path.slice('dsh/sessions/'.length))
        mkdirSync(dirname(to), { recursive: true })
        copyFileSync(join(source, file.path), to)
      }
      restored += 1
    }
    for (const file of manifest.files.filter(file => file.path.startsWith('dsh/attachments/'))) {
      const to = join(dshHome, 'attachments', file.path.slice('dsh/attachments/'.length))
      if (existsSync(to)) continue
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(join(source, file.path), to)
    }
  }
  return { manifest, files: home.length, sessions: { restored, kept } }
}
