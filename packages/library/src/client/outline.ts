// A source's chapter outline as a tree, from the section headings the parser found (most PDFs, scanned textbooks
// above all, carry no bookmarks of their own).

/** One heading: its section path (itself last), its chunk and the PDF page it starts on. */
export interface OutlineEntry {
  readonly section: readonly string[]
  readonly chunkId: string
  readonly page: number
}

export interface OutlineNode {
  /** The section path, joined: unique within the source. */
  readonly key: string
  readonly title: string
  readonly page: number
  readonly chunkId: string
  readonly children: OutlineNode[]
}

const JOIN = '\u0000'

/**
 * Nest the headings by their section paths, in reading order. A heading goes under the nearest heading whose path its
 * own path extends (a missing level is skipped, not invented); the same path again is the first one's.
 */
export function outlineTree(entries: readonly OutlineEntry[]): OutlineNode[] {
  const roots: OutlineNode[] = []
  const byKey = new Map<string, OutlineNode>()
  for (const entry of entries) {
    const title = entry.section.at(-1)?.trim()
    if (!title) continue
    const key = entry.section.join(JOIN)
    if (byKey.has(key)) continue
    const node: OutlineNode = { key, title, page: entry.page, chunkId: entry.chunkId, children: [] }
    let parent: OutlineNode | undefined
    for (let depth = entry.section.length - 1; depth > 0 && !parent; depth--) parent = byKey.get(entry.section.slice(0, depth).join(JOIN))
    ;(parent?.children ?? roots).push(node)
    byKey.set(key, node)
  }
  return roots
}
