// Tool half of the stage-0 spike (V4): mounted only inside the "teacher" agent preset,
// so it must be visible to teacher sessions and absent from side-chat sessions.
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'learning-spike-tool'

export const inject = ['tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'learning_progress',
    description: 'Look up the learner\'s progress in a course. Returns a one-line summary (stage-0 demo data).',
    parameters: {
      course: { type: 'string', required: true, description: 'Course name, e.g. 化工原理' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { summary: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    execute(args) {
      return Promise.resolve({
        summary: `课程「${args.course}」：当前阶段是第 1 章 流体流动，已完成 1.1、1.2 两个小节，1.3 小测待做（演示数据）。`,
      })
    },
    presentCall: args => ({ card: 'generic', title: '查询学习进度', kind: 'other', rawInput: args }),
  }))
}
