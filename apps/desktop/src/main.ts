// The Microsight (知微) desktop shell: runs the bundled Node with the bundled DSH on a free loopback port and
// shows the workbench in its own window (docs/settings/proposals/2026-11-05-windows-installer.md). DSH runs as
// a child process, never inside Electron's own Node, so it runs exactly as in development and the gate.
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, createWriteStream, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { autoUpdater } from 'electron-updater'
import {
  backupName, backupsRoot, dshEnv, freePort, hasLibrary, pageUrl, profileVersion, pruneBackups, readSettings, runNode,
  syncProfile, writeSettings,
} from './runtime.ts'

const PRODUCT = '知微'
/** DSH has this long to print its address before the start counts as failed. */
const START_TIMEOUT_MS = 120_000
/** DSH has this long to exit on its own before it is killed. */
const STOP_TIMEOUT_MS = 5_000
/** How often a running shell looks for a new release after the first check at start. */
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

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
/** DSH's address once it listens: the only origin the window shows and the bridge answers. */
let origin: string | undefined
let work = ''
let env: NodeJS.ProcessEnv = {}

/** What the status bar and 设置 › 关于 show about updates (welcome.tsx, UpdateStatus). */
interface UpdateStatus { state: 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error'; current: string; version?: string; percent?: number; error?: string }
let update: UpdateStatus = { state: 'idle', current: app.getVersion() }
function setUpdate(next: Omit<UpdateStatus, 'current'>): void {
  update = { ...next, current: app.getVersion() }
  if (window && !window.isDestroyed()) {
    window.webContents.send('microsight:update', update)
    window.setProgressBar(update.state === 'downloading' ? (update.percent ?? 0) / 100 : -1)
  }
}

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
  const learningHome = library()
  mkdirSync(learningHome, { recursive: true })
  const profile = join(dshHome, 'profiles', 'learning')
  env = dshEnv(process.env, dshHome, learningHome)
  work = join(dshHome, 'work')
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
    webPreferences: { contextIsolation: true, sandbox: true, preload: join(__dirname, 'preload.js') },
  })
  window.once('ready-to-show', () => window?.show())
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING)}`)

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
  bridge()
  await openDsh()
  watchUpdates()
}

/** Start DSH and show its page; the first-run guide in the page takes it from there. */
async function openDsh(): Promise<void> {
  const url = await startDsh(work, env)
  origin = new URL(url).origin
  await window?.loadURL(url)
}

/** The learning library: the saved choice, else Documents\学习库, which the first-run guide offers to change. */
function library(): string {
  const settings = readSettings(settingsFile)
  if (settings.learningHome) return settings.learningHome
  const chosen = join(app.getPath('documents') || homedir(), '学习库')
  writeSettings(settingsFile, { ...settings, learningHome: chosen })
  return chosen
}

/**
 * What the page may ask of the app (preload.ts): its version, a new library folder (DSH restarts there), and
 * updates. Only DSH's own page is answered.
 */
function bridge(): void {
  const ours = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => !!origin && !!event.senderFrame && new URL(event.senderFrame.url).origin === origin
  ipcMain.on('microsight:version', event => { event.returnValue = app.getVersion() })
  ipcMain.handle('microsight:choose-library', async event => {
    if (!ours(event) || !window) return undefined
    const settings = readSettings(settingsFile)
    const picked = await dialog.showOpenDialog(window, { title: '选择学习库文件夹', defaultPath: settings.learningHome, properties: ['openDirectory', 'createDirectory'] })
    const chosen = picked.canceled ? undefined : picked.filePaths[0]
    if (!chosen || chosen === settings.learningHome) return chosen
    mkdirSync(chosen, { recursive: true })
    writeSettings(settingsFile, { ...settings, learningHome: chosen })
    env = dshEnv(process.env, dshHome, chosen)
    const old = dsh
    dsh = undefined
    origin = undefined
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING)}`)
    await stopDsh(old)
    await openDsh()
    return chosen
  })
  ipcMain.handle('microsight:update-status', event => ours(event) ? update : undefined)
  ipcMain.handle('microsight:update-check', async event => {
    if (!ours(event)) return undefined
    if (!updatable()) return update
    await autoUpdater.checkForUpdates().catch(() => undefined)
    return update
  })
  ipcMain.handle('microsight:update-install', async event => {
    if (!ours(event) || update.state !== 'ready') return
    await installNow()
  })
}

const updatable = (): boolean => app.isPackaged && process.platform === 'win32'

async function installNow(): Promise<void> {
  quitting = true
  await stopDsh()
  autoUpdater.quitAndInstall(true, true)
}

/**
 * Updates come from GitHub Releases (electron-builder.yml, publish). A new version downloads in the background
 * (only the changed blocks when it can) and installs when the learner restarts now or the next time they quit.
 * The library is backed up when the new version first starts, as for any version change.
 */
function watchUpdates(): void {
  if (!updatable()) return
  const log = (level: string) => (message: unknown): void => {
    try { appendFileSync(join(logDir, 'update.log'), `${new Date().toISOString()} ${level} ${String(message)}\n`) } catch { /* logging is best effort */ }
  }
  autoUpdater.logger = { info: log('info'), warn: log('warn'), error: log('error'), debug: () => {} }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  let offered = false
  let version: string | undefined
  autoUpdater.on('checking-for-update', () => { if (update.state !== 'downloading' && update.state !== 'ready') setUpdate({ state: 'checking' }) })
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'none' }))
  autoUpdater.on('update-available', info => { version = info.version; setUpdate({ state: 'downloading', version, percent: 0 }) })
  autoUpdater.on('download-progress', progress => setUpdate({ state: 'downloading', version, percent: progress.percent }))
  autoUpdater.on('error', error => { if (update.state !== 'ready') setUpdate({ state: 'error', version, error: plain(error) }) })
  autoUpdater.on('update-downloaded', async info => {
    setUpdate({ state: 'ready', version: info.version })
    if (offered || quitting || !window) return
    offered = true
    const { response } = await dialog.showMessageBox(window, {
      type: 'info', title: PRODUCT, buttons: ['现在重启', '稍后'], defaultId: 0, cancelId: 1,
      message: `知微 ${info.version} 已经下载好。`,
      detail: '重启后安装新版本，安装前会先备份学习库。选"稍后"的话，下次关闭知微时自动安装。',
    })
    if (response === 0) await installNow()
  })
  const check = (): void => { autoUpdater.checkForUpdates().catch(log('error')) }
  check()
  setInterval(check, UPDATE_INTERVAL_MS).unref()
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
      if (!quitting && child === dsh) fail('知微的后台服务停止了。', `退出代码 ${code ?? '无'}。日志：${logFile}`)
      reject(new Error(`exit ${code}`))
    })
  })
}

/** Ask DSH (the running one, or an earlier one being replaced) to stop, then kill it (with its children on Windows) when it does not in time. */
function stopDsh(child = dsh): Promise<void> {
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

/** An error's message without the stack electron-updater appends. */
function plain(error: unknown): string {
  return String((error as Error)?.message ?? error).split('\n')[0]!.slice(0, 300)
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
