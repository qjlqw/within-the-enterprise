/**
 * 知识图谱多跳检索服务（search_graph 工具的数据来源）
 *
 * 职责：
 * - 实体解析：名称/别名精确匹配优先；未命中时按配置回退到
 *   实体 summary 向量召回（仅 confirmed 参与命中）
 * - 多跳邻域：沿 confirmed 关系双向 BFS 扩展（核心逻辑在 knowledgeGraph.js），
 *   跳数夹取到 1~config.graph.maxHops
 * - 来源片段：取实体与关系 sources 文档 id 的并集，逐个取片段，失败跳过不阻断
 *
 * 约定：
 * - 只消费 confirmed 实体与关系，未审核的抽取结果一律不进入检索结果
 * - 任何一步失败不抛异常，统一返回 { status: "not_found" } 风格结果，
 *   让上层工具以 not_found 提示模型如实收口
 * - 不依赖 agent / routes（避免循环引用），只 import db 与 services
 */
import { config } from "../config/index.js";
import {
  lookupConfirmedEntity,
  getEntity,
  getConfirmedNeighborhood,
} from "../db/knowledgeGraph.js";
import {
  getEmbeddings,
  searchNamespace,
  isRagReady,
} from "./embeddingService.js";
import { readDocument } from "./knowledgeService.js";

/** 跳数夹取：1~config.graph.maxHops */
const clampHops = (hops) =>
  Math.max(1, Math.min(config.graph.maxHops, Number(hops) || config.graph.maxHops));

/** 统一的 not_found 返回（提示模型如实告知用户，不得臆测） */
const notFound = (hint) => ({ status: "not_found", hint });

/**
 * 实体解析：
 * 1) 名称/别名精确匹配 confirmed 实体（复用 lookupConfirmedEntity）；
 * 2) 未命中且 config.graph.semanticFallback 开启且 RAG 就绪时，
 *    用实体 summary 向量召回 top5，逐个回查实体并过滤 confirmed，取分数最高者。
 * @returns {Promise<{entity: object, matchedBy: "name"|"semantic", score?: number}|null>}
 */
export async function resolveEntity({ name, signal } = {}) {
  const query = String(name || "").trim();
  if (!query) return null;
  const byName = await lookupConfirmedEntity(query);
  if (byName) return { entity: byName, matchedBy: "name" };
  if (!config.graph.semanticFallback || !isRagReady()) return null;
  signal?.throwIfAborted?.();
  let candidates = [];
  try {
    const embedding = await getEmbeddings().embedQuery(query);
    candidates = await searchNamespace("entity", embedding, 5);
  } catch {
    return null; // 向量通道失败不阻断，视为未命中
  }
  // searchNamespace 按分数降序返回，逐个回查，首个 confirmed 即为结果
  for (const hit of candidates) {
    const entityId = hit?.metadata?.entityId;
    if (entityId == null) continue;
    const entity = await getEntity(entityId);
    if (entity?.status === "confirmed")
      return { entity, matchedBy: "semantic", score: hit.score };
  }
  return null;
}

/**
 * 图谱检索主入口（供 search_graph 工具消费）：
 * 实体解析 → confirmed 多跳邻域 → 来源文档并集 → 逐个取片段（失败跳过）。
 * @param {Object} params
 * @param {string} params.name 实体名/别名
 * @param {number} [params.hops] 跳数，夹取到 1~config.graph.maxHops
 * @param {number} [params.maxCharsPerSource] 每个来源文档片段的最大字符数
 * @returns {Promise<
 *   | {status:"found", entity, matchedBy, score?, neighbors, relations, fragments}
 *   | {status:"not_found", hint: string}
 * >}
 */
export async function searchGraph({ name, hops, maxCharsPerSource = 1200 } = {}) {
  const query = String(name || "").trim();
  if (!query) return notFound("需要提供非空的实体名称。");
  const maxHops = clampHops(hops);
  const maxChars = Math.max(1, Math.min(6000, Number(maxCharsPerSource) || 1200));

  try {
    const resolved = await resolveEntity({ name: query });
    if (!resolved?.entity)
      return notFound(
        "未找到该实体或其已确认的关联关系，如实告知用户，不得臆测。",
      );

    const { entity, matchedBy, score } = resolved;
    const { entities, relations } = await getConfirmedNeighborhood({
      entityId: entity.id,
      hops: maxHops,
    });
    if (!entities?.length)
      return notFound(
        "未找到该实体或其已确认的关联关系，如实告知用户，不得臆测。",
      );

    // 来源文档 id 并集（实体 + 关系），保留首次出现顺序
    const docIds = [];
    const collect = (sources) => {
      for (const id of sources || []) {
        const num = Number(id);
        if (Number.isFinite(num) && !docIds.includes(num)) docIds.push(num);
      }
    };
    for (const e of entities) collect(e.sources);
    for (const r of relations) collect(r.sources);

    // 逐个取片段：源文档已删除/下线则跳过，不阻断实体与关系返回
    const fragments = [];
    for (const docId of docIds) {
      try {
        fragments.push(await readDocument({ documentId: docId, maxChars }));
      } catch {
        // 源文档不再可用：跳过
      }
    }

    return {
      status: "found",
      entity,
      matchedBy,
      ...(score !== undefined ? { score } : {}),
      // neighbors 不含起点实体（entity 字段单独承载）
      neighbors: entities.filter((e) => e.id !== entity.id),
      relations,
      fragments,
    };
  } catch {
    return notFound("图谱检索服务暂时不可用，如实告知用户，不得臆测。");
  }
}
