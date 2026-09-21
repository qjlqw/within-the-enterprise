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
import observabilityRoutes from './routes/observability.js'
import { notFoundHandler, errorHandler } from './middleware/error.js'
import { runtimeStatus } from './services/observability.js'

const app = express()

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

// 健康检查（附带 RAG/Rerank 开关状态，便于部署后自检）
app.get('/api/health', (_req, res) => {
  res.json({ code: 200, message: 'success', data: { status: 'ok', ...runtimeStatus() } })
})

// 业务路由
app.use('/api/auth', authRoutes)
app.use('/api/documents', documentRoutes)
app.use('/api/documents/:documentId/comments', commentRoutes) // 嵌套评论路由：通过 mergeParams 取到 documentId
app.use('/api/search', searchRoutes)
app.use('/api/points', pointsRoutes)
app.use('/api/users', userRoutes)
app.use('/api/agent', agentRoutes)
app.use('/api/observability', observabilityRoutes)

// 兜底
app.use(notFoundHandler)   // 未匹配的路由返回 404
app.use(errorHandler)      // 统一错误处理（必须放在最后）

export default app
