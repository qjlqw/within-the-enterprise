/**
 * Express 应用入口：
 * - 注册通用中间件（CORS、JSON 解析、日志）
 * - 挂载静态资源、健康检查和各业务路由
 * - 兜底 404 与统一错误处理
 *
 * 路由前缀约定：
 *   /api/auth           认证（登录、注册、刷新 token 等）
 *   /api/documents      文档 CRUD、版本、点赞收藏
 *   /api/documents/:documentId/comments  文档下的评论
 *   /api/search         搜索、推荐、热搜、历史
 *   /api/points         积分排行、明细、规则
 *   /api/users          用户资料、头像、统计
 *   /api/agent          知识助手会话与流式问答
 */
import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import fs from 'node:fs'
import { config } from './config/index.js'
import authRoutes from './routes/auth.js'
import documentRoutes from './routes/documents.js'
import commentRoutes from './routes/comments.js'
import searchRoutes from './routes/search.js'
import pointsRoutes from './routes/points.js'
import userRoutes from './routes/users.js'
import agentRoutes from './routes/agent.js'
import entityRoutes from './routes/entities.js'
import observabilityRoutes from './routes/observability.js'
import { notFoundHandler, errorHandler } from './middleware/error.js'
import { runtimeStatus } from './services/observability.js'
import { healthSnapshot } from './services/health.js'
import { optionalAuth } from './middleware/auth.js'
import { globalApiLimiter } from './middleware/rateLimit.js'

const app = express()

// 安全响应头（A10）：不引 helmet，轻量内联即可
// - nosniff：禁止浏览器嗅探 MIME，缓解上传文件被当作可执行内容
// - DENY：禁止被 iframe 嵌套，防点击劫持
// - no-referrer：不向第三方泄露来源 URL
// - HSTS 仅生产开启（本地 http 调试不应强制 https）
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
})

// 反向代理后需要信任一层代理才能拿到真实 IP；未部署代理时保持关闭，避免伪造 X-Forwarded-For
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1)
}

// 静态资源：头像上传目录
if (!fs.existsSync(config.uploadDir)) {
  fs.mkdirSync(config.uploadDir, { recursive: true })
}
app.use('/uploads', express.static(config.uploadDir))

// 通用中间件
app.use(cors({ origin: config.corsOrigin }))          // 跨域：默认允许所有来源
app.use(express.json({ limit: '10mb' }))              // JSON body 解析，限制 10MB
app.use(express.urlencoded({ extended: true }))      // urlencoded 解析（支持数组、嵌套对象）
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'))                              // HTTP 请求日志，测试环境关闭
}

// 健康检查：分项探测数据库 / 队列 / 向量库 / 模型供应商，任一异常返回 503。
// 信息收敛（A13）：未登录/非管理员只返回整体 status，完整 snapshot + runtime
// 详情（依赖拓扑、版本等内部信息）仅对 admin 暴露。
app.get('/api/health', optionalAuth, async (req, res) => {
  const snapshot = await healthSnapshot()
  const isAdminUser = req.user?.roles?.includes('admin')
  const data = isAdminUser
    ? { ...snapshot, ...runtimeStatus() }
    : { status: snapshot.status }
  res
    .status(snapshot.status === 'ok' ? 200 : 503)
    .json({
      code: snapshot.status === 'ok' ? 200 : 503,
      message: snapshot.status,
      data,
    })
})

// 全局 API 限流：兜底防止单实例被请求洪泛（多实例生产仍建议网关/Redis 配额）
app.use('/api', globalApiLimiter)

// 业务路由
app.use('/api/auth', authRoutes)
app.use('/api/documents', documentRoutes)
app.use('/api/documents/:documentId/comments', commentRoutes) // 嵌套评论路由：通过 mergeParams 取到 documentId
app.use('/api/search', searchRoutes)
app.use('/api/points', pointsRoutes)
app.use('/api/users', userRoutes)
app.use('/api/agent', agentRoutes)
app.use('/api/entities', entityRoutes)
app.use('/api/observability', observabilityRoutes)

// 兜底
app.use(notFoundHandler)   // 未匹配的路由返回 404
app.use(errorHandler)      // 统一错误处理（必须放在最后）

export default app
