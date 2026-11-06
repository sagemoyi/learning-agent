// The first-run guide (docs/shell/proposals/2026-11-06-first-run.md): over the whole window while no model can
// answer, three steps — the learning library, DeepSeek's key, MinerU's key — in the workbench's own look. The
// desktop app adds what a page cannot do (choose a folder, restart DSH on it, updates) through `window.microsight`.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowRight, CircleAlert, Download, ExternalLink, FolderOpen, GraduationCap, KeyRound, RefreshCw } from 'lucide-react'
import type { LearnShell, SecretState } from '@learning-agent/contracts/client'
import { Button, ErrorText, SecretField, TestButton, useLoad } from '@learning-agent/kit/client'

type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string } }
interface Catalog {
  readonly routableProviders: readonly string[]
  readonly groups: readonly { readonly id: string; readonly models: readonly { readonly id: string }[] }[]
}
export interface WelcomeRemotes {
  readonly credentials: {
    describe(refs: string[]): Promise<RemoteResult<Readonly<Record<string, SecretState>>>>
    set(ref: string, value: string): Promise<RemoteResult<void>>
  }
  readonly session: { modelCatalog(): Promise<RemoteResult<Catalog>> }
}

/** What the desktop app's preload exposes (apps/desktop/src/preload.ts); absent in a browser. */
export interface DesktopBridge {
  readonly version: string
  /** Pick a folder for the library; on a pick the app saves it and restarts DSH there (the page reloads). */
  chooseLibrary(): Promise<string | undefined>
  readonly update: {
    status(): Promise<UpdateStatus>
    check(): Promise<UpdateStatus>
    install(): Promise<void>
    onStatus(listener: (status: UpdateStatus) => void): () => void
  }
}
export interface UpdateStatus {
  readonly state: 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error'
  readonly current: string
  readonly version?: string
  readonly percent?: number
  readonly error?: string
}
export const desktop = (globalThis as { microsight?: DesktopBridge }).microsight

const DEEPSEEK = { provider: 'deepseek-official', key: 'DEEPSEEK_API_KEY' } as const
const MINERU_KEY = 'MINERU_API_KEY'
const NO_FEED = ['settings/']

async function unwrap<T>(pending: Promise<RemoteResult<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Whether any model service can answer: a routable provider with models. */
export function canAnswer(catalog: Catalog): boolean {
  return catalog.groups.some(group => group.models.length > 0 && catalog.routableProviders.includes(group.id))
}

/* Whether the guide is open, shared by the guide and the status-bar reminder. */
type Mode = 'auto' | 'open' | 'later'
let mode: Mode = 'auto'
const listeners = new Set<() => void>()
function setMode(next: Mode): void { mode = next; for (const listener of listeners) listener() }
function useMode(): Mode {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => mode)
}

type Step = 'library' | 'model' | 'services' | 'done'
const STEPS: readonly { id: Step; title: string }[] = [
  { id: 'library', title: '学习库' },
  { id: 'model', title: '连接模型' },
  { id: 'services', title: '资料服务' },
]

export function createWelcome(shell: LearnShell, remote: WelcomeRemotes): { Welcome: () => ReactNode; Reminder: () => ReactNode } {
  const useCatalog = (revision: number) => useLoad(shell, () => unwrap(remote.session.modelCatalog()), [revision], NO_FEED)

  function Welcome(): ReactNode {
    const current = useMode()
    const [revision, setRevision] = useState(0)
    const catalog = useCatalog(revision)
    const [step, setStep] = useState<Step>('library')
    // Decided once from the first load: the guide does not vanish the moment the key starts working.
    const [needed, setNeeded] = useState<boolean>()
    useEffect(() => { if (needed === undefined && catalog.data) setNeeded(!canAnswer(catalog.data)) }, [catalog.data, needed])
    const open = current === 'open' || (current === 'auto' && needed === true)
    if (!open) return null
    const finish = () => { setNeeded(false); setMode('auto'); setStep('library') }
    return (
      <div className="la-welcome" role="dialog" aria-modal="true" aria-labelledby="la-welcome-title">
        <div className="la-welcome-card">
          <div className="la-welcome-brand"><GraduationCap size={22} strokeWidth={1.75} />知微</div>
          {step !== 'done' && (
            <ol className="la-welcome-steps" aria-label="步骤">
              {STEPS.map((item, index) => (
                <li key={item.id} className={item.id === step ? 'is-current' : STEPS.findIndex(entry => entry.id === step) > index ? 'is-done' : undefined}
                  aria-current={item.id === step ? 'step' : undefined}>
                  <span className="la-welcome-step-n">{index + 1}</span>{item.title}
                </li>
              ))}
            </ol>
          )}
          {step === 'library' && <LibraryStep onNext={() => setStep('model')} />}
          {step === 'model' && <ModelStep catalog={catalog.data} onSaved={() => setRevision(value => value + 1)} onBack={() => setStep('library')} onNext={() => setStep('services')}
            onElsewhere={() => { setMode('later'); shell.openPage('settings.home', { section: 'models' }) }} />}
          {step === 'services' && <ServicesStep onBack={() => setStep('model')} onNext={() => setStep('done')} />}
          {step === 'done' && <DoneStep onClose={finish} />}
          {step !== 'done' && (
            <button type="button" className="la-welcome-later" onClick={() => setMode('later')}>稍后再说</button>
          )}
        </div>
      </div>
    )
  }

  function LibraryStep({ onNext }: { onNext(): void }): ReactNode {
    const about = useLoad(shell, () => shell.call<{ dataRoot: string }>('settings', 'about'), [], NO_FEED)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string>()
    const choose = async () => {
      setBusy(true)
      setError(undefined)
      try { await desktop?.chooseLibrary() } catch (caught) { setError(String((caught as Error)?.message ?? caught)) } finally { setBusy(false) }
    }
    return (
      <>
        <h1 id="la-welcome-title" className="la-welcome-title">欢迎使用知微</h1>
        <p className="la-welcome-lead">和老师一起定目标、排计划，学完用不看提示的作答确认你真的会了。先花一分钟准备好两样东西。</p>
        <div className="la-welcome-box">
          <div className="la-welcome-box-label">学习库放在这里</div>
          <code className="la-welcome-path">{about.data?.dataRoot ?? '正在读取…'}</code>
          <p className="la-welcome-hint">课程、讲义和学习记录都存在这个文件夹里。它是普通文件夹，可以用 Obsidian 打开、自己备份；卸载知微不会删除它。</p>
          {desktop
            ? <Button size="sm" icon={FolderOpen} loading={busy} onClick={() => void choose()}>换个位置</Button>
            : <p className="la-welcome-hint">网页版的学习库位置由启动环境的 LEARNING_HOME 决定。</p>}
          {desktop && <p className="la-welcome-hint">换位置后知微会重新连接，原来位置里的内容不会搬过去。</p>}
          <ErrorText error={error ?? about.error} />
        </div>
        <div className="la-welcome-actions">
          <Button variant="primary" icon={ArrowRight} onClick={onNext}>下一步</Button>
        </div>
      </>
    )
  }

  function ModelStep({ catalog, onSaved, onBack, onNext, onElsewhere }: {
    catalog: Catalog | undefined
    onSaved(): void
    onBack(): void
    onNext(): void
    onElsewhere(): void
  }): ReactNode {
    const [secret, setSecret] = useState<SecretState>()
    const [tested, setTested] = useState(false)
    const read = async () => setSecret((await unwrap(remote.credentials.describe([DEEPSEEK.key])))[DEEPSEEK.key])
    useEffect(() => { void read().catch(() => undefined) }, [])
    const model = catalog?.groups.find(group => group.id === DEEPSEEK.provider)?.models[0]
    const ready = catalog ? canAnswer(catalog) : false
    return (
      <>
        <h1 id="la-welcome-title" className="la-welcome-title">连接 DeepSeek</h1>
        <p className="la-welcome-lead">老师的讲解、出题和判分都由模型完成。知微用你自己的 DeepSeek 密钥，费用直接记在你的 DeepSeek 账户上。</p>
        <div className="la-welcome-box">
          <div className="la-welcome-box-label"><KeyRound size={14} strokeWidth={1.75} />DeepSeek 密钥</div>
          <SecretField state={secret} placeholder="粘贴以 sk- 开头的密钥"
            onSave={async value => { await unwrap(remote.credentials.set(DEEPSEEK.key, value)); setTested(false); await read(); onSaved() }} />
          <p className="la-welcome-hint">
            还没有密钥？到 <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">DeepSeek 开放平台<ExternalLink size={12} strokeWidth={1.75} /></a> 注册、充值后创建一个。密钥只存在这台电脑上。
          </p>
          {secret?.configured && (
            <TestButton disabled={!model} run={async () => {
              const { ms } = await shell.call<{ ms: number }>('settings', 'testModel', { model: `${DEEPSEEK.provider}/${model!.id}` })
              setTested(true)
              return ms
            }} />
          )}
        </div>
        <p className="la-welcome-hint">用中转站或别的模型服务？<button type="button" className="la-link" onClick={onElsewhere}>去设置页添加</button></p>
        <div className="la-welcome-actions">
          <Button variant="quiet" onClick={onBack}>上一步</Button>
          <Button variant="primary" icon={ArrowRight} disabled={!tested && !ready} onClick={onNext}>下一步</Button>
        </div>
        {!tested && !ready && secret?.configured && <p className="la-welcome-hint la-welcome-right">测试连接通过后就能继续。</p>}
      </>
    )
  }

  function ServicesStep({ onBack, onNext }: { onBack(): void; onNext(): void }): ReactNode {
    const [secret, setSecret] = useState<SecretState>()
    const read = async () => setSecret((await unwrap(remote.credentials.describe([MINERU_KEY])))[MINERU_KEY])
    useEffect(() => { void read().catch(() => undefined) }, [])
    return (
      <>
        <h1 id="la-welcome-title" className="la-welcome-title">导入 PDF（可以跳过）</h1>
        <p className="la-welcome-lead">导入教材和讲义时，用 MinerU 云端识别文字、公式和表格。它会把你导入的 PDF 原件上传到 MinerU。</p>
        <div className="la-welcome-box">
          <div className="la-welcome-box-label"><KeyRound size={14} strokeWidth={1.75} />MinerU 密钥</div>
          <SecretField state={secret} onSave={async value => { await unwrap(remote.credentials.set(MINERU_KEY, value)); await read() }} />
          <p className="la-welcome-hint">
            到 <a href="https://mineru.net/apiManage/token" target="_blank" rel="noreferrer">MinerU 官网<ExternalLink size={12} strokeWidth={1.75} /></a> 免费申请。现在不填也行，第一次导入 PDF 时会再提醒你。
          </p>
        </div>
        <div className="la-welcome-actions">
          <Button variant="quiet" onClick={onBack}>上一步</Button>
          <Button variant="primary" icon={ArrowRight} onClick={onNext}>{secret?.configured ? '下一步' : '跳过'}</Button>
        </div>
      </>
    )
  }

  function DoneStep({ onClose }: { onClose(): void }): ReactNode {
    return (
      <>
        <h1 id="la-welcome-title" className="la-welcome-title">准备好了</h1>
        <p className="la-welcome-lead">新建一门课，告诉老师你想学什么、学到什么程度。模型、资料服务和外观以后都能在左下角的"设置"里改。</p>
        <div className="la-welcome-actions">
          <Button variant="primary" icon={ArrowRight} onClick={onClose}>开始学习</Button>
        </div>
      </>
    )
  }

  /** In the status bar: the guide put off with no model yet, and the desktop app's update progress. */
  function Reminder(): ReactNode {
    const current = useMode()
    const catalog = useCatalog(0)
    const update = useUpdateStatus()
    const missing = current === 'later' && catalog.data && !canAnswer(catalog.data)
    return (
      <>
        {missing && (
          <button type="button" className="la-status-item warn" onClick={() => setMode('open')}>
            <CircleAlert size={13} strokeWidth={1.75} />还没连接模型，去连接
          </button>
        )}
        {update && <UpdateItem status={update} />}
      </>
    )
  }

  return { Welcome, Reminder }
}

/** The desktop app's update state, live; undefined in a browser. */
export function useUpdateStatus(): UpdateStatus | undefined {
  const [status, setStatus] = useState<UpdateStatus>()
  useEffect(() => {
    if (!desktop) return
    let live = true
    void desktop.update.status().then(value => { if (live) setStatus(value) }).catch(() => undefined)
    const off = desktop.update.onStatus(value => setStatus(value))
    return () => { live = false; off() }
  }, [])
  return status
}

function UpdateItem({ status }: { status: UpdateStatus }): ReactNode {
  if (status.state === 'downloading') {
    return <span className="la-status-item" role="status"><Download size={13} strokeWidth={1.75} />正在下载 {status.version} {status.percent === undefined ? '' : `${Math.floor(status.percent)}%`}</span>
  }
  if (status.state === 'ready') {
    return (
      <button type="button" className="la-status-item accent" onClick={() => void desktop?.update.install()}>
        <RefreshCw size={13} strokeWidth={1.75} />{status.version} 已下载，重启更新
      </button>
    )
  }
  if (status.state === 'error') {
    return (
      <button type="button" className="la-status-item warn" title={status.error} onClick={() => void desktop?.update.check()}>
        <CircleAlert size={13} strokeWidth={1.75} />更新下载失败，重试
      </button>
    )
  }
  return null
}
