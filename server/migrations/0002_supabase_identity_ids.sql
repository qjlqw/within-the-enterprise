-- ============================================================================
-- Supabase 迁移 0002：将各表主键改为数据库 identity 自增
-- ----------------------------------------------------------------------------
-- 背景：
--   0001 中主键为 `integer primary key`，id 由应用层内存计数器生成。
--   现在移除内存实现，改由数据库生成 id，因此把 id 列升级为 identity 自增。
--
-- 使用方法（在 Supabase SQL Editor 中按顺序执行）：
--   1. 先执行 0001_supabase_schema.sql（若尚未执行）。
--   2. 再执行本文件。
--
-- 说明：
--   - 仅 users / documents / comments / points_records / document_versions
--     这五张表有自增主键；关系表与 search_history 的联合主键保持不变。
--   - 使用 `generated always as identity` 强制 id 完全由数据库生成，
--     应用层 insert 时不再传入 id。
--   - 末尾把 sequence 同步到当前最大 id，避免与已有数据冲突。
-- ============================================================================

alter table users
  alter column id add generated always as identity;
alter table documents
  alter column id add generated always as identity;
alter table comments
  alter column id add generated always as identity;
alter table points_records
  alter column id add generated always as identity;
alter table document_versions
  alter column id add generated always as identity;

-- 同步自增序列到各表当前最大 id（空表则从 1 开始）
select setval(pg_get_serial_sequence('users', 'id'), coalesce(max(id), 0), true) from users;
select setval(pg_get_serial_sequence('documents', 'id'), coalesce(max(id), 0), true) from documents;
select setval(pg_get_serial_sequence('comments', 'id'), coalesce(max(id), 0), true) from comments;
select setval(pg_get_serial_sequence('points_records', 'id'), coalesce(max(id), 0), true) from points_records;
select setval(pg_get_serial_sequence('document_versions', 'id'), coalesce(max(id), 0), true) from document_versions;
