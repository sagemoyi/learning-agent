// tutor C (docs/tutor/design.md, 修改提案): an error the learner reports on the textbook reaches the teacher's brief;
// the teacher checks it and records the outcome. "Applied" needs a change to the lesson made after the report,
// "rejected" needs the reason, and the learner's note shows what happened. Synthetic data; fake model and sessions.
import { afterEach, expect, it } from 'vitest'
import type { Annotation, Proposal } from '@learning-agent/contracts'
import * as tutorTools from '../packages/tutor/src/tools.ts'
import type { NoteView } from '../packages/annotation/src/types.ts'
import { createHarness, type Harness, type ModelCall } from './harness.ts'
import { lessonCourse, lessonText } from './lesson-setup.ts'

let h: Harness | undefined
afterEach(() => h?.dispose())

function reply(call: ModelCall): string {
  const text = lessonText(call)
  if (text) return text
  if (call.purpose === 'learning-tutor-ledger') return JSON.stringify({ help: [] })
  throw new Error(`unexpected model call: ${call.purpose}`)
}

it('takes an error report from the textbook to the teacher and back to the note', async () => {
  h = createHarness(reply)
  const { ctx, endpoint, call } = h
  const { courseId, lesson } = await lessonCourse(h, '主老师 C 提案（合成资料）')
  const path = lesson.textbookFile!
  const file = (await ctx.learnCore.files.read(courseId, path))!.text
  const blockId = /计算。.*\^([0-9a-z]{6})/.exec(file)![1]!
  const report = (exact: string, text: string, requestId: string) => endpoint<Annotation>('annotation', 'create', {
    courseId, type: 'error', text, requestId, anchor: { kind: 'block', courseId, blockId, quote: { exact, prefix: '', suffix: '' } },
  })
  const first = await report('静水压强按', '这里应该写"静水压强 p 按"，少了符号', 'err-1')
  expect(first.proposalId).toBeTruthy()

  // The brief names the lesson, the paragraph, and the learner's words.
  const brief = await ctx.learnTutor.brief(courseId, '')
  expect(brief).toContain('## 待处理的修改提案')
  expect(brief).toContain(first.proposalId)
  expect(brief).toContain(`教材 1.1 静水压强（${lesson.id}）`)
  expect(brief).toContain(`段落 ^${blockId}`)
  expect(brief).toContain('少了符号')

  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>()
  ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('tools', { register: (tool: { name: string }) => { tools.set(tool.name, tool as never); return () => tools.delete(tool.name) } })
  tutorTools.apply(ctx as never)
  const teacher = await ctx.learnTutor.session(courseId)
  const decide = (args: Record<string, unknown>, session = teacher) => tools.get('decide_proposal')!.execute(args, { agent: { session: { id: session } } })

  // Nothing was changed yet: "applied" is refused; "rejected" needs the reason.
  await expect(decide({ proposalId: first.proposalId, decision: 'applied' })).rejects.toThrow('还没有改动')
  await expect(decide({ proposalId: first.proposalId, decision: 'rejected' })).rejects.toThrow('写清理由')
  // Another course's teacher cannot decide it.
  const other = await endpoint('core', 'createCourse', { title: '另一门课（合成资料）' })
  await expect(decide({ proposalId: first.proposalId, decision: 'rejected', note: '不改' }, await ctx.learnTutor.session(other.id))).rejects.toThrow('不属于这门课')

  // The teacher fixes the paragraph, then records it.
  const fix = await ctx.learnCore.files.write(courseId, path, file.replace('静水压强按', '静水压强 p 按'), { actor: 'teacher', reason: '按批注改正' })
  await decide({ proposalId: first.proposalId, decision: 'applied', note: '补上了符号 p' })
  const applied = ctx.learnCore.proposals.get(first.proposalId!)!
  expect(applied).toMatchObject({ status: 'applied', changeIds: [fix.id], decisionNote: '补上了符号 p' })
  await expect(decide({ proposalId: first.proposalId, decision: 'applied' })).rejects.toThrow('已经处理过了')
  await h.settle()

  // A second report is checked and kept as it is.
  const second = await report('计算', '公式应该是 p = ρgh + p0 吧', 'err-2')
  await decide({ proposalId: second.proposalId, decision: 'rejected', note: '这一节讲的是表压，资料里就是 p = ρgh' })
  await h.settle()

  // The learner's notes show the outcome and count as handled; the brief has nothing left to do.
  const notes = await endpoint<NoteView[]>('annotation', 'list', { courseId })
  const byId = new Map(notes.map(note => [note.id, note]))
  expect(byId.get(first.id)).toMatchObject({ resolvedAt: expect.any(String), proposal: { status: 'applied', note: '补上了符号 p' } })
  expect(byId.get(second.id)).toMatchObject({ resolvedAt: expect.any(String), proposal: { status: 'rejected', note: expect.stringContaining('表压') } })
  expect(await ctx.learnTutor.brief(courseId, '')).not.toContain('待处理的修改提案')
  expect((await call<Proposal>('annotation', 'submitError', { annotationId: second.id })).value).toMatchObject({ status: 'rejected' })
})

it('a new note must quote the paragraph word for word; a sentence that is only close is refused', async () => {
  h = createHarness(reply)
  const { ctx, call } = h
  const { courseId, lesson } = await lessonCourse(h, '批注原句（合成资料）')
  const file = (await ctx.learnCore.files.read(courseId, lesson.textbookFile!))!.text
  const blockId = /计算。.*\^([0-9a-z]{6})/.exec(file)![1]!
  const create = (exact: string) => call('annotation', 'create', { courseId, type: 'highlight', anchor: { kind: 'block', courseId, blockId, quote: { exact, prefix: '', suffix: '' } } })
  expect((await create('静水压强按')).ok).toBe(true)
  expect((await create('静水压力按')).error?.code).toBe('learning/annotation/quote-missing')
})
