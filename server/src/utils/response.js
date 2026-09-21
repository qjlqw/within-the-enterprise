/**
 * 统一响应封装与业务错误类
 *
 * 前后端约定的响应结构：{ code, message, data }
 * - success：成功响应，code 固定 200
 * - fail：失败响应，由调用方指定 status / message / code（一般直接抛 ApiError 即可）
 * - ApiError：业务错误，抛出后由 error 中间件统一捕获并转换成响应
 *
 * 常用错误工厂：
 *   badRequest   400 参数错误
 *   unauthorized 401 未登录或登录失效
 *   forbidden    403 无权限
 *   notFound     404 资源不存在
 *   conflict     409 资源冲突
 */

/**
 * 统一响应封装，与前端 ApiResponse 结构保持一致：
 * { code, message, data }
 */

export function success(res, data = null, message = 'success') {
  return res.json({ code: 200, message, data })
}

export function fail(res, status, message, code) {
  return res.status(status).json({ code: code ?? status, message, data: null })
}

// 业务错误：抛出后被 error 中间件捕获，自动转成统一响应
export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
    this.code = status
  }
}

// 便捷工厂：路由中直接 throw badRequest('xxx')
export const badRequest = (msg = '请求参数错误') => new ApiError(400, msg)
export const unauthorized = (msg = '未登录或登录已过期') =>
  new ApiError(401, msg)
export const forbidden = (msg = '没有权限访问该资源') => new ApiError(403, msg)
export const notFound = (msg = '资源不存在') => new ApiError(404, msg)
export const conflict = (msg = '资源已存在') => new ApiError(409, msg)
