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
import { auth } from '../middleware/auth.js'
import {
  allDocuments,
  getHotSearches,
  addSearchHistory,
  getSearchHistory,
  clearSearchHistory,
} from '../db/index.js'
import { success, badRequest } from '../utils/response.js'

const router = Router()

// 搜索文档（标题 / 内容 / 标签任意命中）
router.get('/', (req, res, next) => {
  try {
    const { q, page = 1, pageSize = 10 } = req.query
    if (!q) throw badRequest('搜索关键词不能为空')
    const kw = String(q).toLowerCase()

    let results = allDocuments().filter(
      (d) =>
        d.title.toLowerCase().includes(kw) ||
        d.content.toLowerCase().includes(kw) ||
        d.tags.some((t) => t.toLowerCase().includes(kw))
    )

    const p = Math.max(1, Number(page) || 1)
    const size = Math.max(1, Number(pageSize) || 10)
    const start = (p - 1) * size

    // 记录搜索历史（仅登录用户；search 路由未挂 auth，因此需 req.user 存在才记录）
    // 注意：app.js 中 search 路由未使用 auth，req.user 此时不会存在；如需记录请改用 optionalAuth
    if (req.user) addSearchHistory(req.user.id, String(q))

    success(res, {
      list: results.slice(start, start + size),
      total: results.length,
      highlight: String(q), // 前端用于高亮匹配项
    })
  } catch (err) {
    next(err)
  }
})

// 推荐文档（按点赞数排序）
router.get('/recommend', (req, res, next) => {
  try {
    const { limit = 5 } = req.query
    const list = [...allDocuments()]
      .sort((a, b) => b.likes - a.likes)
      .slice(0, Number(limit) || 5)
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
router.get('/history', auth, (req, res, next) => {
  try {
    success(res, getSearchHistory(req.user.id))
  } catch (err) {
    next(err)
  }
})

// 清除搜索历史
router.delete('/history', auth, (req, res, next) => {
  try {
    clearSearchHistory(req.user.id)
    success(res, null, '已清除搜索历史')
  } catch (err) {
    next(err)
  }
})

export default router
