/**
 * 可观测性路由（仅 admin）
 *
 * 路由前缀：/api/observability
 *   GET  /metrics                     错误监控聚合 + 索引队列 / 删除 outbox 概况
 *   GET  /index-jobs                  最近的文档索引任务（可按 status 过滤）
 *   GET  /storage-deletions           最近的对象存储删除任务（可按 status 过滤）
 *   POST /storage-deletions/:id/retry 手动重试 failed 的删除任务
 *   GET  /usage/summary?days=7        近 N 天用量汇总（每日问答次数/字符量 + 用户 Top）
 */
import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { success, forbidden, notFound } from "../utils/response.js";
import { errorMetrics, runtimeStatus } from "../services/observability.js";
import { getIndexQueue } from "../services/indexQueue.js";
import { getStorageDeletionOutbox } from "../services/storageDeletionOutbox.js";
import { getUsageSummary } from "../services/usageService.js";

const router = Router();
router.use(auth);

// 简易 admin 守卫：复用角色体系，避免新建中间件
router.use((req, _res, next) => {
  if (!req.user.roles?.includes("admin")) return next(forbidden("仅管理员可查看监控信息"));
  next();
});

router.get("/metrics", async (_req, res, next) => {
  try {
    const queue = await getIndexQueue();
    const storageDeletion = getStorageDeletionOutbox();
    success(res, {
      runtime: runtimeStatus(),
      errors: errorMetrics(),
      // BullMQ 驱动下 stats() 为异步，内存驱动下同步返回值，await 两者兼容
      indexQueue: await queue.stats(),
      storageDeletion: await storageDeletion.stats(),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/index-jobs", async (req, res, next) => {
  try {
    const { status } = req.query;
    const queue = await getIndexQueue();
    // BullMQ 驱动下 list() 返回 Promise，内存驱动下同步返回数组，await 两者兼容
    success(res, { list: await queue.list(status ? { status } : {}) });
  } catch (err) {
    next(err);
  }
});

router.get("/storage-deletions", async (req, res, next) => {
  try {
    const { status, limit } = req.query;
    const outbox = getStorageDeletionOutbox();
    const pageSize = Math.min(Number(limit) || 20, 100);
    success(res, {
      list: await outbox.list({ status: status || undefined, limit: pageSize }),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/storage-deletions/:id/retry", async (req, res, next) => {
  try {
    const outbox = getStorageDeletionOutbox();
    const job = await outbox.retry(req.params.id);
    if (!job) throw notFound("删除任务不存在");
    success(res, job, "已重新入队");
  } catch (err) {
    next(err);
  }
});

// 用量汇总（成本治理 B7）：近 N 天每日问答次数/字符量/token 量 + 用户 Top 榜
router.get("/usage/summary", async (req, res, next) => {
  try {
    const days = Number(req.query.days) || 7;
    success(res, await getUsageSummary({ days }));
  } catch (err) {
    next(err);
  }
});

export default router;
