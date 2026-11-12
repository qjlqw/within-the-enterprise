/**
 * LLM Wiki 抽取 schema 白名单（P0-0 业务方确认初版，2026-11-12）
 *
 * 依据：现网 relations.predicate / entities.type 分布
 *   - predicate：包含21 / 依赖16 / 属于5 / 涉及、调用、查询、写入、产出、
 *     支撑、进入、附带各2 / 审计、负责、缺失、配合、先于、参与、区别于、校验各1
 *   - type：概念34 / 其他5 / 事件5 / 产品3
 *
 * 约束（禁止项 #4 / 排期 P0-3）：
 * - 代码级枚举校验，LLM 不得自创 type / predicate
 * - 白名单外「降级不丢弃」：type → 其他，predicate → 关联；
 *   原词经审计（extract_schema.*_degraded）保留，供人工审核与后续扩白名单
 * - 扩白名单：直接在下方数组追加并同步更新 extractionService 提示词
 */

/** 实体类型白名单（降级兜底：其他） */
export const ENTITY_TYPES = ["概念", "事件", "产品", "其他"];
export const ENTITY_TYPE_FALLBACK = "其他";

/** 关系谓词白名单（降级兜底：关联，仅作代码级兜底，不进提示词避免滥用） */
export const RELATION_PREDICATES = [
  "包含",
  "依赖",
  "属于",
  "涉及",
  "调用",
  "查询",
  "写入",
  "产出",
  "支撑",
  "进入",
  "附带",
  "审计",
  "负责",
  "缺失",
  "配合",
  "先于",
  "参与",
  "区别于",
  "校验",
];
export const RELATION_PREDICATE_FALLBACK = "关联";

/**
 * 实体类型白名单校验：trim 后精确匹配；白名单外降级为兜底类型
 * @param {string} raw LLM 抽取的原始 type
 * @returns {{ type: string, degraded: boolean, raw: string }}
 */
export function normalizeEntityType(raw) {
  const value = String(raw || "").trim();
  if (value && ENTITY_TYPES.includes(value)) {
    return { type: value, degraded: false, raw: value };
  }
  return { type: ENTITY_TYPE_FALLBACK, degraded: true, raw: value };
}

/**
 * 关系谓词白名单校验：trim 后精确匹配；白名单外降级为兜底谓词
 * @param {string} raw LLM 抽取的原始 predicate
 * @returns {{ predicate: string, degraded: boolean, raw: string }}
 */
export function normalizePredicate(raw) {
  const value = String(raw || "").trim();
  if (value && RELATION_PREDICATES.includes(value)) {
    return { predicate: value, degraded: false, raw: value };
  }
  return { predicate: RELATION_PREDICATE_FALLBACK, degraded: true, raw: value };
}
