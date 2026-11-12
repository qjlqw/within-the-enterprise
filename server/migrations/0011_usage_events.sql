-- 0011: 用量事件表（成本治理 11-06 报告 B7）
--
-- 背景：
--   问答/向量化/精排/抽取等模型调用此前只打审计日志，没有可聚合的持久计量，
--   无法回答「谁、哪天、用了多少」，也无法做用户级每日配额拦截。
--
-- 方案：
--   每次模型调用写一条 usage_events（计量失败仅记日志，不阻断业务）；
--   配额检查与看板汇总在 service 层按时间窗口聚合原始行。
--
-- 口径：
--   tokens_in / tokens_out 可空：上游未返回 token 数时不计；
--   chars 为输入字符量，作为 token 缺失时的字符口径兜底计量。
--
-- 保留策略：
--   超出 config.cost.usageRetentionDays 的数据由聚合接口忽略，表内可定期清理。

create table if not exists usage_events (
  id         bigserial primary key,
  user_id    integer not null,
  kind       text not null,              -- agent_run | embedding | rerank | extraction
  tokens_in  integer,                    -- 可空：上游未返回时不计
  tokens_out integer,
  chars      integer,                    -- 输入字符量（字符口径兜底计量）
  meta       jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- 按用户 + 时间聚合（每日配额检查、用户 Top 榜）
create index if not exists idx_usage_events_user_time
  on usage_events (user_id, created_at);

-- 按类型 + 时间聚合（分类型成本统计）
create index if not exists idx_usage_events_kind_time
  on usage_events (kind, created_at);

-- 内部计量数据，仅 service_role 可读
alter table usage_events enable row level security;