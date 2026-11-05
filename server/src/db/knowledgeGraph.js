/**
 * LLM Wiki 知识图谱业务层（Entity + Relation）
 *
 * 职责：
 * - 在 supabase 适配器的原始持久化方法之上，实现「去重 + 状态硬约束」。
 * - LLM 写回一律 status='pending'，仅 confirmed 参与检索（由上层工具过滤）。
 * - 实体按 name（大小写不敏感）去重；关系按三元组去重。
 *
 * 本模块与 db/index.js 并列，复用 supabase 与 utils/date.js，
 * 不依赖 db/index.js，避免循环引用。
 */
import { formatDateTime } from "../utils/date.js";
import { badRequest } from "../utils/response.js";
import * as supabase from "./supabase.js";

const toNumberId = (id) => parseInt(String(id), 10);

/** 归一化实体名，用于去重比较（trim + 小写） */
const normName = (name) => String(name || "").trim().toLowerCase();

/**
 * 写入 / 更新实体（按 name 去重）：
 * - 不存在：插入（status=pending）
 * - 已存在：合并 aliases / sources（并集），保留人工审核结论
 *   · confirmed / rejected 的实体不会被抽取覆盖状态、摘要、类型
 *   · pending 实体首次摘要生效；后续来源口径不同则保留首个摘要并标记 needsReview
 *   · 每个来源文档的摘要口径记录在 summaryBySource，供审核对比
 * 返回最终实体。
 */
export async function upsertEntity({
  name,
  type = "",
  aliases = [],
  summary = "",
  sources = [],
  sourceId = null,
}) {
  if (!name || !normName(name)) return null;
  const merged = {
    type,
    aliases: aliases || [],
    summary: summary || "",
    sources: sources || [],
    sourceId,
    now: formatDateTime(),
  };
  const existing = await supabase.findEntityByName(name);
  if (existing) return mergeIntoEntity(existing, merged);
  try {
    return await supabase.insertEntity({
      name: name.trim(),
      type: merged.type,
      aliases: merged.aliases,
      summary: merged.summary,
      sources: merged.sources,
      status: "pending",
      summaryBySource: merged.sourceId != null && merged.summary
        ? { [String(merged.sourceId)]: merged.summary }
        : {},
      updatedAt: merged.now,
    });
  } catch (err) {
    // 并发下另一任务已插入同名实体：唯一约束（23505）后转为合并
    if (err?.code === "23505") {
      const again = await supabase.findEntityByName(name);
      if (again) return mergeIntoEntity(again, merged);
    }
    throw err;
  }
}

/** 摘要口径归一化，仅用于“是否发生变化”的比较 */
const normSummary = (text) => String(text || "").replace(/\s+/g, " ").trim();

/** 合并到已存在实体：人工结论优先，抽取只补充不破坏 */
async function mergeIntoEntity(existing, { type, aliases, summary, sources, sourceId, now }) {
  const humanDecided = existing.status === "confirmed" || existing.status === "rejected";
  const mergedAliases = Array.from(
    new Set([...(existing.aliases || []), ...(aliases || [])]),
  );
  const mergedSources = Array.from(
    new Set(
      [...(existing.sources || []), ...(sources || [])]
        .map(Number)
        .filter((id) => Number.isFinite(id)),
    ),
  );

  const summaryBySource = { ...(existing.summaryBySource || {}) };
  if (sourceId != null && summary) {
    summaryBySource[String(sourceId)] = summary;
  }

  let nextSummary = existing.summary || "";
  let needsReview = existing.needsReview === true;
  if (!humanDecided) {
    if (!nextSummary) {
      nextSummary = summary || "";
    } else if (summary && normSummary(summary) !== normSummary(nextSummary)) {
      // 不同来源给出不同口径：保留首个摘要，交人工复检
      needsReview = true;
    }
  }

  await supabase.updateEntity(existing.id, {
    type: humanDecided ? existing.type : (type || existing.type),
    aliases: mergedAliases,
    summary: nextSummary,
    sources: mergedSources,
    summaryBySource,
    needsReview,
    // 关键：不把人工结论打回 pending
    status: existing.status,
    updatedAt: now,
  });
  return supabase.findEntity(existing.id);
}

export const listEntities = (opts) => supabase.listEntities(opts);

export const getEntity = (id) => supabase.findEntity(toNumberId(id));

/** 确认实体：status → confirmed（此后可被 lookup_entity 检索） */
export async function confirmEntity(id) {
  const entity = await supabase.findEntity(toNumberId(id));
  if (!entity) return null;
  if (entity.status !== "pending") throw badRequest("仅 pending 状态可确认");
  // 条件更新：两个审核人同时操作时，后到者会失败而不是覆盖前者
  const updated = await supabase.updateEntityIfStatus(entity.id, "pending", {
    status: "confirmed",
    needsReview: false,
    updatedAt: formatDateTime(),
  });
  if (!updated) throw badRequest("实体状态已变更，请刷新后重试");
  return updated;
}

/** 驳回实体：status → rejected（不再参与检索） */
export async function rejectEntity(id) {
  const entity = await supabase.findEntity(toNumberId(id));
  if (!entity) return null;
  if (entity.status !== "pending") throw badRequest("仅 pending 状态可驳回");
  const updated = await supabase.updateEntityIfStatus(entity.id, "pending", {
    status: "rejected",
    needsReview: false,
    updatedAt: formatDateTime(),
  });
  if (!updated) throw badRequest("实体状态已变更，请刷新后重试");
  return updated;
}

/** 批量确认实体（pending/rejected → confirmed） */
export async function confirmEntities(ids) {
  return await Promise.all(ids.map(confirmEntity));
}

/** 批量驳回实体（pending → rejected） */
export async function rejectEntities(ids) {
  return await Promise.all(ids.map(rejectEntity));
}



/**
 * 写入关系（按 subjectId + predicate + objectId 三元组去重）：
 * 已存在则合并 sources 后返回，不重复写入。
 * 并发下若唯一约束冲突（23505），重新查询后按已存在处理。
 */
export async function upsertRelation({
  subjectId,
  predicate,
  objectId,
  sources = [],
}) {
  const sId = toNumberId(subjectId);
  const oId = toNumberId(objectId);
  if (!sId || !oId || !predicate) return null;
  const now = formatDateTime();
  const existing = (await supabase.listRelations({ subjectId: sId, objectId: oId }))
    .find((r) => r.predicate === predicate);
  if (existing) return mergeRelationSources(existing, sources, now);
  try {
    return await supabase.insertRelation({
      subjectId: sId,
      predicate,
      objectId: oId,
      sources: sources || [],
      status: "pending",
      updatedAt: now,
    });
  } catch (err) {
    if (err?.code === "23505") {
      const again = (await supabase.listRelations({ subjectId: sId, objectId: oId }))
        .find((r) => r.predicate === predicate);
      if (again) return mergeRelationSources(again, sources, now);
    }
    throw err;
  }
}

/** 关系来源并集，避免重复写入时丢来源 */
async function mergeRelationSources(existing, sources, now) {
  const merged = Array.from(
    new Set(
      [...(existing.sources || []), ...(sources || [])]
        .map(Number)
        .filter((id) => Number.isFinite(id)),
    ),
  );
  if (merged.length === (existing.sources || []).length) return existing;
  await supabase.updateRelation(existing.id, { sources: merged, updatedAt: now });
  return { ...existing, sources: merged };
}

/**
 * 文档下线/删除后，从实体与关系的 sources 中移除该文档；
 * 关系来源为空时删除关系，实体来源为空时标记 needsReview 交人工处理。
 */
export async function detachDocumentSources(documentId) {
  const docId = toNumberId(documentId);
  if (!docId) return { entities: 0, relations: 0 };
  const now = formatDateTime();

  const entities = await supabase.listEntitiesBySource(docId);
  let entityCount = 0;
  for (const entity of entities) {
    const sources = (entity.sources || [])
      .map(Number)
      .filter((id) => Number.isFinite(id) && id !== docId);
    const summaryBySource = { ...(entity.summaryBySource || {}) };
    delete summaryBySource[String(docId)];
    await supabase.updateEntity(entity.id, {
      sources,
      summaryBySource,
      needsReview: sources.length === 0 ? true : entity.needsReview,
      updatedAt: now,
    });
    entityCount += 1;
  }

  const relations = await supabase.listRelationsBySource(docId);
  let relationCount = 0;
  for (const relation of relations) {
    const sources = (relation.sources || [])
      .map(Number)
      .filter((id) => Number.isFinite(id) && id !== docId);
    if (sources.length === 0) {
      await supabase.deleteRelationById(relation.id);
    } else {
      await supabase.updateRelation(relation.id, { sources, updatedAt: now });
    }
    relationCount += 1;
  }

  return { entities: entityCount, relations: relationCount };
}

export const listRelations = (opts) => supabase.listRelations(opts);

/**
 * 按名称或别名查找「已确认」实体（仅 status === 'confirmed'）。
 * - 优先名称精确匹配（大小写不敏感）
 * - 未命中或未确认时，在 confirmed 实体中按别名（含名称）归一匹配
 * 返回实体或 null（供 lookup_entity 工具使用）。
 */
export async function lookupConfirmedEntity(name) {
  const query = normName(name);
  if (!query) return null;
  const byName = await supabase.findEntityByName(name);
  if (byName && byName.status === "confirmed") return byName;
  const { list } = await supabase.listEntities({
    status: "confirmed",
    page: 1,
    pageSize: 500,
  });
  return (
    list.find((e) =>
      [e.name, ...(e.aliases || [])].some((n) => normName(n) === query),
    ) || null
  );
}
