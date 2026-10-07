// Graph colours come from the shell's tokens, read at runtime: WebGL needs concrete colour strings,
// and the tokens change with the light or dark theme.
import type { MasteryState } from '@learning-agent/contracts'

export interface GraphColors {
  readonly text: string
  readonly muted: string
  readonly faint: string
  readonly surface: string
  readonly line: string
  readonly lineStrong: string
  readonly accent: string
  readonly accentLine: string
  readonly neutral: string
  readonly state: Readonly<Record<MasteryState, string>>
  /** Course colours for "colour by course", in course order. */
  readonly courses: readonly string[]
  readonly font: string
}

export function readColors(): GraphColors {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  const neutral = token('--la-text-4', '#b4b2ab')
  const ok = token('--la-ok', '#2a7a4a')
  return {
    text: token('--la-text', '#1c1b18'),
    muted: token('--la-text-3', '#8c8a83'),
    faint: token('--la-line-strong', '#d6d4cd'),
    surface: token('--la-bg-raised', '#ffffff'),
    line: token('--la-line', '#e8e7e2'),
    lineStrong: token('--la-line-strong', '#d6d4cd'),
    accent: token('--la-accent', '#3d5bd9'),
    accentLine: token('--la-accent-line', '#c6d0f5'),
    neutral,
    state: {
      untested: neutral,
      'not-yet': token('--la-warn', '#a35f0b'),
      assisted: token('--la-accent', '#3d5bd9'),
      independent: ok,
      retained: ok,
      conflict: token('--la-bad', '#c0392f'),
    },
    courses: [1, 2, 3, 4, 5, 6].map(i => token(`--la-cat-${i}`, '#8c8a83')),
    font: token('--la-font', 'sans-serif'),
  }
}

/** Call `listener` when the shell switches between light and dark. */
export function onThemeChange(listener: () => void): () => void {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-la-theme'] })
  return () => observer.disconnect()
}
