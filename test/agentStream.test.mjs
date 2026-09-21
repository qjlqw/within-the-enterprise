import { test } from 'node:test'
import assert from 'node:assert/strict'
import { consumeAgentStream } from '../src/services/agentStream.ts'

const stream = (bytes, chunkSize) => new ReadableStream({ start(controller) {
  for (let index = 0; index < bytes.length; index += chunkSize) controller.enqueue(bytes.slice(index, index + chunkSize))
  controller.close()
} })
test('SSE handles Chinese split bytes, CRLF, comments, partial and multiple events', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\n\r\nevent: token\r\ndata: {"messageId":"1","delta":"中文答案"}\r\n\r\nevent: done\r\ndata: {"runId":"1","status":"completed"}\r\n\r\n')
  for (const size of [1, 2, 7, bytes.length]) {
    const events = []
    await consumeAgentStream(stream(bytes, size), (event) => events.push(event))
    assert.equal(events.length, 2)
    assert.equal(events[0].delta, '中文答案')
    assert.equal(events[1].status, 'completed')
  }
})
test('error is a terminal event while incomplete EOF and malformed payload fail', async () => {
  const encode = (text) => stream(new TextEncoder().encode(text), 3)
  const events = []
  await consumeAgentStream(encode('event: error\ndata: {"code":"MODEL_ERROR","message":"失败"}\n\n'), (event) => events.push(event))
  assert.equal(events[0].type, 'error')
  await assert.rejects(consumeAgentStream(encode('event: token\ndata: {"messageId":"1","delta":"片段"}\n\n'), () => {}), /连接中断/)
  await assert.rejects(consumeAgentStream(encode('event: done\ndata: {"status":"unknown"}\n\n'), () => {}), /结束事件无效/)
  await assert.rejects(consumeAgentStream(encode('event: token\ndata: not-json\n\n'), () => {}))
})
