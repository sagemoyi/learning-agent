// Build every workspace package into the files its package.json `exports` point at.
//
// Convention: an export target `./lib/<name>.js` is built from `src/<name>.ts` or `src/<name>.tsx`.
// - The `./client` export is a browser bundle wrapped in DSH's client-module format:
//   window.__ModuleLoader__.load({ id, factory: (require) => module.exports }).
// - Every other export is a Node ESM bundle loaded by DSH's host.
// DSH packages (`@deepseek-ai/*`) and React stay external: DSH's runtime supplies the single live copy.
// Everything else (zod, dockview, our contracts package) is bundled in.
//
// Usage: node scripts/build.mjs [package-dir ...]   (default: all workspace packages)
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function workspaceDirs() {
  const dirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(root, 'packages', entry.name))
  dirs.push(join(root, 'spikes', 'probe'))
  return dirs.filter(dir => existsSync(join(dir, 'package.json')))
}

function sourceFor(dir, target) {
  const name = target.replace(/^\.\/lib\//, '').replace(/\.js$/, '')
  for (const ext of ['.ts', '.tsx']) {
    const file = join(dir, 'src', name + ext)
    if (existsSync(file)) return file
  }
  throw new Error(`${relative(root, dir)}: no source for export ${target} (expected src/${name}.ts or .tsx)`)
}

async function buildHost(entry, outfile) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['@deepseek-ai/*'],
    // Bundled CommonJS dependencies may call require(); give them one in ESM output.
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    sourcemap: 'linked',
    logLevel: 'warning',
  })
}

// Client CSS is imported as text and injected by the plugin as a <style>. Each stylesheet is bundled
// first, so its own @imports resolve and fonts (KaTeX) are inlined as data URLs; only woff2 is
// inlined, the woff/ttf fallbacks stay as dead relative URLs that browsers never reach.
const cssAsText = {
  name: 'css-as-text',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.css$/ }, async args => {
      const result = await build({
        entryPoints: [args.path],
        bundle: true,
        minify: true,
        write: false,
        loader: { '.woff2': 'dataurl' },
        external: ['*.woff', '*.ttf'],
        logLevel: 'warning',
      })
      return { contents: result.outputFiles[0].text, loader: 'text' }
    })
  },
}

async function buildClient(entry, outfile, id) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    plugins: [cssAsText],
    external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
    define: { 'process.env.NODE_ENV': '"production"' },
    write: false,
    logLevel: 'warning',
  })
  const body = result.outputFiles[0].text
  const wrapped = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(id)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${body}\n\t\treturn module.exports;\n\t}\n});\n`
  mkdirSync(dirname(outfile), { recursive: true })
  writeFileSync(outfile, wrapped)
}

const requested = process.argv.slice(2).map(arg => resolve(arg))
const dirs = requested.length > 0 ? requested : workspaceDirs()
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (pkg.name === '@learning-agent/library') {
    const pdfRoot = dirname(createRequire(join(dir, 'package.json')).resolve('pdfjs-dist/package.json'))
    const assets = join(dir, 'lib', 'pdf-assets')
    mkdirSync(assets, { recursive: true })
    cpSync(join(pdfRoot, 'legacy', 'build', 'pdf.worker.min.mjs'), join(assets, 'pdf.worker.min.mjs'))
    for (const folder of ['cmaps', 'standard_fonts', 'wasm']) cpSync(join(pdfRoot, folder), join(assets, folder), { recursive: true })
  }
  const targets = Object.entries(pkg.exports ?? {})
    .filter(([, target]) => typeof target === 'string' && target.startsWith('./lib/'))
  for (const [key, target] of targets) {
    const entry = sourceFor(dir, target)
    const outfile = join(dir, target)
    if (key === './client') await buildClient(entry, outfile, pkg.name)
    else await buildHost(entry, outfile)
    console.log(`built ${pkg.name} ${key} -> ${relative(root, outfile)}`)
  }
}
