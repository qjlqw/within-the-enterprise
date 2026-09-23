/**
 * 鉴权与角色中间件
 *
 * 三种导出形式，按场景选用：
 * - auth：必须登录，否则 401
 * - optionalAuth：有 token 就解析挂 req.user，无 token 也放行（如搜索登录用户记录历史）
 * - requireRole：必须在 auth 之后，按角色白名单校验
 *
 * token 使用 JWT，密钥与有效期见 config。
 */
import jwt from 'jsonwebtoken'
import { config } from '../config/index.js'
import { findUserById, stripPassword } from '../db/index.js'
import { unauthorized } from '../utils/response.js'

/**
 * JWT 鉴权中间件：
 * - 解析 Authorization: Bearer <token>
 * - 校验后将 user 挂到 req.user
 */
export async function auth(req, _res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) {
    return next(unauthorized())
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret)
    const user = await findUserById(payload.id)
    if (!user) {
      // token 有效但用户已被删除：视为未登录
      return next(unauthorized('用户不存在或已被删除'))
    }
    req.user = stripPassword(user)
    req.token = token
    next()
  } catch (err) {
    // JWT 校验失败（签名错误/过期等）
    return next(unauthorized('登录已过期，请重新登录'))
  }
}

/** 可选鉴权：有 token 就解析，没有也不拦截 */
export async function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (token) {
    try {
      const payload = jwt.verify(token, config.jwtSecret)
      const user = await findUserById(payload.id)
      if (user) req.user = stripPassword(user)
    } catch {
      /* 忽略无效 token：未登录用户也能访问的接口不报错 */
    }
  }
  next()
}

/**
 * 角色校验：必须在 auth 之后使用
 * @param  {...string} roles 允许的角色（如 'admin'、'editor'）
 */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized())
    const hasRole = req.user.roles?.some((r) => roles.includes(r))
    if (!hasRole) return next(unauthorized('没有权限执行该操作'))
    next()
  }
}

/** 签发 JWT：payload 含 id/email/roles，有效期取自 config */
export function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, roles: user.roles },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  )
}
