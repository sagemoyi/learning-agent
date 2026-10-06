// Project docs are split by unit (docs/<unit>/design.md) and cross-link heavily; a moved or renamed
// file must not leave links pointing nowhere.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => join(entry.parentPath, entry.name))
}

describe('project docs', () => {
  it('relative links point at existing files', () => {
    const files = [...markdownFiles(join(ROOT, 'docs')), ...['AGENTS.md', 'CLAUDE.md', 'README.md'].map(name => join(ROOT, name))]
    const broken: string[] = []
    for (const file of files) {
      // Code blocks and inline code show link syntax (citation formats, examples) without linking.
      const prose = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
      for (const [, target] of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^([a-z][a-z0-9+.-]*:|#)/i.test(target!)) continue
        const path = resolve(dirname(file), decodeURIComponent(target!.split('#')[0]!))
        if (!existsSync(path)) broken.push(`${relative(ROOT, file)} → ${target}`)
      }
    }
    expect(broken).toEqual([])
  })
})
