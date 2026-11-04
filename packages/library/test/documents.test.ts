// Loaded PDFs are shared between the reader and figures, and let go half a minute after the last one; figures draw a few
// at a time. pdf.js is faked: only the borrowing is under test.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { getDocument } = vi.hoisted(() => ({
  getDocument: vi.fn((_options: { url: string }) => ({ promise: Promise.resolve({}), destroy: vi.fn(() => Promise.resolve()) })),
}))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument }))

import { borrowDocument, inTurn, originalUrl } from '../src/client/documents.ts'

beforeEach(() => { vi.useFakeTimers(); getDocument.mockClear() })
afterEach(() => { vi.useRealTimers() })

it('opens one book once however many borrow it, and lets go half a minute after the last returns it', async () => {
  const url = originalUrl('src_shared')
  const reader = borrowDocument(url), figure = borrowDocument(url), other = borrowDocument(originalUrl('src_other'))
  expect(getDocument).toHaveBeenCalledTimes(2)
  const task = getDocument.mock.results[0]!.value as { destroy: ReturnType<typeof vi.fn> }

  reader.release()
  reader.release()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(task.destroy).not.toHaveBeenCalled()

  figure.release()
  await vi.advanceTimersByTimeAsync(29_000)
  expect(task.destroy).not.toHaveBeenCalled()
  // Borrowed again in time: the same load, kept.
  const again = borrowDocument(url)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(getDocument).toHaveBeenCalledTimes(2)
  expect(task.destroy).not.toHaveBeenCalled()

  again.release()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(task.destroy).toHaveBeenCalledTimes(1)
  // After that it is opened anew.
  const fresh = borrowDocument(url)
  expect(getDocument).toHaveBeenCalledTimes(3)
  fresh.release()
  other.release()
  await vi.advanceTimersByTimeAsync(30_000)
})

it('draws three at a time, and goes on after one fails', async () => {
  vi.useRealTimers()
  let running = 0, most = 0
  const gates: (() => void)[] = []
  const draw = (fail = false) => inTurn(async () => {
    running++
    most = Math.max(most, running)
    await new Promise<void>(resolve => gates.push(resolve))
    running--
    if (fail) throw new Error('画不出来')
  })
  const all = [draw(true), draw(), draw(), draw(), draw()]
  const settled = Promise.allSettled(all)
  for (let opened = 0; opened < all.length; opened++) {
    await vi.waitFor(() => expect(gates.length).toBeGreaterThan(opened))
    gates[opened]!()
  }
  const results = await settled
  expect(most).toBe(3)
  expect(results.map(result => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
})
