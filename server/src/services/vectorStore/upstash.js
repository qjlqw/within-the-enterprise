import { Index } from "@upstash/vector";
import { Redis } from "@upstash/redis";
import { config } from "../../config/index.js";

let vectorClient = null;
let redisClient = null;

export function init() {
  if (vectorClient) return;
  const { upstash } = config.vector;
  const url =
    upstash?.restUrl ||
    process.env.UPSTASH_VECTOR_REST_URL ||
    process.env.UPSTASH_VECTOR_URL;
  const token =
    upstash?.restApiKey ||
    process.env.UPSTASH_VECTOR_API_KEY ||
    process.env.UPSTASH_VECTOR_REST_TOKEN;
  if (!url || !token) {
    throw new Error("Upstash vector config missing (url/token)");
  }
  vectorClient = new Index({ url, token });

  const redisRestUrl = upstash?.redisRestUrl || "";
  const redisToken = upstash?.redisToken || "";
  if (redisRestUrl && redisToken) {
    redisClient = new Redis({ url: redisRestUrl, token: redisToken });
  }
}

/**
 * 返回指定 namespace 的索引客户端；无 namespace 时回退主空间
 * - 借助 @upstash/vector 的 Index.namespace(name) 实现多知识库/多类型隔离
 */
function namespacedIndex(namespace) {
  if (!vectorClient) init();
  return namespace ? vectorClient.namespace(namespace) : vectorClient;
}

/** 生成带 namespace 前缀的 Redis 映射 key */
function redisKey(namespace, key) {
  return namespace ? `${namespace}:${key}` : key;
}

/**
 * items: [{ id, embedding, metadata, text }]
 */
export async function upsertVectors(items, namespace) {
  if (!vectorClient) init();
  const index = namespacedIndex(namespace);
  // prepare documents for upsert
  const docs = items.map((it) => ({
    id: it.id,
    vector: it.embedding,
    metadata: { ...it.metadata, text: it.text },
  }));
  // Upstash Vector SDK upsert
  await index.upsert(docs);

  // maintain mapping documentId -> vector ids in Redis (if available)
  if (redisClient) {
    for (const it of items) {
      const docId = it.metadata?.documentId;
      if (docId) {
        try {
          await redisClient.sadd(redisKey(namespace, `doc:vectors:${docId}`), it.id);
        } catch (e) {
          // 映射维护失败不应让整篇文档索引判定为失败：向量已写入成功，
          // 这里只影响「按文档删除向量」的能力，降级为日志告警即可
          console.warn(
            "[Upstash] 维护 doc:vectors 映射失败（sadd）:",
            e?.message || e,
          );
        }
      }
    }
  }
}

export async function getInfo() {
  if (!vectorClient) init();
  try {
    const info = await vectorClient.info();
    return info;
  } catch (e) {
    console.error("[Upstash] info failed:", e.message || e);
    throw e;
  }
}

export async function deleteByDocumentId(documentId, namespace) {
  if (!vectorClient) init();
  const index = namespacedIndex(namespace);
  if (redisClient) {
    const key = redisKey(namespace, `doc:vectors:${documentId}`);
    const ids = await redisClient.smembers(key);
    if (ids && ids.length > 0) {
      // 失败必须抛出：否则下面 del(key) 会清掉映射，向量变成
      // 永久孤儿（重试时 smembers 拿到空集合，index.delete 不再被调用）
      await index.delete(ids);
    }
    // 仅在向量删除成功后才清理映射，保证失败时可重试
    await redisClient.del(key);
  } else {
    // Best-effort: attempt to delete by prefix (if ids were named with prefix)
    // This requires ids to be named e.g. `${documentId}:v1` when upserting.
    // Not implemented if Redis mapping unavailable.
    console.warn(
      "[Upstash] Redis mapping unavailable; cannot reliably delete by documentId",
    );
  }
}

export async function search(queryEmbedding, topK = 5, namespace) {
  if (!vectorClient) init();
  const index = namespacedIndex(namespace);
  // Upstash Vector query API: include metadata
  const resp = await index.query({
    vector: queryEmbedding,
    topK,
    includeMetadata: true,
  });
  const items = Array.isArray(resp) ? resp : resp?.matches || resp?.items || [];
  return items.map((it) => ({
    id: it.id,
    score: it.score ?? it.similarity ?? it.similarityScore ?? 0,
    metadata: it.metadata || it.data || {},
  }));
}
