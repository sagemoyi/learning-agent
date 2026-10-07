// Material found online, across units: the teacher's brief counts it, and endpoint input errors read as
// sentences. No search service is called (the add flow itself is in packages/library/test/web.test.ts).
import { afterEach, expect, it } from 'vitest'
import { createHarness, type Harness } from './harness.ts'
import { chunksFromMarkdown } from '../packages/library/src/web/page.ts'
import type { LibraryStore } from '../packages/library/src/store.ts'

let h: Harness | undefined
afterEach(() => h?.dispose())

it('counts web material in the brief instead of listing every page', async () => {
  h = createHarness(() => '好')
  const { id: courseId } = await h.endpoint<{ id: string }>('core', 'createCourse', { title: '联网资料（合成资料）' })
  await h.settle()
  const store = (h.ctx.learnLibrary as unknown as { store: LibraryStore }).store
  const markdown = '## 合成网页\n\n合成的网页正文，讲逆流和并流的平均温差，用来检查简报里怎样提到网上找到的资料。正文要足够长，才能算作有正文的网页。'
  store.importWebPage({ title: '合成网页', url: 'https://hg.example.edu.cn/a.htm', authority: '2', markdown, chunks: chunksFromMarkdown(markdown), via: 'local', courseId })
  const { text } = await h.endpoint<{ text: string }>('tutor', 'brief', { courseId })
  expect(text).toContain('另有 1 份网上找到的参考资料')
  expect(text).not.toContain('合成网页')
})

it('reports invalid endpoint input with its messages, not the raw issue list', async () => {
  h = createHarness(() => '好')
  const result = await h.call('library', 'setSiteRule', { host: 'not a host', authority: '2' })
  expect(result.ok).toBe(false)
  expect(result.error?.message).toBe('网站写成域名，例如 hg.kmust.edu.cn')
})
