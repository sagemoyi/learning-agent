// Bundle the spike's browser half into DSH's client-module format:
// window.__ModuleLoader__.load({ id, factory: (require) => module.exports }).
// Modules DSH shares at runtime (react, cordis, ...) stay external and resolve through `require`.
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'

const pkgDir = new URL('./learning-spike/', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', pkgDir), 'utf8'))

const result = await build({
  entryPoints: [new URL('src/client.jsx', pkgDir).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
  logLevel: 'warning',
})

const body = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`
writeFileSync(new URL('lib/client.js', pkgDir), wrapped)
console.log(`wrote lib/client.js (${(wrapped.length / 1024).toFixed(1)} KiB)`)
