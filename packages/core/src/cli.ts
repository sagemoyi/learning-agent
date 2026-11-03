// `pnpm backup <目标目录>` and `pnpm restore <备份目录> <新学习库目录>` (docs/core/design.md, 备份和恢复).
// The library is LEARNING_HOME (else `Documents/学习库`), DSH's home is DSH_HOME (else `~/.dsh`), as when DSH runs.
import { resolve } from 'node:path'
import { backup, resolveDataRoot, resolveDshHome, restore } from './backup.ts'

// pnpm runs scripts from the repository root; paths are meant from where the command was typed.
const here = process.env.INIT_CWD ?? process.cwd()
const [command, ...args] = process.argv.slice(2)

async function main(): Promise<void> {
  if (command === 'backup' && args.length === 1) {
    const dataRoot = resolveDataRoot()
    const manifest = await backup({ dataRoot, target: resolve(here, args[0]!), dshHome: resolveDshHome() })
    const sessions = new Set(manifest.files.filter(file => file.path.startsWith('dsh/sessions/')).map(file => file.path.split('/')[3])).size
    console.log(`已备份学习库 ${dataRoot}：${manifest.files.length} 个文件，其中 DSH 会话 ${sessions} 个。`)
    for (const item of manifest.notIncluded) console.log(`没有带：${item.path}（${item.why}）`)
    return
  }
  if (command === 'restore' && args.length === 2) {
    const target = resolve(here, args[1]!)
    const result = await restore({ source: resolve(here, args[0]!), target, dshHome: resolveDshHome() })
    console.log(`已恢复到 ${target}：${result.files} 个文件；DSH 会话放回 ${result.sessions.restored} 个，DSH 里已有、保持原样的 ${result.sessions.kept} 个。`)
    console.log(`要用它：把 LEARNING_HOME 设成这个文件夹再启动 DSH。密钥不在备份里，到设置页重填。`)
    return
  }
  console.error('用法：pnpm backup <目标目录>（先停掉 DSH）\n      pnpm restore <备份目录> <新学习库目录>')
  process.exitCode = 2
}

main().catch(error => {
  console.error((error as Error).message)
  process.exitCode = 1
})
