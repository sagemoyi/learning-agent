// Relation phrases follow the stored direction; a prerequisite arrow points to the required ability.
import type { RelationStatus } from '@learning-agent/contracts'
export const KIND_LABEL = { knowledge: '知识', skill: '技能', integrated: '综合能力', task: '完整任务' } as const
export const EDGE_LABEL = { 'part-of': '是组成项', requires: '需要先掌握', 'recommended-before': '建议先于', related: '与之相关' } as const
export const STATUS_LABEL: Record<RelationStatus, string> = { draft: '草案', valid: '有效', disputed: '有争议', legacy: '遗留待复核', inactive: '已停用' }
