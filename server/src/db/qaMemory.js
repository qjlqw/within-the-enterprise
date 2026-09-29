/**
 * 历史问答（QA 长期记忆）业务层
 *
 * 职责：
 * - 在 supabase 适配器的原始持久化方法之上，实现「按 message_id 去重 + 状态硬约束」。
 * - 写回一律 status='pending'，仅用户反馈「有帮助」后转 confirmed 参与检索。
 * - 反馈按 messageId + userId 双重定位，防止越权操作他人问答。
 *
 * 本模块与 db/index.js 并列，复用 supabase 与 utils/date.js，
 * 不依赖 db/index.js，避免循环引用。
 */
import { formatDateTime } from "../utils/date.js";
import * as supabase from "./supabase.js";

const toNumberId = (id) => parseInt(String(id), 10);

/**
 * 写入 / 更新问答（按 messageId 去重）：
 * - 不存在：插入（status 默认 pending）
 * - 已存在：覆盖 answer / sources / embedding，保持 status 不变（不因重试把 confirmed 降级）
 * 返回最终问答。
 */
export async function upsertQa({
  question,
  answer,
  sources = [],
  userId,
  sessionId = "",
  messageId,
  status = "pending",
  embedding = [],
  score = 0,
}) {
  if (!question || !answer || !messageId) return null;
  const existing = await supabase.findQaByMessageId(messageId);
  if (existing) {
    await supabase.updateQa(existing.id, {
      question,
      answer,
      sources: sources || [],
      embedding: embedding || [],
      score,
      updatedAt: formatDateTime(),
    });
    return supabase.findQa(existing.id);
  }
  return supabase.insertQa({
    question,
    answer,
    sources: sources || [],
    userId: toNumberId(userId),
    sessionId: sessionId || "",
    messageId,
    status,
    embedding: embedding || [],
    score,
    createdAt: formatDateTime(),
    updatedAt: formatDateTime(),
  });
}

/** 按 messageId 查问答，且校验归属用户（防止越权） */
export async function findQaByMessageId(messageId, userId) {
  const qa = await supabase.findQaByMessageId(messageId);
  if (!qa) return null;
  return toNumberId(qa.userId) === toNumberId(userId) ? qa : null;
}

export const findQa = (id) => supabase.findQa(toNumberId(id));

export const listQa = (opts) => supabase.listQa(opts);

/** 确认问答（有帮助）：status → confirmed */
export async function confirmQa(messageId, userId) {
  const qa = await findQaByMessageId(messageId, userId);
  if (!qa) return null;
  await supabase.updateQa(qa.id, {
    status: "confirmed",
    updatedAt: formatDateTime(),
  });
  return supabase.findQa(qa.id);
}

/** 驳回问答（无帮助）：status → rejected（不再参与检索） */
export async function rejectQa(messageId, userId) {
  const qa = await findQaByMessageId(messageId, userId);
  if (!qa) return null;
  await supabase.updateQa(qa.id, {
    status: "rejected",
    updatedAt: formatDateTime(),
  });
  return supabase.findQa(qa.id);
}

export async function deleteQaById(id) {
  await supabase.deleteQaById(toNumberId(id));
}
