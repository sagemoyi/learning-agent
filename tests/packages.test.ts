// What DSH needs to load a unit that tests mounting from source cannot show (docs/stage0/compatibility.md, handoff review):
// every `@deepseek-ai/*` package a unit's host bundle leaves for DSH to supply must be declared in its package.json,
// or DSH reports "failed to import" for that unit. (annotation once shipped without `dsh-llm` and `dsh-tools`.)
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { build, type Metafile } from 'esbuild'
import { beforeAll, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
// contracts and kit are bundled into each unit and never installed on their own.
const BUNDLED = new Set(['contracts', 'kit'])

interface Unit {
  readonly name: string
  readonly entry: string
  readonly declared: ReadonlySet<string>
}

const units: Unit[] = readdirSync(join(root, 'packages'), { withFileTypes: true }).flatMap(entry => {
  const dir = join(root, 'packages', entry.name)
  if (!entry.isDirectory() || BUNDLED.has(entry.name) || !existsSync(join(dir, 'package.json'))) return []
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { exports?: Record<string, string>; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
  const file = ['index.ts', 'index.tsx'].map(name => join(dir, 'src', name)).find(path => existsSync(path))
  if (!manifest.exports?.['.'] || !file) return []
  return [{ name: entry.name, entry: file, declared: new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]) }]
})

// One build for every unit: separate builds per unit took over the test timeout while the rest of the suite ran.
let outputs: Metafile['outputs'] = {}
beforeAll(async () => {
  const result = await build({
    entryPoints: Object.fromEntries(units.map(unit => [unit.name, unit.entry])),
    bundle: true, write: false, metafile: true, outdir: join(root, '.scratch', 'packages-test'), splitting: false,
    format: 'esm', platform: 'node', target: 'node22', external: ['@deepseek-ai/*'], logLevel: 'silent',
  })
  outputs = result.metafile.outputs
}, 60_000)

it.each(units.map(unit => [unit.name, unit] as const))('%s declares every DSH package its host bundle imports', (name, unit) => {
  const output = Object.values(outputs).find(item => item.entryPoint && resolve(root, item.entryPoint) === unit.entry)
  expect(output, `${name}: no bundle for ${relative(root, unit.entry)}`).toBeDefined()
  const used = new Set<string>()
  for (const item of output!.imports) {
    if (!item.external || !item.path.startsWith('@deepseek-ai/')) continue
    const [scope, pkg] = item.path.split('/')
    used.add(`${scope}/${pkg}`)
  }
  expect([...used].filter(pkg => !unit.declared.has(pkg)).sort(), `${name}: imported but not declared`).toEqual([])
})
