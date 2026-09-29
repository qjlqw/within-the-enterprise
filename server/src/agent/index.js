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
import { createAgent, createMiddleware, ToolMessage } from 'langchain'
import { config } from '../config/index.js'
import { createModel } from './model.js'
import { createKnowledgeTools } from './tools.js'
import { AgentError, SourceRegistry, visibleText, visibleReasoning } from './events.js'
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
  const stats = { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, firstTokenMs: null, reasoningChars: 0, reasoningTokens: 0 }
  const started = Date.now()
  let emitted = false   // 是否已对外输出过 token（影响是否允许重试）
  let retried = false   // 是否已重试过（429/5xx 仅重试一次）
  const tools = createKnowledgeTools({ userId, registry, signal })

  // 硬熔断：同一检索工具连续空结果达阈值后，拦截后续调用并直接注入「停止检索」指令
  // 防止模型无视提示词约束陷入无限换词检索（此时 toolCalls 计数仍递增，最终触发 TOOL_LIMIT 兜底）
  const SEARCH_TOOLS = new Set(['search_documents', 'lookup_entity', 'searchHistoricalQA'])
  const emptyStreak = new Map()

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
        // 推理 token：provider 返回则取（各模型字段名不一），否则用 reasoningChars 估算
        stats.reasoningTokens += response.usage_metadata?.reasoning_tokens
          || response.usage_metadata?.completion_tokens_details?.reasoning_tokens
          || 0
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
      // 检索熔断：同一检索工具连续 2 次空结果，注入停止指令，不再执行真实调用
      if (SEARCH_TOOLS.has(request.toolCall.name) && (emptyStreak.get(request.toolCall.name) || 0) >= 2) {
        emit('tool_start', data)
        emit('tool_end', { ...data, status: 'completed' })
        // 返回 ToolMessage 而非抛出异常，让 agent 正常走完当前轮次
        return new ToolMessage({
          content: JSON.stringify({
            status: 'not_found',
            items: [],
            hint: '已多次检索无结果，禁止再次检索。请立即基于现有信息回答用户，并说明知识库缺少该资料。',
          }),
          tool_call_id: request.toolCall.id,
        })
      }
      emit('tool_start', data)
      try {
        const result = await handler(request)
        // 记录检索结果是否为空，用于熔断判定
        if (SEARCH_TOOLS.has(request.toolCall.name)) {
          try {
            const parsed = JSON.parse(result.content)
            const isEmpty = parsed.status === 'not_found'
              || (Array.isArray(parsed.items) && parsed.items.length === 0)
              || parsed.found === false
            const count = emptyStreak.get(request.toolCall.name) || 0
            emptyStreak.set(request.toolCall.name, isEmpty ? count + 1 : 0)
          } catch { /* 忽略非 JSON 结果 */ }
        }
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
  }, onReasoning: (delta) => {
    if (!delta) return
    signal.throwIfAborted()
    emitted = true                                  // 推理同样属对外输出，禁止重试避免重复
    emit('reasoning', { delta })
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
  const { agent, registry, stats, messages, onText, onReasoning } = buildAgent(params)
  const options = params.options || config.agent
  let text = ''
  const addText = (delta) => {
    // 回答长度限制：避免模型超长输出
    if (text.length + delta.length > options.maxOutputChars) throw new AgentError('OUTPUT_LIMIT', '回答长度已达上限，请缩小问题范围')
    text += delta
    onText(delta)
  }

  // 推理（thinking）累计与限长：仅开启思考时下发，超出 maxReasoningChars 截断，不影响正文
  let reasoningChars = 0
  const addReasoning = (delta) => {
    if (!options.enableThinking || reasoningChars >= options.maxReasoningChars || !delta) return
    const slice = delta.slice(0, options.maxReasoningChars - reasoningChars)
    reasoningChars += slice.length
    stats.reasoningChars = reasoningChars
    onReasoning(slice)
  }

  // 用 run_id 跟踪流式模型调用，避免对同一 run 同时累加 stream 与 end 输出
  const streamedRuns = new Set()
  for await (const event of agent.streamEvents({ messages: [...messages, { role: 'user', content: message }] }, {
    version: 'v2', signal: params.signal, recursionLimit: 60, callbacks: [],
  })) {
    params.signal.throwIfAborted()
    if (event.event === 'on_chat_model_stream') {
      // 流式增量：推理块与普通文本块分开提取，各自对外下发
      addReasoning(visibleReasoning(event.data.chunk))
      const delta = visibleText(event.data.chunk?.content)
      if (delta) { streamedRuns.add(event.run_id); addText(delta) }
    } else if (event.event === 'on_chat_model_end' && !streamedRuns.has(event.run_id)) {
      // 非流式调用结束：补一次完整输出（如工具决策回合）
      addReasoning(visibleReasoning(event.data.output))
      addText(visibleText(event.data.output?.content))
    }
  }
  params.signal.throwIfAborted()
  // 模型可能返回空回答（如调用失败兜底），需提示用户重试
  if (!text.trim()) throw new AgentError('EMPTY_RESPONSE', '模型未返回回答，请重试')

  // 校验回答中引用的来源编号是否都存在且资料未变更
  const sources = await registry.validate(text)
  return {
    text,
    sources,
    // 合并历史与新来源并去重（按 sourceId）
    evidence: [...new Map([...params.history.sources, ...registry.used].map((source) => [source.sourceId, source])).values()],
    usage: stats,
  }
}
