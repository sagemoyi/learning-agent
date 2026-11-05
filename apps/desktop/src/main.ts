// The Microsight (知微) desktop shell: runs the bundled Node with the bundled DSH on a free loopback port and
// shows the workbench in its own window (docs/settings/proposals/2026-11-05-windows-installer.md). DSH runs as
// a child process, never inside Electron's own Node, so it runs exactly as in development and the gate.
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import {
  backupName, backupsRoot, dshEnv, freePort, hasLibrary, pageUrl, profileVersion, pruneBackups, readSettings, runNode,
  syncProfile, writeSettings, type Settings,
} from './runtime.ts'

const PRODUCT = '知微'
/** DSH has this long to print its address before the start counts as failed. */
const START_TIMEOUT_MS = 120_000
/** DSH has this long to exit on its own before it is killed. */
const STOP_TIMEOUT_MS = 5_000

// Electron names userData after productName, but with a non-ASCII one (知微) it uses the appData folder itself.
app.setPath('userData', join(app.getPath('appData'), 'Microsight'))
const resources = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '.stage')
const node = join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node')
const dshBin = join(resources, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const template = join(resources, 'profile')
const dshHome = join(process.env.LOCALAPPDATA ?? app.getPath('userData'), 'Microsight', 'dsh-home')
const settingsFile = join(app.getPath('userData'), 'settings.json')
const logDir = join(app.getPath('userData'), 'logs')

let window: BrowserWindow | undefined
let dsh: ChildProcess | undefined
let quitting = false

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  app.whenReady().then(start).catch(error => fail('知微没能启动。', String(error)))
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', event => {
    if (quitting || !dsh || dsh.exitCode !== null) return
    event.preventDefault()
    quitting = true
    void stopDsh().finally(() => app.quit())
  })
}

async function start(): Promise<void> {
  Menu.setApplicationMenu(null)
  const learningHome = await chooseLibrary()
  if (!learningHome) return app.quit()
  mkdirSync(learningHome, { recursive: true })
  const profile = join(dshHome, 'profiles', 'learning')
  const env = dshEnv(process.env, dshHome, learningHome)
  const work = join(dshHome, 'work')
  mkdirSync(work, { recursive: true })

  // Back up before the new version first opens the library: its upgrades may change the database.
  const previous = profileVersion(profile)
  if (previous && previous !== app.getVersion() && hasLibrary(learningHome)) {
    const root = backupsRoot(learningHome)
    const target = join(root, backupName(previous))
    const cli = join(profile, 'node_modules', '@learning-agent', 'core', 'lib', 'cli.js')
    const result = await runNode(node, [cli, 'backup', target], { cwd: work, env })
    if (result.code !== 0) {
      const { response } = await dialog.showMessageBox({
        type: 'warning', title: PRODUCT, buttons: ['仍然继续', '退出'], defaultId: 1, cancelId: 1,
        message: '升级前没能备份学习库。', detail: result.output.trim().slice(-2000),
      })
      if (response === 1) return app.quit()
    } else {
      pruneBackups(root)
    }
  }
  syncProfile(template, profile, app.getVersion())

  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600, title: PRODUCT, show: false, backgroundColor: '#ffffff',
    icon: join(resources, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  })
  window.once('ready-to-show', () => window?.show())
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING)}`)

  const url = await startDsh(work, env)
  const origin = new URL(url).origin
  // Links leave the workbench for the system browser; the window only ever shows DSH's own pages.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin === origin) return
    event.preventDefault()
    if (/^https?:/.test(target)) void shell.openExternal(target)
  })
  await window.loadURL(url)
}

/** The learning library: the saved choice, or on the first start the learner's pick (default Documents\学习库). */
async function chooseLibrary(): Promise<string | undefined> {
  const settings = readSettings(settingsFile)
  if (settings.learningHome) return settings.learningHome
  const fallback = join(app.getPath('documents') || homedir(), '学习库')
  const { response } = await dialog.showMessageBox({
    type: 'question', title: PRODUCT, buttons: ['使用这个位置', '选择其他文件夹', '退出'], defaultId: 0, cancelId: 2,
    message: '欢迎使用知微。学习库放在哪里？',
    detail: `课程、讲义和学习记录都存在学习库里，是普通的文件夹，可以用 Obsidian 打开、自己备份。\n\n默认位置：${fallback}\n\n模型和 MinerU 用你自己的密钥，启动后在设置页填写；MinerU 云端解析会上传你导入的 PDF。`,
  })
  if (response === 2) return undefined
  let chosen = fallback
  if (response === 1) {
    const picked = await dialog.showOpenDialog({ title: '选择学习库文件夹', defaultPath: fallback, properties: ['openDirectory', 'createDirectory'] })
    if (picked.canceled || !picked.filePaths[0]) return chooseLibrary()
    chosen = picked.filePaths[0]
  }
  const next: Settings = { ...settings, learningHome: chosen }
  writeSettings(settingsFile, next)
  return chosen
}

async function startDsh(work: string, env: NodeJS.ProcessEnv): Promise<string> {
  mkdirSync(logDir, { recursive: true })
  const logFile = join(logDir, 'dsh.log')
  const log = createWriteStream(logFile, { flags: 'w' })
  const port = await freePort()
  const child = spawn(node, [dshBin, 'learning', '--no-open', '--port', String(port)], { cwd: work, env, windowsHide: true })
  dsh = child
  return new Promise((resolve, reject) => {
    let output = ''
    let started = false
    const timer = setTimeout(() => fail('知微的后台服务没能按时启动。', `日志：${logFile}`), START_TIMEOUT_MS)
    const read = (chunk: Buffer): void => {
      log.write(chunk)
      if (started) return
      output += chunk.toString()
      const url = pageUrl(output)
      if (!url) return
      started = true
      clearTimeout(timer)
      resolve(url)
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.on('exit', code => {
      clearTimeout(timer)
      log.end()
      if (!quitting) fail('知微的后台服务停止了。', `退出代码 ${code ?? '无'}。日志：${logFile}`)
      reject(new Error(`exit ${code}`))
    })
  })
}

/** Ask DSH to stop, then kill it (with its children on Windows) when it does not in time. */
function stopDsh(): Promise<void> {
  const child = dsh
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      else child.kill('SIGKILL')
    }, STOP_TIMEOUT_MS)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

function fail(message: string, detail: string): void {
  if (quitting) return
  quitting = true
  dialog.showErrorBox(PRODUCT, `${message}\n\n${detail}`)
  void stopDsh().finally(() => app.exit(1))
}

const LOADING = `<!doctype html><meta charset="utf-8"><title>${PRODUCT}</title>
<style>html,body{height:100%;margin:0;font-family:"Microsoft YaHei UI",system-ui,sans-serif;color:#141414;background:#fff}
body{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px}
p{margin:0;color:#666;font-size:14px}</style>
<h1 style="font-weight:600;font-size:28px;margin:0">${PRODUCT}</h1><p>正在启动…</p>`
