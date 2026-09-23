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
router.get('/ranking', async (req, res, next) => {
  try {
    const { limit = 10 } = req.query
    success(res, await getPointsRanking(Number(limit) || 10))
  } catch (err) {
    next(err)
  }
})

// 个人积分明细（分页，下推到 SQL 层）
router.get('/detail', auth, async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.max(1, Number(req.query.pageSize) || 10)
    const result = await getPointsDetail(req.user.id, { page, pageSize })
    success(res, result)
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
