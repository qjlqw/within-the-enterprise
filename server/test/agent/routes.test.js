import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import express from 'express'
import { initDb, findUserById } from '../../src/db/index.js'
import { signToken } from '../../src/middleware/auth.js'
import { errorHandler } from '../../src/middleware/error.js'
import { createAgentRouter } from '../../src/routes/agent.js'
import { SessionStore } from '../../src/agent/sessionStore.js'
import { config } from '../../src/config/index.js'
import { AgentError } from '../../src/agent/events.js'

beforeEach(initDb)
async function setup(t, settings = {}) {
  const store = new SessionStore()
  const app = express()
  app.use(express.json())
  app.use('/agent', createAgentRouter({ store, checkConfig: () => {}, options: { ...config.agent, timeoutMs: 500 },
    runner: async ({ message, signal, emit }) => {
      if (message === 'hold') await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      if (message === 'fail') throw new AgentError('MODEL_ERROR', '模型服务暂时不可用')
      emit('token', { delta: '暂无相关资料' })
      return { text: '暂无相关资料', sources: [], evidence: [], usage: {} }
    }, ...settings }))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const call = (path, { userId = 1, body, method = body ? 'POST' : 'GET', ...rest } = {}) => fetch(`http://127.0.0.1:${server.address().port}/agent${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(userId ? { Authorization: `Bearer ${signToken(findUserById(userId))}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), ...rest,
  })
  const create = async () => (await (await call('/sessions', { body: {} })).json()).data.sessionId
  return { call, create, store }
}
test('all routes authenticate and cross-user access consistently returns 404', async (t) => {
  const { call, create } = await setup(t)
  assert.equal((await call('/sessions', { userId: null })).status, 401)
  const id = await create()
  for (const [method, suffix, body] of [['GET', '', undefined], ['DELETE', '', undefined],
    ['POST', '/cancel', { runId: randomUUID() }], ['POST', '/messages', { message: '入职', clientMessageId: randomUUID() }]]) {
    assert.equal((await call(`/sessions/${id}${suffix}`, { method, body, userId: 2 })).status, 404)
  }
})
test('SSE sends one terminal event and duplicates cannot execute again', async (t) => {
  const { call, create, store } = await setup(t)
  const id = await create()
  const body = { message: '入职', clientMessageId: randomUUID() }
  const response = await call(`/sessions/${id}/messages`, { body })
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const text = await response.text()
  assert.match(text, /event: start/)
  assert.match(text, /event: token/)
  assert.equal((text.match(/event: done/g) || []).length, 1)
  assert.equal((await call(`/sessions/${id}/messages`, { body })).status, 409)
  assert.equal(store.running.size, 0)
  assert.equal(store.get(1, id).turns[0].assistant.status, 'completed')
})
test('JSON validation and missing configuration happen before opening the stream', async (t) => {
  const { call, create } = await setup(t)
  const id = await create()
  for (const body of [{ message: 'a'.repeat(4001), clientMessageId: randomUUID() },
    { message: '入职', clientMessageId: randomUUID(), userId: 2 }, { message: '入职', clientMessageId: 'bad' }]) {
    assert.equal((await call(`/sessions/${id}/messages`, { body })).status, 400)
  }
  const { assertModelConfigured } = await import('../../src/agent/model.js')
  const disabled = await setup(t, { checkConfig: assertModelConfigured, options: { ...config.agent, enabled: false } })
  const disabledId = await disabled.create()
  assert.equal((await disabled.call(`/sessions/${disabledId}/messages`, { body: { message: '入职', clientMessageId: randomUUID() } })).status, 503)
})
test('timeout, cancel, concurrent sends and reconnect recover without holding a user lock', async (t) => {
  const { call, create, store } = await setup(t)
  const id = await create()
  const pending = await call(`/sessions/${id}/messages`, { body: { message: 'hold', clientMessageId: randomUUID() } })
  assert.equal((await call(`/sessions/${id}/messages`, { body: { message: '入职', clientMessageId: randomUUID() } })).status, 409)
  const runId = store.get(1, id).run.runId
  await call(`/sessions/${id}/cancel`, { body: { runId } })
  assert.match(await pending.text(), /"status":"cancelled"/)
  assert.equal(store.running.size, 0)
  assert.equal((await call(`/sessions/${id}/cancel`, { body: { runId } })).status, 200)
  const timeout = await call(`/sessions/${id}/messages`, { body: { message: 'hold', clientMessageId: randomUUID() } })
  assert.match(await timeout.text(), /"code":"TIMEOUT"/)
  assert.equal(store.running.size, 0)
  const failed = await call(`/sessions/${id}/messages`, { body: { message: 'fail', clientMessageId: randomUUID() } })
  assert.match(await failed.text(), /event: error/)
  assert.equal(store.history(store.get(1, id)).messages.length, 0)
})
