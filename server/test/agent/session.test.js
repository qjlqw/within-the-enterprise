import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { SessionStore } from '../../src/agent/sessionStore.js'
import { config } from '../../src/config/index.js'
import { initDb, findDocument } from '../../src/db/index.js'
import { readDocument } from '../../src/services/knowledgeService.js'

beforeEach(initDb)
test('ownership, duplicate IDs, per-user concurrency and cancellation cleanup', () => {
  const store = new SessionStore()
  const session = store.create(1)
  for (const action of [() => store.get(2, session.sessionId), () => store.remove(2, session.sessionId)]) assert.throws(action, { status: 404 })
  const clientId = randomUUID()
  const run = store.begin(session, '入职', clientId)
  assert.throws(() => store.begin(store.create(1), '问题', randomUUID()), { status: 409 })
  run.turn.assistant.status = 'cancelled'
  store.finish(session, run)
  assert.throws(() => store.begin(session, '入职', clientId), { status: 409 })
  assert.deepEqual(store.history(session).messages, [])
  const next = store.begin(session, '再次提问', randomUUID())
  store.remove(1, session.sessionId)
  assert.equal(next.controller.signal.aborted, true)
  store.finish(session, next)
  assert.equal(store.running.size, 0)
})
test('expired sessions, per-user capacity, total capacity and rate windows are bounded', () => {
  let now = 0
  const store = new SessionStore({ ...config.agent, maxSessions: 21, sessionTtlMs: 1000 }, () => now)
  for (let i = 0; i < 20; i++) store.create(1)
  assert.throws(() => store.create(1), { status: 429 })
  store.create(2)
  assert.throws(() => store.create(3), { status: 503 })
  now = 1001
  store.cleanup()
  assert.equal(store.sessions.size, 0)
  const session = store.create(1)
  for (let i = 0; i < 10; i++) { const run = store.begin(session, '问题', randomUUID()); store.finish(session, run) }
  assert.throws(() => store.begin(session, '问题', randomUUID()), { status: 429 })
  now += 60001
  assert.doesNotThrow(() => store.begin(session, '问题', randomUUID()))
})
test('withdrawn and changed evidence clears display, title and model history including incomplete output', () => {
  const store = new SessionStore()
  const session = store.create(1)
  const run = store.begin(session, '入职准备', randomUUID())
  run.turn.evidence = [{ ...readDocument({ documentId: 4 }), sourceId: 'S1' }]
  run.turn.assistant.content = '准备入职材料 [S1]'
  run.turn.assistant.status = 'completed'
  store.finish(session, run)
  assert.equal(store.history(session).messages.length, 2)
  findDocument(4).status = 'draft'
  const view = store.view(store.get(1, session.sessionId))
  assert.deepEqual(view.messages, [])
  assert.equal(view.title, '新会话')
  assert.match(view.notice, /资料已变更/)
  assert.deepEqual(store.history(session).messages, [])
})
