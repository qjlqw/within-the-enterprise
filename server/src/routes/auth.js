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
 * 修改密码会递增 token 版本，使此前签发的所有 Token 立即失效（含其他设备）。
 */
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { auth, signToken } from '../middleware/auth.js'
import { config } from '../config/index.js'
import {
  findUserByEmail,
  getUserPassword,
  findUserById,
  createUser,
  updateUserPassword,
  bumpUserTokenVersion,
  stripPassword,
} from '../db/index.js'
import { success, badRequest, notFound, forbidden } from '../utils/response.js'
import { parse } from '../middleware/validate.js'
import {
  loginLimiter,
  registerLimiter,
  passwordLimiter,
} from '../middleware/rateLimit.js'

const router = Router()

// 输入边界：邮箱格式 / 密码强度（长度与复杂度取自 config.security，可经环境变量调整）
const loginSchema = z.object({
  email: z.email('邮箱格式不正确').max(254),
  password: z.string().min(1, '密码不能为空').max(128, '密码过长'),
})

// 密码强度规则：最小长度可配；开启 passwordRequireAlnum 时必须同时包含字母与数字
const passwordRule = () =>
  z
    .string()
    .min(
      config.security.passwordMinLength,
      `密码至少 ${config.security.passwordMinLength} 位`,
    )
    .max(128, '密码不能超过 128 位')
    .refine(
      (v) =>
        !config.security.passwordRequireAlnum ||
        /^(?=.*[A-Za-z])(?=.*\d)/.test(v),
      '密码必须同时包含字母和数字',
    )

const registerSchema = z.object({
  name: z.string().trim().min(1, '姓名不能为空').max(50, '姓名过长'),
  email: z.email('邮箱格式不正确').max(254),
  password: passwordRule(),
  department: z.string().trim().max(50, '部门名称过长').optional(),
})

const passwordSchema = z.object({
  oldPassword: z.string().min(1, '原密码不能为空').max(128),
  newPassword: passwordRule(),
})

// 登录（IP + 邮箱维度限流，防暴力破解）
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = parse(loginSchema, req.body, '登录参数无效')

    const user = await findUserByEmail(email.toLowerCase())
    if (!user) throw badRequest('邮箱或密码错误')

    // bcrypt 比对（异步，避免阻塞事件循环）：错误信息保持与“用户不存在”一致，避免账号枚举
    const hash = getUserPassword(user)
    if (!(await bcrypt.compare(password, hash))) {
      throw badRequest('邮箱或密码错误')
    }

    const token = signToken(user)
    success(res, { token, user: stripPassword(user) })
  } catch (err) {
    next(err)
  }
})

// 注册（按 IP 限流，防批量注册；可经 REGISTER_ENABLED 关闭改走内部开通）
router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    if (!config.security.registerEnabled) {
      throw forbidden('注册功能已关闭，请联系管理员开通账号')
    }
    const { name, email, password, department } = parse(
      registerSchema,
      req.body,
      '注册参数无效',
    )
    const normalizedEmail = email.toLowerCase()
    if (await findUserByEmail(normalizedEmail)) {
      throw badRequest('该邮箱已被注册')
    }
    const user = await createUser({
      name,
      email: normalizedEmail,
      password,
      department,
    })
    const token = signToken(user)
    success(res, { token, user: stripPassword(user) })
  } catch (err) {
    next(err)
  }
})

// 获取当前用户信息
router.get('/me', auth, async (req, res, next) => {
  try {
    const user = await findUserById(req.user.id)
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
router.post('/refresh', auth, async (req, res, next) => {
  try {
    const user = await findUserById(req.user.id)
    if (!user) throw notFound('用户不存在')
    success(res, { token: signToken(user) })
  } catch (err) {
    next(err)
  }
})

// 修改密码：成功后递增 token 版本，旧 Token 全部失效，并返回新 Token
router.put('/password', auth, passwordLimiter, async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = parse(
      passwordSchema,
      req.body,
      '密码参数无效',
    )
    const user = await findUserById(req.user.id)
    if (!user) throw notFound('用户不存在')

    // 校验原密码后再允许修改（异步比对，避免阻塞事件循环）
    if (!(await bcrypt.compare(oldPassword, getUserPassword(user)))) {
      throw badRequest('原密码不正确')
    }
    if (oldPassword === newPassword) {
      throw badRequest('新密码不能与原密码相同')
    }
    await updateUserPassword(user.id, newPassword)
    // 撤销所有旧会话，并为当前设备签发新 Token
    const tokenVersion = await bumpUserTokenVersion(user.id)
    const token = signToken({ ...user, tokenVersion })
    success(res, { token }, '密码修改成功')
  } catch (err) {
    next(err)
  }
})

export default router
