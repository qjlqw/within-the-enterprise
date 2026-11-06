/**
 * 评论路由（嵌套在文档下）
 *
 * 路由前缀：/api/documents/:documentId/comments（在 app.js 中挂载）
 * 通过 Router({ mergeParams: true }) 读取父路由的 documentId。
 *
 * 接口列表：
 *   GET    /                       评论列表
 *   POST   /                       创建评论（需登录）
 *   POST   /:commentId/like        点赞评论（需登录）
 *   POST   /:commentId/reply       回复评论（需登录）
 *   DELETE /:commentId              删除评论
 *
 * 评论支持嵌套回复（replies 数组），删除时递归查找。
 */
import { Router } from 'express'
import { z } from 'zod'
import { auth, optionalAuth } from '../middleware/auth.js'
import {
  getComments,
  createComment,
  replyComment,
  deleteComment,
  likeComment,
  findDocument,
  findComment,
  canViewDocument,
  isAdmin,
} from '../db/index.js'
import { success, notFound, forbidden } from '../utils/response.js'
import { parse, parseId } from '../middleware/validate.js'
import { commentLimiter } from '../middleware/rateLimit.js'

// mergeParams：让本路由能拿到父路由的 :documentId
const router = Router({ mergeParams: true })

// 评论文本边界：限制长度，避免超大记录撑爆响应与数据库
const commentSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, '评论内容不能为空')
    .max(2000, '评论内容不能超过 2000 字'),
})

// 评论列表
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const documentId = parseId(req.params.documentId, '文档 ID')
    const doc = await findDocument(documentId)
    if (!doc) throw notFound('文档不存在')
    if (!canViewDocument(doc, req.user)) throw notFound('文档不存在')
    const list = await getComments(documentId)
    success(res, list)
  } catch (err) {
    next(err)
  }
})

// 创建评论
router.post('/', auth, commentLimiter, async (req, res, next) => {
  try {
    const documentId = parseId(req.params.documentId, '文档 ID')
    const { content } = parse(commentSchema, req.body, '评论参数无效')
    const comment = await createComment(documentId, content, req.user)
    success(res, comment, '评论成功')
  } catch (err) {
    next(err)
  }
})

// 点赞评论
router.post('/:commentId/like', auth, async (req, res, next) => {
  try {
    const result = await likeComment(
      parseId(req.params.documentId, '文档 ID'),
      parseId(req.params.commentId, '评论 ID'),
      req.user.id
    )
    if (!result) throw notFound('评论不存在')
    success(res, null, '点赞成功')
  } catch (err) {
    next(err)
  }
})

// 回复评论（写入 parent.replies）
router.post('/:commentId/reply', auth, commentLimiter, async (req, res, next) => {
  try {
    const { content } = parse(commentSchema, req.body, '回复参数无效')
    const reply = await replyComment(
      parseId(req.params.documentId, '文档 ID'),
      parseId(req.params.commentId, '评论 ID'),
      content,
      req.user
    )
    if (!reply) throw notFound('评论不存在')
    success(res, reply, '回复成功')
  } catch (err) {
    next(err)
  }
})

// 删除评论（递归在 replies 中查找并删除）
router.delete('/:commentId', auth, async (req, res, next) => {
  try {
    const documentId = parseId(req.params.documentId, '文档 ID')
    const commentId = parseId(req.params.commentId, '评论 ID')
    const comment = await findComment(documentId, commentId)
    if (!comment) throw notFound('评论不存在')
    if (comment.userId !== req.user.id && !isAdmin(req.user)) {
      throw forbidden('只能删除自己的评论')
    }
    const ok = await deleteComment(documentId, commentId)
    if (!ok) throw notFound('评论不存在')
    success(res, null, '删除成功')
  } catch (err) {
    next(err)
  }
})

export default router
