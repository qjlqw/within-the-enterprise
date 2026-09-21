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
import { indexQueue } from "../services/indexQueue.js";

const router = Router();
router.use(auth);

// 简易 admin 守卫：复用角色体系，避免新建中间件
router.use((req, _res, next) => {
  if (!req.user.roles?.includes("admin")) return next(forbidden("仅管理员可查看监控信息"));
  next();
});

router.get("/metrics", (_req, res) => {
  success(res, {
    runtime: runtimeStatus(),
    errors: errorMetrics(),
    indexQueue: indexQueue.stats(),
  });
});

router.get("/index-jobs", (req, res) => {
  const { status } = req.query;
  success(res, { list: indexQueue.list(status ? { status } : {}) });
});

export default router;
