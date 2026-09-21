/**
 * 全局兜底中间件
 *
 * - notFoundHandler：未匹配到任何路由的请求统一返回 404
 * - errorHandler：捕获所有 next(err) 抛出的错误，按类型映射为统一响应格式
 *   * ApiError       -> 用其自带 status 与 message
 *   * MulterError    -> 文件上传相关错误，统一 400
 *   * 其他           -> 500，并打印日志，避免向前端泄露堆栈
 */
import { ApiError } from '../utils/response.js'
import { recordError } from '../services/observability.js'

// 404 兜底
export function notFoundHandler(_req, res) {
  res.status(404).json({ code: 404, message: '请求的资源不存在', data: null })
}

// 统一错误处理
export function errorHandler(err, _req, res, _next) {
  if (err instanceof ApiError) {
    return res
      .status(err.status)
      .json({ code: err.code, message: err.message, data: null })
  }
  // Multer 文件上传错误（如超大小、类型不符）
  if (err?.name === 'MulterError') {
    recordError('upload.multer', err, { code: err.code })
    return res
      .status(400)
      .json({ code: 400, message: `文件上传失败: ${err.message}`, data: null })
  }
  // 未预期错误：计入错误监控，不向前端泄露堆栈
  recordError('server.unhandled', err, { path: _req.path, method: _req.method })
  res
    .status(500)
    .json({ code: 500, message: '服务器错误', data: null })
}
