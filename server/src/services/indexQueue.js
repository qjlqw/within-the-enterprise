/**
 * 异步任务队列（通用工厂 + 文档索引专用适配）
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
 *
 * 泛化：
 * - `createQueue({ jobType, handler })` 抽出「串行 + 指数退避 + 审计 + 失败标记」
 *   的通用逻辑，文档索引 / 知识抽取 / QA 写回三类 job 复用同一套实现；
 *   BullMQ 下以 job.data.type / 不同队列名区分。
 * - `createIndexQueue` 是该工厂的文档索引适配层，保持原有 `docId` / `indexed` 语义。
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 默认任务去重键：优先取 payload.docId，否则序列化整个 payload */
function defaultKey(payload) {
  if (payload && typeof payload === "object" && payload.docId != null) {
    return String(payload.docId);
  }
  return JSON.stringify(payload ?? {});
}

/**
 * 创建通用异步任务队列。
 *
 * @param {Object} args
 * @param {string} args.jobType   job 类型（用于审计事件名与 BullMQ 队列名）
 * @param {(payload: any) => Promise<any>} args.handler  任务处理器；抛错则按退避重试
 * @param {Object} [args.options]
 * @param {number} [args.options.maxAttempts]      最大尝试次数
 * @param {number} [args.options.retryBaseDelayMs] 指数退避基数（ms）
 * @param {number} [args.options.maxHistory]       done/failed 历史保留条数
 * @param {string} [args.options.queueName]        BullMQ 队列名
 * @param {() => boolean} [args.options.isReady]   返回 false 时任务进入 waiting 且不计重试
 * @param {(job: Object, result: any) => void} [args.options.onDone] 成功回调（可装饰 job）
 * @param {Object} [args.deps]                     可注入依赖（测试用）：setTimer/clearTimer/now
 * @returns 队列实例：{ enqueue, retry, getByKey, list, stats, stop, schedule, pump, _internal }
 */
export async function createQueue({ jobType, handler, options = {}, deps = {} }) {
  const maxAttempts = options.maxAttempts ?? config.indexQueue.maxAttempts;
  const retryBaseDelayMs =
    options.retryBaseDelayMs ?? config.indexQueue.retryBaseDelayMs;
  const maxHistory = options.maxHistory ?? MAX_HISTORY;
  const queueName = options.queueName || `${jobType}-queue`;
  const isReady = options.isReady || (() => true);
  const onDone = options.onDone || (() => {});
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
  // `options.useBull` 可显式覆盖（测试/本地可强制走内存实现）
  const useBull =
    options.useBull ??
    (process.env.INDEX_QUEUE_DRIVER === "bullmq" &&
      Boolean(config.vector?.upstash?.redisUrl));

  if (useBull) {
    let connection;
    try {
      const { default: IORedis } = await import("ioredis");
      const { Queue, Worker } = await import("bullmq");
      const redisUrl = config.vector.upstash.redisUrl;
      connection = new IORedis(redisUrl, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
        retryStrategy: (times) => {
          if (times > 3) return null;
          return Math.min(times * 1000, 5000);
        },
        connectTimeout: 5000,
      });

      connection.on("error", (err) => {
        console.warn(`${jobType}Queue redis error:`, err?.message || err);
      });

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

      // BullMQ 按 jobId 去重：同文档的后续任务（如 upload 后 delete）若复用
      // 同一 jobId 会被静默丢弃，删除任务从未执行、向量残留成孤儿。
      // jobId 追加时间戳与序号保证唯一；getByKey 改为按 data.key 扫描最新任务。
      let jobSeq = 0;
      const newJobId = (key) =>
        `${jobType}-${key}-${Date.now()}-${jobSeq++}`;
      const queue = new Queue(queueName, { connection });

      // BullMQ 原生状态 → 内存驱动统一词汇（前端轮询、重试判断、测试断言都认后者）
      const BULL_STATE_MAP = {
        completed: "done",
        active: "processing",
        delayed: "retrying",
        prioritized: "pending",
        "waiting-children": "waiting",
      };
      const normalizeState = (state) => BULL_STATE_MAP[state] ?? state;

      const worker = new Worker(
        queueName,
        async (job) => {
          const { key, payload } = job.data;
          while (!isReady()) await sleep(2000);
          try {
            return await handler(payload);
          } catch (err) {
            recordError(`${jobType}_attempt`, err, {
              key,
              jobId: job.id,
              attempt: job.attemptsMade + 1,
            });
            audit(`${jobType}_job.attempt_failed`, {
              key,
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
        audit(`${jobType}_job.done`, { key: job.data.key, jobId: job.id });
      });
      worker.on("failed", (job, err) => {
        recordError(`${jobType}_job`, err, {
          key: job?.data?.key,
          jobId: job?.id,
        });
        audit(`${jobType}_job.failed`, {
          key: job?.data?.key,
          jobId: job?.id,
          error: String(err?.message || err).slice(0, 300),
        });
      });

      async function enqueueBull(payload, { key, reason } = {}) {
        if (key == null) key = defaultKey(payload);
        key = String(key);
        const jobId = newJobId(key);
        try {
          const opts = {
            jobId,
            attempts: maxAttempts,
            backoff: { type: "exponential", delay: retryBaseDelayMs },
          };
          const job = await queue.add(jobType, { key, payload, reason }, opts);
          // 与内存驱动一致：入队即 pending（不要透传 BullMQ 的 job.name）
          return { jobId: job.id, key, payload, reason, status: "pending" };
        } catch (err) {
          recordError(`${jobType}_enqueue`, err, { key, reason });
          audit(`${jobType}_enqueue.failed`, {
            key,
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
          // 与内存驱动一致：手动重试后回到 pending（reason 由路由层记录）
          return { jobId: job.id, status: "pending" };
        } catch (err) {
          recordError(`${jobType}_retry`, err, { jobId });
          audit(`${jobType}_retry.failed`, {
            jobId,
            error: String(err?.message || err).slice(0, 300),
          });
          return null;
        }
      }

      async function getByKeyBull(key) {
        // jobId 每次入队唯一（不可推导），按 data.key 扫描并取时间戳最新的任务
        const jobs = await queue.getJobs(
          [
            "waiting",
            "prioritized",
            "waiting-children",
            "active",
            "delayed",
            "completed",
            "failed",
          ],
          0,
          maxHistory - 1,
          false,
        );
        let latest = null;
        for (const j of jobs) {
          if (String(j.data?.key) !== String(key)) continue;
          if (!latest || (j.timestamp || 0) > (latest.timestamp || 0))
            latest = j;
        }
        if (!latest) return null;
        const state = await latest.getState();
        return {
          jobId: latest.id,
          key,
          payload: latest.data.payload,
          status: normalizeState(state),
          attempts: latest.attemptsMade,
          failedReason: latest.failedReason,
          returnvalue: latest.returnvalue,
          data: latest.data,
        };
      }

      async function listBull({ status } = {}) {
        // 反向映射：调用方用统一词汇过滤，这里翻译成 BullMQ 状态名
        const BULL_STATE_FILTER = {
          done: "completed",
          processing: "active",
          retrying: "delayed",
        };
        const states = status
          ? [BULL_STATE_FILTER[status] ?? status]
          : ["waiting", "active", "delayed", "completed", "failed"];
        const jobs = await queue.getJobs(states, 0, maxHistory - 1, false);
        return jobs.map((j) => ({
          jobId: j.id,
          key: j.data.key,
          payload: j.data.payload,
          // 词汇同内存驱动：有返回值 done、有失败原因 failed、其余排队中 pending
          status: j.returnvalue ? "done" : j.failedReason ? "failed" : "pending",
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
        getByKey: getByKeyBull,
        list: listBull,
        stats: statsBull,
        stop: stopBull,
        _internal: { queue, worker, connection },
      };
    } catch (err) {
      if (connection) {
        try {
          connection.disconnect();
        } catch {
          // ignore
        }
      }
      console.warn(
        `bullmq/ioredis not available or failed to initialize, falling back to in-memory ${jobType}Queue`,
        err?.message || err,
      );
    }
  }

  // --- Fallback: in-memory single-process queue ---
  /** jobId -> job */
  const jobs = new Map();
  /** key -> 该键最近一个任务（用于合并与状态查询） */
  const byKey = new Map();

  let timer = null;
  let pumping = false;

  const iso = () => new Date(now()).toISOString();

  function schedule(delay = 0) {
    if (timer) return;
    timer = setTimer(() => {
      timer = null;
      void pump();
    }, delay);
  }

  function enqueue(payload, { key, reason } = {}) {
    if (key == null) key = defaultKey(payload);
    key = String(key);
    const current = byKey.get(key);
    if (
      current &&
      ["pending", "processing", "waiting", "retrying"].includes(current.status)
    ) {
      return current;
    }
    const job = {
      jobId: randomUUID(),
      key,
      payload,
      status: "pending",
      reason: reason || "enqueued",
      attempts: 0,
      result: undefined,
      lastError: null,
      runAt: now(),
      createdAt: iso(),
      updatedAt: iso(),
    };
    jobs.set(job.jobId, job);
    byKey.set(key, job);
    pruneHistory();
    schedule(0); // 脱离 HTTP 请求上下文，下一个事件循环再执行
    return job;
  }

  function pruneHistory() {
    if (jobs.size <= maxHistory) return;
    const finished = [...jobs.values()]
      .filter((job) => job.status === "done" || job.status === "failed")
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const removeCount = jobs.size - maxHistory;
    for (const job of finished.slice(0, removeCount)) jobs.delete(job.jobId);
  }

  function nextDueJob() {
    return [...jobs.values()]
      .filter((job) => ["pending", "retrying", "waiting"].includes(job.status))
      .filter((job) => job.runAt <= now())
      .sort(
        (a, b) => a.runAt - b.runAt || a.createdAt.localeCompare(b.createdAt),
      )[0];
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (true) {
        const job = nextDueJob();
        if (!job) break;
        job.status = "processing";
        job.updatedAt = iso();

        if (!isReady()) {
          job.status = "waiting";
          job.runAt = now() + 2000;
          schedule(2000);
          break;
        }

        try {
          job.attempts += 1;
          job.result = await handler(job.payload);
          job.status = "done";
          job.runAt = 0;
          job.lastError = null;
          job.updatedAt = iso();
          onDone(job, job.result);
          audit(`${jobType}_job.done`, {
            key: job.key,
            attempts: job.attempts,
            result: job.result,
          });
        } catch (err) {
          job.lastError = String(err?.message || err).slice(0, 300);
          job.updatedAt = iso();
          if (job.attempts >= maxAttempts) {
            job.status = "failed";
            job.runAt = 0;
            recordError(`${jobType}_job`, err, {
              key: job.key,
              attempts: job.attempts,
            });
            audit(`${jobType}_job.failed`, {
              key: job.key,
              attempts: job.attempts,
              reason: job.reason,
              error: job.lastError,
            });
          } else {
            job.status = "retrying";
            // 指数退避：base * 2^(attempts-1)
            const delay = retryBaseDelayMs * 2 ** (job.attempts - 1);
            job.runAt = now() + delay;
            recordError(`${jobType}_attempt`, err, {
              key: job.key,
              attempts: job.attempts,
            });
            audit(`${jobType}_job.retrying`, {
              key: job.key,
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

  function getByKey(key) {
    return byKey.get(String(key)) || null;
  }

  function list({ status } = {}) {
    return [...jobs.values()]
      .filter((job) => !status || job.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  function stats() {
    const result = { total: jobs.size };
    for (const job of jobs.values())
      result[job.status] = (result[job.status] || 0) + 1;
    return result;
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { enqueue, retry, getByKey, list, stats, stop, schedule, pump };
}

/**
 * 创建文档索引队列（`createQueue` 的文档索引适配层）。
 *
 * 保留原有 docId 语义：`enqueue(docId, reason)`、`getByDoc(docId)`，
 * 成功/清除后通过 `onDone` 把切片数写入 `job.indexed`，供路由/前端直接读取。
 *
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

  const handler = async ({ docId }) => {
    const doc = await findDoc(docId);
    if (!doc || doc.status !== "published") {
      await remove(docId);
      return { indexed: 0 };
    }
    return upsert(doc);
  };

  const base = await createQueue({
    jobType: "index",
    handler,
    options: {
      ...options,
      queueName: process.env.INDEX_QUEUE_NAME || "index-queue",
      isReady: () => !ragEnabled() || ready(),
      onDone: (job, result) => {
        job.indexed = result?.indexed ?? 0;
      },
    },
    deps,
  });

  /** 在 job 上补齐 docId 顶层字段（幂等），便于路由/前端读取 */
  const withDoc = (job) => {
    if (job && job.docId == null) {
      const id = job.payload?.docId ?? job.key;
      if (id != null) job.docId = Number(id);
    }
    return job;
  };

  /**
   * 队列方法在不同驱动下同步性不同（内存驱动同步返回，BullMQ 异步返回 Promise），
   * 适配层在此统一抹平：同步驱动保持同步（测试依赖），异步驱动返回 Promise（调用方 await）。
   */
  const syncOrAsync = (result, decorate) =>
    result instanceof Promise ? result.then(decorate) : decorate(result);

  return {
    enqueue(docId, reason = "document_changed") {
      const id = Number(docId);
      if (!Number.isSafeInteger(id) || id < 1) return null;
      return syncOrAsync(
        base.enqueue({ docId: id, reason }, { key: String(id), reason }),
        withDoc,
      );
    },
    retry: (jobId) => syncOrAsync(base.retry(jobId), withDoc),
    getByDoc: (docId) =>
      syncOrAsync(base.getByKey(String(Number(docId))), withDoc),
    list: (opts) =>
      syncOrAsync(base.list(opts), (jobs) => jobs.map(withDoc)),
    stats: base.stats,
    stop: base.stop,
    schedule: base.schedule,
    pump: base.pump,
    _internal: base._internal,
  };
}

// 惰性单例：仅在首次调用时连接真实队列后端（避免测试/无后端时 import 即挂起）
let _indexQueuePromise = null;

/** 获取全局索引队列单例（懒加载，返回 Promise） */
export function getIndexQueue() {
  if (!_indexQueuePromise) _indexQueuePromise = createIndexQueue();
  return _indexQueuePromise;
}

/** 路由层便捷入口：文档创建/更新/回滚/删除后入队 */
export function enqueueIndexJob(docId, reason) {
  return getIndexQueue().then((q) => q.enqueue(docId, reason));
}
