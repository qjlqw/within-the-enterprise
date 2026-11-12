/**
 * 推理审计（P0' 度量地基）：
 * - 记录 agent 每轮问答的推理链与工具调用轨迹，供事后回放评测
 * - 正文先脱敏（密钥/令牌）再分块落审计；observability.audit 会对超长字符串截断，
 *   因此按 ≤490 字符分块传入数组，保证 reasoning 整体（≤8000 字符）完整落盘
 * - 仅组装数据并复用 audit() 写入，失败吞错，绝不阻断问答主流程
 */
import { audit } from './observability.js'

/** 审计事件名（写入 JSONL 的 action 字段） */
export const REASONING_TRACE_EVENT = 'agent.reasoning.trace'

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{8,}/g,                                   // OpenAI 风格密钥
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,                     // Bearer 令牌
  /eyJ[A-Za-z0-9._-]{8,}/g,                                // eyJ 开头的 JWT
  /\b[0-9a-fA-F]{32,}\b/g,                                 // 连续 32+ 位十六进制
]
const MAX_TEXT_CHARS = 8000        // 单段文本最大保留长度
const CHUNK_SIZE = 490             // 分块大小（observability 对 >500 的字符串截断）

/**
 * 脱敏文本：疑似密钥/令牌替换为 ***，并截断到 MAX_TEXT_CHARS
 * @param {unknown} text 任意输入（非字符串返回空串）
 */
export function sanitize(text) {
  if (typeof text !== 'string' || !text) return ''
  let out = text
    .replace(SECRET_PATTERNS[0], '***')
    .replace(SECRET_PATTERNS[1], 'Bearer ***')
    .replace(SECRET_PATTERNS[2], '***')
    .replace(SECRET_PATTERNS[3], '***')
  return out.length > MAX_TEXT_CHARS ? out.slice(0, MAX_TEXT_CHARS) : out
}

/** 按固定长度分块（保证能整体穿过 observability 的 500 字符截断） */
function chunkText(text, size = CHUNK_SIZE) {
  const chunks = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

/**
 * 记录一条推理链审计：agent.reasoning.trace
 * @param {Object} params
 * @param {string} params.runId       本次运行 id
 * @param {number|string} params.userId       用户 id
 * @param {string} [params.sessionId] 会话 id
 * @param {string} params.question    用户提问
 * @param {string} params.reasoning   本次累计的推理正文
 * @param {Array<{tool: string, args?: unknown, ok: boolean, returnedChars: number}>} params.toolCalls 工具调用轨迹
 */
export function recordReasoningAudit({ runId, userId, sessionId, question, reasoning, toolCalls = [] } = {}) {
  try {
    audit(REASONING_TRACE_EVENT, {
      runId,
      userId,
      sessionId,
      question: sanitize(question),
      reasoningChars: typeof reasoning === 'string' ? reasoning.length : 0,
      reasoningChunks: chunkText(sanitize(reasoning)),
      toolCalls: (Array.isArray(toolCalls) ? toolCalls : []).slice(0, 20).map((call) => ({
        tool: typeof call?.tool === 'string' ? call.tool : 'unknown',
        args: sanitize(typeof call?.args === 'string' ? call.args : JSON.stringify(call?.args ?? {})).slice(0, 500),
        ok: Boolean(call?.ok),
        returnedChars: Number(call?.returnedChars) || 0,
      })),
    })
  } catch (error) {
    console.error('[reasoningAudit]', error?.message || error)
  }
}
