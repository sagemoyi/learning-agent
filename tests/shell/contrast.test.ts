// shell (docs/shell/design.md, 视觉规范): the design tokens keep informative text readable in both themes. Reads the two
// colour blocks of shell.css and works out WCAG contrast on the surfaces text sits on.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(import.meta.dirname, '../../packages/shell/src/shell.css'), 'utf8')
function block(pattern: RegExp): Record<string, string> {
  const found = pattern.exec(css)
  if (!found) throw new Error(`no colour block ${pattern}`)
  return Object.fromEntries([...found[1]!.matchAll(/--(la-[\w-]+):\s*([^;]+);/g)].map(match => [match[1]!, match[2]!.trim()]))
}
const light = block(/:root \{([\s\S]*?)\n\}/)
const themes = { light, dark: { ...light, ...block(/:root\[data-la-theme='dark'\] \{([\s\S]*?)\n\}/) } }

type Rgba = readonly [number, number, number, number]
function parse(color: string): Rgba {
  if (color.startsWith('#')) {
    const value = parseInt(color.slice(1), 16)
    return [value >> 16 & 255, value >> 8 & 255, value & 255, 1]
  }
  const parts = /rgba\(([^)]+)\)/.exec(color)
  if (!parts) throw new Error(`not a colour: ${color}`)
  return parts[1]!.split(',').map(Number) as unknown as Rgba
}
const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map(i => top[i]! * top[3] + under[i]! * (1 - top[3])).concat(1) as unknown as Rgba
function luminance([r, g, b]: Rgba): number {
  const channel = (value: number) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
function contrast(a: Rgba, b: Rgba): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

const NORMAL_TEXT = 4.5
const PAGES = ['la-bg', 'la-bg-chrome', 'la-bg-sunken', 'la-bg-raised']

describe.each(Object.entries(themes))('%s theme', (_name, tokens: Record<string, string>) => {
  const color = (name: string) => parse(tokens[name]!)
  const surfaces = PAGES.flatMap(name => [[name, color(name)], [`${name} under a hover`, over(color('la-hover'), color(name))]] as [string, Rgba][])

  it.each(['la-text', 'la-text-2', 'la-text-3'])('%s reads on every surface text sits on', text => {
    const short = surfaces.filter(([, surface]) => contrast(color(text), surface) < NORMAL_TEXT).map(([name, surface]) => `${name} ${contrast(color(text), surface).toFixed(2)}`)
    expect(short).toEqual([])
  })

  it('keeps three steps of text, each lighter than the last', () => {
    const page = color('la-bg')
    const [one, two, three] = ['la-text', 'la-text-2', 'la-text-3'].map(name => contrast(color(name), page)) as [number, number, number]
    expect(one).toBeGreaterThan(two + 1)
    expect(two).toBeGreaterThan(three + 1)
  })

  it.each(['la-accent-text', 'la-ok', 'la-warn', 'la-bad'])('%s reads on the page, the shell and its soft background', text => {
    const soft = { 'la-accent-text': 'la-accent-soft', 'la-ok': 'la-ok-soft', 'la-warn': 'la-warn-soft', 'la-bad': 'la-bad-soft' }[text]!
    const on = [color('la-bg'), color('la-bg-chrome'), color('la-bg-raised'), over(color(soft), color('la-bg'))]
    expect(Math.min(...on.map(surface => contrast(color(text), surface)))).toBeGreaterThanOrEqual(NORMAL_TEXT)
  })

  it('white on the accent button reads', () => {
    expect(contrast(color('la-on-accent'), color('la-accent'))).toBeGreaterThanOrEqual(NORMAL_TEXT)
  })
})
