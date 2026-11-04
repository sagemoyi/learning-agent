// What the e2e run checks: the smoke test, the whole learning flow with a scripted teacher, then the high-risk page
// states that tests with a fake transport cannot see. Each scenario gets a fresh page; the data stays for the next one.
import { join } from 'node:path'
import { ROOT } from '../browser.ts'
import type { Run } from './run.ts'

export interface Scenario {
  readonly name: string
  run(run: Run): Promise<void>
}

const CHAPTER = join(ROOT, 'tests/fixtures/synthetic-chapter')

/** Every unit answers through its real plugin; a unit that failed to load (a broken inject, say) has no endpoint. */
const READS: readonly (readonly [string, (courseId: string) => unknown])[] = [
  ['core.courses', () => ({})],
  ['goal.get', courseId => ({ courseId })],
  ['assess.tests', courseId => ({ courseId })],
  ['curriculum.overview', courseId => ({ courseId })],
  ['knowledge.graph', courseId => ({ courseId })],
  ['learner.states', () => ({ nodeIds: [] })],
  ['library.sources', courseId => ({ courseId })],
  ['planner.next', courseId => ({ courseId })],
  ['settings.about', () => ({})],
  ['sidechat.active', courseId => ({ courseId })],
  ['annotation.list', courseId => ({ courseId })],
  ['textbook.current', courseId => ({ courseId })],
  ['tutor.session', courseId => ({ courseId })],
]

/** The course with this title, made when it is missing, with its id. */
async function course(run: Run, title: string): Promise<{ id: string; title: string }> {
  const courses = await run.rpc<{ id: string; title: string }[]>('core.courses', {})
  const found = courses.find(item => item.title === title)
  if (found) return found
  const made = await run.rpc('core.createCourse', { title })
  await run.page.reload()
  await run.page.locator('.la-app').waitFor()
  return made
}

const chatOf = ({ page }: Run) => page.locator('.la-page[data-current] .la-chat').first()

async function say(run: Run, text: string): Promise<void> {
  const box = chatOf(run).locator('.la-composer textarea')
  await box.fill(text)
  await box.press('Enter')
}

async function teacherOf(run: Run, title: string): Promise<void> {
  await run.enter(title)
  await run.app.nav('主老师')
  await chatOf(run).locator('.la-composer textarea').waitFor()
}

const smoke: Scenario = {
  name: 'smoke',
  async run(run) {
    const { env, page, check, until, rpc } = run
    check('DSH starts and the workbench opens', await page.locator('.la-app').count() === 1)
    const pending = env.log().split('\n').filter(line => /did not activate|: pending \(|failed to (load|apply)|cannot find package/i.test(line))
    check('DSH activates every plugin', pending.length === 0, pending.slice(0, 3).join(' | ').slice(0, 400))
    const { id } = await course(run, '冒烟课（合成）')
    for (const [method, input] of READS) {
      const problem = await rpc(method, input(id)).then(() => '', (error: Error) => error.message)
      check(`${method} answers`, problem === '', problem.slice(0, 200))
    }
    await teacherOf(run, '冒烟课（合成）')
    const chat = chatOf(run)
    await say(run, '慢慢说一下静水压强')
    await until('the teacher\'s reply starts streaming', chat.getByText('第3句').first().waitFor({ timeout: 30_000 }))
    check('it is still being written when the first sentences show', await chat.getByText('第40句').count() === 0)
    await until('and finishes', chat.getByText('第40句').first().waitFor({ timeout: 30_000 }))
    await until('nothing is left waiting', chat.locator('.la-thinking').waitFor({ state: 'detached', timeout: 10_000 }))
  },
}

/**
 * The learning flow on real DSH. The teacher's turns are scripted through the fake model's 【工具】 messages, so every
 * tool runs through DSH's agent loop and its checks, and the learner's steps go through the page or its endpoints.
 */
const flow: Scenario = {
  name: 'flow',
  async run(run) {
    const { page, check, until, rpc, app } = run
    const title = '流程课（合成）'
    const { id: courseId } = await course(run, title)
    await teacherOf(run, title)
    const chat = chatOf(run)

    /** One scripted teacher turn; returns what the tool answered. */
    const tool = async (name: string, input: unknown, expected: string): Promise<string> => {
      const results = () => chatOf(run).locator('.la-msg.assistant', { hasText: '工具结果：' })
      const before = await results().count()
      await say(run, `【工具】${name} ${JSON.stringify(input)}`)
      await page.waitForFunction(count => document.querySelectorAll('.la-page[data-current] .la-chat .la-msg.assistant').length > 0 && [...document.querySelectorAll('.la-page[data-current] .la-chat .la-msg.assistant')].filter(el => el.textContent!.includes('工具结果：')).length > count, before, { timeout: 30_000 })
      const answer = await results().last().innerText()
      check(`${name} through the agent loop`, answer.includes(expected), answer.slice(0, 200))
      await chat.locator('.la-thinking').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {})
      return answer
    }

    // Goal: the teacher drafts, the learner confirms.
    await tool('save_goal_draft', { purpose: '验证整条流程', scenario: '合成资料短题', canDo: [{ text: '能按给定参数计算静水压强' }], level: '能独立完成资料中的计算', verification: '小测和阶段测试', book: 'closed', calculator: true, formulaSheet: false, notes: '仅用于流程回归（合成）。' }, '目标')
    await rpc('goal.confirm', { courseId })
    const goal = await rpc('goal.get', { courseId })
    check('the learner confirms the goal', goal?.goal?.status === 'confirmed' || goal?.doc?.goal?.status === 'confirmed')

    // Material, nodes, problems.
    const source = await rpc('library.import', { title: '合成验收资料', kind: 'textbook', authority: '1', file: join(CHAPTER, 'source.md'), parsed: [join(CHAPTER, 'middle.json')], courseId, role: 'skeleton' })
    check('the synthetic chapter is imported as the skeleton', Boolean(source?.id))
    await chat.locator('.la-thinking').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {})
    await tool('add_knowledge_nodes', { requestId: 'flow-1', nodes: [{ title: '静水压强计算', kind: 'skill' }] }, '节点')
    const added = await tool('add_problems', { problems: [10, 20, 30, 40].map((depth, index) => ({ stem: `（合成）水深 ${depth} m，求水面下的静水压强（ρ=1000 kg/m³，g=10 m/s²）。题 ${index + 1}`, answerKind: 'numeric', value: depth * 10000, unit: 'Pa', tier: 4, nodes: ['静水压强计算'], pool: 'practice' })) }, '已加入 4 道题')
    const problemIds = added.match(/pb_[0-9A-Z]{26}|\b[a-z]+_[0-9A-Z]{26}\b/g) ?? []
    check('the tool reports each problem\'s id', problemIds.length === 4, String(problemIds.length))

    // The diagnostic on the test page: saves held and failing, then the hand-in.
    await tool('start_test', { kind: 'diagnostic', problemIds: problemIds.slice(0, 2), instructions: '凭记忆作答，不算成绩' }, '')
    await app.nav('测试')
    const startTest = page.locator('.la-page[data-current]').getByRole('button', { name: '开始作答' }).first()
    await startTest.click()
    const cards = page.locator('.la-page[data-current] .la-problem')
    await cards.first().waitFor()
    const box = cards.nth(0).locator('input, textarea').first()
    const context = page.context()

    // Saves arrive in order: the first is held on the way, the second waits for it, and the last typed wins.
    const seen: string[] = []
    await context.route(/\/api\/learning\/assess\.draft/, async route => {
      seen.push(JSON.stringify(route.request().postDataJSON()?.payload?.draft ?? {}))
      if (seen.length === 1) await new Promise(done => setTimeout(done, 1500))
      await route.fallback()
    })
    await box.fill('11 Pa')
    await page.waitForTimeout(1200)
    await box.fill('100000 Pa')
    await page.waitForTimeout(3000)
    check('a problem\'s saves go one after another, the last typed last', seen.length >= 2 && seen.at(-1)!.includes('100000 Pa') && seen[0]!.includes('11 Pa'), `${seen.length} saves`)
    await context.unroute(/\/api\/learning\/assess\.draft/)

    // A save failing: it says so beside the problem, the input stays, hand-in is refused, retry recovers.
    await context.route(/\/api\/learning\/assess\.draft/, route => route.abort())
    const second = cards.nth(1).locator('input, textarea').first()
    await second.fill('200000 Pa')
    const failure = page.locator('.la-page[data-current]').getByText('这道题的作答没保存上')
    await until('a failed save says so beside the problem', failure.waitFor({ timeout: 10_000 }))
    check('the input stays', await second.inputValue() === '200000 Pa')
    await context.unroute(/\/api\/learning\/assess\.draft/)
    await page.locator('.la-page[data-current]').getByRole('button', { name: '重试' }).click()
    await until('retry saves it and the warning goes', failure.waitFor({ state: 'detached', timeout: 10_000 }))

    // After a reload the page shows what was saved, not an older version.
    await page.reload()
    await page.locator('.la-app').waitFor()
    await cards.first().waitFor()
    await page.waitForTimeout(500)
    check('a reload brings back the last saved answers', await cards.nth(0).locator('input, textarea').first().inputValue() === '100000 Pa' && await cards.nth(1).locator('input, textarea').first().inputValue() === '200000 Pa')

    await page.locator('.la-page[data-current]').getByRole('button', { name: '交卷' }).click()
    const confirm = page.getByRole('button', { name: /确认交卷|仍然交卷|确定/ }).first()
    if (await confirm.waitFor({ timeout: 1000 }).then(() => true, () => false)) await confirm.click()
    const tests = async () => (await rpc<{ test: any; correct: number }[]>('assess.tests', { courseId }))
    await until('the paper is handed in and graded', page.waitForFunction(() => document.querySelector('.la-page[data-current]')?.textContent?.includes('摸底') && !document.querySelector('.la-page[data-current] input:not([disabled])'), undefined, { timeout: 20_000 }))
    const diagnostic = (await tests()).find(row => row.test.kind === 'diagnostic')
    check('the rules grade it once: both right', diagnostic?.test.status === 'graded' && diagnostic.correct === 2, `${diagnostic?.test.status}, ${diagnostic?.correct} right`)

    // Roadmap, design, handout.
    await teacherOf(run, title)
    const roadmap = await tool('save_roadmap', { stages: [{ title: '静水压强', objective: '按资料参数独立计算静水压强' }] }, '路线已保存')
    const stageId = /\bst[a-z]*_[0-9A-Z]{26}\b/.exec(roadmap)?.[0] ?? ''
    check('the roadmap names its stage', stageId !== '', roadmap.slice(0, 120))
    const designed = await tool('save_stage_design', { stageId, markdown: '# 阶段设计\n\n## 验收\n\n能算静水压强。\n\n## 测试蓝图\n\n小测（合成）。\n\n## 课时\n\n1.1 静水压强。', lessons: [{ number: '1.1', title: '静水压强' }] }, '设计书已保存')
    const lessonId = /\b[a-z]+_[0-9A-Z]{26}(?= 1\.1)/.exec(designed)?.[0] ?? ''
    check('the design names its lesson', lessonId !== '', designed.slice(0, 160))
    await rpc('curriculum.confirmDesign', { stageId })
    const ready = async () => {
      for (let i = 0; i < 60; i++) {
        const statuses = await rpc<any>('textbook.statuses', { stageId })
        if (JSON.stringify(statuses).includes('"ready"')) return true
        await page.waitForTimeout(1000)
      }
      return false
    }
    check('confirming the design writes the handout', await ready())
    await app.nav('课程讲义')
    await until('the handout opens with the written section', page.locator('.la-page[data-current]').getByText('静水压强怎样按水深计算').first().waitFor({ timeout: 20_000 }))
    await app.shot('flow-handout')

    // A lesson: read, quiz, summary; then the planner asks for the stage test.
    await teacherOf(run, title)
    await tool('publish_task', { kind: 'read', title: '读 1.1', instructions: '读完本节', lessonId }, '已发布')
    const taskId = (await rpc<any>('curriculum.overview', { courseId })).tasks?.find((task: any) => task.title === '读 1.1')?.id
    if (taskId) await rpc('curriculum.completeTask', { taskId })
    check('the learner finishes the reading', Boolean(taskId))
    await chat.locator('.la-thinking').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {})
    await tool('start_test', { kind: 'quiz', lessonId, problemIds: problemIds.slice(2), instructions: '凭记忆作答' }, '')
    const quiz = (await tests()).find(row => row.test.kind === 'quiz')!.test
    await rpc('assess.submit', { testId: quiz.id, answers: quiz.problemIds.map((problemId: string) => ({ problemId, text: '300000 Pa' })) })
    const summary = await tool('write_lesson_summary', { lessonId, learnerReport: '我能按给定参数计算（合成）。', summary: '小测一对一错（合成）。' }, '课时记录已写好')
    check('the summary finishes the lesson', summary.includes('已记为完成'))
    const next = await rpc('planner.next', { courseId })
    check('the next step is the stage test', String(next.title).includes('阶段测试'), String(next.title))

    // Side chat, kept apart from the teacher.
    const teacherSession = await rpc('tutor.session', { courseId })
    await page.locator('.la-toggle', { hasText: '提问' }).click()
    const side = page.locator('.la-side')
    await side.locator('textarea').fill('水深加倍时会怎样？')
    await side.locator('textarea').press('Enter')
    await until('the side chat gets a reply', side.getByText('收到').first().waitFor({ timeout: 20_000 }))
    const active = await rpc('sidechat.active', { courseId })
    check('it is not the teacher\'s session', Boolean(active?.sessionId) && JSON.stringify(teacherSession).indexOf(active.sessionId) < 0)
    await side.getByText('结束并总结').click()
    await until('closing it writes its summary', side.getByText('结束并总结').waitFor({ state: 'detached', timeout: 20_000 }))
  },
}

/** Switching courses: nothing of one course shows under or is written to another. */
const courses: Scenario = {
  name: 'courses',
  async run(run) {
    const { page, check, until, rpc, enter } = run
    const A = await course(run, '甲课（合成）')
    const B = await course(run, '乙课（合成）')
    const context = page.context()
    const side = page.locator('.la-side')
    await enter('甲课')
    await page.locator('.la-toggle', { hasText: '提问' }).click()
    await side.locator('textarea').fill('甲课的问题：什么是压强？')
    await side.locator('textarea').press('Enter')
    await until('side chat in A opens and gets a reply', side.getByText('收到').first().waitFor({ timeout: 20_000 }))
    const activeA = await rpc('sidechat.active', { courseId: A.id })

    await context.route(/\/api\/learning\/sidechat\.active/, async route => {
      if (route.request().postDataJSON()?.payload?.courseId === B.id) await new Promise(done => setTimeout(done, 1500))
      await route.fallback()
    })
    await enter('乙课')
    check('switching to B: A\'s session is gone at once, while B loads', await side.getByText('结束并总结').count() === 0)
    await side.locator('textarea').waitFor({ timeout: 5000 })
    check('B shows an empty question box', await side.locator('textarea').inputValue() === '' && await side.getByText('结束并总结').count() === 0)
    await side.locator('textarea').fill('乙课还没发出去的问题')
    await context.unroute(/\/api\/learning\/sidechat\.active/)

    await enter('甲课')
    await until('back in A: its session is there', side.getByText('结束并总结').waitFor({ timeout: 8000 }))
    await context.route(/\/api\/learning\/sidechat\.active/, route => route.abort())
    await enter('乙课')
    await until('B failing to load offers a retry', side.getByRole('button', { name: '重试' }).waitFor({ timeout: 8000 }))
    check('and shows nothing of A', await side.getByText('结束并总结').count() === 0 && await side.getByText('甲课的问题').count() === 0)
    await context.unroute(/\/api\/learning\/sidechat\.active/)
    await side.getByRole('button', { name: '重试' }).click()
    await side.locator('textarea').waitFor({ timeout: 5000 })
    check('retry recovers, and B\'s unsent question is kept', await side.locator('textarea').inputValue() === '乙课还没发出去的问题')
    const refused = await rpc('sidechat.close', { sessionId: activeA.sessionId, courseId: B.id }).then(() => '', (error: Error) => error.message)
    check('closing A\'s session from B is refused', refused.includes('learning/sidechat/other-course'), refused.slice(0, 120))
    await page.locator('.la-toggle', { hasText: '提问' }).click()
  },
}

/** A background tab naming itself leaves the front tab alone. */
const titles: Scenario = {
  name: 'titles',
  async run(run) {
    const { page, check, rpc, enter } = run
    const B = await course(run, '乙课（合成）')
    const listed = await rpc<any>('library.sources', { courseId: B.id })
    if (!JSON.stringify(listed).includes('标题验收资料')) await rpc('library.import', { title: '标题验收资料', kind: 'textbook', authority: '1', file: join(CHAPTER, 'source.md'), parsed: [join(CHAPTER, 'middle.json')], courseId: B.id, role: 'skeleton' })
    await page.reload()
    await page.locator('.la-app').waitFor()
    await enter('乙课')
    await page.locator('.la-rail-btn[data-activity="library"]').click()
    await page.waitForTimeout(600)
    const context = page.context()
    await context.route(/\/api\/learning\/library\.document/, async route => { await new Promise(done => setTimeout(done, 1800)); await route.fallback() })
    await page.locator('.la-panel').getByText('标题验收资料').first().click({ modifiers: ['Control'] })
    await page.waitForTimeout(200)
    const tabs = page.locator('.dv-tab')
    const front = () => page.locator('.dv-tab.dv-active-tab .la-tab-title').first().innerText()
    await tabs.nth(0).click()
    await page.waitForTimeout(100)
    const shown = await front()
    await page.waitForTimeout(2600)
    const names = await tabs.locator('.la-tab-title').allInnerTexts()
    check('the front tab stays in front', await front() === shown && names.length >= 2, `front ${await front()}; tabs ${names.join(' | ')}`)
    await context.unroute(/\/api\/learning\/library\.document/)
  },
}

/** The feed breaking: the status bar says so, and the page catches up by itself when it is back. */
const feed: Scenario = {
  name: 'feed',
  async run(run) {
    const { env, page, check, until, rpc, enter, app, second } = run
    const A = await course(run, '甲课（合成）')
    await enter('甲课')
    await app.nav('知识模型')
    await page.waitForTimeout(800)
    const other = await second()
    const title = `断线期间加的节点${Date.now() % 10000}`
    env.cut(6000)
    await page.waitForTimeout(800)
    const off = await page.locator('.la-status').innerText()
    check('the status bar says the feed is broken', off.includes('推送断开'), off.replaceAll('\n', ' '))
    await rpc('knowledge.add', { courseId: A.id, input: { nodes: [{ title, kind: 'knowledge' }] } }, other)
    await page.waitForTimeout(1500)
    check('nothing shows the change while broken', await page.getByText(title).count() === 0)
    await until('after the feed came back, the page shows what changed, untouched', page.getByText(title).first().waitFor({ timeout: 25_000 }))
    await other.context().close()
  },
}

/** The chat stream breaking mid-reply, and DSH restarting. */
const chatBreak: Scenario = {
  name: 'chat-break',
  async run(run) {
    const { env, page, check, until, app } = run
    await course(run, '甲课（合成）')
    await teacherOf(run, '甲课（合成）')
    const chat = chatOf(run)
    await say(run, `慢慢说 ${Date.now() % 1000}`)
    await until('the reply streams', chat.getByText('第3句').first().waitFor({ timeout: 30_000 }))
    env.cut(2500)
    await until('a break says it is reconnecting beside the box', chat.locator('.la-composer-broken').waitFor({ timeout: 8000 }))
    await until('the hint goes once the stream is back', chat.locator('.la-composer-broken').waitFor({ state: 'detached', timeout: 25_000 }))
    await until('the reply carries on', chat.getByText('第40句').first().waitFor({ timeout: 30_000 }))
    await page.waitForTimeout(1500)
    const replies = await chat.locator('.la-msg.assistant').allInnerTexts()
    check('the reply is whole and once after the break', replies.filter(text => text.includes('第1句') && text.includes('第40句')).length === 1 && replies.filter(text => text.includes('第7句')).length === 1, `${replies.length} replies`)
    check('not left waiting', await chat.locator('.la-thinking').count() === 0)
    await say(run, '断线后再问一句')
    await until('the next message gets its reply', chat.getByText('收到：断线后再问一句').first().waitFor({ timeout: 15_000 }))

    const started = await chat.getByText('第2句').count()
    await say(run, `慢慢说，会重启 ${Date.now() % 1000}`)
    await until('another reply streams', page.waitForFunction(([count]) => document.querySelectorAll('.la-page[data-current] .la-chat .la-msg.assistant').length > 0 && (document.querySelector('.la-page[data-current] .la-chat')!.textContent!.match(/第2句/g)?.length ?? 0) > count!, [started], { timeout: 30_000 }))
    await env.kill()
    await until('DSH gone: the page says so', chat.locator('.la-composer-broken').waitFor({ timeout: 10_000 }))
    await env.start()
    await until('DSH back: the chat reconnects without a reload', chat.locator('.la-composer-broken').waitFor({ state: 'detached', timeout: 60_000 }))
    await page.waitForTimeout(1500)
    check('the reply cut off is not left waiting', await chat.locator('.la-thinking').count() === 0)
    // The turn cut off and this message go to the model together, so the fake model takes this one slowly too.
    await say(run, '重启后再问一句')
    await until('the next message gets its reply', page.waitForFunction(() => [...document.querySelectorAll('.la-page[data-current] .la-msg.assistant')].filter(el => el.textContent!.includes('第40句')).length === 2, undefined, { timeout: 30_000 }))
    await chat.locator('.la-thinking').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
    await say(run, '再问最后一句')
    await until('and the one after it', chat.getByText('收到：再问最后一句').first().waitFor({ timeout: 20_000 }))
    await app.shot('chat-after-restart')
  },
}

/** More than one page of messages: pages back in order, the view stays still, a failed page offers a retry. */
const longChat: Scenario = {
  name: 'long-chat',
  async run(run) {
    const { page, check, until } = run
    await course(run, '长聊课（合成）')
    await teacherOf(run, '长聊课（合成）')
    const chat = chatOf(run)
    const total = 55
    // The first turn carries the course brief and wakes the teacher again; the numbered turns start after that.
    await say(run, '开场')
    await page.waitForTimeout(1500)
    await chat.locator('.la-thinking').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {})
    for (let i = 1; i <= total; i++) {
      await say(run, `长会话第${i}条`)
      await chat.getByText(`收到：长会话第${i}条`).first().waitFor({ timeout: 20_000 })
      await chat.locator('.la-thinking').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    }
    await page.reload()
    await page.locator('.la-app').waitFor()
    const older = chat.locator('.la-chat-older button')
    await older.waitFor({ timeout: 15_000 })
    const context = page.context()
    await context.route(/\/api\/session\/page/, route => route.abort())
    await older.click()
    await until('a failed page says so and offers a retry', chat.getByText('没有加载出来，再试一次').waitFor({ timeout: 8000 }))
    await context.unroute(/\/api\/session\/page/)
    let pages = 0, jumped = 0
    while (await older.count() && pages < 8) {
      const before = await page.evaluate(() => {
        const list = document.querySelector('.la-page[data-current] .la-chat-scroll')!
        list.scrollTop = 0
        const anchor = list.querySelector('.la-msg.user')!
        ;(window as any).__anchor = anchor
        return anchor.getBoundingClientRect().top
      })
      const count = await chat.locator('.la-msg.user').count()
      await older.click()
      await page.waitForFunction(count => document.querySelectorAll('.la-page[data-current] .la-chat-scroll .la-msg.user').length > count, count, { timeout: 10_000 })
      await page.waitForTimeout(150)
      if (Math.abs(await page.evaluate(() => (window as any).__anchor.getBoundingClientRect().top) - before) > 3) jumped++
      pages++
    }
    const numbers = (await chat.locator('.la-msg.user').allInnerTexts()).filter(text => text.startsWith('长会话')).map(text => Number(/第(\d+)条/.exec(text)![1]))
    check('pages back to the first message, none twice', numbers[0] === 1 && new Set(numbers).size === total && numbers.length === total, `${pages} pages, ${numbers.length} messages`)
    check('the view stays put when older messages come in', jumped === 0, `${jumped} jumps`)
  },
}

/** Menus, the command palette and the sidebar's edge by keyboard. */
const keys: Scenario = {
  name: 'keys',
  async run(run) {
    const { page, check, enter } = run
    await course(run, '甲课（合成）')
    const focus = () => page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      return { tag: el?.tagName, role: el?.getAttribute('role'), label: (el?.getAttribute('aria-label') ?? el?.innerText ?? '').trim().slice(0, 30), active: el?.dataset.active, inPalette: Boolean(el?.closest('.la-palette')) }
    })
    await page.locator('.la-switcher').focus()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)
    let at = await focus()
    check('opening a menu moves the focus to its first item', at.role?.startsWith('menuitem') === true, JSON.stringify(at))
    const first = at.label
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(80)
    at = await focus()
    check('arrows move the real focus', at.role?.startsWith('menuitem') === true && at.label !== first && at.active === 'true', at.label)
    await page.keyboard.press('End')
    await page.waitForTimeout(80)
    check('End goes to the last', (await focus()).label.includes('新建课程'))
    await page.keyboard.press('Home')
    await page.waitForTimeout(80)
    check('Home goes to the first', (await focus()).label === first)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(100)
    at = await focus()
    check('Esc closes and gives the focus back', at.label.includes('切换课程') && await page.locator('.la-menu-list').count() === 0, JSON.stringify(at))

    await page.keyboard.press('Control+k')
    await page.waitForTimeout(150)
    at = await focus()
    check('Ctrl K puts the focus in the search box', at.tag === 'INPUT' && at.inPalette)
    const described = () => page.locator('.la-palette input').getAttribute('aria-activedescendant')
    const option = await described()
    check('the box points at an option that exists', await page.evaluate(id => Boolean(document.getElementById(id!)), option))
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(60)
    check('arrows move what it points at', await described() !== option)
    for (const key of ['Tab', 'Tab', 'Shift+Tab']) await page.keyboard.press(key)
    check('Tab stays in the panel', (await focus()).inPalette)
    check('the rest of the page is out of reach', await page.evaluate(() => [...document.querySelector('.la-app')!.children].filter(child => !child.classList.contains('la-palette-scrim')).every(child => child.hasAttribute('inert'))))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(120)
    at = await focus()
    check('Esc closes it and the focus is back where it was', await page.locator('.la-palette').count() === 0 && at.label.includes('切换课程'), JSON.stringify(at))
    check('the page is reachable again', await page.evaluate(() => [...document.querySelector('.la-app')!.children].every(child => !child.hasAttribute('inert'))))

    await enter('甲课（合成）')
    const edge = page.locator('.la-panel .la-resize')
    if (!await edge.count()) await page.locator('.la-unfold').click()
    await edge.focus()
    const value = () => edge.getAttribute('aria-valuenow').then(Number)
    const start = await value()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(100)
    check('the right arrow widens the sidebar a step', await value() === start + 16, `${start} → ${await value()}`)
    await page.keyboard.press('Home')
    await page.waitForTimeout(100)
    check('Home goes to the narrowest', await value() === 200)
    await page.keyboard.press('End')
    await page.waitForTimeout(100)
    check('End goes to the widest', await value() === 420)
  },
}

/** DSH killed just after a message went out, before the model answered: the chat must not stay stuck. */
const killEarly: Scenario = {
  name: 'kill-early',
  async run(run) {
    const { env, page, check, until } = run
    await course(run, '重启课（合成）')
    await teacherOf(run, '重启课（合成）')
    const chat = chatOf(run)
    await say(run, '开场')
    await page.waitForTimeout(1500)
    await chat.locator('.la-thinking').waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {})
    await say(run, '这一句发出去就重启')
    await env.kill()
    await env.start()
    await until('DSH back: the chat reconnects', chat.locator('.la-composer-broken').waitFor({ state: 'detached', timeout: 60_000 }))
    await page.waitForTimeout(3000)
    check('nothing is left waiting', await chat.locator('.la-thinking').count() === 0, (await chat.innerText()).replaceAll('\n', ' ').slice(-200))
    await say(run, '重启后再问一句')
    // When the first message did reach DSH the two are answered together, so the fake model's words run into each other.
    await until('the next message gets its reply', chat.locator('.la-msg.assistant', { hasText: '再问一句' }).first().waitFor({ timeout: 20_000 }))
  },
}

export const SCENARIOS: readonly Scenario[] = [smoke, flow, courses, titles, feed, keys, longChat, chatBreak, killEarly]
