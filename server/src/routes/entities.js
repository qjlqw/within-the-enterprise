/**
 * 实体（LLM Wiki）路由
 *
 * 路由前缀：/api/entities（在 app.js 中挂载）
 *
 * 接口列表：
 *   GET    /                     实体列表（可按 status 筛选，分页）
 *   GET    /:id                  实体详情（含关系与来源文档）
 *   POST   /:id/confirm          确认实体（admin/editor）
 *   POST   /:id/reject           驳回实体（admin/editor）
 *
 * 状态语义：LLM 抽取结果一律 pending；人工 confirm 后才可被 lookup_entity 检索。
 */
import { Router } from "express";
import { auth, requireRole } from "../middleware/auth.js";
import {
  listEntities,
  getEntity,
  confirmEntity,
  rejectEntity,
  listRelations,
  findDocument,
  toNumberId,
  confirmEntities,
  rejectEntities,
} from "../db/index.js";
import { success, notFound } from "../utils/response.js";
import { audit } from "../services/observability.js";

const router = Router();

/** 允许的状态筛选值；其余（含缺省）视为「全部」 */
const VALID_STATUS = new Set(["pending", "confirmed", "rejected"]);

// 实体列表（可按状态筛选，分页）
router.get("/", async (req, res, next) => {
  try {
    const status = VALID_STATUS.has(req.query.status) ? req.query.status : undefined;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(1, Number(req.query.pageSize) || 20);
    const result = await listEntities({ status, page, pageSize });
    success(res, result);
  } catch (err) {
    next(err);
  }
});

// 实体详情：实体字段 + 出/入关系 + 来源文档标题
router.get("/:id", async (req, res, next) => {
  try {
    const entity = await getEntity(req.params.id);
    if (!entity) throw notFound("实体不存在");

    // 关系两端解析：返回目标实体 id/name
    const resolveName = async (id) => {
      const target = await getEntity(id);
      return { id: toNumberId(id), name: target?.name ?? null };
    };
    const outgoing = await listRelations({ subjectId: entity.id });
    const incoming = await listRelations({ objectId: entity.id });
    const relations = [];
    for (const r of outgoing) {
      relations.push({
        id: r.id,
        predicate: r.predicate,
        direction: "out",
        target: await resolveName(r.objectId),
        status: r.status,
      });
    }
    for (const r of incoming) {
      relations.push({
        id: r.id,
        predicate: r.predicate,
        direction: "in",
        target: await resolveName(r.subjectId),
        status: r.status,
      });
    }

    // 来源文档标题（供前端展示链接）
    const sourceDocs = [];
    for (const docId of entity.sources || []) {
      const doc = await findDocument(docId);
      if (doc) sourceDocs.push({ id: doc.id, title: doc.title });
    }

    success(res, { ...entity, relations, sourceDocs });
  } catch (err) {
    next(err);
  }
});

// 确认实体（pending/rejected → confirmed），此后可被 lookup_entity 检索
// 状态校验由 confirmEntity 内部完成：非 pending 时抛 badRequest，经 errorHandler 透传 message
router.post("/:id/confirm", auth, requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const entity = await confirmEntity(req.params.id);
    if (!entity) throw notFound("实体不存在");
    audit("entity.confirm", { userId: req.user.id, entityId: entity.id });
    success(res, entity, "已确认实体");
  } catch (err) {
    next(err);
  }
});

// 驳回实体（→ rejected），不再参与检索
// 状态校验由 rejectEntity 内部完成：非 pending 时抛 badRequest，经 errorHandler 透传 message
router.post("/:id/reject", auth, requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const entity = await rejectEntity(req.params.id);
    if (!entity) throw notFound("实体不存在");
    audit("entity.reject", { userId: req.user.id, entityId: entity.id });
    success(res, entity, "已驳回实体");
  } catch (err) {
    next(err);
  }
});

// 批量确认实体（pending/rejected → confirmed）
router.post("/confirm-batch", auth, requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const entities = await confirmEntities(req.body.ids);
    success(res, entities, "已全部确认实体");
  } catch (err) {
    next(err);
  }
});

// 批量驳回实体（→ rejected）
router.post("/reject-batch", auth, requireRole("admin", "editor"), async (req, res, next) => {
  try {
    const entities = await rejectEntities(req.body.ids);
    success(res, entities, "已全部驳回实体");
  } catch (err) {
    next(err);
  }
});


export default router;
