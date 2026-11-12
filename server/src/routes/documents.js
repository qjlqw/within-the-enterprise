/**
 * 文档路由
 *
 * 路由前缀：/api/documents（在 app.js 中挂载）
 *
 * 接口列表：
 *   GET    /                     文档列表（支持分页 / 分类 / 关键词 / 排序）
 *   GET    /favorites            当前用户收藏列表（须放在 /:id 之前）
 *   GET    /:id                  文档详情（自动 +1 浏览量）
 *   POST   /                     创建文档（需登录）
 *   POST   /upload               上传 MD/TXT/DOCX 解析创建文档（需登录）
 *   PUT    /:id                  更新文档（仅作者或 admin）
 *   DELETE /:id                  删除文档（仅作者或 admin）
 *   GET    /:id/versions         版本历史
 *   POST   /:id/rollback         回滚到指定版本
 *   GET    /index-jobs/:docId    查询文档最近的异步索引任务状态
 *   POST   /index-jobs/:docId/retry  重试失败的索引任务（仅作者或 admin）
 *   POST   /:id/favorite         收藏
 *   DELETE /:id/favorite         取消收藏
 *   POST   /:id/like            点赞
 *   DELETE /:id/like             取消点赞
 *
 * 权限：编辑/删除仅限作者本人或 admin，其余接口（列表/详情）公开。
 */
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { auth, optionalAuth } from "../middleware/auth.js";
import {
  listDocuments,
  findDocument,
  incrementDocumentViews,
  createDocument,
  attachDocumentStorage,
  removeDocument,
  updateDocument,
  getDocumentVersions,
  getDocumentVersion,
  rollbackDocument,
  likeDocument,
  unlikeDocument,
  favoriteDocument,
  unfavoriteDocument,
  getFavoriteDocuments,
  hasDocumentLike,
  hasDocumentFavorite,
  toNumberId,
  isAdmin,
  canViewDocument,
  detachDocumentSources,
} from "../db/index.js";
import { success, badRequest, notFound, forbidden } from "../utils/response.js";
import {
  paginationSchema,
  parse,
  parseId,
} from "../middleware/validate.js";
import { uploadLimiter } from "../middleware/rateLimit.js";
import { config } from "../config/index.js";
import { enqueueIndexJob, getIndexQueue } from "../services/indexQueue.js";
import { enqueueExtractionJob } from "../services/extractionService.js";
import {
  parseDocumentFile,
  documentFileFilter,
} from "../services/documentParser.js";
import { audit, recordError } from "../services/observability.js";
import backblazeStorage from "../services/storage/backblaze.js";
import { enqueueStorageDeletion } from "../services/storageDeletionOutbox.js";

const router = Router();

// 文档上传：内存存储（不落盘，避免可执行文件被静态目录直接访问），
// 大小与类型在 limits/fileFilter + 解析时文件头嗅探双重校验
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.document.uploadMaxBytes },
  fileFilter: documentFileFilter,
});

// 列表查询：pageSize 上限 100，关键词/分类长度受限，排序字段白名单
const listQuerySchema = paginationSchema(100, 10).extend({
  category: z.string().trim().max(50, "分类名称过长").optional(),
  keyword: z.string().trim().max(100, "关键词过长").optional(),
  sortBy: z
    .enum(["id", "createdAt", "updatedAt", "views", "likes", "favorites"])
    .optional(),
});

// 创建/更新文档的字段边界，避免超长正文或标签打爆数据库与响应
const documentInputSchema = z.object({
  title: z.string().trim().min(1, "标题不能为空").max(200, "标题不能超过 200 字"),
  content: z
    .string()
    .min(1, "内容不能为空")
    .max(500_000, "内容不能超过 50 万字符"),
  category: z
    .string()
    .trim()
    .min(1, "分类不能为空")
    .max(50, "分类名称不能超过 50 字"),
  tags: z
    .array(z.string().trim().min(1).max(30, "单个标签不能超过 30 字"))
    .max(10, "最多 10 个标签")
    .optional(),
  status: z.enum(["draft", "published"]).optional(),
});

const documentUpdateSchema = documentInputSchema.partial();

// LLM Wiki 自动抽取开关开启时，才入队知识抽取任务（默认关闭，避免无谓消耗）
const enqueueExtractionIfEnabled = (docId, reason) =>
  config.wiki.enabled && config.wiki.extractEnabled
    ? enqueueExtractionJob(docId, reason)
    : Promise.resolve(null);

/**
 * 文档下线/删除后，把该文档从实体与关系的 sources 中摘除：
 * 否则知识图谱会长期保留“来源已消失”的实体，问答引用到无效出处。
 * best-effort：失败只审计，不影响文档主流程。
 */
const detachExtractionSources = async (docId) => {
  try {
    const result = await detachDocumentSources(docId);
    audit("wiki.detach_sources", { docId, ...result });
  } catch (err) {
    audit("wiki.detach_sources.error", {
      docId,
      error: String(err?.message || err).slice(0, 300),
    });
  }
};

// 文档列表（支持分页 / 分类 / 关键词，全部下推到 SQL 层）
router.get("/", optionalAuth, async (req, res, next) => {
  try {
    const { category, keyword, sortBy, page, pageSize } = parse(
      listQuerySchema,
      req.query,
      "列表参数无效",
    );
    const result = await listDocuments({
      category,
      keyword,
      sortBy,
      page,
      pageSize,
      viewerId: req.user?.id ?? null,
      viewerIsAdmin: isAdmin(req.user),
    });
    success(res, result);
  } catch (err) {
    next(err);
  }
});

// 收藏列表（注意：必须放在 /:id 之前，否则 'favorites' 会被当作 id 解析）
router.get("/favorites", auth, async (req, res, next) => {
  try {
    const { page, pageSize } = parse(
      paginationSchema(50, 10),
      req.query,
      "分页参数无效",
    );
    const result = await getFavoriteDocuments(
      req.user.id,
      {
        page,
        pageSize,
      },
      req.user,
    );
    success(res, result);
  } catch (err) {
    next(err);
  }
});

// 查询文档最近的异步索引任务状态（必须放在 /:id 之前，否则会被当作文档 id）
router.get("/index-jobs/:docId", auth, async (req, res, next) => {
  try {
    const docId = parseId(req.params.docId, "文档 ID");
    const queue = await getIndexQueue();
    // BullMQ 驱动的 getByDoc 返回 Promise，必须 await（内存驱动同步返回，await 同样兼容）
    const job = await queue.getByDoc(docId);
    success(res, job || { status: "none" });
  } catch (err) {
    next(err);
  }
});

// 手动重试失败的索引任务（仅作者本人或 admin）
router.post("/index-jobs/:docId/retry", auth, async (req, res, next) => {
  try {
    const doc = await findDocument(req.params.docId);
    if (!doc) throw notFound("文档不存在");
    if (doc.authorId !== req.user.id && !req.user.roles?.includes("admin")) {
      throw forbidden("只能重试自己创建文档的索引任务");
    }
    // getByDoc / retry 在 BullMQ 驱动下均为异步，必须 await
    const latest = await (await getIndexQueue()).getByDoc(doc.id);
    if (!latest || latest.status !== "failed")
      throw badRequest("该文档没有失败的索引任务");
    const job = await (await getIndexQueue()).retry(latest.jobId);
    audit("index_job.retry", {
      userId: req.user.id,
      docId: doc.id,
      jobId: job.jobId,
    });
    success(
      res,
      { jobId: job.jobId, status: job.status },
      "已重新加入索引队列",
    );
  } catch (err) {
    next(err);
  }
});

// 文档详情（自动 +1 浏览量）
router.get("/:id", optionalAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "文档 ID");
    const doc = await findDocument(id);
    if (!doc) throw notFound("文档不存在");
    if (!canViewDocument(doc, req.user)) throw notFound("文档不存在");
    await incrementDocumentViews(id);
    // 回填当前用户的互动状态，前端刷新后按钮不再“假性可点”
    const [liked, favorited] = req.user
      ? await Promise.all([
          hasDocumentLike(id, req.user.id),
          hasDocumentFavorite(id, req.user.id),
        ])
      : [false, false];
    success(res, { ...doc, liked, favorited });
  } catch (err) {
    next(err);
  }
});

// 创建文档
router.post("/", auth, async (req, res, next) => {
  try {
    const { title, content, category, tags, status } = parse(
      documentInputSchema,
      req.body,
      "文档参数无效",
    );
    const doc = await createDocument(
      { title, content, category, tags, status },
      req.user,
    );
    // 已发布文档异步入向量库（失败由索引队列重试，不影响创建结果）
    if (doc.status === "published") await enqueueIndexJob(doc.id, "create");
    // 已发布文档异步入知识抽取队列（失败由抽取队列重试，不影响创建结果）
    if (doc.status === "published") await enqueueExtractionIfEnabled(doc.id, "create");
    audit("document.create", {
      userId: req.user.id,
      docId: doc.id,
      status: doc.status,
    });
    success(res, doc, "创建成功");
  } catch (err) {
    next(err);
  }
});

// 上传文件解析创建文档（Markdown / TXT / DOCX）
router.post(
  "/upload",
  auth,
  uploadLimiter,
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) throw badRequest("请选择要上传的文件");
      const category = (req.body.category || "").trim();
      if (!category) throw badRequest("分类不能为空");
      if (category.length > 50) throw badRequest("分类名称不能超过 50 字");
      const status = req.body.status === "published" ? "published" : "draft";
      // tags 支持 JSON 数组或逗号分隔字符串
      let tags = [];
      if (req.body.tags) {
        try {
          const parsed = JSON.parse(req.body.tags);
          if (Array.isArray(parsed))
            tags = parsed.map((t) => String(t).trim()).filter(Boolean);
        } catch {
          tags = String(req.body.tags)
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
        }
        tags = tags.slice(0, 10);
      }

      const parsed = await parseDocumentFile(req.file);
      let doc = await createDocument(
        {
          title: parsed.title,
          content: parsed.content,
          category,
          tags,
          status,
        },
        req.user,
      );
      // 尝试将原始上传文件存储到 Backblaze B2（如果配置了凭证）
      try {
        if (
          req.file &&
          process.env.B2_ACCOUNT_ID &&
          process.env.B2_APPLICATION_KEY &&
          process.env.B2_BUCKET_ID
        ) {
          const uploaded = await backblazeStorage.upload(
            req.file.buffer,
            req.file.originalname,
          );
          // 存储元数据落库（documents.storage），重启后仍能定位并删除原始文件
          const storage = {
            driver: "backblaze",
            fileId: uploaded.fileId,
            fileName: uploaded.fileName,
            url: uploaded.url,
          };
          doc = (await attachDocumentStorage(doc.id, storage)) || {
            ...doc,
            storage,
          };
        }
      } catch (err) {
        // 记录但不阻塞文档创建与索引流程（统一走脱敏错误采集）
        recordError("storage.backblaze.upload", err, {
          userId: req.user.id,
          docId: doc.id,
        });
        audit("storage.backblaze.error", {
          userId: req.user.id,
          docId: doc.id,
          error: String(err?.message || err),
        });
      }

      const job =
        doc.status === "published" ? await enqueueIndexJob(doc.id, "upload") : null;
      if (doc.status === "published")
        await enqueueExtractionIfEnabled(doc.id, "upload");
      audit("document.upload", {
        userId: req.user.id,
        docId: doc.id,
        format: parsed.format,
        size: req.file.size,
        status: doc.status,
      });
      success(
        res,
        {
          doc,
          indexJob: job ? { jobId: job.jobId, status: job.status } : null,
          warnings: parsed.warnings,
        },
        "上传成功，已加入文档列表",
      );
    } catch (err) {
      next(err);
    }
  },
);

// 更新文档
router.put("/:id", auth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "文档 ID");
    const doc = await findDocument(id);
    if (!doc) throw notFound("文档不存在");
    // 权限：仅作者本人或 admin 可编辑
    if (doc.authorId !== req.user.id && !req.user.roles?.includes("admin")) {
      throw forbidden("只能编辑自己创建的文档");
    }
    const payload = parse(documentUpdateSchema, req.body, "文档参数无效");
    const updated = await updateDocument(id, payload);
    // 增量同步向量库（草稿→发布、发布→改版、发布→草稿全覆盖），异步重试
    await enqueueIndexJob(updated.id, "update");
    // 发布 → 非发布：文档不再对外可见，同步摘除其在知识图谱中的来源标记
    if (doc.status === "published" && updated.status !== "published") {
      await detachExtractionSources(updated.id);
    }
    // 正文/版本变化后重新抽取（草稿由抽取 handler 自行跳过）
    await enqueueExtractionIfEnabled(updated.id, "update");
    audit("document.update", {
      userId: req.user.id,
      docId: updated.id,
      version: updated.version,
      status: updated.status,
    });
    success(res, updated, "更新成功");
  } catch (err) {
    next(err);
  }
});

// 删除文档
router.delete("/:id", auth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "文档 ID");
    const doc = await findDocument(id);
    if (!doc) throw notFound("文档不存在");
    // 权限：仅作者本人或 admin 可删除
    if (doc.authorId !== req.user.id && !req.user.roles?.includes("admin")) {
      throw forbidden("只能删除自己创建的文档");
    }
    // 使用 DB 提供的删除封装，便于切换到托管 DB
    const removed = await removeDocument(id);
    if (!removed) throw notFound("文档不存在");
    // 异步清除向量库中相关切片（队列读不到文档即执行删除）
    await enqueueIndexJob(doc.id, "delete");
    // 同步摘除实体/关系中的来源标记（来源为空的关系删除、实体标记待复核）
    await detachExtractionSources(doc.id);
    // 原始文件删除走持久化 outbox：先落库，再由后台 worker 重试调用对象存储删除，
    // 避免进程重启 / 对象存储临时故障导致文件残留（失败可重试、可观测）
    if (
      doc.storage?.driver === "backblaze" &&
      doc.storage.fileId &&
      doc.storage.fileName
    ) {
      try {
        await enqueueStorageDeletion({
          documentId: doc.id,
          driver: doc.storage.driver,
          fileId: doc.storage.fileId,
          fileName: doc.storage.fileName,
        });
      } catch (e) {
        // 文档已删除，入队失败无法回滚；记录错误供人工补偿，不改变删除结果
        recordError("storage_deletion_enqueue", e, { docId: doc.id });
        audit("storage.deletion.enqueue.error", {
          userId: req.user.id,
          docId: doc.id,
          error: String(e?.message || e),
        });
      }
    }
    audit("document.delete", { userId: req.user.id, docId: doc.id });
    success(res, null, "删除成功");
  } catch (err) {
    next(err);
  }
});

// 版本历史
router.get("/:id/versions", auth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "文档 ID");
    const doc = await findDocument(id);
    if (!doc) throw notFound("文档不存在");
    if (!canViewDocument(doc, req.user)) throw notFound("文档不存在");
    success(res, await getDocumentVersions(id));
  } catch (err) {
    next(err);
  }
});

// 查看指定历史版本的完整内容
router.get("/:id/versions/:versionId", auth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "文档 ID");
    const versionId = parseId(req.params.versionId, "版本 ID");
    const doc = await findDocument(id);
    if (!doc) throw notFound("文档不存在");
    if (!canViewDocument(doc, req.user)) throw notFound("文档不存在");
    const version = await getDocumentVersion(id, versionId);
    if (!version) throw notFound("版本不存在");
    success(res, version);
  } catch (err) {
    next(err);
  }
});

// 回滚到指定版本
router.post("/:id/rollback", auth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "文档 ID");
    const versionId = parseId(req.body?.versionId, "版本 ID");
    const existing = await findDocument(id);
    if (!existing) throw notFound("文档不存在");
    if (existing.authorId !== req.user.id && !isAdmin(req.user)) {
      throw forbidden("只能回滚自己创建的文档");
    }
    const doc = await rollbackDocument(id, versionId);
    if (!doc) throw notFound("文档或版本不存在");
    // 回滚改变了正文与版本号，重新入队同步向量库（草稿/下线由队列负责清除）
    await enqueueIndexJob(doc.id, "rollback");
    await enqueueExtractionIfEnabled(doc.id, "rollback");
    audit("document.rollback", {
      userId: req.user.id,
      docId: doc.id,
      versionId: toNumberId(versionId),
    });
    success(res, doc, "回滚成功");
  } catch (err) {
    next(err);
  }
});

// 收藏 / 取消收藏（先做对象级校验：文档不存在或不可见一律 404，防探测）
router.post("/:id/favorite", auth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "文档 ID");
    const doc = await findDocument(id);
    if (!doc) throw notFound("文档不存在");
    if (!canViewDocument(doc, req.user)) throw notFound("文档不存在");
    await favoriteDocument(id, req.user.id);
    success(res, null, "收藏成功");
  } catch (err) {
    next(err);
  }
});
router.delete("/:id/favorite", auth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "文档 ID");
    const doc = await findDocument(id);
    if (!doc) throw notFound("文档不存在");
    if (!canViewDocument(doc, req.user)) throw notFound("文档不存在");
    await unfavoriteDocument(id, req.user.id);
    success(res, null, "已取消收藏");
  } catch (err) {
    next(err);
  }
});

// 点赞 / 取消点赞（同样先做对象级校验）
router.post("/:id/like", auth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "文档 ID");
    const doc = await findDocument(id);
    if (!doc) throw notFound("文档不存在");
    if (!canViewDocument(doc, req.user)) throw notFound("文档不存在");
    await likeDocument(id, req.user.id);
    success(res, null, "点赞成功");
  } catch (err) {
    next(err);
  }
});
router.delete("/:id/like", auth, async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "文档 ID");
    const doc = await findDocument(id);
    if (!doc) throw notFound("文档不存在");
    if (!canViewDocument(doc, req.user)) throw notFound("文档不存在");
    await unlikeDocument(id, req.user.id);
    success(res, null, "已取消点赞");
  } catch (err) {
    next(err);
  }
});

export default router;
