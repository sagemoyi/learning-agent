// What DSH needs to load a unit that tests mounting from source cannot show (docs/stage0/compatibility.md, handoff review):
// every `@deepseek-ai/*` package a unit's host bundle leaves for DSH to supply must be declared in its package.json,
// or DSH reports "failed to import" for that unit. (annotation once shipped without `dsh-llm` and `dsh-tools`.)
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
// contracts and kit are bundled into each unit and never installed on their own.
const BUNDLED = new Set(['contracts', 'kit'])
const packages = readdirSync(join(root, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory() && !BUNDLED.has(entry.name) && existsSync(join(root, 'packages', entry.name, 'package.json')))

it.each(packages.map(entry => entry.name))('%s declares every DSH package its host bundle imports', async name => {
  const dir = join(root, 'packages', name)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { exports?: Record<string, string>; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
  const entry = ['index.ts', 'index.tsx'].map(file => join(dir, 'src', file)).find(file => existsSync(file))
  if (!manifest.exports?.['.'] || !entry) return
  const result = await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, format: 'esm', platform: 'node', target: 'node22', external: ['@deepseek-ai/*'], logLevel: 'silent' })
  const used = new Set<string>()
  for (const output of Object.values(result.metafile.outputs)) {
    for (const item of output.imports) {
      if (!item.external || !item.path.startsWith('@deepseek-ai/')) continue
      const [scope, pkg] = item.path.split('/')
      used.add(`${scope}/${pkg}`)
    }
  }
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])
  expect([...used].filter(pkg => !declared.has(pkg)).sort(), `${name}: imported but not declared`).toEqual([])
})
