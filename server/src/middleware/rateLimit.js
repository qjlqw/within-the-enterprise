/**
 * 接口限流
 *
 * 用途：
 * - 登录/注册/改密：防暴力破解与批量注册
 * - 评论/上传/Agent：防刷接口与模型费用失控
 *
 * 计数存储见 services/rateLimitStore.js：
 * - 配置 REDIS_URL 后多实例共享同一配额（固定窗口）
 * - 未配置 Redis 时退化为进程内滑动窗口，单实例仍有效
 */
import { tooManyRequests } from "../utils/response.js";
import { rateLimitStore } from "../services/rateLimitStore.js";

/** 取客户端来源 IP（信任反向代理时需在 Express 配置 trust proxy） */
const clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";

/**
 * 创建限流中间件
 * @param {Object} opts
 * @param {string} [opts.name] 限流器名称，作为计数维度前缀（Redis key 一部分）
 * @param {number} opts.windowMs 时间窗口（毫秒）
 * @param {number} opts.max 窗口内最大请求数
 * @param {(req: import("express").Request) => string} [opts.keyGenerator] 自定义 key
 * @param {string} [opts.message] 超限提示
 */
export function createRateLimiter({
  name = "default",
  windowMs = 60_000,
  max = 60,
  keyGenerator,
  message = "请求过于频繁，请稍后再试",
} = {}) {
  const keyOf = keyGenerator || ((req) => `ip:${clientIp(req)}`);

  return async (req, res, next) => {
    try {
      const result = await rateLimitStore.hit(
        name,
        keyOf(req),
        windowMs,
        max,
      );
      if (!result.allowed) {
        res.setHeader(
          "Retry-After",
          String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))),
        );
        return next(tooManyRequests(message));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** 已登录用户按 ID 限流，未登录回退到 IP */
export const byUserOrIp = (req) =>
  req.user?.id ? `user:${req.user.id}` : `ip:${clientIp(req)}`;

/** 登录/注册：按 IP + 邮箱组合限流，避免同一 IP 多账号绕过 */
export const byIpAndEmail = (req) =>
  `auth:${clientIp(req)}:${String(req.body?.email || "")
    .toLowerCase()
    .slice(0, 120)}`;

// 常用限流器（挂在具体路由上）
export const loginLimiter = createRateLimiter({
  name: "login",
  windowMs: 10 * 60_000,
  max: 10,
  keyGenerator: byIpAndEmail,
  message: "登录尝试过于频繁，请稍后再试",
});

export const registerLimiter = createRateLimiter({
  name: "register",
  windowMs: 60 * 60_000,
  max: 5,
  message: "注册过于频繁，请稍后再试",
});

export const passwordLimiter = createRateLimiter({
  name: "password",
  windowMs: 60 * 60_000,
  max: 10,
  keyGenerator: byUserOrIp,
  message: "修改密码过于频繁，请稍后再试",
});

export const commentLimiter = createRateLimiter({
  name: "comment",
  windowMs: 60_000,
  max: 20,
  keyGenerator: byUserOrIp,
  message: "评论过于频繁，请稍后再试",
});

export const uploadLimiter = createRateLimiter({
  name: "upload",
  windowMs: 60 * 60_000,
  max: 20,
  keyGenerator: byUserOrIp,
  message: "上传过于频繁，请稍后再试",
});

export const agentLimiter = createRateLimiter({
  name: "agent",
  windowMs: 60_000,
  max: 30,
  keyGenerator: byUserOrIp,
  message: "提问过于频繁，请稍后再试",
});

export const globalApiLimiter = createRateLimiter({
  name: "global",
  windowMs: 60_000,
  max: 300,
  message: "请求过于频繁，请稍后再试",
});
