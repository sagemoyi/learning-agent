// Material found online: site rules, search fallbacks, safe downloads, page extraction and the add flow.
// Search services and web pages are a local server or in-memory fakes; nothing here reaches the internet.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SiteRule } from '@learning-agent/contracts'
import { Database } from '../../core/src/db.ts'
import { LibraryStore, libraryMigrations } from '../src/store.ts'
import { LibraryImports } from '../src/imports.ts'
import type { MineruParser } from '../src/parser.ts'
import { formatOf, normalizeUrl, organization, rate, trustedSites } from '../src/web/sites.ts'
import { bochaProvider, exaProvider, searchWeb, tavilyProvider, type SearchProvider } from '../src/web/search.ts'
import { download, isPublicAddress } from '../src/web/fetch.ts'
import { chunksFromMarkdown, decodeHtml, readPage } from '../src/web/page.ts'
import { LibraryWeb } from '../src/web/service.ts'

const rule = (host: string, authority: SiteRule['authority']): SiteRule => ({ host, authority, createdAt: '2026-10-07T00:00:00.000Z' })

describe('site rules', () => {
  it('rates by where a page lives: the most specific rule wins, unknown sites are clues', () => {
    expect(rate('https://hg.kmust.edu.cn/a.pdf')).toEqual({ authority: '2', rule: '国内高校' })
    expect(rate('http://openstd.samr.gov.cn/x')).toMatchObject({ authority: '2' })
    expect(rate('https://ocw.mit.edu/courses/x')).toMatchObject({ authority: '3', rule: '国外高校' })
    expect(rate('https://www.360doc.com/content/1.shtml')).toMatchObject({ authority: 'clue', rule: '文库和转载站' })
    expect(rate('https://download.cucdc.com/wenku/1.html')).toMatchObject({ authority: 'clue' })
    expect(rate('https://zh.wikipedia.org/wiki/x')).toMatchObject({ authority: 'clue', rule: '百科' })
    expect(rate('https://m.edu.iask.sina.com.cn/x')).toMatchObject({ authority: 'clue', rule: '问答和题库' })
    expect(rate('https://www.engineeringtoolbox.com/x')).toEqual({ authority: 'clue', rule: '不在可信网站清单里' })
    expect(rate('https://libgen.is/book/1')).toMatchObject({ authority: 'blocked' })
    expect(rate('https://dokumen.pub/x.html')).toMatchObject({ authority: 'blocked' })
  })

  it("lets the learner's rules override the built-in ones", () => {
    const rules = [rule('engineeringtoolbox.com', '3'), rule('hg.kmust.edu.cn', 'clue'), rule('my.school.example.com', '1')]
    expect(rate('https://www.engineeringtoolbox.com/x', rules)).toEqual({ authority: '3', rule: '你设定的网站' })
    expect(rate('https://hg.kmust.edu.cn/x', rules)).toMatchObject({ authority: 'clue' })
    expect(rate('https://chem.kmust.edu.cn/x', rules)).toMatchObject({ authority: '2' })
    expect(rate('https://my.school.example.com/a', rules)).toMatchObject({ authority: '1' })
    expect(trustedSites('zh', rules)).toEqual(expect.arrayContaining(['engineeringtoolbox.com', 'my.school.example.com', 'edu.cn']))
    expect(trustedSites('zh', rules)).not.toContain('hg.kmust.edu.cn')
    expect(trustedSites('en')).toEqual(expect.arrayContaining(['edu', 'nptel.ac.in']))
  })

  it('groups pages by organization and normalizes addresses', () => {
    expect(organization('hg.kmust.edu.cn')).toBe('kmust.edu.cn')
    expect(organization('www.engineeringtoolbox.com')).toBe('engineeringtoolbox.com')
    expect(organization('www.eng.cam.ac.uk')).toBe('cam.ac.uk')
    expect(normalizeUrl('https://Example.com/a?utm_source=x&id=1#top')).toBe('https://example.com/a?id=1')
    expect(formatOf('https://hg.kmust.edu.cn/__local/A/1.pdf?e=.pdf')).toBe('pdf')
    expect(formatOf('https://x.edu.cn/slides.pptx')).toBe('other')
  })
})

describe('web search', () => {
  const fake = (id: SearchProvider['id'], hits: { url: string; title?: string }[] | Error, calls: { sites?: readonly string[] }[] = [], suffixFilter = true): SearchProvider => ({
    id, suffixFilter,
    async search(_query, options) {
      calls.push({ sites: options.sites })
      if (hits instanceof Error) throw hits
      return hits.map(hit => ({ url: hit.url, title: hit.title ?? hit.url, snippet: '' }))
    },
  })

  it('merges the targeted and open search, rates, drops blocked sites, and caps each organization at two', async () => {
    const hits = [
      { url: 'https://www.360doc.com/1' },
      { url: 'https://hg.kmust.edu.cn/a.pdf' },
      { url: 'https://hg.kmust.edu.cn/a.pdf?utm_source=exa' },
      { url: 'https://chem.kmust.edu.cn/b' },
      { url: 'https://hg.kmust.edu.cn/c' },
      { url: 'https://ocw.mit.edu/d' },
      { url: 'https://libgen.is/e' },
      { url: 'https://course.buct.edu.cn/f' },
    ]
    const result = await searchWeb(['离心泵 汽蚀'], [fake('exa', hits)], [])
    expect(result.candidates.map(item => item.url)).toEqual(['https://hg.kmust.edu.cn/a.pdf', 'https://chem.kmust.edu.cn/b', 'https://course.buct.edu.cn/f', 'https://ocw.mit.edu/d'])
    expect(result.candidates[0]).toMatchObject({ authority: '2', organization: 'kmust.edu.cn', format: 'pdf', provider: 'Exa', question: '离心泵 汽蚀' })
    expect(result.clues.map(item => item.site)).toEqual(['360doc.com'])
    expect(result.notes).toEqual([])
  })

  it('hands a failing service over to the next one and says so', async () => {
    const result = await searchWeb(['Moody chart'], [fake('exa', new Error('Exa 返回 401：invalid key')), fake('tavily', [{ url: 'https://ocw.mit.edu/x' }])], [])
    expect(result.candidates.map(item => item.provider)).toEqual(['Tavily'])
    expect(result.notes).toEqual(['Exa搜索失败（Exa 返回 401：invalid key），改用Tavily'])
    const none = await searchWeb(['x'], [], [])
    expect(none.notes[0]).toMatch(/Exa、博查或 Tavily 的密钥/)
  })

  it('limits a targeted search to registrable domains when the service cannot take suffixes', async () => {
    const calls: { sites?: readonly string[] }[] = []
    await searchWeb(['化工原理'], [fake('bocha', [], calls, false)], [rule('my.school.example.com', '1')])
    const targeted = calls.find(call => call.sites)!
    expect(targeted.sites).toContain('my.school.example.com')
    expect(targeted.sites).toContain('icourse163.org')
    expect(targeted.sites).not.toContain('edu.cn')

    const suffixCalls: { sites?: readonly string[] }[] = []
    await searchWeb(['Moody chart'], [fake('exa', [], suffixCalls)], [])
    const english = suffixCalls.find(call => call.sites)!
    expect(english.sites).toEqual(expect.arrayContaining(['ac.uk', 'nptel.ac.in']))
    expect(english.sites).not.toContain('edu')
  })
})

/** A local stand-in for the web and the search services. */
let server: Server
let base: string
const requests: { path: string; body: unknown; auth?: string; key?: string }[] = []

const ARTICLE = `<!doctype html><html><head><meta charset="gbk"><title>实验五 传热综合实验-合成大学</title></head><body>
<table width="707"><tr><td><a href="/">首页</a> <a href="/a">学院概况</a> <a href="/b">师资队伍</a> <a href="/c">科学研究</a></td></tr></table>
<table><tr><td class="content"><div class="article">
<h2>一、实验目的</h2>
<p>测定套管换热器的总传热系数，比较并流与逆流传热的特点。合成实验讲义，仅用于测试网页正文提取。逆流时冷热流体的平均温差比并流时大，所以在相同的传热量下，逆流需要的传热面积更小。</p>
<p>对数平均温差按两端温差计算，当两端温差之比小于 2 时，可以用算术平均温差代替，误差不超过 4%。</p>
<h2>二、实验原理</h2>
<p>总传热系数 K 由传热速率方程求得：Q = K A Δt<sub>m</sub>。实验中测定冷流体的进出口温度和流量，求出传热速率，再除以传热面积和平均温差。</p>
<table><tr><th>流量</th><th>K</th></tr><tr><td>1.0</td><td>520</td></tr><tr><td>2.0</td><td>610</td></tr></table>
</div></td></tr></table>
<div class="footer">版权所有 合成大学 地址：某地 电话：0000</div>
</body></html>`

beforeAll(async () => {
  server = createServer(async (request: IncomingMessage, response) => {
    let raw = ''
    for await (const part of request) raw += part
    const path = request.url ?? '/'
    requests.push({ path, body: raw ? JSON.parse(raw) : undefined, auth: request.headers.authorization, key: request.headers['x-api-key'] as string | undefined })
    const json = (value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    if (path === '/page.html') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(gbk(ARTICLE)); return }
    if (path === '/moved') { response.writeHead(302, { location: '/page.html' }); response.end(); return }
    if (path === '/app.html') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<html><head><title>应用</title></head><body><div id="app"></div><script>render()</script></body></html>'); return }
    if (path === '/doc.pdf') { response.writeHead(200, { 'content-type': 'application/pdf' }); response.end(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 3 >>\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1')); return }
    if (path === '/slides.pptx') { response.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }); response.end('PK'); return }
    if (path === '/big') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('x'.repeat(5000)); return }
    if (path === '/exa/search') return json({ results: [{ url: 'https://hg.kmust.edu.cn/a.pdf', title: '离心泵', highlights: ['汽蚀余量是…'], publishedDate: '2020-01-01' }] })
    if (path === '/exa/contents') return json({ results: [{ title: 'Exa 副本', text: '## 汽蚀\n\n离心泵的汽蚀余量表示泵入口处液体的能量超过汽化压力的部分，必须大于泵所需的汽蚀余量，否则会发生汽蚀，损坏叶轮并使扬程下降。装置的有效汽蚀余量由吸入液面压力、安装高度、吸入管路阻力和液体饱和蒸气压决定，安装高度越高越容易汽蚀。合成副本用于测试。' }] })
    if (path === '/bocha/v1/web-search') return json({ code: 200, data: { webPages: { value: [{ url: 'https://max.book118.com/1', name: '课件', snippet: '短', summary: '博查摘要' }] } } })
    if (path === '/bocha-down/v1/web-search') return json({ code: 403, msg: '余额不足' })
    if (path === '/tavily/search') return json({ results: [{ url: 'https://ocw.mit.edu/x', title: 'Fluid', content: 'Tavily content' }] })
    response.writeHead(404); response.end('not found')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

/** GB18030 bytes for the synthetic page (TextEncoder only writes UTF-8). */
let gbkTable: Map<string, number[]> | undefined
function gbk(text: string): Buffer {
  const decoder = new TextDecoder('gb18030')
  const table = gbkTable ??= new Map<string, number[]>()
  // Build the character table by scanning the two-byte range once.
  if (table.size === 0) {
    for (let lead = 0x81; lead <= 0xfe; lead++) for (let trail = 0x40; trail <= 0xfe; trail++) {
      const char = decoder.decode(new Uint8Array([lead, trail]))
      if (char.length === 1 && !table.has(char)) table.set(char, [lead, trail])
    }
  }
  const bytes: number[] = []
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) bytes.push(char.charCodeAt(0))
    else bytes.push(...(table.get(char) ?? [0x3f]))
  }
  return Buffer.from(bytes)
}

describe('search services', () => {
  beforeEach(() => { requests.length = 0 })
  it('send the documented request to each service and read its answer', async () => {
    const exa = await exaProvider('exa-key', `${base}/exa`).search('离心泵', { sites: ['edu.cn'], limit: 5 })
    expect(exa[0]).toMatchObject({ url: 'https://hg.kmust.edu.cn/a.pdf', snippet: '汽蚀余量是…', publishedAt: '2020-01-01' })
    expect(requests[0]).toMatchObject({ path: '/exa/search', key: 'exa-key', body: { query: '离心泵', numResults: 5, includeDomains: ['edu.cn'] } })

    const bocha = await bochaProvider('bocha-key', `${base}/bocha`).search('离心泵', { sites: ['kmust.edu.cn', 'buct.edu.cn'], limit: 5 })
    expect(bocha[0]).toMatchObject({ title: '课件', snippet: '博查摘要' })
    expect(requests[1]).toMatchObject({ auth: 'Bearer bocha-key', body: { query: '离心泵', count: 5, summary: true, include: 'kmust.edu.cn|buct.edu.cn' } })
    await expect(bochaProvider('k', `${base}/bocha-down`).search('x', { limit: 1 })).rejects.toThrow('博查 返回错误 403：余额不足')

    const tavily = await tavilyProvider('tavily-key', `${base}/tavily`).search('pump', { limit: 3 })
    expect(tavily[0]).toMatchObject({ url: 'https://ocw.mit.edu/x', snippet: 'Tavily content' })
    expect(requests[3]).toMatchObject({ auth: 'Bearer tavily-key', body: { query: 'pump', max_results: 3 } })
  })
})

describe('downloads', () => {
  it('connect only to public addresses unless told otherwise', async () => {
    // 198.18.0.0/15 is what fake-IP proxies answer for every name; refusing it would refuse everything behind one.
    expect(['8.8.8.8', '2606:4700:4700::1111', '198.18.1.137'].map(isPublicAddress)).toEqual([true, true, true])
    expect(['10.1.2.3', '172.20.0.1', '192.168.1.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '::1', 'fe80::1', '::ffff:127.0.0.1', 'fc00::1'].some(isPublicAddress)).toBe(false)
    await expect(download(`${base}/page.html`, { maxBytes: 1e6 })).rejects.toThrow('不访问本机或局域网地址')
    await expect(download(`${base.replace('127.0.0.1', 'localhost')}/page.html`, { maxBytes: 1e6 })).rejects.toThrow('不访问本机或局域网地址')
    await expect(download('file:///etc/passwd', { maxBytes: 1e6 })).rejects.toThrow('只能打开 http 和 https 网址')
  })

  it('check every redirect and cap the size', async () => {
    const onlyHere = (address: string) => address === '127.0.0.1'
    const moved = await download(`${base}/moved`, { maxBytes: 1e6, allowAddress: onlyHere })
    expect(moved.url).toBe(`${base}/page.html`)
    expect(moved.status).toBe(200)
    await expect(download(`${base}/big`, { maxBytes: 1000, allowAddress: onlyHere })).rejects.toThrow('文件超过')
  })
})

describe('page text', () => {
  it('keeps the article, not the navigation, and decodes GBK pages', () => {
    const html = decodeHtml(gbk(ARTICLE), 'text/html')
    const page = readPage(html)
    expect(page.title).toContain('传热综合实验')
    expect(page.markdown).toContain('逆流需要的传热面积更小')
    expect(page.markdown).not.toContain('师资队伍')
    expect(page.markdown).not.toContain('版权所有')
  })

  it('splits Markdown into sections; short paragraphs merge, tables stay whole, long text splits at sentences', () => {
    const long = '长句子。'.repeat(500)
    const chunks = chunksFromMarkdown(`# 标题\n\n## 一\n\n短段一。\n\n短段二。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n## 二\n\n${long}`)
    expect(chunks.map(chunk => chunk.kind)).toEqual(['heading', 'heading', 'text', 'table', 'heading', 'text', 'text'])
    expect(chunks[2]).toMatchObject({ section: ['标题', '一'], text: '短段一。\n\n短段二。' })
    expect(chunks[5]!.section).toEqual(['标题', '二'])
    expect(chunks.slice(5).every(chunk => chunk.text.length <= 1200 && chunk.text.endsWith('。'))).toBe(true)
    expect(chunks.map(chunk => chunk.locator.block)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})

describe('adding material found online', () => {
  let root: string, db: Database, store: LibraryStore, ctx: Context, importer: LibraryImports, web: LibraryWeb
  let keys: Record<string, string>
  const course = 'course-web'
  const local = (path: string) => `${base}${path}`
  const host = (path: string) => `${base.replace('127.0.0.1', 'localhost')}${path}`

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'learning-web-'))
    db = new Database(join(root, 'learning.db')); db.migrate('library', libraryMigrations)
    store = new LibraryStore(db.sqlite, fn => db.transaction(fn), root)
    ctx = new Context()
    // The parser never answers: PDF imports stay queued, which is all these tests look at.
    importer = new LibraryImports(ctx, store, () => new Promise<MineruParser>(() => {}))
    keys = {}
    web = new LibraryWeb(ctx, store, importer, { provider: () => 'exa', key: async name => keys[name] }, { bases: { exa: `${base}/exa`, bocha: `${base}/bocha`, tavily: `${base}/tavily` }, allowAddress: () => true })
    // The test server stands for a domestic university (127.0.0.1) and a foreign one (localhost).
    store.setSiteRule('127.0.0.1', '2')
    store.setSiteRule('localhost', '3')
  })
  afterEach(() => { importer.dispose(); db.close(); rmSync(root, { recursive: true, force: true }) })

  it('makes a second-level page citable at once, under its title, without the navigation', async () => {
    const [added] = await web.add(course, [{ url: local('/page.html') }], 'teacher')
    expect(added).toMatchObject({ status: 'added' })
    const source = store.source(added!.sourceId!)!
    expect(source).toMatchObject({ kind: 'web', authority: '2', origin: { kind: 'web', url: local('/page.html'), format: 'html' }, parser: { name: 'readability' } })
    expect(store.courseSources(course).map(entry => entry.role)).toEqual(['reference'])
    const hit = store.search('逆流 传热面积', { courseId: course })[0]!
    expect(hit.chunk.citation).toBe(`《${source.title}》`)
    expect(store.chunks(source.id).some(chunk => chunk.text.includes('师资队伍'))).toBe(false)

    const again = await web.add('course-other', [{ url: local('/page.html') }], 'teacher')
    expect(again[0]).toMatchObject({ status: 'added', sourceId: source.id })
    expect(store.courseSources('course-other')).toHaveLength(1)
  })

  it('holds a third-level source the teacher found until the learner confirms it', async () => {
    const [proposed] = await web.add(course, [{ url: host('/page.html'), title: '国外讲义', reason: '补充逆流的推导' }], 'teacher')
    expect(proposed).toMatchObject({ status: 'pending' })
    expect(store.courseSources(course)).toHaveLength(0)
    const [pending] = web.pending(course)
    expect(pending).toMatchObject({ title: '国外讲义', reason: '补充逆流的推导', authority: '3' })
    const confirmed = await web.confirm(pending!.id)
    expect(confirmed.status).toBe('added')
    expect(web.pending(course)).toHaveLength(0)
    expect(store.source(confirmed.sourceId!)!.authority).toBe('3')

    const [own] = await web.add('course-two', [{ url: host('/moved') }], 'learner')
    expect(own!.status).toBe('added')
  })

  it('never adds clues or blocked sites, and lets the learner dismiss a proposal', async () => {
    const results = await web.add(course, [{ url: 'https://www.360doc.com/x' }, { url: 'https://libgen.is/x' }, { url: 'ftp://x.edu.cn/a' }], 'teacher')
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(results[0]!.message).toMatch(/只当线索/)
    await web.add(course, [{ url: host('/page.html') }], 'teacher')
    web.dismiss(web.pending(course)[0]!.id)
    expect(web.pending(course)).toHaveLength(0)
  })

  it("uses Exa's copy for a page this computer cannot read, and says when there is none", async () => {
    const [noKey] = await web.add(course, [{ url: local('/app.html') }], 'teacher')
    expect(noKey).toMatchObject({ status: 'failed' })
    expect(noKey!.message).toMatch(/没有 Exa 密钥/)
    keys.EXA_API_KEY = 'exa-key'
    const [copied] = await web.add(course, [{ url: local('/app.html') }], 'teacher')
    expect(copied).toMatchObject({ status: 'added' })
    expect(copied!.message).toMatch(/正文来自 Exa 的副本/)
    expect(store.source(copied!.sourceId!)!.parser).toMatchObject({ name: 'exa-contents' })
    const [missing] = await web.add(course, [{ url: local('/missing.pdf') }], 'teacher')
    expect(missing).toMatchObject({ status: 'failed' })
    expect(missing!.message).toMatch(/下载不了这个 PDF（网站返回 404）/)
    const [slides] = await web.add(course, [{ url: local('/slides.pptx') }], 'teacher')
    expect(slides!.message).toMatch(/暂时只能加入网页和 PDF/)
  })

  it('sends a PDF through the usual import and remembers its address', async () => {
    const [pdf] = await web.add(course, [{ url: local('/doc.pdf') }], 'teacher')
    expect(pdf).toMatchObject({ status: 'importing' })
    const task = store.imports()[0]!
    expect(task).toMatchObject({ url: local('/doc.pdf'), authority: '2', role: 'reference', courseId: course, fileName: 'doc.pdf' })
    const [again] = await web.add(course, [{ url: local('/doc.pdf') }], 'teacher')
    expect(again!.status).toBe('importing')
    expect(store.imports()).toHaveLength(1)
  })
})
