-- ============================================================================
-- Supabase 迁移 0004：Agent 长期记忆（历史问答 QA）
-- ----------------------------------------------------------------------------
-- 背景：
--   知识助手把「已确认有效」的历史问答沉淀为长期记忆，供后续提问通过
--   searchHistoricalQA 工具语义召回。写回一律 status='pending'，仅用户反馈
--   「有帮助」后转为 confirmed 参与检索。
--
-- 说明：
--   - id 沿用 0002 的 identity 自增策略，应用层写入时不传 id。
--   - message_id 存 assistant 消息的 UUID，用于 feedback 接口按消息链接问答。
--   - embedding 存向量（jsonb 数组），confirm 时免重算即可重写向量库 metadata。
--   - sources 存回答引用的来源片段对象数组（documentId/title/version/offset/text）。
--   - updated_at 用 text 存 "YYYY-MM-DD HH:mm:ss" 字符串，与 0001 保持一致。
--
-- 使用方法（在 Supabase SQL Editor 中按顺序执行）：
--   1. 先执行 0001 / 0002 / 0003。
--   2. 再执行本文件。
-- ============================================================================

create table if not exists qa_memory (
  id         integer primary key generated always as identity,
  question   text not null,
  answer     text not null,
  sources    jsonb not null default '[]',       -- 引用来源片段对象数组
  user_id    integer not null,                  -- 提问用户（召回时强制隔离）
  session_id text not null default '',          -- 所属会话 UUID
  message_id text not null,                     -- assistant 消息 UUID（feedback 链接）
  status     text not null default 'pending',   -- pending | confirmed | rejected
  score      real not null default 0,
  embedding  jsonb not null default '[]',       -- 向量（jsonb 数组，confirm 时重写 metadata）
  created_at text,
  updated_at text
);

-- ---------- 索引（按常用查询字段） ----------
create index if not exists idx_qa_user_status on qa_memory (user_id, status);
create index if not exists idx_qa_message_id   on qa_memory (message_id);
