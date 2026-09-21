/**
 * 托管数据库适配器存根
 *
 * 说明：这是一个最小存根，用于在未来接入真实托管数据库（Postgres/Supabase 等）。
 * 当前实现不会对外部数据库发起连接，仅按调用记录意图并返回可预测的结果，
 * 便于在代码中逐步替换内存实现。
 */
import { config } from "../config/index.js";

let connected = false;

export async function connect() {
  // 在真实适配器中，这里应基于 process.env.DB_URL 等建立连接
  if (process.env.DB_DRIVER !== "hosted") {
    throw new Error(
      "hosted adapter not enabled; set DB_DRIVER=hosted to use it",
    );
  }
  // 模拟连接延迟
  await new Promise((r) => setTimeout(r, 50));
  connected = true;
  return true;
}

export async function close() {
  connected = false;
  return true;
}

export function isConnected() {
  return connected;
}

export async function insertDocument(doc) {
  if (!connected) throw new Error("hosted DB not connected");
  // 在真实实现中：INSERT INTO documents (...) RETURNING id
  // 存根：返回模拟插入结果
  return { id: doc.id || null, acknowledged: true };
}

export async function deleteDocumentById(id) {
  if (!connected) throw new Error("hosted DB not connected");
  return { id, deleted: true };
}

export default {
  connect,
  close,
  isConnected,
  insertDocument,
  deleteDocumentById,
};
