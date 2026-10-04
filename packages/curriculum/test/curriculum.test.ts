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
    expect(second.stages.map(stage => [stage.title, stage.folder])).toEqual([['流体流动与静力学', 'stages/01-流体流动']])
  })

  it('refuses to drop a stage that has started', () => {
    const { stages } = store.applyRoadmap(courseId, [{ title: 'A', objective: '' }, { title: 'B', objective: '' }])
    store.saveStage({ ...stages[1]!, status: 'learning' })
    expect(() => store.applyRoadmap(courseId, [{ title: 'A', objective: '' }])).toThrow(/已经开始/)
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
