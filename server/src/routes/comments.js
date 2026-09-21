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
import { auth } from '../middleware/auth.js'
import {
  getComments,
  createComment,
  replyComment,
  deleteComment,
  likeComment,
} from '../db/index.js'
import { success, badRequest, notFound } from '../utils/response.js'

// mergeParams：让本路由能拿到父路由的 :documentId
const router = Router({ mergeParams: true })

// 评论列表
router.get('/', (req, res, next) => {
  try {
    const list = getComments(req.params.documentId)
    success(res, list)
  } catch (err) {
    next(err)
  }
})

// 创建评论
router.post('/', auth, (req, res, next) => {
  try {
    const { content } = req.body || {}
    if (!content) throw badRequest('评论内容不能为空')
    const comment = createComment(req.params.documentId, content, req.user)
    success(res, comment, '评论成功')
  } catch (err) {
    next(err)
  }
})

// 点赞评论
router.post('/:commentId/like', auth, (req, res, next) => {
  try {
    const result = likeComment(
      req.params.documentId,
      req.params.commentId,
      req.user.id
    )
    if (!result) throw notFound('评论不存在')
    success(res, null, '点赞成功')
  } catch (err) {
    next(err)
  }
})

// 回复评论（写入 parent.replies）
router.post('/:commentId/reply', auth, (req, res, next) => {
  try {
    const { content } = req.body || {}
    if (!content) throw badRequest('回复内容不能为空')
    const reply = replyComment(
      req.params.documentId,
      req.params.commentId,
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
router.delete('/:commentId', auth, (req, res, next) => {
  try {
    const ok = deleteComment(req.params.documentId, req.params.commentId)
    if (!ok) throw notFound('评论不存在')
    success(res, null, '删除成功')
  } catch (err) {
    next(err)
  }
})

export default router
