// Compare what is installed in .tools/dsh with scripts/dsh/package-lock.json: every package the lock names must be there
// at that version (a platform's optional package may be absent), and nothing else may be there.
// Prints the differences and exits 1 when there are any. `--list` prints the installed name@version list instead, to
// compare two machines. Used by scripts/setup-dsh.sh.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const target = join(root, '.tools/dsh')
const lock = JSON.parse(readFileSync(join(root, 'scripts/dsh/package-lock.json'), 'utf8')).packages

/** Every package folder under a node_modules, nested ones included, as its path relative to .tools/dsh. */
function installed(modules = 'node_modules', found = []) {
  if (!existsSync(join(target, modules))) return found
  for (const entry of readdirSync(join(target, modules), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const names = entry.name.startsWith('@') ? readdirSync(join(target, modules, entry.name)).map(name => `${entry.name}/${name}`) : [entry.name]
    for (const name of names) {
      const path = `${modules}/${name}`
      if (!existsSync(join(target, path, 'package.json'))) continue
      found.push(path)
      installed(`${path}/node_modules`, found)
    }
  }
  return found
}

const versionOf = path => JSON.parse(readFileSync(join(target, path, 'package.json'), 'utf8')).version
const paths = installed()

if (process.argv.includes('--list')) {
  for (const path of paths.sort()) console.log(`${path.replace(/^node_modules\//, '')}@${versionOf(path)}`)
  process.exit(0)
}

const problems = []
const present = new Set(paths)
for (const [path, entry] of Object.entries(lock)) {
  if (!path || entry.link) continue
  if (!present.has(path)) {
    if (!entry.optional && !entry.peer && !entry.dev) problems.push(`缺少 ${path}@${entry.version}`)
  } else if (versionOf(path) !== entry.version) {
    problems.push(`${path}：装的是 ${versionOf(path)}，锁文件是 ${entry.version}`)
  }
}
for (const path of paths) if (!lock[path]) problems.push(`多出来的 ${path}@${versionOf(path)}`)

if (problems.length) {
  console.error(`.tools/dsh 和 scripts/dsh/package-lock.json 不一致（${problems.length} 处）：`)
  for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`)
  if (problems.length > 20) console.error(`  ……还有 ${problems.length - 20} 处`)
  process.exit(1)
}
console.log(`.tools/dsh 和锁文件一致（${paths.length} 个包）`)
