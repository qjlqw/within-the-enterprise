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
 * - 累计字符超过 maxChars 时抛 TOOL_LIMIT，防止一次性读太多
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
  }

  /**
   * 注册一个文档片段为来源，返回带 sourceId 的来源对象
   * @param {Object} fragment  来自 knowledgeService 的文档片段
   */
  register(fragment) {
    const source = { ...fragment, sourceId: `S${this.nextId++}`, url: `/document/${fragment.documentId}` }
    this.chars += JSON.stringify(source).length
    // 容量上限：防止模型在多轮中累计读取过量内容
    if (this.chars > this.maxChars) throw new AgentError('TOOL_LIMIT', '本轮读取内容已达上限，请缩小问题范围')
    this.items.set(source.sourceId, source)
    this.used.push(source)
    this.onRegister?.()
    return source
  }

  /**
   * 校验回答中引用的来源编号：
   * 1) 本轮使用过的所有来源在回答生成时仍然有效（文档未删除/未改版）
   * 2) 回答中出现的 [Sx] 编号必须真实存在
   * 任一条件不满足则抛错，让用户重新提问
   */
  validate(text) {
    if (this.used.some((source) => !sourceIsValid(source))) {
      throw new AgentError('SOURCES_CHANGED', '资料已变更，请重新提问')
    }
    // 提取回答中所有 [S1] [S2] 形式的引用，按出现顺序去重
    const ids = [...new Set([...text.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]))]
    return ids.map((id) => {
      const source = this.items.get(id)
      if (!source || !sourceIsValid(source)) throw new AgentError('INVALID_SOURCE', '回答引用校验失败，请重试')
      return source
    })
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
