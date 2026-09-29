/**
 * Agent 会话持久化后端（内存实现）
 *
 * 与 db/index.js 导出的 sessionPersist（Supabase 版）实现同一接口契约：
 *   save(durable) / load(sessionId) / listByUser(userId, minTouchedAt)
 *   / countAll(minTouchedAt) / remove(sessionId)
 * durable = { sessionId, userId, title, turns, createdAt, updatedAt, touchedAt }
 *
 * 供单元测试与无 Supabase 环境使用；生产默认走 Supabase 版。
 * 过期语义：listByUser / countAll 按 minTouchedAt 过滤，不做物理删除。
 */
export function createMemorySessionPersist() {
  const rows = new Map(); // sessionId -> durable

  const clone = (d) => ({ ...d, turns: [...(d.turns || [])] });

  return {
    async save(durable) {
      rows.set(durable.sessionId, clone(durable));
    },
    async load(sessionId) {
      const d = rows.get(sessionId);
      return d ? clone(d) : null;
    },
    async listByUser(userId, minTouchedAt) {
      return [...rows.values()]
        .filter((d) => d.userId === userId && d.touchedAt >= minTouchedAt)
        .map(clone);
    },
    async countAll(minTouchedAt) {
      return [...rows.values()].filter((d) => d.touchedAt >= minTouchedAt)
        .length;
    },
    async remove(sessionId) {
      rows.delete(sessionId);
    },
  };
}
