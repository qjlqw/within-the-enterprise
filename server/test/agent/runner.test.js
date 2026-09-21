import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { ChatOpenAI } from '@langchain/openai'
import { initDb } from '../../src/db/index.js'
import { config } from '../../src/config/index.js'
import { buildAgent, runAgent } from '../../src/agent/index.js'

beforeEach(initDb)
async function provider(t, { answer = '准备入职材料，领取设备，开通账号 [S2]', failFirst = false, stall = false } = {}) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    if (failFirst && requests.length === 1) { res.writeHead(429); res.end('{"error":{"message":"busy"}}'); return }
    if (stall) return
    const toolResults = body.messages.filter((message) => message.role === 'tool')
    const call = toolResults.length === 0 ? { name: 'search_documents', arguments: JSON.stringify({ query: '入职' }) }
      : toolResults.length === 1 ? { name: 'read_document', arguments: JSON.stringify({ documentId: 4 }) } : null
    const result = call ? { content: '', tool_calls: [{ id: `call${toolResults.length}`, type: 'function', function: call }] }
      : { content: answer }
    if (!body.stream) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ id: 'test', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', ...result }, finish_reason: call ? 'tool_calls' : 'stop' }] }))
      return
    }
    res.setHeader('Content-Type', 'text/event-stream')
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `model${requests.length}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    if (call) send({ role: 'assistant', tool_calls: [{ index: 0, ...result.tool_calls[0] }] })
    else {
      send({ role: 'assistant', reasoning_content: 'private internal reasoning' })
      for (const char of answer) send({ content: char })
    }
    send({}, call ? 'tool_calls' : 'stop')
    res.end('data: [DONE]\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const model = new ChatOpenAI({ model: 'qwen-test', apiKey: 'local-test', maxRetries: 0, streaming: true,
    configuration: { baseURL: `http://127.0.0.1:${server.address().port}/v1` } })
  return { model, requests }
}
const args = () => ({ userId: 1, history: { messages: [], sources: [] }, signal: new AbortController().signal })
test('installed createAgent invoke executes structured search, read and sourced answer', async (t) => {
  const { model, requests } = await provider(t)
  const { agent } = buildAgent({ ...args(), model })
  const result = await agent.invoke({ messages: [{ role: 'user', content: '入职需要做什么' }] })
  assert.match(result.messages.at(-1).content, /\[S2\]/)
  assert.equal(requests.length, 3)
  assert.equal(requests[0].tools.length, 2)
  assert.match(requests[2].messages.find((item) => item.role === 'tool').content, /新员工入职指南/)
})
test('adapter streaming emits public Chinese tokens and validated sources, not reasoning or tool payloads', async (t) => {
  const { model } = await provider(t)
  const events = []
  const result = await runAgent({ ...args(), model, message: '入职准备', emit: (type, data) => events.push({ type, ...data }) })
  assert.equal(result.sources[0].documentId, 4)
  assert.equal(result.usage.toolCalls, 2)
  assert.equal(result.usage.modelCalls, 3)
  assert.equal(events.filter((event) => event.type === 'token').map((event) => event.delta).join(''), result.text)
  assert.equal(JSON.stringify(events).includes('private internal'), false)
  assert.equal(events.filter((event) => event.type === 'tool_start').length, 2)
})
test('unknown citations fail final validation', async (t) => {
  const { model } = await provider(t, { answer: '错误引用 [S999]' })
  await assert.rejects(runAgent({ ...args(), model, message: '入职' }), { code: 'INVALID_SOURCE' })
})
test('model budget and output length are enforced', async (t) => {
  const { model } = await provider(t)
  await assert.rejects(runAgent({ ...args(), model, message: '入职', options: { ...config.agent, maxModelCalls: 1 } }), /模型调用已达上限/)
  const second = await provider(t)
  await assert.rejects(runAgent({ ...args(), model: second.model, message: '入职', options: { ...config.agent, maxOutputChars: 2 } }), /回答长度已达上限/)
})
test('one transient retry counts against model budget', async (t) => {
  const { model } = await provider(t, { failFirst: true })
  const result = await runAgent({ ...args(), model, message: '入职' })
  assert.equal(result.usage.modelCalls, 4)
})
test('AbortSignal cancels a stalled model request', async (t) => {
  const { model } = await provider(t, { stall: true })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 150)
  t.after(() => clearTimeout(timer))
  await assert.rejects(runAgent({ ...args(), model, signal: controller.signal, message: '入职' }))
})
