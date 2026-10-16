// The graph's own settings, as Obsidian has them: how it looks (node size, line width, how many names) and
// the forces of the layout. Each is a share from 0 to 1, remembered in this browser as a view preference;
// layout.ts and canvas.tsx turn the shares into forces and sizes.

export interface GraphSettings {
  readonly nodeSize: number
  readonly edgeSize: number
  /** More names: labels appear on smaller nodes. */
  readonly labels: number
  /** Pull towards the centre, so loose groups stay near. */
  readonly center: number
  readonly repel: number
  /** How tight the relation "rubber bands" are. */
  readonly link: number
  readonly distance: number
}

export const DEFAULT_SETTINGS: GraphSettings = { nodeSize: 0.4, edgeSize: 0.4, labels: 0.65, center: 0.3, repel: 0.3, link: 0.5, distance: 0.3 }

export const SETTING_LABELS: Readonly<Record<keyof GraphSettings, { label: string; low: string; high: string }>> = {
  nodeSize: { label: '节点大小', low: '小', high: '大' },
  edgeSize: { label: '连线粗细', low: '细', high: '粗' },
  labels: { label: '名称显示', low: '少', high: '多' },
  center: { label: '中心力', low: '松', high: '紧' },
  repel: { label: '排斥力', low: '弱', high: '强' },
  link: { label: '连线拉力', low: '松', high: '紧' },
  distance: { label: '连线长度', low: '短', high: '长' },
}

/** Settings read back from the browser, with anything missing or out of range put back to its default. */
export function withDefaults(stored: unknown): GraphSettings {
  const value = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const pick = (key: keyof GraphSettings) => {
    const n = value[key]
    return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_SETTINGS[key]
  }
  return Object.fromEntries((Object.keys(DEFAULT_SETTINGS) as (keyof GraphSettings)[]).map(key => [key, pick(key)])) as unknown as GraphSettings
}

/** The forces of the layout, in d3-force's units (graph units of distance). */
export interface Physics {
  /** Strength of the pull of every node towards the centre (d3 `forceX`/`forceY`). */
  readonly center: number
  /** Many-body strength: negative pushes apart. */
  readonly repel: number
  /** Multiplies d3's default link strength (1 / the smaller degree of the two ends). */
  readonly link: number
  readonly distance: number
}

export function physicsOf(settings: GraphSettings): Physics {
  return {
    center: 0.01 + 0.19 * settings.center,
    repel: -(20 + 380 * settings.repel),
    link: 2 * settings.link,
    distance: 10 + 190 * settings.distance,
  }
}

/** Multipliers of the model's node and line sizes. */
export function sizeScale(share: number): number {
  return 0.5 + 1.25 * share
}

/** The smallest node, in screen pixels, that gets its name written. */
export function labelThreshold(settings: GraphSettings): number {
  return 16 - 14 * settings.labels
}
