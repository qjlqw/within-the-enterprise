import { createParser } from 'eventsource-parser'
import type { AgentEvent } from '../types/agent'

export async function consumeAgentStream(body: ReadableStream<Uint8Array>, onEvent: (event: AgentEvent) => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let terminal = false
  const parser = createParser({
    onEvent: ({ event, data }) => {
      if (terminal || !event) return
      if (!['start', 'tool_start', 'tool_end', 'token', 'sources', 'done', 'error'].includes(event)) return
      const payload: unknown = JSON.parse(data)
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('流式响应格式无效')
      const item = payload as Record<string, unknown>
      if (event === 'token' && (typeof item.delta !== 'string' || typeof item.messageId !== 'string')) throw new Error('正文事件无效')
      if (event === 'done' && !['completed', 'cancelled'].includes(String(item.status))) throw new Error('结束事件无效')
      if (event === 'sources' && !Array.isArray(item.items)) throw new Error('引用事件无效')
      if (event === 'error' && typeof item.message !== 'string') throw new Error('错误事件无效')
      if (event === 'start' && (typeof item.runId !== 'string' || typeof item.messageId !== 'string')) throw new Error('开始事件无效')
      terminal = event === 'done' || event === 'error'
      onEvent({ ...item, type: event } as AgentEvent)
    },
    onError: () => { throw new Error('流式响应格式无效') },
  })
  try {
    while (!terminal) {
      const { value, done } = await reader.read()
      if (done) { parser.feed(decoder.decode()); break }
      parser.feed(decoder.decode(value, { stream: true }))
    }
    if (!terminal) throw new Error('连接中断，回答尚未完成')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
