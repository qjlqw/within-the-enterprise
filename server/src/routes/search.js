/**
 * 搜索路由
 *
 * 路由前缀：/api/search（在 app.js 中挂载）
 *
 * 接口列表：
 *   GET    /          关键词搜索（标题 / 内容 / 标签），登录用户记录搜索历史
 *   GET    /recommend 按点赞数推荐文档（默认前 5）
 *   GET    /hot       热门搜索词
 *   GET    /history   当前用户搜索历史（需登录）
 *   DELETE /history   清除搜索历史（需登录）
 *
 * 说明：当前为内存简单匹配，未来可替换为 Elasticsearch。
 */
import { Router } from 'express'
import { z } from 'zod'
import { auth, optionalAuth } from '../middleware/auth.js'
import {
  listDocuments,
  getHotSearches,
  addSearchHistory,
  getSearchHistory,
  clearSearchHistory,
  isAdmin,
} from '../db/index.js'
import { success } from '../utils/response.js'
import { paginationSchema, limitSchema, parse } from '../middleware/validate.js'

const router = Router()

// 搜索参数：关键词长度与分页上限，避免 pageSize 过大造成全表扫描
const searchQuerySchema = paginationSchema(50, 10).extend({
  q: z.string().trim().min(1, '搜索关键词不能为空').max(100, '关键词过长'),
})

// 搜索文档（标题 / 内容 / 标签任意命中，SQL 层下推）
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { q, page, pageSize } = parse(
      searchQuerySchema,
      req.query,
      '搜索参数无效',
    )
    const result = await listDocuments({
      keyword: q,
      page,
      pageSize,
      viewerId: req.user?.id ?? null,
      viewerIsAdmin: isAdmin(req.user),
    })

    // 记录搜索历史（仅登录用户；本路由挂 optionalAuth）
    if (req.user) await addSearchHistory(req.user.id, q)

    success(res, {
      list: result.list,
      total: result.total,
      highlight: q, // 前端用于高亮匹配项
    })
  } catch (err) {
    next(err)
  }
})

// 推荐文档（按点赞数排序，limit 硬上限 50）
router.get('/recommend', optionalAuth, async (req, res, next) => {
  try {
    const { limit } = parse(limitSchema(50, 5), req.query, '推荐参数无效')
    const { list } = await listDocuments({
      sortBy: 'likes',
      order: 'desc',
      page: 1,
      pageSize: limit,
      viewerId: req.user?.id ?? null,
      viewerIsAdmin: isAdmin(req.user),
    })
    success(res, list)
  } catch (err) {
    next(err)
  }
})

// 热门搜索词
router.get('/hot', (_req, res, next) => {
  try {
    success(res, getHotSearches())
  } catch (err) {
    next(err)
  }
})

// 搜索历史
router.get('/history', auth, async (req, res, next) => {
  try {
    success(res, await getSearchHistory(req.user.id))
  } catch (err) {
    next(err)
  }
})

// 清除搜索历史
router.delete('/history', auth, async (req, res, next) => {
  try {
    await clearSearchHistory(req.user.id)
    success(res, null, '已清除搜索历史')
  } catch (err) {
    next(err)
  }
})

export default router
