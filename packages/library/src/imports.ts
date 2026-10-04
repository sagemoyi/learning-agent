import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-jobs'
import { LibraryImport, type Source } from '@learning-agent/contracts'
import type { LibraryStore } from './store.ts'
import { parserFromEnv, ParserMissingJob, ParserUnavailable, type MineruParser } from './parser.ts'

/** Pages per range for each cloud round: the service limit first, then smaller pieces for ranges that failed. */
const CLOUD_RETRY_PAGES = [undefined, 100, 50, 25] as const

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { 'library-import': 'library-import' }
}

export class LibraryImports {
  private readonly running = new Map<string, AbortController>()
  private disposed = false
  constructor(private readonly ctx: Context, private readonly store: LibraryStore, private readonly parser: MineruParser = parserFromEnv(), private readonly pollMs = 1500, private readonly retryWaitMs = 20_000) {}

  /** Where PDFs are parsed: this machine or MinerU cloud. */
  get where(): MineruParser['where'] { return this.parser.where }

  private change(task: LibraryImport, patch: Partial<LibraryImport>): LibraryImport {
    const saved = this.store.saveImport({ ...task, ...patch })
    this.ctx.emit('learning/import-changed', saved)
    return saved
  }

  accept(file: string, input: Pick<LibraryImport, 'title' | 'fileName' | 'bytes' | 'fingerprint' | 'kind' | 'authority' | 'pageOffset' | 'courseId' | 'role'>): LibraryImport {
    // Reuse even while parsing; one content identity can feed multiple course attachments later.
    const existing = this.store.imports().find(task => task.fingerprint === input.fingerprint && task.status !== 'canceled' && task.status !== 'failed')
    if (existing && existing.status !== 'ready' && existing.courseId !== input.courseId) {
      rmSync(file)
      throw new Error('同一 PDF 正在导入，请等完成后从资料卡加入本课')
    }
    if (existing && (existing.status !== 'ready' || !input.courseId || existing.courseId === input.courseId)) {
      rmSync(file)
      if (existing.status === 'waiting') this.retry(existing.id)
      return this.store.importTask(existing.id)
    }
    const now = new Date().toISOString()
    const task = this.store.saveImport({ ...input, id: randomUUID(), status: 'queued', message: '已保存 PDF，等待解析', createdAt: now, updatedAt: now })
    const folder = this.store.importFolder(task.id)
    mkdirSync(folder, { recursive: true })
    renameSync(file, join(folder, 'original.pdf'))
    this.ctx.emit('learning/import-changed', task)
    this.start(task.id)
    return task
  }

  resume(): void {
    for (const task of this.store.imports()) if (['queued', 'parsing', 'indexing', 'waiting'].includes(task.status)) this.start(task.id)
  }

  retry(id: string): void {
    const task = this.store.importTask(id)
    if (this.running.has(id) || task.status === 'ready') return
    this.change(task, { status: 'queued', message: '准备重试', ...(task.status === 'failed' || task.status === 'canceled' ? { remoteId: undefined } : {}) })
    this.start(id)
  }

  reparse(sourceId: string, courseId?: string): LibraryImport {
    const source = this.store.source(sourceId)
    if (!source) throw new Error('找不到要重新解析的资料')
    const existing = this.store.imports().find(task => task.reparseOf === sourceId && ['queued', 'parsing', 'indexing', 'waiting'].includes(task.status))
    if (existing) return existing
    const original = this.store.original(sourceId)
    if (!/\.pdf$/i.test(original)) throw new Error('只有 PDF 原件可以自动重新解析')
    // A source from the advanced entry has no import task; its kept original stands in for the upload.
    const base = this.store.imports().find(task => task.sourceId === sourceId && task.status === 'ready') ?? {
      title: source.title,
      fileName: source.origin.kind === 'file' ? source.origin.fileName : 'original.pdf',
      bytes: statSync(original).size,
      fingerprint: createHash('sha256').update(readFileSync(original)).digest('hex'),
      kind: source.kind,
      authority: source.authority,
    }
    // The new snapshot takes the old one's place in this course, in the same role (a skeleton stays a skeleton).
    const role = courseId ? this.store.courseSources(courseId).find(entry => entry.sourceId === sourceId)?.role : undefined
    const now = new Date().toISOString()
    const task = this.store.saveImport(LibraryImport.parse({ ...base, pageOffset: source.pageOffset, id: randomUUID(), courseId, role, reparseOf: sourceId, remoteId: undefined, sourceId: undefined, status: 'queued', message: '重新解析；原出处继续可用', createdAt: now, updatedAt: now }))
    const folder = this.store.importFolder(task.id)
    mkdirSync(folder, { recursive: true })
    copyFileSync(original, join(folder, 'original.pdf'))
    this.ctx.emit('learning/import-changed', task)
    this.start(task.id)
    return task
  }

  cancel(id: string): void {
    const task = this.store.importTask(id)
    if (task.status === 'ready' || task.status === 'canceled') return
    this.change(task, { status: 'canceled', message: '已取消，原 PDF 保留，可重试' })
    this.running.get(id)?.abort()
    if (task.remoteId) void this.parser.cancel(task.remoteId).catch(() => {})
  }

  dispose(): void {
    this.disposed = true
    for (const controller of this.running.values()) controller.abort()
  }

  private start(id: string): void {
    if (this.running.has(id) || this.disposed) return
    const controller = new AbortController()
    this.running.set(id, controller)
    const run = (progress: (text: string) => void) => this.run(id, controller.signal, progress).finally(() => this.running.delete(id))
    if (this.ctx.jobs) {
      try { this.ctx.jobs.start({
        kind: 'library-import', label: `解析《${this.store.importTask(id).title}》`,
        run: job => ({ cancel: () => controller.abort(), done: run(text => job.updateProgress(text)).then(() => {
          if (this.disposed) return { status: 'killed' as const, detail: '程序关闭；下次启动恢复导入' }
          const task = this.store.importTask(id)
          return { status: task.status === 'ready' ? 'completed' as const : task.status === 'canceled' ? 'killed' as const : 'failed' as const, detail: task.message }
        }) }),
      }) } catch {
        this.running.delete(id)
        this.change(this.store.importTask(id), { status: 'waiting', message: '后台任务服务暂不可用，PDF 已保存，请重试' })
      }
    }
    else void run(() => {}) // Unit harness: transport/jobs fakes need no running process.
  }

  private async run(id: string, signal: AbortSignal, progress: (text: string) => void): Promise<void> {
    let task = this.store.importTask(id)
    const update = (patch: Partial<LibraryImport>) => {
      signal.throwIfAborted()
      task = this.change(task, patch)
      progress(task.message)
    }
    try {
      const reused = task.reparseOf ? undefined : this.store.byFingerprint(task.fingerprint)
      if (reused) {
        if (task.courseId) this.store.attach(task.courseId, reused.id, task.role ?? 'reference')
        update({ status: 'ready', sourceId: reused.id, message: '复用了已导入的资料' })
        this.handoff(task, reused)
        return
      }
      const folder = this.store.importFolder(id)
      const original = join(folder, 'original.pdf')
      const finish = (result: { parsed: string; assets: string }) => {
        signal.throwIfAborted()
        const finished = this.store.finishImport(id, result.parsed, result.assets)
        task = finished.task
        this.ctx.emit('learning/import-changed', task)
        this.ctx.emit('learning/source-imported', { sourceId: finished.source.id })
        this.handoff(task, finished.source)
      }
      let resubmissions = 0
      // Cloud ranges that fail are parsed again in smaller pieces; finished parts stay saved on disk.
      let round = 0
      for (;;) {
        signal.throwIfAborted()
        if (!task.remoteId) {
          const ranges = await this.parser.pending(original, folder, signal, CLOUD_RETRY_PAGES[round])
          if (ranges.length === 0) {
            update({ status: 'indexing', message: '正在合并各段结果、检查图像并建立出处索引' })
            finish(this.parser.assemble(folder))
            return
          }
          update({ status: 'parsing', message: this.parser.cloud ? '正在上传到 MinerU 云端' : '正在提交本地解析' })
          const remoteId = await this.parser.submit(original, task, signal, ranges)
          update({ remoteId, message: `${this.parser.where}解析器已接收，等待结果` })
        }
        let job
        try { job = await this.parser.status(task.remoteId!, signal) } catch (error) {
          if (!(error instanceof ParserMissingJob) || ++resubmissions > 3) throw error
          update({ remoteId: undefined, message: '解析器任务已失效，正在从原 PDF 恢复' })
          continue
        }
        if (this.parser.cloud && ['completed', 'partial', 'failed'].includes(job.status)) {
          update({ status: 'indexing', message: '正在下载并检查已完成的部分' })
          const failed = await this.parser.collect(job, folder, signal)
          if (failed.length === 0) { update({ remoteId: undefined }); continue }
          const pages = failed.map(part => `第 ${part.range} 页`).join('、')
          if (++round >= CLOUD_RETRY_PAGES.length) throw new Error(`PDF ${pages}在云端多次解析失败（${failed[0]!.message}）。其余部分已保存，稍后点重试只会补这些页`)
          const wait = this.retryWaitMs * round
          update({ status: 'parsing', remoteId: undefined, message: `PDF ${pages}云端解析失败，${Math.round(wait / 1000)} 秒后拆成每段最多 ${CLOUD_RETRY_PAGES[round]} 页重试；已完成的部分已保存` })
          await delay(wait, signal)
          continue
        }
        if (job.status === 'completed') {
          update({ status: 'indexing', message: '正在保存结果、检查图像并建立出处索引' })
          finish(await this.parser.result(job, folder, signal))
          return
        }
        if (['partial', 'failed', 'canceled'].includes(job.status)) throw new Error(job.status === 'partial' ? '解析只完成了一部分，未发布资料；请重试' : `${this.parser.where}解析未完成${failure(job)}，请重试`)
        const waiting = job.status === 'queued' ? `${this.parser.where}解析排队中` : `正在${this.parser.where}解析 PDF${job.files.length > 1 ? `（分 ${job.files.length} 段，已完成 ${job.files.filter(file => file.status === 'completed').length} 段）` : ''}`
        if (task.message !== waiting) update({ message: waiting })
        await delay(this.pollMs, signal)
      }
    } catch (error) {
      if (this.disposed) return // Durable status/remote id remain for next startup.
      task = this.store.importTask(id)
      if (signal.aborted) {
        if (task.status !== 'canceled') this.change(task, { status: 'waiting', message: '任务已暂停，下次启动或重试时继续' })
      } else this.change(task, { status: error instanceof ParserUnavailable ? 'waiting' : 'failed', message: error instanceof Error ? error.message : '解析失败，请重试' })
    }
  }

  private handoff(task: LibraryImport, source: Source): void {
    if (task.courseId) this.ctx.emit('learning/handoff', { courseId: task.courseId, unit: 'library', text: `《${source.title}》已完成解析，加入本课${task.role === 'skeleton' ? '骨架教材' : '参考资料'}，现在可以引用。` })
  }
}

/** The parser's own reason for a failed part, if it gave one. */
function failure(job: { files: { error?: { code?: string; message?: string } }[] }): string {
  const error = job.files.find(file => file.error)?.error
  return error ? `（${(error.message ?? error.code ?? '').slice(0, 120)}）` : ''
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
