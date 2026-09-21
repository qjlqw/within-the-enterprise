/**
 * 托管数据库适配器（Stub）
 *
 * 说明：
 * - 该文件为托管 DB 的占位实现，方便后续替换为真实的 Postgres / Supabase / MySQL 实现。
 * - 暂时不改变现有内存 DB 行为；路由层与业务逻辑仍使用 `server/src/db/index.js`。
 */

let _connected = false;

export async function connect(cfg = {}) {
  // TODO: 用真实库实现连接（pg / mysql2 / @supabase/postgres-js 等）
  _connected = true;
  return { ok: true };
}

export async function close() {
  _connected = false;
}

export async function query(sql, params = []) {
  throw new Error("DB adapter stub: query() not implemented");
}

export function isConnected() {
  return _connected;
}

export default { connect, close, query, isConnected };
