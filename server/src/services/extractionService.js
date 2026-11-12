/**
 * LLM Wiki 知识抽取服务
 *
 * 职责：
 * - 文档发布后，从正文中用 LLM 抽取实体（name/type/aliases/summary）与关系三元组
 * - 长文档按语义边界分片、逐片抽取后合并去重：单次调用体量可控，单分片失败只跳过不拖垮整篇
 * - 抽取结果去重后写入 entities / relations（status 一律 pending，sources=[docId]）
 * - 实体 summary 向量化写入 "entity" namespace（供未来语义检索，P0 以名称/别名检索为主）
 *
 * 队列语义复用 indexQueue 的 createQueue 工厂：
 * - 串行执行 + 指数退避重试 + 审计（extract_job.*）+ 失败标记
 * - 从 HTTP 请求链路剥离：路由只入队，后台执行，失败不影响文档发布
 *
 * 安全约束：
 * - 抽取结果一律 status='pending'，仅人工 confirmed 后参与 lookup_entity 检索
 * - 抽取失败只审计，不污染实体库
 * - schema 白名单（P0-3，见 wikiSchema.js）：type/predicate 白名单外降级不丢弃，
 *   原词经 extract_schema.*_degraded 审计保留
 * - 原文支撑校验（P0-4）：实体 name/alias 与关系 subject/predicate/object 必须
 *   在原始分片文本中出现；未命中实体打 needsReview 待审，关系审计留痕（pending 本就待审）
 */
import { ChatOpenAI } from "@langchain/openai";
import { config } from "../config/index.js";
import {
  findDocument,
  upsertEntity,
  upsertRelation,
  setDocumentExtractedVersion,
} from "../db/index.js";
import {
  getEmbeddings,
  upsertNamespaceVectors,
  isRagReady,
} from "./embeddingService.js";
import { createQueue } from "./indexQueue.js";
import { audit, recordError } from "./observability.js";
import { normalizeEntityType, normalizePredicate } from "./wikiSchema.js";

/** 输入给 LLM 的文档正文字符上限（控制成本与延迟） */
const MAX_INPUT_CHARS = 12000;

/** 单个分片的目标字符数：控制单次 LLM 调用体量，长文档不再整篇一次抽取 */
const CHUNK_CHARS = 3000;

/** 单个分片抽取失败（超时/网络异常/不可解析）时的立即补抽次数 */
const CHUNK_MAX_RETRIES = 1;

/** 抽取系统提示词：要求只输出一个 JSON 对象 */
const EXTRACTION_SYSTEM_PROMPT = `你是知识库结构化抽取助手。从给定文档正文中抽取实体与实体间关系，只输出一个 JSON 对象，不要输出任何解释、前后缀或 Markdown 代码块。

输出格式（严格）：
{
  "entities": [
    { "name": "实体名", "type": "概念|事件|产品|其他", "aliases": ["别名1"], "summary": "一句话概括该实体" }
  ],
  "relations": [
    { "subject": "主体实体名", "predicate": "关系谓词", "object": "客体实体名" }
  ]
}

要求：
1. 实体名与别名必须与原文用词一致，不要改写。
2. summary 用一句话客观概括，不掺入推测。
3. 关系两端必须引用 entities 中已出现的实体名。
4. 实体 type 只能取：概念 / 事件 / 产品 / 其他，不得自创。
5. 关系 predicate 只能从以下白名单中选择：包含、依赖、属于、涉及、调用、查询、写入、产出、支撑、进入、附带、审计、负责、缺失、配合、先于、参与、区别于、校验，不得自创。
6. 只抽取对知识库有价值的概念，实体一般不超过 20 个。`;

/** 归一化名称，用于实体去重与关系两端解析 */
const norm = (s) => String(s || "").trim().toLowerCase();

/** 从模型输出中剥离代码围栏并解析 JSON 对象；失败返回 null */
function parseExtraction(text) {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 按语义边界切分正文：优先段落（换行）边界，超长段落退到句子边界，
 * 避免把实体/表述拦腰截断导致抽取遗漏或半截实体。
 * @param {string} text 待切分正文
 * @param {number} size 目标分片字符数（软上限，无标点超长句仍会被硬切）
 * @returns {string[]} 非空分片数组
 */
function splitIntoChunks(text, size) {
  const chunks = [];
  let buf = "";
  const push = (piece) => {
    let trimmed = (piece || "").trim();
    // 超长片按 size 硬切，宁可截断也要控制单次调用体量
    while (trimmed.length > size) {
      chunks.push(trimmed.slice(0, size));
      trimmed = trimmed.slice(size).trim();
    }
    if (trimmed) chunks.push(trimmed);
  };
  const flushBuf = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = "";
  };
  for (const para of text.split(/\n+/)) {
    if (!para) continue;
    if (para.length > size) {
      // 段落超长：按句读边界（。！？；）贪心合并成不超过 size 的片
      flushBuf();
      let piece = "";
      for (const sentence of para.split(/(?<=[。！？；])/)) {
        if (piece && piece.length + sentence.length > size) {
          push(piece);
          piece = "";
        }
        piece += sentence;
      }
      push(piece);
    } else if (buf && buf.length + para.length + 1 > size) {
      flushBuf();
      buf = para;
    } else {
      buf += (buf ? "\n" : "") + para;
    }
  }
  flushBuf();
  return chunks;
}

/**
 * 原文支撑校验（P0-4）：标注单个分片抽取结果的原文支撑情况。
 * - 实体：name 或任一 alias 必须在原始 chunk 文本中出现（别名匹配覆盖表述变体）
 * - 关系：subject / predicate / object 三者都必须在该 chunk 文本中出现
 * - 不通过仅标注 supported=false，不丢弃：写库时实体打 needsReview 待审，
 *   关系保持 pending（本就待审）并审计，原词可追溯
 * @param {Object} parsed parseExtraction 结果（原地标注）
 * @param {string} chunkText 该结果来源的原始分片文本
 */
function annotateExtractionSupport(parsed, chunkText) {
  const text = String(chunkText || "");
  const hit = (word) => {
    const w = String(word || "").trim();
    return w.length > 0 && text.includes(w);
  };
  for (const e of parsed?.entities || []) {
    e.supported =
      hit(e?.name) ||
      (Array.isArray(e?.aliases) && e.aliases.some((alias) => hit(alias)));
  }
  for (const r of parsed?.relations || []) {
    r.supported = hit(r?.subject) && hit(r?.predicate) && hit(r?.object);
  }
}

/**
 * 合并多个分片的抽取结果：
 * - 实体按归一化名称去重（跨分片重复出现的同一实体只保留一条），别名取并集、摘要取信息量更大的一条；
 *   原文支撑取并集（任一分片命中即视为有支撑，P0-4）
 * - 关系原样收集（保留所在分片的 supported 标注），两端实体解析推迟到合并后统一进行（因此支持跨分片关系）
 * @param {Array<Object|null>} batches 各分片 parseExtraction 的结果
 * @returns {{ entities: Array<Object>, relations: Array<Object> }}
 */
function mergeExtraction(batches) {
  const byNorm = new Map();
  for (const parsed of batches) {
    for (const e of parsed?.entities || []) {
      if (!e?.name || !norm(e.name)) continue;
      const found = byNorm.get(norm(e.name));
      if (!found) {
        byNorm.set(norm(e.name), {
          name: e.name,
          type: e.type || "",
          aliases: new Set((e.aliases || []).filter(Boolean)),
          summary: e.summary || "",
          supported: e.supported === true,
        });
      } else {
        for (const alias of e.aliases || []) if (alias) found.aliases.add(alias);
        if ((e.summary || "").length > found.summary.length) found.summary = e.summary;
        if (e.supported === true) found.supported = true;
      }
    }
  }
  const relations = batches
    .flatMap((parsed) => parsed?.relations || [])
    .filter((r) => r?.subject && r?.predicate && r?.object);
  return {
    entities: [...byNorm.values()].map((e) => ({ ...e, aliases: [...e.aliases] })),
    relations,
  };
}

/**
 * 抽取单个分片：失败（超时/网络异常/JSON 不可解析）按 CHUNK_MAX_RETRIES 立即补抽，
 * 仍失败返回 null 并审计，由调用方决定跳过（不影响其余分片）。
 * @param {import('@langchain/openai').ChatOpenAI} llm
 * @param {string} content 分片正文
 * @param {number} docId 文档 id（审计用）
 * @returns {Promise<Object|null>} parseExtraction 结果；失败为 null
 */
async function extractChunk(llm, content, docId) {
  let lastError = null;
  for (let attempt = 1; attempt <= CHUNK_MAX_RETRIES + 1; attempt++) {
    try {
      const response = await llm.invoke([
        ["system", EXTRACTION_SYSTEM_PROMPT],
        ["human", content],
      ]);
      const parsed = parseExtraction(response?.content);
      if (parsed && Array.isArray(parsed.entities)) return parsed;
      lastError = new Error("unparsable");
    } catch (err) {
      lastError = err;
    }
  }
  recordError("extract_chunk", lastError, { docId, attempts: CHUNK_MAX_RETRIES + 1 });
  audit("extract_job.chunk_failed", {
    docId,
    error: String(lastError?.message || lastError).slice(0, 300),
  });
  return null;
}

/** 分批 embed 文本（DashScope 单次上限 10 条），返回与入参顺序对齐的向量数组 */
const EMBED_BATCH_SIZE = 10;
async function embedTexts(embeddings, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embeddings.embedDocuments(batch);
    for (const v of vectors) out.push(v);
  }
  return out;
}

/**
 * 抽取执行器（队列 handler）：
 * 读文档 → 分片逐段 LLM 抽取 → 合并去重写实体/关系 → summary 向量化写 entity namespace
 * @param {{ docId: number }} payload
 * @returns {Promise<{ entities: number, relations: number, indexed: number }>}
 */
async function runExtraction({ docId }) {
  const doc = await findDocument(docId);
  // 文档被删除/下线：无需抽取
  if (!doc || doc.status !== "published") {
    return { entities: 0, relations: 0, indexed: 0 };
  }
  // 幂等：同一版本文档已抽取过则直接跳过（重复入队/手动重试不再触发 LLM 调用）
  if (
    doc.extractedVersion != null &&
    Number(doc.extractedVersion) === Number(doc.version)
  ) {
    audit("extract_job.skipped", {
      docId,
      reason: "already_extracted",
      version: doc.version,
    });
    return { entities: 0, relations: 0, indexed: 0, skipped: true };
  }
  // 模型未配置时跳过（避免无限重试），仅审计
  const { model, apiKey, baseURL } = config.agent;
  if (!model || !apiKey || !baseURL) {
    audit("extract_job.skipped", { docId, reason: "model_not_configured" });
    return { entities: 0, relations: 0, indexed: 0 };
  }

  const llm = new ChatOpenAI({
    model,
    apiKey,
    configuration: { baseURL },
    streaming: false,
    maxTokens: 2000,
    maxRetries: 0,
    // 后台任务超时独立于前端问答（AGENT_RUN_TIMEOUT_MS），长文档抽取需要更宽预算
    timeout: config.wiki.extractionTimeoutMs,
    temperature: 0,
  });

  // 分片抽取：单次调用只处理一个分片，体量可控、失败可补抽；
  // 单个分片失败仅跳过并审计，不影响其余分片产出
  const chunks = splitIntoChunks(doc.content.slice(0, MAX_INPUT_CHARS), CHUNK_CHARS);
  if (!chunks.length) {
    // 正文为空（或仅空白）：无抽取对象，直接记审计返回，不进入重试
    audit("extract_job.empty", { docId });
    return { entities: 0, relations: 0, indexed: 0 };
  }
  const batches = [];
  for (const chunk of chunks) {
    const parsed = await extractChunk(llm, chunk, docId);
    if (parsed) {
      // P0-4 原文支撑校验：逐分片标注实体/关系是否有原文支撑
      annotateExtractionSupport(parsed, chunk);
      batches.push(parsed);
    }
  }
  // 全部分片失败：抛错交给队列指数退避重试整篇，避免静默产出空结果
  if (!batches.length) {
    throw new Error(`文档 ${docId} 抽取失败：${chunks.length} 个分片均未产出结果`);
  }

  // 合并去重：跨分片同名实体合并（别名并集、摘要择优），关系两端在合并后统一解析
  const { entities, relations } = mergeExtraction(batches);
  if (!entities.length) {
    audit("extract_job.unparsable", { docId });
    return { entities: 0, relations: 0, indexed: 0 };
  }

  // 写库前版本守卫：LLM 抽取期间文档可能被编辑（version 变化）或下线，
  // 此时结果已过期，直接丢弃，避免旧内容覆盖新内容
  const latest = await findDocument(docId);
  if (
    !latest ||
    latest.status !== "published" ||
    Number(latest.version) !== Number(doc.version)
  ) {
    audit("extract_job.skipped", {
      docId,
      reason: "document_changed",
      expectedVersion: doc.version,
      actualVersion: latest?.version,
      status: latest?.status,
    });
    return { entities: 0, relations: 0, indexed: 0, skipped: true };
  }

  // 写入实体，建立 name/alias -> entityId 索引，供关系两端解析
  // P0-3 schema 白名单：type 白名单外降级为「其他」，原词经审计保留（不丢弃）
  // P0-4 原文支撑校验：无原文支撑的实体打 needsReview 待审（不丢弃），并审计
  const nameToId = new Map();
  const written = [];
  let unsupportedEntities = 0;
  for (const e of entities) {
    const schemaType = normalizeEntityType(e.type);
    if (schemaType.degraded) {
      audit("extract_schema.type_degraded", {
        docId,
        entity: e.name,
        raw: schemaType.raw,
        fallback: schemaType.type,
      });
    }
    if (e.supported === false) {
      unsupportedEntities += 1;
      audit("extract_schema.unsupported_entity", {
        docId,
        entity: e.name,
        aliases: Array.isArray(e.aliases) ? e.aliases : [],
        fallbackType: schemaType.type,
      });
    }
    const entity = await upsertEntity({
      name: e.name,
      type: schemaType.type,
      aliases: Array.isArray(e.aliases) ? e.aliases : [],
      summary: e.summary || "",
      sources: [doc.id],
      // 记录本来源文档的摘要口径，供人工审核对比冲突
      sourceId: doc.id,
      // P0-4：无原文支撑 → 待人工复核
      needsReview: e.supported === false,
    });
    if (!entity) continue;
    nameToId.set(norm(entity.name), entity.id);
    for (const alias of entity.aliases || []) nameToId.set(norm(alias), entity.id);
    written.push(entity);
  }

  // 写入关系：两端实体必须都在本批/既有实体库中
  // P0-3 schema 白名单：predicate 白名单外降级为「关联」，原词经审计保留（不丢弃）
  // P0-4 原文支撑校验：subject/predicate/object 未在原文命中的关系审计留痕（关系本就 pending 待审）
  let relationCount = 0;
  let unsupportedRelations = 0;
  for (const r of relations) {
    const subjectId = nameToId.get(norm(r.subject));
    const objectId = nameToId.get(norm(r.object));
    if (!subjectId || !objectId) continue;
    const schemaPredicate = normalizePredicate(r.predicate);
    if (schemaPredicate.degraded) {
      audit("extract_schema.predicate_degraded", {
        docId,
        raw: schemaPredicate.raw,
        fallback: schemaPredicate.predicate,
        subject: r.subject,
        object: r.object,
      });
    }
    if (r.supported === false) {
      unsupportedRelations += 1;
      audit("extract_schema.unsupported_relation", {
        docId,
        subject: r.subject,
        rawPredicate: r.predicate,
        object: r.object,
      });
    }
    await upsertRelation({
      subjectId,
      predicate: schemaPredicate.predicate,
      objectId,
      sources: [doc.id],
    });
    relationCount += 1;
  }

  // 记录已抽取版本：同一版本再次入队时在入口直接跳过（幂等）
  try {
    await setDocumentExtractedVersion(doc.id, doc.version);
  } catch (err) {
    // 迁移 0006 未执行（缺 extracted_version 列）时不影响抽取结果，仅审计
    recordError("extract_version_mark", err, { docId });
  }

  // summary 向量化写入 entity namespace（失败不影响实体库，仅审计）
  let indexed = 0;
  if (isRagReady()) {
    try {
      const withSummary = written.filter((e) => (e.summary || "").trim());
      if (withSummary.length > 0) {
        const vectors = await embedTexts(
          getEmbeddings(),
          withSummary.map((e) => e.summary),
        );
        await upsertNamespaceVectors(
          "entity",
          withSummary.map((e, i) => ({
            id: `entity-${e.id}`,
            text: e.summary,
            metadata: { entityId: e.id, name: e.name },
            embedding: vectors[i],
          })),
        );
        indexed = withSummary.length;
      }
    } catch (err) {
      recordError("extract_vectorize", err, { docId });
    }
  }

  return {
    entities: written.length,
    relations: relationCount,
    indexed,
    unsupportedEntities,
    unsupportedRelations,
  };
}

/**
 * 创建知识抽取队列（createQueue 的抽取适配层）。
 * @param {Object} [deps]
 * @param {(payload: Object) => Promise<any>} [deps.handler]
 * @param {{maxAttempts: number, retryBaseDelayMs: number}} [deps.options]
 */
export async function createExtractionQueue(deps = {}) {
  const options = deps.options || config.indexQueue;
  const handler = deps.handler || runExtraction;

  const base = await createQueue({
    jobType: "extraction",
    handler,
    options: {
      ...options,
      queueName: process.env.EXTRACTION_QUEUE_NAME || "extraction-queue",
      // 抽取开关关闭时任务进入 waiting（不重复触发），避免无意义执行
      isReady: () => config.wiki.enabled,
    },
    deps,
  });

  return {
    enqueue(docId, reason = "document_changed") {
      const id = Number(docId);
      if (!Number.isSafeInteger(id) || id < 1) return null;
      return base.enqueue({ docId: id, reason }, { key: String(id), reason });
    },
    retry: base.retry,
    getByDoc: (docId) => base.getByKey(String(Number(docId))),
    list: base.list,
    stats: base.stats,
    stop: base.stop,
    schedule: base.schedule,
    pump: base.pump,
    _internal: base._internal,
  };
}

// 惰性单例：仅在首次调用时连接真实队列后端（避免测试/无后端时 import 即挂起）
let _extractionQueuePromise = null;

/** 获取全局知识抽取队列单例（懒加载，返回 Promise） */
export function getExtractionQueue() {
  if (!_extractionQueuePromise) _extractionQueuePromise = createExtractionQueue();
  return _extractionQueuePromise;
}

/** 路由层便捷入口：文档发布/更新/回滚后入队 */
export function enqueueExtractionJob(docId, reason) {
  return getExtractionQueue().then((q) => q.enqueue(docId, reason));
}
