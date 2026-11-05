// Start an installed or unpacked 知微 and wait until its window shows the workbench, as a learner would see it
// after the first start. CI runs it on the installed Windows build:
//   node scripts/desktop/smoke.mjs <path to Microsight.exe>
// The library choice is written up front so no dialog waits for a click, in a throwaway folder; the window's
// page is read over Chromium's debugging port. Exits 0 once the page title is the workbench's.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const executable = process.argv[2]
if (!executable) throw new Error('usage: node scripts/desktop/smoke.mjs <executable>')
const PORT = 9333
const TITLE = '学习工作台'
const TIMEOUT_MS = 180_000

const library = join(mkdtempSync(join(tmpdir(), 'microsight-smoke-')), '学习库')
// The shell keeps its settings in <appData>/Microsight (apps/desktop/src/main.ts); on Linux appData is XDG_CONFIG_HOME.
const config = process.platform === 'win32' ? process.env.APPDATA : (process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'))
if (!config) throw new Error('no APPDATA or config folder')
const userData = join(config, 'Microsight')
mkdirSync(userData, { recursive: true })
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ learningHome: library }) + '\n')

const extra = process.platform === 'linux' ? ['--no-sandbox'] : []
const app = spawn(executable, [`--remote-debugging-port=${PORT}`, ...extra], { stdio: 'inherit' })
const deadline = Date.now() + TIMEOUT_MS
let exited = false
app.on('exit', code => { exited = true; console.error(`知微 exited with ${code}`) })

function stop() {
  if (exited) return
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(app.pid), '/t', '/f'], { stdio: 'inherit' })
  else app.kill('SIGTERM')
}

let last = ''
while (Date.now() < deadline && !exited) {
  await new Promise(resolve => setTimeout(resolve, 2000))
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = targets.find(target => target.type === 'page')
    last = page ? `${page.title} ${new URL(page.url).origin}` : 'no page yet'
    if (page?.title === TITLE && page.url.startsWith('http://127.0.0.1:')) {
      console.log(`smoke: the window shows ${TITLE} from ${new URL(page.url).origin}`)
      stop()
      process.exit(0)
    }
  } catch {
    last = 'debugging port not open yet'
  }
}
console.error(`smoke: no workbench within ${TIMEOUT_MS / 1000}s (last: ${last})`)
const log = join(userData, 'logs', 'dsh.log')
try { console.error(`--- ${log}\n${readFileSync(log, 'utf8').slice(-4000)}`) } catch { console.error(`no ${log}`) }
stop()
process.exit(1)
