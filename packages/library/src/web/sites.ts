// Site rules: how much a page found online can be trusted, decided by where it lives, never by a model
// (docs/library/research.md "怎么判断权威"). The learner's rules override the built-in ones; within each
// set the most specific match wins. Unknown sites are clues: they may point somewhere, never be cited.
import type { Authority, SiteRule } from '@learning-agent/contracts'

export type Rating = { authority: Authority; rule: string } | { authority: 'blocked'; rule: string }

interface BuiltIn {
  readonly sites: readonly string[]
  readonly authority: Authority | 'blocked'
  readonly rule: string
  /** Searched on purpose for questions in this language (targeted search). */
  readonly targeted?: 'zh' | 'en'
}

/** Each entry matches the site itself and every subdomain (`edu.cn` covers `hg.kmust.edu.cn`). */
const BUILT_IN: readonly BuiltIn[] = [
  { sites: ['edu.cn'], authority: '2', rule: '国内高校', targeted: 'zh' },
  { sites: ['gov.cn'], authority: '2', rule: '政府和国家标准', targeted: 'zh' },
  { sites: ['ac.cn'], authority: '2', rule: '国内科研机构', targeted: 'zh' },
  { sites: ['icourse163.org', 'smartedu.cn', 'xuetangx.com'], authority: '2', rule: '国家级课程平台', targeted: 'zh' },
  { sites: ['hep.com.cn', 'cip.com.cn'], authority: '2', rule: '教材出版社', targeted: 'zh' },
  { sites: ['iso.org'], authority: '2', rule: '标准组织' },
  { sites: ['edu', 'ac.uk', 'edu.au', 'ac.jp', 'edu.hk', 'edu.sg'], authority: '3', rule: '国外高校', targeted: 'en' },
  { sites: ['nptel.ac.in', 'libretexts.org'], authority: '3', rule: '国外开放课程', targeted: 'en' },
  {
    sites: ['doi.org', 'ncbi.nlm.nih.gov', 'core.ac.uk', 'sciencedirect.com', 'springer.com', 'wiley.com', 'acs.org', 'aiche.org', 'tandfonline.com', 'rsc.org', 'iop.org', 'nature.com', 'science.org', 'cnki.net', 'wanfangdata.com.cn'],
    authority: '3', rule: '学术出版',
  },
  { sites: ['wikipedia.org', 'baike.baidu.com', 'baike.sogou.com', 'baike.so.com'], authority: 'clue', rule: '百科' },
  {
    sites: ['360doc.com', 'book118.com', 'doc88.com', 'docin.com', 'taodocs.com', 'wenku.baidu.com', 'cucdc.com', 'renrendoc.com', 'mayiwenku.com', 'wendangku.net', 'coursehero.com'],
    authority: 'clue', rule: '文库和转载站',
  },
  {
    sites: ['zhihu.com', 'zhidao.baidu.com', 'iask.sina.com.cn', 'shuashuati.com', 'chatiyi.com', '365zhishi.cn', 'zuoyebang.com', 'chegg.com', 'quizlet.com'],
    authority: 'clue', rule: '问答和题库',
  },
  {
    sites: ['csdn.net', 'cnblogs.com', 'jianshu.com', 'mp.weixin.qq.com', 'toutiao.com', 'sohu.com', '163.com', 'bilibili.com', 'youtube.com', 'medium.com'],
    authority: 'clue', rule: '博客、媒体和视频',
  },
  { sites: ['researchgate.net', 'arxiv.org', 'academia.edu'], authority: 'clue', rule: '论文转载和预印本' },
  {
    sites: ['pdfdrive.com', 'dokumen.pub', 'ebin.pub', 'epdf.pub', 'vdoc.pub', 'pdfcoffee.com', 'annas-archive.org', 'singlelogin.re'],
    authority: 'blocked', rule: '盗版资料站',
  },
]

/** Mirrors of pirated books rotate their top-level domains, so these match by name. */
const PIRATE = /(^|\.)(libgen|z-lib|zlibrary|z-library|sci-hub|annas-archive|b-ok)\./

const UNKNOWN: Rating = { authority: 'clue', rule: '不在可信网站清单里' }

/** Second-level public suffixes, so `hg.kmust.edu.cn` belongs to `kmust.edu.cn`. */
const TWO_LABEL_SUFFIXES = new Set([
  'edu.cn', 'gov.cn', 'com.cn', 'org.cn', 'net.cn', 'ac.cn', 'ac.uk', 'co.uk', 'org.uk', 'edu.au', 'com.au',
  'ac.jp', 'co.jp', 'edu.hk', 'com.hk', 'edu.tw', 'com.tw', 'ac.in', 'co.in', 'edu.sg', 'com.sg',
])

function covers(site: string, host: string): boolean {
  return host === site || host.endsWith(`.${site}`)
}

/** The host a rule should name: lower case, without `www.`. */
export function siteOf(url: string | URL): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
}

/** `edu.cn`, `edu`: names under which anyone registers, so no organization owns them. */
export function isPublicSuffix(site: string): boolean {
  return !site.includes('.') || TWO_LABEL_SUFFIXES.has(site)
}

/** Registrable domain: one organization's pages share it. IP addresses stand for themselves. */
export function organization(host: string): string {
  const name = host.toLowerCase().replace(/^www\./, '')
  if (/^[\d.]+$/.test(name) || name.includes(':')) return name
  const labels = name.split('.')
  const keep = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2
  return labels.slice(-keep).join('.')
}

/** Rate one address: the learner's most specific rule, else the built-in one, else a clue. */
export function rate(url: string, learnerRules: readonly SiteRule[] = []): Rating {
  const host = siteOf(url)
  const own = learnerRules.filter(rule => covers(rule.host.toLowerCase(), host)).sort((a, b) => b.host.length - a.host.length)[0]
  if (own) return { authority: own.authority, rule: '你设定的网站' } as Rating
  if (PIRATE.test(host)) return { authority: 'blocked', rule: '盗版资料站' }
  let best: { site: string; entry: BuiltIn } | undefined
  for (const entry of BUILT_IN) {
    for (const site of entry.sites) if (covers(site, host) && (!best || site.length > best.site.length)) best = { site, entry }
  }
  return best ? { authority: best.entry.authority, rule: best.entry.rule } as Rating : UNKNOWN
}

/** Sites a targeted search in this language is limited to: the learner's trusted sites, then built-in ones. */
export function trustedSites(language: 'zh' | 'en', learnerRules: readonly SiteRule[] = []): string[] {
  const own = learnerRules.filter(rule => rule.authority !== 'clue' && rule.authority !== 'blocked').map(rule => rule.host)
  const builtIn = BUILT_IN.filter(entry => entry.targeted === language).flatMap(entry => entry.sites)
  return [...new Set([...own, ...builtIn])]
}

/** Questions with any Chinese character are searched as Chinese. */
export function languageOf(text: string): 'zh' | 'en' {
  return /\p{Script=Han}/u.test(text) ? 'zh' : 'en'
}

/** Same page, different spelling: no fragment, no tracking parameters, lower-case host, no default port. */
export function normalizeUrl(url: string): string {
  const parsed = new URL(url)
  parsed.hash = ''
  for (const key of [...parsed.searchParams.keys()]) if (/^utm_/i.test(key)) parsed.searchParams.delete(key)
  return parsed.toString()
}

/** What the address looks like it serves; the response's content type decides when fetched. */
export function formatOf(url: string): 'html' | 'pdf' | 'other' {
  const path = new URL(url).pathname.toLowerCase()
  if (/\.pdf$/.test(path) || /[?&]e=\.pdf$/i.test(url)) return 'pdf'
  if (/\.(pptx?|docx?|xlsx?|zip|rar|7z|mp4|mp3)$/.test(path)) return 'other'
  return 'html'
}

export const AUTHORITY_TEXT: Record<Authority, string> = { '1': '一级', '2': '二级', '3': '三级', clue: '只当线索' }
