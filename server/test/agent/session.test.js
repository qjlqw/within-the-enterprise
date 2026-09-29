import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SessionStore } from '../../src/agent/sessionStore.js'
import { config } from '../../src/config/index.js'
import { createMemorySessionPersist } from '../../src/agent/sessionPersist.js'

test('ownership, duplicate IDs, per-user concurrency and cancellation cleanup', async () => {
  const store = new SessionStore(config.agent, Date.now, createMemorySessionPersist())
  const session = await store.create(1)
  for (const action of [() => store.get(2, session.sessionId), () => store.remove(2, session.sessionId)])
    await assert.rejects(action, { status: 404 })
  const clientId = randomUUID()
  const run = store.begin(session, '入职', clientId)
  // 同一用户已有一轮运行中，即使换会话也会被单并发拦截
  const other = await store.create(1)
  assert.throws(() => store.begin(other, '问题', randomUUID()), { status: 409 })
  run.turn.assistant.status = 'cancelled'
  await store.finish(session, run)
  assert.throws(() => store.begin(session, '入职', clientId), { status: 409 })
  assert.deepEqual((await store.history(session)).messages, [])
  const next = store.begin(session, '再次提问', randomUUID())
  await store.remove(1, session.sessionId)
  assert.equal(next.controller.signal.aborted, true)
  await store.finish(session, next)
  assert.equal(store.running.size, 0)
})

test('expired sessions, per-user capacity, total capacity and rate windows are bounded', async () => {
  let now = 0
  const store = new SessionStore({ ...config.agent, maxSessions: 21, sessionTtlMs: 1000 }, () => now, createMemorySessionPersist())
  for (let i = 0; i < 20; i++) await store.create(1)
  await assert.rejects(() => store.create(1), { status: 429 })
  await store.create(2)
  await assert.rejects(() => store.create(3), { status: 503 })
  now = 1001
  store.cleanup()
  assert.equal(store.sessions.size, 0)
  const session = await store.create(1)
  for (let i = 0; i < 10; i++) { const run = store.begin(session, '问题', randomUUID()); await store.finish(session, run) }
  assert.throws(() => store.begin(session, '问题', randomUUID()), { status: 429 })
  now += 60001
  assert.doesNotThrow(() => store.begin(session, '问题', randomUUID()))
})

test('withdrawn and changed evidence clears display, title and model history including incomplete output', async () => {
  let valid = true
  const store = new SessionStore(config.agent, Date.now, createMemorySessionPersist(), async () => valid)
  const session = await store.create(1)
  const run = store.begin(session, '入职准备', randomUUID())
  run.turn.evidence = [{ documentId: 4, sourceId: 'S1' }]
  run.turn.assistant.content = '准备入职材料 [S1]'
  run.turn.assistant.status = 'completed'
  await store.finish(session, run)
  assert.equal((await store.history(session)).messages.length, 2)
  valid = false
  const view = await store.view(await store.get(1, session.sessionId))
  assert.deepEqual(view.messages, [])
  assert.equal(view.title, '新会话')
  assert.match(view.notice, /资料已变更/)
  assert.deepEqual((await store.history(session)).messages, [])
})
