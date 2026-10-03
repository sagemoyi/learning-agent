// Markdown files with YAML frontmatter: structured fields on top, prose below (contracts §4.1).
import { parse, stringify } from 'yaml'

export interface FrontmatterDocument {
  readonly data: Record<string, unknown>
  readonly body: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function parseFrontmatter(text: string): FrontmatterDocument {
  const match = FRONTMATTER.exec(text)
  if (!match) return { data: {}, body: text }
  const data = parse(match[1] ?? '') as unknown
  return {
    data: data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {},
    body: text.slice(match[0].length),
  }
}

export function withFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = stringify(data, { lineWidth: 0 }).trimEnd()
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`
}
