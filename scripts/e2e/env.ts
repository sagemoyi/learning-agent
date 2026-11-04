// Real DSH for the e2e tests: a throwaway DSH home and learning library in a temp folder, the fake model, no key, and a
// TCP proxy in front of DSH that can cut every connection. The built packages (`pnpm build`) are linked into a fresh
// `learning` profile. Nothing here touches .dsh-home, .data or the 3180/3182 instances.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { cpSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, type WriteStream } from 'node:fs'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFakeModel } from '../fake-openai.ts'

const ROOT = resolve(import.meta.dirname, '../..')
const BIN = join(ROOT, '.tools/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
const UNITS = ['core', 'shell', 'library', 'knowledge', 'goal', 'assess', 'curriculum', 'textbook', 'annotation', 'learner', 'sidechat', 'tutor', 'planner', 'settings', 'app']

export interface Env {
  readonly port: number
  /** The page's address through the proxy, with DSH's token; do not print it. */
  url(): string
  /** The same address without the proxy. */
  directUrl(): string
  /** Drop every connection through the proxy and refuse new ones for this long. */
  cut(ms: number): void
  /** What DSH printed since it started. */
  log(): string
  /** Stop DSH hard and start it again on the same data; a new token, the old cookie stays good only if DSH says so. */
  kill(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done))
  const { port } = probe.address() as { port: number }
  await new Promise(done => probe.close(done))
  return port
}

/** An environment for DSH with only what it needs: no key of the developer's reaches it. */
function cleanEnv(home: string, data: string, modelPort: number): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|TOKEN|SECRET|BASE_URL|MINERU|VOYAGE|LEARNING_|DSH_/i.test(name)))
  return { ...kept, DSH_HOME: home, LEARNING_HOME: data, DEEPSEEK_API_KEY: 'fake-local-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, NO_COLOR: '1' }
}

export async function startEnv(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'learning-e2e-'))
  const home = join(dir, 'home'), data = join(dir, 'data'), work = join(home, 'work'), profile = join(home, 'profiles/learning')
  mkdirSync(work, { recursive: true })
  mkdirSync(profile, { recursive: true })
  mkdirSync(data, { recursive: true })
  for (const file of readdirSync(join(ROOT, 'profile'))) cpSync(join(ROOT, 'profile', file), join(profile, file))

  const silence = console.log
  console.log = () => {}
  const model = await startFakeModel(0)
  console.log = silence
  const modelPort = (model.address() as { port: number }).port
  const env = cleanEnv(home, data, modelPort)
  execFileSync(process.execPath, [BIN, 'plugin', '--profile', 'learning', 'add', ...UNITS.map(unit => `link:${join(ROOT, 'packages', unit).replaceAll('\\', '/')}`)], { cwd: work, env, stdio: 'pipe' })

  const port = await freePort()
  const proxyPort = await freePort()
  let child: ChildProcess | undefined
  let output = ''
  let logFile: WriteStream | undefined
  mkdirSync(join(ROOT, '.scratch'), { recursive: true })

  const sockets = new Set<Socket>()
  let cutUntil = 0
  const proxy: Server = createServer(client => {
    if (Date.now() < cutUntil) { client.destroy(); return }
    const server = connect(port, '127.0.0.1')
    sockets.add(client); sockets.add(server)
    client.pipe(server); server.pipe(client)
    const drop = () => { client.destroy(); server.destroy(); sockets.delete(client); sockets.delete(server) }
    for (const socket of [client, server]) { socket.on('error', drop); socket.on('close', drop) }
  })
  await new Promise<void>(done => proxy.listen(proxyPort, '127.0.0.1', done))

  const tokenUrl = () => {
    const found = output.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[\\w-]+`, 'g'))
    if (!found) throw new Error('DSH 还没打印地址')
    return found.at(-1)!
  }

  const env_: Env = {
    port,
    url: () => tokenUrl().replace(`:${port}/`, `:${proxyPort}/`),
    directUrl: tokenUrl,
    cut(ms) {
      cutUntil = Date.now() + ms
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
    log: () => output,
    async start() {
      output = ''
      logFile = createWriteStream(join(ROOT, '.scratch/e2e-dsh.log'))
      // detached on Linux gives DSH its own process group, so stopping it reaches its children too.
      child = spawn(process.execPath, [BIN, 'learning', '--no-open', '--port', String(port)], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      const collect = (chunk: Buffer) => { output += chunk.toString(); logFile?.write(chunk) }
      child.stdout!.on('data', collect)
      child.stderr!.on('data', collect)
      const exited = new Promise<never>((_, reject) => child!.once('exit', code => reject(new Error(`DSH 退出了（${code}）：\n${output.slice(-1500)}`))))
      const deadline = Date.now() + 120_000
      await Promise.race([exited, (async () => {
        for (;;) {
          if (output.includes(`127.0.0.1:${port}/?token=`)) return
          if (Date.now() > deadline) throw new Error(`DSH 两分钟没启动好：\n${output.slice(-1500)}`)
          await new Promise(done => setTimeout(done, 200))
        }
      })()])
    },
    async kill() {
      const running = child
      child = undefined
      if (!running?.pid || running.exitCode !== null) return
      running.removeAllListeners('exit')
      const gone = new Promise(done => running.once('exit', done))
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(running.pid), '/F', '/T'], { stdio: 'ignore' })
      else process.kill(-running.pid, 'SIGKILL')
      await gone
      logFile?.end()
    },
    async stop() {
      await env_.kill()
      for (const socket of sockets) socket.destroy()
      await new Promise(done => proxy.close(done))
      await new Promise(done => model.close(done))
      model.closeAllConnections()
      // A file still held open for a moment on Windows only leaves a temp folder behind.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    },
  }
  return env_
}

/** Whether a listed DSH package file is there; a clear message beats a stack trace on a fresh clone. */
export function assertBuilt(): void {
  for (const unit of UNITS) readFileSync(join(ROOT, 'packages', unit, 'package.json'))
  try {
    readFileSync(join(ROOT, 'packages/core/lib/index.js'))
    readFileSync(BIN)
  } catch {
    throw new Error('先运行 sh scripts/setup-dsh.sh 和 pnpm build')
  }
}
