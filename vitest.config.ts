import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// DSH runtime packages resolve to the pinned install in .tools/dsh, as they do inside DSH.
const DSH = resolve(import.meta.dirname, '.tools/dsh/node_modules/@deepseek-ai')

export default defineConfig({
  resolve: {
    alias: [{ find: /^@deepseek-ai\/(cordis|dsh-llm|dsh-tools)$/, replacement: `${DSH}/$1/lib/index.js` }],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    // Tests never reach paid online services, even when the shell exports their keys.
    env: { LEARNING_PARSER: 'local', LEARNING_EMBEDDINGS: 'off' },
  },
})
