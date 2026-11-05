// What the desktop shell does around DSH, without Electron, so tests can run it
// (docs/settings/proposals/2026-11-05-windows-installer.md, 运行时的行为).
//
// The installer carries a pre-installed `learning` profile. The profile in DSH_HOME belongs to the learner
// where it holds their choices: cordis.patch.yml (settings saved from the settings page) is never replaced.
// Everything else in it is ours and is replaced whenever the installed version differs from the one the
// profile was last filled from.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'

/** Files of the profile that belong to the learner. */
export const LEARNER_FILES = new Set(['cordis.patch.yml'])
/** Marks which installed version filled a profile. */
export const VERSION_FILE = '.microsight-version'
/** How many backups made before upgrades are kept. */
export const KEPT_BACKUPS = 3

export interface Settings {
  /** The learning library, LEARNING_HOME for DSH; unset until the first start asks. */
  readonly learningHome?: string
}

export function readSettings(file: string): Settings {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return value && typeof value === 'object' ? value as Settings : {}
  } catch {
    return {} // no file yet, or one the learner broke: the first start asks again
  }
}

export function writeSettings(file: string, settings: Settings): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
}

/** The version that last filled the profile, undefined for a profile never filled. */
export function profileVersion(profile: string): string | undefined {
  try {
    return readFileSync(join(profile, VERSION_FILE), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Fill the profile from the installed template when its version differs: our files are replaced whole,
 * the learner's are copied only when missing. Returns the version the profile had before, if any.
 */
export function syncProfile(template: string, profile: string, version: string): { changed: boolean; previous?: string } {
  const previous = profileVersion(profile)
  if (previous === version) return { changed: false, previous }
  mkdirSync(profile, { recursive: true })
  for (const entry of readdirSync(profile)) {
    if (!LEARNER_FILES.has(entry)) rmSync(join(profile, entry), { recursive: true, force: true })
  }
  for (const entry of readdirSync(template)) {
    if (LEARNER_FILES.has(entry) && existsSync(join(profile, entry))) continue
    cpSync(join(template, entry), join(profile, entry), { recursive: true })
  }
  writeFileSync(join(profile, VERSION_FILE), version + '\n')
  return { changed: true, ...(previous ? { previous } : {}) }
}

/** Whether a learning library already holds data worth backing up. */
export function hasLibrary(learningHome: string): boolean {
  return existsSync(join(learningHome, '.learning', 'learning.db'))
}

/** Where backups made before upgrades go: next to the library, so they survive uninstalling. */
export function backupsRoot(learningHome: string): string {
  return join(dirname(learningHome), '知微备份')
}

/** A folder name for a backup made before upgrading from `previous`, sortable by time. */
export function backupName(previous: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  return `${stamp}-v${previous}`
}

/** Delete all but the newest `keep` backups this shell made; anything else in the folder is left alone. */
export function pruneBackups(root: string, keep = KEPT_BACKUPS): string[] {
  if (!existsSync(root)) return []
  const ours = readdirSync(root).filter(name => /^\d{8}-\d{6}-v/.test(name)).sort()
  const removed = ours.slice(0, Math.max(0, ours.length - keep))
  for (const name of removed) rmSync(join(root, name), { recursive: true, force: true })
  return removed
}

/** The page address DSH prints once it listens ("dsh web: http://127.0.0.1:<port>/?token=…"). */
export function pageUrl(output: string): string | undefined {
  return /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*)/.exec(output)?.[1]
}

/** A free port on the loopback interface. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/**
 * The environment DSH runs with: the parent's, minus anything that would point DSH at other keys,
 * services or homes (a developer's shell may export them), plus our two homes.
 */
export function dshEnv(parent: NodeJS.ProcessEnv, dshHome: string, learningHome: string): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(parent).filter(([name]) => !/^(DSH_|LEARNING_|DEEPSEEK_)|_API_KEY$/i.test(name)))
  return { ...kept, DSH_HOME: dshHome, LEARNING_HOME: learningHome, NO_COLOR: '1' }
}

/** Run a Node script to its end, resolving with its exit code and output. */
export function runNode(node: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    const child = spawn(node, args, { cwd: options.cwd, env: options.env, windowsHide: true })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', error => resolve({ code: -1, output: output + String(error) }))
    child.on('close', code => resolve({ code: code ?? -1, output }))
  })
}
