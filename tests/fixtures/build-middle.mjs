// Turn a synthetic fixture's source.md into a MinerU-style `docvortex.middle` JSON (the structured
// result library imports), so fixtures are edited as readable text.
//   node tests/fixtures/build-middle.mjs tests/fixtures/synthetic-long-section
// source.md: `# title` → heading block; a line `$$…$$` → display formula; any other paragraph → text.
// Blocks are put 12 to a page, so citations carry several page numbers.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('usage: node tests/fixtures/build-middle.mjs <fixture-dir>')
const paragraphs = readFileSync(join(dir, 'source.md'), 'utf8').replace(/\r\n/g, '\n').split(/\n{2,}/).map(text => text.trim()).filter(Boolean)
const blocks = paragraphs.map(text => {
  if (text.startsWith('# ')) return { type: 'paragraph_title', content: [{ type: 'text', content: text.slice(2).trim() }] }
  const formula = /^\$\$(.+)\$\$$/.exec(text)
  if (formula) return { type: 'equation', content: [{ type: 'equation', content: formula[1].trim() }] }
  return { type: 'text', content: [{ type: 'text', content: text }] }
})
const pages = []
blocks.forEach((block, index) => {
  const pageIndex = Math.floor(index / 12)
  pages[pageIndex] ??= { page_idx: pageIndex, blocks: [] }
  pages[pageIndex].blocks.push({ ...block, index: index % 12 })
})
const middle = { schema: 'docvortex.middle', metadata: { producer: { name: 'synthetic-fixture', version: '1' }, document: { page_count: pages.length } }, pages }
writeFileSync(join(dir, 'middle.json'), `${JSON.stringify(middle, null, 2)}\n`)
console.log(`${dir}: ${blocks.length} blocks on ${pages.length} pages`)
