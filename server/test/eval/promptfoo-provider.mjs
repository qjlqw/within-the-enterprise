/**
 * promptfoo 自定义 provider：把本项目的 runAgent 直接暴露给 promptfoo 评测，
 * 无需额外起 HTTP 服务。promptfoo 会在独立 Node 进程中加载本文件。
 *
 * 注意：promptfoo 对 file:// 形式的 .mjs provider 会把默认导出解包后直接
 * new 实例化，因此默认导出必须是「class」（对象 / async 函数导出都会抛
 * "TypeError: (intermediate value) is not a constructor"）。
 * promptfoo 实例化后调用实例的 callApi 方法；yaml 里 provider.config 会传给构造函数。
 *
 * 环境要求与 scripts/agent-evaluate.js 一致：server/.env 可用（模型密钥、
 * JWT_SECRET、数据库连接）。config/index.js 按自身路径定位 .env，与 cwd 无关。
 *
 * A/B 对照：跑不同开关配置时设置 EVAL_LABEL 区分（如 baseline / memory-off）。
 */
import { runAgent } from '../../src/agent/index.js'
import { initDb } from '../../src/db/index.js'
import { initVectorStore } from '../../src/services/embeddingService.js'
import { config } from '../../src/config/index.js'

// 惰性单例初始化：DB / 向量库只做一次，多次 callApi 复用
let readyPromise = null
function bootstrap() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await initDb()
      if (config.rag.enabled) await initVectorStore()
    })()
  }
  return readyPromise
}

export default class AgentProvider {
  constructor() {}

  id() {
    return `agent-runner[${process.env.EVAL_LABEL || 'baseline'}]`
  }

  async callApi(prompt) {
    try {
      await bootstrap()
    } catch (error) {
      return { error: `BOOTSTRAP_FAILED: ${error.message}` }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.agent.timeoutMs)
    const started = Date.now()
    try {
      const result = await runAgent({
        userId: 1,
        message: prompt,
        history: { messages: [], sources: [] },
        signal: controller.signal,
      })
      return {
        output: result.text,
        tokenUsage: {
          prompt: result.usage?.inputTokens || 0,
          completion: result.usage?.outputTokens || 0,
          total: (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0),
        },
        // metadata 会随 providerResponse 传给 javascript 断言（doc-match.mjs），
        // 同时完整保留 evidence 供后续 judge 类指标复用
        metadata: {
          label: process.env.EVAL_LABEL || 'baseline',
          durationMs: Date.now() - started,
          usage: result.usage,
          sources: result.sources.map((source) => ({
            sourceId: source.sourceId,
            documentId: source.documentId,
            offset: source.offset,
          })),
          evidence: result.evidence,
        },
      }
    } catch (error) {
      return { error: `${error.code || 'AGENT_ERROR'}: ${error.message}` }
    } finally {
      clearTimeout(timer)
    }
  }
}
