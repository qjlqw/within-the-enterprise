/**
 * 对象存储删除 outbox + 后台重试队列
 *
 * 背景：
 * - 旧实现中删除文档时直接 fire-and-forget 调用对象存储删除接口，
 *   进程重启 / 对象存储临时故障都会导致原始文件永久残留（孤儿文件）。
 * - 现在删除文档只把「待删除文件」写入数据库 outbox 表，后台 worker
 *   轮询领取任务，失败按指数退避重试，超过上限标记 failed 并可手动重试。
 *
 * 状态机：
 *   pending → processing → done
 *                   ↓ 失败且未到上限
 *              pending（next_attempt_at 退避后再次领取）
 *                   ↓ 达到上限
 *              failed（可人工重试 → pending）
 *
 * 可靠性要点：
 * - 任务持久化在 Supabase，进程重启不丢；
 * - CAS（status=pending 才更新为 processing）保证多实例不重复执行；
 * - 锁超时回收（processing 且 locked_at 过旧）避免进程崩溃后任务卡死；
 * - 唯一部分索引 (driver, file_id) where status in ('pending','processing')
 *   保证同一文件不会重复入队，重复插入的错误码 23505 视为「已入队」。
 */
import { config } from "../config/index.js";
import {
  enqueueStorageDeletionJob,
  claimDueStorageDeletionJobs,
  completeStorageDeletionJob,
  rescheduleStorageDeletionJob,
  failStorageDeletionJob,
  requeueStorageDeletionJob,
  listStorageDeletionJobs,
  getStorageDeletionStats,
} from "../db/index.js";
import backblazeStorage from "./storage/backblaze.js";
import { audit, recordError } from "./observability.js";

/** 默认对象存储驱动：驱动名 → delete(fileId, fileName) */
const DEFAULT_DRIVERS = {
  backblaze: {
    delete: (fileId, fileName) =>
      backblazeStorage.deleteFileVersion(fileId, fileName),
  },
};

/** PostgreSQL 唯一约束冲突 */
const UNIQUE_VIOLATION = "23505";

/** 默认轮询定时器：unref 避免阻塞进程退出 */
const defaultSetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
};

/**
 * 创建 outbox 实例（依赖可注入，便于测试）。
 *
 * @param {Object} [deps]
 * @param {Object} [deps.options]      覆盖 config.storageDeletion（maxAttempts 等）
 * @param {Object} [deps.drivers]      驱动表：{ [driver]: { delete(fileId, fileName) } }
 * @param {Function} [deps.enqueueJob] 入队数据访问方法
 * @param {Function} [deps.claimJobs]  领取到期任务
 * @param {Function} [deps.markDone]
 * @param {Function} [deps.markRetry]
 * @param {Function} [deps.markFailed]
 * @param {Function} [deps.requeue]
 * @param {Function} [deps.list]
 * @param {Function} [deps.stats]
 * @param {() => number} [deps.now]        时钟（毫秒）
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 * @param {Function} [deps.audit]
 * @param {Function} [deps.recordError]
 */
export function createStorageDeletionOutbox(deps = {}) {
  const options = { ...config.storageDeletion, ...(deps.options || {}) };
  const drivers = deps.drivers || DEFAULT_DRIVERS;
  const enqueueJob = deps.enqueueJob || enqueueStorageDeletionJob;
  const claimJobs = deps.claimJobs || claimDueStorageDeletionJobs;
  const markDone = deps.markDone || completeStorageDeletionJob;
  const markRetry = deps.markRetry || rescheduleStorageDeletionJob;
  const markFailed = deps.markFailed || failStorageDeletionJob;
  const requeueJob = deps.requeue || requeueStorageDeletionJob;
  const listJobs = deps.list || listStorageDeletionJobs;
  const statsJobs = deps.stats || getStorageDeletionStats;
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || defaultSetTimer;
  const clearTimer = deps.clearTimer || clearTimeout;
  const auditLog = deps.audit || audit;
  const reportError = deps.recordError || recordError;

  const iso = (ms = now()) => new Date(ms).toISOString();

  let timer = null;
  let started = false;

  /**
   * 入队一条删除任务。
   * 唯一约束冲突（同一文件已有未完成任务）视为入队成功，返回 null。
   */
  async function enqueue({ documentId, driver, fileId, fileName }) {
    try {
      const job = await enqueueJob({
        documentId,
        driver,
        fileId,
        fileName,
        now: iso(),
      });
      auditLog("storage.deletion.enqueued", {
        jobId: job?.id,
        documentId,
        driver,
        fileId,
      });
      schedule(0);
      return job;
    } catch (err) {
      if (err?.code === UNIQUE_VIOLATION) {
        auditLog("storage.deletion.duplicate", { documentId, driver, fileId });
        return null;
      }
      throw err;
    }
  }

  /** 执行单条任务：成功 done，失败退避或 failed */
  async function runJob(job) {
    const attempts = (job.attempts || 0) + 1;
    const driver = drivers[job.driver];
    if (!driver) {
      const lastError = `unsupported storage driver: ${job.driver}`;
      await markFailed(job.id, { attempts, lastError, now: iso() });
      reportError("storage_deletion_job", new Error(lastError), {
        jobId: job.id,
        documentId: job.documentId,
      });
      auditLog("storage.deletion.failed", {
        jobId: job.id,
        documentId: job.documentId,
        driver: job.driver,
        attempts,
        error: lastError,
      });
      return { id: job.id, status: "failed" };
    }

    try {
      await driver.delete(job.fileId, job.fileName);
      await markDone(job.id, { attempts, now: iso() });
      auditLog("storage.deletion.done", {
        jobId: job.id,
        documentId: job.documentId,
        driver: job.driver,
        attempts,
      });
      return { id: job.id, status: "done", attempts };
    } catch (err) {
      const lastError = String(err?.message || err).slice(0, 500);
      if (attempts >= options.maxAttempts) {
        await markFailed(job.id, { attempts, lastError, now: iso() });
        reportError("storage_deletion_job", err, {
          jobId: job.id,
          documentId: job.documentId,
          attempts,
        });
        auditLog("storage.deletion.failed", {
          jobId: job.id,
          documentId: job.documentId,
          driver: job.driver,
          attempts,
          error: lastError,
        });
        return { id: job.id, status: "failed", attempts, lastError };
      }

      // 指数退避：base * 2^(attempts-1)，封顶 retryMaxDelayMs
      const delay = Math.min(
        options.retryBaseDelayMs * 2 ** (attempts - 1),
        options.retryMaxDelayMs,
      );
      const nextAttemptAt = iso(now() + delay);
      await markRetry(job.id, {
        attempts,
        nextAttemptAt,
        lastError,
        now: iso(),
      });
      reportError("storage_deletion_attempt", err, {
        jobId: job.id,
        documentId: job.documentId,
        attempts,
      });
      auditLog("storage.deletion.retrying", {
        jobId: job.id,
        documentId: job.documentId,
        driver: job.driver,
        attempts,
        error: lastError,
        retryAt: nextAttemptAt,
      });
      return { id: job.id, status: "pending", attempts, nextAttemptAt };
    }
  }

  /** 领取并执行一批到期任务 */
  async function runOnce({ limit } = {}) {
    const current = now();
    const jobs = await claimJobs({
      limit: limit || options.batchSize,
      now: iso(current),
      staleBefore: iso(current - options.lockTimeoutMs),
    });
    const results = [];
    for (const job of jobs) {
      try {
        results.push(await runJob(job));
      } catch (err) {
        // 单条任务的落库更新失败不应中断整批；任务保持 processing，
        // 锁超时后会被回收重试
        reportError("storage_deletion_job_update", err, {
          jobId: job.id,
          documentId: job.documentId,
        });
      }
    }
    return results;
  }

  function schedule(delay) {
    if (!started || timer) return;
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, delay);
  }

  async function tick() {
    if (!started) return;
    try {
      await runOnce();
    } catch (err) {
      reportError("storage_deletion_poll", err);
      auditLog("storage.deletion.poll.error", {
        error: String(err?.message || err).slice(0, 300),
      });
    } finally {
      schedule(options.intervalMs);
    }
  }

  /** 启动后台轮询（幂等） */
  function start() {
    if (started) return;
    started = true;
    schedule(0);
  }

  /** 停止轮询（已发出的请求执行完为止，不丢任务） */
  function stop() {
    started = false;
    if (timer) clearTimer(timer);
    timer = null;
  }

  /** 手动重试 failed 任务：重置重试次数并立即到期 */
  async function retry(id) {
    const job = await requeueJob(id, { now: iso() });
    if (job) {
      auditLog("storage.deletion.requeued", { jobId: id });
      schedule(0);
    }
    return job;
  }

  return {
    enqueue,
    runOnce,
    start,
    stop,
    retry,
    list: (opts) => listJobs(opts),
    stats: () => statsJobs(),
  };
}

// 惰性单例：路由与 worker 共用同一实例
let _outbox = null;

export function getStorageDeletionOutbox() {
  if (!_outbox) _outbox = createStorageDeletionOutbox();
  return _outbox;
}

/** 路由层入口：删除文档后入队 */
export function enqueueStorageDeletion(args) {
  return getStorageDeletionOutbox().enqueue(args);
}

/** 启动后台删除 worker（server.js 启动时调用） */
export function startStorageDeletionWorker() {
  return getStorageDeletionOutbox().start();
}

/** 停止后台删除 worker（优雅退出时调用） */
export function stopStorageDeletionWorker() {
  return getStorageDeletionOutbox().stop();
}
