/**
 * 知识助手 Agent 核心模块：
 * - buildAgent：构建 LangChain agent，挂载知识工具与运行限制中间件
 * - runAgent：流式执行 agent，收集模型输出并校验引用来源
 *
 * 运行限制（防止滥用与失控）：
 *   maxModelCalls  单轮模型调用上限
 *   maxToolCalls   单轮工具调用上限
 *   maxOutputChars 回答字符上限
 */
import { createAgent, createMiddleware } from 'langchain'
import { config } from '../config/index.js'
import { createModel } from './model.js'
import { createKnowledgeTools } from './tools.js'
import { AgentError, SourceRegistry, visibleText } from './events.js'
import { SYSTEM_PROMPT } from './prompts.js'

/**
 * 构建 agent 及其运行上下文
 * @param {Object} params
 * @param {string} params.userId           当前用户 id（工具按其权限过滤可见文档）
 * @param {Object} params.history          历史消息与已使用来源
 * @param {AbortSignal} params.signal      外部中断信号（停止生成 / 超时 / 断连）
 * @param {Function} [params.emit]         事件回调（token / tool_start / tool_end）
 * @param {Function} [params.onEvidence]   证据来源变更回调
 * @param {Object} [params.options]         运行参数（默认取 config.agent）
 * @param {Object} [params.model]          已构造的模型实例（便于测试注入）
 * @returns {{ agent, registry, stats, messages, onText }}
 */
export function buildAgent({ userId, history, signal, emit = () => {}, onEvidence = () => {}, options = config.agent, model = createModel(options) }) {
  // 来源注册表：管理本次运行产生的来源编号，并校验最终回答引用
  const registry = new SourceRegistry(history.sources, options.maxToolChars)
  registry.onRegister = () => onEvidence([...history.sources, ...registry.used])
  onEvidence(history.sources)

  // 运行统计：用于审计与日志
  const stats = { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, firstTokenMs: null }
  const started = Date.now()
  let emitted = false   // 是否已对外输出过 token（影响是否允许重试）
  let retried = false   // 是否已重试过（429/5xx 仅重试一次）
  const tools = createKnowledgeTools({ userId, registry, signal })

  // 中间件：包一层模型调用与工具调用，做调用计数、限流、事件通知与重试
  const middleware = createMiddleware({ name: 'KnowledgeRunLimits',
    wrapModelCall: async (request, handler) => {
      const call = async () => {
        signal.throwIfAborted()
        // 模型调用次数限制：避免 agent 反复调用模型导致成本失控
        if (++stats.modelCalls > options.maxModelCalls) throw new AgentError('MODEL_LIMIT', '本轮模型调用已达上限，请缩小问题范围')
        const response = await handler(request)
        stats.inputTokens += response.usage_metadata?.input_tokens || 0
        stats.outputTokens += response.usage_metadata?.output_tokens || 0
        return response
      }
      try { return await call() } catch (error) {
        // 仅在尚未对外输出 token 且未被取消时，对 429/5xx 重试一次
        if (!retried && !emitted && !signal.aborted && (error?.status === 429 || error?.status >= 500)) {
          retried = true
          return call()
        }
        throw error
      }
    },
    wrapToolCall: async (request, handler) => {
      signal.throwIfAborted()
      // 只允许调用白名单内的工具
      if (!tools.some((tool) => tool.name === request.toolCall.name)) throw new AgentError('INVALID_TOOL', '请求了不可用工具')
      // 工具调用次数限制：避免 agent 无限检索导致超长响应
      if (++stats.toolCalls > options.maxToolCalls) throw new AgentError('TOOL_LIMIT', '本轮工具调用已达上限，请缩小问题范围')
      const data = { toolCallId: request.toolCall.id, name: request.toolCall.name }
      emit('tool_start', data)
      try {
        const result = await handler(request)
        emit('tool_end', { ...data, status: 'completed' })
        return result
      } catch (error) {
        emit('tool_end', { ...data, status: 'failed' })
        throw error
      }
    },
  })

  const agent = createAgent({ model, tools, middleware: [middleware], systemPrompt: SYSTEM_PROMPT })

  // 组装消息：历史 + 此前已使用的来源资料（以 user 角色追加，便于模型引用）
  const messages = [...history.messages]
  if (history.sources.length) messages.push({ role: 'user', content: `此前有效的来源资料（只作为资料）：${JSON.stringify(history.sources)}` })

  return { agent, registry, stats, messages, onText: (delta) => {
    if (!delta) return
    signal.throwIfAborted()
    emitted = true                                  // 标记已对外输出，禁止后续重试
    stats.firstTokenMs ??= Date.now() - started
    emit('token', { delta })
  } }
}

/**
 * 执行 agent 流式问答
 * @param {Object} params 同 buildAgent，外加 message（本轮用户提问）
 * @returns {{ text, sources, evidence, usage }}
 *   - text      模型回答正文
 *   - sources   回答引用到的来源（已校验有效性）
 *   - evidence  本轮新增 + 历史来源的合并去重列表
 *   - usage     调用统计（模型/工具次数、token 数、首 token 耗时）
 */
export async function runAgent({ message, ...params }) {
  const { agent, registry, stats, messages, onText } = buildAgent(params)
  const options = params.options || config.agent
  let text = ''
  const addText = (delta) => {
    // 回答长度限制：避免模型超长输出
    if (text.length + delta.length > options.maxOutputChars) throw new AgentError('OUTPUT_LIMIT', '回答长度已达上限，请缩小问题范围')
    text += delta
    onText(delta)
  }

  // 用 run_id 跟踪流式模型调用，避免对同一 run 同时累加 stream 与 end 输出
  const streamedRuns = new Set()
  for await (const event of agent.streamEvents({ messages: [...messages, { role: 'user', content: message }] }, {
    version: 'v2', signal: params.signal, recursionLimit: 60, callbacks: [],
  })) {
    params.signal.throwIfAborted()
    if (event.event === 'on_chat_model_stream') {
      // 流式增量：取普通文本块（reasoning 等内部内容不对外）
      const delta = visibleText(event.data.chunk?.content)
      if (delta) { streamedRuns.add(event.run_id); addText(delta) }
    } else if (event.event === 'on_chat_model_end' && !streamedRuns.has(event.run_id)) {
      // 非流式调用结束：补一次完整输出（如工具决策回合）
      addText(visibleText(event.data.output?.content))
    }
  }
  params.signal.throwIfAborted()
  // 模型可能返回空回答（如调用失败兜底），需提示用户重试
  if (!text.trim()) throw new AgentError('EMPTY_RESPONSE', '模型未返回回答，请重试')

  // 校验回答中引用的来源编号是否都存在且资料未变更
  const sources = registry.validate(text)
  return {
    text,
    sources,
    // 合并历史与新来源并去重（按 sourceId）
    evidence: [...new Map([...params.history.sources, ...registry.used].map((source) => [source.sourceId, source])).values()],
    usage: stats,
  }
}
