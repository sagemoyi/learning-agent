// What 高级设置 writes for one model (docs/settings/design.md "模型的高级设置"), apart from the page so it can be
// tested. DSH keeps a model's limits in one of three places: DeepSeek's model list (`llm-deepseek` `models`, which
// replaces the built-in list as a whole), a declared route's own list (`llm-pi-ai` `providers.<route>.models`), or the
// overrides of a provider DSH's catalog already describes (`providers.<route>.modelOverrides.<model>`).

/** Thinking levels in DSH's order (pi-ai's `ModelThinkingLevel`). */
export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export const LEVEL_LABEL: Readonly<Record<string, string>> = { off: '不思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' }

export type Efforts = false | Readonly<Record<string, string | null>>

/** The learner's own values for one model; an absent field follows the default. */
export interface Limits {
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly reasoningEfforts?: Efforts
}

/** One model of a list, with fields this page does not edit (name, input types…) kept as they are. */
export type ModelEntry = Readonly<Record<string, unknown>> & { readonly id: string }
type Entry = ModelEntry

export type Where =
  | { readonly kind: 'deepseek'; readonly base: readonly Entry[]; readonly user: readonly Entry[] | undefined }
  | { readonly kind: 'list'; readonly route: string; readonly models: readonly Entry[] }
  | { readonly kind: 'overrides'; readonly route: string; readonly overrides: Readonly<Record<string, Limits>> }

export type Op = { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown } | { readonly op: 'unset'; readonly path: readonly string[] }

const FIELDS = ['contextWindow', 'maxTokens', 'reasoningEfforts'] as const
const SCALE: Readonly<Record<string, number>> = { k: 1e3, m: 1e6 }

/** `128K`, `1M` or a plain count (K is 1000 and M a million, as DSH's own page reads them); blank is undefined, unreadable NaN. */
export function parseCapacity(text: string): number | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(trimmed)
  if (!match) return NaN
  const value = Number(match[1]) * (match[2] ? SCALE[match[2].toLowerCase()]! : 1)
  return Math.abs(value - Math.round(value)) < 1e-6 ? Math.round(value) : value
}

/** The shortest spelling `parseCapacity` reads back: 1M, 128K, else the plain count. */
export function formatCapacity(value: number): string {
  if (!Number.isInteger(value) || value <= 0) return String(value)
  if (value % 1e6 === 0) return `${value / 1e6}M`
  if (value % 1e3 === 0) return `${value / 1e3}K`
  return String(value)
}

/**
 * Ticked levels as DSH's `reasoningEfforts`: each level is sent under its own name, 不思考 sends nothing. None ticked,
 * or 不思考 alone, is a model that does not think (DSH refuses a list without a level beyond off).
 */
export function effortsOf(levels: Iterable<string>): Efforts {
  const ticked = new Set(levels)
  const chosen = LEVELS.filter(level => ticked.has(level))
  if (!chosen.some(level => level !== 'off')) return false
  return Object.fromEntries(chosen.map(level => [level, level === 'off' ? null : level]))
}

/** The levels a stored `reasoningEfforts` offers. */
export function levelsOf(efforts: Efforts): string[] {
  return efforts === false ? [] : LEVELS.filter(level => level in efforts)
}

/** The learner's own values for a model, wherever DSH keeps them. DeepSeek's list counts only fields that differ from the built-in entry. */
export function currentLimits(where: Where, id: string): Limits {
  if (where.kind === 'overrides') return pick(where.overrides[id] ?? {})
  if (where.kind === 'list') return pick(where.models.find(entry => entry.id === id) ?? {})
  const own = where.user?.find(entry => entry.id === id)
  if (!own) return {}
  const base = where.base.find(entry => entry.id === id) ?? {}
  return pick(Object.fromEntries(FIELDS.filter(field => own[field] !== (base as Record<string, unknown>)[field]).map(field => [field, own[field]])))
}

/** The settings writes that give one model these values; an empty `limits` puts the model back to its default. */
export function limitOps(where: Where, id: string, limits: Limits): Op[] {
  if (where.kind === 'overrides') {
    const path = ['providers', where.route, 'modelOverrides', id]
    const own = pick(limits)
    if (Object.keys(own).length) return [{ op: 'set', path, value: own }]
    // The last override gone: no empty map left behind.
    return [{ op: 'unset', path: Object.keys(where.overrides).some(other => other !== id) ? path : path.slice(0, -1) }]
  }
  if (where.kind === 'list') {
    return [{ op: 'set', path: ['providers', where.route, 'models'], value: where.models.map(entry => (entry.id === id ? withFields(entry, limits, {}) : entry)) }]
  }
  // DeepSeek: a blank field takes the built-in entry's value back; a list equal to the built-in one is no override.
  const base = where.base.find(entry => entry.id === id) ?? {}
  const models = (where.user ?? where.base).map(entry => (entry.id === id ? withFields(entry, { contextWindow: limits.contextWindow, maxTokens: limits.maxTokens }, base) : entry))
  return sameList(models, where.base) ? [{ op: 'unset', path: ['models'] }] : [{ op: 'set', path: ['models'], value: models }]
}

function sameList(a: readonly Entry[], b: readonly Entry[]): boolean {
  const key = (entry: Entry) => JSON.stringify(Object.keys(entry).sort().map(field => [field, entry[field]]))
  return a.length === b.length && a.every((entry, index) => key(entry) === key(b[index]!))
}

function pick(source: Limits | Readonly<Record<string, unknown>>): Limits {
  const fields = source as Readonly<Record<string, unknown>>
  return Object.fromEntries(FIELDS.filter(field => fields[field] !== undefined).map(field => [field, fields[field]])) as Limits
}

/** `entry` with the limit fields replaced: a value from `limits`, else `fallback`'s, else none. Other fields stay in place. */
function withFields(entry: Entry, limits: Limits, fallback: Readonly<Record<string, unknown>>): Entry {
  const next: Record<string, unknown> = { ...entry }
  for (const field of FIELDS) {
    const value = limits[field] ?? fallback[field]
    if (value === undefined) delete next[field]
    else next[field] = value
  }
  return next as Entry
}
