/**
 * Redis 客户端（可选）
 *
 * 用途：多实例部署时共享限流计数与 Agent 运行锁。
 * - 配置 REDIS_URL（或复用 UPSTASH_REDIS_URL）后启用
 * - ioredis 为可选依赖：未安装、未配置或连接失败时返回 null，
 *   调用方自动退化为进程内实现，不阻断服务启动
 */
import { config } from '../config/index.js'
import { recordError } from './observability.js'

let clientPromise = null

/** 建立连接；失败只记录一次，由调用方走内存兜底 */
async function connect() {
  if (!config.redis.url) return null
  try {
    const { default: IORedis } = await import('ioredis')
    const client = new IORedis(config.redis.url, {
      connectTimeout: config.redis.connectTimeoutMs,
      maxRetriesPerRequest: 2,
      // 未连接时立即失败，避免请求排队等待 Redis 重连
      enableOfflineQueue: false,
      lazyConnect: true,
    })
    // ioredis 未监听 error 时会抛未处理事件，必须兜底
    client.on('error', (err) => recordError('redis.connection', err))
    await client.connect()
    return client
  } catch (err) {
    recordError('redis.init', err)
    return null
  }
}

/** 获取共享客户端；未配置或连接失败返回 null */
export function getRedis() {
  if (!config.redis.url) return Promise.resolve(null)
  clientPromise ??= connect()
  return clientPromise
}

/** 是否配置了 Redis（仅代表配置存在，不代表连接可用） */
export const redisConfigured = () => Boolean(config.redis.url)

/** 进程退出前断开连接，避免遗留 socket 阻止退出 */
export async function closeRedis() {
  const pending = clientPromise
  clientPromise = null
  if (!pending) return
  const client = await pending.catch(() => null)
  client?.disconnect?.()
}
