import { useCallback, useEffect, useRef, useState } from 'react'
import { isAxiosError } from 'axios'
import { agentApi, sendAgentMessage } from '@/services/agent'
import { useUserStore } from '@/store/userStore'
import type { AgentMessage, AgentSession, SessionSummary } from '@/types/agent'

const errorText = (error: unknown) => isAxiosError(error) && error.response?.data?.message
  ? String(error.response.data.message) : error instanceof Error ? error.message : '请求失败，请稍后重试'

export function useAgentChat() {
  const token = useUserStore((state) => state.token)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [session, setSession] = useState<AgentSession | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activity, setActivity] = useState('')
  const epoch = useRef(0)
  const operation = useRef(false)
  const active = useRef<{ sessionId: string; runId?: string; controller: AbortController } | null>(null)
  const alive = useCallback((id: number) => epoch.current === id && useUserStore.getState().token === token, [token])

  useEffect(() => {
    const id = ++epoch.current
    setSessions([]); setSession(null); setError(''); setLoading(true); setBusy(false)
    operation.current = false
    if (token) {
      void agentApi.list().then(async (data) => {
        if (!alive(id)) return
        setSessions(data.list)
        if (data.list[0]) {
          const detail = await agentApi.get(data.list[0].sessionId)
          if (alive(id)) setSession(detail)
        }
      }).catch((err: unknown) => { if (alive(id)) setError(errorText(err)) })
        .finally(() => { if (alive(id)) setLoading(false) })
    } else setLoading(false)
    const unsubscribe = useUserStore.subscribe((state) => {
      if (state.token !== token) {
        epoch.current++
        active.current?.controller.abort()
        active.current = null
        setSessions([]); setSession(null); setBusy(false); setError('')
      }
    })
    return () => { epoch.current++; unsubscribe(); active.current?.controller.abort(); active.current = null }
  }, [token, alive])

  useEffect(() => {
    if (!session?.run || busy) return
    const id = epoch.current
    const timer = window.setTimeout(() => {
      void agentApi.get(session.sessionId).then((detail) => {
        if (alive(id)) setSession((current) => current?.sessionId === detail.sessionId ? detail : current)
      }).catch((err: unknown) => { if (alive(id)) setError(errorText(err)) })
    }, 1200)
    return () => window.clearTimeout(timer)
  }, [session, busy, alive])

  const refreshList = async (id: number) => {
    const data = await agentApi.list()
    if (alive(id)) setSessions(data.list)
  }

  const select = async (sessionId?: string) => {
    if (operation.current || busy) return
    operation.current = true
    const id = epoch.current
    setLoading(true); setError('')
    try {
      const detail = sessionId ? await agentApi.get(sessionId) : await agentApi.create()
      if (alive(id)) { setSession(detail); await refreshList(id) }
    } catch (err) { if (alive(id)) setError(errorText(err)) }
    finally { if (alive(id)) { operation.current = false; setLoading(false) } }
  }

  const remove = async (sessionId: string) => {
    if (operation.current || busy) return
    operation.current = true
    const id = epoch.current
    setLoading(true)
    try {
      await agentApi.remove(sessionId)
      if (!alive(id)) return
      if (session?.sessionId === sessionId) setSession(null)
      await refreshList(id)
    } catch (err) { if (alive(id)) setError(errorText(err)) }
    finally { if (alive(id)) { operation.current = false; setLoading(false) } }
  }

  const send = async (message: string) => {
    if (!message.trim() || message.trim().length > 4000 || operation.current || busy || session?.run) return false
    operation.current = true
    const id = epoch.current
    const controller = new AbortController()
    active.current = { sessionId: session?.sessionId || '', controller }
    setBusy(true); setError(''); setActivity('正在提交')
    let current = session
    let accepted = false
    try {
      if (!current) current = await agentApi.create()
      if (!alive(id)) return false
      // Recover server state before every new submission, including retries after a broken stream.
      current = await agentApi.get(current.sessionId)
      controller.signal.throwIfAborted()
      if (!alive(id)) return false
      setSession(current)
      if (current.run) throw new Error('已有回答正在生成，请先停止')
      const assistant: AgentMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', status: 'running', sources: [] }
      setSession({ ...current, messages: [...current.messages,
        { id: crypto.randomUUID(), role: 'user', content: message.trim(), status: 'completed', sources: [] }, assistant] })
      const running = { sessionId: current.sessionId, controller, runId: undefined as string | undefined }
      active.current = running
      await sendAgentMessage(current.sessionId, message.trim(), crypto.randomUUID(), controller.signal, (event) => {
        if (!alive(id)) return
        if (event.type === 'start') { accepted = true; running.runId = event.runId; setActivity('正在生成') }
        if (event.type === 'tool_start') setActivity(event.name === 'search_documents' ? '正在检索文档' : '正在读取文档')
        if (event.type === 'tool_end' || event.type === 'token') setActivity('正在生成')
        if (event.type === 'error') setError(event.message)
        setSession((previous) => {
          if (!previous || previous.sessionId !== running.sessionId) return previous
          const messages = previous.messages.map((item, index) => {
            if (index !== previous.messages.length - 1) return item
            if (event.type === 'start') return { ...item, id: event.messageId }
            if (event.type === 'token') return { ...item, content: item.content + event.delta }
            if (event.type === 'sources') return { ...item, sources: event.items }
            if (event.type === 'done') return { ...item, status: event.status }
            if (event.type === 'error') return { ...item, status: 'failed' as const, error: event.message }
            return item
          })
          return { ...previous, messages }
        })
      })
    } catch (err) {
      if (alive(id)) {
        if (!controller.signal.aborted) setError(errorText(err))
        setSession((previous) => previous ? { ...previous, messages: previous.messages.map((item) => item.status === 'running'
          ? { ...item, status: controller.signal.aborted ? 'cancelled' : 'failed', sources: [] } : item) } : previous)
      }
    } finally {
      if (alive(id)) {
        active.current = null
        if (current) {
          try {
            const detail = await agentApi.get(current.sessionId)
            if (alive(id)) setSession(detail)
          } catch { /* Keep the interrupted draft visible until the server is reachable. */ }
        }
        if (alive(id)) {
          operation.current = false; setBusy(false); setActivity('')
          void refreshList(id).catch(() => {})
        }
      }
    }
    return accepted
  }

  const stop = async () => {
    const running = active.current
    const sessionId = running?.sessionId || session?.sessionId
    const runId = running?.runId || session?.run?.runId
    const id = epoch.current
    running?.controller.abort()
    if (sessionId && runId) {
      try {
        await agentApi.cancel(sessionId, runId)
        const detail = await agentApi.get(sessionId)
        if (alive(id)) setSession(detail)
      } catch (err) { if (alive(id)) setError(errorText(err)) }
    }
  }

  return { sessions, session, busy, loading, error, activity, select, remove, send, stop }
}
