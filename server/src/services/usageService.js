/**
 * 用量计量与配额服务（成本治理 11-06 报告 B7）
 *
 * 职责：
 * - recordUsage   写入用量事件（失败仅记日志，不阻断业务）
 * - checkQuota    用户级每日配额检查（问答次数 / 输入字符量，0 = 不限）
 * - getUsageSummary  近 N 天每日聚合 + 用户 Top 榜（admin 成本看板）
 *
 * 时区口径：每日零点按 Asia/Shanghai（UTC+8）计算，聚合日期同理。
 * 聚合方式：拉取时间窗口内的原始行（sumUsageSince，上限 5 万行），
 * 在 service 层做 JS 聚合，不依赖数据库 rpc。
 */
import { insertUsageEvent, sumUsageSince } from "../db/index.js";
import { config } from "../config/index.js";

/** Asia/Shanghai 的固定偏移（毫秒）：无夏令时，固定 UTC+8 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 当日零点（Asia/Shanghai）对应的 UTC ISO 时间 */
function startOfLocalDay(now = new Date()) {
  // 先平移到上海墙上时钟（以 UTC 刻度表示），取日期部分，再减回偏移
  const shifted = new Date(now.getTime() + TZ_OFFSET_MS);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ) - TZ_OFFSET_MS,
  ).toISOString();
}

/** ISO 时间 → 上海时区日期字符串（YYYY-MM-DD） */
function shanghaiDate(iso) {
  const t = new Date(iso).getTime();
  return new Date(t + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 记录一条用量事件。
 * 计量失败不阻断业务：仅记录错误日志。
 */
export async function recordUsage({
  userId,
  kind,
  tokensIn,
  tokensOut,
  chars,
  meta,
}) {
  try {
    await insertUsageEvent({
      userId,
      kind,
      tokensIn,
      tokensOut,
      chars,
      meta,
    });
  } catch (error) {
    console.error("[usage] 用量记录失败:", error?.message || error);
  }
}

/**
 * 用户级每日配额检查（提交问答前调用）。
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function checkQuota(userId) {
  const runLimit = config.cost.dailyAgentRunLimit;
  const charBudget = config.cost.dailyCharBudget;
  // 两个限额均为 0（不限）时直接放行，避免无谓的聚合查询
  if (!runLimit && !charBudget) return { ok: true };

  const rows = await sumUsageSince(startOfLocalDay());
  const mine = rows.filter(
    (r) => r.kind === "agent_run" && r.userId === userId,
  );

  if (runLimit && mine.length >= runLimit)
    return {
      ok: false,
      reason: `今日问答次数已达上限（${runLimit} 次/天），请明日再试`,
    };

  if (charBudget) {
    const chars = mine.reduce((s, r) => s + (r.chars || 0), 0);
    if (chars >= charBudget)
      return {
        ok: false,
        reason: `今日输入字符量已超预算（${charBudget} 字符/天），请明日再试`,
      };
  }
  return { ok: true };
}

/**
 * 近 N 天用量汇总（admin 成本看板）。
 * @param {{ days?: number }} args days 默认 7，范围 1~90
 * @returns {Promise<{ days: number, daily: Array<{date, agentRuns, chars, tokensIn, tokensOut}>, topUsers: Array<{userId, runs, chars}> }>}
 */
export async function getUsageSummary({ days = 7 } = {}) {
  const n = Math.min(Math.max(Number(days) || 7, 1), 90);
  // 保留期约束：超出 config.cost.usageRetentionDays 的明细按约定由聚合接口忽略
  const windowStart = Date.now() - (n - 1) * DAY_MS;
  const retentionStart = Date.now() - config.cost.usageRetentionDays * DAY_MS;
  const since = new Date(Math.max(windowStart, retentionStart)).toISOString();

  const rows = await sumUsageSince(since);

  // 近 N 天日期序列（按上海时区），保证无数据的日期也出现在结果里
  const byDay = new Map();
  for (let i = n - 1; i >= 0; i--) {
    const key = shanghaiDate(new Date(Date.now() - i * DAY_MS).toISOString());
    byDay.set(key, {
      date: key,
      agentRuns: 0,
      chars: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
  }

  const byUser = new Map();
  for (const r of rows) {
    if (r.kind !== "agent_run") continue;
    const day = byDay.get(shanghaiDate(r.createdAt));
    if (day) {
      day.agentRuns += 1;
      day.chars += r.chars || 0;
      day.tokensIn += r.tokensIn || 0;
      day.tokensOut += r.tokensOut || 0;
    }
    const u = byUser.get(r.userId) || { userId: r.userId, runs: 0, chars: 0 };
    u.runs += 1;
    u.chars += r.chars || 0;
    byUser.set(r.userId, u);
  }

  return {
    days: n,
    daily: [...byDay.values()],
    topUsers: [...byUser.values()]
      .sort((a, b) => b.runs - a.runs || b.chars - a.chars)
      .slice(0, 10),
  };
}
