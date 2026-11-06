import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStorageDeletionOutbox } from '../../src/services/storageDeletionOutbox.js'

/**
 * 对象存储删除 outbox 测试：
 * 注入 fake 数据访问方法与可控时钟 / 定时器，不依赖 Supabase 与 B2。
 */
function createHarness(overrides = {}) {
  const start = Date.parse('2026-01-01T00:00:00.000Z')
  let clock = start
  /** @type {{ at: number, fn: Function }[]} */
  const timers = []
  /** 有待领取的任务池（模拟 outbox 表中 pending 且到期的行） */
  let pendingJobs = []
  /** 下一次 delete 是否失败（可设为正整数表示连续失败次数） */
  let failures = 0

  const calls = {
    enqueue: [],
    claim: [],
    done: [],
    retry: [],
    failed: [],
    requeue: [],
    deletes: [],
    audits: [],
    errors: [],
  }

  const outbox = createStorageDeletionOutbox({
    options: {
      maxAttempts: 3,
      retryBaseDelayMs: 1000,
      retryMaxDelayMs: 60000,
      intervalMs: 5000,
      batchSize: 10,
      lockTimeoutMs: 60000,
    },
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
    enqueueJob: async (job) => {
      calls.enqueue.push(job)
      return { id: 'job-new', ...job }
    },
    claimJobs: async (opts) => {
      calls.claim.push(opts)
      const nowMs = Date.parse(opts.now)
      const due = pendingJobs.filter((job) => Date.parse(job.nextAttemptAt) <= nowMs)
      pendingJobs = pendingJobs.filter((job) => !due.includes(job))
      return due
    },
    markDone: async (id, opts) => calls.done.push({ id, ...opts }),
    markRetry: async (id, opts) => calls.retry.push({ id, ...opts }),
    markFailed: async (id, opts) => calls.failed.push({ id, ...opts }),
    requeue: async (id, opts) => {
      calls.requeue.push({ id, ...opts })
      return { id, status: 'pending' }
    },
    list: async () => [],
    stats: async () => ({ pending: pendingJobs.length }),
    drivers: {
      backblaze: {
        delete: async (fileId, fileName) => {
          calls.deletes.push({ fileId, fileName })
          if (failures > 0) {
            failures -= 1
            throw new Error('b2_delete_file_version failed: 503')
          }
        },
      },
    },
    audit: (action, details) => calls.audits.push({ action, details }),
    recordError: (type, error, context) => calls.errors.push({ type, error, context }),
    ...overrides,
  })

  /** 推进时钟并执行所有到点的定时器（异步泵内部 await 全部落定） */
  async function advance(ms = 0) {
    clock += ms
    for (let round = 0; round < 10; round++) {
      const dueIdx = timers
        .map((t, i) => (t.at <= clock ? i : -1))
        .filter((i) => i >= 0)
      if (dueIdx.length === 0) break
      const due = dueIdx.map((i) => timers[i])
      for (let i = dueIdx.length - 1; i >= 0; i--) timers.splice(dueIdx[i], 1)
      for (const timer of due) timer.fn()
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  return {
    outbox,
    calls,
    advance,
    timers,
    nowIso: () => new Date(clock).toISOString(),
    /** 放入一条待领取任务 */
    pushJob(job = {}) {
      pendingJobs.push({
        id: 'job-1',
        documentId: 7,
        driver: 'backblaze',
        fileId: 'file-1',
        fileName: 'docs/a.md',
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(clock).toISOString(),
        ...job,
      })
    },
    setFailures(n) {
      failures = n
    },
  }
}

test('删除成功：任务标记 done，attempts 累加', async () => {
  const h = createHarness()
  h.pushJob()

  const results = await h.outbox.runOnce()

  assert.deepEqual(results, [{ id: 'job-1', status: 'done', attempts: 1 }])
  assert.deepEqual(h.calls.deletes, [{ fileId: 'file-1', fileName: 'docs/a.md' }])
  assert.equal(h.calls.done.length, 1)
  assert.equal(h.calls.done[0].attempts, 1)
  assert.equal(h.calls.retry.length, 0)
})

test('删除失败：按指数退避回到 pending，后续成功后 done', async () => {
  const h = createHarness()
  h.setFailures(1)
  h.pushJob()

  await h.outbox.runOnce()

  assert.equal(h.calls.retry.length, 1)
  assert.equal(h.calls.retry[0].attempts, 1)
  assert.equal(
    h.calls.retry[0].nextAttemptAt,
    new Date(Date.parse(h.nowIso()) + 1000).toISOString(),
  )
  assert.ok(h.calls.retry[0].lastError.includes('503'))
  assert.equal(h.calls.done.length, 0)

  // 第二次领取（attempts=1），本次成功
  h.pushJob({ attempts: 1 })
  const results = await h.outbox.runOnce()

  assert.deepEqual(results, [{ id: 'job-1', status: 'done', attempts: 2 }])
  assert.equal(h.calls.done[0].attempts, 2)
})

test('重试次数耗尽：标记 failed 并上报错误', async () => {
  const h = createHarness()
  h.setFailures(5)
  h.pushJob({ attempts: 2 })

  const results = await h.outbox.runOnce()

  assert.equal(results[0].status, 'failed')
  assert.equal(h.calls.failed.length, 1)
  assert.equal(h.calls.failed[0].attempts, 3)
  assert.equal(h.calls.retry.length, 0)
  assert.equal(h.calls.errors[0].type, 'storage_deletion_job')
})

test('重复入队（唯一约束 23505）视为已入队，不抛错', async () => {
  const h = createHarness({
    enqueueJob: async () => {
      const err = new Error('duplicate key value violates unique constraint')
      err.code = '23505'
      throw err
    },
  })

  const job = await h.outbox.enqueue({
    documentId: 7,
    driver: 'backblaze',
    fileId: 'file-1',
    fileName: 'docs/a.md',
  })

  assert.equal(job, null)
  assert.ok(h.calls.audits.some((e) => e.action === 'storage.deletion.duplicate'))
})

test('worker 轮询领取任务，stop 后不再触发', async () => {
  const h = createHarness()
  h.pushJob()

  h.outbox.start()
  await h.advance(0)

  assert.equal(h.calls.claim.length, 1)
  assert.equal(h.calls.done.length, 1)

  h.outbox.stop()
  await h.advance(60000)

  assert.equal(h.calls.claim.length, 1)
  assert.equal(h.timers.length, 0)
})
