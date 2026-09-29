/**
 * Agent 事件与来源注册相关：
 * - AgentError      带 code 的业务错误（区别于一般异常）
 * - SourceRegistry  来源注册表：管理本次运行的来源编号、容量上限与最终校验
 * - visibleText     过滤模型输出，只保留对外可见的普通文本
 * - publicError     把内部错误映射为可对用户展示的统一信息
 */
import { sourceIsValid } from '../services/knowledgeService.js'

/**
 * Agent 业务错误：携带 code，路由层据此返回对应 SSE 错误事件
 */
export class AgentError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

/**
 * 来源注册表
 * - 每次工具返回的文档片段都会被注册为 S1/S2/... 形式的来源编号
 * - maxChars 是「软预算」：累计读取体量超过预算时不再硬抛错，
 *   而是把后续片段的正文截断到剩余预算并标记 truncated，
 *   让模型拿到部分内容后自行收尾，避免整轮问答因超限直接失败
 *   （彻底耗尽、连元数据都放不下时才抛 TOOL_LIMIT 作为最后兜底）
 * - 同一文档同一偏移同一长度的重复读取自动去重，不重复计费
 * - validate() 校验回答中 [Sx] 引用是否真实存在且文档未变更
 */
export class SourceRegistry {
  constructor(sources = [], maxChars = 24000) {
    // items：sourceId -> source，用于回答校验
    this.items = new Map(sources.map((source) => [source.sourceId, source]))
    // 下一个编号：基于历史来源中的最大值 +1
    this.nextId = Math.max(0, ...sources.map((source) => Number(source.sourceId.slice(1)))) + 1
    this.maxChars = maxChars
    this.chars = 0
    this.used = []   // 本轮新增的来源列表
    // 去重索引：documentId:offset:textLength -> true
    // 模型反复读取同一页是常见浪费，命中后仍分配新 sourceId 但不重复计费
    this.index = new Map()
    for (const source of sources) {
      this.chars += JSON.stringify(source).length
      const key = `${source.documentId}:${source.offset}:${source.text?.length || 0}`
      this.index.set(key, true)
    }
  }

  /**
   * 注册一个文档片段为来源，返回带 sourceId 的来源对象
   * - 每次调用都分配新的 sourceId（保证模型看到的引用编号连续，不因去重跳号）
   * - 命中去重索引（同一文档同一偏移同一长度）时不重复计费，预算不累加
   * - 体量超出剩余预算时截断正文到可容纳长度，标记 truncated:true / nextOffset:null
   * - 仅当预算彻底耗尽（连元数据都放不下）时抛 TOOL_LIMIT
   * @param {Object} fragment  来自 knowledgeService 的文档片段
   */
  register(fragment) {
    const textLen = fragment.text?.length || 0
    const dedupKey = `${fragment.documentId}:${fragment.offset}:${textLen}`
    const isDuplicate = this.index.has(dedupKey)
    const source = { ...fragment, sourceId: `S${this.nextId++}`, url: `/document/${fragment.documentId}` }

    // 重复内容：分配新 sourceId 但不计费（模型引用编号不跳号，预算不重复消耗）
    if (isDuplicate) {
      this.items.set(source.sourceId, source)
      this.used.push(source)
      this.onRegister?.()
      return source
    }

    // 新内容：评估体量并在超限时软截断
    const remaining = this.maxChars - this.chars
    // 预算彻底耗尽才硬抛（maxChars 极小或多次截断后才会出现）
    if (remaining <= 0) throw new AgentError('TOOL_LIMIT', '本轮读取内容已达上限，请缩小问题范围')

    const fullLen = JSON.stringify(source).length
    if (fullLen > remaining) {
      // 软截断：把正文砍到剩余预算能容纳的长度，让模型拿到部分内容而非整轮失败
      //    overhead = 总长度 - 正文字符数（近似；含转义时会被下方收敛循环修正）
      const overhead = fullLen - source.text.length
      const textBudget = Math.max(0, remaining - overhead)
      source.text = source.text.slice(0, textBudget)
      source.truncated = true
      source.nextOffset = null
      // JSON 转义（引号/反斜杠/换行）可能使实际长度仍超，逐步收敛到预算内
      let finalLen = JSON.stringify(source).length
      while (finalLen > remaining && source.text.length > 0) {
        const over = finalLen - remaining
        source.text = source.text.slice(0, Math.max(0, source.text.length - over - 4))
        finalLen = JSON.stringify(source).length
      }
      if (finalLen > remaining) throw new AgentError('TOOL_LIMIT', '本轮读取内容已达上限，请缩小问题范围')
      this.chars += finalLen
    } else {
      this.chars += fullLen
    }

    this.items.set(source.sourceId, source)
    this.used.push(source)
    this.index.set(dedupKey, true)
    this.onRegister?.()
    return source
  }

  /**
   * 校验回答中引用的来源编号：
   * 1) 本轮使用过的所有来源在回答生成时仍然有效（文档未删除/未改版）
   * 2) 回答中出现的 [Sx] 编号必须真实存在
   * 任一条件不满足则抛错，让用户重新提问
   */
  async validate(text) {
    for (const source of this.used) {
      if (!(await sourceIsValid(source))) {
        throw new AgentError('SOURCES_CHANGED', '资料已变更，请重新提问')
      }
    }
    // 提取回答中所有 [S1] [S2] 形式的引用，按出现顺序去重
    const ids = [...new Set([...text.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]))]
    const result = []
    for (const id of ids) {
      const source = this.items.get(id)
      if (!source || !(await sourceIsValid(source))) throw new AgentError('INVALID_SOURCE', '回答引用校验失败，请重试')
      result.push(source)
    }
    return result
  }
}

// Only ordinary text blocks are public; reasoning and provider metadata stay server-side.
/**
 * 从模型 content 中提取对外可见的文本：
 * - 字符串直接返回
 * - 数组（多模态 content）只保留 type === 'text' 的部分，过滤 reasoning 等内部内容
 */
export function visibleText(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter((block) => block.type === 'text').map((block) => block.text || '').join('') : ''
}

/**
 * 从模型 chunk 中提取推理（thinking）文本：
 * - 通义千问/DeepSeek：`reasoning_content` 字段经 LangChain 落入 `additional_kwargs.reasoning_content`
 * - 部分模型（OpenAI 风格）以 `type === 'reasoning'` 的内容块返回
 * - 字符串 content 无推理信息
 */
export function visibleReasoning(chunk) {
  if (!chunk || typeof chunk !== 'object') return ''
  const kwarg = chunk.additional_kwargs?.reasoning_content
  const blockText = Array.isArray(chunk.content)
    ? chunk.content.filter((block) => block?.type === 'reasoning').map((block) => block.reasoning || block.text || '').join('')
    : ''
  return `${kwarg ?? ''}${blockText}`
}

/**
 * 把内部异常映射成对用户友好的错误信息
 * - AgentError 直接透传 code/message
 * - 429 视为模型限流
 * - 其他统一归为 MODEL_ERROR，避免泄露内部细节
 */
export function publicError(error) {
  if (error instanceof AgentError) return { code: error.code, message: error.message }
  if (error?.status === 429) return { code: 'MODEL_RATE_LIMIT', message: '模型服务繁忙，请稍后重试' }
  return { code: 'MODEL_ERROR', message: '模型暂时无法完成回答，请稍后重试' }
}
