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
import { listDocuments } from "../db/index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as vectorStore from "./vectorStore/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 索引持久化目录和文件
const VECTORS_DIR = path.resolve(__dirname, "../../.runtime");
const VECTORS_FILE = path.join(VECTORS_DIR, "vectors.json");

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
/** 向量数据：[{ id, text, metadata, embedding }] */
let vectors = [];
/** 初始化锁，避免并发触发 */
let initPromise = null;
/** Embeddings 实例 */
let embeddings = null;
/** 自增 ID 计数器 */
let idCounter = 0;

/**
 * 构造 Embeddings 实例
 * - 复用 LLM_API_KEY（DashScope 同账号）
 * - baseURL 指向 DashScope 兼容接口
 */
function createEmbeddings() {
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
function loadVectors() {
  try {
    if (!fs.existsSync(VECTORS_FILE)) return { loaded: 0, stale: false };
    const data = JSON.parse(fs.readFileSync(VECTORS_FILE, "utf-8"));
    // 无版本字段的旧索引（版本机制上线前生成）同样视为过期，保守重建
    const stale = !data.version || data.version !== currentIndexVersion();
    if (stale) {
      // 旧索引向量空间/切片边界与当前配置不一致，必须丢弃重建
      console.warn(
        `[RAG] 索引版本不一致（磁盘: ${data.version}，当前: ${currentIndexVersion()}），丢弃旧索引并重建`,
      );
      vectors = [];
      idCounter = 0;
      return { loaded: 0, stale: true };
    }
    vectors = data.vectors || [];
    idCounter = data.idCounter || 0;
    return { loaded: vectors.length, stale: false };
  } catch {
    vectors = [];
    idCounter = 0;
    return { loaded: 0, stale: false };
  }
}

/** 向量数据持久化到磁盘（写入当前索引版本指纹） */
function saveVectors() {
  try {
    fs.mkdirSync(VECTORS_DIR, { recursive: true });
    fs.writeFileSync(
      VECTORS_FILE,
      JSON.stringify(
        { version: currentIndexVersion(), vectors, idCounter },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("[RAG] 向量数据持久化失败:", err.message);
  }
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
      embeddings = createEmbeddings();

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
      loadVectors();

      if (vectors.length > 0) {
        console.log(`[RAG] 向量库已就绪（复用已有 ${vectors.length} 个切片）`);
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
            vectors.push({
              id: `v${++idCounter}`,
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
      saveVectors();
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
      await vectorStore.deleteByDocumentId(doc.id);
      return { indexed: 0 };
    }
    await deleteDocument(doc.id);
    return { indexed: 0 };
  }

  // 切片并生成 embeddings
  const chunks = await chunkDocument(doc);
  if (chunks.length === 0) {
    if (!(config.vector && config.vector.store === "upstash")) saveVectors();
    return { indexed: 0 };
  }
  const texts = chunks.map((c) => c.text);
  const embeddingsArr = await embedDocumentsBatched(texts);

  if (config.vector && config.vector.store === "upstash") {
    // 覆盖更新前先清空该文档旧向量，避免切片数变少时残留孤儿向量
    await vectorStore.deleteByDocumentId(doc.id);

    // prepare items for upsert: id includes document id for traceability
    const items = chunks.map((c, i) => ({
      id: `${doc.id}-v${i + 1}`,
      embedding: embeddingsArr[i],
      metadata: c.metadata,
      text: c.text,
    }));
    await vectorStore.upsertVectors(items);
    return { indexed: items.length };
  }

  // 本地持久化路径（原逻辑）
  vectors = vectors.filter((v) => v.metadata.documentId !== doc.id);
  for (let i = 0; i < chunks.length; i++) {
    vectors.push({
      id: `v${++idCounter}`,
      text: chunks[i].text,
      metadata: chunks[i].metadata,
      embedding: embeddingsArr[i],
    });
  }
  saveVectors();
  return { indexed: chunks.length };
}

/**
 * 文档删除/下线时同步清除向量库中所有相关切片
 * 同样抛出异常以支持队列重试；无切片可删时为空操作
 */
export async function deleteDocument(docId) {
  if (!initialized) return;
  if (config.vector && config.vector.store === "upstash") {
    await vectorStore.deleteByDocumentId(docId);
    return;
  }
  const before = vectors.length;
  vectors = vectors.filter((v) => v.metadata.documentId !== docId);
  if (vectors.length !== before) saveVectors();
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
      const results = await vectorStore.search(queryEmbedding, limit);
      // results: [{id, score, metadata}]
      return results
        .filter((r) => !category || r.metadata.category === category)
        .slice(0, limit)
        .map((r) => ({
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

    if (vectors.length === 0) return [];
    const scored = vectors
      .filter((v) => !category || v.metadata.category === category)
      .map((v) => ({
        ...v,
        score: cosineSimilarity(queryEmbedding, v.embedding),
      }))
      .sort((a, b) => b.score - a.score) // 降序，越大越相似
      .slice(0, limit);
    return scored.map((v) => ({
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
