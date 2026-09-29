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
 * - 已存在：合并 aliases（并集）与 sources（并集），覆盖 type/summary，保持 status=pending
 * 返回最终实体。
 */
export async function upsertEntity({
  name,
  type = "",
  aliases = [],
  summary = "",
  sources = [],
}) {
  if (!name || !normName(name)) return null;
  const now = formatDateTime();
  const existing = await supabase.findEntityByName(name);
  if (existing) {
    const mergedAliases = Array.from(
      new Set([...(existing.aliases || []), ...(aliases || [])]),
    );
    const mergedSources = Array.from(
      new Set([...(existing.sources || []), ...(sources || [])]),
    );
    await supabase.updateEntity(existing.id, {
      type: type || existing.type,
      aliases: mergedAliases,
      summary: summary || existing.summary,
      sources: mergedSources,
      status: "pending",
      updatedAt: now,
    });
    return supabase.findEntity(existing.id);
  }
  return supabase.insertEntity({
    name: name.trim(),
    type,
    aliases: aliases || [],
    summary: summary || "",
    sources: sources || [],
    status: "pending",
    updatedAt: now,
  });
}

export const listEntities = (opts) => supabase.listEntities(opts);

export const getEntity = (id) => supabase.findEntity(toNumberId(id));

/** 确认实体：status → confirmed（此后可被 lookup_entity 检索） */
export async function confirmEntity(id) {
  const entity = await supabase.findEntity(toNumberId(id));
  if (!entity) return null;
  if (entity.status !== "pending") throw badRequest("仅 pending 状态可确认");
  await supabase.updateEntity(entity.id, {
    status: "confirmed",
    updatedAt: formatDateTime(),
  });
  return supabase.findEntity(entity.id);
}

/** 驳回实体：status → rejected（不再参与检索） */
export async function rejectEntity(id) {
  const entity = await supabase.findEntity(toNumberId(id));
  if (!entity) return null;
  if (entity.status !== "pending") throw badRequest("仅 pending 状态可驳回");
  await supabase.updateEntity(entity.id, {
    status: "rejected",
    updatedAt: formatDateTime(),
  });
  return supabase.findEntity(entity.id);
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
 * 已存在则原样返回，不重复写入。
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
  const existing = (await supabase.listRelations({ subjectId: sId, objectId: oId }))
    .find((r) => r.predicate === predicate);
  if (existing) return existing;
  return supabase.insertRelation({
    subjectId: sId,
    predicate,
    objectId: oId,
    sources: sources || [],
    status: "pending",
    updatedAt: formatDateTime(),
  });
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
