-- 0010: 启用全表 RLS，锁死 anon/authenticated 直连读取面（安全整改 A5）
--
-- 目的：
--   后端持有 service_role 凭据读写 Supabase，service_role 默认绕过 RLS，
--   业务读写不受影响。本迁移对全部业务表启用 Row Level Security 且不创建
--   任何 policy，anon / authenticated 角色（Supabase REST / PostgREST /
--   直连 Postgres）的所有查询都会被 RLS 拒绝，封死未授权读取面。
--
-- 注意：
--   1) 本迁移幂等，可重复执行（enable row level security 为幂等操作）。
--   2) 对 service_role 无任何影响，后端功能不变。
--   3) 若未来引入前端直连（anon / authenticated key），必须按表补齐
--      create policy ... 才能恢复对应访问。
--
-- 使用方法：Supabase 控制台 SQL Editor 粘贴运行。

-- ---------- 0001（核心业务表） ----------
alter table users              enable row level security;
alter table documents          enable row level security;
alter table comments           enable row level security;
alter table points_records     enable row level security;
alter table document_versions  enable row level security;
alter table document_likes     enable row level security;
alter table document_favorites enable row level security;
alter table comment_likes      enable row level security;
alter table search_history     enable row level security;

-- ---------- 0003（LLM Wiki 实体 / 关系） ----------
alter table entities           enable row level security;
alter table relations          enable row level security;

-- ---------- 0004（Agent 长期记忆） ----------
alter table qa_memory          enable row level security;

-- ---------- 0005（Agent 会话持久化） ----------
alter table agent_sessions     enable row level security;

-- ---------- 0008（对象存储删除 outbox） ----------
alter table storage_deletion_outbox enable row level security;
