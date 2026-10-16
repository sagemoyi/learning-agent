// settings unit, browser half: the settings page (docs/settings/research.md). It reads and writes through
// DSH's own services: `settings` (the live Config fields of every profile entry, saved in the profile's
// own cordis.patch.yml), `credentials` (named secrets, never read back), `llm` and `session` (model
// providers and the model catalog), `pluginInventory` and `pluginManager` (what is loaded). Units add
// blocks to the 资料服务 section through the `learning.settings.services` slot.
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  Blocks, BrainCircuit, CircleAlert, FileSearch, Info, KeyRound, Monitor, Moon, Plus, Settings, ShieldCheck, Sun, SunMoon, Trash2,
} from 'lucide-react'
import type { ClientContext, LearnShell, LearningPageProps, SecretState, SettingsAccess } from '@learning-agent/contracts/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button, Callout, Checkbox, ConfirmButton, Disclosure, Dot, EmptyState, ErrorText, Field, Page, PageHeader, SecretField, Section, Segmented, Select,
  SettingRow, Skeleton, Tag, TestButton, TextField, useAction, useLoad, useSecrets, type Choice, type Loaded, type Tone,
} from '@learning-agent/kit/client'
import { LEVEL_LABEL, LEVELS, currentLimits, effortsOf, formatCapacity, levelsOf, limitOps, parseCapacity, type Limits, type ModelEntry, type Where } from './limits.ts'

export const name = 'learning-settings'
export const inject = ['slots', 'learnShell', 'remote', 'remote.settings', 'remote.credentials', 'remote.llm', 'remote.session', 'remote.pluginInventory', 'remote.pluginManager']

/* ── DSH's remote services, as far as this page uses them ── */

type RemoteResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string; readonly code?: string } }
type Op = { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown } | { readonly op: 'unset'; readonly path: readonly string[] }
interface SchemaNode {
  readonly type: string
  readonly meta?: { readonly role?: string; readonly description?: string | Readonly<Record<string, string>> }
  readonly dict?: Readonly<Record<string, number>>
  readonly inner?: number
  readonly list?: readonly number[]
  readonly value?: unknown
}
interface SerializedSchema { readonly uid?: number; readonly refs?: Readonly<Record<string, SchemaNode>> }
interface NamespaceView {
  readonly ns: string
  readonly schema: SerializedSchema
  /** Resolved: schema defaults, then the composition base, then the learner's layer. */
  readonly value: Readonly<Record<string, any>>
  /** The composition base with defaults resolved. */
  readonly base?: Readonly<Record<string, any>>
  /** The learner's own layer: a field present here is one they changed. */
  readonly user?: Readonly<Record<string, any>>
  readonly revision: number
}
interface CatalogModel { readonly id: string; readonly name: string; readonly reasoning?: { readonly efforts: readonly { readonly id: string; readonly name: string }[]; readonly defaultEffort?: string } }
interface ModelCatalog {
  readonly default: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly routableProviders: readonly string[]
  readonly groups: readonly { readonly id: string; readonly name: string; readonly models: readonly CatalogModel[] }[]
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[]
}
interface ConfigurableProvider { readonly provider: string; readonly displayName: string; readonly settingsNs: string; readonly declared?: boolean; readonly error?: string }
interface DiscoveredModel { readonly id: string; readonly name?: string; readonly contextWindow?: number; readonly maxTokens?: number; readonly inputModalities?: readonly string[] }
type LocalizedText = string | { readonly en: string; readonly [language: string]: string }
interface Meta { readonly title?: LocalizedText; readonly description?: LocalizedText; readonly icon?: string; readonly error?: string }
type Phase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
interface InventoryEntry { readonly entryId: string; readonly moduleName: string; readonly meta?: Meta; readonly enabled: boolean; readonly fiberPhase: Phase }
interface Inventory {
  readonly entries: readonly InventoryEntry[]
  readonly agentPresets?: readonly { readonly id: string; readonly name?: string; readonly rows: readonly { readonly moduleName: string }[] }[]
}
interface Bundle { readonly name: string; readonly version?: string; readonly rows: readonly { readonly rowId: string; readonly moduleName: string; readonly meta?: Meta; readonly entryId?: string }[] }
interface Remotes {
  readonly settings: {
    describe(): Promise<RemoteResult<{ readonly writable: boolean; readonly namespaces: readonly NamespaceView[] }>>
    mutate(ns: string, ops: readonly Op[], expectedRevision: number | undefined): Promise<RemoteResult<NamespaceView>>
  }
  readonly credentials: {
    describe(refs: string[]): Promise<RemoteResult<Readonly<Record<string, SecretState>>>>
    set(ref: string, value: string): Promise<RemoteResult<void>>
    unset(ref: string): Promise<RemoteResult<void>>
  }
  readonly llm: {
    listConfigurableProviders(): Promise<RemoteResult<readonly ConfigurableProvider[]>>
    discoverModels(settingsNs: string, request: { readonly provider?: string; readonly baseURL?: string; readonly api?: string; readonly apiKey?: string }): Promise<RemoteResult<readonly DiscoveredModel[]>>
  }
  readonly session: { modelCatalog(): Promise<RemoteResult<ModelCatalog>> }
  readonly pluginInventory: { list(): Promise<RemoteResult<Inventory>> }
  readonly pluginManager: { listBundles(): Promise<RemoteResult<readonly Bundle[]>> }
}
/** The part of DSH's theme service (`ctx.theme`, dsh-client-ui-theme) the 外观 section uses. */
interface ThemeService {
  getTheme(): { preference: string }
  setTheme(id: string): void
}

let shell: LearnShell
let remote: Remotes
let theme: { service: ThemeService; subscribe(listener: () => void): () => void } | undefined

async function unwrap<T>(pending: Promise<RemoteResult<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** DSH settings changes do not reach the learning change feed: the page reloads after its own writes. */
const NO_FEED = ['settings/']
const PI_AI = 'llm-pi-ai'
const DEEPSEEK = { provider: 'deepseek-official', ns: 'llm-deepseek', key: 'DEEPSEEK_API_KEY', name: 'DeepSeek' } as const
const MODEL_ROLE = 'learning-model'
/** Roles in reading order; roles other plugins declare follow. */
const ROLE_ORDER = ['主老师', '侧边提问', '写教材', '判分', '侧边会话总结']
const PROTOCOL_LABEL: Record<string, string> = { 'openai-completions': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages' }
/**
 * Readable names for DSH's known providers (DSH lists only their ids), in the order 添加模型服务 offers them;
 * providers not named here follow, by id. Names follow each provider's own name in pi-ai.
 */
const KNOWN_PROVIDERS: ReadonlyArray<readonly [id: string, name: string]> = [
  ['moonshotai-cn', 'Kimi（月之暗面，国内）'],
  ['qwen-token-plan-cn', '通义千问 Token Plan（国内）'],
  ['zai-coding-cn', '智谱 GLM 编程套餐（国内）'],
  ['minimax-cn', 'MiniMax（国内）'],
  ['xiaomi', '小米 MiMo'],
  ['kimi-coding', 'Kimi For Coding'],
  ['openrouter', 'OpenRouter'],
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['google', 'Google Gemini'],
  ['moonshotai', 'Kimi（月之暗面，海外）'],
  ['qwen-token-plan', '通义千问 Token Plan（海外）'],
  ['zai', '智谱 Z.AI（海外）'],
  ['minimax', 'MiniMax（海外）'],
  ['xai', 'xAI Grok'],
  ['mistral', 'Mistral'],
]
/** pi-ai's own DeepSeek route; DeepSeek already has its own card. */
const HIDDEN_PROVIDERS = new Set(['deepseek'])

function providerName(id: string): string | undefined {
  return KNOWN_PROVIDERS.find(([known]) => known === id)?.[1]
}

/** DSH's convention for a provider's key: `minimax-cn` → `MINIMAX_CN_API_KEY` (the same as DSH's own models page). */
function keyRefOf(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

function textOf(text: LocalizedText | undefined): string | undefined {
  return typeof text === 'string' || text === undefined ? text : text.zh ?? text.en
}

function nodeOf(schema: SerializedSchema, uid: number | undefined): SchemaNode | undefined {
  return uid === undefined ? undefined : schema.refs?.[String(uid)]
}

/** The top-level fields of a serialized Config schema. */
function fieldsOf(schema: SerializedSchema): [string, SchemaNode][] {
  const root = nodeOf(schema, schema.uid)
  return Object.entries(root?.dict ?? {}).flatMap(([key, uid]) => {
    const node = nodeOf(schema, uid)
    return node ? [[key, node] as [string, SchemaNode]] : []
  })
}

/** The wire protocols a declared route may name, read from the pi-ai schema so they match what DSH accepts. */
function protocolsOf(view: NamespaceView | undefined): string[] {
  const fallback = Object.keys(PROTOCOL_LABEL)
  if (!view) return fallback
  const providers = fieldsOf(view.schema).find(([key]) => key === 'providers')?.[1]
  let node = nodeOf(view.schema, providers?.inner)
  for (let depth = 0; node && node.type !== 'object' && depth < 4; depth++) node = nodeOf(view.schema, node.inner ?? node.list?.[0])
  const api = nodeOf(view.schema, node?.dict?.api)
  const values = (api?.list ?? []).map(uid => nodeOf(view.schema, uid)?.value).filter((value): value is string => typeof value === 'string')
  return values.length ? values : fallback
}

/* ── plugin ── */

export function apply(ctx: ClientContext): void {
  shell = ctx.learnShell
  remote = (ctx as unknown as { remote: Remotes }).remote
  ctx.inject(['theme'], themeCtx => {
    const service = (themeCtx as unknown as { theme: ThemeService }).theme
    theme = {
      service,
      subscribe: listener => themeCtx.on('theme/change' as never, listener as never),
    }
    themeCtx.effect(() => () => { theme = undefined }, 'learning-settings: theme')
  })
  ctx.effect(() => ctx.learnShell.registerActivity({ id: 'settings', title: '设置', icon: Settings, scope: 'both', page: 'settings.home', order: 90, placement: 'foot' }), 'settings: activity')
  ctx.effect(() => ctx.slots.inject('learning.page', () => ctx.slots.register({
    name: 'learning.page',
    key: 'settings.home',
    children: { 'learning.settings.services': { kind: 'list', scope: 'root' } },
  }, SettingsPage)), 'settings: page')
}

/* ── page ── */

const SECTIONS = [
  { id: 'models', title: '模型', icon: BrainCircuit },
  { id: 'services', title: '资料服务', icon: FileSearch },
  { id: 'appearance', title: '外观', icon: SunMoon },
  { id: 'data', title: '数据与隐私', icon: ShieldCheck },
  { id: 'plugins', title: '插件', icon: Blocks },
  { id: 'about', title: '关于', icon: Info },
] as const
type SectionId = (typeof SECTIONS)[number]['id']

interface Store {
  readonly access: SettingsAccess
  readonly namespaces: Loaded<readonly NamespaceView[]>
  /** Path-addressed write (DSH's `settings.mutate`) at the namespace's latest revision. */
  mutate(ns: string, ops: readonly Op[]): Promise<void>
  bump(): void
}

function useStore(): Store {
  const [revision, setRevision] = useState(0)
  const namespaces = useLoad(shell, async () => (await unwrap(remote.settings.describe())).namespaces, [revision], NO_FEED)
  return useMemo(() => {
    const bump = () => setRevision(value => value + 1)
    const mutate = async (ns: string, ops: readonly Op[]) => {
      // Read the revision now: an older one is refused, so the page never overwrites a newer change.
      const view = (await unwrap(remote.settings.describe())).namespaces.find(entry => entry.ns === ns)
      if (!view) throw new Error('这一组设置现在不可用')
      await unwrap(remote.settings.mutate(ns, ops, view.revision))
      bump()
    }
    const access: SettingsAccess = {
      values: ns => namespaces.data?.find(view => view.ns === ns)?.value,
      set: (ns, key, value) => mutate(ns, [value === undefined ? { op: 'unset', path: [key] } : { op: 'set', path: [key], value }]),
      describeSecrets: names => unwrap(remote.credentials.describe([...names])),
      saveSecret: async (secret, value) => { await unwrap(remote.credentials.set(secret, value)); bump() },
      clearSecret: async secret => { await unwrap(remote.credentials.unset(secret)); bump() },
      revision,
    }
    return { access, namespaces, mutate, bump }
  }, [namespaces, revision])
}

function SettingsPage({ params, renderSlot }: LearningPageProps & PropsRenderSlots<'learning.settings.services'>): ReactNode {
  const requested = SECTIONS.find(item => item.id === params.section)?.id
  const [section, setSection] = useState<SectionId>(requested ?? 'models')
  useEffect(() => { if (requested) setSection(requested) }, [requested])
  const store = useStore()
  const current = SECTIONS.find(item => item.id === section)!
  return (
    <Page width="wide">
      <PageHeader eyebrow={<><Settings size={14} strokeWidth={1.75} />设置</>} title={current.title}
        description="这里设置模型、在线服务和工作台本身；学习安排请和主老师商量。" />
      <div className="la-settings">
        <nav className="la-settings-nav" aria-label="设置分区">
          {SECTIONS.map(item => (
            <button key={item.id} type="button" className={`la-settings-tab${item.id === section ? ' is-active' : ''}`} aria-current={item.id === section ? 'page' : undefined}
              onClick={() => setSection(item.id)}>
              <item.icon size={16} strokeWidth={1.75} />{item.title}
            </button>
          ))}
        </nav>
        <div className="la-settings-body">
          <ErrorText error={store.namespaces.error} />
          {section === 'models' && <ModelsSection store={store} />}
          {section === 'services' && <ServicesSection store={store} renderSlot={renderSlot} />}
          {section === 'appearance' && <AppearanceSection />}
          {section === 'data' && <DataSection store={store} />}
          {section === 'plugins' && <PluginsSection store={store} open={setSection} />}
          {section === 'about' && <AboutSection />}
        </div>
      </div>
    </Page>
  )
}

/* ── 模型 ── */

function useCatalog(revision: number): Loaded<ModelCatalog> {
  return useLoad(shell, () => unwrap(remote.session.modelCatalog()), [revision], NO_FEED)
}

function modelChoices(catalog: ModelCatalog | undefined): Choice<string>[] {
  return (catalog?.groups ?? []).flatMap(group => group.models.map(model => ({ value: `${group.id}/${model.id}`, label: model.name, hint: group.name })))
}

function ModelsSection({ store }: { store: Store }): ReactNode {
  const catalog = useCatalog(store.access.revision)
  const providers = useLoad(shell, () => unwrap(remote.llm.listConfigurableProviders()), [store.access.revision], NO_FEED)
  if (!catalog.data || !store.namespaces.data) return catalog.error ? <ErrorText error={catalog.error} /> : <Skeleton lines={6} />
  return (
    <div className="la-stack" style={{ gap: 28 }}>
      <Section title="模型分工" description="默认模型给所有角色用；某个角色可以单独换一个。改了之后下一次请求就用新模型，主老师和侧边提问正在进行的对话也会换过去。">
        <RoleModels store={store} catalog={catalog.data} />
      </Section>
      <Section title="模型服务" description="接上哪家的模型，就能把它的模型分给上面的角色。密钥只能填写或清除，页面不会显示出来。">
        <ProviderList store={store} catalog={catalog.data} configurable={providers.data ?? []} />
      </Section>
    </div>
  )
}

function RoleModels({ store, catalog }: { store: Store; catalog: ModelCatalog }): ReactNode {
  const action = useAction()
  const choices = modelChoices(catalog)
  const current = `${catalog.default.provider}/${catalog.default.model}`
  const defaultName = choices.find(choice => choice.value === current)?.label ?? catalog.default.model
  const defaultModel = catalog.groups.find(group => group.id === catalog.default.provider)?.models.find(model => model.id === catalog.default.model)
  const efforts = defaultModel?.reasoning?.efforts ?? []
  const roles = (store.namespaces.data ?? []).flatMap(view => fieldsOf(view.schema)
    .filter(([, node]) => node.meta?.role === MODEL_ROLE)
    .map(([key, node]) => ({ ns: view.ns, key, label: textOf(node.meta?.description as LocalizedText | undefined) ?? key, value: view.value[key] as string | undefined })))
    .sort((a, b) => (ROLE_ORDER.indexOf(a.label) + 1 || 99) - (ROLE_ORDER.indexOf(b.label) + 1 || 99))

  const setDefault = (value: string) => action.run(() => {
    const slash = value.indexOf('/')
    return store.mutate('agent-default-model', [{ op: 'set', path: ['provider'], value: value.slice(0, slash) }, { op: 'set', path: ['model'], value: value.slice(slash + 1) }])
  })
  return (
    <div className="la-settings-card">
      <SettingRow title="默认模型" hint="没有单独指定模型的角色都用它。">
        <div className="la-row nowrap">
          <Select value={choices.some(choice => choice.value === current) ? current : undefined} options={choices} width={220} aria-label="默认模型" disabled={action.busy} onChange={setDefault} />
          {efforts.length > 0 && (
            <Select value={catalog.default.reasoningEffort ?? defaultModel?.reasoning?.defaultEffort} options={efforts.map(effort => ({ value: effort.id, label: `思考：${LEVEL_LABEL[effort.id] ?? effort.name}` }))}
              width={130} aria-label="思考强度" disabled={action.busy} onChange={value => action.run(() => store.mutate('agent-default-model', [{ op: 'set', path: ['reasoningEffort'], value }]))} />
          )}
        </div>
      </SettingRow>
      {roles.map(role => {
        const known = !role.value || choices.some(choice => choice.value === role.value)
        const options: Choice<string>[] = [{ value: '', label: `跟随默认（${defaultName}）` }, ...choices, ...(known ? [] : [{ value: role.value!, label: `${role.value}（不可用）` }])]
        return (
          <SettingRow key={`${role.ns}.${role.key}`} title={role.label} hint={known ? undefined : <span className="la-warn-text">这个模型现在不可用，请换一个或接上它的模型服务</span>}>
            <Select value={role.value ?? ''} options={options} width={260} aria-label={`${role.label}的模型`} disabled={action.busy}
              onChange={value => action.run(() => store.access.set(role.ns, role.key, value || undefined))} />
          </SettingRow>
        )
      })}
      <ErrorText error={action.error} />
    </div>
  )
}

interface ProviderView {
  readonly id: string
  readonly name: string
  /** Settings namespace and path of the provider's profile. */
  readonly ns: string
  /** The credential the provider reads; undefined when it authenticates another way. */
  readonly keyRef?: string
  readonly removable: boolean
  readonly baseURL?: string
}

function ProviderList({ store, catalog, configurable }: { store: Store; catalog: ModelCatalog; configurable: readonly ConfigurableProvider[] }): ReactNode {
  const [adding, setAdding] = useState(false)
  const deepseek = store.access.values(DEEPSEEK.ns)
  const routes = (store.access.values(PI_AI)?.providers ?? {}) as Readonly<Record<string, { readonly apiKeyEnv?: string; readonly displayName?: string; readonly baseURL?: string }>>
  const views: ProviderView[] = [
    { id: DEEPSEEK.provider, name: DEEPSEEK.name, ns: DEEPSEEK.ns, keyRef: (deepseek?.apiKeyEnv as string | undefined) ?? DEEPSEEK.key, removable: false, baseURL: deepseek?.baseURL as string | undefined },
    ...Object.entries(routes).map(([id, profile]) => ({
      id, ns: PI_AI, removable: true, keyRef: profile.apiKeyEnv, baseURL: profile.baseURL,
      name: profile.displayName ?? providerName(id) ?? configurable.find(entry => entry.provider === id)?.displayName ?? id,
    })),
  ]
  const secrets = useSecrets(store.access, views.flatMap(view => (view.keyRef ? [view.keyRef] : [])))
  return (
    <div className="la-stack">
      {views.map(view => <ProviderCard key={view.id} view={view} store={store} catalog={catalog} secret={view.keyRef ? secrets?.[view.keyRef] : undefined} />)}
      {adding
        ? <AddProvider store={store} configurable={configurable} taken={new Set([...views.map(view => view.id), 'deepseek-account'])} onClose={() => setAdding(false)} />
        : <div><Button icon={Plus} onClick={() => setAdding(true)}>添加模型服务</Button></div>}
    </div>
  )
}

function ProviderCard({ view, store, catalog, secret }: { view: ProviderView; store: Store; catalog: ModelCatalog; secret: SecretState | undefined }): ReactNode {
  const remove = useAction()
  const group = catalog.groups.find(entry => entry.id === view.id)
  const failure = catalog.failures.find(entry => entry.id === view.id)
  const usable = catalog.routableProviders.includes(view.id) && !!group?.models.length
  const status: { tone: Tone; text: string } = usable ? { tone: 'ok', text: '可用' } : view.keyRef && secret && !secret.configured ? { tone: 'warn', text: '缺密钥' } : { tone: 'bad', text: '不可用' }
  const removeProvider = () => remove.run(async () => {
    await store.mutate(PI_AI, [{ op: 'unset', path: ['providers', view.id] }])
    // Only the key this page derived for the route; a shared variable such as OPENAI_API_KEY may serve other tools.
    if (view.keyRef === keyRefOf(view.id) && secret?.configured && secret.writable) await store.access.clearSecret(view.keyRef)
  })
  return (
    <div className="la-settings-card la-provider">
      <div className="la-provider-head">
        <span className="la-provider-name">{view.name}</span>
        <Tag tone={status.tone}>{status.text}</Tag>
        <span className="la-spacer" />
        {group?.models[0] && (
          <TestButton run={async () => (await shell.call<{ ms: number }>('settings', 'testModel', { model: `${view.id}/${group.models[0]!.id}` })).ms} />
        )}
        {view.removable && <ConfirmButton size="sm" variant="quiet" icon={Trash2} question={`删除 ${view.name}？`} confirm="删除" loading={remove.busy} onConfirm={removeProvider}>删除</ConfirmButton>}
      </div>
      {failure && !usable && <p className="la-provider-note la-warn-text"><CircleAlert size={13} strokeWidth={1.75} />{failure.message}</p>}
      {view.keyRef && (
        <Field label={<span className="la-row"><KeyRound size={13} strokeWidth={1.75} />密钥</span>}>
          <SecretField state={secret} onSave={value => store.access.saveSecret(view.keyRef!, value)} onClear={() => store.access.clearSecret(view.keyRef!)} />
        </Field>
      )}
      {group && group.models.length > 0 && (
        <Field label="可用模型">
          <div className="la-row">{group.models.map(model => <Tag key={model.id}>{model.name}</Tag>)}</div>
        </Field>
      )}
      {(view.id === DEEPSEEK.provider || (group && group.models.length > 0)) && <Advanced view={view} store={store} catalog={catalog} models={group?.models ?? []} />}
      <ErrorText error={remove.error} />
    </div>
  )
}

/** A route's profile in `llm-pi-ai`, as resolved. */
function routeOf(store: Store, id: string): unknown {
  return (store.access.values(PI_AI)?.providers as Readonly<Record<string, unknown>> | undefined)?.[id]
}

/** Where DSH keeps this service's model limits (see limits.ts). */
function whereOf(view: ProviderView, store: Store): Where | undefined {
  if (view.id === DEEPSEEK.provider) {
    const ns = store.namespaces.data?.find(item => item.ns === DEEPSEEK.ns)
    return { kind: 'deepseek', base: (ns?.base?.models ?? ns?.value.models ?? []) as ModelEntry[], user: ns?.user?.models as ModelEntry[] | undefined }
  }
  // The learner's own layer, not the resolved value: that one carries schema defaults (an empty `compat`…) which,
  // written back, a route on another protocol would refuse.
  const own = store.namespaces.data?.find(item => item.ns === PI_AI)?.user?.providers?.[view.id] as { readonly models?: ModelEntry[]; readonly modelOverrides?: Record<string, Limits> } | undefined
  const route = own ?? (routeOf(store, view.id) ? {} : undefined)
  if (!route) return undefined
  return Array.isArray(route.models) ? { kind: 'list', route: view.id, models: route.models } : { kind: 'overrides', route: view.id, overrides: route.modelOverrides ?? {} }
}

/** 高级设置 of a model service: DeepSeek's address and thinking, then one model's limits. */
function Advanced({ view, store, catalog, models }: { view: ProviderView; store: Store; catalog: ModelCatalog; models: readonly CatalogModel[] }): ReactNode {
  const [picked, setPicked] = useState<string>()
  const where = whereOf(view, store)
  const deepseek = view.id === DEEPSEEK.provider
  const own = store.namespaces.data?.find(item => item.ns === DEEPSEEK.ns)?.user ?? {}
  const changed = (deepseek && (own.baseURL !== undefined || own.thinking !== undefined)) || (where && models.some(model => Object.keys(currentLimits(where, model.id)).length > 0))
  const model = models.find(item => item.id === picked) ?? models[0]
  return (
    <Disclosure summary={changed ? '高级设置（已改）' : '高级设置'}>
      <div className="la-stack la-advanced">
        {deepseek && <BaseUrl store={store} value={view.baseURL} />}
        {deepseek && <DeepSeekThinking store={store} catalog={catalog} />}
        {where && model && (
          // Drafts start from what is stored: start again once a save comes back.
          <ModelLimits key={`${model.id}:${JSON.stringify(currentLimits(where, model.id))}:${model.reasoning?.efforts.map(effort => effort.id).join() ?? ''}`} view={view} store={store} catalog={catalog} where={where} models={models} model={model} onPick={setPicked} />
        )}
      </div>
    </Disclosure>
  )
}

/** DeepSeek's endpoint: an address saved here wins, then the launch environment's `DEEPSEEK_BASE_URL`, then the official one. */
function BaseUrl({ store, value }: { store: Store; value: string | undefined }): ReactNode {
  const [draft, setDraft] = useState(value ?? '')
  const action = useAction()
  useEffect(() => setDraft(value ?? ''), [value])
  return (
    <Field label="接口地址" hint="留空时用启动环境里的 DEEPSEEK_BASE_URL，没有就用 DeepSeek 官方地址。">
      <div className="la-row">
        <TextField value={draft} onChange={setDraft} placeholder="https://api.deepseek.com/anthropic" width={340} aria-label="DeepSeek 接口地址" />
        <Button size="sm" variant="primary" loading={action.busy} disabled={draft.trim() === (value ?? '')} onClick={() => action.run(() => store.access.set(DEEPSEEK.ns, 'baseURL', draft.trim() || undefined))}>保存</Button>
      </div>
      <ErrorText error={action.error} />
    </Field>
  )
}

/**
 * DeepSeek's thinking: its levels are fixed (不思考, 低, 高, 最高); a relay that cannot think turns it off for every
 * request. The default model's effort and the service's own default must then be 不思考, or DSH refuses the request.
 */
function DeepSeekThinking({ store, catalog }: { store: Store; catalog: ModelCatalog }): ReactNode {
  const action = useAction()
  const ns = store.namespaces.data?.find(item => item.ns === DEEPSEEK.ns)
  const on = ns?.value.thinking !== 'disabled'
  const set = (next: boolean) => action.run(async () => {
    if (!next && catalog.default.provider === DEEPSEEK.provider && catalog.default.reasoningEffort && catalog.default.reasoningEffort !== 'off') {
      await store.mutate('agent-default-model', [{ op: 'unset', path: ['reasoningEffort'] }])
    }
    const effort = ns?.user?.reasoningEffort as string | undefined
    await store.mutate(DEEPSEEK.ns, next
      ? [{ op: 'unset', path: ['thinking'] }]
      : [{ op: 'set', path: ['thinking'], value: 'disabled' }, ...(effort && effort !== 'off' ? [{ op: 'unset' as const, path: ['reasoningEffort'] }] : [])])
  })
  return (
    <Field label="思考" hint="DeepSeek 的思考强度固定为不思考、低、高、最高。中转站不支持思考时选“不支持”，所有请求都不思考。">
      <Segmented<'on' | 'off'> value={on ? 'on' : 'off'} onChange={value => set(value === 'on')} disabled={action.busy} aria-label="DeepSeek 思考"
        options={[{ value: 'on', label: '支持思考' }, { value: 'off', label: '不支持' }]} />
      <ErrorText error={action.error} />
    </Field>
  )
}

/** One model's context window, output cap and (outside DeepSeek) thinking levels; blank fields follow the default. */
function ModelLimits({ view, store, catalog, where, models, model, onPick }: {
  view: ProviderView
  store: Store
  catalog: ModelCatalog
  where: Where
  models: readonly CatalogModel[]
  model: CatalogModel
  onPick(id: string): void
}): ReactNode {
  const action = useAction()
  const own = currentLimits(where, model.id)
  const live = useLoad(shell, () => shell.call<{ contextWindow: number | null; maxTokens: number | null }>('settings', 'modelLimits', { provider: view.id, model: model.id }), [view.id, model.id], NO_FEED)
  const [context, setContext] = useState(own.contextWindow ? formatCapacity(own.contextWindow) : '')
  const [output, setOutput] = useState(own.maxTokens ? formatCapacity(own.maxTokens) : '')
  const offered = model.reasoning?.efforts.map(effort => effort.id) ?? []
  const [levels, setLevels] = useState<ReadonlySet<string>>(new Set(offered))
  const [touched, setTouched] = useState(false)
  const thinks = where.kind !== 'deepseek'
  const fallback = fallbackOf(view, store, where, model.id, own, live.data)

  const contextValue = parseCapacity(context)
  const outputValue = parseCapacity(output)
  const unreadable = (value: number | undefined) => value !== undefined && !(Number.isInteger(value) && value > 0)
  const capacity = contextValue ?? fallback.contextWindow
  const problem = unreadable(contextValue) || unreadable(outputValue)
    ? '写一个正整数，或者 128K、1M 这样的写法'
    : outputValue !== undefined && capacity !== undefined && outputValue > capacity ? `最大输出不能超过上下文窗口（${formatCapacity(capacity)}）` : undefined
  const efforts = thinks && touched ? effortsOf(levels) : own.reasoningEfforts
  const next: Limits = { ...(contextValue ? { contextWindow: contextValue } : {}), ...(outputValue ? { maxTokens: outputValue } : {}), ...(efforts === undefined ? {} : { reasoningEfforts: efforts }) }
  const dirty = JSON.stringify(next) !== JSON.stringify(own)

  const save = (limits: Limits) => action.run(async () => {
    // The default model's effort must stay one this model offers.
    const effort = catalog.default.reasoningEffort
    if (limits.reasoningEfforts !== undefined && catalog.default.provider === view.id && catalog.default.model === model.id && effort && !levelsOf(limits.reasoningEfforts).includes(effort)) {
      await store.mutate('agent-default-model', [{ op: 'unset', path: ['reasoningEffort'] }])
    }
    await store.mutate(where.kind === 'deepseek' ? DEEPSEEK.ns : PI_AI, limitOps(where, model.id, limits))
  })
  const toggle = (level: string, on: boolean) => {
    setTouched(true)
    setLevels(previous => {
      const changed = new Set(previous)
      if (on) changed.add(level)
      else changed.delete(level)
      return changed
    })
  }
  return (
    <div className="la-stack la-model-limits">
      {models.length > 1 && (
        <Field label="模型">
          <Select value={model.id} width={300} aria-label="要设置的模型" onChange={onPick}
            options={models.map(item => ({ value: item.id, label: item.name, ...(Object.keys(currentLimits(where, item.id)).length ? { hint: '已改' } : {}) }))} />
        </Field>
      )}
      <div className="la-row la-limit-fields">
        <Field label="上下文窗口" hint="问题和回复合计的上限。对话接近它时，主老师会先压缩前面的内容。">
          <TextField value={context} onChange={setContext} width={160} aria-label="上下文窗口" placeholder={fallback.contextWindow ? `默认 ${formatCapacity(fallback.contextWindow)}` : '默认：厂商目录的值'} />
        </Field>
        <Field label="最大输出" hint="一次回复的上限，思考也算在内。写教材一次要 16K，设得更小会被截断。">
          <TextField value={output} onChange={setOutput} width={160} aria-label="最大输出" placeholder={fallback.maxTokens ? `默认 ${formatCapacity(fallback.maxTokens)}` : '默认：厂商目录的值'} />
        </Field>
      </div>
      {thinks && (
        <Field label="思考程度" hint={levels.size === 0 || (levels.size === 1 && levels.has('off')) ? '这样表示不支持思考，请求里不带思考参数。' : '选了哪几档，“思考强度”里就有哪几档；一档都不选表示不支持思考。'}>
          <div className="la-row la-levels" role="group" aria-label="支持的思考程度">
            {LEVELS.map(level => <Checkbox key={level} checked={levels.has(level)} onChange={on => toggle(level, on)}>{LEVEL_LABEL[level]}</Checkbox>)}
          </div>
        </Field>
      )}
      {problem && <p className="la-warn-text la-small" role="alert">{problem}</p>}
      <div className="la-row">
        <Button size="sm" variant="primary" loading={action.busy} disabled={!dirty || !!problem} onClick={() => save(next)}>保存</Button>
        {Object.keys(own).length > 0 && <Button size="sm" variant="quiet" disabled={action.busy} onClick={() => save({})}>恢复默认</Button>}
      </div>
      <ErrorText error={action.error ?? live.error} />
    </div>
  )
}

/** What a blank field falls back to, where the page can tell; a catalog provider's own values stay unknown once overridden. */
function fallbackOf(view: ProviderView, store: Store, where: Where, id: string, own: Limits, live: { contextWindow: number | null; maxTokens: number | null } | undefined): { contextWindow?: number; maxTokens?: number } {
  if (where.kind === 'deepseek') {
    const ns = store.namespaces.data?.find(item => item.ns === DEEPSEEK.ns)
    const base = where.base.find(entry => entry.id === id) as { contextWindow?: number; maxTokens?: number } | undefined
    return { contextWindow: base?.contextWindow ?? ns?.value.defaultContextWindow, maxTokens: base?.maxTokens ?? ns?.value.maxTokens }
  }
  const route = routeOf(store, view.id) as { defaultContextWindow?: number; defaultMaxTokens?: number } | undefined
  if (where.kind === 'list') return { contextWindow: route?.defaultContextWindow ?? 262_144, maxTokens: route?.defaultMaxTokens ?? 32_768 }
  return {
    contextWindow: own.contextWindow === undefined ? live?.contextWindow ?? undefined : undefined,
    maxTokens: own.maxTokens === undefined ? live?.maxTokens ?? undefined : undefined,
  }
}

function PasswordInput({ value, onChange, label }: { value: string; onChange(value: string): void; label: string }): ReactNode {
  return (
    <div className="la-field-box la-secret-box">
      <input className="la-field-input" type="password" autoComplete="new-password" spellCheck={false} value={value} placeholder="粘贴密钥" aria-label={label}
        onChange={event => onChange(event.target.value)} />
    </div>
  )
}

/** 添加模型服务: a provider DSH already knows (key only), or a self-declared compatible endpoint. */
function AddProvider({ store, configurable, taken, onClose }: { store: Store; configurable: readonly ConfigurableProvider[]; taken: ReadonlySet<string>; onClose(): void }): ReactNode {
  const [mode, setMode] = useState<'known' | 'custom'>('known')
  return (
    <div className="la-settings-card la-add-provider">
      <div className="la-row">
        <span className="la-provider-name">添加模型服务</span>
        <span className="la-spacer" />
        <Button size="sm" variant="quiet" onClick={onClose}>取消</Button>
      </div>
      <Segmented<'known' | 'custom'> value={mode} onChange={setMode} aria-label="添加方式" options={[{ value: 'known', label: '常见厂商' }, { value: 'custom', label: '自定义接口' }]} />
      <span className="la-faint la-small">{mode === 'known' ? 'DSH 已经认识的厂商：选好后填密钥，模型列表由 DSH 提供。' : '兼容 OpenAI 或 Anthropic 接口的服务，例如中转站或自己部署的模型。'}</span>
      {mode === 'known'
        ? <AddKnown store={store} configurable={configurable.filter(entry => entry.settingsNs === PI_AI && !entry.declared && !taken.has(entry.provider) && !HIDDEN_PROVIDERS.has(entry.provider))} onDone={onClose} />
        : <AddCustom store={store} taken={taken} onDone={onClose} />}
    </div>
  )
}

function AddKnown({ store, configurable, onDone }: { store: Store; configurable: readonly ConfigurableProvider[]; onDone(): void }): ReactNode {
  const [provider, setProvider] = useState<string>()
  const [key, setKey] = useState('')
  const action = useAction()
  const rank = (id: string) => KNOWN_PROVIDERS.findIndex(([known]) => known === id) + 1 || KNOWN_PROVIDERS.length + 1
  const options = [...configurable]
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.provider.localeCompare(b.provider))
    .map(entry => {
      const name = providerName(entry.provider) ?? entry.displayName
      return { value: entry.provider, label: name, ...(name === entry.provider ? {} : { hint: entry.provider }) }
    })
  const add = () => action.run(async () => {
    const ref = keyRefOf(provider!)
    await store.mutate(PI_AI, [{ op: 'set', path: ['providers', provider!], value: key.trim() ? { apiKeyEnv: ref } : {} }])
    if (key.trim()) await store.access.saveSecret(ref, key.trim())
    onDone()
  })
  return (
    <div className="la-stack">
      <Field label="厂商"><Select value={provider} options={options} onChange={setProvider} width={300} placeholder="选择厂商" aria-label="厂商" /></Field>
      <Field label="密钥" hint="少数厂商用自己的登录方式（例如云平台的凭据），可以留空。"><PasswordInput value={key} onChange={setKey} label="密钥" /></Field>
      <div className="la-row"><Button variant="primary" disabled={!provider} loading={action.busy} onClick={add}>添加</Button></div>
      <ErrorText error={action.error} />
    </div>
  )
}

function AddCustom({ store, taken, onDone }: { store: Store; taken: ReadonlySet<string>; onDone(): void }): ReactNode {
  const protocols = protocolsOf(store.namespaces.data?.find(view => view.ns === PI_AI))
  const [route, setRoute] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [api, setApi] = useState(protocols[0] ?? 'openai-completions')
  const [baseURL, setBaseURL] = useState('')
  const [key, setKey] = useState('')
  const [found, setFound] = useState<readonly DiscoveredModel[]>()
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const discover = useAction()
  const create = useAction()
  const routeProblem = route && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(route) ? '只用小写字母、数字和连字符，例如 my-gateway' : taken.has(route) ? '这个名字已经用过了' : undefined
  const urlProblem = baseURL.trim() && !/^https?:\/\/[^\s/]+/.test(baseURL.trim()) ? '要以 http:// 或 https:// 开头' : undefined
  const ready = route && !routeProblem && baseURL.trim() && !urlProblem && chosen.size > 0

  const fetchModels = () => discover.run(async () => {
    const models = await unwrap(remote.llm.discoverModels(PI_AI, { baseURL: baseURL.trim(), api, ...(key.trim() ? { apiKey: key.trim() } : {}) }))
    setFound(models)
    setChosen(new Set())
  })
  const add = () => create.run(async () => {
    const ref = keyRefOf(route)
    const models = (found ?? []).filter(model => chosen.has(model.id)).map(model => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      ...(model.inputModalities?.length ? { input: model.inputModalities } : {}),
    }))
    await store.mutate(PI_AI, [{ op: 'set', path: ['providers', route], value: {
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      ...(key.trim() ? { apiKeyEnv: ref } : {}),
      api, baseURL: baseURL.trim(), models,
    } }])
    if (key.trim()) await store.access.saveSecret(ref, key.trim())
    onDone()
  })
  return (
    <div className="la-stack">
      <div className="la-row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <Field label="名字（英文标识）" hint={routeProblem}><TextField value={route} onChange={value => setRoute(value.trim())} placeholder="my-gateway" width={200} aria-label="名字" /></Field>
        <Field label="显示名称"><TextField value={displayName} onChange={setDisplayName} placeholder="我的中转站" width={200} aria-label="显示名称" /></Field>
      </div>
      <Field label="接口协议">
        <Segmented value={api} onChange={setApi} aria-label="接口协议" options={protocols.map(value => ({ value, label: PROTOCOL_LABEL[value] ?? value }))} />
      </Field>
      <Field label="接口地址" hint={urlProblem ?? (api === 'anthropic-messages' ? '例如 https://gateway.example' : '例如 https://gateway.example/v1')}>
        <TextField value={baseURL} onChange={setBaseURL} placeholder="https://" width={340} aria-label="接口地址" />
      </Field>
      <Field label="密钥"><PasswordInput value={key} onChange={setKey} label="密钥" /></Field>
      <div className="la-row">
        <Button disabled={!baseURL.trim() || !!urlProblem} loading={discover.busy} onClick={fetchModels}>获取可用模型</Button>
        {found && <span className="la-faint la-small">找到 {found.length} 个模型，勾选要用的</span>}
      </div>
      <ErrorText error={discover.error} />
      {found && found.length > 0 && (
        <div className="la-model-pick">
          {found.map(model => (
            <Checkbox key={model.id} checked={chosen.has(model.id)} onChange={checked => setChosen(previous => {
              const next = new Set(previous)
              if (checked) next.add(model.id)
              else next.delete(model.id)
              return next
            })}><span className="la-mono">{model.id}</span>{model.name && model.name !== model.id && <span className="la-faint">　{model.name}</span>}</Checkbox>
          ))}
        </div>
      )}
      <div className="la-row"><Button variant="primary" disabled={!ready} loading={create.busy} onClick={add}>添加</Button></div>
      <ErrorText error={create.error} />
    </div>
  )
}

/* ── 资料服务 ── */

function ServicesSection({ store, renderSlot }: { store: Store } & PropsRenderSlots<'learning.settings.services'>): ReactNode {
  return (
    <div className="la-stack" style={{ gap: 28 }}>
      {renderSlot('learning.settings.services', { access: store.access }, { fallback: <EmptyState icon={FileSearch} title="没有可以设置的资料服务" compact /> })}
    </div>
  )
}

/* ── 外观 ── */

function AppearanceSection(): ReactNode {
  const preference = useSyncExternalStore(listener => theme?.subscribe(listener) ?? (() => {}), () => theme?.service.getTheme().preference ?? 'system')
  return (
    <div className="la-settings-card">
      <SettingRow title="颜色" hint="跟随系统时，电脑切换深浅色，工作台也跟着切换。侧栏左下角的“外观”也可以切换。">
        <Segmented value={(['light', 'dark'].includes(preference) ? preference : 'system') as 'system' | 'light' | 'dark'} aria-label="颜色" disabled={!theme}
          onChange={value => theme?.service.setTheme(value)}
          options={[
            { value: 'system', label: <span className="la-row nowrap"><Monitor size={14} strokeWidth={1.75} />跟随系统</span> },
            { value: 'light', label: <span className="la-row nowrap"><Sun size={14} strokeWidth={1.75} />浅色</span> },
            { value: 'dark', label: <span className="la-row nowrap"><Moon size={14} strokeWidth={1.75} />深色</span> },
          ]} />
      </SettingRow>
    </div>
  )
}

/* ── 数据与隐私 ── */

function DataSection({ store }: { store: Store }): ReactNode {
  const about = useLoad(shell, () => shell.call<{ dataRoot: string }>('settings', 'about'), [], NO_FEED)
  const services = useLoad(shell, () => shell.call<{ parser: string; semanticSearch: boolean; embeddings?: string }>('library', 'services'), [store.access.revision], NO_FEED)
  const catalog = useCatalog(store.access.revision)
  const others = (catalog.data?.groups ?? []).filter(group => !group.id.startsWith('deepseek'))
  const flows: { name: string; what: string; on: boolean }[] = [
    { name: 'DeepSeek', what: '和老师的对话、讲解时引用的资料片段、你的作答', on: true },
    ...others.map(group => ({ name: group.name, what: '分给它的角色要处理的内容（见“模型分工”）', on: true })),
    { name: 'MinerU 云端', what: '导入的 PDF 原件', on: services.data?.parser === '云端' },
    { name: 'Voyage AI', what: '资料片段和检索时输入的问题', on: !!services.data?.embeddings },
  ]
  return (
    <div className="la-stack" style={{ gap: 28 }}>
      <Section title="学习库" description="课程、教材、作答记录和资料都存在这个文件夹里，可以用 Obsidian 打开。位置在工作台启动时确定，运行中不能更换。">
        {about.data ? <code className="la-path">{about.data.dataRoot}</code> : <Skeleton lines={1} />}
        <ErrorText error={about.error} />
      </Section>
      <Section title="发往在线服务的内容" description="只有用到的服务才会收到数据。">
        <div className="la-settings-card">
          {flows.map(flow => (
            <SettingRow key={flow.name} title={<span className="la-row nowrap"><Dot tone={flow.on ? 'accent' : 'neutral'} hollow={!flow.on} />{flow.name}</span>} hint={flow.what}>
              <span className={flow.on ? 'la-setting-value la-small' : 'la-setting-value la-faint la-small'}>{flow.on ? '在用' : '没在用'}</span>
            </SettingRow>
          ))}
        </div>
      </Section>
      <Section title="密钥" description="在设置页填写的密钥只保存在这台电脑上 DSH 的密钥文件里，不写进配置文件，也不进学习库。启动时环境变量（.env）里的同名密钥优先。" />
    </div>
  )
}

/* ── 插件 ── */

const PHASE: Record<string, { tone: Tone; text: string }> = {
  active: { tone: 'ok', text: '运行中' },
  failed: { tone: 'bad', text: '启动失败' },
  pending: { tone: 'warn', text: '等待依赖' },
  loading: { tone: 'warn', text: '加载中' },
  unloading: { tone: 'warn', text: '正在停止' },
}

function phaseOf(entry: InventoryEntry | undefined): { tone: Tone; text: string } {
  if (!entry) return { tone: 'neutral', text: '未加载' }
  if (!entry.enabled) return { tone: 'neutral', text: '已停用' }
  return PHASE[entry.fiberPhase ?? ''] ?? { tone: 'neutral', text: '未运行' }
}

function PluginsSection({ store, open }: { store: Store; open(section: SectionId): void }): ReactNode {
  const inventory = useLoad(shell, () => unwrap(remote.pluginInventory.list()), [], NO_FEED)
  const bundles = useLoad(shell, () => unwrap(remote.pluginManager.listBundles()), [], NO_FEED)
  if (inventory.error || bundles.error) return <ErrorText error={inventory.error ?? bundles.error} />
  if (!inventory.data || !bundles.data) return <Skeleton lines={8} />
  const app = bundles.data.find(bundle => bundle.name === '@learning-agent/app')
  const byModule = new Map(inventory.data.entries.map(entry => [entry.moduleName, entry]))
  const units = (app?.rows ?? []).filter(row => !row.moduleName.includes('agent-preset'))
  const ours = new Set(units.map(row => row.moduleName))
  const presets = inventory.data.agentPresets ?? []
  const base = inventory.data.entries.filter(entry => !ours.has(entry.moduleName))
  const running = base.filter(entry => entry.enabled && entry.fiberPhase === 'active').length
  const settingsOf = (rowId: string) => {
    const fields = fieldsOf(store.namespaces.data?.find(view => view.ns === rowId)?.schema ?? {})
    return { models: fields.some(([, node]) => node.meta?.role === MODEL_ROLE), services: fields.some(([, node]) => node.meta?.role !== MODEL_ROLE) }
  }
  return (
    <div className="la-stack" style={{ gap: 28 }}>
      <Section title="学习功能" count={units.length} description="学习工作台由这些插件组成，每个都是学习流程的一环，所以都标为必需，不能单独关掉。">
        <div className="la-plugin-grid">
          {units.map(row => {
            const entry = row.entryId ? inventory.data!.entries.find(item => item.entryId === row.entryId) : byModule.get(row.moduleName)
            const meta = entry?.meta ?? row.meta
            const status = phaseOf(entry)
            const users = presets.filter(preset => preset.rows.some(item => item.moduleName === `${row.moduleName}/tools`)).map(preset => preset.name ?? preset.id)
            const settings = settingsOf(row.rowId)
            return (
              <div key={row.rowId} className="la-plugin">
                <div className="la-plugin-head">
                  {meta?.icon ? <img className="la-plugin-icon" src={meta.icon} alt="" /> : <span className="la-plugin-icon"><Blocks size={16} strokeWidth={1.75} /></span>}
                  <span className="la-plugin-title">{textOf(meta?.title) ?? row.moduleName}</span>
                  <span className="la-plugin-status"><Dot tone={status.tone} />{status.text}</span>
                </div>
                <p className="la-plugin-text">{textOf(meta?.description)}</p>
                <div className="la-row la-plugin-foot">
                  <Tag>必需</Tag>
                  {users.length > 0 && <span className="la-faint la-small">{users.join('、')}会用到它的工具</span>}
                  {(settings.models || settings.services) && (
                    <span className="la-plugin-links">
                      {settings.models && <Button size="sm" variant="quiet" onClick={() => open('models')}>模型设置</Button>}
                      {settings.services && <Button size="sm" variant="quiet" onClick={() => open('services')}>资料服务设置</Button>}
                    </span>
                  )}
                </div>
                {meta?.error && <p className="la-plugin-text la-warn-text">{meta.error}</p>}
              </div>
            )
          })}
        </div>
      </Section>
      <Section title="DSH 基础组件" description={`学习工作台运行在 DSH 上，下面这些是 DSH 自己的组件：${running} 个在运行，${base.length - running} 个没用到（多是编程助手的功能）。这里只看不改。`}>
        <Disclosure summary={`查看全部 ${base.length} 个`}>
          <div className="la-plugin-list">
            {base.map(entry => {
              const status = phaseOf(entry)
              return (
                <div key={entry.entryId} className="la-plugin-line">
                  <Dot tone={status.tone} hollow={status.tone === 'neutral'} />
                  <span className="la-plugin-line-title">{textOf(entry.meta?.title) ?? entry.moduleName}</span>
                  <span className="la-faint la-small">{status.text}</span>
                </div>
              )
            })}
          </div>
        </Disclosure>
      </Section>
    </div>
  )
}

/* ── 关于 ── */

function AboutSection(): ReactNode {
  const bundles = useLoad(shell, () => unwrap(remote.pluginManager.listBundles()), [], NO_FEED)
  const version = (name: string) => bundles.data?.find(bundle => bundle.name === name)?.version ?? '—'
  return (
    <div className="la-settings-card">
      <SettingRow title="学习工作台">{bundles.data ? <code className="la-setting-value la-mono">{version('@learning-agent/app')}</code> : <Skeleton lines={1} />}</SettingRow>
      <SettingRow title="DSH" hint="学习工作台运行在 DSH 上：模型、会话和插件系统由它提供。">{bundles.data ? <code className="la-setting-value la-mono">{version('@deepseek-ai/dsh-base')}</code> : <Skeleton lines={1} />}</SettingRow>
      <ErrorText error={bundles.error} />
    </div>
  )
}
