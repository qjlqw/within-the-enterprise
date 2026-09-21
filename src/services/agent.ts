import request from './request'
import { useUserStore } from '@/store/userStore'
import { consumeAgentStream } from './agentStream'
import type { AgentEvent, AgentSession, SessionSummary } from '@/types/agent'

export const agentApi = {
  list: () => request.get<{ list: SessionSummary[]; total: number }>('/agent/sessions'),
  create: () => request.post<AgentSession>('/agent/sessions'),
  get: (id: string) => request.get<AgentSession>(`/agent/sessions/${id}`),
  remove: (id: string) => request.delete(`/agent/sessions/${id}`),
  cancel: (id: string, runId: string) => request.post(`/agent/sessions/${id}/cancel`, { runId }),
}

export async function sendAgentMessage(sessionId: string, message: string, clientMessageId: string,
  signal: AbortSignal, onEvent: (event: AgentEvent) => void) {
  const token = useUserStore.getState().token
  const response = await fetch(`${(import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/$/, '')}/agent/sessions/${sessionId}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}` },
    body: JSON.stringify({ message, clientMessageId }), signal,
  })
  if (response.status === 401) {
    if (useUserStore.getState().token === token) useUserStore.getState().logout()
    throw new Error('登录已过期，请重新登录')
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.message || '发送失败，请稍后重试')
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('服务器未返回有效的流式响应')
  await consumeAgentStream(response.body, onEvent)
}
