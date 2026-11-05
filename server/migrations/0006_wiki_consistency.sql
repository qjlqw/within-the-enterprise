-- 0006: LLM Wiki 并发一致性加固
--
-- 目的：
--   1) 实体名唯一、关系三元组唯一：避免多人同时抽取产生重复行
--      （重复行会让 findEntityByName 的 maybeSingle 报错，进而让该名称后续所有抽取任务失败）
--   2) 记录每个来源文档的摘要口径（summary_by_source），便于审核时对比差异
--   3) needs_review 标记摘要口径发生冲突、需人工复检的实体
--   4) documents.extracted_version：抽取幂等，同一版本重复入队不再重复调用 LLM
--
-- 注意：执行前请备份 entities / relations。本脚本会合并重复数据。

-- ---------- 1. 新增字段 ----------

alter table entities add column if not exists name_key text
  generated always as (lower(btrim(name))) stored;

alter table entities add column if not exists summary_by_source jsonb not null default '{}'::jsonb;

alter table entities add column if not exists needs_review boolean not null default false;

alter table documents add column if not exists extracted_version integer;

-- ---------- 2. 合并重复实体（保留 id 最小的一条） ----------

-- 2.1 关系主体指向保留实体
with keepers as (
  select name_key, min(id) as keep_id
  from entities
  group by name_key
)
update relations r
set subject_id = k.keep_id
from entities e
join keepers k on e.name_key = k.name_key
where r.subject_id = e.id
  and r.subject_id <> k.keep_id;

-- 2.2 关系客体指向保留实体
with keepers as (
  select name_key, min(id) as keep_id
  from entities
  group by name_key
)
update relations r
set object_id = k.keep_id
from entities e
join keepers k on e.name_key = k.name_key
where r.object_id = e.id
  and r.object_id <> k.keep_id;

-- 2.3 删除重复实体
with keepers as (
  select name_key, min(id) as keep_id
  from entities
  group by name_key
)
delete from entities e
using keepers k
where e.name_key = k.name_key
  and e.id <> k.keep_id;

-- ---------- 3. 合并重复关系（三元组相同，保留 id 最小的一条） ----------

delete from relations r
using relations keep
where r.id > keep.id
  and r.subject_id = keep.subject_id
  and r.predicate = keep.predicate
  and r.object_id = keep.object_id;

-- ---------- 4. 唯一约束 ----------

create unique index if not exists uq_entities_name_key
  on entities (name_key);

create unique index if not exists uq_relations_triple
  on relations (subject_id, predicate, object_id);

-- ---------- 5. 来源检索索引（按 sources 包含 docId 清理用） ----------

create index if not exists idx_entities_sources
  on entities using gin (sources);

create index if not exists idx_relations_sources
  on relations using gin (sources);
