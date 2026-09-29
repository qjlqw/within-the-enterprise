-- ============================================================================
-- Supabase 迁移 0003：LLM Wiki 知识图谱（实体 / 关系）
-- ----------------------------------------------------------------------------
-- 背景：
--   LLM Wiki 从文档中抽取结构化实体（Entity）与有向关系（Relation），
--   供 Agent 通过 lookup_entity 工具引用。这里在 Supabase 中新建两张表。
--
-- 说明：
--   - id 沿用 0002 的 identity 自增策略，应用层写入时不传 id。
--   - sources 用 jsonb 存文档 id 数组，用于溯源（每条实体可追溯到源文档）。
--   - status 用 text 存 pending / confirmed / rejected，硬约束：
--     仅 confirmed 参与检索，LLM 写回一律 pending。
--   - updated_at 用 text 存 "YYYY-MM-DD HH:mm:ss" 字符串，与 0001 保持一致。
--
-- 使用方法（在 Supabase SQL Editor 中按顺序执行）：
--   1. 先执行 0001_supabase_schema.sql 与 0002_supabase_identity_ids.sql。
--   2. 再执行本文件。
-- ============================================================================

-- ---------- 实体（词条） ----------
create table if not exists entities (
  id         integer primary key generated always as identity,
  name       text not null,
  type       text not null default '',
  aliases    jsonb not null default '[]',     -- 别名列表
  summary    text not null default '',         -- 摘要（用于向量化检索）
  sources    jsonb not null default '[]',      -- 源文档 id 数组
  status     text not null default 'pending',  -- pending | confirmed | rejected
  updated_at text
);

-- ---------- 关系（有向三元组，谓词可复用） ----------
create table if not exists relations (
  id         integer primary key generated always as identity,
  subject_id integer not null,                 -- 头实体 id
  predicate  text not null,                    -- 谓词（如 属于 / 负责 / 依赖）
  object_id  integer not null,                 -- 尾实体 id
  sources    jsonb not null default '[]',      -- 源文档 id 数组
  status     text not null default 'pending',
  updated_at text
);

-- ---------- 索引（按常用查询字段） ----------
create index if not exists idx_entities_name   on entities (name);
create index if not exists idx_entities_status on entities (status);
create index if not exists idx_relations_subject on relations (subject_id);
create index if not exists idx_relations_object  on relations (object_id);
