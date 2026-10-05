import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// DSH runtime packages resolve to the pinned install in .tools/dsh, as they do inside DSH.
const DSH = resolve(import.meta.dirname, '.tools/dsh/node_modules/@deepseek-ai')

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@deepseek-ai\/(cordis|dsh-llm|dsh-tools)$/, replacement: `${DSH}/$1/lib/index.js` },
      { find: /^@deepseek-ai\/schemastery$/, replacement: `${DSH}/schemastery/lib/index.mjs` },
    ],
  },
  test: {
    // Tests never reach paid online services: the harness gives the library local parsing and no
    // semantic search, and parser and embedding tests use fake endpoints.
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
  },
})
