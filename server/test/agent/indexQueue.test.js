import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIndexQueue } from '../../src/services/indexQueue.js'

/**
 * 索引队列测试：
 * 注入可控时钟与定时器，不依赖真实 setTimeout / embedding 服务。
 */
function createHarness(overrides = {}) {
  let clock = 1_000_000
  /** @type {{ at: number, fn: Function }[]} */
  const timers = []

  const upsertCalls = []
  const removeCalls = []

  const queue = createIndexQueue({
    options: { maxAttempts: 3, retryBaseDelayMs: 2000 },
    ragEnabled: () => false,
    ready: () => true,
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { at: clock + ms, fn }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      const i = timers.indexOf(timer)
      if (i >= 0) timers.splice(i, 1)
    },
    findDoc: () => ({ id: 1, status: 'published' }),
    upsert: async (doc) => {
      upsertCalls.push(doc.id)
      return { indexed: 3 }
    },
    remove: async (docId) => {
      removeCalls.push(docId)
    },
    ...overrides,
  })

  /** 推进时钟并执行所有到点的定时器，泵内 await 全部落定 */
  async function advance(ms = 0) {
    clock += ms
    for (let round = 0; round < 10; round++) {
      // 只触发到点的定时器；未到退避时间的保留
      const dueIdx = timers
        .map((t, i) => (t.at <= clock ? i : -1))
        .filter((i) => i >= 0)
      if (dueIdx.length === 0) break
      const due = dueIdx.map((i) => timers[i])
      for (let i = dueIdx.length - 1; i >= 0; i--) timers.splice(dueIdx[i], 1)
      for (const timer of due) timer.fn()
      // pump 是 async，需要让 upsert 的 await 链跑完
      await Promise.resolve()
      await Promise.resolve()
    }
  }

  return { queue, advance, upsertCalls, removeCalls, clock: () => clock }
}

test('任务首次执行成功即 done，并记录切片数', async () => {
  const { queue, advance, upsertCalls } = createHarness()
  const job = queue.enqueue(1, 'create')
  assert.equal(job.status, 'pending')
  await advance()

  const finished = queue.getByDoc(1)
  assert.equal(finished.status, 'done')
  assert.equal(finished.attempts, 1)
  assert.equal(finished.indexed, 3)
  assert.deepEqual(upsertCalls, [1])
})

test('同一文档未完成的任务自动合并，不重复堆积', async () => {
  const { queue, advance } = createHarness()
  const first = queue.enqueue(1, 'create')
  const second = queue.enqueue(1, 'update')
  assert.equal(first, second)
  assert.equal(queue.stats().total, 1)
  await advance()
  // done 后再次入队应产生新任务（上一轮已结束）
  const third = queue.enqueue(1, 'update')
  assert.notEqual(third, first)
  assert.equal(third.status, 'pending')
  await advance()
})

test('失败按指数退避重试，成功后 done 且 attempts 累计', async () => {
  let failures = 2
  const { queue, advance } = createHarness({
    upsert: async () => {
      if (failures-- > 0) throw new Error('embedding 500')
      return { indexed: 2 }
    },
  })

  queue.enqueue(1, 'create')
  await advance()
  let job = queue.getByDoc(1)
  assert.equal(job.status, 'retrying')
  assert.equal(job.attempts, 1)
  assert.equal(job.runAt, 1_002_000) // base 2000 * 2^0

  // 未到退避时间：不会执行
  await advance(1000)
  job = queue.getByDoc(1)
  assert.equal(job.status, 'retrying')
  assert.equal(job.attempts, 1)

  await advance(1000) // 到 1_002_000
  job = queue.getByDoc(1)
  assert.equal(job.status, 'retrying')
  assert.equal(job.attempts, 2)
  assert.equal(job.runAt, 1_006_000) // 2000 * 2^1

  await advance(4000)
  job = queue.getByDoc(1)
  assert.equal(job.status, 'done')
  assert.equal(job.attempts, 3)
  assert.equal(job.indexed, 2)
})

test('超过最大尝试次数标记 failed，手动 retry 后可恢复', async () => {
  const { queue, advance } = createHarness({
    upsert: async () => {
      throw new Error('持续失败')
    },
  })
  queue.enqueue(7, 'create')
  await advance() // retrying attempt 1
  await advance(2000) // retrying attempt 2
  await advance(4000) // failed attempt 3

  const failed = queue.getByDoc(7)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.attempts, 3)
  assert.match(failed.lastError, /持续失败/)

  const reset = queue.retry(failed.jobId)
  assert.equal(reset.status, 'pending')
  assert.equal(reset.attempts, 0)
  assert.equal(reset.reason, 'manual_retry')
  assert.equal(queue.getByDoc(7), reset)
})

test('RAG 未就绪时进入 waiting 且不消耗重试次数，就绪后继续执行', async () => {
  let ready = false
  const { queue, advance } = createHarness({
    ragEnabled: () => true,
    ready: () => ready,
  })
  queue.enqueue(1, 'create')
  await advance()
  let job = queue.getByDoc(1)
  assert.equal(job.status, 'waiting')
  assert.equal(job.attempts, 0)

  ready = true
  await advance(2000)
  job = queue.getByDoc(1)
  assert.equal(job.status, 'done')
  assert.equal(job.attempts, 1)
})

test('文档已删除或转草稿时执行向量清除并 done', async () => {
  const { queue, advance, removeCalls } = createHarness({
    findDoc: () => ({ id: 9, status: 'draft' }),
  })
  queue.enqueue(9, 'update')
  await advance()
  const job = queue.getByDoc(9)
  assert.equal(job.status, 'done')
  assert.equal(job.indexed, 0)
  assert.deepEqual(removeCalls, [9])
})

test('非法 docId 不入队', () => {
  const { queue } = createHarness()
  for (const bad of [0, -1, 1.5, 'x', null, undefined]) {
    assert.equal(queue.enqueue(bad), null)
  }
})
