// What the desktop shell does around DSH (docs/settings/proposals/2026-11-05-windows-installer.md, 运行时的行为):
// profile sync that keeps the learner's settings, backups before upgrades, the page address and the environment.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  backupName, backupsRoot, dshEnv, hasLibrary, pageUrl, profileVersion, pruneBackups, readSettings, syncProfile, writeSettings,
} from '../../apps/desktop/src/runtime.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'microsight-test-'))
  dirs.push(dir)
  return dir
}

function template(root: string, marker: string): string {
  const dir = join(root, `template-${marker}`)
  mkdirSync(join(dir, 'node_modules', 'unit'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), marker)
  writeFileSync(join(dir, 'node_modules', 'unit', 'index.js'), marker)
  writeFileSync(join(dir, 'cordis.patch.yml'), `template ${marker}`)
  return dir
}

it('fills a new profile, keeps the learner settings on upgrade and removes files the new version dropped', () => {
  const root = temp()
  const profile = join(root, 'profile')
  expect(syncProfile(template(root, '1'), profile, '0.1.0')).toEqual({ changed: true })
  expect(profileVersion(profile)).toBe('0.1.0')
  expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toBe('template 1')

  writeFileSync(join(profile, 'cordis.patch.yml'), 'learner')
  writeFileSync(join(profile, 'stale.txt'), 'old')
  expect(syncProfile(template(root, '1'), profile, '0.1.0')).toEqual({ changed: false, previous: '0.1.0' })
  expect(readFileSync(join(profile, 'stale.txt'), 'utf8')).toBe('old')

  expect(syncProfile(template(root, '2'), profile, '0.2.0')).toEqual({ changed: true, previous: '0.1.0' })
  expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toBe('learner')
  expect(readFileSync(join(profile, 'node_modules', 'unit', 'index.js'), 'utf8')).toBe('2')
  expect(readdirSync(profile)).not.toContain('stale.txt')
  expect(profileVersion(profile)).toBe('0.2.0')
})

it('names backups by time and previous version, and keeps only the newest of its own', () => {
  const root = temp()
  const library = join(root, '学习库')
  expect(hasLibrary(library)).toBe(false)
  mkdirSync(join(library, '.learning'), { recursive: true })
  writeFileSync(join(library, '.learning', 'learning.db'), '')
  expect(hasLibrary(library)).toBe(true)

  const backups = backupsRoot(library)
  expect(backups).toBe(join(root, '知微备份'))
  expect(backupName('0.1.0', new Date('2026-11-05T08:09:10Z'))).toBe('20261105-080910-v0.1.0')
  for (let day = 1; day <= 5; day++) mkdirSync(join(backups, `2026110${day}-000000-v0.1.0`), { recursive: true })
  mkdirSync(join(backups, 'my own copy'))
  expect(pruneBackups(backups)).toEqual(['20261101-000000-v0.1.0', '20261102-000000-v0.1.0'])
  expect(readdirSync(backups).sort()).toEqual(['20261103-000000-v0.1.0', '20261104-000000-v0.1.0', '20261105-000000-v0.1.0', 'my own copy'])
})

it('reads the page address DSH prints, and runs DSH without the parent shell keys or homes', () => {
  expect(pageUrl('starting\ndsh web: http://127.0.0.1:51234/?token=abc\n')).toBe('http://127.0.0.1:51234/?token=abc')
  expect(pageUrl('dsh web: http://0.0.0.0:1/')).toBeUndefined()
  const env = dshEnv({ PATH: '/bin', DEEPSEEK_API_KEY: 'k', VOYAGE_API_KEY: 'k', LEARNING_HOME: '/x', DSH_PROFILE: 'p' }, '/dsh', '/lib')
  expect(env).toEqual({ PATH: '/bin', DSH_HOME: '/dsh', LEARNING_HOME: '/lib', NO_COLOR: '1' })
})

it('treats a missing or broken settings file as a first start', () => {
  const root = temp()
  const file = join(root, 'nested', 'settings.json')
  expect(readSettings(file)).toEqual({})
  writeSettings(file, { learningHome: 'D:\\学习库' })
  expect(readSettings(file)).toEqual({ learningHome: 'D:\\学习库' })
  writeFileSync(file, '{broken')
  expect(readSettings(file)).toEqual({})
})
