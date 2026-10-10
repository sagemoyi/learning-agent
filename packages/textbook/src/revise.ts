// Local revision of a lesson (docs/textbook/design.md, 局部修订): the model rewrites only the paragraphs
// named, the program puts them back in place. A rewritten paragraph keeps its id, extra paragraphs get
// new ones, a removed paragraph is recorded with where it went. Pure helpers; the call is in index.ts.
import { finalize, indexBlocks, splitPieces } from './format.ts'

export const REVISER_SYSTEM = `你修改一节教材里指定的几段。规则：
1. 只依据给出的资料片段改写，不使用你自己的知识；资料里没有的内容不写。
2. 每段末尾用链接注明出处，格式 [《书名》p.页码](cite:片段ID)，片段 ID 只能是"资料片段"里列出的 ID。
3. 公式用 LaTeX：行内用 $…$；独立公式单独成段，写成 $$…$$，紧接着的下一段说明公式含义并带出处。
4. 只改"要改的段落"，按"修改要求"改；"前后文"只用来衔接，不要输出。例题只能照资料原样写。不写习题、小测题或测试安排，正文里不要出现内部编号（kn_、ck_ 等）。
5. 输出格式：每个要改的段落先单独写一行 [[段落 编号]]，下面写改好的内容，可以拆成几段；要删掉的段落在这一行下面只写"（删除）"；不需要改的段落不要输出。不要前言后语，不要代码块包裹。`

export interface RevisionInput {
  readonly heading: string
  readonly instruction: string
  /** The paragraphs to rewrite, by block id. */
  readonly targets: readonly { readonly id: string; readonly text: string }[]
  /** One paragraph before and after each target, for continuity. */
  readonly around: readonly { readonly text: string; readonly after: string }[]
  readonly material: readonly { readonly id: string; readonly citation: string; readonly text: string }[]
}

export function revisionPrompt(input: RevisionInput): string {
  return [
    `# 小节\n${input.heading}`,
    `# 修改要求\n${input.instruction}`,
    `# 要改的段落\n${input.targets.map(target => `[[段落 ${target.id}]]\n${target.text}`).join('\n\n')}`,
    input.around.length ? `# 前后文（不要输出）\n${input.around.map(item => `（${item.after}）\n${item.text}`).join('\n\n')}` : '',
    `# 资料片段（只能引用这些 ID）\n${input.material.map(chunk => `[${chunk.id}] ${chunk.citation}\n${chunk.text}`).join('\n\n')}`,
  ].filter(Boolean).join('\n\n')
}

/** The new text of each target the reply rewrote; `null` for a target it removed. Others are left alone. */
export function parseRevision(reply: string, targets: readonly string[]): Map<string, string | null> {
  const text = reply.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/, '$1')
  const marks = [...text.matchAll(/^\[\[段落\s*([0-9a-z]{6})\]\]\s*$/gm)]
  const result = new Map<string, string | null>()
  marks.forEach((mark, index) => {
    const id = mark[1]!
    if (!targets.includes(id) || result.has(id)) return
    const body = text.slice(mark.index! + mark[0].length, marks[index + 1]?.index ?? text.length).trim()
    if (body === '（删除）' || body === '(删除)') result.set(id, null)
    else if (body) result.set(id, body)
  })
  return result
}

export interface Applied {
  readonly body: string
  /** Every target and the blocks it became (itself first when kept; none when removed). */
  readonly into: ReadonlyMap<string, readonly string[]>
}

/**
 * Put the rewritten paragraphs into `body` (no frontmatter). Each one goes through `finalize`, the first
 * paragraph keeping the target's id; citations to chunks not in `knownChunk` become 待核实.
 */
export function applyRevision(body: string, revised: ReadonlyMap<string, string | null>, options: { readonly knownChunk: (id: string) => boolean; readonly newBlockId: () => string }): Applied {
  const out: string[] = []
  const into = new Map<string, string[]>()
  for (const piece of splitPieces(body)) {
    const [block] = /^#{1,6}\s/.test(piece) ? [] : indexBlocks(piece)
    if (!block || !revised.has(block.id)) { out.push(piece); continue }
    const text = revised.get(block.id)
    if (text === null) { into.set(block.id, []); continue }
    let first = true
    const done = finalize(text!, { knownChunk: options.knownChunk, newBlockId: options.newBlockId, reuse: () => { if (!first) return undefined; first = false; return block.id } })
    out.push(done.body.trim())
    into.set(block.id, done.blocks.map(item => item.id))
  }
  return { body: `${out.join('\n\n')}\n`, into }
}
