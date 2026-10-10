import { describe, expect, it } from 'vitest'
import { promptError } from '../src/prompt-error.ts'

describe('why a message did not go into a session', () => {
  it('reads a message and its code', () => {
    expect(promptError({ code: 'session/busy', message: '会话正忙' })).toBe('会话正忙（session/busy）')
    expect(promptError({ message: '没有这个会话' })).toBe('没有这个会话')
    expect(promptError('workspace not found')).toBe('workspace not found')
  })

  it('never shows the error object as JSON', () => {
    // A DSH remote error: its message is not an own property, so only code, details and name survive JSON.stringify.
    const remote = Object.assign(new Error(''), { code: 'gateway/internal', details: {}, isDSHRemoteError: true, name: 'RemoteError' })
    expect(promptError(remote)).toBe('没有发出去（gateway/internal）')
    expect(promptError(undefined)).toBe('没有发出去')
    expect(promptError({})).toBe('没有发出去')
  })
})
