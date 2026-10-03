import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COURSE_LAYOUT, newId, parseFrontmatter } from '@learning-agent/contracts'
import { Database } from '../src/db.ts'
import { coreMigrations } from '../src/migrations.ts'
import { CoreStore } from '../src/store.ts'

let root: string
let db: Database
let events: { name: string; payload: unknown }[]
let store: CoreStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'learning-core-'))
  db = new Database(join(root, '.learning', 'learning.db'))
  db.migrate('core', coreMigrations)
  events = []
  let workspaces = 0
  store = new CoreStore(
    db,
    root,
    (name, payload) => events.push({ name, payload }),
    () => ({ create: async () => ({ id: `ws-${++workspaces}` }) }),
  )
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('database', () => {
  it('applies each migration once and checks numbering', () => {
    const steps = [{ version: 1, sql: 'CREATE TABLE demo_a (x INTEGER)' }]
    db.migrate('demo', steps)
    db.migrate('demo', steps)
    db.migrate('demo', [...steps, { version: 2, sql: 'CREATE TABLE demo_b (x INTEGER)' }])
    const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'demo_%' ORDER BY name").all()
    expect(tables).toEqual([{ name: 'demo_a' }, { name: 'demo_b' }])
    expect(() => db.migrate('demo', [{ version: 3, sql: 'SELECT 1' }])).toThrow(/numbered/)
  })

  it('runs after-commit work only after the outermost commit, and drops it on rollback', () => {
    const seen: string[] = []
    db.transaction(() => {
      db.afterCommit(() => seen.push('outer'))
      db.transaction(() => db.afterCommit(() => seen.push('inner')))
      expect(seen).toEqual([])
    })
    expect(seen).toEqual(['outer', 'inner'])
    expect(() => db.transaction(() => {
      db.afterCommit(() => seen.push('lost'))
      throw new Error('boom')
    })).toThrow('boom')
    expect(seen).toEqual(['outer', 'inner'])
  })
})

describe('courses and files', () => {
  it('creates the folder, workspace and course card through the change log', async () => {
    const course = await store.courses.create({ title: '化工原理' })
    expect(course.slug).toBe('化工原理')
    expect(course.workspaceId).toBe('ws-1')
    const card = readFileSync(join(store.courses.folder(course.id), COURSE_LAYOUT.card), 'utf8')
    expect(parseFrontmatter(card).data).toEqual({ course: course.id, title: '化工原理' })
    expect(events.map(e => e.name)).toEqual(['learning/change-applied', 'learning/doc-changed', 'learning/course-created'])
    const again = await store.courses.create({ title: '化工原理' })
    expect(again.slug).toBe('化工原理-2')
  })

  it('records before/after, detects outside edits, and reverts', async () => {
    const course = await store.courses.create({ title: 'C' })
    const first = await store.files.write(course.id, 'goal.md', 'v1', { actor: 'teacher', reason: 'draft' })
    expect(first.before).toBeNull()
    const second = await store.files.write(course.id, 'goal.md', 'v2', { actor: 'teacher', reason: 'edit', size: 'major' })
    expect([second.before, second.after]).toEqual(['v1', 'v2'])

    // The learner edits the file in Obsidian.
    writeFileSync(join(store.courses.folder(course.id), 'goal.md'), 'v2 + my note', 'utf8')
    const read = await store.files.read(course.id, 'goal.md')
    expect(read?.text).toBe('v2 + my note')
    const outside = store.changes.list({ target: { kind: 'file', courseId: course.id, path: 'goal.md' } })[0]!
    expect([outside.actor, outside.before, outside.after]).toEqual(['user', 'v2', 'v2 + my note'])

    const reverted = await store.changes.revert(outside.id, { actor: 'user', reason: 'undo' })
    expect(reverted.revertOf).toBe(outside.id)
    expect((await store.files.read(course.id, 'goal.md'))?.text).toBe('v2')
  })

  it('refuses paths outside the course folder', async () => {
    const course = await store.courses.create({ title: 'C' })
    await expect(store.files.write(course.id, '../escape.md', 'x', { actor: 'system', reason: 't' })).rejects.toThrow()
    await expect(store.files.write(course.id, 'C:\\abs.md', 'x', { actor: 'system', reason: 't' })).rejects.toThrow()
  })

  it('appends to a file as one change per call', async () => {
    const course = await store.courses.create({ title: 'C' })
    await store.files.append(course.id, COURSE_LAYOUT.sideChats, 'a\n', { actor: 'system', reason: 's1' })
    await store.files.append(course.id, COURSE_LAYOUT.sideChats, 'b\n', { actor: 'system', reason: 's2' })
    expect((await store.files.read(course.id, COURSE_LAYOUT.sideChats))?.text).toBe('a\nb\n')
  })
})

describe('evidence log', () => {
  it('validates, emits after commit, filters by node, and stays append-only', () => {
    const node = newId('node')
    const entry = store.log.append({
      type: 'help.given',
      nodeIds: [node],
      context: {},
      level: 'hint',
      via: 'teacher',
    })
    expect(entry.id.startsWith('lg_')).toBe(true)
    expect(events.at(-1)).toEqual({ name: 'learning/logged', payload: entry })
    store.log.append({ type: 'signal.question', nodeIds: [newId('node')], context: {}, text: '为什么？' })
    expect(store.log.query({ nodeId: node }).map(e => e.id)).toEqual([entry.id])
    expect(store.log.query({ types: ['signal.question'] })).toHaveLength(1)
    expect(() => store.log.append({ type: 'help.given', nodeIds: [], context: {}, level: 'nonsense', via: 'teacher' } as never)).toThrow()
    expect(() => db.sqlite.prepare('DELETE FROM core_log').run()).toThrow(/append-only/)
    expect(() => db.sqlite.prepare("UPDATE core_log SET type = 'x'").run()).toThrow(/append-only/)
  })
})

describe('sessions and proposals', () => {
  it('links sessions to courses and closes them', async () => {
    const course = await store.courses.create({ title: 'C' })
    const sessionId = globalThis.crypto.randomUUID()
    store.sessions.link({ sessionId, courseId: course.id, role: 'side-chat', createdAt: new Date().toISOString() })
    expect(store.sessions.list({ courseId: course.id, role: 'side-chat' })).toHaveLength(1)
    store.sessions.close(sessionId)
    expect(store.sessions.get(sessionId)?.closedAt).toBeTruthy()
  })

  it('creates and decides proposals', async () => {
    const course = await store.courses.create({ title: 'C' })
    const proposal = store.proposals.create({
      courseId: course.id,
      source: 'side-chat',
      targets: [{ kind: 'file', courseId: course.id, path: 'roadmap.md' }],
      summary: '先学传热再学蒸馏',
      rationale: '你说考试顺序如此',
    })
    expect(events.at(-1)?.name).toBe('learning/proposal-created')
    const decided = store.proposals.decide(proposal.id, 'rejected')
    expect(decided.status).toBe('rejected')
    expect(store.proposals.list({ courseId: course.id, status: 'open' })).toHaveLength(0)
  })
})
