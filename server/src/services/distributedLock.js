/**
 * 分布式锁（Redis + 进程内兜底）
 *
 * 用途：保证同一用户在多个实例上同时只有一个 Agent 运行。
 * - 配置 Redis 时使用 SET NX PX 抢占，租约到期自动释放（进程崩溃不会永久占锁）
 * - 释放时用 Lua 校验 token，避免误删其他实例续期后的锁
 * - 未配置 Redis 或 Redis 不可用时退化为进程内锁，仅保证单实例互斥
 */
import { randomUUID } from 'node:crypto'
import { config } from '../config/index.js'
import { getRedis, redisConfigured } from './redis.js'
import { recordError } from './observability.js'

// 仅当 token 与当前值一致时删除，避免删除其他实例持有的锁
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`

/** 进程内兜底：key -> { token, expiresAt } */
const localLocks = new Map()
const keyOf = (name, id) => `${config.redis.keyPrefix}:lock:${name}:${id}`

const acquireLocal = (key, token, ttlMs) => {
  const existing = localLocks.get(key)
  if (existing && existing.expiresAt > Date.now()) return null
  localLocks.set(key, { token, expiresAt: Date.now() + ttlMs })
  return { key, token, shared: false }
}

const cleanup = setInterval(() => {
  const now = Date.now()
  for (const [key, lock] of localLocks) {
    if (lock.expiresAt <= now) localLocks.delete(key)
  }
}, 60000)
cleanup.unref?.()

export const distributedLock = {
  /**
   * 尝试加锁
   * @param {string} name 锁名称（业务维度，如 agent-run）
   * @param {string|number} id 业务主键（如 userId）
   * @param {number} ttlMs 租约时长
   * @returns {Promise<{key: string, token: string, shared: boolean}|null>} 抢锁失败返回 null
   */
  async acquire(name, id, ttlMs) {
    const key = keyOf(name, id)
    const token = randomUUID()
    if (redisConfigured()) {
      const redis = await getRedis()
      if (redis) {
        try {
          const ok = await redis.set(key, token, 'PX', ttlMs, 'NX')
          if (ok === 'OK') return { key, token, shared: true }
          return null
        } catch (err) {
          // Redis 抖动时退化为进程内锁：牺牲跨实例互斥，保证服务可用
          recordError('lock.acquire', err, { name })
        }
      }
    }
    return acquireLocal(key, token, ttlMs)
  },

  /** 释放锁；token 不匹配或已过期时不处理 */
  async release(lock) {
    if (!lock?.token) return
    if (lock.shared) {
      const redis = await getRedis()
      if (redis) {
        try {
          await redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token)
          return
        } catch (err) {
          // 释放失败时依赖租约自动过期
          recordError('lock.release', err)
        }
      }
    }
    const current = localLocks.get(lock.key)
    if (current?.token === lock.token) localLocks.delete(lock.key)
  },
}
