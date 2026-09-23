/**
 * 文档索引异步任务队列
 *
 * 背景：
 * - 旧实现中 upsertDocument 在 HTTP 请求内同步完成，且失败只打日志，
 *   发布成功但索引失败的文档会长期检索不到（只能手动全量 reindex）
 * - 现在索引从请求链路剥离：路由只入队，后台串行执行，
 *   失败指数退避重试，超过上限标记 failed 并支持手动重试
 *
 * 状态机：
 *   pending → processing → done
 *                    ↓ 失败
 *              retrying（退避后回到 processing）→ 超过上限 failed
 *   waiting：RAG 已启用但向量库尚未初始化完成（不计重试次数）
 *
 * 单进程内存实现（与当前内存数据库一致；重启后随种子/空索引自愈，
 * 未来接入持久化队列时只需替换本模块实现）。
 */
import { randomUUID } from "node:crypto";
import { config } from "../config/index.js";
import { findDocument } from "../db/index.js";
import {
  upsertDocument,
  deleteDocument,
  isRagReady,
} from "./embeddingService.js";
import { audit, recordError } from "./observability.js";
// bullmq / ioredis are optional; import dynamically when enabled

/** 历史任务最多保留条数（done/failed），防止内存无限增长 */
const MAX_HISTORY = 500;

/**
 * 创建索引队列（依赖可注入，便于测试）
 * @param {Object} deps
 * @param {(doc: Object) => Promise<{indexed: number}>} [deps.upsert]
 * @param {(docId: number) => Promise<void>} [deps.remove]
 * @param {(id: number) => Object} [deps.findDoc]
 * @param {() => boolean} [deps.ready]       向量库是否就绪
 * @param {() => boolean} [deps.ragEnabled]  RAG 是否启用
 * @param {{maxAttempts: number, retryBaseDelayMs: number}} [deps.options]
 */
export async function createIndexQueue(deps = {}) {
  const options = deps.options || config.indexQueue;
  const upsert = deps.upsert || upsertDocument;
  const remove = deps.remove || deleteDocument;
  const findDoc = deps.findDoc || findDocument;
  const ready = deps.ready || isRagReady;
  const ragEnabled = deps.ragEnabled || (() => config.rag.enabled);
  const setTimer =
    deps.setTimer ||
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
  const clearTimer = deps.clearTimer || clearTimeout;
  const now = deps.now || Date.now;

  // If configured to use bullmq + Upstash Redis, initialize Redis-backed queue
  const useBull =
    (process.env.INDEX_QUEUE_DRIVER === "bullmq" ||
      config.indexQueue.driver === "bullmq") &&
    Boolean(config.vector?.upstash?.redisUrl);

  if (useBull) {
    // dynamic imports to avoid crashing when optional deps are missing
    let connection;
    try {
      const { default: IORedis } = await import("ioredis");
      const { Queue, Worker } = await import("bullmq");
      // create ioredis client from configured UPSTASH redis url (e.g. rediss://:password@host:port)
      const redisUrl = config.vector.upstash.redisUrl;
      connection = new IORedis(redisUrl, {
        // BullMQ manages its own retries; disable per-request retry limit
        maxRetriesPerRequest: null,
        // attach the error handler before any connect attempt so transient
        // disconnects are logged instead of surfacing as an unhandled error
        // event (which would be caught by uncaughtException and spammed)
        lazyConnect: true,
        retryStrategy: (times) => {
          if (times > 3) return null; // give up, fall back to in-memory queue
          return Math.min(times * 1000, 5000);
        },
        connectTimeout: 5000,
      });

      connection.on("error", (err) => {
        console.warn("indexQueue redis error:", err?.message || err);
      });

      // Explicitly connect and require a ready connection; otherwise fall
      // through to the in-memory queue implementation below.
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("redis connect timeout")),
          8000,
        );
        connection.once("ready", () => {
          clearTimeout(timer);
          resolve();
        });
        connection.once("end", () => {
          clearTimeout(timer);
          reject(new Error("redis connection ended"));
        });
        connection.connect().catch(reject);
      });

      const queueName = process.env.INDEX_QUEUE_NAME || "index-queue";
      const queue = new Queue(queueName, { connection });

      // Worker concurrency 1 to preserve serial processing semantics
      const worker = new Worker(
        queueName,
        async (job) => {
          // job.data: { docId, reason }
          const docId = Number(job.data.docId);
          if (!Number.isSafeInteger(docId) || docId < 1) return null;

          // If RAG enabled but vector store not ready, wait until ready (non-consuming)
          while (ragEnabled() && !ready()) {
            await new Promise((r) => setTimeout(r, 2000));
          }

          const doc = await findDoc(docId);
          if (!doc || doc.status !== "published") {
            await remove(docId);
            return { indexed: 0 };
          }
          try {
            const result = await upsert(doc);
            return { indexed: result?.indexed || 0 };
          } catch (err) {
            // BullMQ 会按 attempts 自动重试，但中间每次失败是静默的；
            // 这里记录每次尝试失败，重试耗尽后再由 worker.on("failed") 记录最终失败
            recordError("index_attempt", err, {
              docId,
              jobId: job.id,
              attempt: job.attemptsMade + 1,
            });
            audit("index_job.attempt_failed", {
              docId,
              jobId: job.id,
              attempt: job.attemptsMade + 1,
              error: String(err?.message || err).slice(0, 300),
            });
            throw err;
          }
        },
        { connection, concurrency: 1 },
      );

      worker.on("completed", (job) => {
        audit("index_job.done", { docId: job.data.docId, jobId: job.id });
      });
      worker.on("failed", (job, err) => {
        recordError("index_job", err, {
          docId: job?.data?.docId,
          jobId: job?.id,
        });
        audit("index_job.failed", {
          docId: job?.data?.docId,
          jobId: job?.id,
          error: String(err?.message || err).slice(0, 300),
        });
      });

      async function enqueueBull(docId, reason = "document_changed") {
        const id = Number(docId);
        if (!Number.isSafeInteger(id) || id < 1) return null;
        // use predictable jobId per document to dedupe
        // Upstash 不接受含冒号的 id，改用 `-` 作分隔符
        const jobId = `doc-${id}`;
        try {
          const opts = {
            jobId,
            attempts: options.maxAttempts,
            backoff: { type: "exponential", delay: options.retryBaseDelayMs },
          };
          const job = await queue.add("index", { docId: id, reason }, opts);
          return { jobId: job.id, docId: id, status: job?.name || "queued" };
        } catch (err) {
          // 入队失败不能静默吞掉：写审计日志 + 错误聚合，方便定位队列/Redis 异常
          recordError("index_enqueue", err, { docId: id, reason });
          audit("index_enqueue.failed", {
            docId: id,
            reason,
            error: String(err?.message || err).slice(0, 300),
          });
          return null;
        }
      }

      async function retryBull(jobId) {
        try {
          const job = await queue.getJob(jobId);
          if (!job) return null;
          await job.retry();
          return { jobId: job.id, status: "retrying" };
        } catch (err) {
          recordError("index_retry", err, { jobId });
          audit("index_retry.failed", {
            jobId,
            error: String(err?.message || err).slice(0, 300),
          });
          return null;
        }
      }

      async function getByDocBull(docId) {
        const id = Number(docId);
        const jobId = `doc-${id}`;
        const job = await queue.getJob(jobId);
        if (!job) return null;
        const state = await job.getState();
        return {
          jobId: job.id,
          docId: id,
          status: state,
          attempts: job.attemptsMade,
          failedReason: job.failedReason,
          returnvalue: job.returnvalue,
          data: job.data,
        };
      }

      async function listBull({ status } = {}) {
        const states = status
          ? [status]
          : ["waiting", "active", "delayed", "completed", "failed"];
        const jobs = await queue.getJobs(states, 0, MAX_HISTORY - 1, false);
        return jobs.map((j) => ({
          jobId: j.id,
          docId: j.data.docId,
          status: j.returnvalue
            ? "done"
            : j.failedReason
              ? "failed"
              : "waiting",
        }));
      }

      async function statsBull() {
        return queue.getJobCounts();
      }

      async function stopBull() {
        try {
          await worker.close();
          await queue.close();
          await connection.quit();
        } catch (e) {
          // ignore
        }
      }

      return {
        enqueue: enqueueBull,
        retry: retryBull,
        getByDoc: getByDocBull,
        list: listBull,
        stats: statsBull,
        stop: stopBull,
        // expose internal objects for advanced ops/tests
        _internal: { queue, worker, connection },
      };
    } catch (err) {
      // if dynamic import failed or redis connection issue, fallback to memory implementation
      if (connection) {
        try {
          connection.disconnect();
        } catch {
          // ignore
        }
      }
      console.warn(
        "bullmq/ioredis not available or failed to initialize, falling back to in-memory indexQueue",
        err?.message || err,
      );
    }
  }

  // --- Fallback: in-memory single-process queue (原实现) ---
  /** jobId -> job */
  const jobs = new Map();
  /** docId -> 该文档最近一个任务（用于合并与状态查询） */
  const byDoc = new Map();

  let timer = null;
  let pumping = false;

  const iso = () => new Date(now()).toISOString();

  /** 安排一次后台调度（合并重复触发） */
  function schedule(delay = 0) {
    if (timer) return;
    timer = setTimer(() => {
      timer = null;
      void pump();
    }, delay);
  }

  /**
   * 入队一个文档的索引任务
   * - 同一文档已有未完成任务时合并（不重复堆积）
   * - 上一个任务已失败时自动创建新任务重新尝试
   * @param {number} docId
   * @param {string} [reason] 触发来源（create/update/rollback/upload/retry）
   */
  function enqueue(docId, reason = "document_changed") {
    const id = Number(docId);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const current = byDoc.get(id);
    if (
      current &&
      ["pending", "processing", "waiting", "retrying"].includes(current.status)
    ) {
      return current;
    }
    const job = {
      jobId: randomUUID(),
      docId: id,
      status: "pending",
      reason,
      attempts: 0,
      indexed: 0,
      lastError: null,
      runAt: now(),
      createdAt: iso(),
      updatedAt: iso(),
    };
    jobs.set(job.jobId, job);
    byDoc.set(id, job);
    pruneHistory();
    schedule(0); // 脱离 HTTP 请求上下文，下一个事件循环再执行
    return job;
  }

  /** 清理过老的已结束任务，控制内存占用 */
  function pruneHistory() {
    if (jobs.size <= MAX_HISTORY) return;
    const finished = [...jobs.values()]
      .filter((job) => job.status === "done" || job.status === "failed")
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const removeCount = jobs.size - MAX_HISTORY;
    for (const job of finished.slice(0, removeCount)) jobs.delete(job.jobId);
  }

  /** 取出下一个到点的可执行任务 */
  function nextDueJob() {
    return [...jobs.values()]
      .filter((job) => ["pending", "retrying", "waiting"].includes(job.status))
      .filter((job) => job.runAt <= now())
      .sort(
        (a, b) => a.runAt - b.runAt || a.createdAt.localeCompare(b.createdAt),
      )[0];
  }

  /** 后台串行处理所有到期任务（串行避免 embedding API 并发限流） */
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (true) {
        const job = nextDueJob();
        if (!job) break;
        job.status = "processing";
        job.updatedAt = iso();

        // RAG 启用中但向量库还没初始化好：稍后再试，不消耗重试次数
        if (ragEnabled() && !ready()) {
          job.status = "waiting";
          job.runAt = now() + 2000;
          schedule(2000);
          break;
        }

        try {
          job.attempts += 1;
          const doc = await findDoc(job.docId);
          if (!doc || doc.status !== "published") {
            // 文档已删除或转草稿：清除其向量（可能本来就不存在，空操作）
            await remove(job.docId);
            job.indexed = 0;
          } else {
            const result = await upsert(doc);
            job.indexed = result?.indexed || 0;
          }
          job.status = "done";
          job.runAt = 0;
          job.lastError = null;
          job.updatedAt = iso();
          audit("index_job.done", {
            docId: job.docId,
            attempts: job.attempts,
            indexed: job.indexed,
          });
        } catch (err) {
          job.lastError = String(err?.message || err).slice(0, 300);
          job.updatedAt = iso();
          if (job.attempts >= options.maxAttempts) {
            job.status = "failed";
            job.runAt = 0;
            recordError("index_job", err, {
              docId: job.docId,
              attempts: job.attempts,
            });
            audit("index_job.failed", {
              docId: job.docId,
              attempts: job.attempts,
              reason: job.reason,
              error: job.lastError,
            });
          } else {
            job.status = "retrying";
            // 指数退避：base * 2^(attempts-1)
            const delay = options.retryBaseDelayMs * 2 ** (job.attempts - 1);
            job.runAt = now() + delay;
            recordError("index_attempt", err, {
              docId: job.docId,
              attempts: job.attempts,
            });
            audit("index_job.retrying", {
              docId: job.docId,
              attempts: job.attempts,
              reason: job.reason,
              error: job.lastError,
              retryAt: new Date(job.runAt).toISOString(),
            });
            schedule(delay);
          }
        }
      }
    } finally {
      pumping = false;
    }
  }

  /** 手动重试失败任务（作者/admin 在路由层鉴权后调用） */
  function retry(jobId) {
    const job = jobs.get(jobId);
    if (!job) return null;
    if (!["failed", "done"].includes(job.status)) return job;
    job.status = "pending";
    job.attempts = 0;
    job.lastError = null;
    job.reason = "manual_retry";
    job.runAt = now();
    job.updatedAt = iso();
    schedule(0);
    return job;
  }

  /** 按文档查询最近任务状态 */
  function getByDoc(docId) {
    return byDoc.get(Number(docId)) || null;
  }

  /** 任务列表（按更新时间倒序），供监控/调试 */
  function list({ status } = {}) {
    return [...jobs.values()]
      .filter((job) => !status || job.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 队列概况 */
  function stats() {
    const result = { total: jobs.size };
    for (const job of jobs.values())
      result[job.status] = (result[job.status] || 0) + 1;
    return result;
  }

  /** 停止定时器（测试用） */
  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { enqueue, retry, getByDoc, list, stats, stop, schedule, pump };
}

// 全局单例：路由默认使用
export const indexQueue = await createIndexQueue();

/** 路由层便捷入口：文档创建/更新/回滚/删除后入队 */
export const enqueueIndexJob = (docId, reason) =>
  indexQueue.enqueue(docId, reason);
