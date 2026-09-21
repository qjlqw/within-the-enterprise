/**
 * 认证路由
 *
 * 路由前缀：/api/auth（在 app.js 中挂载）
 *
 * 接口列表：
 *   POST /login      邮箱 + 密码登录，返回 token 与用户信息
 *   POST /register   注册新用户（默认 user 角色）
 *   GET  /me         获取当前登录用户信息（需登录）
 *   POST /logout     退出登录（JWT 无状态，前端清 token 即可）
 *   POST /refresh    刷新 token
 *   PUT  /password   修改密码（需登录，校验原密码）
 *
 * 密码使用 bcrypt 哈希存储，明文不入库。
 */
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { auth, signToken } from '../middleware/auth.js'
import {
  findUserByEmail,
  getUserPassword,
  findUserById,
  createUser,
  updateUserPassword,
  stripPassword,
} from '../db/index.js'
import { success, badRequest, notFound } from '../utils/response.js'

const router = Router()

// 登录
router.post('/login', (req, res, next) => {
  try {
    const { email, password } = req.body || {}
    if (!email || !password) throw badRequest('邮箱和密码不能为空')

    const user = findUserByEmail(email)
    if (!user) throw badRequest('邮箱或密码错误')

    // bcrypt 比对：错误信息保持与“用户不存在”一致，避免账号枚举
    const hash = getUserPassword(user)
    if (!bcrypt.compareSync(password, hash)) {
      throw badRequest('邮箱或密码错误')
    }

    const token = signToken(user)
    success(res, { token, user: stripPassword(user) })
  } catch (err) {
    next(err)
  }
})

// 注册
router.post('/register', (req, res, next) => {
  try {
    const { name, email, password, department } = req.body || {}
    if (!name || !email || !password) {
      throw badRequest('姓名、邮箱和密码不能为空')
    }
    if (findUserByEmail(email)) {
      throw badRequest('该邮箱已被注册')
    }
    const user = createUser({ name, email, password, department })
    const token = signToken(user)
    success(res, { token, user: stripPassword(user) })
  } catch (err) {
    next(err)
  }
})

// 获取当前用户信息
router.get('/me', auth, (req, res, next) => {
  try {
    const user = findUserById(req.user.id)
    if (!user) throw notFound('用户不存在')
    success(res, stripPassword(user))
  } catch (err) {
    next(err)
  }
})

// 退出登录（JWT 无状态，前端清除 token 即可）
router.post('/logout', auth, (_req, res) => {
  success(res, null, '退出成功')
})

// 刷新 token
router.post('/refresh', auth, (req, res, next) => {
  try {
    const user = findUserById(req.user.id)
    if (!user) throw notFound('用户不存在')
    success(res, { token: signToken(user) })
  } catch (err) {
    next(err)
  }
})

// 修改密码
router.put('/password', auth, (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body || {}
    if (!oldPassword || !newPassword) {
      throw badRequest('原密码和新密码不能为空')
    }
    const user = findUserById(req.user.id)
    if (!user) throw notFound('用户不存在')

    // 校验原密码后再允许修改
    if (!bcrypt.compareSync(oldPassword, getUserPassword(user))) {
      throw badRequest('原密码不正确')
    }
    updateUserPassword(user.id, newPassword)
    success(res, null, '密码修改成功')
  } catch (err) {
    next(err)
  }
})

export default router
