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
 *
 * 成本治理（11-06 报告 B1 检索下推）：
 * - 不再全量拉取所有已发布文档到内存打分，而是把拆词结果作为 keywords
 *   下推到 SQL 层过滤（title.ilike / content.ilike / tags.cs 的 or 表达式），
 *   仅拉取命中文档（candidatePageSize 量级可控）再做加权评分排序。
 * - 拆词最多 12 个关键词，与 supabase.listDocuments 的 keywords 选项对齐。
 *
 * @param {{ query: string, category?: string, limit?: number }} args
 * @returns {Promise<Array<{ frag: Object, kwScore: number }>>}
 */
async function keywordSearchScored({ query, category, limit }) {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .slice(0, 12)
    .filter(Boolean);
  // 拆词后全部为空（理论上入口已校验非空，这里兜底防全表拉取）
  if (!terms.length) return [];

  // 候选池：SQL 已过滤出命中文档，量级可控；下限保证对外 limit 的 4 倍召回
  const candidatePageSize = Math.min(Math.max(limit * 4, 50), 200);
  const { list: docs } = await listDocuments({
    status: "published",
    category,
    keywords: terms,
    page: 1,
    pageSize: candidatePageSize,
  });

  return docs
    .map((doc) => {
      const lowerTitle = doc.title.toLowerCase();
      const lowerTags = doc.tags.map((tag) => tag.toLowerCase());
      const lowerContent = doc.content.toLowerCase();
      // 加权评分：标题命中 +5 / 标签命中 +3 / 内容命中 +1；同时记录首个命中位置
      let score = 0;
      let firstHit = -1;
      for (const term of terms) {
        if (lowerTitle.includes(term)) score += 5;
        if (lowerTags.some((tag) => tag.includes(term))) score += 3;
        const hit = lowerContent.indexOf(term);
        if (hit >= 0) {
          score += 1;
          if (firstHit < 0 || hit < firstHit) firstHit = hit;
        }
      }
      // 在原文中找到首个关键词命中位置，向前回退 80 字作为预览起点
      const frag = fragment(
        doc,
        Math.max(0, (firstHit >= 0 ? firstHit : 0) - 80),
        500,
      );
      return { frag, kwScore: score };
    })
    .filter(({ kwScore }) => kwScore > 0)
    .sort(
      (a, b) =>
        b.kwScore - a.kwScore || a.frag.documentId - b.frag.documentId,
    )
    .slice(0, limit);
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
  return (await keywordSearchScored({ query, category, limit })).map(
    ({ frag }) => frag,
  );
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
 * 精排结果按相关性下限过滤（导出以便单测覆盖核心过滤逻辑）
 * - 低于 floor 的候选视为噪声直接淘汰
 * - 不做「未覆盖候选按融合分补位」：尾部候选即噪声，宁可少返回也不硬凑满
 * - 全部低于 floor 时返回空数组，由调用方走关键词兜底
 * @param {Array} candidates 候选池（pairs.index 对应其下标）
 * @param {Array<{ index: number, score: number }>|null} pairs rerank 返回结果
 * @param {number} floor 相关性下限
 * @returns {Array} 过滤后的候选（附带 rerankScore）
 */
export function applyRerankFloor(candidates, pairs, floor) {
  return (pairs || [])
    .filter(({ score }) => score >= floor)
    .map(({ index, score }) => ({ ...candidates[index], rerankScore: score }));
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
 * 5) RERANK_ENABLED=true 时，对候选池做 cross-encoder 精排，
 *    按 rerankScoreFloor 淘汰低相关结果后取前 limit 条
 *
 * 降级：
 * - 向量库不可用或 RAG 未启用（semanticSearch 返回空）→ 纯关键词检索
 * - rerank 未配置/超时/报错 → 使用融合分排序，不阻断主流程
 * - 各层阈值过滤后结果为空 → 关键词兜底，保证检索路径不空转
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

  // 关键词召回（评分与切片一次完成，直接消费 kwScore，不再逐条回查文档）
  const kwWithScore = (
    await keywordSearchScored({ query, category, limit: candidateLimit })
  ).map(({ frag, kwScore }) => ({ ...frag, kwScore }));

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

  // Rerank 精排：只要 rerank 可用且候选非空就执行——它不仅是排序器，
  // 也是 rerankScoreFloor 的执行者（负向查询靠它整体否决候选池）；
  // 失败/超时回退融合排序
  let ordered = candidates;
  // [rerank-diag] 分支诊断：candidates/limit/ready/vecResults/kwWithScore 真实值
  console.log(
    `[rerank-diag] branch ready=${isRerankReady()} candidates=${candidates.length} limit=${limit} vecResults=${vecResults.length} kwResults=${kwWithScore.length} ragReady=${isRagReady()} scoreFloor=${config.rag.scoreFloor} rerankFloor=${config.rag.rerankScoreFloor}`,
  );
  if (isRerankReady() && candidates.length > 0) {
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
      // 精排结果按相关性下限过滤：低于 rerankScoreFloor 的候选视为噪声直接淘汰；
      // 不再把精排未覆盖的尾部候选按融合分补位回来（尾部候选 = 噪声）。
      const reranked = applyRerankFloor(
        candidates,
        pairs,
        config.rag.rerankScoreFloor,
      );
      // 精排成功即采纳其结果（含空）：全部低于下限说明候选池整体与查询不相关，
      // ordered 置空后由「最终结果为空 → 关键词兜底」统一收口
      ordered = reranked;
    } catch {
      // 降级：保留融合排序（error 已在 rerankService 内记录监控）
      ordered = candidates;
    }
  }

  const final = ordered
    .slice(0, limit)
    .map(({ finalScore: _fs, rerankScore: _rs, ...frag }) => frag);

  // 兜底：召回/精排层层过滤后可能颗粒无收（阈值淘汰所有候选），
  // 回退到关键词检索（自带 score>0 门槛），保证检索路径不空转
  if (final.length === 0) {
    console.log(
      `[rerank-diag] fallback-to-keyword: 阈值过滤后候选为空，走纯关键词检索`,
    );
    return searchDocuments({ query, category, limit });
  }
  return final;
}
