export interface AgentSource {
  sourceId: string
  documentId: number
  title: string
  version: number
  offset: number
  text: string
  url: string
}

export type MessageStatus = 'running' | 'completed' | 'cancelled' | 'failed'
export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
  sources: AgentSource[]
  error?: string
  reasoning?: string
}

export interface SessionSummary {
  sessionId: string
  title: string
  createdAt: number
  updatedAt: number
  running: boolean
}

export interface AgentSession extends SessionSummary {
  notice: string | null
  messages: AgentMessage[]
  run: { runId: string; messageId: string } | null
}

export type AgentEvent =
  | { type: 'start'; runId: string; sessionId: string; messageId: string }
  | { type: 'tool_start' | 'tool_end'; toolCallId: string; name: string; status?: string }
  | { type: 'token'; messageId: string; delta: string }
  | { type: 'reasoning'; messageId: string; delta: string }
  | { type: 'sources'; items: AgentSource[] }
  | {
      type: 'done'
      runId: string
      status: 'completed' | 'cancelled'
      /** P0-2 guardrail 拦截时携带降级话术，用于覆写已流式下发的原文 */
      content?: string
      guardrail?: { action: 'blocked' | 'warn'; citation: string; toolCheck: string; hasToolResult: boolean; hasCitation: boolean }
    }
  | { type: 'error'; runId: string; code: string; message: string }
