import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@learning-agent/contracts'
import { Database } from '../../core/src/db.ts'
import { CurriculumStore, curriculumMigrations } from '../src/store.ts'

describe('curriculum store', () => {
  let root: string
  let db: Database
  let store: CurriculumStore
  const courseId = newId('course')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'learning-curriculum-'))
    db = new Database(join(root, 'learning.db'))
    db.migrate('curriculum', curriculumMigrations)
    store = new CurriculumStore(db.sqlite)
  })

  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('creates, renames and trims planned stages from the roadmap', () => {
    const first = store.applyRoadmap(courseId, [{ title: '流体流动', objective: 'a' }, { title: '流体输送', objective: 'b' }])
    expect(first.created.map(stage => stage.folder)).toEqual(['stages/01-流体流动', 'stages/02-流体输送'])
    const second = store.applyRoadmap(courseId, [{ title: '流体流动与静力学', objective: 'a2' }])
    expect(second.created).toEqual([])
    // A planned stage has no files yet: its folder follows the new title.
    expect(second.stages.map(stage => [stage.title, stage.folder])).toEqual([['流体流动与静力学', 'stages/01-流体流动与静力学']])
  })

  it('keeps what a stage supports when the route is reordered without supports', () => {
    store.applyRoadmap(courseId, [{ title: 'A', objective: '', supports: ['c1'] }, { title: 'B', objective: '', supports: ['c2'] }])
    const { stages } = store.applyRoadmap(courseId, [{ title: 'B', objective: '' }, { title: 'C', objective: '' }])
    expect(stages.map(stage => [stage.title, stage.supports])).toEqual([['B', ['c2']], ['C', ['c2']]])
  })

  it('keeps started stages in front and replaces only the open ones', () => {
    const { stages } = store.applyRoadmap(courseId, [{ title: 'A', objective: '' }, { title: 'B', objective: '' }, { title: 'C', objective: '' }])
    store.saveStage({ ...stages[1]!, status: 'learning' })
    const { stages: after } = store.applyRoadmap(courseId, [{ title: 'D', objective: '' }])
    expect(after.map(stage => [stage.index, stage.title, stage.id === stages[2]!.id])).toEqual([[1, 'A', false], [2, 'B', false], [3, 'D', true]])
  })

  it('inserts a remedial stage after a reviewed one; the planned stages move down', () => {
    const { stages } = store.applyRoadmap(courseId, [{ title: 'A', objective: '' }, { title: 'B', objective: '' }])
    const done = store.saveStage({ ...stages[0]!, status: 'done' })
    const remedial = store.insertRemedial(done, { title: '补课', objective: '补上', nodeIds: [newId('node')] })
    expect(store.stages(courseId).map(stage => [stage.index, stage.title, stage.kind, stage.folder])).toEqual([
      [1, 'A', 'normal', 'stages/01-A'], [2, '补课', 'remedial', 'stages/02-补课'], [3, 'B', 'normal', 'stages/03-B'],
    ])
    expect(remedial.remedialOf).toBe(done.id)
    // The remedial stage is fixed: a roadmap draft replaces only what comes after it.
    expect(store.split(courseId).open.map(stage => stage.title)).toEqual(['B'])
    store.saveStage({ ...store.stages(courseId)[2]!, status: 'learning' })
    expect(() => store.insertRemedial(done, { title: '再补', objective: '', nodeIds: [newId('node')] })).toThrow(/已经开始，补课阶段插不进去/)
  })

  it('maps lessons to textbook and record files, keeping started lessons', () => {
    const { stages } = store.applyRoadmap(courseId, [{ title: '流体流动', objective: '' }])
    const stage = stages[0]!
    const lessons = store.applyLessons(stage, [{ number: '1.1', title: '概述' }, { number: '1.2', title: '流体静力学' }])
    expect(lessons.map(lesson => [lesson.textbookFile, lesson.recordFile])).toEqual([
      ['stages/01-流体流动/textbook/1.1-概述.md', 'stages/01-流体流动/lessons/1.1.md'],
      ['stages/01-流体流动/textbook/1.2-流体静力学.md', 'stages/01-流体流动/lessons/1.2.md'],
    ])
    store.saveLesson({ ...lessons[0]!, status: 'in-progress' })
    const again = store.applyLessons(stage, [{ number: '1.1', title: '概述（改）' }])
    expect(again).toHaveLength(1)
    expect(again[0]!.id).toBe(lessons[0]!.id)
    expect(again[0]!.title).toBe('概述（改）')
  })
})
