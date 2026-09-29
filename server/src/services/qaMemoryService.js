/**
 * Agent 长期记忆（历史问答 QA）服务
 *
 * 职责：
 * - searchHistoricalQA：按用户隔离召回「已确认」历史问答（供 searchHistoricalQA 工具）
 * - QA 异步写回：问答完成后入队，过滤 → 向量化 → 相似去重 → 写 qa_memory(pending) + qa namespace
 * - applyFeedback：用户反馈「有帮助/无帮助」→ 转 confirmed/rejected，并同步向量 metadata
 *
 * 安全约束：
 * - 写回一律 status='pending'，仅用户确认后 confirmed 参与检索
 * - 召回按 userId 强制隔离，绝不跨用户泄露历史问答
 * - 历史答案中的 [Sx] 编号剥离、来源重新 sourceIsValid 校验后交由本轮 registry 重注册
 */
import { config } from "../config/index.js";
import {
  findQa,
  findQaByMessageId,
  confirmQa,
  rejectQa,
  upsertQa,
} from "../db/index.js";
import { sourceIsValid } from "./knowledgeService.js";
import {
  getEmbeddings,
  upsertNamespaceVectors,
  searchNamespace,
  isRagReady,
} from "./embeddingService.js";
import { createQueue } from "./indexQueue.js";
import { audit } from "./observability.js";

const NS = "qa";

/** 召回候选池：至少 10 条，按 qaTopK 放大 3 倍，兼顾去重与召回 */
const candidatePool = () => Math.max(10, config.memory.qaTopK * 3);

/** 剥离答案正文中的 [Sx] 来源编号（历史答案编号在本轮无效） */
function stripSourceMarks(text) {
  return String(text || "").replace(/\[(S\d+)\]/g, "");
}

/** 重新校验并整理来源片段：剔除已失效来源，剥离旧 sourceId/url（由本轮 registry 重注册） */
async function revalidateSources(sources) {
  const out = [];
  for (const s of sources || []) {
    if (await sourceIsValid(s)) {
      out.push({
        documentId: s.documentId,
        title: s.title,
        category: s.category,
        version: s.version,
        offset: s.offset,
        text: s.text,
      });
    }
  }
  return out;
}

/**
 * 语义召回当前用户「已确认」的历史问答。
 * @param {{ userId: number, query: string, limit?: number }} args
 * @returns {Promise<Array<{ question, answer, sources }>>}
 */
export async function searchHistoricalQA({
  userId,
  query,
  limit = config.memory.qaTopK,
}) {
  if (!config.memory.enabled || !isRagReady()) return [];
  if (!query?.trim()) return [];

  const vector = await getEmbeddings().embedQuery(query);
  const candidates = await searchNamespace(NS, vector, candidatePool());

  const out = [];
  for (const c of candidates) {
    if (String(c.metadata?.userId) !== String(userId)) continue;
    if (c.metadata?.status !== "confirmed") continue;
    const qa = await findQa(Number(c.metadata?.qaId));
    if (!qa || qa.status !== "confirmed") continue;
    out.push({
      question: qa.question,
      answer: stripSourceMarks(qa.answer),
      sources: await revalidateSources(qa.sources),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * QA 写回执行器（队列 handler）：
 * 过滤 → embed → 相似去重 → 写 qa_memory(pending) → 写 qa namespace 向量
 * @param {{ userId, sessionId, messageId, question, answer, sources }} payload
 */
async function runQaWrite({
  userId,
  sessionId,
  messageId,
  question,
  answer,
  sources,
}) {
  if (!config.memory.enabled) return { saved: false, reason: "disabled" };
  if (!question?.trim() || !answer?.trim())
    return { saved: false, reason: "empty" };
  if (!sources?.length) return { saved: false, reason: "no_sources" };
  if (!isRagReady()) return { saved: false, reason: "rag_not_ready" };

  const vector = await getEmbeddings().embedQuery(`${question}\n${answer}`);

  // 相似去重：同用户已存在高度相似的问答则跳过
  const candidates = await searchNamespace(NS, vector, candidatePool());
  for (const c of candidates) {
    if (String(c.metadata?.userId) !== String(userId)) continue;
    if ((c.score ?? 0) >= config.memory.qaMinSim) {
      return { saved: false, reason: "duplicate" };
    }
  }

  const qa = await upsertQa({
    question,
    answer,
    sources,
    userId,
    sessionId,
    messageId,
    status: "pending",
    embedding: vector,
  });
  if (!qa) return { saved: false, reason: "db_error" };

  await upsertNamespaceVectors(NS, [
    {
      id: `qa-${qa.id}`,
      text: `${question}\n${answer}`,
      metadata: { qaId: qa.id, userId, status: "pending", question },
      embedding: vector,
    },
  ]);
  return { saved: true, qaId: qa.id };
}

/**
 * 创建 QA 写回队列（createQueue 的适配层）。
 * @param {Object} [deps]
 * @param {(payload: Object) => Promise<any>} [deps.handler]
 * @param {{maxAttempts: number, retryBaseDelayMs: number}} [deps.options]
 */
export async function createQaWriteQueue(deps = {}) {
  const options = deps.options || config.indexQueue;
  const handler = deps.handler || runQaWrite;

  const base = await createQueue({
    jobType: "qa_write",
    handler,
    options: {
      ...options,
      queueName: process.env.QA_QUEUE_NAME || "qa-write-queue",
      isReady: () => config.memory.enabled,
    },
    deps,
  });

  return {
    enqueue(payload, reason = "answer_completed") {
      const key = payload?.messageId;
      if (!key) return null;
      return base.enqueue(payload, { key: String(key), reason });
    },
    retry: base.retry,
    getByMessage: (messageId) => base.getByKey(String(messageId)),
    list: base.list,
    stats: base.stats,
    stop: base.stop,
    schedule: base.schedule,
    pump: base.pump,
    _internal: base._internal,
  };
}

// 惰性单例：仅在首次调用时连接真实队列后端
let _qaWriteQueuePromise = null;

/** 获取全局 QA 写回队列单例（懒加载，返回 Promise） */
export function getQaWriteQueue() {
  if (!_qaWriteQueuePromise) _qaWriteQueuePromise = createQaWriteQueue();
  return _qaWriteQueuePromise;
}

/** 路由层便捷入口：问答完成后入队（返回 Promise，不阻塞 SSE） */
export function enqueueQaWriteJob(payload, reason) {
  return getQaWriteQueue().then((q) => q.enqueue(payload, reason));
}

/**
 * 用户反馈落库 + 向量状态同步。
 * - helpful=true：DB → confirmed，向量 metadata.status → confirmed（复用库内 embedding）
 * - helpful=false：DB → rejected（pending 向量天然不被召回，无需重写）
 * @param {{ messageId: string, userId: number, helpful: boolean }} args
 * @returns {Promise<{ status: string } | null>} 找不到对应问答返回 null
 */
export async function applyFeedback({ messageId, userId, helpful }) {
  const qa = await findQaByMessageId(messageId, userId);
  if (!qa) return null;

  if (helpful) {
    await confirmQa(messageId, userId);
    if (
      Array.isArray(qa.embedding) &&
      qa.embedding.length > 0 &&
      isRagReady()
    ) {
      await upsertNamespaceVectors(NS, [
        {
          id: `qa-${qa.id}`,
          text: `${qa.question}\n${qa.answer}`,
          metadata: {
            qaId: qa.id,
            userId,
            status: "confirmed",
            question: qa.question,
          },
          embedding: qa.embedding,
        },
      ]);
    }
    audit("qa.feedback", { messageId, userId, helpful: true, qaId: qa.id });
    return { status: "confirmed" };
  }

  await rejectQa(messageId, userId);
  audit("qa.feedback", { messageId, userId, helpful: false, qaId: qa.id });
  return { status: "rejected" };
}
