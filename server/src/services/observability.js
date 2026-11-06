/**
 * 可观测性：审计日志 + 错误监控
 *
 * 审计日志（audit）：
 * - 记录敏感/重要业务动作（登录、文档增删改、上传、Agent 问答结果、索引任务失败等）
 * - 以 JSON Lines 追加写入 .runtime/logs/audit-YYYY-MM-DD.log，按天切分
 * - 仅记录事实字段（谁、做了什么、对象、结果、耗时），不记录提问正文与文档内容
 *
 * 错误监控（errorMonitor）：
 * - 进程内聚合各类错误计数与最近 N 条错误明细
 * - 通过 GET /api/observability/metrics（admin）查看
 * - registerProcessHandlers 兜底 uncaughtException / unhandledRejection
 *
 * 当前为单进程内存 + 本地文件实现；多实例部署时替换为集中式日志/监控即可，
 * 调用方代码（audit/recordError）无需改动。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "../../.runtime/logs");
const RECENT_ERROR_LIMIT = 100;
// node --test 不会自动设置 NODE_ENV，额外检测进程参数，避免测试产生磁盘文件
const IS_TEST =
  process.env.NODE_ENV === "test" || process.argv.includes("--test");

/** 内存中的错误计数：type -> 次数 */
const errorCounts = new Map();
/** 最近错误环形缓冲（最新在前） */
const recentErrors = [];
/** 审计文件写入串行锁，避免并发追加互相截断 */
let writeChain = Promise.resolve();

/** 审计日志保留天数；超期文件在启动与每日巡检时删除 */
const AUDIT_RETENTION_DAYS = 30;

/** 需要脱敏的字段名（大小写不敏感） */
const SENSITIVE_KEY = /(password|passwd|token|secret|api[_-]?key|authorization|cookie)/i;

/**
 * 递归脱敏 + 截断：
 * - 命中敏感字段名的值替换为 [REDACTED]
 * - 长字符串截断，避免把文档正文/错误堆栈整体写进审计文件
 */
function sanitize(value, depth = 0) {
  if (depth > 4) return "[TRUNCATED]";
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...[TRUNCATED]` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, depth + 1);
    }
    return result;
  }
  return value;
}

/** 清理超过保留期的审计日志（按文件名日期判断） */
export function pruneAuditLogs(retentionDays = AUDIT_RETENTION_DAYS) {
  if (IS_TEST) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  fs.readdir(LOG_DIR, (err, files) => {
    if (err) return;
    for (const file of files) {
      const match = /^audit-(\d{4}-\d{2}-\d{2})\.log$/.exec(file);
      if (!match) continue;
      if (new Date(`${match[1]}T00:00:00Z`).getTime() < cutoff) {
        fs.unlink(path.join(LOG_DIR, file), () => {});
      }
    }
  });
}

/** 启动审计轮转巡检：立即清理一次，之后每 24 小时一次（unref 不阻塞进程退出） */
export function scheduleAuditRetention() {
  pruneAuditLogs();
  const timer = setInterval(pruneAuditLogs, 24 * 60 * 60 * 1000);
  timer.unref?.();
}

/** 今天的审计日志文件路径 */
function auditFile(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return path.join(LOG_DIR, `audit-${day}.log`);
}

/**
 * 写一条审计日志
 * @param {string} action 动作类型，如 document.create / agent.run / index_job.failed
 * @param {Object} [details] 事实字段（避免写入正文、密钥等敏感内容）
 */
export function audit(action, details = {}) {
  const entry = {
    time: new Date().toISOString(),
    action,
    ...sanitize(details),
  };
  const line = JSON.stringify(entry) + "\n";
  if (!IS_TEST) {
    // 串行化追加写入；失败只输出到 stderr，不影响业务
    writeChain = writeChain
      .then(
        () =>
          new Promise((resolve) => {
            fs.mkdir(LOG_DIR, { recursive: true }, (mkdirErr) => {
              if (mkdirErr) return resolve();
              fs.appendFile(auditFile(), line, resolve);
            });
          }),
      )
      .catch(() => {});
    console.info("[audit]", line.trim());
  }
  return entry;
}

/**
 * 记录一条错误到监控聚合
 * @param {string} type 错误类型，如 rag.init / rerank.request / index_job
 * @param {Error|unknown} error 错误对象
 * @param {Object} [context] 附加上下文（不含敏感内容）
 */
export function recordError(type, error, context = {}) {
  errorCounts.set(type, (errorCounts.get(type) || 0) + 1);
  recentErrors.unshift({
    time: new Date().toISOString(),
    type,
    message: error?.message
      ? String(error.message).slice(0, 500)
      : String(error),
    status: error?.status,
    ...sanitize(context),
  });
  if (recentErrors.length > RECENT_ERROR_LIMIT)
    recentErrors.length = RECENT_ERROR_LIMIT;
  if (!IS_TEST) {
    console.error(`[monitor:${type}]`, error?.message || error);
  }
}

/** 错误监控快照（供 admin 接口查看） */
export function errorMetrics() {
  return {
    time: new Date().toISOString(),
    totals: Object.fromEntries(errorCounts),
    recent: recentErrors.slice(0, 50),
  };
}

/**
 * 注册进程级兜底：未捕获异常 / 未处理 Promise 拒绝
 *
 * uncaughtException 后进程可能处于不一致状态，记录后主动退出，交由进程管理器重启；
 * 立即退出会丢失尚未落盘的审计，因此等待一个事件循环后再退出。
 */
export function registerProcessHandlers() {
  let exiting = false;
  process.on("uncaughtException", (err) => {
    recordError("process.uncaughtException", err);
    audit("process.uncaughtException", { message: err?.message });
    if (exiting) return;
    exiting = true;
    setTimeout(() => process.exit(1), 100);
  });
  process.on("unhandledRejection", (reason) => {
    recordError(
      "process.unhandledRejection",
      reason instanceof Error ? reason : new Error(String(reason)),
    );
  });
}

/** 配置快照中的非敏感开关状态（健康检查用） */
export function runtimeStatus() {
  return {
    agentEnabled: config.agent.enabled,
    ragEnabled: config.rag.enabled,
    rerankEnabled: config.rag.rerankEnabled,
    rerankReady: config.rag.rerankEnabled && Boolean(config.rag.rerankApiKey),
  };
}
