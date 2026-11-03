// Documentation rules that a script can check (AGENTS.md "文档：一件事一个家", the learning-docs skill):
// word budgets for the documents every session reads, current-state design documents, proposal headings,
// relative links and their headings, documentation cited from code comments, research records, and copied
// sentences. docs/history/ is frozen and skipped as a source.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const SKIP = new Set(['node_modules', '.git', '.scratch', '.tools', '.data', '.dsh-home', 'dist', 'lib', 'materials', 'history'])

/**
 * Character ceilings (Chinese text, so characters rather than words). Raise one only when the content needs it.
 * now.md says what is in progress, what waits for the learner and what comes next, nothing about what is done.
 */
const BUDGETS: Record<string, number> = {
  'AGENTS.md': 3800,
  'packages/AGENTS.md': 3600,
  'docs/development.md': 3300,
  'docs/now.md': 1800,
  'docs/contracts.md': 11800,
}

/** A design document says how the unit works now: these sections, in this order, and no batches, acceptance criteria or progress labels. */
const DESIGN_SECTIONS = ['## 概要', '## 数据与接口', '## 关键决定', '## 已知限制与以后再做']
const DESIGN_BUDGET = 10_000
const STALE_HEADING = /^#{2,4} .*(?:[A-D] ?批|验收标准|改版)/m
const PROGRESS = /已技术验收|技术验收|待你试用|待用户试用|待试用|已验收/
const PROPOSAL_SECTIONS = ['## 问题', '## 方案', '## 放弃的方案', '## 验收标准', '## 风险']

function units(): string[] {
  return readdirSync(join(ROOT, 'docs'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(ROOT, 'docs', entry.name, 'design.md')))
    .map(entry => entry.name)
}

/** The positions of `headings` in `text`, -1 for a missing one. */
function positions(text: string, headings: readonly string[]): number[] {
  return headings.map(heading => text.search(new RegExp(`^${heading}\\s*$`, 'm')))
}

/** The text with LF line ends, as committed: Git on Windows may check it out with CRLF. */
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n')
}

function markdownFiles(dir = ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (SKIP.has(entry.name)) return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.name.endsWith('.md') ? [path] : []
  })
}

/** Text outside fenced and inline code, which show link syntax without linking. */
function prose(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
}

/** A research record is dated and leaves status, plans, acceptance drafts and handoff notes to proposals, commits and design docs. */
const RESEARCH_HEADER = /^> \d{4}-\d{2}-\d{2} 的调研记录/
const RESEARCH_STALE_HEADING = /分批|验收草案|验收矩阵|验收标准|实施顺序|接续|当前代码|骨架核对|当前起点|当前实现|现有代码|你的决定|需要讨论|需要你决定|契约补充|契约与数据|数据建议|数据归属|精简候选/
const RESEARCH_PROGRESS = /^> .*状态：|尚未实现|待你试用|待用户试用|已技术验收/m

/** Sentences this long that appear word for word in two current documents are copies; one of them should link instead. */
const COPY_MIN_LENGTH = 24

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (SKIP.has(entry.name)) return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|mjs|sh)$/.test(entry.name) ? [path] : []
  })
}

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces as hyphens, repeats numbered. */
function anchorsOf(text: string): Set<string> {
  const found = new Set<string>()
  const seen = new Map<string, number>()
  for (const [, heading] of text.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const slug = heading!.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
    const count = seen.get(slug) ?? 0
    seen.set(slug, count + 1)
    found.add(count ? `${slug}-${count}` : slug)
  }
  return found
}

function headingsOf(text: string): string[] {
  return [...text.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, heading]) => heading!.trim())
}

describe('documentation', () => {
  it('keeps the always-read documents within their budgets', () => {
    for (const [path, ceiling] of Object.entries(BUDGETS)) expect([...read(path)].length, path).toBeLessThanOrEqual(ceiling)
  })

  it('design documents describe the unit as it is now', () => {
    for (const unit of units()) {
      const path = `docs/${unit}/design.md`
      const text = read(path)
      const found = positions(text, DESIGN_SECTIONS)
      expect(found.every(at => at >= 0), `${path} has ${DESIGN_SECTIONS.join(', ')}`).toBe(true)
      expect([...found].sort((a, b) => a - b), `${path} keeps the section order`).toEqual(found)
      expect(text, path).not.toMatch(STALE_HEADING)
      expect(text, path).not.toMatch(PROGRESS)
      expect([...text].length, path).toBeLessThanOrEqual(DESIGN_BUDGET)
    }
  })

  it('proposals carry the proposal sections', () => {
    for (const unit of units()) {
      const dir = join(ROOT, 'docs', unit, 'proposals')
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir).filter(file => file.endsWith('.md'))) {
        const found = positions(readFileSync(join(dir, name), 'utf8'), PROPOSAL_SECTIONS)
        expect(found.every(at => at >= 0) && found.every((at, i) => i === 0 || at > found[i - 1]!), `docs/${unit}/proposals/${name}`).toBe(true)
      }
    }
  })

  it('relative links in active documents point at existing files and headings', () => {
    const broken: string[] = []
    for (const file of markdownFiles()) {
      for (const [, target] of prose(readFileSync(file, 'utf8')).matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target!)) continue
        const [pathPart, anchor] = target!.split('#')
        const path = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart)) : file
        if (!existsSync(path)) broken.push(`${relative(ROOT, file)} → ${target}`)
        else if (anchor && path.endsWith('.md') && !anchorsOf(readFileSync(path, 'utf8')).has(decodeURIComponent(anchor).toLowerCase())) {
          broken.push(`${relative(ROOT, file)} → ${target} (no such heading)`)
        }
      }
    }
    expect(broken).toEqual([])
  })

  it('code comments cite documentation sections that exist', () => {
    const broken: string[] = []
    const files = ['packages', 'tests', 'scripts'].flatMap(dir => sourceFiles(join(ROOT, dir)))
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const [, doc, listed, quoted] of text.matchAll(/(docs\/[\w/.-]+\.md|packages\/AGENTS\.md)(?:(?:, |: )([^)\n]+)\)| "([^"\n]+)")/g)) {
        if (doc!.startsWith('docs/history/')) continue
        const path = join(ROOT, doc!)
        if (!existsSync(path)) { broken.push(`${relative(ROOT, file)} → ${doc} (no such file)`); continue }
        const headings = headingsOf(readFileSync(path, 'utf8'))
        for (const section of quoted ? [quoted] : listed!.split(', ')) {
          if (!headings.some(heading => heading.includes(section.trim()))) broken.push(`${relative(ROOT, file)} → ${doc}, ${section}`)
        }
      }
    }
    expect(broken).toEqual([])
  })

  it('research records hold findings, not status, plans or handoff notes', () => {
    for (const unit of units()) {
      const path = `docs/${unit}/research.md`
      if (!existsSync(join(ROOT, path))) continue
      const text = read(path)
      expect(text.split('\n')[2], `${path} opens with its date`).toMatch(RESEARCH_HEADER)
      for (const heading of headingsOf(text)) expect(heading, path).not.toMatch(RESEARCH_STALE_HEADING)
      expect(text, path).not.toMatch(RESEARCH_PROGRESS)
    }
  })

  it('no sentence is copied word for word into a second current document', () => {
    const copies = new Map<string, Set<string>>()
    const current = markdownFiles().map(file => relative(ROOT, file).replaceAll('\\', '/'))
      .filter(file => !/(^|\/)(research|throughts)\.md$|\/proposals\/|^tests\/fixtures\/|^\.claude\//.test(file))
    for (const file of current) {
      for (const raw of read(file).replace(/```[\s\S]*?```/g, '').split(/[。；\n]/)) {
        const sentence = raw.replace(/^[\s>*|#\d.-]+/, '').replace(/\*\*/g, '').trim()
        if ([...sentence].length < COPY_MIN_LENGTH) continue
        copies.set(sentence, (copies.get(sentence) ?? new Set()).add(file))
      }
    }
    const repeated = [...copies].filter(([, files]) => files.size > 1).map(([sentence, files]) => `${[...files].join(' & ')}: ${sentence}`)
    expect(repeated).toEqual([])
  })
})
