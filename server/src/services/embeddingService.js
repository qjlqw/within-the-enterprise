/**
 * 向量库服务（RAG 增强）
 *
 * 职责：
 * - 文档切片、向量化、写入本地向量库
 * - 启动时加载已有索引，若为空则扫描 published 文档灌入
 * - 文档发布/更新/删除时增量同步
 * - 语义检索：返回与 knowledgeService.fragment() 结构一致的片段
 *
 * 设计要点：
 * - 纯 JavaScript 实现，零外部依赖（不需要 Docker / Python / 原生编译）
 * - 向量数据持久化到 .runtime/vectors.json（JSON 文件）
 * - Embedding 复用 LLM_API_KEY 走 DashScope 的 OpenAI 兼容 /v1/embeddings
 * - 检索用余弦相似度（cosine similarity），O(n) 遍历，适合数百篇文档规模
 * - chunk 的 metadata 与 knowledgeService.fragment 字段对齐，
 *   保证 sourceIsValid / SourceRegistry 校验链路完全复用
 * - 草稿不入库；发布时 upsert，删除时同步清除
 *
 * 降级：任何初始化或调用失败不阻断主流程，
 *       由 knowledgeService.searchDocumentsHybrid 回退到关键词检索
 */
import { OpenAIEmbeddings } from "@langchain/openai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { config } from "../config/index.js";
import { listDocuments, findDocument } from "../db/index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as vectorStore from "./vectorStore/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 索引持久化目录
const VECTORS_DIR = path.resolve(__dirname, "../../.runtime");
// 文档向量默认 namespace（与 entity / qa 隔离）
const DOC_NAMESPACE = "doc";

/** 指定 namespace 的本地向量文件路径：vectors.${namespace}.json */
function vectorsFile(namespace) {
  return path.join(VECTORS_DIR, `vectors.${namespace || DOC_NAMESPACE}.json`);
}

// 索引结构版本：切分逻辑/metadata 结构发生不兼容变化时手动 +1，
// 与配置指纹（embedding 模型 / chunkSize / chunkOverlap）共同组成 indexVersion
const INDEX_FORMAT_VERSION = 2;

/**
 * 当前配置对应的索引版本指纹
 * - embedding 模型切换（向量空间变化）
 * - chunkSize / chunkOverlap 调整（切片边界变化）
 * 任一变化都会使旧 vectors.json 失效，加载时丢弃并自动重建
 */
export function currentIndexVersion() {
  const { rag } = config;
  return `v${INDEX_FORMAT_VERSION}:${rag.embeddingModel}:${rag.chunkSize}:${rag.chunkOverlap}`;
}

/** 是否已初始化成功（false 时所有调用走降级） */
let initialized = false;
/** 各 namespace 的本地向量数据：Map<namespace, { vectors, idCounter }> */
const stores = new Map();
/** 已从磁盘加载过索引的 namespace（DOC_NAMESPACE 由 initVectorStore 加载，其余懒加载） */
const loadedNamespaces = new Set([DOC_NAMESPACE]);
/** 初始化锁，避免并发触发 */
let initPromise = null;
/** Embeddings 实例 */
let embeddings = null;

/** 取（必要时新建）指定 namespace 的本地向量 store */
function getStore(namespace = DOC_NAMESPACE) {
  if (!stores.has(namespace)) {
    stores.set(namespace, { vectors: [], idCounter: 0 });
  }
  return stores.get(namespace);
}

/**
 * 构造 Embeddings 实例（工厂，供文档 / 实体 / QA 三方复用同一 embeddingModel 与 API Key）
 * - 复用 LLM_API_KEY（DashScope 同账号）
 * - baseURL 指向 DashScope 兼容接口
 */
export function getEmbeddings() {
  const { rag } = config;
  return new OpenAIEmbeddings({
    model: rag.embeddingModel,
    apiKey: rag.embeddingApiKey,
    configuration: { baseURL: rag.embeddingBaseURL },
    maxRetries: 0,
  });
}

// DashScope text-embedding-v3 接口单次最多 10 个文本，超出会返回
// "batch size is invalid, it should not be larger than 10"
// 大文档切片数往往超过该上限，这里分批调用再合并结果
const EMBED_BATCH_SIZE = 10;

/**
 * 分批 embed 文本列表，返回与入参顺序对齐的向量数组
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedDocumentsBatched(texts) {
  const result = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embeddings.embedDocuments(batch);
    for (let j = 0; j < vectors.length; j++) result.push(vectors[j]);
  }
  return result;
}

/**
 * 从磁盘加载向量数据
 * - 携带 indexVersion：与当前配置指纹不一致（换模型/改切片参数/格式升级）时
 * *   丢弃旧索引，返回 false 触发全量重建，避免跨向量空间误召回
 * @returns {{ loaded: number, stale: boolean }} 加载切片数与是否为过期索引
 */
function loadStore(namespace) {
  const store = getStore(namespace);
  try {
    const file = vectorsFile(namespace);
    if (!fs.existsSync(file)) return { loaded: 0, stale: false };
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    // 无版本字段的旧索引（版本机制上线前生成）同样视为过期，保守重建
    const stale = !data.version || data.version !== currentIndexVersion();
    if (stale) {
      // 旧索引向量空间/切片边界与当前配置不一致，必须丢弃重建
      console.warn(
        `[RAG] 索引版本不一致（磁盘: ${data.version}，当前: ${currentIndexVersion()}），丢弃旧索引并重建`,
      );
      store.vectors = [];
      store.idCounter = 0;
      return { loaded: 0, stale: true };
    }
    store.vectors = data.vectors || [];
    store.idCounter = data.idCounter || 0;
    return { loaded: store.vectors.length, stale: false };
  } catch {
    store.vectors = [];
    store.idCounter = 0;
    return { loaded: 0, stale: false };
  }
}

/** 指定 namespace 向量数据持久化到磁盘（写入当前索引版本指纹） */
function saveStore(namespace) {
  try {
    const store = getStore(namespace);
    fs.mkdirSync(VECTORS_DIR, { recursive: true });
    fs.writeFileSync(
      vectorsFile(namespace),
      JSON.stringify(
        {
          version: currentIndexVersion(),
          vectors: store.vectors,
          idCounter: store.idCounter,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("[RAG] 向量数据持久化失败:", err.message);
  }
}

/**
 * 确保指定 namespace 的本地向量已从磁盘加载（懒加载）。
 * - DOC_NAMESPACE 由 initVectorStore 加载；entity / qa 等扩展 namespace 在首次
 *   读写时加载，避免 upsertNamespaceVectors 在未加载时就 getStore 得到空 store，
 *   导致写回覆盖掉磁盘上已有的向量（跨重启丢失）。
 * - upstash 驱动数据在云端，无需本地加载。
 * @param {string} namespace
 */
export function ensureNamespaceLoaded(namespace) {
  if (config.vector && config.vector.store === "upstash") return;
  if (loadedNamespaces.has(namespace)) return;
  loadStore(namespace);
  loadedNamespaces.add(namespace);
}

/**
 * 把单个文档切片为 { text, metadata } 数组
 * - 使用 RecursiveCharacterTextSplitter 按分隔符优先级递归切分
 *   （段落 → 行 → 句号 → 问叹号 → 分号 → 逗号 → 空格），
 *   尽量在自然语义边界断开，避免固定滑窗把句子从中间截断
 * - chunkSize / chunkOverlap 仍由 config.rag 控制
 * - splitText 为异步，且带 overlap 合并时可能产生纯标点碎片，需过滤
 * - offset 定位：keepSeparator 保证每个 chunk 都是原文的精确子串，
 *   用全局 indexOf 取首个匹配位置，天然满足
 *   content.slice(offset, offset+len) === text，即 sourceIsValid 校验一定成立；
 *   若文本重复命中不同位置，slice 内容仍一致，引用展示不受影响
 * - 每片 metadata 携带 documentId/version/offset/category/title/nextOffset
 *
 * @param {Object} doc 文档对象（必须已发布）
 * @returns {Promise<Array<{ text: string, metadata: Object }>>}
 */
async function chunkDocument(doc) {
  const { chunkSize, chunkOverlap } = config.rag;
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    // v1 默认按 token 计长（tiktoken）；保持与历史配置一致的字符语义，
    // 避免 RAG_CHUNK_SIZE=500 的含义从"500字符"漂移为"500 token"
    lengthFunction: (text) => text.length,
    // 中文文本默认分隔符（\n\n / 空格）粒度太粗，补充中文标点
    separators: ["\n\n", "\n", "。", "！", "？", "；", "，", " "],
    // 保留分隔符，使 chunk 文本与原文完全一致（indexOf / sourceIsValid 依赖）
    keepSeparator: true,
  });
  const texts = await splitter.splitText(doc.content);

  const chunks = [];
  for (const text of texts) {
    // 过滤空白及纯标点碎片（overlap 合并残留，无语义价值）
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    const offset = doc.content.indexOf(text);
    if (offset === -1) continue; // 理论上不会发生（keepSeparator 保证为原文子串）
    chunks.push({
      text,
      metadata: {
        documentId: doc.id,
        title: doc.title,
        category: doc.category,
        version: doc.version,
        offset,
        // 标记该 chunk 是否还有后续内容，与 fragment.nextOffset 语义对齐
        nextOffset:
          offset + text.length < doc.content.length
            ? offset + text.length
            : null,
      },
    });
  }
  return chunks;
}

/**
 * 计算两个向量的余弦相似度
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} 0~1，越大越相似
 */
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * 初始化向量库：加载已有索引或新建，若索引为空则灌入所有 published 文档
 * 幂等：多次调用安全，由 initPromise 锁保护
 *
 * 失败时不抛出，仅记日志；initialized 保持 false，调用方走降级
 */
export async function initVectorStore() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      if (!config.rag.enabled) {
        console.log("[RAG] 未启用（RAG_ENABLED 非 true），跳过初始化");
        return;
      }
      if (!config.rag.embeddingApiKey) {
        console.warn(
          "[RAG] 缺少 embeddingApiKey，跳过初始化（复用 LLM_API_KEY）",
        );
        return;
      }
      // 构造 embeddings 客户端
      embeddings = getEmbeddings();

      // 如果配置为 Upstash 驱动，初始化 Upstash adapter 并跳过本地全量重建
      if (config.vector && config.vector.store === "upstash") {
        try {
          await vectorStore.init();
          console.log("[RAG] Upstash vector store 已初始化（不自动灌种本地文档");
          initialized = true;
          return;
        } catch (e) {
          console.error("[RAG] 初始化 Upstash 失败，回退到本地实现:", e.message || e);
          // 继续走本地逻辑（若需要）
        }
      }

      // 先加载已有数据（本地 JSON），版本不一致时自动丢弃并重建
      const store = getStore(DOC_NAMESPACE);
      loadStore(DOC_NAMESPACE);

      if (store.vectors.length > 0) {
        console.log(`[RAG] 向量库已就绪（复用已有 ${store.vectors.length} 个切片）`);
        initialized = true;
        return;
      }

      // 空索引则批量灌种子数据（仅在本地驱动时执行）
      const { list: docs } = await listDocuments({ status: "published" });
      console.log(`[RAG] 正在为 ${docs.length} 篇文档生成向量...`);
      let total = 0;
      for (const doc of docs) {
        try {
          const chunks = await chunkDocument(doc);
          if (chunks.length === 0) continue;
          const texts = chunks.map((c) => c.text);
          const embeddingsArr = await embedDocumentsBatched(texts);
          for (let i = 0; i < chunks.length; i++) {
            store.vectors.push({
              id: `v${++store.idCounter}`,
              text: chunks[i].text,
              metadata: chunks[i].metadata,
              embedding: embeddingsArr[i],
            });
          }
          total += chunks.length;
        } catch (err) {
          console.error(`[RAG] 文档 ${doc.id} 入库失败:`, err.message);
        }
      }
      saveStore(DOC_NAMESPACE);
      console.log(
        `[RAG] 向量库已就绪，已索引 ${docs.length} 篇文档 / ${total} 个切片`,
      );
      initialized = true;
    } catch (err) {
      console.error("[RAG] 初始化失败，已降级为关键词检索");
      console.error("      原因:", err.message);
      console.error("      排查：");
      console.error("      1) Embedding API Key 是否有效？");
      console.error(`      2) 索引目录可写？${VECTORS_DIR}`);
      console.error("      agent 仍可工作，仅检索回退为关键词模式");
      initialized = false;
    }
  })();
  return initPromise;
}

/**
 * 文档发布/更新时增量同步向量库
 * - 先按 documentId 删除旧切片（覆盖更新场景）
 * - 重新切片 + embed + 存储
 * - 草稿/下线文档：清除其向量，避免被召回
 *
 * 注意：本函数会抛出异常，由异步索引任务队列（indexQueue）负责重试；
 *       不应在 HTTP 请求中直接 await，避免索引失败被静默吞掉。
 *       RAG 未启用/未初始化时为空操作（正常 resolve）。
 *
 * @returns {Promise<{ indexed: number }>} 写入的切片数
 */
export async function upsertDocument(doc) {
  if (!initialized || !embeddings) return { indexed: 0 };
  if (doc.status !== "published") {
    // 如果使用 Upstash 驱动，调用其删除接口
    if (config.vector && config.vector.store === "upstash") {
      await vectorStore.deleteByDocumentId(doc.id, DOC_NAMESPACE);
      return { indexed: 0 };
    }
    await deleteDocument(doc.id);
    return { indexed: 0 };
  }

  // 切片并生成 embeddings
  const chunks = await chunkDocument(doc);
  if (chunks.length === 0) {
    if (!(config.vector && config.vector.store === "upstash"))
      saveStore(DOC_NAMESPACE);
    return { indexed: 0 };
  }
  const texts = chunks.map((c) => c.text);
  const embeddingsArr = await embedDocumentsBatched(texts);

  if (config.vector && config.vector.store === "upstash") {
    // 覆盖更新前先清空该文档旧向量，避免切片数变少时残留孤儿向量
    await vectorStore.deleteByDocumentId(doc.id, DOC_NAMESPACE);

    // prepare items for upsert: id includes document id for traceability
    const items = chunks.map((c, i) => ({
      id: `${doc.id}-v${i + 1}`,
      embedding: embeddingsArr[i],
      metadata: c.metadata,
      text: c.text,
    }));
    await vectorStore.upsertVectors(items, DOC_NAMESPACE);
    return { indexed: items.length };
  }

  // 本地持久化路径（原逻辑）
  const store = getStore(DOC_NAMESPACE);
  store.vectors = store.vectors.filter((v) => v.metadata.documentId !== doc.id);
  for (let i = 0; i < chunks.length; i++) {
    store.vectors.push({
      id: `v${++store.idCounter}`,
      text: chunks[i].text,
      metadata: chunks[i].metadata,
      embedding: embeddingsArr[i],
    });
  }
  saveStore(DOC_NAMESPACE);
  return { indexed: chunks.length };
}

/**
 * 文档删除/下线时同步清除向量库中所有相关切片
 * 同样抛出异常以支持队列重试；无切片可删时为空操作
 */
export async function deleteDocument(docId) {
  // RAG 启用但未初始化时必须抛错让队列重试；静默 return 会让删除任务
  // 标记完成而向量残留成孤儿（历史事故：doc 17/50/51 的向量未被清除）
  if (!initialized) {
    if (config.rag?.enabled)
      throw new Error("RAG 未初始化，无法删除文档向量（任务将进入重试）");
    return;
  }
  if (config.vector && config.vector.store === "upstash") {
    await vectorStore.deleteByDocumentId(docId, DOC_NAMESPACE);
    return;
  }
  const store = getStore(DOC_NAMESPACE);
  const before = store.vectors.length;
  store.vectors = store.vectors.filter((v) => v.metadata.documentId !== docId);
  if (store.vectors.length !== before) saveStore(DOC_NAMESPACE);
}

/**
 * 语义检索：返回与 knowledgeService.fragment 结构一致的片段数组
 *
 * @param {{ query: string, category?: string, limit?: number }} args
 * @returns {Promise<Array<{ documentId, title, category, version, offset, text, nextOffset, score }>>}
 *   失败时返回空数组，调用方应回退到关键词检索
 */
export async function semanticSearch({ query, category, limit = 5 }) {
  if (!initialized || !embeddings) return [];
  try {
    const queryEmbedding = await embeddings.embedQuery(query);

    if (config.vector && config.vector.store === "upstash") {
      const results = await vectorStore.search(queryEmbedding, limit, DOC_NAMESPACE);
      // results: [{id, score, metadata}]
      // 过滤孤儿向量：文档删除/改版后旧向量可能仍残留在索引中，
      // 不过滤会让 agent 引用失效来源并在 sourceIsValid 时抛 SOURCES_CHANGED
      const valid = [];
      for (const r of results) {
        if (category && r.metadata.category !== category) continue;
        const doc = await findDocument(r.metadata.documentId);
        if (!(doc?.status === "published" && doc.version === r.metadata.version))
          continue;
        valid.push(r);
        if (valid.length >= limit) break;
      }
      return valid.map((r) => ({
        documentId: r.metadata.documentId,
        title: r.metadata.title,
        category: r.metadata.category,
        version: r.metadata.version,
        offset: r.metadata.offset,
        text: r.metadata.text || "",
        nextOffset: r.metadata.nextOffset || null,
        score: r.score,
      }));
    }

    const store = getStore(DOC_NAMESPACE);
    if (store.vectors.length === 0) return [];
    const scored = store.vectors
      .filter((v) => !category || v.metadata.category === category)
      .map((v) => ({
        ...v,
        score: cosineSimilarity(queryEmbedding, v.embedding),
      }))
      .sort((a, b) => b.score - a.score); // 降序，越大越相似
    // 过滤孤儿向量（文档删除/改版后的残留向量）
    const valid = [];
    for (const v of scored) {
      const doc = await findDocument(v.metadata.documentId);
      if (!(doc?.status === "published" && doc.version === v.metadata.version))
        continue;
      valid.push(v);
      if (valid.length >= limit) break;
    }
    return valid.map((v) => ({
      documentId: v.metadata.documentId,
      title: v.metadata.title,
      category: v.metadata.category,
      version: v.metadata.version,
      offset: v.metadata.offset,
      text: v.text,
      nextOffset: v.metadata.nextOffset,
      score: v.score,
    }));
  } catch (err) {
    console.error("[RAG] semanticSearch 失败，回退关键词检索:", err.message);
    return [];
  }
}

/** 暴露初始化状态，便于调试与降级判断 */
export const isRagReady = () => initialized;

// ============================================================================
// 通用 namespace 向量接口（供 entity / qa 等服务复用）
// - 文档向量走 DOC_NAMESPACE，实体走 "entity"，QA 走 "qa"，互不串扰
// - local 驱动：各自独立的 vectors.${namespace}.json + 内存 store
// - upstash 驱动：通过 vectorStore 的 namespace 参数隔离
// ============================================================================

/**
 * 向指定 namespace 批量写入向量（本地 JSON 或 Upstash）
 * @param {string} namespace
 * @param {Array<{ id: string, text: string, metadata: Object, embedding: number[] }>} items
 * @returns {Promise<number>} 写入条数
 */
export async function upsertNamespaceVectors(namespace, items) {
  if (!items || items.length === 0) return 0;
  if (config.vector && config.vector.store === "upstash") {
    await vectorStore.upsertVectors(items, namespace);
    return items.length;
  }
  ensureNamespaceLoaded(namespace);
  const store = getStore(namespace);
  for (const it of items) {
    store.vectors = store.vectors.filter((v) => v.id !== it.id);
    store.vectors.push({
      id: it.id,
      text: it.text,
      metadata: it.metadata,
      embedding: it.embedding,
    });
  }
  saveStore(namespace);
  return items.length;
}

/**
 * 在指定 namespace 内做语义检索
 * @param {string} namespace
 * @param {number[]} queryEmbedding
 * @param {number} topK
 * @returns {Promise<Array<{ id, score, metadata, text }>>}
 */
export async function searchNamespace(namespace, queryEmbedding, topK = 5) {
  if (config.vector && config.vector.store === "upstash") {
    const results = await vectorStore.search(queryEmbedding, topK, namespace);
    return results.map((r) => ({
      id: r.id,
      score: r.score,
      metadata: r.metadata || {},
      text: r.metadata?.text || r.text || "",
    }));
  }
  ensureNamespaceLoaded(namespace);
  const store = getStore(namespace);
  if (store.vectors.length === 0) return [];
  return store.vectors
    .map((v) => ({
      id: v.id,
      score: cosineSimilarity(queryEmbedding, v.embedding),
      metadata: v.metadata,
      text: v.text,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * 删除指定 namespace 内 metadata[key] === value 的向量
 * - local：直接过滤本地 store
 * - upstash：仅支持按 documentId 删除（复用 Redis 映射）；其它 key 需调用方
 *   自行维护「id → vectorId」映射并走 upsertNamespaceVectors 覆盖或后续扩展
 * @param {string} namespace
 * @param {string} key
 * @param {*} value
 */
export async function deleteNamespaceByKey(namespace, key, value) {
  if (config.vector && config.vector.store === "upstash") {
    if (key === "documentId") {
      await vectorStore.deleteByDocumentId(value, namespace);
      return;
    }
    console.warn(
      `[RAG] Upstash 驱动暂不支持按 metadata.${key} 删除（namespace=${namespace}），请调用方自行维护映射`,
    );
    return;
  }
  const store = getStore(namespace);
  const before = store.vectors.length;
  store.vectors = store.vectors.filter((v) => v.metadata?.[key] !== value);
  if (store.vectors.length !== before) saveStore(namespace);
}
