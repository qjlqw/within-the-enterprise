-- ============================================================================
-- Supabase 迁移 0005：Agent 会话持久化（agent_sessions）
-- ----------------------------------------------------------------------------
-- 背景：
--   Agent 会话此前为单进程内存存储（SessionStore 三个 Map），重启丢失、
--   不支持多实例。本迁移落一张 agent_sessions 表，作为会话「持久字段」
--   的唯一真相源（展示历史 turns），供多实例 / 重启恢复。
--
-- 字段说明：
--   - session_id 用会话 UUID 作主键（应用层生成，非自增）。
--   - turns 存展示历史（jsonb 数组，最多 10 个回合，含 user/assistant/evidence）。
--   - created_at / updated_at / touched_at 用 bigint 存 epoch 毫秒（数字），
--     与前端 SessionSummary.createdAt/updatedAt 的 number 语义保持一致。
--   - 运行态（AbortController、单并发 running、限流 rates、幂等 requests）
--     属进程内运行时，不落库；恢复时重置为空。
--
-- 说明：
--   - service_role 绕过 RLS，因此不启用 RLS、不写策略（与 0001 一致）。
--   - 闲置过期由应用层用 minTouchedAt 过滤实现（不在此物理删除）。
--
-- 使用方法（在 Supabase SQL Editor 中按顺序执行）：
--   1. 先执行 0001 / 0002 / 0003 / 0004。
--   2. 再执行本文件。
-- ============================================================================

create table if not exists agent_sessions (
  session_id text primary key,
  user_id    integer not null,                 -- 所属用户（隔离）
  title      text not null default '新会话',
  turns      jsonb not null default '[]',      -- 展示历史（最多 10 回合）
  created_at bigint not null default 0,        -- epoch 毫秒
  updated_at bigint not null default 0,
  touched_at bigint not null default 0
);

-- ---------- 索引（按常用查询字段） ----------
create index if not exists idx_agent_sessions_user    on agent_sessions (user_id);
create index if not exists idx_agent_sessions_touched on agent_sessions (touched_at);
