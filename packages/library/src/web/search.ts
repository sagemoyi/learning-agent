// Web search services behind one interface (docs/library/design.md "服务兼容"): the learner's preferred
// service first, then the measured order; a failing or missing service hands over to the next one.
// Each question runs twice: limited to trusted sites, and open. Results are rated by site rules.
import type { SiteRule, WebCandidate, WebSearch } from '@learning-agent/contracts'
import { AUTHORITY_TEXT, formatOf, isPublicSuffix, languageOf, normalizeUrl, organization, rate, siteOf, trustedSites } from './sites.ts'

export type ProviderId = 'exa' | 'bocha' | 'tavily'

/** Measured on course-topic queries (compatibility.md, 10-07): Exa finds the most university sources. */
export const PROVIDER_ORDER: readonly ProviderId[] = ['exa', 'bocha', 'tavily']
export const PROVIDER_NAME: Record<ProviderId, string> = { exa: 'Exa', bocha: '博查', tavily: 'Tavily' }
export const PROVIDER_KEY: Record<ProviderId, string> = { exa: 'EXA_API_KEY', bocha: 'BOCHA_API_KEY', tavily: 'TAVILY_API_KEY' }

export interface WebHit {
  readonly url: string
  readonly title: string
  readonly snippet: string
  readonly publishedAt?: string
}

export interface SearchProvider {
  readonly id: ProviderId
  /**
   * Exa and Tavily also take suffixes like `edu.cn` (Exa rejects a bare `edu`: "Domain must include a
   * top-level domain"); Bocha's filter matches nothing for a suffix, so it gets registrable domains only.
   */
  readonly suffixFilter: boolean
  search(query: string, options: { readonly sites?: readonly string[]; readonly limit: number }, signal?: AbortSignal): Promise<WebHit[]>
}

const TIMEOUT_MS = 20_000
const SNIPPET = 300

async function post<T>(name: string, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) as Record<string, unknown> } catch { /* reported with the status below */ }
  const reason = typeof json.error === 'string' ? json.error : typeof json.msg === 'string' ? json.msg : typeof json.detail === 'string' ? json.detail : text.slice(0, 120)
  if (!response.ok) throw new Error(`${name} 返回 ${response.status}${reason ? `：${reason}` : ''}`)
  // Bocha answers HTTP 200 with its own failure code in the body.
  if (typeof json.code === 'number' && json.code !== 200) throw new Error(`${name} 返回错误 ${json.code}${reason ? `：${reason}` : ''}`)
  return json as T
}

/** Text a service pulled out of a PDF carries private-use glyphs and replacement marks; they read as boxes. */
function clip(text: string | undefined): string {
  const flat = (text ?? '').replace(/[-�]/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > SNIPPET ? `${flat.slice(0, SNIPPET)}…` : flat
}

export function exaProvider(key: string, base = 'https://api.exa.ai'): SearchProvider {
  return {
    id: 'exa',
    suffixFilter: true,
    async search(query, { sites, limit }, signal) {
      const body = await post<{ results?: { url: string; title?: string; publishedDate?: string; highlights?: string[]; text?: string }[] }>('Exa', `${base}/search`, { 'x-api-key': key }, {
        query, type: 'auto', numResults: limit,
        ...(sites?.length ? { includeDomains: sites } : {}),
        contents: { highlights: { numSentences: 2, highlightsPerUrl: 2 } },
      }, signal)
      return (body.results ?? []).map(result => ({ url: result.url, title: result.title?.trim() || siteOf(result.url), snippet: clip(result.highlights?.join(' … ') ?? result.text), publishedAt: result.publishedDate }))
    },
  }
}

export function bochaProvider(key: string, base = 'https://api.bochaai.com'): SearchProvider {
  return {
    id: 'bocha',
    suffixFilter: false,
    async search(query, { sites, limit }, signal) {
      const body = await post<{ data?: { webPages?: { value?: { url: string; name?: string; snippet?: string; summary?: string; datePublished?: string }[] } } }>('博查', `${base}/v1/web-search`, { authorization: `Bearer ${key}` }, {
        query, summary: true, count: limit, ...(sites?.length ? { include: sites.join('|') } : {}),
      }, signal)
      return (body.data?.webPages?.value ?? []).map(result => ({ url: result.url, title: result.name?.trim() || siteOf(result.url), snippet: clip(result.summary || result.snippet), publishedAt: result.datePublished }))
    },
  }
}

export function tavilyProvider(key: string, base = 'https://api.tavily.com'): SearchProvider {
  return {
    id: 'tavily',
    suffixFilter: true,
    async search(query, { sites, limit }, signal) {
      const body = await post<{ results?: { url: string; title?: string; content?: string; published_date?: string }[] }>('Tavily', `${base}/search`, { authorization: `Bearer ${key}` }, {
        query, max_results: limit, search_depth: 'basic', ...(sites?.length ? { include_domains: sites } : {}),
      }, signal)
      return (body.results ?? []).map(result => ({ url: result.url, title: result.title?.trim() || siteOf(result.url), snippet: clip(result.content), publishedAt: result.published_date }))
    },
  }
}

/** Exa's own copy of a page, for pages this computer cannot open. */
export async function exaContents(key: string, url: string, signal?: AbortSignal, base = 'https://api.exa.ai'): Promise<{ title?: string; text: string } | undefined> {
  const body = await post<{ results?: { title?: string; text?: string }[] }>('Exa', `${base}/contents`, { 'x-api-key': key }, { urls: [url], text: { maxCharacters: 100_000 } }, signal)
  const result = body.results?.[0]
  return result?.text?.trim() ? { title: result.title, text: result.text } : undefined
}

/** Run one query on the first provider that answers; earlier failures become notes. */
async function firstAnswer(providers: readonly SearchProvider[], query: string, sites: readonly string[] | undefined, limit: number, notes: string[], signal?: AbortSignal): Promise<{ hits: WebHit[]; provider: ProviderId } | undefined> {
  for (const [index, provider] of providers.entries()) {
    const filter = sites?.filter(site => provider.suffixFilter ? site.includes('.') : !isPublicSuffix(site))
    // A site-limited search this service cannot express is left to the open search.
    if (sites && !filter?.length) continue
    try {
      return { hits: await provider.search(query, { sites: filter, limit }, signal), provider: provider.id }
    } catch (error) {
      signal?.throwIfAborted()
      const next = providers.slice(index + 1)[0]
      notes.push(`${PROVIDER_NAME[provider.id]}搜索失败（${error instanceof Error ? error.message : String(error)}）${next ? `，改用${PROVIDER_NAME[next.id]}` : ''}`)
    }
  }
  return undefined
}

const PER_SEARCH = 8
const PER_ORGANIZATION = 2
const CANDIDATES_PER_QUESTION = 6
const CLUES_PER_QUESTION = 4

/**
 * Search every question on trusted sites and openly, merge, rate, and keep the best: authority first,
 * then the order the services ranked them; at most two per organization, since one university's
 * slides are not independent of each other.
 */
export async function searchWeb(questions: readonly string[], providers: readonly SearchProvider[], rules: readonly SiteRule[], signal?: AbortSignal): Promise<WebSearch> {
  const notes: string[] = []
  if (providers.length === 0) return { candidates: [], clues: [], notes: ['还没有可用的搜索服务：请在设置页"资料服务"里填写 Exa、博查或 Tavily 的密钥。'] }
  const perQuestion = await Promise.all(questions.map(async question => {
    const sites = trustedSites(languageOf(question), rules)
    const [targeted, open] = await Promise.all([
      firstAnswer(providers, question, sites, PER_SEARCH, notes, signal),
      firstAnswer(providers, question, undefined, PER_SEARCH, notes, signal),
    ])
    const seen = new Set<string>()
    const rated: WebCandidate[] = []
    for (const found of [targeted, open]) {
      for (const hit of found?.hits ?? []) {
        let key: string
        try { key = normalizeUrl(hit.url) } catch { continue }
        if (seen.has(key)) continue
        seen.add(key)
        const rating = rate(hit.url, rules)
        if (rating.authority === 'blocked') continue
        rated.push({
          url: hit.url, title: hit.title, snippet: hit.snippet, site: siteOf(hit.url), organization: organization(siteOf(hit.url)),
          authority: rating.authority, rule: rating.rule, format: formatOf(hit.url), provider: PROVIDER_NAME[found!.provider], question,
          ...(hit.publishedAt ? { publishedAt: hit.publishedAt } : {}),
        })
      }
    }
    const rank = (candidate: WebCandidate) => ({ '1': 0, '2': 1, '3': 2, clue: 3 })[candidate.authority]
    const sorted = rated.map((candidate, order) => ({ candidate, order })).sort((a, b) => rank(a.candidate) - rank(b.candidate) || a.order - b.order).map(entry => entry.candidate)
    const perOrganization = new Map<string, number>()
    const candidates = sorted.filter(candidate => {
      if (candidate.authority === 'clue') return false
      const count = perOrganization.get(candidate.organization) ?? 0
      perOrganization.set(candidate.organization, count + 1)
      return count < PER_ORGANIZATION
    }).slice(0, CANDIDATES_PER_QUESTION)
    const clues = sorted.filter(candidate => candidate.authority === 'clue').slice(0, CLUES_PER_QUESTION)
    if (!targeted && !open) notes.push(`"${question}" 没有搜到：所有搜索服务都失败了`)
    return { candidates, clues }
  }))
  return { candidates: perQuestion.flatMap(entry => entry.candidates), clues: perQuestion.flatMap(entry => entry.clues), notes: [...new Set(notes)] }
}

export function describeAuthority(candidate: Pick<WebCandidate, 'authority' | 'rule'>): string {
  return `${AUTHORITY_TEXT[candidate.authority]}（${candidate.rule}）`
}
