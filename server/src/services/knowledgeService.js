/**
 * 知识检索服务（agent 工具底层调用）
 *
 * 提供文档检索与正文读取能力，并为 agent 的来源校验提供 sourceIsValid。
 *
 * 关键概念：
 * - fragment：文档片段，包含 documentId / title / version / offset / text / nextOffset
 *   agent 通过 [Sx] 引用片段，回答生成后用 sourceIsValid 校验片段是否仍与原文一致
 *   （文档被改版/删除会导致校验失败，触发重新提问）
 *
 * 检索路径：
 * - searchDocuments        关键词加权检索（标题 5 / 标签 3 / 内容 1）
 * - searchDocumentsHybrid  向量召回 + 关键词加权融合（RAG 启用时优先使用）
 *
 * 安全约束：
 * - 只暴露已发布文档（status === 'published'）
 * - 限制单次读取字符数（maxChars <= 6000），避免一次性吐出全文
 */
import { listDocuments, findDocument } from "../db/index.js";
import { badRequest, notFound } from "../utils/response.js";
import { semanticSearch, isRagReady } from "./embeddingService.js";
import { rerank, isRerankReady } from "./rerankService.js";
import { config } from "../config/index.js";

/** 判断文档是否已发布（agent 仅可访问已发布文档） */
export const isPublished = (doc) => doc?.status === "published";

/**
 * 构造文档片段：从 offset 开始截取 maxChars 字符
 * - truncated：是否还有更多内容
 * - nextOffset：下一段起始偏移，agent 据此分页读取
 */
const fragment = (doc, offset, maxChars) => ({
  documentId: doc.id,
  title: doc.title,
  category: doc.category,
  version: doc.version,
  offset,
  text: doc.content.slice(offset, offset + maxChars),
  truncated: offset + maxChars < doc.content.length,
  nextOffset: offset + maxChars < doc.content.length ? offset + maxChars : null,
});

/**
 * 关键词检索核心实现（不做对外 limit 上限校验，供混合检索扩大召回使用）
 * - 把 query 按空格拆为多个关键词（最多 12 个）
 * - 加权评分：标题命中 +5 / 标签命中 +3 / 内容命中 +1
 * - 取 score>0 的前 limit 个，返回命中位置附近的片段（前 80 字上下文）
 *
 * @param {{ query: string, category?: string, limit?: number }} args
 */
async function keywordSearch({ query, category, limit }) {
  const terms = query.trim().toLowerCase().split(/\s+/u).slice(0, 12);
  const { list: docs } = await listDocuments({
    status: "published",
    category,
  });
  return docs
    .map((doc) => ({
      doc,
      score: terms.reduce(
        (score, term) =>
          score +
          (doc.title.toLowerCase().includes(term) ? 5 : 0) +
          (doc.tags.some((tag) => tag.toLowerCase().includes(term)) ? 3 : 0) +
          (doc.content.toLowerCase().includes(term) ? 1 : 0),
        0,
      ),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.doc.id - b.doc.id)
    .slice(0, limit)
    .map(({ doc }) => {
      // 在原文中找到首个关键词命中位置，向前回退 80 字作为预览起点
      const hits = terms
        .map((term) => doc.content.toLowerCase().indexOf(term))
        .filter((index) => index >= 0);
      return fragment(
        doc,
        Math.max(0, (hits.length ? Math.min(...hits) : 0) - 80),
        500,
      );
    });
}

/**
 * 关键词检索文档（对外工具入口：limit 硬上限 10）
 *
 * @param {{ query: string, category?: string, limit?: number }} args
 */
export async function searchDocuments({ query, category, limit = 2 }) {
  if (typeof query !== "string" || !query.trim() || query.length > 200)
    throw badRequest("Invalid query");
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw badRequest("Invalid limit");
  return keywordSearch({ query, category, limit });
}

/**
 * 按文档 id 读取正文片段
 * - 仅返回 offset 起的 maxChars 字符，便于 agent 分段读取长文档
 * - maxChars 上限 6000，避免单次返回过长
 */
export async function readDocument({ documentId, offset = 0, maxChars = 6000 }) {
  if (
    !Number.isSafeInteger(documentId) ||
    documentId < 1 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(maxChars) ||
    maxChars < 1 ||
    maxChars > 6000
  )
    throw badRequest("Invalid document range");
  const doc = await findDocument(documentId);
  if (!isPublished(doc)) throw notFound("文档不存在或未发布");
  return fragment(doc, offset, maxChars);
}

/**
 * 校验来源是否仍然有效：
 * 1) 文档存在且仍为已发布
 * 2) 版本号、标题与对应片段文本与来源记录时一致
 *
 * 任一条件不满足代表文档已被改版/删除，旧来源失效。
 */
export async function sourceIsValid(source) {
  const doc = await findDocument(source.documentId);
  return (
    isPublished(doc) &&
    doc.version === source.version &&
    doc.title === source.title &&
    doc.content.slice(source.offset, source.offset + source.text.length) ===
      source.text
  );
}

/**
 * 混合检索：向量召回 + 关键词加权融合 + Rerank 精排（可选）
 *
 * 流程：
 * 1) 向量召回 semanticSearch，候选池大小取 config.rag.recallTopK
 *    （RAG_RECALL_TOP_K，默认 20；与最终返回条数 limit 独立配置）
 * 2) 关键词召回同样取候选池大小（内部实现允许超过工具层 10 条上限）
 * 3) 分数归一化 + 加权融合
 *    - 向量：余弦相似度（0~1）
 *    - 关键词：原 score（标题 5/标签 3/内容 1）按最大值归一化
 *    - finalScore = vectorWeight*vecSim + keywordWeight*kwNorm
 * 4) 按 documentId 去重（同一文档只保留高分片段）
 * 5) RERANK_ENABLED=true 时，对候选池做 cross-encoder 精排后取前 limit 条
 *
 * 降级：
 * - 向量库不可用或 RAG 未启用（semanticSearch 返回空）→ 纯关键词检索
 * - rerank 未配置/超时/报错 → 使用融合分排序，不阻断主流程
 *
 * @param {{ query: string, category?: string, limit?: number, signal?: AbortSignal }} args
 */
export async function searchDocumentsHybrid({
  query,
  category,
  limit = 2,
  signal,
}) {
  // [rerank-diag] hybrid 入口：RAG 开关/就绪状态/召回配置
  console.log(
    `[rerank-diag] hybrid-enter ragEnabled=${config.rag.enabled} ragReady=${isRagReady()} recallTopK=${config.rag.recallTopK} limit=${limit} topK=${config.rag.topK}`,
  );
  if (typeof query !== "string" || !query.trim() || query.length > 200)
    throw badRequest("Invalid query");
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw badRequest("Invalid limit");

  // 候选池大小：独立配置的召回数，至少满足最终返回条数
  const candidateLimit = Math.max(config.rag.recallTopK, limit);

  // 先尝试向量召回
  const vecResults = await semanticSearch({
    query,
    category,
    limit: candidateLimit,
  }).catch((err) => {
    // [rerank-diag] 向量召回异常：RAG 初始化失败/embedding 调用报错都会走这里
    console.log(`[rerank-diag] semanticSearch-error: ${err?.message || err}`);
    return [];
  });

  // [rerank-diag] 向量召回结果：为空就会直接短路到关键词检索，rerank 永远不执行
  console.log(`[rerank-diag] vecResults count=${vecResults.length}`);

  // 向量库不可用 → 直接降级关键词检索
  if (vecResults.length === 0) {
    console.log(
      `[rerank-diag] fallback-to-keyword: 向量召回为空，走纯关键词检索（rerank 不会执行）`,
    );
    return searchDocuments({ query, category, limit });
  }

  // 关键词召回（内部已做加权评分，但返回 fragment 不带 score，这里重算）
  const kwRaw = await keywordSearch({ query, category, limit: candidateLimit });
  const terms = query.trim().toLowerCase().split(/\s+/u).slice(0, 12);
  const kwWithScore = await Promise.all(
    kwRaw.map(async (frag) => {
      const doc = await findDocument(frag.documentId);
      const score = terms.reduce(
        (s, t) =>
          s +
          (doc.title.toLowerCase().includes(t) ? 5 : 0) +
          (doc.tags.some((tag) => tag.toLowerCase().includes(t)) ? 3 : 0) +
          (doc.content.toLowerCase().includes(t) ? 1 : 0),
        0,
      );
      return { ...frag, kwScore: score };
    }),
  );

  // 归一化：向量相似度已在 (0,1]；关键词按最大值归一化
  const maxKw = Math.max(...kwWithScore.map((r) => r.kwScore), 1);
  const { vectorWeight, keywordWeight } = config.rag;

  // 转成以 documentId 为键的 Map，便于去重并保留高分片段
  const merged = new Map();
  for (const r of vecResults) {
    const vecSim = r.score || 0; // semanticSearch 返回余弦相似度（越大越相似）
    const finalScore = vectorWeight * vecSim;
    const existing = merged.get(r.documentId);
    if (!existing || finalScore > existing.finalScore) {
      const { score: _score, ...frag } = r;
      merged.set(r.documentId, { ...frag, finalScore });
    }
  }
  for (const r of kwWithScore) {
    const normKw = r.kwScore / maxKw;
    const finalScore = keywordWeight * normKw;
    const existing = merged.get(r.documentId);
    if (!existing) {
      const { kwScore: _kw, ...frag } = r;
      merged.set(r.documentId, { ...frag, finalScore });
    } else {
      // 同时被两路召回：融合分叠加；片段沿用向量版本（与切片文本一致，引用校验更稳）
      merged.set(r.documentId, {
        ...existing,
        finalScore: existing.finalScore + finalScore,
      });
    }
  }

  const candidates = [...merged.values()].sort(
    (a, b) => b.finalScore - a.finalScore,
  );

  // Rerank 精排：候选多于最终条数时才有重排价值；任何失败都回退融合排序
  let ordered = candidates;
  // [rerank-diag] 分支诊断：candidates/limit/ready/vecResults/kwWithScore 真实值
  console.log(
    `[rerank-diag] branch ready=${isRerankReady()} candidates=${candidates.length} limit=${limit} vecResults=${vecResults.length} kwResults=${kwWithScore.length} ragReady=${isRagReady()}`,
  );
  if (isRerankReady() && candidates.length > limit) {
    try {
      const pairs = await rerank({
        query,
        documents: candidates.map((item) => item.text),
        topN: Math.min(
          candidates.length,
          Math.max(limit, config.rag.rerankTopN),
        ),
        signal,
      });
      if (pairs?.length) {
        const reranked = pairs.map(({ index, score }) => ({
          ...candidates[index],
          rerankScore: score,
        }));
        // 精排未覆盖的候选（top_n 小于候选数）按融合分追加在后面，避免直接丢失
        const covered = new Set(pairs.map(({ index }) => index));
        for (const [index, item] of candidates.entries()) {
          if (!covered.has(index)) reranked.push(item);
        }
        ordered = reranked;
      }
    } catch {
      // 降级：保留融合排序（error 已在 rerankService 内记录监控）
      ordered = candidates;
    }
  }

  return ordered
    .slice(0, limit)
    .map(({ finalScore: _fs, rerankScore: _rs, ...frag }) => frag);
}
