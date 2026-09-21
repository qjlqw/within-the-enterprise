/**
 * 用户路由
 *
 * 路由前缀：/api/users（在 app.js 中挂载）
 *
 * 接口列表：
 *   PUT   /profile              更新个人资料（需登录）
 *   POST  /avatar               上传头像（需登录，限制 2MB / png,jpg,gif,webp）
 *   GET   /:userId              获取用户信息
 *   GET   /:userId/documents    获取用户发布的文档列表
 *   GET   /:userId/stats        获取用户统计（文档数 / 点赞 / 收藏 / 浏览）
 *
 * 注意：/profile 与 /avatar 必须放在 /:userId 之前，避免被当作 userId 解析。
 */
import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import fs from 'node:fs'
import { config } from '../config/index.js'
import { auth } from '../middleware/auth.js'
import {
  findUserById,
  updateUserProfile,
  stripPassword,
  allDocuments,
  getUserStats,
  toNumberId,
} from '../db/index.js'
import { success, badRequest, notFound } from '../utils/response.js'

const router = Router()

// 头像上传配置：磁盘存储，文件名带用户 id 与时间戳防冲突
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.uploadDir)
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png'
    cb(null, `avatar-${req.user.id}-${Date.now()}${ext}`)
  },
})
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    // 仅允许常见图片格式
    if (/^image\/(png|jpe?g|gif|webp)$/.test(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error('仅支持 png/jpg/gif/webp 格式'))
    }
  },
})

// 更新个人资料（放在 /:userId 之前避免被当作 id 解析）
router.put('/profile', auth, (req, res, next) => {
  try {
    const { name, department, avatar } = req.body || {}
    // 至少要传一个待更新字段
    if (
      name === undefined &&
      department === undefined &&
      avatar === undefined
    ) {
      throw badRequest('没有需要更新的字段')
    }
    const user = updateUserProfile(req.user.id, { name, department, avatar })
    success(res, stripPassword(user), '更新成功')
  } catch (err) {
    next(err)
  }
})

// 上传头像：返回 /uploads/<filename> 路径，前端直接拼 URL 访问
router.post('/avatar', auth, upload.single('avatar'), (req, res, next) => {
  try {
    if (!req.file) throw badRequest('请上传头像文件')
    const url = `/uploads/${req.file.filename}`
    updateUserProfile(req.user.id, { avatar: url })
    success(res, { avatar: url }, '头像上传成功')
  } catch (err) {
    next(err)
  }
})

// 获取用户信息
router.get('/:userId', (req, res, next) => {
  try {
    const user = findUserById(req.params.userId)
    if (!user) throw notFound('用户不存在')
    success(res, stripPassword(user))
  } catch (err) {
    next(err)
  }
})

// 获取用户文档列表（按作者过滤后分页）
router.get('/:userId/documents', (req, res, next) => {
  try {
    const { page = 1, pageSize = 10 } = req.query
    let list = allDocuments().filter(
      (d) => d.authorId === toNumberId(req.params.userId)
    )
    const p = Math.max(1, Number(page) || 1)
    const size = Math.max(1, Number(pageSize) || 10)
    const start = (p - 1) * size
    success(res, { list: list.slice(start, start + size), total: list.length })
  } catch (err) {
    next(err)
  }
})

// 获取用户统计
router.get('/:userId/stats', (req, res, next) => {
  try {
    success(res, getUserStats(req.params.userId))
  } catch (err) {
    next(err)
  }
})

export default router
