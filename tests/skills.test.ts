// Development skills: full text in .agents/skills (Codex reads it), a same-named entry in
// .claude/skills (Claude Code reads it). This machine cannot create symlinks without admin rights,
// so the two trees are kept in step by these checks instead.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE = join(ROOT, '.agents', 'skills')
const ENTRY = join(ROOT, '.claude', 'skills')

function skillNames(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

/** `name` and `description` from the frontmatter; both are single-line values in these files. */
function frontmatter(file: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(readFileSync(file, 'utf8'))
  if (!match) throw new Error(`${relative(ROOT, file)} has no frontmatter`)
  return Object.fromEntries(match[1]!.split(/\r?\n/).map(line => /^([a-z-]+):\s*(.*)$/.exec(line)).filter(Boolean).map(found => [found![1]!, found![2]!]))
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => join(entry.parentPath, entry.name))
}

describe('development skills', () => {
  const names = skillNames(SOURCE)

  it('every skill has a valid name and description', () => {
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const meta = frontmatter(join(SOURCE, name, 'SKILL.md'))
      expect(meta.name, name).toBe(name)
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(name.length).toBeLessThanOrEqual(64)
      expect(meta.description?.length ?? 0, `${name} description`).toBeGreaterThan(20)
      expect(meta.description!.length, `${name} description`).toBeLessThanOrEqual(1024)
    }
  })

  it('each skill has a Claude Code entry with the same name and description', () => {
    expect(skillNames(ENTRY)).toEqual(names)
    for (const name of names) {
      const entry = join(ENTRY, name, 'SKILL.md')
      expect(frontmatter(entry), name).toEqual(frontmatter(join(SOURCE, name, 'SKILL.md')))
      expect(readFileSync(entry, 'utf8')).toContain(`](../../../.agents/skills/${name}/SKILL.md)`)
    }
  })

  it('relative links in skills point at existing files', () => {
    const broken: string[] = []
    for (const file of [...markdownFiles(SOURCE), ...markdownFiles(ENTRY)]) {
      // Code blocks and inline code show link syntax (citation formats, examples) without linking.
      const prose = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
      for (const [, target] of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^([a-z][a-z0-9+.-]*:|#)/i.test(target!)) continue
        const path = resolve(dirname(file), target!.split('#')[0]!)
        if (!existsSync(path)) broken.push(`${relative(ROOT, file)} → ${target}`)
      }
    }
    expect(broken).toEqual([])
  })
})
