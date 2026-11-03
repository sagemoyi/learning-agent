// core (docs/core/design.md, 备份和恢复): the restore drill. A synthetic course with a confirmed goal, a written
// handout, answered tests, an annotation and a side-chat summary is backed up after DSH stops, restored into a
// new folder and started there: every table and file is as it was, the pages read it back, mastery recomputed
// from the evidence log is the same, and new sessions go to the restored course folders. A backup written by an
// older program (tests/fixtures/backup-*) restores and upgrades to the current tables.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { COURSE_LAYOUT, DATA_LAYOUT } from '@learning-agent/contracts'
import { backup, restore } from '../../packages/core/src/backup.ts'
import { FIXTURES, createHarness, type Harness, type ModelCall } from '../harness.ts'
import { lessonCourse, lessonText } from '../lesson-setup.ts'

const scratch = mkdtempSync(join(tmpdir(), 'learning-drill-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

function reply(call: ModelCall): string {
  const lesson = lessonText(call)
  if (lesson !== undefined) return lesson
  if (call.purpose === 'learning-sidechat-summary') return JSON.stringify({ questions: [{ quote: '水深加倍压强会怎样', text: '水深加倍时静水压强怎样变', nodes: [] }], conclusions: [{ text: '静水压强和深度成正比' }], help: [], misconceptions: [] })
  throw new Error(`unexpected model call: ${call.purpose}`)
}

/** Every row of every table, rowids included (FTS and ordering depend on them). */
function tables(h: Harness): Record<string, unknown[]> {
  const sqlite = h.ctx.learnCore.db.sqlite
  const names = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name").all() as { name: string }[]).map(row => row.name)
  return Object.fromEntries(names.map(name => {
    const withRowid = !/WITHOUT ROWID/i.test((sqlite.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as { sql: string }).sql)
    const rows = sqlite.prepare(`SELECT ${withRowid ? 'rowid AS _rowid, ' : ''}* FROM "${name}"`).all()
    return [name, rows.map(row => JSON.stringify(row, (_key, value: unknown) => value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value))]
  }))
}

it('restores a course into a new folder that starts and reads back as it was', async () => {
  const h = createHarness(reply)
  const { courseId, nodeId, stage, lesson, problems } = await lessonCourse(h, '恢复演练（合成资料）')
  const quiz = h.ctx.learnAssess.startTest({ courseId, kind: 'quiz', lessonId: lesson.id, problemIds: [problems[1]!.id] })
  await h.endpoint('assess', 'submit', { testId: quiz.id, answers: [{ problemId: problems[1]!.id, text: '20000 Pa' }] })
  const blockId = (h.ctx.learnCore.db.sqlite.prepare('SELECT block_id FROM textbook_blocks WHERE course_id = ? LIMIT 1').get(courseId) as { block_id: string }).block_id
  const note = await h.endpoint('annotation', 'create', { courseId, type: 'question', anchor: { kind: 'block', courseId, blockId }, text: '为什么和容器形状无关？', requestId: 'drill-1' })
  const side = await h.ctx.learnSidechat.open({ courseId, page: 'textbook.reader' } as never)
  h.sessions.get(side.sessionId)!.events.push(
    { type: 'user/message', data: { content: [{ type: 'text', text: '水深加倍压强会怎样？' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '也加倍。' }] } } },
  )
  await h.ctx.learnSidechat.close(side.sessionId)
  await h.settle()
  const handoutPath = `${stage.folder}/handout.md`
  const handout = (await h.ctx.learnCore.files.read(courseId, handoutPath))!.text
  const sideNotes = (await h.ctx.learnCore.files.read(courseId, COURSE_LAYOUT.sideChats))!.text
  expect(sideNotes).toContain('水深加倍时静水压强怎样变')
  const before = { tables: tables(h), states: h.ctx.learnLearner.states(), log: h.ctx.learnCore.log.count() }
  const oldWorkspace = h.ctx.learnCore.courses.get(courseId)!.workspaceId
  writeFileSync(join(h.root, '.env'), 'DEEPSEEK_API_KEY=合成的假密钥\n')

  // While DSH has the library open, the backup refuses; after it stops, it goes through.
  await expect(backup({ dataRoot: h.root, target: join(scratch, 'backup') })).rejects.toThrow('学习库正在被使用')
  h.dispose(true)
  const manifest = await backup({ dataRoot: h.root, target: join(scratch, 'backup') })
  // How the old-library fixtures were made: FIXTURE_BACKUP=tests/fixtures/backup-<date> on the code of that date.
  if (process.env.FIXTURE_BACKUP) cpSync(join(scratch, 'backup'), process.env.FIXTURE_BACKUP, { recursive: true })
  expect(manifest.files.some(file => file.path.endsWith('.env'))).toBe(false)
  expect(manifest.migrations).toMatchObject({ core: 1, assess: expect.any(Number), library: expect.any(Number) })

  const restored = join(scratch, 'restored')
  await restore({ source: join(scratch, 'backup'), target: restored })
  rmSync(h.root, { recursive: true, force: true })
  const again = createHarness(reply, {}, { root: restored })
  try {
    expect(tables(again)).toEqual(before.tables)
    const changes = again.ctx.learnCore.changes.list({ courseId, limit: 1000 }).length
    expect(again.ctx.learnCore.log.count()).toBe(before.log)
    // Recomputed now from the restored log: everything but the time it was computed at is the same.
    const unstamped = (states: readonly object[]) => states.map(({ computedAt: _at, ...state }: { computedAt?: string }) => state)
    expect(unstamped(again.ctx.learnLearner.recompute())).toEqual(unstamped(before.states))
    expect(again.ctx.learnLearner.states([nodeId])).toHaveLength(1)

    // What the pages show.
    expect((await again.endpoint('core', 'courses', {})).map((course: { id: string }) => course.id)).toEqual([courseId])
    expect((await again.ctx.learnCore.files.read(courseId, handoutPath))!.text).toBe(handout)
    expect(readFileSync(join(restored, DATA_LAYOUT.courses, again.ctx.learnCore.courses.get(courseId)!.slug, handoutPath), 'utf8')).toBe(handout)
    expect((await again.ctx.learnCore.files.read(courseId, COURSE_LAYOUT.sideChats))!.text).toBe(sideNotes)
    expect(await again.endpoint('assess', 'view', { testId: quiz.id })).toMatchObject({ test: { status: 'graded' } })
    expect((await again.endpoint('annotation', 'list', { courseId })).map((item: { id: string }) => item.id)).toEqual([note.id])
    expect((await again.ctx.learnLibrary.search('静水压强', { courseId })).length).toBeGreaterThan(0)
    // Reading the restored files records nothing: they are not taken for edits made outside the app.
    expect(again.ctx.learnCore.changes.list({ courseId, limit: 1000 })).toHaveLength(changes)

    // A new session goes to the restored course folder, not the workspace of the old one.
    await again.ctx.learnSidechat.open({ courseId, page: 'textbook.reader' } as never)
    expect(again.ctx.learnCore.courses.get(courseId)!.workspaceId).not.toBe(oldWorkspace)
  } finally {
    again.dispose()
  }
})

it('restores the backups older programs wrote, and upgrades them to the current tables', async () => {
  const fixtures = readdirSync(FIXTURES).filter(name => name.startsWith('backup-'))
  expect(fixtures.length).toBeGreaterThan(0)
  for (const name of fixtures) {
    const target = join(scratch, `upgraded-${name}`)
    const { manifest } = await restore({ source: join(FIXTURES, name), target })
    const h = createHarness(reply, {}, { root: target })
    try {
      const versions = Object.fromEntries((h.ctx.learnCore.db.sqlite.prepare('SELECT unit, MAX(version) AS version FROM core_migrations GROUP BY unit').all() as { unit: string; version: number }[]).map(row => [row.unit, row.version]))
      for (const [unit, version] of Object.entries(manifest.migrations)) expect(versions[unit], `${name}: ${unit}`).toBeGreaterThanOrEqual(version)
      const [course] = await h.endpoint('core', 'courses', {})
      const stage = h.ctx.learnCurriculum.stages(course.id)[0]!
      expect((await h.ctx.learnCore.files.read(course.id, `${stage.folder}/handout.md`))?.text).toContain('静水压强')
      expect(h.ctx.learnAssess.tests(course.id, {}).map(test => test.status)).toEqual(['graded', 'graded'])
      expect(await h.endpoint('annotation', 'list', { courseId: course.id })).toHaveLength(1)
      expect(h.ctx.learnLearner.recompute().length).toBeGreaterThan(0)
    } finally {
      h.dispose()
    }
  }
})
