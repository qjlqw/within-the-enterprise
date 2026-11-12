/**
 * P0-2 强制引用 + 工具联合判定（防绕过）单测
 *
 * 覆盖三种处置路径：
 * - enforce：零引用 / 零工具回答被拦截并降级为「资料不足」话术
 * - warn：放行但返回 guardrail 标记（供误杀率统计）
 * - off：整体关闭，无 guardrail 字段
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { ChatOpenAI } from '@langchain/openai'
import { initDb } from '../../src/db/index.js'
import { config } from '../../src/config/index.js'
import { runAgent } from '../../src/agent/index.js'

beforeEach(initDb)

const CITED_ANSWER = '准备入职材料，领取设备，开通账号 [S2]'
const UNCITED_ANSWER = '准备入职材料，领取设备，开通账号。'

/**
 * 本地 mock 模型服务（复用 runner.test.js 的写法，支持两种违规样本）：
 * - noCitation：正常调用工具，但最终回答不带任何 [Sx] 引用
 * - noTool：完全不调用工具，直接输出无引用回答（跳过工具的事实类回答）
 */
async function provider(t, { noTool = false, noCitation = false } = {}) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    const toolResults = body.messages.filter((message) => message.role === 'tool')
    const call = !noTool && toolResults.length === 0
      ? { name: 'search_documents', arguments: JSON.stringify({ query: '新员工入职' }) }
      : !noTool && toolResults.length === 1
        ? { name: 'read_document', arguments: JSON.stringify({ documentId: 4 }) }
        : null
    const answer = noCitation || noTool ? UNCITED_ANSWER : CITED_ANSWER
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
      // 首个 chunk 带 role，与真实 OpenAI 流式协议及 runner.test.js 的 mock 对齐
      send({ role: 'assistant', content: '' })
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
  return { model }
}

const args = () => ({ userId: 1, history: { messages: [], sources: [] }, signal: new AbortController().signal })
const enforceOptions = () => ({ ...config.agent, enforceCitation: 'enforce', enforceToolCheck: 'on' })

test('enforce 模式拦截零引用回答并降级为资料不足话术', async (t) => {
  const { model } = await provider(t, { noCitation: true })
  const result = await runAgent({ ...args(), model, message: '入职准备', options: enforceOptions() })
  assert.equal(result.guardrail.action, 'blocked')
  assert.equal(result.guardrail.hasToolResult, true)
  assert.equal(result.guardrail.hasCitation, false)
  assert.match(result.text, /无法给出有依据的回答/)
  assert.deepEqual(result.sources, [])
})

test('enforce 模式拦截跳过工具的零引用回答（工具条件触发）', async (t) => {
  const { model } = await provider(t, { noTool: true })
  const result = await runAgent({ ...args(), model, message: '入职准备', options: enforceOptions() })
  assert.equal(result.guardrail.action, 'blocked')
  assert.equal(result.guardrail.hasToolResult, false)
  assert.match(result.text, /无法给出有依据的回答/)
})

test('warn 模式放行违规回答但返回 guardrail 标记（误杀率统计用）', async (t) => {
  const { model } = await provider(t, { noCitation: true })
  const result = await runAgent({ ...args(), model, message: '入职准备',
    options: { ...config.agent, enforceCitation: 'warn', enforceToolCheck: 'on' } })
  assert.equal(result.guardrail.action, 'warn')
  assert.equal(result.guardrail.hasCitation, false)
  // 放行：原文返回，引用为空
  assert.equal(result.text, UNCITED_ANSWER)
  assert.deepEqual(result.sources, [])
})

test('off 模式整体关闭，不返回 guardrail 字段', async (t) => {
  const { model } = await provider(t, { noCitation: true })
  const result = await runAgent({ ...args(), model, message: '入职准备',
    options: { ...config.agent, enforceCitation: 'off', enforceToolCheck: 'off' } })
  assert.equal(result.guardrail, undefined)
  assert.equal(result.text, UNCITED_ANSWER)
})

test('合规回答（有工具结果且有引用）在任何模式下不受影响', async (t) => {
  const { model } = await provider(t)
  const result = await runAgent({ ...args(), model, message: '入职准备',
    options: { ...config.agent, enforceCitation: 'enforce', enforceToolCheck: 'on' } })
  assert.equal(result.guardrail, undefined)
  assert.match(result.text, /\[S2\]/)
  assert.equal(result.sources[0].documentId, 4)
})
