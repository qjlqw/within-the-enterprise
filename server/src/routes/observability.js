/**
 * 可观测性路由（仅 admin）
 *
 * 路由前缀：/api/observability
 *   GET /metrics      错误监控聚合 + 索引队列概况 + RAG/Rerank 开关状态
 *   GET /index-jobs   最近的文档索引任务（可按 status 过滤）
 */
import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { success, forbidden } from "../utils/response.js";
import { errorMetrics, runtimeStatus } from "../services/observability.js";
import { getIndexQueue } from "../services/indexQueue.js";

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
    success(res, {
      runtime: runtimeStatus(),
      errors: errorMetrics(),
      // BullMQ 驱动下 stats() 为异步，内存驱动下同步返回值，await 两者兼容
      indexQueue: await queue.stats(),
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

export default router;
