// Pack the built workbench into tarballs a fresh DSH profile installs with `dsh plugin add`:
// one per unit plus the @learning-agent/app bundle, all at the bundle's version, in dist/.
// Run after `pnpm build`:   node scripts/pack.mjs
//
// The build bundles every dependency except DSH's packages and React (scripts/build.mjs), so a packed
// package keeps only its DSH peers; contracts and kit are already inside each bundle and are not packed.
// The bundle names its units by package name, so the profile installs them side by side, not as the
// bundle's dependencies: `dsh plugin add dist/*.tgz`. engines.dsh pins the DSH this repo is tested
// against (scripts/dsh/package.json), which DSH checks on install and on every start.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist')
const stage = join(root, '.scratch', 'pack')
const SKIPPED = new Set(['contracts', 'kit'])

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const app = readJson(join(root, 'packages/app/package.json'))
const dsh = readJson(join(root, 'scripts/dsh/package.json')).dependencies['@deepseek-ai/dsh']
const version = app.version

rmSync(out, { recursive: true, force: true })
rmSync(stage, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const units = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !SKIPPED.has(entry.name) && existsSync(join(root, 'packages', entry.name, 'package.json')))
  .map(entry => entry.name)

for (const unit of units) {
  const from = join(root, 'packages', unit)
  const manifest = readJson(join(from, 'package.json'))
  const exported = Object.values(manifest.exports ?? {}).filter(target => typeof target === 'string' && target.startsWith('./lib/'))
  for (const target of exported) {
    if (!existsSync(join(from, target))) throw new Error(`packages/${unit}: ${target} is missing; run pnpm build first`)
  }
  const to = join(stage, unit)
  mkdirSync(to, { recursive: true })
  const files = ['lib', 'locale', 'icon.svg', 'cordis.patch.yml'].filter(name => existsSync(join(from, name)))
  // Source maps are about as large as the code and only help a debugger, so the packed copy leaves them out.
  for (const name of files) cpSync(join(from, name), join(to, name), { recursive: true, filter: path => !path.endsWith('.map') })
  cpSync(join(root, 'LICENSE'), join(to, 'LICENSE'))

  const { private: _private, dependencies: _dependencies, devDependencies: _devDependencies, ...kept } = manifest
  const packed = {
    ...kept,
    version,
    repository: { type: 'git', url: 'git+https://github.com/sagemoyi/learning-agent.git', directory: `packages/${unit}` },
    files: [...files, 'LICENSE'],
    ...(manifest.dsh?.bundle ? { engines: { ...manifest.engines, dsh: dsh } } : {}),
  }
  writeFileSync(join(to, 'package.json'), JSON.stringify(packed, null, 2) + '\n')
  execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: to, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' })
}

const tarballs = readdirSync(out).filter(name => name.endsWith('.tgz')).sort()
console.log(`packed ${tarballs.length} packages at ${version} for DSH ${dsh} into dist/:\n  ${tarballs.join('\n  ')}`)
