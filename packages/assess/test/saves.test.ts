// assess (docs/assess/design.md, 作答): answers in progress are saved in order, a failure is reported and kept, and
// handing in waits for every save queued or on its way.
import { expect, it } from 'vitest'
import { SaveQueue, SavesFailed, type SaveState } from '../src/saves.ts'

/** A save the test answers by hand. */
function server() {
  const sent: { key: string; value: string; reply(error?: Error): void }[] = []
  const send = (key: string, value: string) => new Promise<void>((resolve, reject) => {
    sent.push({ key, value, reply: error => (error ? reject(error) : resolve()) })
  })
  return { sent, send }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

it('sends a problem\'s versions one at a time and in order; only the latest reply counts as saved', async () => {
  const { sent, send } = server()
  const states: SaveState[] = []
  const queue = new SaveQueue(send, (_, state) => { states.push(state) })
  queue.put('p1', 'a')
  const first = queue.save('p1')
  queue.put('p1', 'ab')
  const second = queue.save('p1')
  await tick()
  // The second version waits for the first reply: the server cannot receive them the other way round.
  expect(sent.map(item => item.value)).toEqual(['a'])
  sent[0]!.reply()
  await first
  await tick()
  expect(sent.map(item => item.value)).toEqual(['a', 'ab'])
  // The first version's reply came back, the latest is still on its way.
  expect(queue.pending).toBe(true)
  expect(states.at(-1)).toBe('saving')
  sent[1]!.reply()
  await second
  expect(queue.pending).toBe(false)
  expect(states.at(-1)).toBe('saved')
})

it('a failed save is reported and kept; a retry sends the latest input', async () => {
  const { sent, send } = server()
  const failures: string[] = []
  const queue = new SaveQueue(send, (key, state) => { if (state === 'failed') failures.push(key) })
  queue.put('p1', 'x = 1')
  const saving = queue.save('p1')
  await tick()
  sent[0]!.reply(new Error('网络断了'))
  await expect(saving).rejects.toThrow('网络断了')
  expect(failures).toEqual(['p1'])
  expect(queue.pending).toBe(true)
  queue.put('p1', 'x = 2')
  const retry = queue.save('p1')
  await tick()
  expect(sent.at(-1)!.value).toBe('x = 2')
  sent.at(-1)!.reply()
  await retry
  expect(queue.pending).toBe(false)
})

it('handing in waits for what is queued and on its way, and names the problems that could not be saved', async () => {
  const { sent, send } = server()
  const queue = new SaveQueue(send)
  queue.put('p1', 'on its way')
  void queue.save('p1').catch(() => {})
  queue.put('p2', 'queued')
  queue.put('p3', 'queued')
  let done = false
  const all = queue.saveAll().then(() => { done = true }, error => error as SavesFailed)
  await tick()
  expect(sent.map(item => item.key).sort()).toEqual(['p1', 'p2', 'p3'])
  sent.find(item => item.key === 'p1')!.reply()
  sent.find(item => item.key === 'p2')!.reply()
  await tick()
  expect(done).toBe(false)
  sent.find(item => item.key === 'p3')!.reply(new Error('服务器没回应'))
  const failed = await all
  expect(failed).toBeInstanceOf(SavesFailed)
  expect((failed as SavesFailed).keys).toEqual(['p3'])
  expect((failed as SavesFailed).message).toBe('服务器没回应')
  // Trying again sends only what is not saved.
  const again = queue.saveAll()
  await tick()
  sent.at(-1)!.reply()
  await again
  expect(sent).toHaveLength(4)
  expect(queue.pending).toBe(false)
})
