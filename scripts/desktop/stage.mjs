// Assemble what the desktop installer carries into apps/desktop/.stage, on the platform it is for
// (Windows x64 for the installer; Linux x64 to try the shell here). Run after `pnpm build` and `pnpm dist`:
//   node scripts/desktop/stage.mjs
// - node/     the Node runtime pinned in apps/desktop/node.lock.json, checked against its SHA-256;
// - dsh/      DSH installed by `npm ci` from scripts/dsh (the same lock the repo develops against);
// - profile/  a `learning` profile with dist/*.tgz installed by DSH's own `dsh plugin add`, laid out flat
//             (pnpm's hoisted linker) so it copies without symbolic links;
// - icon.png  the window icon.
// See docs/settings/proposals/2026-11-05-windows-installer.md, 结构.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const stage = join(root, 'apps/desktop/.stage')
const target = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
const lock = JSON.parse(readFileSync(join(root, 'apps/desktop/node.lock.json'), 'utf8'))
const windows = process.platform === 'win32'
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', shell: windows && command !== process.execPath, ...options })

if (!lock.sha256[target]) throw new Error(`no Node pinned for ${target} in apps/desktop/node.lock.json`)
const tarballs = existsSync(join(root, 'dist')) ? readdirSync(join(root, 'dist')).filter(name => name.endsWith('.tgz')) : []
if (tarballs.length === 0) throw new Error('dist/ is empty: run pnpm build and pnpm dist first')

rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })

// node/
const archive = `node-v${lock.version}-${target}.${windows ? 'zip' : 'tar.xz'}`
const response = await fetch(`https://nodejs.org/dist/v${lock.version}/${archive}`)
if (!response.ok) throw new Error(`downloading ${archive}: HTTP ${response.status}`)
const bytes = Buffer.from(await response.arrayBuffer())
const digest = createHash('sha256').update(bytes).digest('hex')
if (digest !== lock.sha256[target]) throw new Error(`${archive}: SHA-256 ${digest} is not the pinned ${lock.sha256[target]}`)
const unpack = mkdtempSync(join(tmpdir(), 'microsight-node-'))
writeFileSync(join(unpack, archive), bytes)
// Windows' own tar (bsdtar) reads zip; Git Bash's GNU tar, which may come first on PATH, does not.
run(windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xf', archive], { cwd: unpack })
// Only the executable and its licence: npm, corepack and the headers are never run on the learner's machine.
const unpacked = join(unpack, archive.replace(/\.(zip|tar\.xz)$/, ''))
const executable = windows ? 'node.exe' : 'bin/node'
mkdirSync(join(stage, 'node', dirname(executable)), { recursive: true })
renameSync(join(unpacked, executable), join(stage, 'node', executable))
renameSync(join(unpacked, 'LICENSE'), join(stage, 'node', 'LICENSE'))
rmSync(unpack, { recursive: true, force: true })
const node = join(stage, 'node', executable)

// dsh/: npm here is the build machine's; the staged Node only runs DSH.
mkdirSync(join(stage, 'dsh'))
for (const file of ['package.json', 'package-lock.json']) cpSync(join(root, 'scripts/dsh', file), join(stage, 'dsh', file))
run('npm', ['ci', '--omit=dev', '--no-fund', '--no-audit'], { cwd: join(stage, 'dsh') })
const bin = join(stage, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')

// profile/: DSH installs into $DSH_HOME/profiles/learning, so it is built in a throwaway home and moved.
const home = mkdtempSync(join(tmpdir(), 'microsight-home-'))
const profile = join(home, 'profiles', 'learning')
mkdirSync(join(profile, 'vendor'), { recursive: true })
for (const file of readdirSync(join(root, 'profile'))) cpSync(join(root, 'profile', file), join(profile, file))
writeFileSync(join(profile, 'pnpm-workspace.yaml'), readFileSync(join(profile, 'pnpm-workspace.yaml'), 'utf8') +
  '# Installed copies are plain folders, so the installer can carry the profile without symbolic links.\nnodeLinker: hoisted\n')
for (const name of tarballs) cpSync(join(root, 'dist', name), join(profile, 'vendor', name))
const env = { ...process.env, DSH_HOME: home }
for (const name of Object.keys(env)) if (/^(LEARNING_|DEEPSEEK_)|_API_KEY$/i.test(name)) delete env[name]
run(node, [bin, 'plugin', '--profile', 'learning', 'add', ...tarballs.map(name => `./vendor/${name}`)], { cwd: profile, env })
// The installed copy may live anywhere: name the tarballs relative to the profile, not this machine.
const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
  const file = String(spec).split('/').pop()
  if (tarballs.includes(file)) manifest.dependencies[name] = `file:vendor/${file}`
}
writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
rmSync(join(profile, 'pnpm-lock.yaml'), { force: true })
cpSync(profile, join(stage, 'profile'), { recursive: true })
rmSync(home, { recursive: true, force: true })

cpSync(join(root, 'apps/desktop/build/icon.png'), join(stage, 'icon.png'))
console.log(`staged Node ${lock.version}, DSH and the learning profile (${tarballs.length} packages) for ${target} in apps/desktop/.stage`)
