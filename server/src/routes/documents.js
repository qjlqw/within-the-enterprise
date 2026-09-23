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
import { auth } from "../middleware/auth.js";
import {
  listDocuments,
  findDocument,
  incrementDocumentViews,
  createDocument,
  removeDocument,
  updateDocument,
  getDocumentVersions,
  rollbackDocument,
  likeDocument,
  unlikeDocument,
  favoriteDocument,
  unfavoriteDocument,
  getFavoriteDocuments,
  toNumberId,
} from "../db/index.js";
import { success, badRequest, notFound, forbidden } from "../utils/response.js";
import { config } from "../config/index.js";
import { enqueueIndexJob, indexQueue } from "../services/indexQueue.js";
import {
  parseDocumentFile,
  documentFileFilter,
} from "../services/documentParser.js";
import { audit } from "../services/observability.js";
import backblazeStorage from "../services/storage/backblaze.js";

const router = Router();

// 文档上传：内存存储（不落盘，避免可执行文件被静态目录直接访问），
// 大小与类型在 limits/fileFilter + 解析时文件头嗅探双重校验
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.document.uploadMaxBytes },
  fileFilter: documentFileFilter,
});

// 文档列表（支持分页 / 分类 / 关键词，全部下推到 SQL 层）
router.get("/", async (req, res, next) => {
  try {
    const { category, keyword, sortBy } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(1, Number(req.query.pageSize) || 10);
    const result = await listDocuments({
      category,
      keyword,
      sortBy,
      page,
      pageSize,
    });
    success(res, result);
  } catch (err) {
    next(err);
  }
});

// 收藏列表（注意：必须放在 /:id 之前，否则 'favorites' 会被当作 id 解析）
router.get("/favorites", auth, async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(1, Number(req.query.pageSize) || 10);
    const result = await getFavoriteDocuments(req.user.id, {
      page,
      pageSize,
    });
    success(res, result);
  } catch (err) {
    next(err);
  }
});

// 查询文档最近的异步索引任务状态（必须放在 /:id 之前，否则会被当作文档 id）
router.get("/index-jobs/:docId", auth, (req, res, next) => {
  try {
    const job = indexQueue.getByDoc(toNumberId(req.params.docId));
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
    const latest = indexQueue.getByDoc(doc.id);
    if (!latest || latest.status !== "failed")
      throw badRequest("该文档没有失败的索引任务");
    const job = indexQueue.retry(latest.jobId);
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
router.get("/:id", async (req, res, next) => {
  try {
    const doc = await findDocument(req.params.id);
    if (!doc) throw notFound("文档不存在");
    await incrementDocumentViews(req.params.id);
    success(res, doc);
  } catch (err) {
    next(err);
  }
});

// 创建文档
router.post("/", auth, async (req, res, next) => {
  try {
    const { title, content, category, tags, status } = req.body || {};
    if (!title || !content || !category) {
      throw badRequest("标题、内容和分类不能为空");
    }
    const doc = await createDocument(
      { title, content, category, tags, status },
      req.user,
    );
    // 已发布文档异步入向量库（失败由索引队列重试，不影响创建结果）
    if (doc.status === "published") enqueueIndexJob(doc.id, "create");
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
router.post("/upload", auth, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw badRequest("请选择要上传的文件");
    const category = (req.body.category || "").trim();
    if (!category) throw badRequest("分类不能为空");
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
    const doc = await createDocument(
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
        // 将存储元数据附加到文档对象（内存 DB 中的引用）
        doc.storage = {
          driver: "backblaze",
          fileId: uploaded.fileId,
          fileName: uploaded.fileName,
          url: uploaded.url,
        };
        // update updatedAt to reflect the storage save
        doc.updatedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
      }
    } catch (err) {
      // 记录但不阻塞文档创建与索引流程
      console.error("Backblaze upload failed:", err?.message || err);
      audit("storage.backblaze.error", {
        userId: req.user.id,
        docId: doc.id,
        error: String(err?.message || err),
      });
    }

    const job =
      doc.status === "published" ? enqueueIndexJob(doc.id, "upload") : null;
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
});

// 更新文档
router.put("/:id", auth, async (req, res, next) => {
  try {
    const doc = await findDocument(req.params.id);
    if (!doc) throw notFound("文档不存在");
    // 权限：仅作者本人或 admin 可编辑
    if (doc.authorId !== req.user.id && !req.user.roles?.includes("admin")) {
      throw forbidden("只能编辑自己创建的文档");
    }
    const updated = await updateDocument(req.params.id, req.body || {});
    // 增量同步向量库（草稿→发布、发布→改版、发布→草稿全覆盖），异步重试
    enqueueIndexJob(updated.id, "update");
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
    const doc = await findDocument(req.params.id);
    if (!doc) throw notFound("文档不存在");
    // 权限：仅作者本人或 admin 可删除
    if (doc.authorId !== req.user.id && !req.user.roles?.includes("admin")) {
      throw forbidden("只能删除自己创建的文档");
    }
    // 使用 DB 提供的删除封装，便于切换到托管 DB
    const removed = await removeDocument(req.params.id);
    if (!removed) throw notFound("文档不存在");
    // 异步清除向量库中相关切片（队列读不到文档即执行删除）
    enqueueIndexJob(doc.id, "delete");
    // 如果文档已上传到 Backblaze，尝试删除对应文件版本（不阻塞删除响应）
    try {
      if (
        doc.storage?.driver === "backblaze" &&
        doc.storage.fileId &&
        doc.storage.fileName
      ) {
        backblazeStorage
          .deleteFileVersion(doc.storage.fileId, doc.storage.fileName)
          .catch((e) => {
            console.error("Backblaze delete failed:", e?.message || e);
            audit("storage.backblaze.delete.error", {
              userId: req.user.id,
              docId: doc.id,
              error: String(e?.message || e),
            });
          });
      }
    } catch (e) {
      console.error("Backblaze delete invocation failed:", e?.message || e);
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
    const doc = await findDocument(req.params.id);
    if (!doc) throw notFound("文档不存在");
    success(res, await getDocumentVersions(req.params.id));
  } catch (err) {
    next(err);
  }
});

// 回滚到指定版本
router.post("/:id/rollback", auth, async (req, res, next) => {
  try {
    const { versionId } = req.body || {};
    if (!versionId) throw badRequest("缺少 versionId");
    const doc = await rollbackDocument(req.params.id, versionId);
    if (!doc) throw notFound("文档或版本不存在");
    // 回滚改变了正文与版本号，重新入队同步向量库（草稿/下线由队列负责清除）
    enqueueIndexJob(doc.id, "rollback");
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

// 收藏 / 取消收藏
router.post("/:id/favorite", auth, async (req, res, next) => {
  try {
    await favoriteDocument(req.params.id, req.user.id);
    success(res, null, "收藏成功");
  } catch (err) {
    next(err);
  }
});
router.delete("/:id/favorite", auth, async (req, res, next) => {
  try {
    await unfavoriteDocument(req.params.id, req.user.id);
    success(res, null, "已取消收藏");
  } catch (err) {
    next(err);
  }
});

// 点赞 / 取消点赞
router.post("/:id/like", auth, async (req, res, next) => {
  try {
    await likeDocument(req.params.id, req.user.id);
    success(res, null, "点赞成功");
  } catch (err) {
    next(err);
  }
});
router.delete("/:id/like", auth, async (req, res, next) => {
  try {
    await unlikeDocument(req.params.id, req.user.id);
    success(res, null, "已取消点赞");
  } catch (err) {
    next(err);
  }
});

export default router;
