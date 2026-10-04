// library unit, agent tools (mounted per preset; contracts §7.2).
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type { CitedChunk } from '@learning-agent/contracts'
import { linkOf, textTool } from '@learning-agent/kit'

export const name = 'learning-library-tools'
export const inject = ['tools', 'learnLibrary', 'learnCore']

const KINDS = ['heading', 'text', 'formula', 'table', 'figure', 'example', 'exercise', 'answer'] as const

function line(chunk: CitedChunk, max = 400, relevance?: number): string {
  const text = chunk.text.length > max ? `${chunk.text.slice(0, max)}…` : chunk.text
  const score = relevance === undefined ? '' : ` · 相关度 ${relevance.toFixed(2)}`
  return `[${chunk.id}] ${chunk.citation} · ${chunk.section.at(-1) ?? ''} · ${chunk.kind}${score}\n${text}`
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(textTool({
    name: 'search_library',
    title: '查资料库',
    description: '在本课关联的资料里检索（关键词加语义，换一种说法的问题也能找到）。返回片段 ID、出处（书名和页码）、所在小节、相关度和原文。写教材、出题、回答问题时必须以这些片段为依据，引用时用片段 ID。结果提示资料里没有时，不要拿模型知识充当出处。找习题用 kinds=["exercise","answer"]。',
    parameters: {
      query: { type: 'string', required: true, description: '要查的问题或关键词，例如 "怎样判断层流还是湍流"、"流体静力学 基本方程"' },
      kinds: { type: 'array', items: { type: 'string', enum: KINDS }, description: '只要这些类型的片段' },
      limit: { type: 'integer', description: '最多返回几条，默认 8' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const result = await ctx.learnLibrary.retrieve(args.query, { courseId, ...(args.kinds ? { kinds: args.kinds } : {}), limit: args.limit ?? 8 })
      const notes = [
        result.note,
        result.gap && result.hits.length ? '资料里没有找到能直接回答这个问题的内容，下面只是最接近的片段。不要用模型知识充当出处；讲解时说明资料没有覆盖这部分。' : undefined,
      ].filter(Boolean).map(note => `【${note}】`)
      if (result.hits.length === 0) return [...notes, '没有找到。换个说法再试，或者用 read_section 按小节读原文。'].join('\n')
      return [...notes, result.hits.map(hit => line(hit.chunk, 400, hit.relevance)).join('\n\n')].join('\n\n')
    },
  })), 'library tools: search_library')

  ctx.effect(() => ctx.tools.register(textTool({
    name: 'read_section',
    title: '读资料原文',
    description: '按小节号读取本课骨架教材的原文（例如 "1.2" 会包含 1.2.1、1.2.2…），每段都带片段 ID 和页码。也可以读 "习题"。不给 section 时返回目录。',
    parameters: {
      section: { type: 'string', description: '小节号或标题开头，例如 "1.2"、"习题"；省略则返回目录' },
      sourceId: { type: 'string', description: '资料 ID；省略时用本课的骨架教材' },
    },
    async execute(args, exec) {
      const { courseId } = linkOf(ctx, exec)
      const sources = ctx.learnLibrary.courseSources(courseId)
      const source = args.sourceId
        ? sources.find(entry => entry.sourceId === args.sourceId)
        : sources.find(entry => entry.role === 'skeleton') ?? sources[0]
      if (!source) return '本课还没有关联资料。请让学习者先在资料库页面把教材加入本课。'
      if (!args.section) {
        return `《${source.source.title}》目录：\n${ctx.learnLibrary.outline(source.sourceId).map(entry => `${'  '.repeat(Math.max(0, entry.section.length - 1))}${entry.section.at(-1)}`).join('\n')}`
      }
      const chunks = ctx.learnLibrary.section(source.sourceId, args.section)
      if (chunks.length === 0) return `《${source.source.title}》里没有小节 ${args.section}。先不带 section 调用一次看目录。`
      const body = chunks.map(chunk => line(chunk, 1200)).join('\n\n')
      return body.length > 60_000 ? `${body.slice(0, 60_000)}\n…（内容过长已截断，请读更小的小节）` : body
    },
  })), 'library tools: read_section')
}
