// shell (docs/shell/design.md, 前端方案): text from model replies, parsed books and web pages is rendered by the shared
// Markdown, which must not run anything it holds or fetch anything the learner did not open, while formulas,
// citations, tables, folded quotes and figures still show. Checked with jsdom always, and in a real Chromium when one
// is installed (the system Chrome, or LEARNING_CHROME).
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { toHtml, toInlineHtml, useDocumentOf } from '../../packages/shell/src/client/html.ts'

useDocumentOf(new JSDOM('').window)

const RUN = 'window.__ran=1'
const OUTSIDE = 'https://example.invalid'
/** What a model reply, a parsed PDF, a plain-text web page or an Exa copy might carry. */
const ATTACKS = [
  `<img src=x onerror="${RUN}">`,
  `<svg onload="${RUN}"><circle r="1"/></svg>`,
  `[例子](javascript:${RUN})`,
  `[例子](JaVaScRiPt:${RUN})`,
  `[例子](&#106;avascript:${RUN})`,
  `[例子](java&#x09;script:${RUN})`,
  `<a href="java&#x0A;script:${RUN}">链接</a>`,
  `<a href=" javascript:${RUN}">链接</a>`,
  `<a href="&#x6A;&#x61;vascript:${RUN}">链接</a>`,
  '[数据](data:text/html;base64,PHNjcmlwdD53aW5kb3cuX19yYW49MTwvc2NyaXB0Pg==)',
  '<a href="vbscript:msgbox(1)">链接</a>',
  '[相对路径](/api/learning/core/courses) 和 <a href="../courses">上一级</a>',
  `<script>${RUN}</script>`,
  `<iframe src="${OUTSIDE}/frame"></iframe>`,
  `<object data="${OUTSIDE}/object"></object>`,
  `<form action="${OUTSIDE}/post"><button>提交</button></form>`,
  `<style>body{background:url(${OUTSIDE}/style.png)}</style>`,
  `<div style="background:url(${OUTSIDE}/inline.png)">背景</div>`,
  `![远程图](${OUTSIDE}/markdown.png)`,
  `<img src="${OUTSIDE}/raw.png">`,
  `<svg><image href="${OUTSIDE}/svg.png"/><a xlink:href="javascript:${RUN}"><text y="10">点</text></a></svg>`,
  `<details open ontoggle="${RUN}"><summary>折叠</summary>内容</details>`,
  `<math><mtext><table><mglyph><style><img src=x onerror="${RUN}">`,
  `> [!quote]- 引文 <img src=x onerror="${RUN}">\n> 正文 <b onmouseover="${RUN}">粗体</b>`,
  `| 列 | 值 |\n|---|---|\n| <img src=x onerror="${RUN}"> | [x](javascript:${RUN}) |`,
  `网页副本：<p onclick="${RUN}">点我</p>，原文在 <a href="${OUTSIDE}/page">这里</a>。`,
]

const SAFE_URL = /^(?:https?:|mailto:)/i
const GONE = 'script, iframe, frame, object, embed, form, input, button, style, link, meta, base, img, picture, video, audio, source, image, use'

function sanitizedProblems(html: string): string[] {
  const { document } = new JSDOM(`<body>${html}</body>`).window
  const problems: string[] = []
  for (const element of document.body.querySelectorAll('*')) {
    if (element.matches(GONE)) problems.push(`<${element.localName}>`)
    for (const { name, value } of element.attributes) {
      if (name.startsWith('on')) problems.push(`${name} on <${element.localName}>`)
      if (['href', 'xlink:href', 'src', 'action', 'data'].includes(name) && !SAFE_URL.test(value)) problems.push(`${name}=${value}`)
      if (name === 'style' && /url\s*\(/i.test(value)) problems.push(`style=${value}`)
    }
    if (element.localName === 'a' && element.hasAttribute('href') && element.getAttribute('rel') !== 'noreferrer noopener') problems.push('a link without rel')
  }
  return problems
}

/** Every kind of thing the renderer draws, from Markdown the units write. */
const SAMPLE = [
  '静水压强按 $p=\\rho g h$ 计算[《合成资料》p.3](cite:ck_01K6PQZRB8M3A4T5V6W7X8Y9Z0)，[这句没有出处](cite:unverified)。',
  '$$\\sqrt{x^2+y^2}=\\overrightarrow{AB}$$',
  '| 深度 | 压强 |\n|---|---|\n| 1 m | 10 kPa |',
  '> [!quote]- 原文\n> 静水压强与容器形状无关。',
  '![图1-3](cite:ck_01K6PQZRB8M3A4T5V6W7X8Y9Z1)',
  `另见 [网页](${OUTSIDE}/article) 和 [邮件](mailto:a@example.invalid)。`,
].join('\n\n')

function sampleKeeps(document: Document): Record<string, unknown> {
  return {
    tex: [...document.querySelectorAll('annotation[encoding="application/x-tex"]')].map(node => node.textContent),
    svg: document.querySelectorAll('.katex svg path').length > 0,
    cite: document.querySelector('a.la-cite[data-la-opens]')?.getAttribute('data-cite'),
    unverified: document.querySelector('.la-unverified')?.textContent,
    table: document.querySelectorAll('.la-table > table td').length,
    folded: document.querySelector('details.la-quote-box > summary')?.textContent,
    figure: document.querySelector('[data-figure]')?.getAttribute('data-figure'),
    links: [...document.querySelectorAll('a[href]')].map(link => `${link.getAttribute('href')} ${link.getAttribute('target')}`),
  }
}

const KEPT = {
  tex: ['p=\\rho g h', '\\sqrt{x^2+y^2}=\\overrightarrow{AB}'],
  svg: true,
  cite: 'ck_01K6PQZRB8M3A4T5V6W7X8Y9Z0',
  unverified: '这句没有出处',
  table: 2,
  folded: '原文',
  figure: 'ck_01K6PQZRB8M3A4T5V6W7X8Y9Z1',
  links: [`${OUTSIDE}/article _blank`, 'mailto:a@example.invalid _blank'],
}

it('drops what runs or fetches, in block and inline rendering, and keeps what the pages draw', () => {
  for (const attack of ATTACKS) {
    expect(sanitizedProblems(toHtml(attack)), attack).toEqual([])
    expect(sanitizedProblems(toInlineHtml(attack)), attack).toEqual([])
  }
  // A picture from elsewhere is a link to open, not an image.
  expect(toHtml(`![远程图](${OUTSIDE}/markdown.png)`)).toContain(`<a href="${OUTSIDE}/markdown.png" target="_blank" rel="noreferrer noopener">图：远程图</a>`)
  const { document } = new JSDOM(`<body>${toHtml(SAMPLE)}</body>`).window
  expect(sampleKeeps(document)).toEqual(KEPT)
})

it('runs nothing and requests nothing in a real browser', async ({ skip }) => {
  const executable = process.env.LEARNING_CHROME
  const browser = await chromium.launch(executable ? { executablePath: executable } : { channel: 'chrome' }).catch(() => undefined)
  if (!browser) return skip('no Chrome or LEARNING_CHROME here')
  try {
    const bundle = await build({ entryPoints: ['packages/shell/src/client/html.ts'], bundle: true, format: 'iife', globalName: 'rendering', write: false, platform: 'browser', logLevel: 'silent' })
    const page = await browser.newPage()
    const requests: string[] = []
    await page.route('**/*', route => { requests.push(route.request().url()); return route.abort() })
    const dialogs: string[] = []
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss() })
    await page.setContent('<!doctype html><meta charset="utf-8"><body></body>')
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const result = await page.evaluate(async ({ attacks, sample }) => {
      const { toHtml, toInlineHtml } = (window as unknown as { rendering: { toHtml(text: string): string; toInlineHtml(text: string): string } }).rendering
      for (const attack of attacks) {
        for (const html of [toHtml(attack), toInlineHtml(attack)]) {
          const box = document.createElement('div')
          box.innerHTML = html
          document.body.append(box)
        }
      }
      // Whatever is left gets hovered, clicked (but links, which would open a tab) and toggled.
      for (const element of document.body.querySelectorAll('*')) {
        element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
        if (!element.closest('a')) element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        if (element instanceof HTMLDetailsElement) element.open = !element.open
      }
      await new Promise(done => setTimeout(done, 300))
      const shown = document.createElement('div')
      shown.innerHTML = toHtml(sample)
      document.body.append(shown)
      return { ran: (window as unknown as { __ran?: number }).__ran ?? 0, html: shown.innerHTML }
    }, { attacks: ATTACKS, sample: SAMPLE })
    await page.waitForTimeout(200)
    expect({ ran: result.ran, dialogs, requests }).toEqual({ ran: 0, dialogs: [], requests: [] })
    expect(sampleKeeps(new JSDOM(`<body>${result.html}</body>`).window.document)).toEqual(KEPT)
  } finally {
    await browser.close()
  }
}, 60_000)
