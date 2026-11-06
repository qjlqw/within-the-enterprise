/**
 * 分项健康检查
 *
 * 与旧版“返回功能开关”不同，这里分别探测数据库、索引队列、向量库与模型供应商配置，
 * 任何一项异常都会在 checks 中单独标注，便于运维快速定位。
 */
import { config } from "../config/index.js";
import { pingDatabase } from "../db/index.js";
import { getIndexQueue } from "./indexQueue.js";
import { getVectorStoreStatus } from "./embeddingService.js";

/** 截断错误信息，避免健康检查把内部堆栈/密钥带出去 */
const safeError = (error) =>
  String(error?.message || error || "unknown").slice(0, 200);

/**
 * 采集健康状态
 * @returns {Promise<{status: "ok"|"degraded", checks: Record<string, object>}>}
 */
export async function healthSnapshot() {
  const checks = {};

  // 1. 数据库：真实执行一次轻量查询
  try {
    await pingDatabase();
    checks.database = { ok: true };
  } catch (error) {
    checks.database = { ok: false, error: safeError(error) };
  }

  // 2. 索引队列：能取到实例并读出统计即视为可用
  try {
    const queue = await getIndexQueue();
    const stats = await Promise.resolve(queue.stats?.() ?? {});
    checks.queue = {
      ok: true,
      driver: process.env.INDEX_QUEUE_DRIVER || "memory",
      stats,
    };
  } catch (error) {
    checks.queue = { ok: false, error: safeError(error) };
  }

  // 3. 向量库：未启用 RAG 时不算失败，只标注状态
  const vector = getVectorStoreStatus();
  checks.vectorStore = {
    ok: !config.rag.enabled || vector.initialized,
    enabled: config.rag.enabled,
    driver: vector.driver,
    initialized: vector.initialized,
  };

  // 4. 模型供应商：健康检查不主动产生计费调用，仅校验必要配置是否齐全
  const llmConfigured = Boolean(
    config.agent.model && config.agent.apiKey && config.agent.baseURL,
  );
  checks.llm = {
    ok: !config.agent.enabled || llmConfigured,
    enabled: config.agent.enabled,
    configured: llmConfigured,
    model: config.agent.model || null,
  };

  const ok = Object.values(checks).every((item) => item.ok);
  return { status: ok ? "ok" : "degraded", checks };
}
