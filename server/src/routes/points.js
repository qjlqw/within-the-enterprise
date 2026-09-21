/**
 * 积分路由
 *
 * 路由前缀：/api/points（在 app.js 中挂载）
 *
 * 接口列表：
 *   GET /ranking   积分排行榜（默认 Top10，公开）
 *   GET /detail    当前用户积分明细（需登录，分页）
 *   GET /rules     积分规则（公开）
 *
 * 积分由 db.awardPoints 在文档被点赞 / 收藏、评论发布时自动累加。
 */
import { Router } from 'express'
import { auth } from '../middleware/auth.js'
import { getPointsRanking, getPointsDetail, getPointsRules } from '../db/index.js'
import { success } from '../utils/response.js'

const router = Router()

// 积分排行（按积分倒序，默认取前 10）
router.get('/ranking', (req, res, next) => {
  try {
    const { limit = 10 } = req.query
    success(res, getPointsRanking(Number(limit) || 10))
  } catch (err) {
    next(err)
  }
})

// 个人积分明细（分页）
router.get('/detail', auth, (req, res, next) => {
  try {
    const { page = 1, pageSize = 10 } = req.query
    const result = getPointsDetail(req.user.id)
    const p = Math.max(1, Number(page) || 1)
    const size = Math.max(1, Number(pageSize) || 10)
    const start = (p - 1) * size
    success(res, {
      list: result.list.slice(start, start + size),
      total: result.total,
    })
  } catch (err) {
    next(err)
  }
})

// 积分规则
router.get('/rules', (_req, res, next) => {
  try {
    success(res, getPointsRules())
  } catch (err) {
    next(err)
  }
})

export default router
