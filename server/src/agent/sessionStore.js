/**
 * Agent 会话存储
 *
 * 维护每个用户的会话列表、运行状态与限流：
 * - 会话：每用户最多 20 个，全局上限 maxSessions，闲置 24h 过期
 * - 并发：同一用户同时只能有一个运行中的问答
 * - 限流：每用户每分钟最多 10 次提交，每会话最多 200 次提交
 * - 一致性：文档被改版/删除后，引用旧来源的会话自动作废
 *
 * 单进程内存实现；多实例部署需替换为共享存储。
 */
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.js'
import { ApiError, conflict, notFound } from '../utils/response.js'
import { sourceIsValid } from '../services/knowledgeService.js'

export class SessionStore {
  constructor(options = config.agent, now = Date.now) {
    this.options = options
    this.now = now
    this.sessions = new Map()   // sessionId -> session
    this.running = new Map()    // userId -> run   保证每用户单并发
    this.rates = new Map()      // userId -> number[]  最近一分钟提交时间戳
  }

  /**
   * 清理过期会话与过期限流记录
   * 在 create / get / list 等入口懒触发，并由定时器每分钟兜底执行
   */
  cleanup() {
    for (const [id, session] of this.sessions) {
      // 闲置超过 sessionTtlMs 且无运行任务才删除
      if (!session.run && this.now() - session.touchedAt >= this.options.sessionTtlMs) this.sessions.delete(id)
    }
    for (const [id, times] of this.rates) {
      // 该用户最近一分钟内没有任何提交，删除限流记录
      if (!times.some((time) => time > this.now() - 60000)) this.rates.delete(id)
    }
  }

  /**
   * 创建新会话
   * 限制：每用户最多 20 个会话；全局最多 maxSessions 个
   */
  create(userId) {
    this.cleanup()
    if ([...this.sessions.values()].filter((session) => session.userId === userId).length >= 20) {
      throw new ApiError(429, '最多保留 20 个会话，请先删除旧会话')
    }
    if (this.sessions.size >= this.options.maxSessions) throw new ApiError(503, '会话容量已满，请稍后重试')
    const session = { sessionId: randomUUID(), userId, title: '新会话', createdAt: this.now(), updatedAt: this.now(),
      touchedAt: this.now(), turns: [], requests: new Map(), run: null, notice: null }
    this.sessions.set(session.sessionId, session)
    return session
  }

  /**
   * 取会话并刷新活跃时间，同时校验资料是否仍一致
   */
  get(userId, id) {
    this.cleanup()
    const session = this.sessions.get(id)
    if (!session || session.userId !== userId) throw notFound('会话不存在或已过期')
    session.touchedAt = this.now()
    this.invalidate(session)
    return session
  }

  /**
   * 一致性校验：若历史回合引用的来源已失效（文档被改版/删除），
   * 中止正在进行的运行并清空历史，提示用户重新提问。
   */
  invalidate(session) {
    if (session.turns.some((turn) => turn.evidence.some((source) => !sourceIsValid(source)))) {
      session.run?.controller.abort('sources_changed')
      session.turns = []
      session.title = '新会话'
      session.notice = '资料已变更，旧会话内容已清除，请重新提问'
    }
  }

  /**
   * 返回给前端的会话视图：摘要 + 消息 + 运行状态 + 通知
   */
  view(session) {
    this.invalidate(session)
    return { ...this.summary(session), notice: session.notice,
      messages: session.turns.flatMap((turn) => [turn.user, turn.assistant]),
      run: session.run ? { runId: session.run.runId, messageId: session.run.turn.assistant.id } : null }
  }

  /** 会话摘要（列表与详情共用） */
  summary(session) {
    return { sessionId: session.sessionId, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt,
      running: Boolean(session.run) }
  }

  /**
   * 分页列出某用户的会话，按更新时间倒序
   */
  list(userId, page, pageSize) {
    this.cleanup()
    const sessions = [...this.sessions.values()].filter((session) => session.userId === userId)
    sessions.forEach((session) => this.invalidate(session))
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    return { list: sessions.slice((page - 1) * pageSize, page * pageSize).map((session) => this.summary(session)), total: sessions.length }
  }

  /**
   * 取最近的历史回合（用于回传给模型作为上下文）
   * - 只取状态为 completed 的回合
   * - 累计字符不超过 historyChars，最多 10 个回合
   */
  history(session) {
    this.invalidate(session)
    const turns = []
    let chars = 0
    for (const turn of [...session.turns].reverse()) {
      if (turn.assistant.status !== 'completed') continue
      const size = turn.user.content.length + turn.assistant.content.length + JSON.stringify(turn.evidence).length
      if (chars + size > this.options.historyChars || turns.length >= 10) break
      chars += size
      turns.unshift(turn)
    }
    return { messages: turns.flatMap((turn) => [
      { role: 'user', content: turn.user.content }, { role: 'assistant', content: turn.assistant.content },
    ]), sources: turns.flatMap((turn) => turn.evidence) }
  }

  /**
   * 开始一轮问答：
   * - 幂等：相同 clientMessageId 不重复执行
   * - 单并发：同用户已有运行则拒绝
   * - 限流：每分钟 10 次，每会话累计 200 次
   * - 创建 user/assistant 两条消息和运行上下文（AbortController）
   */
  begin(session, message, clientMessageId) {
    if (session.requests.has(clientMessageId)) throw conflict('此消息已提交，请刷新会话查看结果')
    if (this.running.has(session.userId)) throw conflict('已有回答正在生成，请先停止')
    if (session.requests.size >= 200) throw new ApiError(429, '此会话提交次数已达上限，请新建会话')
    // 滑动窗口限流：保留最近一分钟内的提交时间戳
    const times = (this.rates.get(session.userId) || []).filter((time) => time > this.now() - 60000)
    if (times.length >= 10) throw new ApiError(429, '请求过于频繁，请稍后重试')
    this.rates.set(session.userId, [...times, this.now()])

    const turn = { user: { id: randomUUID(), role: 'user', content: message, status: 'completed', sources: [] },
      assistant: { id: randomUUID(), role: 'assistant', content: '', status: 'running', sources: [] }, evidence: [] }
    const run = { runId: randomUUID(), controller: new AbortController(), turn }
    session.requests.set(clientMessageId, run.runId)
    session.turns.push(turn)
    session.turns = session.turns.slice(-10)   // 仅保留最近 10 个回合
    session.run = run
    // 首轮提问自动用消息前 40 字作为会话标题
    session.title = session.title === '新会话' ? message.slice(0, 40) : session.title
    session.updatedAt = this.now()
    this.running.set(session.userId, run)
    return run
  }

  /**
   * 结束运行：清理 session.run 与 running 映射，刷新时间戳
   */
  finish(session, run) {
    if (session.run === run) session.run = null
    if (this.running.get(session.userId) === run) this.running.delete(session.userId)
    session.updatedAt = session.touchedAt = this.now()
  }

  /**
   * 删除会话：若有运行中任务先中止
   */
  remove(userId, id) {
    const session = this.get(userId, id)
    session.run?.controller.abort('cancelled')
    this.sessions.delete(id)
  }
}

// 全局单例：供路由默认使用
export const sessionStore = new SessionStore()
// 每分钟兜底清理过期会话；unref() 确保定时器不阻塞进程退出
const cleanupTimer = setInterval(() => sessionStore.cleanup(), 60000)
cleanupTimer.unref()
