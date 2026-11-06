/**
 * 限流计数器存储
 *
 * - 配置 Redis 时使用固定窗口计数（INCR + PEXPIRE），多实例共享同一配额
 * - 未配置或 Redis 不可用时回退到进程内滑动窗口，保证服务可用
 */
import { config } from '../config/index.js'
import { getRedis, redisConfigured } from './redis.js'
import { recordError } from './observability.js'

// 首次 INCR 时设置过期时间，避免 key 永久堆积
const HIT_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return { current, redis.call("PTTL", KEYS[1]) }
`

/** 进程内滑动窗口：key -> { hits: number[], windowMs: number } */
const buckets = new Map()

function memoryHit(key, windowMs, max) {
  const now = Date.now()
  const entry = buckets.get(key)
  const hits = (entry?.hits || []).filter((t) => now - t < windowMs)
  if (hits.length >= max) {
    const oldest = hits[0] ?? now
    return {
      allowed: false,
      count: hits.length,
      retryAfterMs: Math.max(0, windowMs - (now - oldest)),
    }
  }
  hits.push(now)
  buckets.set(key, { hits, windowMs })
  return { allowed: true, count: hits.length, retryAfterMs: 0 }
}

const cleanup = setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of buckets) {
    const alive = entry.hits.filter((t) => now - t < entry.windowMs)
    if (alive.length) buckets.set(key, { hits: alive, windowMs: entry.windowMs })
    else buckets.delete(key)
  }
}, 60_000)
cleanup.unref?.()

let redisWarned = false

export const rateLimitStore = {
  /**
   * 记录一次命中并返回是否放行
   * @param {string} scope 限流器名称，参与 Redis key 命名
   * @param {string} key 业务维度（IP / 用户 / 邮箱等）
   * @param {number} windowMs 窗口时长
   * @param {number} max 窗口内上限
   */
  async hit(scope, key, windowMs, max) {
    const composite = `${config.redis.keyPrefix}:rl:${scope}:${key}`
    if (redisConfigured()) {
      const redis = await getRedis()
      if (redis) {
        try {
          // ioredis 未配置 keyPrefix，这里使用完整 key，避免 EVAL 参数不被前缀化
          const [count, ttl] = await redis.eval(
            HIT_SCRIPT,
            1,
            composite,
            String(windowMs),
          )
          return {
            allowed: count <= max,
            count,
            retryAfterMs: ttl > 0 ? ttl : windowMs,
          }
        } catch (err) {
          // 只记录一次，避免 Redis 故障时限流日志刷屏
          if (!redisWarned) {
            redisWarned = true
            recordError('ratelimit.redis', err, { scope })
          }
        }
      }
    }
    return memoryHit(composite, windowMs, max)
  },
}
